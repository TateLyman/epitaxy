import { AccountWatcher, isMaterialDrop, type AccountUpdate } from '../../../packages/adapters/src/accountwatch.js';
import { recordHealth } from '../../../packages/storage/src/repo.js';
import type { Db } from '../../../packages/storage/src/db.js';
import { decodeTokenAccountAmount } from '../../../packages/solana/src/tokenaccount.js';

/**
 * P17.3 — the WSS reserve alarm, wired.
 *
 * `accountwatch.ts` was complete, tested, and imported by nothing. A watcher
 * that decides nothing is worse than no watcher: it counts as coverage in every
 * report that counts files, and the collapse it exists to catch happens between
 * two marks either way.
 *
 * What this is and is not:
 *
 *   **an alarm** — a reason to look now rather than at the next scheduled mark
 *   **not a price** — raw account state never becomes a fill or a mark
 *
 * That distinction is the whole design. A socket update arrives before any
 * quote could, which makes it exactly the wrong thing to value a position with
 * and exactly the right thing to trigger valuing one.
 */

export interface AlarmDeps {
  readonly db: Db;
  /**
   * Called when a watched pool moves materially. The engine's job is to
   * enqueue an immediate same-family observation — not to act on the raw state.
   */
  readonly onMaterialChange: (mint: string, detail: string) => void;
}

export interface WatchedPool {
  readonly mint: string;
  /** The pool's token account, whose BALANCE is the reserve. */
  readonly reserveTokenAccount: string;
}

/**
 * How far a reserve may fall before it is an alarm.
 *
 * Frozen here rather than configured: a threshold that can be widened from a
 * config file is one that will be widened the first time it fires
 * inconveniently, and this one exists precisely for the inconvenient case.
 */
const MATERIAL_DROP_BPS = 1_000;

export class ReserveAlarm {
  private readonly watcher: AccountWatcher;
  private readonly byAccount = new Map<string, WatchedPool>();
  /** Last DECODED token amount per account. Never lamports. */
  private readonly lastAmount = new Map<string, bigint>();

  constructor(
    private readonly deps: AlarmDeps,
    wsUrl: string,
  ) {
    this.watcher = new AccountWatcher({
      wsUrl,
      // `processed` sees a change soonest and can see one that never finalises.
      // For an alarm that is the right trade: a false alarm costs one
      // observation, and a missed one costs the position.
      commitment: 'processed',
      onUpdate: (u) => {
        this.handle(u);
      },
      onGap: (detail) => {
        // Coverage loss is a FACT the engine must record, not a silence. A
        // watcher that stops watching and says nothing is indistinguishable
        // from a market that stopped moving.
        recordHealth(this.deps.db, 'wss_coverage_gap', 'warn', detail.slice(0, 200));
      },
    });
  }

  watch(pool: WatchedPool): void {
    this.byAccount.set(pool.reserveTokenAccount, pool);
    this.watcher.watch(pool.reserveTokenAccount, 'POOL_RESERVES');
  }

  unwatch(pool: WatchedPool): void {
    this.byAccount.delete(pool.reserveTokenAccount);
    this.lastAmount.delete(pool.reserveTokenAccount);
    // Sends a real unsubscribe. A watcher that forgets locally and leaves the
    // subscription open leaks the socket's capacity and keeps paying for
    // updates nobody reads.
    this.watcher.unwatch(pool.reserveTokenAccount);
  }

  get fullyCovered(): boolean {
    return this.watcher.fullyCovered;
  }

  stop(): void {
    this.watcher.close();
  }

  /**
   * One update.
   *
   * The reserve is the DECODED SPL token amount, not the account's lamports.
   * A token account's lamports are its rent-exempt minimum and barely move;
   * reading them as the reserve would produce an alarm that never fires, which
   * is the failure mode that looks most like working.
   */
  private handle(u: AccountUpdate): void {
    const pool = this.byAccount.get(u.address);
    if (pool === undefined) return;

    // The DECODED token amount from the account's data, not its lamports. A
    // token account's lamports are its rent-exempt minimum and barely move;
    // reading them as the reserve produces an alarm that never fires.
    const amount = decodeTokenAccountAmount(Buffer.from(u.dataBase64, 'base64'));
    if (amount === null) {
      // Undecodable is unknown. It is not zero, and reading it as zero would
      // fire a total-drain alarm on every malformed update.
      recordHealth(
        this.deps.db,
        'wss_undecodable_account',
        'warn',
        `${pool.mint.slice(0, 12)}: reserve account did not decode as a token account`,
      );
      return;
    }

    // A slot gap means updates were MISSED, not that the account did not
    // change. The comparison below is then against a stale baseline, so it is
    // recorded rather than silently trusted.
    if (u.slotGap !== null && u.slotGap > 0) {
      recordHealth(
        this.deps.db,
        'wss_slot_gap',
        'warn',
        `${pool.mint.slice(0, 12)}: ${u.slotGap} slot(s) not observed before this update`,
      );
    }

    const previous = this.lastAmount.get(u.address);
    this.lastAmount.set(u.address, amount);
    // The first update establishes a baseline. There is nothing to compare it
    // against, and treating a first sighting as a drop from zero would fire on
    // every new subscription.
    if (previous === undefined) return;

    if (isMaterialDrop(previous, amount, MATERIAL_DROP_BPS)) {
      const detail =
        `${pool.mint.slice(0, 12)}: reserve ${previous} -> ${amount} ` +
        `(${MATERIAL_DROP_BPS}bps threshold) at slot ${u.contextSlot}`;
      recordHealth(this.deps.db, 'wss_reserve_drop', 'critical', detail.slice(0, 200));
      // Enqueue an observation. The alarm says LOOK; the observation says what
      // the position is worth, and only the observation may move a stop.
      this.deps.onMaterialChange(pool.mint, detail);
    }
  }
}
