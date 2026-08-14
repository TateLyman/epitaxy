/**
 * P13 — watch the real vaults.
 *
 * The reserve alarm's balance decoder receives VAULT TOKEN ACCOUNTS, never the
 * pool PDA. A pool account is not a token account: decoding one as the other
 * reads an arbitrary 8 bytes at offset 64 as a balance, which produces a number
 * rather than an error and therefore an alarm that fires on nothing or never
 * fires at all.
 *
 * The exact subscription addresses are persisted on the trajectory, and the
 * unwatch uses those same stored addresses. Re-deriving them at unwatch time
 * means a derivation change silently leaks subscriptions instead of failing.
 */

export interface WatchSet {
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly poolState: string;
  readonly feeConfig: string;
  readonly mint: string;
  /** Present only when the coin is cashback-enabled or has a creator vault. */
  readonly creatorOrCashbackAccumulator: string | null;
}

export class NotATokenAccount extends Error {
  constructor(pubkey: string, why: string) {
    super(
      `refusing to read a balance from ${pubkey.slice(0, 12)}: ${why}. ` +
        'A pool PDA decoded as a token account yields an arbitrary 8 bytes as a balance, ' +
        'which is a number rather than an error.',
    );
    this.name = 'NotATokenAccount';
  }
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * The balance, or a refusal naming why.
 *
 * Checks the OWNER, not the length. A pool account can be 165 bytes by
 * coincidence; it cannot be owned by a token program.
 */
export function vaultBalance(a: { pubkey: string; owner: string; dataBase64: string }): bigint {
  if (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022) {
    throw new NotATokenAccount(a.pubkey, `it is owned by ${a.owner.slice(0, 12)}, not a token program`);
  }
  const b = Buffer.from(a.dataBase64, 'base64');
  if (b.length < 72) throw new NotATokenAccount(a.pubkey, `it is ${b.length} bytes, too short for a token account`);
  return b.readBigUInt64LE(64);
}

export interface Subscription {
  readonly trajectoryId: string;
  /** EXACTLY what was subscribed. Unwatch uses these, never a re-derivation. */
  readonly addresses: readonly string[];
  readonly subscribedAtMs: number;
}

export function subscriptionFor(trajectoryId: string, w: WatchSet, atMs: number): Subscription {
  const addresses = [w.baseVault, w.quoteVault, w.poolState, w.feeConfig, w.mint, w.creatorOrCashbackAccumulator]
    .filter((x): x is string => x !== null && x.length > 0);
  return { trajectoryId, addresses: [...new Set(addresses)], subscribedAtMs: atMs };
}

export class UnwatchMismatch extends Error {
  constructor(readonly leaked: readonly string[]) {
    super(
      `unwatch was asked for addresses that were never subscribed, leaving ${leaked.length} subscription(s) open. ` +
        'Unwatch must use the stored subscription addresses, not a fresh derivation.',
    );
    this.name = 'UnwatchMismatch';
  }
}

export function assertUnwatchesExactly(sub: Subscription, unwatching: readonly string[]): void {
  const stored = new Set(sub.addresses);
  const asked = new Set(unwatching);
  const leaked = [...stored].filter((a) => !asked.has(a));
  if (leaked.length > 0) throw new UnwatchMismatch(leaked);
}

/**
 * Urgent queue: a material reserve change jumps the ordinary mark queue.
 *
 * "Material" is a frozen fraction, not a judgement call at the call site.
 */
export const MATERIAL_RESERVE_CHANGE_BPS = 500;

export function isMaterialChange(before: bigint, after: bigint): boolean {
  if (before === 0n) return after !== 0n;
  const delta = after > before ? after - before : before - after;
  return (delta * 10_000n) / before >= BigInt(MATERIAL_RESERVE_CHANGE_BPS);
}

/**
 * The urgent queue is drained BEFORE ordinary marks.
 *
 * A vault that just moved 5% is the one observation whose value decays
 * fastest; serving it after a queue of routine marks is the same as not having
 * detected it.
 */
export function drainOrder(urgent: readonly string[], ordinary: readonly string[]): readonly string[] {
  const seen = new Set(urgent);
  return [...urgent, ...ordinary.filter((x) => !seen.has(x))];
}

/**
 * Socket coverage gaps are recorded; per-account update gaps are NOT invented.
 *
 * A quiet account across slots is a quiet account. Recording "no update for
 * 40 slots" per account manufactures a gap for every account that simply did
 * not trade, and buries the one real gap — the interval where the SOCKET was
 * down and nothing could have been seen.
 */
export interface CoverageGap {
  readonly fromSlot: number;
  readonly toSlot: number;
  readonly reason: 'SOCKET_DISCONNECTED' | 'SUBSCRIBE_FAILED';
}

export interface ResyncPlan {
  readonly addresses: readonly string[];
  readonly reason: string;
}

export function resyncAfterGap(sub: Subscription, gap: CoverageGap): ResyncPlan {
  return {
    addresses: sub.addresses,
    reason: `socket coverage gap slots ${gap.fromSlot}..${gap.toSlot} (${gap.reason}); re-read every subscribed address and compare hashes`,
  };
}

export interface ResyncOutcome {
  readonly restored: readonly string[];
  readonly changedWhileBlind: readonly string[];
  readonly stillUnreadable: readonly string[];
}

export function compareAfterResync(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  subscribed: readonly string[],
): ResyncOutcome {
  const restored: string[] = [];
  const changed: string[] = [];
  const unreadable: string[] = [];
  for (const a of subscribed) {
    const b = before.get(a);
    const n = after.get(a);
    if (n === undefined) {
      unreadable.push(a);
      continue;
    }
    restored.push(a);
    if (b !== undefined && b !== n) changed.push(a);
  }
  return { restored, changedWhileBlind: changed, stillUnreadable: unreadable };
}
