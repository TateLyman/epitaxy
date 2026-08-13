import type { SimulationRequest, SimulationResponse } from './protocol.js';
import { aggregateTokenDeltas, deltaFor, type TokenDelta } from './tokenbalance.js';

/**
 * P3 — whether the intended trade actually HAPPENED.
 *
 * A Solana runtime that returns no transaction error has proved one thing: the
 * instructions did not abort. It has not proved that the taker received an
 * output, that the debit was the one intended, that the fee was what the caller
 * modelled, or that value did not move somewhere nobody was watching.
 *
 * Those are four separate questions and this repository has already been burned
 * by collapsing them. `SIMULATED_OK` was read as "the leg works" by the exit
 * gate, the shadow book and the readiness check, when all it ever meant was
 * "the runtime did not complain".
 *
 * Runtime success is necessary. It is not sufficient, and nothing here may
 * treat it as though it were.
 */

export type EffectCheck = 'RUNTIME_OK' | 'EFFECT_OK' | 'FEE_DECOMPOSITION_OK' | 'ACCOUNT_COVERAGE_OK';

export interface EffectVerdict {
  /** All four passed. The only value any executable decision may act on. */
  readonly simulatedEffectOk: boolean;
  readonly checks: Readonly<Record<EffectCheck, boolean>>;
  /**
   * Why each failing check failed, in the directive's own words where they
   * apply. A refusal without a reason cannot be argued with, and an unexplained
   * pass cannot be audited.
   */
  readonly refusals: readonly string[];

  /** The measured economics, kept whether the verdict passed or not. */
  readonly inputDebit: bigint | null;
  readonly outputCredit: bigint | null;
  readonly baseFeeLamports: bigint | null;
  readonly priorityFeeLamports: bigint | null;
  readonly tipLamports: bigint | null;
  readonly rentCreatedLamports: bigint | null;
  readonly rentRecoveredLamports: bigint | null;
  readonly transferFeeLamports: bigint | null;
  readonly withheldFeeLamports: bigint | null;
  /** Value that moved to a writable nobody asserted would receive it. */
  readonly unexpectedMovementLamports: bigint;
  readonly unexpectedRecipients: readonly string[];
  /** Whether every writable the run touched was observed pre AND post. */
  readonly completeAccountCoverage: boolean;
  readonly unobservedAccounts: readonly string[];
  readonly boundsViolations: readonly string[];
  /** P2 — every token movement the run observed, with its identity intact. */
  readonly tokenDeltas: readonly TokenDelta[];
}

const WSOL = 'So11111111111111111111111111111111111111112';

