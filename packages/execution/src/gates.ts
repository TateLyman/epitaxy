import { existsSync } from 'node:fs';
import type { Db } from '../../storage/src/db.js';
import { killSwitchEngaged } from '../../domain/src/config.js';
import { buildReadiness } from '../../research/src/readiness.js';
import type { AppConfig, Secrets } from '../../domain/src/config.js';
import type { Mode } from '../../domain/src/types.js';

/**
 * Deployment gates.
 *
 * Promotion from paper to canary, and from canary to live, is a claim that the
 * system has earned a larger blast radius. This file makes that claim checkable
 * by a machine, because the alternative is an operator at 2am deciding that the
 * evidence is probably fine.
 *
 * Two properties are deliberate:
 *
 *  - Every threshold is a number written down here, not a judgement made at
 *    promotion time. The numbers are choices, not derivations, and they are
 *    reported alongside the observation so a reader can disagree with the
 *    choice rather than having to reverse-engineer it.
 *
 *  - A gate whose evidence cannot be gathered FAILS. Not "passes with a
 *    warning". An unmeasurable precondition is exactly the case where a system
 *    is most likely to be wrong about itself.
 */

export interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly observed: string;
  readonly required: string;
}

/** Chosen thresholds. Changing one is a decision that belongs in DECISION_LOG.md. */
export const CANARY_THRESHOLDS = {
  /**
   * PnL-ELIGIBLE positions in the CURRENT context, not closed simulated ones.
   *
   * The old gate counted `positions WHERE simulated = 1 AND closed_utc_ms IS
   * NOT NULL`, which at the time of writing was 200 rows away from being
   * satisfied by a corpus in which ZERO rows established executable PnL. It
   * would have opened canary on 200 quote-only fills from five pooled regimes.
   */
  minEligiblePositions: 200,
  minReplayedSnapshots: 1_000,
  maxReplayDivergences: 0,
  /** 21 days, not 72 hours. Three days cannot contain multiple market regimes. */
  minObservationHours: 21 * 24,
} as const;

export const LIVE_THRESHOLDS = {
  minConfirmedOnChainFills: 30,
  maxUnresolvedAttempts: 0,
  maxFailedAttemptRate: 0.2,
} as const;

