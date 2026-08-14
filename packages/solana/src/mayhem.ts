import { PublicKey } from '@solana/web3.js';

/**
 * P11 — Mayhem, from what the chain actually establishes.
 *
 * I first recorded this requirement as having no verifiable source and left the
 * table empty. That was wrong, and the evidence was already in hand:
 * `isMayhemMode` is a decoded field on the PumpSwap **pool** account, in the
 * same IDL this system uses to price every swap, and `is_mayhem_mode` is a
 * field on the pump **bonding curve** account, which covers the pre-migration
 * half of a token's life. Neither needed a new dependency or a new provider.
 *
 * What is establishable is kept separate from what is not, because the second
 * half is where fabrication would happen:
 *
 *   ESTABLISHED      whether the venue runs in Mayhem mode — a decoded boolean
 *   NOT ESTABLISHED  agent identity, inventory, buys, sells, additional supply,
 *                    burn transition
 *
 * The second group needs the Mayhem program's own account layout. `MAyhSm…`
 * publishes no IDL and no decoder, so reading fields out of those bytes would
 * mean guessing offsets — and a guessed agent inventory is worse than an absent
 * one, because it would be subtracted from organic flow with confidence.
 *
 * They stay UNKNOWN with the reason attached. Absence of a provider field is a
 * fact about the provider, not about the token.
 */

/** The Mayhem program. Recorded for provenance; its layout is not decoded here. */
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

/** The pump program, which owns every bonding curve. */
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * A mint's bonding curve accounts, v1 first.
 *
 * There are TWO derivations — `bonding-curve` and `bonding-curve-v2` — and a
 * mint has whichever its launch used. Deriving only v1 returns "no account" for
 * every newer mint, which reads exactly like "this is not a pump token" and is
 * not the same statement at all.
 *
 * Seeds derived here rather than imported: `@pump-fun/pump-sdk` exports the
 * helpers and its ESM build does not load under the test runner, so importing
 * would trade a two-line derivation for an untestable module.
 */
export function bondingCurveAddresses(mint: string): { v1: string; v2: string } {
  const key = new PublicKey(mint).toBuffer();
  const program = new PublicKey(PUMP_PROGRAM);
  return {
    v1: PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), key], program)[0].toBase58(),
    v2: PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), key], program)[0].toBase58(),
  };
}

/** The v1 address alone, for callers that only want the original derivation. */
export function bondingCurveAddress(mint: string): string {
  return bondingCurveAddresses(mint).v1;
}

export type MayhemSource = 'pumpswap_pool' | 'bonding_curve' | 'none';

export interface MayhemFacts {
  readonly mint: string;
  readonly observedUtcMs: number;
  /**
   * Whether the venue runs in Mayhem mode.
   *
   * Null when neither venue was read — never false. A token whose pool and
   * bonding curve were both unavailable has not been shown to be non-Mayhem;
   * it has not been looked at.
   */
  readonly enabled: boolean | null;
  readonly source: MayhemSource;
  /** Everything the Mayhem program layout would be needed for. */
  readonly agentIdentity: null;
  readonly agentInventoryAtoms: null;
  readonly agentBuyCount: null;
  readonly agentSellCount: null;
  readonly additionalSupplyAtoms: null;
  readonly burnTransition: null;
  readonly unknownReason: string;
}

export const MAYHEM_LAYOUT_UNKNOWN =
  `the Mayhem program (${MAYHEM_PROGRAM}) publishes no IDL or decoder, so its account layout is not ` +
  'established; agent identity, inventory, buys, sells, additional supply and the burn transition are ' +
  'NOT measured rather than measured as zero';

/**
 * `is_mayhem_mode` on a pump bonding curve account.
 *
 * Anchor layout, from the published pump IDL: an 8-byte discriminator, then
 * five u64 reserves, a bool, a 32-byte creator pubkey, and the flag.
 *
 *   8 + 8*5 + 1 + 32 = 81
 *
 * Returns null rather than false for a short account, because a truncated read
 * establishes nothing and "not Mayhem" is a claim.
 */
export const BONDING_CURVE_MAYHEM_OFFSET = 81;

export function bondingCurveMayhemMode(data: Uint8Array): boolean | null {
  if (data.length <= BONDING_CURVE_MAYHEM_OFFSET) return null;
  const byte = data[BONDING_CURVE_MAYHEM_OFFSET];
  if (byte === undefined) return null;
  // A bool is 0 or 1. Anything else means the offset is not what this build
  // believes, and a wrong offset must not produce a confident answer.
  if (byte !== 0 && byte !== 1) return null;
  return byte === 1;
}

/**
 * Assemble the facts from whichever venue was readable.
 *
 * The pool wins when both are present: a migrated token trades there, and the
 * bonding curve it left behind describes a venue nobody is using.
 */
export function mayhemFactsOf(p: {
  mint: string;
  nowUtcMs: number;
  poolIsMayhemMode: boolean | null;
  bondingCurveIsMayhemMode?: boolean | null;
}): MayhemFacts {
  const fromPool = p.poolIsMayhemMode;
  const fromCurve = p.bondingCurveIsMayhemMode ?? null;
  const enabled = fromPool ?? fromCurve;
  const source: MayhemSource = fromPool !== null ? 'pumpswap_pool' : fromCurve !== null ? 'bonding_curve' : 'none';

  return {
    mint: p.mint,
    observedUtcMs: p.nowUtcMs,
    enabled,
    source,
    agentIdentity: null,
    agentInventoryAtoms: null,
    agentBuyCount: null,
    agentSellCount: null,
    additionalSupplyAtoms: null,
    burnTransition: null,
    unknownReason: MAYHEM_LAYOUT_UNKNOWN,
  };
}

/**
 * What Mayhem does to a breadth or momentum reading.
 *
 * The directive's rule: Mayhem flow may not count as independent breadth or
 * momentum. Agent buys and sells are flow the protocol produced, and counting
 * them as market interest measures the agent.
 *
 * The honest grading, given that the agent's own volume cannot be isolated
 * without the layout, is that a Mayhem venue's breadth is **unusable rather
 * than adjustable**. Subtracting an unmeasured quantity is not a correction; it
 * is a guess with a minus sign. There is deliberately no function here that
 * returns an "organic volume" number.
 */
export type BreadthUsability = 'ORGANIC' | 'CONTAMINATED_UNQUANTIFIED' | 'UNKNOWN';

export function breadthUsability(f: Pick<MayhemFacts, 'enabled'>): {
  usability: BreadthUsability;
  countsAsOrganic: boolean;
  reason: string;
} {
  if (f.enabled === null) {
    return {
      usability: 'UNKNOWN',
      countsAsOrganic: false,
      reason: 'Mayhem mode was never read for this mint, so its flow is not established as organic',
    };
  }
  if (f.enabled) {
    return {
      usability: 'CONTAMINATED_UNQUANTIFIED',
      countsAsOrganic: false,
      reason:
        'the venue runs in Mayhem mode and the agent share of flow cannot be isolated without the ' +
        'program layout, so breadth and momentum here are not independent evidence',
    };
  }
  return { usability: 'ORGANIC', countsAsOrganic: true, reason: 'the venue does not run in Mayhem mode' };
}
