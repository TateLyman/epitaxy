import type { SimulationClient } from './client.js';
import type { SimulationMode, SimulationRequest, AssetSide, BalanceMutation } from './protocol.js';
import { associatedTokenAddress } from '../../solana/src/pda.js';

/**
 * P2 — the ONE economic leg, and the one request that can be built from it.
 *
 * Two builders existed. The proof harness described a leg by naming both its
 * assets; production described one by naming a mint and a minimum delta. They
 * produced different requests, so the harness's eight effect-verified legs
 * proved nothing about the engine — and the engine, unable to name the asset a
 * buy received, produced zero.
 *
 * This type is what a leg IS. `buildSimulationRequestForLeg` is the only way to
 * turn one into a request, and every path uses it: the proof harness, the
 * production paper loop, replay, offline parity, and the future executor.
 *
 * Immutable, and complete: a field that is absent is absent because the leg
 * genuinely has no such thing (a native-SOL side has no token program), never
 * because a caller did not fill it in.
 */

const WSOL = 'So11111111111111111111111111111111111111112';

/** What the leg spends. */
export type LegInput =
  | {
      readonly kind: 'native_sol';
      readonly exactDebitLamports: bigint;
      readonly maxTotalPayerDebitLamports: bigint;
    }
  | {
      readonly kind: 'token';
      readonly mint: string;
      readonly tokenProgram: string;
      /** The exact account debited, so nothing downstream re-derives and disagrees. */
      readonly sourceTokenAccount: string;
      readonly exactDebitAtoms: bigint;
    };

/** What the leg receives. */
export type LegOutput =
  | {
      readonly kind: 'native_sol';
      readonly destinationOwner: string;
      readonly minCreditLamports: bigint;
      readonly expectedCreditLamports: bigint | null;
    }
  | {
      readonly kind: 'token';
      readonly mint: string;
      readonly tokenProgram: string;
      readonly destinationTokenAccount: string;
      readonly minCreditAtoms: bigint;
      readonly expectedCreditAtoms: bigint | null;
    };

export interface EconomicLegSpec {
  readonly side: 'buy' | 'sell';
  /**
   * The observation's ACTUAL family. Never hardcoded: two families are two
   * markets, and a request that claims the wrong one is a label about a venue
   * the leg never touched.
   */
  readonly routeFamily: string;
  /**
   * The route identity this leg exercises. `BUILD_CUSTOM` alone is too broad to
   * be a capability: it names the builder, not the pools the swap goes through.
   */
  readonly capabilityFingerprint: string;

  readonly input: LegInput;
  readonly output: LegOutput;

  /**
   * The most SOL the payer may lose, whatever the leg spends.
   *
   * On the LEG, not on the input asset. It lived on the native-input variant
   * and a token-input sell therefore had no lamport cap to bind — so the
   * builder bound the token ATOM COUNT instead. A sell of 905 atoms asserted
   * the payer could spend at most 905 lamports, and the run was refused for
   * spending 6,121 on fees it could not have avoided. An atom is not a
   * lamport, and a field that accepts either is a defect waiting for a
   * denominator.
   */
  readonly maxTotalPayerDebitLamports: bigint;

  readonly feePayer: string;
  readonly declaredTipLamports: bigint;
  /**
   * Who is permitted to gain value, from the decoded instruction graph.
   *
   * Empty is a statement that no model was supplied, and effect verification
   * treats it as such. It is not a claim that nobody should gain.
   */
  readonly expectedRecipients: readonly string[];
  readonly allowedCreatedAccounts: readonly string[];
  readonly allowedClosedAccounts: readonly string[];
}

export class InvalidLegSpec extends Error {
  constructor(reason: string) {
    super(
      `not a well-formed economic leg: ${reason}. A request built from it could still return ` +
        'SIMULATED_OK while having verified nothing about the money.',
    );
    this.name = 'InvalidLegSpec';
  }
}

/** The taker's associated account for a mint under a given program. */
export function ataFor(owner: string, mint: string, tokenProgram: string): string {
  return associatedTokenAddress(owner, mint, tokenProgram);
}

/**
 * Assemble a leg from the parts a caller actually has.
 *
 * Refuses rather than defaulting. Every historical defect this replaces took
 * the form of a missing field silently becoming a permissive value: a null
 * token program becoming legacy, a null minimum becoming zero, an unnamed
 * output asset becoming no output check at all.
 */
