import { LogsWatcher, MIGRATION_INSTRUCTIONS, pumpInstructionFromLogs } from '../../../packages/adapters/src/logswatch.js';
import { AccountWatcher } from '../../../packages/adapters/src/accountwatch.js';
import {
  decodeMigrations,
  enrichMigration,
  reconcileCommitment,
  MigrationUndecodable,
  type MigrationEventIdentity,
} from '../../../packages/solana/src/migration.js';
import { vaultBalance, isMaterialChange, NotATokenAccount, type Subscription } from '../../../packages/pipeline/src/vault-watch.js';
import {
  countResource,
  recordLatency,
  recordSubscription,
  recordUnsubscribe,
  countSubscriptionEvent,
  openGap,
  closeGap,
  queueUrgentMark,
} from '../../../packages/storage/src/collector-telemetry.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P8/P11 — the LIVE lanes: current migrations in, current vault moves out.
 *
 * ## P8 — why history paging is not the primary lane
 *
 * The collector derives pools from old screenings and then pages a pool's
 * signature history backwards until it finds the creation. That works, and it
 * is genuinely the right RECOVERY tool — one live pool needed 25 pages to reach
 * its creation, and its single oldest signature was a failed snipe rather than
 * the creation itself. But as a primary lane it is structurally late: a pool
 * only enters the queue once a screening happened to mention its mint, and the
 * whole premise of the strategy is the first hour.
 *
 * The primary lane has to react to the chain. A `create_pool` produces a log
 * event within a slot of landing, and the transaction behind it decodes to an
 * exact identity. That is the difference between sampling migrations and
 * discovering them.
 *
 * ## What is NOT trusted here
 *
 * The socket delivers logs. Logs are a display surface: they carry program
 * names and human strings and are trivially spoofable by any program that wants
 * to print them. So a log event is used for ONE thing — a signature worth
 * fetching — and every identity comes from decoding the transaction's actual
 * instruction bytes against the official discriminator.
 *
 * A `processed` sighting is not a migration either. It can still be reverted,
 * so nothing enters the candidate queue until the transaction has been read
 * back at `confirmed` and reconciled.
 *
 * ## P11 — the vault lane
 *
 * Vault token accounts, never the pool PDA. A pool decoded as a token account
 * yields an arbitrary eight bytes at offset 64 as a balance — a number rather
 * than an error, and therefore an alarm that fires on nothing or never fires.
 * `vaultBalance` checks the OWNER, and this module lets the refusal through
 * rather than catching it into a zero.
 */

/** The socket may run far ahead of the cycle. A bound, so it cannot grow forever. */
const MAX_QUEUED_SIGNATURES = 2_000;

export interface MigrationRpc {
  getTransactionInstructions(signature: string): Promise<Parameters<typeof decodeMigrations>[0] | null>;
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

export interface LiveMigrationLaneOptions {
  readonly wsUrl: string;
  readonly programs: readonly string[];
  readonly rpc: MigrationRpc;
  readonly db: DatabaseSync;
  readonly sessionId: string;
  /** Persist one reconciled migration. Injected so this module owns no schema. */
  readonly persist: (m: MigrationEventIdentity & Record<string, unknown>, reversal: string, nowMs: number) => void;
}

export interface DrainResult {
  readonly fetched: number;
  readonly recorded: number;
  readonly refusals: Record<string, number>;
  readonly droppedForBound: number;
}

export class LiveMigrationLane {
  private watcher: LogsWatcher | null = null;
  /** Signature → the monotonic ms it was first seen, for notice lag. */
  private readonly queued = new Map<string, { seenUtcMs: number; slot: number }>();
  private readonly done = new Set<string>();
  private droppedForBound = 0;
  private gapOpen = false;

  constructor(private readonly opts: LiveMigrationLaneOptions) {}

  get pending(): number {
    return this.queued.size;
  }

  get coverage(): { programId: string; subscribed: boolean; lastSlot: number | null; events: number }[] {
    return this.watcher?.coverage ?? [];
  }

  get fullyCovered(): boolean {
    return this.watcher?.fullyCovered ?? false;
  }

  /**
   * Consider one log event for the queue.
   *
   * Separate from the socket handler so the admission RULES are testable
   * without a websocket. What is admitted is the whole of the lane's judgement:
   * everything after this is fetch-and-decode, and everything before is
   * transport.
   *
   * Returns why it was not queued, or null when it was.
   */
  offer(e: { signature: string; slot: number; logs: readonly string[]; err: string | null; receivedUtcMs: number }): string | null {
    // A failed transaction migrated nothing. Counting one as flow is how a
    // corpus comes to be 99.75% events that never happened.
    if (e.err !== null) return 'the transaction failed; nothing migrated';
    // Logs are a DISPLAY surface: any program can print any string. This uses
    // them for one thing — deciding a signature is worth fetching — and every
    // identity comes from decoding the transaction's own instruction bytes.
    const ix = pumpInstructionFromLogs(e.logs);
    if (ix === null) return 'no pump instruction named in the logs';
    if (!MIGRATION_INSTRUCTIONS.has(ix)) return `${ix} is not a migration`;
    if (this.done.has(e.signature)) return 'already processed';
    if (this.queued.has(e.signature)) return 'already queued';
    if (this.queued.size >= MAX_QUEUED_SIGNATURES) {
      // Dropped and COUNTED. A silent drop reads downstream as a quiet chain,
      // which is the opposite of what a full queue means.
      this.droppedForBound++;
      return 'the queue is at its bound';
    }
    this.queued.set(e.signature, { seenUtcMs: e.receivedUtcMs, slot: e.slot });
    return null;
  }

