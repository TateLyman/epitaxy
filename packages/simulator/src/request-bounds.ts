import type { AssetSide, EconomicBounds, BalanceMutation } from './protocol.js';
import { associatedTokenAddress } from '../../solana/src/pda.js';

/**
 * P2.4 — ONE construction of the economic bounds and the provisioning.
 *
 * The proof harness built the asset-aware form and produced effect-verified
 * legs. Production built the compatibility form — a single generic
 * `mint + minTokenDelta` — and produced none. Two builders meant the thing that
 * was proven and the thing that runs were different requests, so the proof
 * transferred nothing.
 *
 * Both now call this. There is no compatibility fallback here: a request that
 * cannot name its assets is refused, because such a request can still return
 * `SIMULATED_OK` while having verified nothing about the money.
 */

const WSOL = 'So11111111111111111111111111111111111111112';

export class UnnameableAsset extends Error {
  constructor(reason: string) {
    super(
      `cannot name the leg's assets: ${reason}. Simulating without them yields a run that ` +
        'can pass while checking nothing about the money.',
    );
    this.name = 'UnnameableAsset';
  }
}

export interface LegEconomics {
  readonly side: 'buy' | 'sell';
  readonly taker: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmount: bigint;
  /** Required whenever the corresponding side is a token. Never guessed. */
  readonly inputTokenProgram: string | null;
  readonly outputTokenProgram: string | null;
  readonly maxLamportsSpent: bigint;
  /** The route's floor. Null is UNKNOWN and never becomes a zero minimum. */
  readonly minimumOutput: bigint | null;
  readonly expectedOutput: bigint | null;
  readonly declaredTipLamports?: bigint;
}

function inputSide(l: LegEconomics): AssetSide {
  if (l.inputMint === WSOL) {
    return {
      kind: 'native_sol',
      exactDebitLamports: l.inputAmount.toString(),
      maxTotalDebitLamports: l.maxLamportsSpent.toString(),
    };
  }
  const program = l.inputTokenProgram;
  if (program === null || program === '') {
    throw new UnnameableAsset(`the input ${l.inputMint.slice(0, 8)} is a token with no token program`);
  }
  return {
    kind: 'token',
    mint: l.inputMint,
    tokenProgram: program,
    tokenAccount: associatedTokenAddress(l.taker, l.inputMint, program),
    exactDebitAtoms: l.inputAmount.toString(),
  };
}

function outputSide(l: LegEconomics): AssetSide {
  // A null or non-positive minimum is an unknown floor. Binding zero would
  // assert that any output at all is acceptable, which is the opposite of a
  // bound.
  const hasFloor = l.minimumOutput !== null && l.minimumOutput > 0n;

  if (l.outputMint === WSOL) {
    return {
      kind: 'native_sol',
      ...(hasFloor ? { minCreditLamports: (l.minimumOutput as bigint).toString() } : {}),
      expectedCreditLamports: l.expectedOutput === null ? null : l.expectedOutput.toString(),
    };
  }
  const program = l.outputTokenProgram;
  if (program === null || program === '') {
    throw new UnnameableAsset(`the output ${l.outputMint.slice(0, 8)} is a token with no token program`);
  }
  return {
    kind: 'token',
    mint: l.outputMint,
    tokenProgram: program,
    tokenAccount: associatedTokenAddress(l.taker, l.outputMint, program),
    ...(hasFloor ? { minCreditAtoms: (l.minimumOutput as bigint).toString() } : {}),
    expectedCreditAtoms: l.expectedOutput === null ? null : l.expectedOutput.toString(),
  };
}

/** The bounds. Throws rather than degrading to the compatibility form. */
export function economicBoundsFor(l: LegEconomics): EconomicBounds {
  if (l.inputMint === l.outputMint) throw new UnnameableAsset('input and output are the same mint');
  if (l.inputAmount <= 0n) throw new UnnameableAsset('the input amount is zero');
  return {
    feePayer: l.taker,
    maxLamportsSpent: l.maxLamportsSpent.toString(),
    inputAsset: inputSide(l),
    outputAsset: outputSide(l),
    declaredTipLamports: (l.declaredTipLamports ?? 0n).toString(),
  };
}

/**
 * Fund the asset the transaction will actually DEBIT.
 *
 * A buy spends lamports. A sell spends tokens, and funding it with SOL alone is
 * what produced 43 identical failures: the token account existed with a zero
 * balance and the venue rejected the transfer at the same instruction each time.
 *
 * The token amount is EXACTLY the hypothetical position — more would let a sell
 * succeed that the real balance could not cover.
 */
export function provisioningMutations(l: LegEconomics, fundingLamports: bigint): BalanceMutation[] {
  const out: BalanceMutation[] = [{ kind: 'sol', owner: l.taker, amount: fundingLamports.toString() }];
  if (l.inputMint !== WSOL) {
    const program = l.inputTokenProgram;
    if (program === null || program === '') {
      throw new UnnameableAsset(`cannot provision ${l.inputMint.slice(0, 8)} without its token program`);
    }
    out.push({
      kind: 'token',
      owner: l.taker,
      mint: l.inputMint,
      amount: l.inputAmount.toString(),
      tokenProgram: program,
    });
  }
  return out;
}