export function legSpec(p: {
  side: 'buy' | 'sell';
  routeFamily: string;
  capabilityFingerprint: string;
  taker: string;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  maxTotalPayerDebitLamports: bigint;
  inputTokenProgram: string | null;
  outputTokenProgram: string | null;
  /** The route's floor. Null is UNKNOWN and never becomes a zero minimum. */
  minimumOutput: bigint | null;
  expectedOutput: bigint | null;
  declaredTipLamports?: bigint;
  expectedRecipients?: readonly string[];
  allowedCreatedAccounts?: readonly string[];
  allowedClosedAccounts?: readonly string[];
}): EconomicLegSpec {
  if (p.inputMint === p.outputMint) throw new InvalidLegSpec('input and output are the same mint');
  if (p.inputAmount <= 0n) throw new InvalidLegSpec('the input amount is zero');
  if (p.routeFamily.length === 0) throw new InvalidLegSpec('no route family');
  if (p.side === 'sell' && p.inputMint === WSOL) throw new InvalidLegSpec('a sell whose input is SOL is not a sell');

  const hasFloor = p.minimumOutput !== null && p.minimumOutput > 0n;

  const input: LegInput =
    p.inputMint === WSOL
      ? {
          kind: 'native_sol',
          exactDebitLamports: p.inputAmount,
          maxTotalPayerDebitLamports: p.maxTotalPayerDebitLamports,
        }
      : (() => {
          if (p.inputTokenProgram === null || p.inputTokenProgram === '') {
            throw new InvalidLegSpec(`the input ${p.inputMint.slice(0, 8)} is a token with no token program`);
          }
          return {
            kind: 'token' as const,
            mint: p.inputMint,
            tokenProgram: p.inputTokenProgram,
            sourceTokenAccount: ataFor(p.taker, p.inputMint, p.inputTokenProgram),
            exactDebitAtoms: p.inputAmount,
          };
        })();

  const output: LegOutput =
    p.outputMint === WSOL
      ? {
          kind: 'native_sol',
          destinationOwner: p.taker,
          minCreditLamports: hasFloor ? (p.minimumOutput as bigint) : 0n,
          expectedCreditLamports: p.expectedOutput,
        }
      : (() => {
          if (p.outputTokenProgram === null || p.outputTokenProgram === '') {
            throw new InvalidLegSpec(
              `the output ${p.outputMint.slice(0, 8)} is a token with no token program, so its credit ` +
                'cannot be bound to an account',
            );
          }
          return {
            kind: 'token' as const,
            mint: p.outputMint,
            tokenProgram: p.outputTokenProgram,
            destinationTokenAccount: ataFor(p.taker, p.outputMint, p.outputTokenProgram),
            minCreditAtoms: hasFloor ? (p.minimumOutput as bigint) : 0n,
            expectedCreditAtoms: p.expectedOutput,
          };
        })();

  return {
    side: p.side,
    routeFamily: p.routeFamily,
    capabilityFingerprint: p.capabilityFingerprint,
    input,
    output,
    maxTotalPayerDebitLamports: p.maxTotalPayerDebitLamports,
    feePayer: p.taker,
    declaredTipLamports: p.declaredTipLamports ?? 0n,
    expectedRecipients: p.expectedRecipients ?? [],
    allowedCreatedAccounts: p.allowedCreatedAccounts ?? [],
    allowedClosedAccounts: p.allowedClosedAccounts ?? [],
  };
}

function inputAsset(l: EconomicLegSpec): AssetSide {
  return l.input.kind === 'native_sol'
    ? {
        kind: 'native_sol',
        exactDebitLamports: l.input.exactDebitLamports.toString(),
        maxTotalDebitLamports: l.input.maxTotalPayerDebitLamports.toString(),
      }
    : {
        kind: 'token',
        mint: l.input.mint,
        tokenProgram: l.input.tokenProgram,
        tokenAccount: l.input.sourceTokenAccount,
        exactDebitAtoms: l.input.exactDebitAtoms.toString(),
      };
}