  start(): void {
    if (this.watcher !== null) return;
    this.watcher = new LogsWatcher({
      wsUrl: this.opts.wsUrl,
      programs: [...this.opts.programs],
      // `processed` sees the creation soonest. It can also see one that never
      // finalises, which is why nothing here enters the queue until the
      // transaction has been read back at confirmed.
      commitment: 'processed',
      onEvent: (e) => {
        countResource(this.opts.db, this.opts.sessionId, 'wss_events', { detail: 'logs' });
        this.offer(e);
      },
      onGap: (detail) => {
        if (!this.gapOpen) {
          openGap(this.opts.db, this.opts.sessionId, `migration logs: ${detail}`, Date.now());
          this.gapOpen = true;
        }
      },
    });
    this.watcher.connect();
    for (const p of this.opts.programs) {
      recordSubscription(this.opts.db, this.opts.sessionId, { kind: 'migration_logs', address: p, nowMs: Date.now() });
    }
  }

  /**
   * Wait, briefly, for every program to be subscribed.
   *
   * Without this a `--once` run connects and drains in the same millisecond,
   * reports DEGRADED, and records a coverage gap describing its own startup
   * rather than anything about the chain. A gap that means "we had not
   * finished connecting yet" is noise in exactly the surface that exists to
   * make real gaps visible.
   *
   * Bounded, and returns whether it succeeded. A socket that will not connect
   * is a fact to report, not a reason to block the cycle.
   */
  async waitUntilCovered(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.fullyCovered) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.fullyCovered;
  }

  /**
   * Fetch, decode and reconcile what the socket queued.
   *
   * Called from the cycle rather than from the socket handler, so RPC spend
   * stays inside the cycle's budget instead of being driven by chain activity.
   */
  async drain(limit: number): Promise<DrainResult> {
    const refusals: Record<string, number> = {};
    const refuse = (r: string): void => {
      refusals[r] = (refusals[r] ?? 0) + 1;
    };
    let fetched = 0;
    let recorded = 0;

    if (this.gapOpen && this.fullyCovered) {
      closeGap(this.opts.db, this.opts.sessionId, {
        nowMs: Date.now(),
        resynced: this.opts.programs.length,
        changed: 0,
        unreadable: 0,
      });
      this.gapOpen = false;
    }

    for (const [signature, meta] of [...this.queued.entries()].slice(0, limit)) {
      this.queued.delete(signature);
      this.done.add(signature);
      fetched++;

      let tx;
      try {
        countResource(this.opts.db, this.opts.sessionId, 'solana_rpc', { detail: 'getTransaction' });
        tx = await this.opts.rpc.getTransactionInstructions(signature);
      } catch (e) {
        refuse(`transaction fetch failed: ${(e as Error).message.slice(0, 60)}`);
        continue;
      }
      if (tx === null) {
        // Seen at processed, absent at confirmed. That is a DROP, and the
        // correct outcome is no candidate — not a candidate with a caveat.
        refuse('not present at confirmed, so the processed sighting was dropped');
        continue;
      }

      let events: readonly MigrationEventIdentity[];
      try {
        events = decodeMigrations(tx, {
          commitment: 'confirmed',
          migrationProgramIds: [...this.opts.programs],
        });
      } catch (e) {
        refuse(e instanceof MigrationUndecodable ? e.message.slice(0, 70) : 'decode failed');
        continue;
      }

      for (const ev of events) {
        let rich;
        try {
          rich = await enrichMigration(this.opts.rpc, ev);
        } catch (e) {
          refuse(`enrichment failed: ${(e as Error).message.slice(0, 60)}`);
          continue;
        }
        // Read at confirmed and it landed, so the sighting reconciles by
        // construction. A processed-only sighting would be STILL_UNKNOWN and
        // would not enter the queue at all.
        const reversal = reconcileCommitment('confirmed', { found: true, failed: false });
        const now = Date.now();
        this.opts.persist(rich as never, reversal, now);
        recorded++;
        // P13 — how long from the chain naming it to us recording it. The
        // number the primary lane exists to reduce.
        recordLatency(this.opts.db, this.opts.sessionId, 'migration_notice_lag', now - meta.seenUtcMs, now);
      }
    }

    const dropped = this.droppedForBound;
    this.droppedForBound = 0;
    return { fetched, recorded, refusals, droppedForBound: dropped };
  }

  async stop(): Promise<void> {
    if (this.watcher === null) return;
    this.watcher.close();
    recordUnsubscribe(this.opts.db, this.opts.sessionId, this.opts.programs, Date.now());
    this.watcher = null;
  }
}