function one<T>(db: Db, sql: string, params: unknown[] = []): T | null {
  return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function gate(name: string, passed: boolean, observed: string, required: string): GateResult {
  return { name, passed, observed, required };
}

/**
 * Gates that must hold before any mode that can sign is permitted to start.
 * These are about the machine and the operator, not about the strategy.
 */
export function operationalGates(config: AppConfig, secrets: Secrets, db: Db): GateResult[] {
  const results: GateResult[] = [];

  results.push(
    gate(
      'signer.keypair',
      secrets.tradingKeypairPath !== null,
      secrets.tradingKeypairPath === null ? 'TRADING_KEYPAIR_PATH unset' : 'keypair path configured',
      'TRADING_KEYPAIR_PATH must be set',
    ),
  );

  // A public endpoint refuses the methods this path depends on and rate-limits
  // the rest. Discovering that mid-trade means an unresolved position.
  results.push(
    gate(
      'rpc.primary',
      secrets.rpcHttp !== null,
      secrets.rpcHttp === null ? 'SOLANA_RPC_HTTP unset' : 'primary endpoint configured',
      'a dedicated RPC endpoint is required to sign',
    ),
  );

  // Startup is the weakest place this can be checked, which is why it is not the
  // only place: the run loops call killSwitchEngaged() every cycle.
  const killed = killSwitchEngaged();
  results.push(
    gate(
      'kill.switch',
      killed === null,
      killed === null ? 'no KILL file' : `KILL file present at ${killed}`,
      'KILL file must be absent',
    ),
  );

  const unresolved =
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM execution_attempts WHERE outcome IN ('SIGNED','SUBMITTED','UNKNOWN')")
      ?.n ?? 0;
  results.push(
    gate(
      'execution.noUnresolved',
      unresolved <= LIVE_THRESHOLDS.maxUnresolvedAttempts,
      `${unresolved} attempt(s) of unknown fate`,
      `at most ${LIVE_THRESHOLDS.maxUnresolvedAttempts}`,
    ),
  );

  results.push(
    gate(
      'config.mode',
      config.mode === 'canary' || config.mode === 'live',
      `config declares mode ${config.mode}`,
      'canary or live',
    ),
  );

  return results;
}

/**
 * Evidence gates for canary. Canary risks the smallest amount of real money
 * that still proves the execution path works end to end, so what it must
 * demonstrate first is that the DECISION path has been exercised honestly.
 */
export function canaryEvidenceGates(db: Db, config: AppConfig): GateResult[] {
  const results: GateResult[] = [];

  // §12.1 / §12.3 — the evidence contract, as a query.
  //
  // Every clause the preregistration asserts is checked here. A closed
  // simulated position is not evidence; a position with BOTH legs observed in
  // ONE route family, both policies passed, both simulated, raw payloads
  // retained, in the current context, is.
  const eligible =
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM positions p
       JOIN execution_observations e ON e.observation_id = p.entry_observation_id
       JOIN execution_observations x ON x.observation_id = p.exit_observation_id
       WHERE p.closed_utc_ms IS NOT NULL
         AND p.context_hash IS NOT NULL
         AND CAST(p.token_amount AS INTEGER) = 0
         AND e.family = x.family
         AND e.side = 'buy' AND x.side = 'sell'
         AND e.requested_amount = CAST(? AS TEXT) OR 1=0`,
      ['never'],
    )?.n ?? 0;
  const eligibleStrict =
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM positions p
       JOIN execution_observations e ON e.observation_id = p.entry_observation_id
       JOIN execution_observations x ON x.observation_id = p.exit_observation_id
       JOIN run_contexts c ON c.context_hash = p.context_hash
       WHERE p.closed_utc_ms IS NOT NULL
         AND CAST(p.token_amount AS INTEGER) = 0
         AND c.source_commit NOT LIKE '%+dirty'
         AND e.family = x.family
         AND e.instruction_policy = 'PASS' AND x.instruction_policy = 'PASS'
         AND e.transaction_policy = 'PASS' AND x.transaction_policy = 'PASS'
         AND e.simulation = 'SIMULATED_OK' AND x.simulation = 'SIMULATED_OK'
         AND e.raw_payload_hash IS NOT NULL AND x.raw_payload_hash IS NOT NULL`,
    )?.n ?? 0;
  void eligible;
  results.push(
    gate(
      'evidence.pnlEligiblePositions',
      eligibleStrict >= CANARY_THRESHOLDS.minEligiblePositions,
      `${eligibleStrict} PnL-eligible positions (both legs observed, one family, policy + simulation passed, clean commit)`,
      `at least ${CANARY_THRESHOLDS.minEligiblePositions}`,
    ),
  );

  // A position still holding tokens is exposure, whatever its state says. The
  // gate refuses to promote while any exists.
  const stray =
    one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM positions WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0 AND state NOT IN ('POSITION_OPEN','EXIT_INTENT','EXIT_BLOCKED','RECONCILING')",
    )?.n ?? 0;
  results.push(
    gate('evidence.noUnmanagedPositions', stray === 0, `${stray} unmanaged position(s) holding tokens`, 'exactly 0'),
  );

  const blocked =
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM positions WHERE state = 'EXIT_BLOCKED'")?.n ?? 0;
  results.push(
    gate('evidence.noBlockedExits', blocked === 0, `${blocked} position(s) in EXIT_BLOCKED`, 'exactly 0'),
  );

  const unresolvedResync =
    one<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM clock_checkpoints WHERE resync_required = 1 AND resync_done_utc_ms IS NULL',
    )?.n ?? 0;
  results.push(
    gate(
      'evidence.noUnresolvedReconciliation',
      unresolvedResync === 0,
      `${unresolvedResync} unresolved clock discontinuity`,
      'exactly 0',
    ),
  );

  const window = one<{ first: number | null; last: number | null }>(
    db,
    'SELECT MIN(evaluated_utc_ms) AS first, MAX(evaluated_utc_ms) AS last FROM screenings WHERE strategy_version = ?',
    [config.strategyVersion],
  );
  const hours =
    window?.first != null && window.last != null ? (window.last - window.first) / 3_600_000 : 0;
  results.push(
    gate(
      'evidence.observationWindow',
      hours >= CANARY_THRESHOLDS.minObservationHours,
      `${hours.toFixed(1)}h on ${config.strategyVersion}`,
      `at least ${CANARY_THRESHOLDS.minObservationHours}h on the CURRENT strategy version`,
    ),
  );

  // `decision_snapshots` carries no strategy_version column -- the version
  // lives on `screenings`. Counting the corpus is all this gate does; whether
  // it REPLAYS at the current version is the separate gate below, which is the
  // whole point of splitting them.
  const snapshots = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM decision_snapshots')?.n ?? 0;
  results.push(
    gate(
      'evidence.replayCorpus',
      snapshots >= CANARY_THRESHOLDS.minReplayedSnapshots,
      `${snapshots} decision snapshots`,
      `at least ${CANARY_THRESHOLDS.minReplayedSnapshots}`,
    ),
  );

  // §12.3 — read the ACTUAL replay result, do not infer it from a count.
  //
  // The gate above says a corpus exists. Whether it replays is a different
  // question, and inferring "replay passed" from "enough snapshots exist" is
  // the same shape of error as inferring "the route is tradable" from "a price
  // came back".
  const replay = latestReplayResult(db);
  results.push(
    gate(
      'evidence.replayResult',
      replay !== null &&
        replay.divergences <= CANARY_THRESHOLDS.maxReplayDivergences &&
        replay.replayed > 0 &&
        replay.strategyVersion === config.strategyVersion,
      replay === null
        ? 'no machine-generated replay result has been recorded'
        : `${replay.replayed} replayed, ${replay.divergences} divergent, ${replay.unverifiable} unverifiable on ${replay.strategyVersion}`,
      `a recorded replay run on ${config.strategyVersion} with ${CANARY_THRESHOLDS.maxReplayDivergences} divergences`,
    ),
  );

  return results;
}

