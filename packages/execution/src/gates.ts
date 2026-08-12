import { existsSync } from 'node:fs';
import type { Db } from '../../storage/src/db.js';
import { killSwitchEngaged } from '../../domain/src/config.js';
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
  minClosedPaperPositions: 200,
  minReplayedSnapshots: 1_000,
  maxReplayDivergences: 0,
  minObservationHours: 72,
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

  const closed =
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM positions WHERE simulated = 1 AND closed_utc_ms IS NOT NULL')
      ?.n ?? 0;
  results.push(
    gate(
      'evidence.paperPositions',
      closed >= CANARY_THRESHOLDS.minClosedPaperPositions,
      `${closed} closed paper positions`,
      `at least ${CANARY_THRESHOLDS.minClosedPaperPositions}`,
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

  const snapshots = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM decision_snapshots')?.n ?? 0;
  results.push(
    gate(
      'evidence.replayCorpus',
      snapshots >= CANARY_THRESHOLDS.minReplayedSnapshots,
      `${snapshots} decision snapshots`,
      `at least ${CANARY_THRESHOLDS.minReplayedSnapshots} (replay must then show ${CANARY_THRESHOLDS.maxReplayDivergences} divergences)`,
    ),
  );

  return results;
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

export function evaluateGates(mode: Mode, config: AppConfig, secrets: Secrets, db: Db): GateResult[] {
  const results = [...operationalGates(config, secrets, db), ...canaryEvidenceGates(db, config)];
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