function outputAsset(l: EconomicLegSpec): AssetSide {
  if (l.output.kind === 'native_sol') {
    return {
      kind: 'native_sol',
      ...(l.output.minCreditLamports > 0n ? { minCreditLamports: l.output.minCreditLamports.toString() } : {}),
      expectedCreditLamports:
        l.output.expectedCreditLamports === null ? null : l.output.expectedCreditLamports.toString(),
    };
  }
  return {
    kind: 'token',
    mint: l.output.mint,
    tokenProgram: l.output.tokenProgram,
    tokenAccount: l.output.destinationTokenAccount,
    ...(l.output.minCreditAtoms > 0n ? { minCreditAtoms: l.output.minCreditAtoms.toString() } : {}),
    expectedCreditAtoms: l.output.expectedCreditAtoms === null ? null : l.output.expectedCreditAtoms.toString(),
  };
}

/**
 * Fund the asset the transaction will actually DEBIT.
 *
 * A buy spends lamports. A sell spends tokens, and funding it with SOL alone is
 * what produced 43 identical failures: the token account existed with a zero
 * balance and the venue rejected the transfer at the same instruction each
 * time. The token amount is EXACTLY the hypothetical position — more would let
 * a sell succeed that the real balance could not cover.
 */
export function provisioningFor(l: EconomicLegSpec, fundingLamports: bigint): BalanceMutation[] {
  const out: BalanceMutation[] = [{ kind: 'sol', owner: l.feePayer, amount: fundingLamports.toString() }];
  if (l.input.kind === 'token') {
    out.push({
      kind: 'token',
      owner: l.feePayer,
      mint: l.input.mint,
      amount: l.input.exactDebitAtoms.toString(),
      tokenProgram: l.input.tokenProgram,
    });
  }
  return out;
}

export interface LegRequestContext {
  readonly executionObservationId: string;
  readonly mode: SimulationMode;
  readonly transactionBase64: string;
  readonly originalTransactionHash: string;
  readonly originalMessageHash: string;
  readonly originalBlockhash: string;
  readonly originalLastValidBlockHeight: number | null;
  readonly targetSlot: number | null;
  readonly snapshotManifestHash: string;
  readonly snapshotAccounts: readonly unknown[];
  readonly fundingLamports: bigint;
  readonly contextHash: string | null;
  /** Carried into the post-state of a stateful round trip. Empty on a fresh leg. */
  readonly extraMutations?: readonly BalanceMutation[];
}

/**
 * THE request constructor. Nothing else builds one.
 *
 * The hash binds every semantic field of the leg — side, family, fingerprint,
 * both assets, both token programs, both accounts, the exact input, the minimum
 * and expected output, the recipients, the snapshot manifest and the context —
 * because a hash that does not bind a field lets two different economic
 * questions share one answer.
 */
export function buildSimulationRequestForLeg(
  client: SimulationClient,
  leg: EconomicLegSpec,
  ctx: LegRequestContext,
): SimulationRequest {
  const requested = leg.input.kind === 'native_sol' ? leg.input.exactDebitLamports : leg.input.exactDebitAtoms;

  return client.buildRequest({
    executionObservationId: ctx.executionObservationId,
    mode: ctx.mode,
    transactionBase64: ctx.transactionBase64,
    originalTransactionHash: ctx.originalTransactionHash,
    originalMessageHash: ctx.originalMessageHash,
    originalBlockhash: ctx.originalBlockhash,
    originalLastValidBlockHeight: ctx.originalLastValidBlockHeight,
    // The observation's actual family, never a constant.
    routeFamily: leg.routeFamily,
    requestedAmount: requested.toString(),
    targetSlot: ctx.targetSlot,
    snapshotManifestHash: ctx.snapshotManifestHash,
    snapshotAccounts: ctx.snapshotAccounts as never[],
    balanceMutations: [...provisioningFor(leg, ctx.fundingLamports), ...(ctx.extraMutations ?? [])],
    bounds: {
      feePayer: leg.feePayer,
      // Always lamports. On a token-input sell the payer's SOL exposure is
      // fees and rent; the atom debit is bound separately, on the asset.
      maxLamportsSpent: leg.maxTotalPayerDebitLamports.toString(),
      inputAsset: inputAsset(leg),
      outputAsset: outputAsset(leg),
      expectedRecipients: leg.expectedRecipients,
      declaredTipLamports: leg.declaredTipLamports.toString(),
      allowedCreatedAccounts: leg.allowedCreatedAccounts,
      allowedClosedAccounts: leg.allowedClosedAccounts,
    },
    contextHash: ctx.contextHash,
    capabilityFingerprint: leg.capabilityFingerprint,
  });
}
