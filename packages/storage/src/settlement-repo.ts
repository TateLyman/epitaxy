import type { Db } from './db.js';
import type {
  MeasuredLegSettlement,
  SettlementAsset,
  SettlementCredit,
  SettlementCosts,
} from '../../domain/src/settlement.js';
import { aggregateTokenDeltas, deltaFor } from '../../simulator/src/tokenbalance.js';
import type { ObservedTokenBalance } from '../../simulator/src/protocol.js';

/**
 * P2 — `measuredSettlementOf(observationId, jobId)`.
 *
 * THE derivation. Every runtime and research path reads this; no caller
 * recomputes actual input, actual output, fees, rent or residual. A second
 * derivation is a second answer, and the whole point of this module is that
 * there is one.
 *
 * Reads only the persisted structured state. If a quantity was not stored, it
 * is `null` here and the settlement is incomplete — it is never reconstructed
 * from a router quote, because the router says what was asked for and this
 * says what happened.
 */

const WSOL = 'So11111111111111111111111111111111111111112';

const big = (v: string | null | undefined): bigint | null => {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
};

const parse = <T>(v: string | null, fallback: T): T => {
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

interface Row {
  observation_id: string;
  job_id: string;
  side: string;
  family: string;
  mint: string;
  input_mint: string;
  output_mint: string;
  requested_amount: string;
  expected_output: string | null;
  minimum_output: string | null;
  status: string;
  validity: string | null;
  simulated_effect_ok: number | null;
  account_coverage_ok: number | null;
  effect_refusals: string | null;
  input_debit: string | null;
  output_credit: string | null;
  base_fee_lamports: string | null;
  priority_fee_lamports: string | null;
  tip_lamports: string | null;
  rent_created_lamports: string | null;
  rent_recovered_lamports: string | null;
  transfer_fee_lamports: string | null;
  unexpected_movement_lamports: string | null;
  pre_token_accounts: string | null;
  post_token_accounts: string | null;
  created_accounts: string | null;
  closed_accounts: string | null;
  snapshot_manifest_hash: string | null;
  replayable: string | null;
  pre_sol_balances: string | null;
  post_sol_balances: string | null;
}

export class SettlementUnavailable extends Error {
  constructor(reason: string) {
    super(`no measured settlement: ${reason}`);
    this.name = 'SettlementUnavailable';
  }
}

/**
 * Derive the settlement, or explain why there is none.
 *
 * Returns null when the job or observation is missing. Returns an INCOMPLETE
 * settlement when they exist and a money-critical quantity does not — the
 * difference matters, because "no such job" and "the job did not measure the
 * fee" lead to different repairs.
 */
export function measuredSettlementOf(
  db: Db,
  observationId: string,
  jobId: string,
  taker: string,
  capabilityFingerprint = 'unknown',
): MeasuredLegSettlement | null {
  let r: Row | undefined;
  try {
    r = db
      .prepare(
        `SELECT o.observation_id, s.job_id, o.side, o.family, o.mint, o.input_mint, o.output_mint,
                o.requested_amount, o.expected_output, o.minimum_output,
                s.status, s.validity, s.simulated_effect_ok, s.account_coverage_ok, s.effect_refusals,
                s.input_debit, s.output_credit, s.base_fee_lamports, s.priority_fee_lamports,
                s.tip_lamports, s.rent_created_lamports, s.rent_recovered_lamports,
                s.transfer_fee_lamports, s.unexpected_movement_lamports,
                s.pre_token_accounts, s.post_token_accounts,
                s.created_accounts, s.closed_accounts, s.snapshot_manifest_hash, s.replayable,
                s.pre_sol_balances, s.post_sol_balances
         FROM simulation_jobs s
         JOIN execution_observations o ON o.observation_id = s.execution_observation_id
         WHERE o.observation_id = ? AND s.job_id = ?`,
      )
      .get(observationId, jobId) as Row | undefined;
  } catch (e) {
    throw new SettlementUnavailable((e as Error).message.slice(0, 120));
  }
  if (r === undefined) return null;

  const incompleteness: string[] = [];
  const need = <T>(v: T | null, name: string): T | null => {
    if (v === null) incompleteness.push(`${name} was not measured`);
    return v;
  };

  const side = r.side === 'sell' ? 'sell' : 'buy';
  const requested = big(r.requested_amount) ?? 0n;
  const inputIsSol = r.input_mint === WSOL;
  const outputIsSol = r.output_mint === WSOL;

  const preTok = parse<ObservedTokenBalance[]>(r.pre_token_accounts, []);
  const postTok = parse<ObservedTokenBalance[]>(r.post_token_accounts, []);
  let deltas: ReturnType<typeof aggregateTokenDeltas> = [];
  try {
    deltas = aggregateTokenDeltas(preTok, postTok);
  } catch (e) {
    incompleteness.push(`token identity unresolved: ${(e as Error).message.slice(0, 60)}`);
  }

  const tokenSide = (mint: string): { delta: bigint | null; account: string | null; program: string | null; post: bigint | null } => {
    try {
      const hit = deltaFor(deltas, taker, mint, null);
      if (hit === null) return { delta: null, account: null, program: null, post: null };
      return {
        delta: hit.delta,
        account: hit.accounts[0] ?? null,
        program: hit.tokenProgram,
        post: hit.postAtoms,
      };
    } catch {
      return { delta: null, account: null, program: null, post: null };
    }
  };

  // ---- input -------------------------------------------------------------
  const measuredDebit = big(r.input_debit);
  let input: SettlementAsset;
  if (inputIsSol) {
    const total = (() => {
      const pre = big(parse<Record<string, string>>(r.pre_sol_balances, {})[taker] ?? null);
      const post = big(parse<Record<string, string>>(r.post_sol_balances, {})[taker] ?? null);
      if (pre === null || post === null) return null;
      return pre - post;
    })();
    input = {
      kind: 'native_sol',
      requestedLamports: requested,
      actualTradeDebitLamports: need(measuredDebit, 'the input debit') ?? 0n,
      totalPayerDebitLamports: need(total, "the payer's total debit") ?? 0n,
    };
  } else {
    const t = tokenSide(r.input_mint);
    input = {
      kind: 'token',
      mint: r.input_mint,
      tokenProgram: need(t.program, 'the input token program') ?? '',
      tokenAccount: need(t.account, 'the input token account') ?? '',
      requestedAtoms: requested,
      // A debit is a negative delta; report it positive.
      actualDebitAtoms: t.delta === null ? (need(null, 'the token debit') ?? 0n) : -t.delta,
    };
  }

  // ---- output ------------------------------------------------------------
  const measuredCredit = big(r.output_credit);
  let output: SettlementCredit;
  if (outputIsSol) {
    output = {
      kind: 'native_sol',
      minimumLamports: big(r.minimum_output) ?? 0n,
      expectedLamports: big(r.expected_output),
      actualCreditLamports: need(measuredCredit, 'the native SOL credit') ?? 0n,
    };
  } else {
    const t = tokenSide(r.output_mint);
    output = {
      kind: 'token',
      mint: r.output_mint,
      tokenProgram: need(t.program, 'the output token program') ?? '',
      tokenAccount: need(t.account, 'the output token account') ?? '',
      minimumAtoms: big(r.minimum_output) ?? 0n,
      expectedAtoms: big(r.expected_output),
      actualCreditAtoms: need(t.delta, 'the token credit') ?? 0n,
    };
  }

  // ---- costs -------------------------------------------------------------
  const costs: SettlementCosts = {
    baseFeeLamports: need(big(r.base_fee_lamports), 'the base fee') ?? 0n,
    priorityFeeLamports: need(big(r.priority_fee_lamports), 'the priority fee') ?? 0n,
    tipLamports: big(r.tip_lamports) ?? 0n,
    // Null, not zero. The venue's own fees are inside the quoted output for
    // BUILD_CUSTOM and are not separately observed; saying zero would claim
    // they do not exist.
    protocolFeeLamports: null,
    creatorFeeLamports: null,
    lpFeeLamports: null,
    // A FAMILY FACT: BUILD_CUSTOM through Jupiter carries no platform fee.
    platformFeeLamports: 0n,
    transferFeeAtoms: null,
    transferFeeLamportsEquivalent: big(r.transfer_fee_lamports),
    rentCreatedLamports: need(big(r.rent_created_lamports), 'rent created') ?? 0n,
    rentRecoveredLamports: need(big(r.rent_recovered_lamports), 'rent recovered') ?? 0n,
    failedAttemptCostLamports: 0n,
    // Filled below, from the identity. Never from a stored column.
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: big(r.unexpected_movement_lamports) ?? 0n,
  };

  /**
   * The residual: does every lamport the payer lost have a name?
   *
   * `unexpected_movement_lamports` was read as this and is a different
   * quantity — it counts value reaching accounts the request did not name,
   * which on a working swap is the pool vaults and the new token account. It
   * measured 24,078,560 on a leg whose true residual was 0.
   */
  const payerDelta = (() => {
    const pre = big(parse<Record<string, string>>(r.pre_sol_balances, {})[taker] ?? null);
    const post = big(parse<Record<string, string>>(r.post_sol_balances, {})[taker] ?? null);
    return pre === null || post === null ? null : post - pre;
  })();

  if (payerDelta === null) {
    incompleteness.push("the payer's native balance was not observed on both sides");
  } else {
    const named =
      (outputIsSol ? (big(r.output_credit) ?? 0n) : 0n) -
      (inputIsSol ? (big(r.input_debit) ?? 0n) : 0n) -
      costs.baseFeeLamports -
      costs.priorityFeeLamports -
      costs.tipLamports -
      costs.rentCreatedLamports +
      costs.rentRecoveredLamports;
    (costs as { unexplainedLamports: bigint }).unexplainedLamports = payerDelta - named;
  }

  const residual = input.kind === 'token' ? tokenSide(r.input_mint).post : null;

  return {
    observationId: r.observation_id,
    simulationJobId: r.job_id,
    side,
    family: r.family,
    capabilityFingerprint,
    input,
    output,
    costs,
    createdAccounts: parse<string[]>(r.created_accounts, []),
    closedAccounts: parse<string[]>(r.closed_accounts, []),
    residualTokenAtoms: residual,
    payerNativeDeltaLamports: payerDelta ?? 0n,
    fullAccountCoverage: r.account_coverage_ok === 1,
    effectValid: r.simulated_effect_ok === 1,
    effectRefusals: parse<string[]>(r.effect_refusals, []),
    snapshotManifestHash: r.snapshot_manifest_hash,
    replayable: r.replayable === 'REPLAYABLE',
    complete: incompleteness.length === 0,
    incompleteness,
  };
}

/** The latest completed job for an observation, so callers need not guess. */
export function latestJobFor(db: Db, observationId: string): string | null {
  try {
    const r = db
      .prepare(
        `SELECT job_id FROM simulation_jobs
         WHERE execution_observation_id = ? AND status IN ('SIMULATED_OK','SIMULATION_FAILED')
         ORDER BY requested_utc_ms DESC LIMIT 1`,
      )
      .get(observationId) as { job_id: string } | undefined;
    return r?.job_id ?? null;
  } catch {
    return null;
  }
}