function big(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * REMOVED: `tokenKey(owner, mint)`.
 *
 * P2 — it built `${owner}:${mint}` and looked that up in a map the daemon keyed
 * by TOKEN-ACCOUNT PUBKEY. The lookup could never match. Every token delta read
 * as unobserved, so a buy that credited its ATA exactly as intended was refused
 * for "output delta is missing", and eleven runtime-successful jobs were
 * recorded as economic failures.
 *
 * Token deltas now come from `aggregateTokenDeltas`, which reads the structured
 * rows and carries the account identity rather than encoding it into a string
 * two files had to agree about.
 */

/**
 * Delta of a balance map, treating an ABSENT entry as unknown rather than zero.
 *
 * The distinction is the whole point. A missing post-balance means the daemon
 * did not observe the account; reading it as zero turns "we did not look" into
 * "it went to nothing", which is the same error that made every rejected token
 * appear to go to zero in reject tracking. Absence is a fact about the
 * observation, never about the value.
 */
function delta(
  pre: Readonly<Record<string, string>>,
  post: Readonly<Record<string, string>>,
  key: string,
): { value: bigint | null; observed: boolean } {
  const a = big(pre[key]);
  const b = big(post[key]);
  if (a === null || b === null) return { value: null, observed: false };
  return { value: b - a, observed: true };
}

export interface EffectContext {
  readonly taker: string;
  readonly side: 'buy' | 'sell';
  readonly inputMint: string;
  readonly outputMint: string;
  /**
   * Accounts that are ALLOWED to gain value: the taker, the fee payer, and any
   * account the caller expects to pay (a tip receiver, a venue's fee account).
   * Everything else gaining lamports is unexpected movement.
   */
  readonly expectedRecipients?: readonly string[];
  /**
   * P2 — which token program the caller expects each side under.
   *
   * Supplying it turns a near-enough match into an assertion: an owner can hold
   * one mint under both legacy Token and Token-2022, and adding those together
   * produces a balance in an asset that does not exist. Absent means the caller
   * does not know, and the lookup then requires the mint to be unambiguous.
   */
  readonly inputTokenProgram?: string | null;
  readonly outputTokenProgram?: string | null;
  /** What the caller told the broadcaster it would tip, if anything. */
  readonly declaredTipLamports?: bigint | null;
}

/**
 * Verify the economic effect of a completed simulation.
 *
 * Every check defaults to FAILING. A verdict that cannot be computed is not a
 * pass -- it is exactly the state where the apparatus has stopped reporting and
 * the temptation to read silence as success is strongest.
 */
export function verifyEffect(
  req: SimulationRequest,
  res: SimulationResponse,
  ctx: EffectContext,
): EffectVerdict {
  const refusals: string[] = [];

  // ---- RUNTIME_OK --------------------------------------------------------
  const runtimeOk = res.status === 'SIMULATED_OK' && res.transactionError === null;
  if (!runtimeOk) {
    refusals.push(`runtime did not succeed: ${res.transactionError ?? res.status}`);
  }

  // ---- the measured movement --------------------------------------------
  const solDelta = delta(res.preSolBalances, res.postSolBalances, ctx.taker);
  const inputIsSol = ctx.inputMint === WSOL;
  const outputIsSol = ctx.outputMint === WSOL;

  // P2 — the structured view. One audited aggregation, one identity per row.
  //
  // A mismatch inside the rows (an account that changed mint, or an owner
  // holding one mint under two token programs) throws rather than resolving to
  // a plausible number, and the throw is caught here and reported as a refusal
  // instead of taking the verdict down.
  let tokenDeltas: readonly TokenDelta[] = [];
  let tokenIdentityError: string | null = null;
  try {
    tokenDeltas = aggregateTokenDeltas(res.preTokenAccounts ?? [], res.postTokenAccounts ?? []);
  } catch (e) {
    tokenIdentityError = (e as Error).message;
  }

  const pick = (mint: string, program: string | null | undefined): { value: bigint | null; observed: boolean } => {
    if (tokenIdentityError !== null) return { value: null, observed: false };
    let hit: TokenDelta | null = null;
    try {
      hit = deltaFor(tokenDeltas, ctx.taker, mint, program ?? null);
    } catch (e) {
      tokenIdentityError = (e as Error).message;
      return { value: null, observed: false };
    }
    if (hit === null || hit.delta === null) return { value: null, observed: false };
    return { value: hit.delta, observed: true };
  };

  const inTok = inputIsSol ? { value: null, observed: false } : pick(ctx.inputMint, ctx.inputTokenProgram);
  const outTok = outputIsSol ? { value: null, observed: false } : pick(ctx.outputMint, ctx.outputTokenProgram);

  const baseFee = big(res.baseFeeLamports);
  const priorityFee = big(res.priorityFeeLamports);
  const rentCreated = big(res.rentCreatedLamports);
  const rentRecovered = big(res.rentRecoveredLamports);
  const transferFee = big(res.transferFeeLamports);
  const withheldFee = big(res.withheldFeeLamports);

  // The input debit. A buy spends lamports, and its SOL delta also carries the
  // fee, so the fee is subtracted out rather than counted as trade cost twice.
  let inputDebit: bigint | null = null;
  if (inputIsSol) {
    if (solDelta.observed && solDelta.value !== null) {
      const fees = (baseFee ?? 0n) + (priorityFee ?? 0n) + (rentCreated ?? 0n) - (rentRecovered ?? 0n);
      inputDebit = -solDelta.value - fees;
    }
  } else if (inTok.observed && inTok.value !== null) {
    inputDebit = -inTok.value;
  }

  const outputCredit = outputIsSol
    ? solDelta.observed && solDelta.value !== null
      ? solDelta.value + (baseFee ?? 0n) + (priorityFee ?? 0n) + (rentCreated ?? 0n) - (rentRecovered ?? 0n)
      : null
    : outTok.observed
      ? outTok.value
      : null;

  // ---- EFFECT_OK ---------------------------------------------------------
  const requested = big(req.requestedAmount);
  const minOut = big(req.bounds.minTokenDelta ?? null);
  const maxSpend = big(req.bounds.maxLamportsSpent);

  let effectOk = runtimeOk;
  if (runtimeOk) {
    if (outputCredit === null) {
      refusals.push('runtime succeeds but output delta is missing');
      effectOk = false;
    } else if (outputCredit <= 0n) {
      refusals.push('runtime succeeds but output delta is missing');
      effectOk = false;
    } else if (minOut !== null && outputCredit < minOut) {
      refusals.push(`runtime succeeds but output is below minimum: ${outputCredit} < ${minOut}`);
      effectOk = false;
    }

    if (inputDebit === null) {
      refusals.push('runtime succeeds but the input debit could not be measured');
      effectOk = false;
    } else if (requested !== null && inputDebit > requested) {
      // Spending MORE than the leg asked for is the failure. Spending less on a
      // partial fill is a different fact and is not silently accepted either:
      // it is reported through the debit itself.
      refusals.push(`runtime succeeds but input debit exceeds the requested amount: ${inputDebit} > ${requested}`);
      effectOk = false;
    }
    if (inputIsSol && inputDebit !== null && maxSpend !== null && inputDebit > maxSpend) {
      refusals.push(`runtime succeeds but input debit exceeds maximum: ${inputDebit} > ${maxSpend}`);
      effectOk = false;
    }
  }

  // ---- unexpected movement ----------------------------------------------
  const allowed = new Set<string>([ctx.taker, req.bounds.feePayer, ...(ctx.expectedRecipients ?? [])]);
  const unexpectedRecipients: string[] = [];
  let unexpectedMovement = 0n;
  for (const [account, prev] of Object.entries(res.preSolBalances)) {
    if (allowed.has(account)) continue;
    const now = big(res.postSolBalances[account]);
    const before = big(prev);
    if (now === null || before === null) continue;
    const d = now - before;
    if (d > 0n) {
      unexpectedRecipients.push(account);
      unexpectedMovement += d;
    }
  }
  // Refuses only when the caller stated who was expected to receive value.
  //
  // Without that model, this check is unpassable and therefore meaningless:
  // every AMM swap moves lamports into pool vaults, and a rule that fails on
  // any account gaining value fails on every successful trade. A gate that
  // cannot pass is a wall, and a wall dressed as a gate teaches everyone to
  // route around it.
  //
  // The movement is ALWAYS measured and always persisted, whether or not it
  // refuses. A skim is found by looking at that number against a route plan,
  // not by asserting in advance that nothing may move.
  if (runtimeOk && unexpectedRecipients.length > 0 && (ctx.expectedRecipients?.length ?? 0) > 0) {
    refusals.push(
      `runtime succeeds but an unexpected writable receives value: ${unexpectedRecipients.slice(0, 4).join(', ')}`,
    );
    effectOk = false;
  }

  // ---- FEE_DECOMPOSITION_OK ---------------------------------------------
  //
  // Every lamport the fee payer lost must be attributable. An unexplained
  // residue is not rounding: it is a cost the model does not know about, and a
  // cost the model does not know about is exactly what turns a positive
  // backtest into a negative live account.
  const tip = ctx.declaredTipLamports ?? null;
  let feeOk = false;
  if (baseFee === null) {
    refusals.push('fee decomposition incomplete: no base fee reported');
  } else if (priorityFee === null) {
    refusals.push('fee decomposition incomplete: no priority fee reported');
  } else if (rentCreated === null || rentRecovered === null) {
    refusals.push('fee decomposition incomplete: rent movement not reported');
  } else {
    feeOk = true;
  }

  // ---- ACCOUNT_COVERAGE_OK ----------------------------------------------
  //
  // Every writable the run touched must have been observed on BOTH sides. An
  // account seen only after the fact has no delta, and a delta that cannot be
  // computed is being read as zero somewhere downstream whether or not anyone
  // intended it.
  const unobserved: string[] = [];
  for (const account of Object.keys(res.mutatedAccountHashes)) {
    const seenPre = res.preSolBalances[account] !== undefined;
    const seenPost = res.postSolBalances[account] !== undefined;
    if (!seenPre || !seenPost) unobserved.push(account);
  }
  const coverageOk = unobserved.length === 0 && res.exportOmissions.length === 0;
  if (runtimeOk && !coverageOk) {
    refusals.push(
      `runtime succeeds but a writable account was unobserved: ${[...unobserved, ...res.exportOmissions].slice(0, 4).join(', ')}`,
    );
  }

  if (tokenIdentityError !== null) {
    // Fails closed. A token identity we cannot resolve is not a token balance
    // we may guess at, and guessing is what produced the defect this replaces.
    refusals.push(`token identity could not be resolved: ${tokenIdentityError}`);
    effectOk = false;
  }

  for (const v of res.boundsViolations) refusals.push(`asserted bounds violated: ${v}`);
  if (res.boundsViolations.length > 0) effectOk = false;

  const checks: Record<EffectCheck, boolean> = {
    RUNTIME_OK: runtimeOk,
    EFFECT_OK: effectOk,
    FEE_DECOMPOSITION_OK: feeOk,
    ACCOUNT_COVERAGE_OK: coverageOk,
  };

  return {
    simulatedEffectOk: runtimeOk && effectOk && feeOk && coverageOk,
    checks,
    refusals,
    inputDebit,
    outputCredit,
    baseFeeLamports: baseFee,
    priorityFeeLamports: priorityFee,
    tipLamports: tip,
    rentCreatedLamports: rentCreated,
    rentRecoveredLamports: rentRecovered,
    transferFeeLamports: transferFee,
    withheldFeeLamports: withheldFee,
    unexpectedMovementLamports: unexpectedMovement,
    unexpectedRecipients,
    completeAccountCoverage: coverageOk,
    unobservedAccounts: unobserved,
    boundsViolations: res.boundsViolations,
    tokenDeltas,
  };
}
