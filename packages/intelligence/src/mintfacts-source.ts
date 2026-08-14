import { decodeMint, transferFeeAtEpoch, worstCaseTransferFee, TOKEN_2022_PROGRAM } from '../../solana/src/mint.js';
import { mintFacts, type MintFacts } from './mintfacts.js';

/**
 * P11 — ONE authoritative mint decoder, read in every mode.
 *
 * Two things were wrong and they compounded.
 *
 * The first: two decoders. `solana/src/token2022.ts` walked the TLV area and
 * graded what it found; `solana/src/mint.ts` does that and also decodes the
 * transfer-fee config properly — both schedules, the epoch that selects between
 * them, and the worst case when the epoch is unknown — and REFUSES on an
 * extension newer than itself instead of grading it. The pipeline called the
 * weaker one. The directive's list of required capabilities is exactly the
 * stronger one's, so the weaker is retired rather than kept in parallel.
 *
 * The second, and worse: the read was gated on `capitalAtRisk(mode)`. Paper
 * risks nothing, so paper never read a mint — which means the corpus this
 * system is being built to interpret contains no measurement at all of how
 * often a candidate carries a freeze authority, a transfer hook or a permanent
 * delegate. The gate that would refuse it in a capital mode had never fired,
 * and nothing in the research corpus could say what it would cost. A risk
 * control first exercised with money on it is not a risk control.
 *
 * So: read in paper and development too, and let the MODE decide what a hostile
 * fact does, not whether it is looked at.
 */

export interface MintFactsSource {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

export interface DirectMintFacts extends MintFacts {
  readonly mint: string;
  readonly tokenProgram: string | null;
  /** The fee that applies in THIS epoch, when the epoch is known. */
  readonly currentEpochTransferFeeBps: number | null;
  /** The highest fee any schedule in the account allows. */
  readonly worstCaseTransferFeeBps: number | null;
  readonly maximumFeeAtoms: bigint | null;
  readonly readUtcMs: number;
  /** Which extension types were present, by number, for the corpus. */
  readonly extensionTypes: readonly number[];
  readonly hasUnknownExtension: boolean;
}

const UNREAD = (mint: string, why: string, now: number): DirectMintFacts => ({
  ...mintFacts(null, why),
  mint,
  tokenProgram: null,
  currentEpochTransferFeeBps: null,
  worstCaseTransferFeeBps: null,
  maximumFeeAtoms: null,
  readUtcMs: now,
  extensionTypes: [],
  hasUnknownExtension: false,
});

/**
 * A bounded, time-limited cache.
 *
 * A mint's authorities and extensions can change, so this is not permanent —
 * but they change on the order of a governance action, not on the order of a
 * screening cycle, and re-reading the same mint every ten seconds spends the
 * RPC budget that the marks need. Bounded because an unbounded map keyed by
 * mint in a system that sees thousands of new mints a day is a leak.
 */
export class MintFactsCache {
  private readonly entries = new Map<string, DirectMintFacts>();
  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 5_000,
  ) {}

  get(mint: string, nowUtcMs: number): DirectMintFacts | null {
    const hit = this.entries.get(mint);
    if (hit === undefined) return null;
    if (nowUtcMs - hit.readUtcMs > this.ttlMs) {
      this.entries.delete(mint);
      return null;
    }
    return hit;
  }

  put(facts: DirectMintFacts): void {
    if (this.entries.size >= this.maxEntries) {
      // Oldest insertion first. A Map preserves insertion order, so the first
      // key is the coldest one without keeping a second index.
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    this.entries.set(facts.mint, facts);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Read a mint's own bytes and grade them.
 *
 * Never throws. An unreadable or undecodable mint returns UNKNOWN across the
 * board with the reason attached, because a thrown error in the screening loop
 * would drop the candidate entirely and a dropped candidate leaves no row —
 * and a filter whose rejects are not stored can never be evaluated.
 */
export async function readMintFacts(
  rpc: MintFactsSource,
  mint: string,
  p: { nowUtcMs: number; currentEpoch?: bigint | null; cache?: MintFactsCache },
): Promise<DirectMintFacts> {
  const cached = p.cache?.get(mint, p.nowUtcMs) ?? null;
  if (cached !== null) return cached;

  let raw;
  try {
    raw = await rpc.getAccountRaw(mint);
  } catch (e) {
    return UNREAD(mint, `the mint account could not be read: ${(e as Error).message.slice(0, 90)}`, p.nowUtcMs);
  }

  let decoded;
  try {
    decoded = decodeMint(Buffer.from(raw.dataBase64, 'base64'), raw.owner);
  } catch (e) {
    // `decodeMint` throws on an extension newer than itself. That is stronger
    // than grading it: there is no decoded mint to grade, and the refusal is
    // the finding.
    const out: DirectMintFacts = {
      ...UNREAD(mint, (e as Error).message.slice(0, 140), p.nowUtcMs),
      tokenProgram: raw.owner,
      hasUnknownExtension: true,
    };
    p.cache?.put(out);
    return out;
  }

  const base = mintFacts(decoded);
  const cfg = decoded.transferFeeConfig;
  const worst = cfg === null ? null : worstCaseTransferFee(cfg);
  const current =
    cfg === null || p.currentEpoch === null || p.currentEpoch === undefined
      ? null
      : transferFeeAtEpoch(cfg, p.currentEpoch);

  const out: DirectMintFacts = {
    ...base,
    mint,
    tokenProgram: raw.owner,
    // When the epoch is not known the WORST case is used, never the newer
    // schedule and never zero: an unknown epoch means either schedule could be
    // the live one, and only one of the two directions of that error is safe.
    currentEpochTransferFeeBps: current?.basisPoints ?? worst?.basisPoints ?? null,
    worstCaseTransferFeeBps: worst?.basisPoints ?? null,
    maximumFeeAtoms: worst?.maximumFee ?? null,
    readUtcMs: p.nowUtcMs,
    extensionTypes: decoded.extensions.map((e) => e.discriminant),
    hasUnknownExtension: false,
  };
  p.cache?.put(out);
  return out;
}

/** The shape `screenCheap` reads, derived from the authoritative decode. */
export function gateFactsFrom(f: DirectMintFacts): {
  hasMoneyCriticalBehaviour: boolean;
  hasUnknownExtension: boolean;
  transferFeeBps: number | null;
  detail: string;
} {
  const hostile = [
    f.permanentDelegate,
    f.defaultAccountState,
    f.transferHook,
    f.nonTransferable,
    f.pausable,
    f.confidential,
  ].includes('HOSTILE');
  return {
    hasMoneyCriticalBehaviour: hostile || f.hasUnknownExtension,
    hasUnknownExtension: f.hasUnknownExtension,
    // The gate sizes a soft risk on this, so it gets the fee that could
    // actually be charged rather than the one charged today.
    transferFeeBps: f.currentEpochTransferFeeBps,
    detail:
      f.decodeFailure !== null
        ? f.decodeFailure
        : f.reasons.length > 0
          ? f.reasons.join('; ')
          : f.tokenProgram === TOKEN_2022_PROGRAM
            ? 'Token-2022 mint with no money-critical extension'
            : 'legacy SPL Token mint',
  };
}
