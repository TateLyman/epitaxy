/**
 * Putting a quote and a simulated effect on the SAME basis before comparing them.
 *
 * MEASURED 2026-08-22, on the first real trade (MT136). Selling a token for SOL, the aggregator
 * quoted 19,620,084 lamports out. `verifyEffect` reported an effective output of 17,538,914 — a
 * gap of about 2,081,170, or one WSOL account rent plus fees. Three consecutive sells were refused
 * as `output_below_minimum` WHILE A REAL POSITION WAS OPEN, and only the fourth cleared.
 *
 * They were not disagreeing about the fill. They were counting different things:
 *
 *   THE QUOTE reports gross proceeds of the swap.
 *   THE EFFECT CHECK, when the output mint is SOL, reports `-lamportDelta` — the NET change in the
 *   fee payer's balance. That nets out the rent the transaction funds for a wrapped-SOL account
 *   along the way.
 *
 * The real trade settled at 19,604,797 against a 19,611,078 quote, so the QUOTE was right about
 * what arrives and the simulated basis is the one carrying the rent. Comparing them directly makes
 * a correct fill look like a bad one, and a bound that fires on good fills is worse than no bound:
 * it fires exactly when you most need to get out.
 *
 * This does not loosen the check. It converts the quote into the effect's units and then applies
 * the full slippage tolerance to that. A genuinely bad fill still fails.
 */

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

/**
 * Rent for one SPL token account, the unit the two bases differ by.
 * Confirmed against mainnet: `getMinimumBalanceForRentExemption(165)` = 2,039,280.
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * The minimum output to require of a fill, expressed in whatever units the effect check will
 * measure it in.
 *
 * For a sell into SOL the quoted gross is reduced by one account rent before slippage is applied,
 * because that is the documented difference between the two bases. For every other direction the
 * quote and the effect already agree and the quote is used unchanged.
 */
export function minOutputOnEffectBasis(params: {
  readonly outputMint: string;
  readonly quotedOut: bigint;
  readonly slippageBps: number;
}): bigint {
  const { outputMint, quotedOut, slippageBps } = params;
  const basisAdjusted = outputMint === WRAPPED_SOL
    ? (quotedOut > TOKEN_ACCOUNT_RENT_LAMPORTS ? quotedOut - TOKEN_ACCOUNT_RENT_LAMPORTS : 0n)
    : quotedOut;
  const tolerated = (basisAdjusted * BigInt(10_000 - slippageBps)) / 10_000n;
  return tolerated < 0n ? 0n : tolerated;
}
