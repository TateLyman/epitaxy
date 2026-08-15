import { directSellMark, DirectMarkUnavailable } from './direct-mark.js';
import { decideExit, type ExitPolicy, type MarkPoint } from '../../strategy/src/treatments.js';

/**
 * P9 — ONE shared market path, then every policy evaluated on it.
 *
 * The reason a shared path matters is not tidiness. Allocating one policy to
 * one trajectory means each policy sees a different set of tokens, so any
 * difference between policies is confounded with which tokens each drew — and
 * at these sample sizes that difference is almost entirely noise.
 *
 * One path, every policy, paired outcomes. That removes the token-selection
 * variance entirely, which is the dominant term.
 *
 * The marks are DIRECT pool reads, not router quotes. A router declines most of
 * these tokens, and 93% of a previous corpus was unpriced for exactly that
 * reason.
 */

export const MARK_OFFSETS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;

export interface CollectedMark {
  readonly atMs: number;
  readonly offsetMs: number;
  readonly executableLamports: bigint | null;
  readonly exitCapacityLamports: bigint | null;
  readonly effectiveQuoteReserveLamports: bigint | null;
  /** Why this mark carries no price. Never collapsed to "no route". */
  readonly refusal: string | null;
}

export interface MarkReader {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

/**
 * Take one mark from the pool's own bytes.
 *
 * A refusal is recorded with its reason rather than as a gap, because a mark
 * that could not be priced and a mark that was never attempted are different
 * facts about the path.
 */
export async function takeMark(
  rpc: MarkReader,
  p: { mint: string; tokenAmount: bigint; slippagePct: number; globalConfig: string; feeConfig: string; offsetMs: number },
): Promise<CollectedMark> {
  const atMs = Date.now();
  try {
    const m = await directSellMark(
      rpc,
      { mint: p.mint, tokenAmount: p.tokenAmount, slippagePct: p.slippagePct },
      { globalConfig: p.globalConfig, feeConfig: p.feeConfig },
    );
    return {
      atMs,
      offsetMs: p.offsetMs,
      executableLamports: m.executableLamports,
      // What the position could actually realise right now IS the mark: the
      // pool's own arithmetic on the position's own size.
      exitCapacityLamports: m.executableLamports,
      effectiveQuoteReserveLamports: m.poolFacts.quoteReserveRaw + m.poolFacts.virtualQuoteReserves,
      refusal: null,
    };
  } catch (e) {
    return {
      atMs,
      offsetMs: p.offsetMs,
      executableLamports: null,
      exitCapacityLamports: null,
      effectiveQuoteReserveLamports: null,
      refusal: e instanceof DirectMarkUnavailable ? e.reason : (e as Error).message.slice(0, 120),
    };
  }
}

export interface PolicyOutcome {
  readonly exitPolicy: ExitPolicy;
  readonly triggeredAtMs: number | null;
  readonly triggeredOffsetMs: number | null;
  readonly reason: string;
  /** The mark the policy actually exits at. Null when it never triggered. */
  readonly exitMarkLamports: bigint | null;
  /** Entry cash out minus what the exit would realise. Null when unpriced. */
  readonly grossDeltaLamports: bigint | null;
}

/**
 * Evaluate every exit policy on the SAME path.
 *
 * Returns one row per policy. They are paired by construction — same token,
 * same pool, same marks, same costs — so a difference between them is a
 * difference in the decision and nothing else.
 */
export function evaluateExitPolicies(
  path: readonly CollectedMark[],
  p: { openedAtMs: number; policies: readonly ExitPolicy[]; entryCashOutLamports: bigint },
): readonly PolicyOutcome[] {
  const marks: MarkPoint[] = path.map((m) => ({
    atMs: m.atMs,
    executableLamports: m.executableLamports ?? 0n,
    exitCapacityLamports: m.exitCapacityLamports,
    effectiveQuoteReserveLamports: m.effectiveQuoteReserveLamports,
  }));

  return p.policies.map((policy) => {
    const d = decideExit(policy, p.openedAtMs, marks);
    const at = d.triggeredAtMs;
    const mark = at === null ? null : path.find((m) => m.atMs === at) ?? null;
    return {
      exitPolicy: policy,
      triggeredAtMs: at,
      triggeredOffsetMs: mark?.offsetMs ?? null,
      reason: d.reason,
      exitMarkLamports: mark?.executableLamports ?? null,
      grossDeltaLamports:
        mark?.executableLamports === null || mark?.executableLamports === undefined
          ? null
          : mark.executableLamports - p.entryCashOutLamports,
    };
  });
}

/**
 * Whether a path is complete enough to conclude anything from.
 *
 * A path missing its 60-minute mark cannot evaluate a policy that might have
 * held that long, and treating a truncated path as finished silently biases
 * every horizon toward whatever the collector happened to reach.
 */
export function pathIsComplete(path: readonly CollectedMark[]): { complete: boolean; reason: string } {
  const have = new Set(path.map((m) => m.offsetMs));
  const missing = MARK_OFFSETS_MS.filter((o) => !have.has(o));
  if (missing.length > 0) {
    return { complete: false, reason: `missing marks at ${missing.map((m) => m / 60_000 + 'm').join(', ')}` };
  }
  const unpriced = path.filter((m) => m.executableLamports === null).length;
  if (unpriced === path.length) {
    return { complete: false, reason: 'every mark on the path was unpriced' };
  }
  return { complete: true, reason: `${path.length} marks, ${unpriced} unpriced` };
}