export interface LiveVaultWatchOptions {
  readonly wsUrl: string;
  readonly db: DatabaseSync;
  readonly sessionId: string;
}

/**
 * P11 — watch the vaults of every open trajectory.
 *
 * A material reserve move is the one observation whose value decays fastest, so
 * it is queued as URGENT and the cycle drains urgent before ordinary marks.
 * Serving it after a queue of routine marks is the same as not having detected
 * it at all.
 */
export class LiveVaultWatch {
  private watcher: AccountWatcher | null = null;
  private readonly byAddress = new Map<string, { trajectoryId: string; last: bigint | null }>();
  private readonly subscriptions = new Map<string, Subscription>();
  private gapOpen = false;
  private refusals = 0;

  constructor(private readonly opts: LiveVaultWatchOptions) {}

  get watchedCount(): number {
    return this.byAddress.size;
  }

  /** Refusals from the balance decoder. A pool PDA reaching it is a defect. */
  get decoderRefusals(): number {
    return this.refusals;
  }

  private ensure(): AccountWatcher {
    if (this.watcher !== null) return this.watcher;
    this.watcher = new AccountWatcher({
      wsUrl: this.opts.wsUrl,
      commitment: 'processed',
      onUpdate: (u) => {
        countResource(this.opts.db, this.opts.sessionId, 'wss_events', { detail: 'account' });
        countSubscriptionEvent(this.opts.db, this.opts.sessionId, u.address);
        const entry = this.byAddress.get(u.address);
        if (entry === undefined) return;

        let balance: bigint;
        try {
          balance = vaultBalance({ pubkey: u.address, owner: u.owner, dataBase64: u.dataBase64 });
        } catch (e) {
          // Let it be COUNTED rather than swallowed. A pool PDA reaching the
          // balance decoder means the watch set was built wrong, and the
          // silent version of that reports an arbitrary eight bytes as a
          // reserve.
          if (e instanceof NotATokenAccount) this.refusals++;
          return;
        }

        const before = entry.last;
        entry.last = balance;
        if (before === null) return;
        if (!isMaterialChange(before, balance)) return;

        queueUrgentMark(this.opts.db, this.opts.sessionId, {
          trajectoryId: entry.trajectoryId,
          address: u.address,
          before,
          after: balance,
          nowMs: u.receivedUtcMs,
        });
      },
      onGap: (detail) => {
        if (!this.gapOpen) {
          openGap(this.opts.db, this.opts.sessionId, `vault watch: ${detail}`, Date.now());
          this.gapOpen = true;
        }
      },
    });
    this.watcher.connect();
    return this.watcher;
  }

  /**
   * Subscribe one trajectory's vaults.
   *
   * Only the two VAULTS enter the balance-decoding set. The pool state, fee
   * config and mint are watched for change but never decoded as balances,
   * which is the whole of P11's first item.
   */
  watch(sub: Subscription, vaults: readonly string[]): void {
    const w = this.ensure();
    const now = Date.now();
    for (const address of sub.addresses) {
      w.watch(address, 'POOL_RESERVES');
      recordSubscription(this.opts.db, this.opts.sessionId, {
        kind: vaults.includes(address) ? 'vault' : 'pool_context',
        address,
        trajectoryId: sub.trajectoryId,
        nowMs: now,
      });
    }
    for (const v of vaults) this.byAddress.set(v, { trajectoryId: sub.trajectoryId, last: null });
    this.subscriptions.set(sub.trajectoryId, sub);
  }

  /**
   * Unsubscribe using the STORED addresses.
   *
   * Never a re-derivation. A derivation that changed between subscribe and
   * unsubscribe leaks the old address silently, and a leaked subscription is
   * indistinguishable from an account that simply went quiet.
   */
  unwatch(trajectoryId: string): void {
    const sub = this.subscriptions.get(trajectoryId);
    if (sub === undefined) return;
    for (const a of sub.addresses) {
      this.watcher?.unwatch(a);
      this.byAddress.delete(a);
    }
    recordUnsubscribe(this.opts.db, this.opts.sessionId, sub.addresses, Date.now());
    this.subscriptions.delete(trajectoryId);
  }

  /** Close an open gap once coverage is back, recording what moved while blind. */
  noteRecovered(changedWhileBlind: number, stillUnreadable: number): void {
    if (!this.gapOpen) return;
    if (this.watcher !== null && !this.watcher.fullyCovered) return;
    closeGap(this.opts.db, this.opts.sessionId, {
      nowMs: Date.now(),
      resynced: this.byAddress.size,
      changed: changedWhileBlind,
      unreadable: stillUnreadable,
    });
    this.gapOpen = false;
  }

  async stop(): Promise<void> {
    if (this.watcher === null) return;
    const all = [...this.subscriptions.values()].flatMap((s) => s.addresses);
    this.watcher.close();
    recordUnsubscribe(this.opts.db, this.opts.sessionId, all, Date.now());
    this.watcher = null;
    this.byAddress.clear();
    this.subscriptions.clear();
  }
}