export interface ReplayResultRow {
  readonly runUtcMs: number;
  readonly strategyVersion: string;
  readonly examined: number;
  readonly replayed: number;
  readonly divergences: number;
  readonly unverifiable: number;
  readonly sourceCommit: string | null;
}

/**
 * The most recent recorded replay run.
 *
 * Written by `pnpm replay`, read here. A gate that recomputes replay itself
 * would be a gate that can be satisfied by the gate, which is not evidence.
 */
export function latestReplayResult(db: Db): ReplayResultRow | null {
  try {
    return (
      (db
        .prepare(
          `SELECT run_utc_ms AS runUtcMs, strategy_version AS strategyVersion, examined, replayed,
                  divergences, unverifiable, source_commit AS sourceCommit
           FROM replay_runs ORDER BY run_utc_ms DESC LIMIT 1`,
        )
        .get() as ReplayResultRow | undefined) ?? null
    );
  } catch {
    // Table absent at an older schema version. Absent is not a pass.
    return null;
  }
}

/**
 * Evidence gates for live. Live is permitted only once canary has produced
 * real, signed, confirmed transactions — the one thing paper mode structurally
 * cannot demonstrate.
 */
export function liveEvidenceGates(db: Db): GateResult[] {
  const results: GateResult[] = [];

  const confirmed = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM execution_attempts WHERE outcome = 'CONFIRMED'")?.n ?? 0;
  results.push(
    gate(
      'evidence.onChainFills',
      confirmed >= LIVE_THRESHOLDS.minConfirmedOnChainFills,
      `${confirmed} confirmed on-chain transactions`,
      `at least ${LIVE_THRESHOLDS.minConfirmedOnChainFills} from canary`,
    ),
  );

  const totals = one<{ n: number; failed: number }>(
    db,
    "SELECT COUNT(*) AS n, SUM(CASE WHEN outcome IN ('FAILED','EXPIRED') THEN 1 ELSE 0 END) AS failed FROM execution_attempts",
  );
  const attempted = totals?.n ?? 0;
  const rate = attempted === 0 ? 1 : (totals?.failed ?? 0) / attempted;
  results.push(
    gate(
      'evidence.attemptFailureRate',
      attempted > 0 && rate <= LIVE_THRESHOLDS.maxFailedAttemptRate,
      attempted === 0 ? 'no attempts recorded' : `${(rate * 100).toFixed(1)}% failed or expired of ${attempted}`,
      `at most ${(LIVE_THRESHOLDS.maxFailedAttemptRate * 100).toFixed(0)}% over a non-empty sample`,
    ),
  );

  // Every on-chain fill must carry the signature that produced it. A fill
  // without one cannot be checked against the chain, which makes the P&L a
  // story rather than a record.
  const unsigned =
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM fills WHERE simulated = 0 AND (signature IS NULL OR signature = '')")
      ?.n ?? 0;
  results.push(
    gate('evidence.fillsVerifiable', unsigned === 0, `${unsigned} unsigned on-chain fills`, 'exactly 0'),
  );

  return results;
}

/**
 * P18 — the profitability gate, folded into the deployment decision.
 *
 * `canaryEvidenceGates()` above asks whether the decision path was exercised
 * honestly. It could pass after 200 losing trades, because it counted positions
 * and never asked what they earned, and it accepted development JIT rows as
 * evidence because it read `simulation='SIMULATED_OK'`.
 *
 * The readiness report asks whether there is an edge. Both must pass: honest
 * measurement of a losing strategy is still a losing strategy, and a profitable
 * result measured badly is not a result.
 *
 * A failed gate is never weakened to make a run possible. A threshold moved for
 * that reason is not evidence about the strategy; it is evidence about whoever
 * moved it.
 */
export function canaryProfitabilityGates(db: Db, config: AppConfig): GateResult[] {
  const report = buildReadiness(db, 'unchecked', config.strategyVersion, Date.now());
  return report.gates.map((x) => gate(`readiness.${x.id}`, x.pass, x.observed, x.required));
}

export function evaluateGates(mode: Mode, config: AppConfig, secrets: Secrets, db: Db): GateResult[] {
  const results = [
    ...operationalGates(config, secrets, db),
    ...canaryEvidenceGates(db, config),
    ...canaryProfitabilityGates(db, config),
  ];
  if (mode === 'live') {
    results.push(...liveEvidenceGates(db));
    results.push(
      gate(
        'live.acknowledgement',
        secrets.liveAckPath !== null && existsSync(secrets.liveAckPath),
        secrets.liveAckPath === null ? 'LIVE_ACK_PATH unset' : `ack file ${secrets.liveAckPath}`,
        'an operator-created acknowledgement file must exist',
      ),
    );
  }
  return results;
}
