import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  loadSecrets,
  signerAllowed,
  modeFromArgv,
} from '../../../packages/domain/src/config.js';
import { KILL_PATHS } from '../../../packages/domain/src/config.js';
import { haltState, exitManagementActive, mayTerminate } from '../../../packages/domain/src/halt.js';
import type { AppConfig } from '../../../packages/domain/src/config.js';
import { LAMPORTS_PER_SOL, WSOL_MINT } from '../../../packages/domain/src/types.js';
import type { Fill, Position } from '../../../packages/domain/src/types.js';
import { openDb, ProcessLock, schemaVersion } from '../../../packages/storage/src/db.js';
import type { Db } from '../../../packages/storage/src/db.js';
import {
  counters,
  insertFill,
  insertPosition,
  insertPositionExit,
  insertPositionMark,
  insertQuote,
  latestMark,
  recordHealth,
  recordSourceHealth,
  updatePosition,
} from '../../../packages/storage/src/repo.js';
import {
  annotateExit,
  insertLedgerEntry,
  markResyncDone,
  outstandingResync,
  recordClockCheckpoint,
  recordMarkAnalysis,
  stampContext,
  storeRawPayload,
  upsertRunContext,
} from '../../../packages/storage/src/provenance-repo.js';
import { ACCOUNTING_VERSION, classifyExit } from '../../../packages/domain/src/exitoutcome.js';
import type { TriggerRule } from '../../../packages/domain/src/exitoutcome.js';
import { diagnoseExit, executableValueRatioBps } from '../../../packages/domain/src/exitdiagnostic.js';

import { ATA_ACCOUNTING_VERSION, settleAtaRent } from '../../../packages/domain/src/ata.js';
import type { AtaState } from '../../../packages/domain/src/ata.js';
import { buildRunContext } from '../../../packages/domain/src/provenance.js';
import { cohortOf, type CohortAssignment } from '../../../packages/domain/src/cohort.js';
import { evidenceClassOf, type LegEvidence } from '../../../packages/domain/src/evidence.js';
import { Cadence, detectDiscontinuity, readClock, monotonicMs } from '../../../packages/domain/src/clock.js';
import type { ClockReading } from '../../../packages/domain/src/clock.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../../../packages/adapters/src/jupiter/client.js';
import { SCHEMA_VERSION as JUPITER_SCHEMA_VERSION } from '../../../packages/adapters/src/jupiter/schemas.js';
import { SourceFetchError } from '../../../packages/adapters/src/http.js';
import { SolanaRpc } from '../../../packages/solana/src/rpc.js';
import { emptyStats, runCycle } from '../../../packages/pipeline/src/cycle.js';
import { decideExit } from '../../../packages/strategy/src/exits.js';
import { scheduleMarks, assessBacklog } from '../../../packages/strategy/src/markscheduler.js';
import { BlobStore, type ExactTransactionBlob } from '../../../packages/storage/src/blobstore.js';
import { SimulationClient } from '../../../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../../../packages/simulator/src/token.js';
import { simulateLeg, simulatorHealth, exactBlobFor } from './simulate-observation.js';
import { sizePosition, plannedLossFractionBps } from '../../../packages/strategy/src/portfolio.js';
import type { PortfolioState } from '../../../packages/strategy/src/portfolio.js';
import { logger, sanitizeExternal } from '../../../packages/observability/src/log.js';
import { formatAmount } from '../../../packages/domain/src/amounts.js';
import { realizedWeek, restoreLedger, rollDayIfNeeded } from './ledger.js';
import type { Ledger } from './ledger.js';
import { observeRoute } from './observe-route.js';
import { ReserveAlarm } from './risk-alarm.js';
import { LogsWatcher } from '../../../packages/adapters/src/logswatch.js';
import { EventPipeline } from '../../../packages/adapters/src/event-pipeline.js';
import type { ParsedEvent } from '../../../packages/adapters/src/event-pipeline.js';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from '../../../packages/solana/src/pump.js';

/**
 * P15 — the running alarm, set once by `main()`.
 *
 * Module-level because the cycle functions are free functions rather than
 * methods; threading it through six signatures would say nothing extra. Null
 * when no websocket URL is configured, which is a coverage fact the engine
 * records at startup rather than a silence.
 */
let alarm: ReserveAlarm | null = null;

/**
 * Mints an alarm has asked to be re-observed before their next scheduled mark.
 *
 * Module-level for the same reason the alarm is: the cycle functions are free
 * functions, and this set is written by a socket callback and read by the mark
 * loop. It was previously scoped inside main(), which is why nothing consumed
 * it - the reader could not see it.
 */
const urgentMarks = new Set<string>();
import { admitPortfolioEntry } from './paper-core.js';
import { tokenProgramFromTransaction } from '../../../packages/solana/src/tokenprogram.js';
import { fingerprintForObservation } from '../../../packages/research/src/fingerprint-of-observation.js';
import { canonicalPoolFor } from '../../../packages/solana/src/pumpswap-model.js';
import {
  acquiredTokens,
  entryCashOut,
  executionCost,
  transferFeeOrUnknown,
  exitCashIn,
  isPnlEligible,
  immediateRoundTrip,
} from '../../../packages/domain/src/settlement.js';
import {
  measuredSettlementOf,
  latestJobFor,
} from '../../../packages/storage/src/settlement-repo.js';
import { chooseDecisionMark, admitPortfolioExit } from './paper-core.js';
import { legIsExecutable } from '../../../packages/domain/src/execution.js';
import {
  assertTransition,
  holdsExposure,
  type ShadowState,
} from '../../../packages/domain/src/shadow-lifecycle.js';
import { allocateArm } from '../../../packages/domain/src/tournament.js';
import {
  resolveFill,
  lookAheadBiasLamports,
  FROZEN_FILL_LATENCY_MS,
} from '../../../packages/domain/src/fill-latency.js';
import {
  bindEntryObservation,
  bindExitObservation,
  managedPositions,
  markExitBlocked,
  openShadowPosition,
  openShadowPositions,
  insertShadowMark,
  observationById,
  armCounts,
  assignTournamentArm,
  triggerShadowExit,
  blockShadowExit,
  resumeShadowExit,
  fillShadowExit,
  fillCandidatesSince,
  updateShadowPeak,
  unmanagedPositions,
  claimSignalEpisode,
  bindEpisode,
  closeSignalEpisode,
} from '../../../packages/storage/src/observation-repo.js';
import {
  netExpectedOutput,
  netMinimumOutput,
  totalEntryCost,
  netExitProceeds,
  type SimulationEffectOutcome,
} from '../../../packages/domain/src/execution.js';

/**
 * Paper mode.
 *
 * Runs the identical screening pipeline as observe, then maintains simulated
 * positions against REAL executable quotes. Nothing here is signed or sent:
 * the process holds no key for any address, and paper mode refuses to start if
 * one is configured.
 *
 * Fill honesty rules, applied without exception:
 *  - BOTH legs must be structurally buildable. An entry may only be booked when
 *    `/swap/v2/build` returns an instruction set that passes the same program
 *    allowlist, instruction cap, signer rule and priority-fee cap the executor
 *    enforces; an exit may only be booked on the same terms. Until P2a.1 the
 *    entry leg was gated and the exit leg was not, so a position could be
 *    opened on a proven route and closed against a price nobody had shown could
 *    be traded;
 *  - an ENTRY fill uses the quote's `otherAmountThreshold` — the worst amount
 *    the router guarantees at that slippage — never the optimistic `outAmount`,
 *    so we never credit ourselves tokens a live buy might not have received;
 *  - an EXIT is valued at `outAmount`, the router's expected output. The
 *    asymmetry is the conservative direction in both cases:
 *    `otherAmountThreshold` is derived from our own `slippageBps` and is
 *    therefore not an observation of the market at all, so marking an open
 *    position against it subtracted a constant we had chosen ourselves. Exit
 *    slippage is modelled where slippage belongs — in the cost model;
 *  - priority fee is charged on entry even though no transaction was sent,
 *    because a live entry would pay it;
 *  - ATA rent is LOCKED, not spent, and is credited back only when a close
 *    would be structurally valid. It never is in paper, because withheld
 *    transfer fees are unobserved, so recovery is zero and says why;
 *  - the modelled new-token fee is the DOCUMENTED 50 bps, not the 10 bps we
 *    measured, so paper results cannot be flattered by an unexplained discount.
 *    The fee the response actually reported is persisted beside it.
 *
 * A paper P&L that would not survive being wrong about those things is not
 * evidence of anything.
 */

const log = logger.child({ app: 'paper' });

/**
 * How often both clocks are persisted together.
 *
 * Five minutes: often enough that a drift is caught within one mark window of
 * an operator looking, rare enough that the table stays a log of the clock
 * rather than a second copy of the cycle log.
 */
const CLOCK_CHECKPOINT_INTERVAL_MS = 300_000;

/**
 * How often a blocked exit is retried.
 *
 * A position that cannot be sold is still ours, so the retry must keep
 * happening; it must not consume the whole rate budget doing so. Thirty seconds
 * is roughly three mark intervals, which is frequent enough that a route
 * reappearing is noticed quickly and rare enough that a permanently dead token
 * does not starve everything else.
 */
const EXIT_RETRY_INTERVAL_MS = 30_000;

/**
 * The current epoch, cached for an epoch's worth of time.
 *
 * Refreshed on a timer rather than per cycle: an epoch is roughly two days and
 * asking every ten seconds spends a call to learn a number that did not move.
 * Null when it could not be read, and null means the fee decoder takes the
 * worst of the mint's two schedules — the safe direction.
 */
let cachedEpoch: { value: bigint; readUtcMs: number } | null = null;
async function currentEpochOf(rpc: { configured: boolean; getEpoch(): Promise<bigint> }): Promise<bigint | null> {
  if (!rpc.configured) return null;
  const now = Date.now();
  if (cachedEpoch !== null && now - cachedEpoch.readUtcMs < 30 * 60_000) return cachedEpoch.value;
  try {
    const value = await rpc.getEpoch();
    cachedEpoch = { value, readUtcMs: now };
    return value;
  } catch {
    return cachedEpoch?.value ?? null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(modeFromArgv());
  const secrets = loadSecrets();

  if (config.mode !== 'paper') {
    throw new Error(`paper engine runs only in paper mode; got "${config.mode}"`);
  }
  if (signerAllowed(config.mode)) {
    throw new Error('internal invariant violated: signer must never be permitted in paper mode');
  }
  if (secrets.tradingKeypairPath !== null) {
    // Paper mode has no use for a key. Its presence means the operator believes
    // this process can trade, and that belief is the dangerous part.
    throw new Error('TRADING_KEYPAIR_PATH is set while running paper mode — refusing to start');
  }

  const db = openDb({ path: secrets.databasePath });
  const lock = new ProcessLock(db, 'engine', config.mode);
  const held = lock.acquire();
  if (!held.ok) {
    throw new Error(`another engine holds the lock (pid=${held.heldBy}, heartbeat ${held.ageMs}ms ago)`);
  }

  // Provenance first, so every row this process writes can say what produced
  // it. A dirty tree is reported as dirty rather than attributed to HEAD.
  const ctx = buildRunContext(config, {
    schemaVersion: schemaVersion(db),
    quoteSchemaVersion: JUPITER_SCHEMA_VERSION,
    nowUtcMs: Date.now(),
  });
  const contextHash = upsertRunContext(db, ctx, config.mode);
  if (ctx.sourceCommit.endsWith('+dirty')) {
    recordHealth(
      db,
      'dirty_tree',
      'warn',
      'engine started from a working tree with uncommitted changes; rows are tagged +dirty and are not confirmatory data',
    );
  }

  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });
  const rpc = new SolanaRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback });

  // Public key only. Used solely as the `taker` for `/swap/v2/build`; no
  // private key for it exists anywhere in this system and paper mode has no
  // signer, so nothing built here can be signed or sent.
  const taker = secrets.paperTakerPubkey;

  /**
   * P15 — the risk alarm, actually running.
   *
   * `ReserveAlarm` was defined, unit-tested and instantiated by nobody. A
   * class that no production caller constructs is documentation, and the tests
   * over it were testing documentation.
   *
   * Raw socket state remains an ALARM: it enqueues an immediate risk-priority
   * observation and never becomes a mark or a fill. A websocket frame is not
   * an executable price.
   */
  alarm =
    secrets.rpcWs === null
      ? null
      : new ReserveAlarm(
          {
            db,
            onMaterialChange: (mint, detail) => {
              recordHealth(db, 'reserve_alarm', 'critical', `${mint.slice(0, 12)}: ${detail}`.slice(0, 200));
              // The alarm's whole purpose: get an exact observation NOW rather
              // than at the next scheduled mark.
              urgentMarks.add(mint);
            },
          },
          secrets.rpcWs,
        );
  /**
   * P8 — the direct chain clock, BOUNDED.
   *
   * The previous build inserted every raw notification synchronously: 1,055
   * events/second, 91 million rows/day projected, 68% of them a log block
   * whose instruction the parser could not name. The database grew from
   * 2.97 GB to 6.15 GB in a single session, and the decision-useful yield was
   * 43 migration events out of seven million rows.
   *
   * Now: a bounded queue, a program-stack-aware parse, deduplication, and
   * persistence only of events that carry an identity a decision could use.
   * Everything else becomes a counter and a one-in-a-thousand sample.
   *
   * `processed` is still the commitment, because an alarm wants the earliest
   * signal — and every row says so, so a reversal can be reconciled.
   */
  const flowBars = new Map<string, { trades: number; migrations: number; launches: number; configs: number }>();
  /** Batched between flushes: one transaction beats one INSERT per event. */
  const pendingEventRows: ParsedEvent[] = [];

  const pipeline = new EventPipeline({
    maxQueue: 5_000,
    unknownSampleRate: 1_000,
    onEvent: (e) => {
      /**
       * A TRADE is aggregated, never stored as a row.
       *
       * Trades are the high-volume kind by two orders of magnitude, and no
       * decision reads an individual one: the candidate queue wants launches,
       * the migration age wants migrations, and the flow signal wants COUNTS
       * per mint per interval. Storing each trade reproduced the firehose at a
       * seventh of the size, which is still 19 million rows a day.
       *
       * Launches, migrations and config changes ARE stored: they are rare, and
       * each one is individually decision-useful.
       */
      if (e.kind !== 'TRADE') {
        pendingEventRows.push(e);
      }
      // Five-second bars, flushed by the cycle. Aggregate flow survives even
      // when individual rows are not worth keeping.
      const bucket = Math.floor(e.receivedUtcMs / 5_000) * 5_000;
      // Keyed by MINT as well as program, so per-token flow is recoverable
      // from the bars without keeping the trades.
      const key = `${bucket}:${e.programId}:${e.mint ?? ''}`;
      const bar = flowBars.get(key) ?? { trades: 0, migrations: 0, launches: 0, configs: 0 };
      if (e.kind === 'TRADE') bar.trades += 1;
      else if (e.kind === 'MIGRATION') bar.migrations += 1;
      else if (e.kind === 'LAUNCH') bar.launches += 1;
      else if (e.kind === 'CONFIG') bar.configs += 1;
      flowBars.set(key, bar);
    },
    onUnknownSample: (e) => {
      try {
        db.prepare(
          `INSERT OR IGNORE INTO chain_unknown_samples
             (signature,program_id,slot,logs_json,received_utc_ms) VALUES (?,?,?,?,?)`,
        ).run(e.signature, e.programId, e.slot, JSON.stringify(e.logs).slice(0, 4_000), e.receivedUtcMs);
      } catch {
        /* a sample nobody could store is not worth failing over */
      }
    },
  });

  const directClock =
    secrets.rpcWs === null
      ? null
      : new LogsWatcher({
          wsUrl: secrets.rpcWs,
          programs: [PUMP_PROGRAM, PUMPSWAP_PROGRAM],
          commitment: 'processed',
          // OFFER, never insert. The socket's rate is no longer the database's
          // write rate.
          onEvent: (e) => {
            pipeline.offer(e);
          },
          onGap: (detail) => {
            recordHealth(db, 'direct_clock_gap', 'warn', detail.slice(0, 200));
          },
        });
  if (directClock !== null) {
    directClock.connect();
    recordHealth(db, 'direct_clock_started', 'info', 'bounded pipeline on Pump and PumpSwap at processed');
  } else {
    recordHealth(db, 'direct_clock_absent', 'warn', 'no SOLANA_RPC_WS; the signal clock is the provider poll only');
  }

  /** Flush the bars and the pipeline counters. Called once per cycle. */
  const flushEventPipeline = (): void => {
    // One transaction for the whole batch. Per-event synchronous INSERTs made
    // the socket's arrival rate the database's write rate, which is what put
    // the queue on its ceiling and dropped 3,534 events.
    if (pendingEventRows.length > 0) {
      try {
        db.exec('BEGIN');
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO chain_events
             (signature,program_id,slot,kind,instruction,mint,pool,commitment,
              received_monotonic_ms,received_utc_ms,tx_error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        );
        for (const e of pendingEventRows) {
          stmt.run(
            e.signature,
            e.programId,
            e.slot,
            e.kind,
            e.instruction,
            e.mint,
            e.pool,
            e.commitment,
            e.receivedMonotonicMs,
            e.receivedUtcMs,
            e.err,
          );
        }
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the batch is lost and the counters say so */
        }
      }
      pendingEventRows.length = 0;
    }

    for (const [key, bar] of flowBars) {
      const [bucketStr, programId, mint] = key.split(':');
      try {
        db.prepare(
          `INSERT INTO chain_flow_bars_v2 (bucket_utc_ms,program_id,mint,trades,migrations,launches,configs)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(bucket_utc_ms,program_id,mint) DO UPDATE SET
             trades=trades+excluded.trades, migrations=migrations+excluded.migrations,
             launches=launches+excluded.launches, configs=configs+excluded.configs`,
        ).run(Number(bucketStr), programId ?? '', mint ?? '', bar.trades, bar.migrations, bar.launches, bar.configs);
      } catch {
        /* aggregation is best-effort */
      }
    }
    flowBars.clear();
    const c = pipeline.counters;
    try {
      db.prepare(
        `INSERT OR REPLACE INTO chain_pipeline_health
           (observed_utc_ms,received,parsed,unknown,duplicates,dropped,persisted,queue_high_water,bytes_in)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(Date.now(), c.received, c.parsed, c.unknown, c.duplicates, c.dropped, c.persisted, c.queueHighWater, c.bytesIn);
    } catch {
      /* health is best-effort */
    }
    if (c.dropped > 0) {
      recordHealth(db, 'event_pipeline_backpressure', 'warn', `${c.dropped} event(s) dropped; queue high water ${c.queueHighWater}`);
    }
  };

  if (alarm !== null) {
    alarm.start();
    recordHealth(db, 'reserve_alarm_started', 'info', 'websocket reserve alarm connected');
  } else {
    // Named, not silent. Running without the alarm is a coverage fact.
    recordHealth(db, 'reserve_alarm_absent', 'warn', 'no SOLANA_RPC_WS; reserve alarms are not running');
  }

  if (config.requireBuildableFill && taker === null) {
    throw new Error(
      'requireBuildableFill is set but PAPER_TAKER_PUBKEY is unset — ' +
        'buildability cannot be established and paper mode would book nothing. ' +
        'Set a public key, or set requireBuildableFill false and treat every row as quote-only.',
    );
  }

  // §9 — the simulator, constructed once and health-checked before the loop.
  //
  // Null when no token is configured: the engine then runs observe and
  // structural development exactly as before and refuses any fill that needs a
  // simulation, which is the documented behaviour during an outage rather than
  // a degraded mode invented here.
  const blobs = new BlobStore();
  const { token: simToken, source: simTokenSource } = resolveSimulatorToken();
  const simulator =
    simToken.length === 0
      ? null
      : new SimulationClient({
          baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
          token: simToken,
          pinnedIdentity: null,
          requirePinned: false,
          timeoutMs: 120_000,
        });
  if (simulator === null) {
    recordHealth(
      db,
      'simulator_not_configured',
      'warn',
      'no simulator token found, so no observation can be simulated and no fill requiring simulation may occur',
    );
  } else {
    const health = await simulatorHealth(db, simulator);
    recordHealth(
      db,
      'simulator_health',
      health.reachable && health.identityMatch ? 'info' : 'warn',
      `reachable=${health.reachable} identity=${health.identityMatch} queue=${health.queueDepth} ` +
        `parity=${health.parityStatus} snapshots=${health.snapshotFreezeStatus} token=${simTokenSource} ${health.detail}`,
    );
  }

  const ledger = restoreLedger(db, config, Date.now());

  // A discontinuity recorded by a previous process is still outstanding for
  // this one. A replacement process is not evidence that the world stopped
  // moving while the old one was gone.
  let pendingResync = outstandingResync(db);
  if (pendingResync !== null) {
    log.warn(
      { detail: pendingResync.detail, atUtcMs: pendingResync.wallUtcMs },
      'unresolved clock discontinuity from a previous run — entries blocked until reconciliation',
    );
  }

  log.info(
    {
      mode: config.mode,
      strategyVersion: config.strategyVersion,
      contextHash: contextHash.slice(0, 12),
      dataRegimeId: ctx.dataRegimeId,
      sourceCommit: ctx.sourceCommit.slice(0, 12),
      navSol: formatAmount(ledger.navLamports, 9),
      openPositions: managedPositions(db).length,
      maxQuotesPerCycle: config.maxQuotesPerCycle,
    },
    'paper mode starting — simulated fills, real quotes, no signer',
  );

  let stop = false;
  const shutdown = (s: string): void => {
    if (stop) return;
    stop = true;
    log.info({ signal: s }, 'shutdown requested');
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const seen = new Set<string>();
  let cycle = 0;

  // Cadence is driven by the MONOTONIC clock. Wall time is used only for day
  // boundaries, logging and stored timestamps. Before P3 every schedule ran off
  // `Date.now()`, so an NTP step or a laptop resume made the loop fire
  // immediately and repeatedly against a 0.5 RPS budget.
  //
  // Discovery is expensive and slow-moving; marking an open position is cheap
  // and urgent. Before P2a they shared one interval, so the mark cadence was
  // whatever discovery happened to be — 31s in the observed corpus, wider than
  // the entire lifetime of every collapse we have measured.
  const discovery = new Cadence(config.discoveryIntervalMs, 'discovery');
  // Both clocks are persisted on a slow heartbeat as well as on a
  // discontinuity. Writing only on a discontinuity would mean an engine that
  // has never drifted is indistinguishable from one that never checked, and
  // `pnpm capability` would have to report the clock as UNKNOWN forever.
  const clockBeat = new Cadence(CLOCK_CHECKPOINT_INTERVAL_MS, 'clock');
  let lastClock: ClockReading = readClock();
  recordClockCheckpoint(db, lastClock, null, false);
  // A halt is announced once, not every 10s for as long as the file exists.
  let haltAnnounced = false;

  while (!stop) {
    const now = readClock();
    const started = now.wallUtcMs;
    cycle += 1;
    let stats = emptyStats();

    // Compare the two clocks before anything else uses either of them.
    const skew = detectDiscontinuity(lastClock, now, config.maxClockSkewMs);
    if (skew.discontinuity !== null) {
      const checkpointId = recordClockCheckpoint(db, now, skew, true);
      recordHealth(db, 'clock_discontinuity', 'critical', `${skew.discontinuity}: ${skew.detail}`);
      log.error({ discontinuity: skew.discontinuity, skewMs: Math.round(skew.skewMs) }, 'clock discontinuity');
      pendingResync = { checkpointId, detail: skew.detail, wallUtcMs: now.wallUtcMs };
      // Every cadence reading predates the gap, so its age means nothing.
      discovery.reset();
    }
    lastClock = now;

    if (clockBeat.due(now.monotonicMs)) {
      clockBeat.fired(now.monotonicMs);
      if (skew.discontinuity === null) recordClockCheckpoint(db, now, skew, false);
    }

    // Checked every cycle, before any work. A switch consulted only at startup
    // cannot stop a process that is already running, which is the only case
    // anyone reaches for it in.
    //
    // A halt stops ENTRIES immediately. It does not, by default, stop exit
    // management: the previous behaviour broke out of the loop at once, which
    // released the lock and left any open position unmanaged at precisely the
    // moment someone had decided something was wrong. Going flat and stopping
    // are now separate things — see packages/domain/src/halt.ts.
    const halt = haltState(KILL_PATHS);
    if (halt !== null) {
      const openNow = managedPositions(db).length;
      if (!haltAnnounced) {
        if (halt.defaulted) {
          log.warn(
            { path: halt.path, rawLabel: halt.rawLabel },
            'halt file names no recognised mode — defaulting to TERMINATE_WHEN_FLAT',
          );
        }
        recordHealth(db, 'halt_engaged', 'critical', `${halt.mode} via ${halt.path}; ${openNow} open position(s)`);
        log.error({ path: halt.path, mode: halt.mode, open: openNow }, 'halt engaged');
        haltAnnounced = true;
      }
      if (mayTerminate(halt.mode, openNow)) {
        if (halt.mode === 'EMERGENCY_RECONCILE' && openNow > 0) {
          // Loud, and recorded, because it is the one path that can orphan a
          // position. It is never reached by writing a bare halt file.
          recordHealth(
            db,
            'position_abandoned',
            'critical',
            `EMERGENCY_RECONCILE with ${openNow} open position(s) — exposure is unmanaged until reconciled`,
          );
          log.error({ open: openNow }, 'stopping with open positions — EMERGENCY_RECONCILE');
        } else {
          log.info({ mode: halt.mode }, 'flat — stopping');
        }
        break;
      }
      if (!exitManagementActive(halt.mode)) break;
      // Otherwise fall through: exits are still worked below, entries are not.
    }

    // The daily loss cap is a DAILY cap, so someone has to notice the day
    // ended. `dayStartUtcMs` used to be set once in `restoreLedger` and read by
    // nothing, which made the cap permanent rather than daily.
    const roll = rollDayIfNeeded(db, ledger, started, contextHash);
    if (roll.rolled) {
      log.info(
        {
          utcDate: ledger.utcDate,
          daysSkipped: roll.daysSkipped,
          wentBackward: roll.wentBackward,
          realizedTodaySol: formatAmount(ledger.realizedTodayLamports, 9),
        },
        'UTC day rolled — daily loss budget recomputed from closed positions',
      );
      if (roll.wentBackward) {
        recordHealth(db, 'utc_day_backward', 'warn', `day key moved back ${-roll.daysSkipped} day(s); no counter was reset`);
      }
    }

    // Exits run FIRST, every cycle, before any entry may compete for the quote
    // budget. Getting out is always more urgent than getting in — and after
    // P4 that is enforced by the rate limiter as well as by ordering.
    let exits = 0;
    try {
      exits = await manageOpenPositions(db, jupiter, config, ledger, taker, contextHash, blobs, simulator);
    } catch (e) {
      log.error({ err: (e as Error).message }, 'exit management failed');
      recordHealth(db, 'exit_management_error', 'critical', (e as Error).message);
    }

    // Shadow books are worked after the realizable wallet, never before: the
    // wallet is the only book that can actually lose money.
    try {
      await manageShadowBooks(db, jupiter, config, taker, contextHash, blobs, simulator);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'shadow book management failed');
    }

    // Reconciliation after a discontinuity: every open position has now been
    // re-quoted from a fresh executable route and re-marked above, and the
    // database is checked below. Only then are entries allowed again.
    if (pendingResync !== null) {
      // §4.3 — database integrity says nothing about whether any position was
      // successfully re-observed. The previous gate cleared on
      // `PRAGMA integrity_check` alone, so a provider outage during a resume
      // re-enabled entries without a single fresh observation of anything held.
      //
      // Every clause is a requirement and a provider failure leaves the resync
      // unresolved. Entries stay blocked, which is the correct cost.
      const blockers: string[] = [];

      const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])[0];
      if (integrity?.integrity_check !== 'ok') blockers.push(`integrity=${integrity?.integrity_check ?? 'unknown'}`);
      if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) blockers.push('foreign key violations');

      const stray = unmanagedPositions(db);
      if (stray.length > 0) blockers.push(`${stray.length} position(s) hold tokens outside the managed set`);

      const sourcesOk =
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM source_health
               WHERE ok = 0 AND utc_ms > ?`,
            )
            .get(pendingResync.wallUtcMs) as { n: number }
        ).n === 0;
      if (!sourcesOk) blockers.push('a source has failed since the discontinuity');

      // The substantive clause: every managed position must have been marked
      // AFTER the discontinuity checkpoint, from a fresh observation.
      const managed = managedPositions(db);
      for (const row of managed) {
        const fresh = db
          .prepare(
            `SELECT COUNT(*) AS n FROM position_marks
             WHERE position_id = ? AND observed_utc_ms > ? AND route_available = 1`,
          )
          .get(row.position_id, pendingResync.wallUtcMs) as { n: number };
        if (fresh.n === 0) blockers.push(`${row.mint.slice(0, 12)} has no fresh mark since the discontinuity`);
      }

      if (blockers.length === 0) {
        markResyncDone(db, pendingResync.checkpointId, Date.now());
        recordHealth(
          db,
          'clock_resync_complete',
          'info',
          `${managed.length} managed position(s) re-observed after the discontinuity; entries re-enabled`,
        );
        log.info({ managed: managed.length }, 'clock resync complete — entries re-enabled');
        pendingResync = null;
      } else {
        log.warn({ blockers }, 'resync still unresolved — entries remain blocked');
      }
    }

    const heldMints = new Set(managedPositions(db).map((p) => p.mint));

    // Entries are refused for as long as any halt file exists, whatever its
    // mode, and while a clock discontinuity is unreconciled. Discovery still
    // runs so the corpus keeps growing, and marks still run so open positions
    // stay observed.
    const entriesHalted = halt !== null || pendingResync !== null;

    const nowMono = monotonicMs();
    const discoveryDue = discovery.due(nowMono);

    if (discoveryDue) {
      discovery.fired(nowMono);
      try {
        stats = await runCycle({
          db,
          jupiter,
          config,
          seen,
          cycleIndex: cycle,
          skip: heldMints,
          rpc: rpc.configured ? rpc : null,
          currentEpoch: await currentEpochOf(rpc),
          onEligible: async (info, result) => {
            if (entriesHalted) return;
            await tryEnter(
              db,
              jupiter,
              taker,
              config,
              ledger,
              info.id,
              sanitizeExternal(info.symbol ?? '', 16),
              result,
              contextHash,
              blobs,
              simulator,
            );
          },
        });
      } catch (e) {
        if (e instanceof SourceFetchError) {
          recordSourceHealth(db, e.source, false, null, e.kind);
          log.warn({ source: e.source, kind: e.kind }, 'discovery failed');
        } else {
          recordHealth(db, 'cycle_error', 'warn', (e as Error).message);
          log.error({ err: (e as Error).message }, 'cycle error');
        }
      }
    }

    lock.heartbeat();
    const open = managedPositions(db);
    const exposure = open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n);
    const c = counters(db);


    // P8 — one aggregate write per cycle instead of one per notification.
    flushEventPipeline();

    log.info(
      {
        cycle,
        ...stats,
        discovery: discoveryDue,
        exits,
        open: open.length,
        navSol: formatAmount(ledger.navLamports, 9),
        freeSol: formatAmount(ledger.freeLamports, 9),
        lockedRentSol: formatAmount(ledger.lockedRentLamports, 9),
        exposureSol: formatAmount(exposure, 9),
        realizedTodaySol: formatAmount(ledger.realizedTodayLamports, 9),
        totalScreenings: c.screenings,
        elapsedMs: Date.now() - started,
      },
      'cycle complete',
    );

    // The tick is the MARK cadence, measured on the monotonic clock so a wall
    // clock correction cannot compress or burst it. Discovery gates itself
    // above on its own, longer interval.
    const spentMs = monotonicMs() - now.monotonicMs;
    await sleep(Math.max(1_000, config.markIntervalMs - spentMs), () => stop);
  }

  recordClockCheckpoint(db, readClock(), null, false);
  lock.release();
  db.close();
  log.info('paper mode stopped cleanly');
}

async function tryEnter(
  db: Db,
  jupiter: JupiterClient,
  taker: string | null,
  config: AppConfig,
  ledger: Ledger,
  mint: string,
  symbol: string,
  result: Parameters<Parameters<typeof runCycle>[0]['onEligible']>[1],
  contextHash: string,
  // §9 — null when no simulator is configured. The entry path then refuses any
  // fill that requires simulation rather than pretending one happened.
  blobs: BlobStore,
  simulator: SimulationClient | null,
): Promise<void> {
  const rt = result.roundTrip;
  if (!rt || !rt.exitExists || !rt.sell) return;

  // A quote is a perishable fact. Acting on a stale one is acting on a price
  // that no longer exists.
  const quoteAgeMs = Date.now() - rt.buy.receivedUtcMs;
  if (quoteAgeMs > config.maxQuoteAgeMs) {
    log.info({ mint, quoteAgeMs, max: config.maxQuoteAgeMs }, 'skip entry: quote too old');
    return;
  }

  const open = managedPositions(db);
  const state: PortfolioState = {
    navLamports: ledger.navLamports,
    freeLamports: ledger.freeLamports,
    openPositions: open.length,
    totalExposureLamports: open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n),
    realizedTodayLamports: ledger.realizedTodayLamports,
    peakNavLamports: ledger.peakNavLamports,
    realizedWeekLamports: realizedWeek(db, Date.now()),
    // Null until valid observations exist. Null means the catastrophic floor
    // governs sizing, not that risk is zero.
    observedSevereLossBps: null,
    // P12 -- the SAME loss model for existing and proposed positions.
    //
    // This charged existing positions the nominal stop distance while
    // `sizePosition` charged a proposed one `plannedLossFractionBps()`, which
    // is the max of the stop, the observed severe loss and the catastrophic
    // floor. With no valid observations the floor is 100%, so a new trade was
    // charged four times what an identical existing one was, and the aggregate
    // cap read the book as four times safer than the model said it was.
    //
    // A stop is a hope about where the exit fills. In a token that goes to
    // zero, no stop fills anywhere.
    plannedLossLamports: open.reduce(
      (a, p) => a + (BigInt(p.cost_lamports) * BigInt(plannedLossFractionBps(config, null))) / 10_000n,
      0n,
    ),
  };

  const sizing = sizePosition(state, config, result.outcome.opportunityScore ?? 0);

  // §12.1 — EVERY structurally eligible signal opens both books, before the
  // portfolio has any say and whatever it says.
  //
  // This used to run only in the refusal branch, which reintroduced the exact
  // censoring it was written to remove, from the other side. Shadows existed
  // only for signals the portfolio had REJECTED, so the books systematically
  // excluded everything it liked, and comparing shadow performance against
  // portfolio performance compared the trades we turned down against the trades
  // we took. Neither population is the strategy.
  //
  // An accepted portfolio trade is not a substitute for a fixed shadow either:
  // the portfolio sizes by risk budget and free capital, so its notional moves
  // with NAV and the number of open positions. A book whose position size
  // depends on how the last few trades went cannot answer what the signal was
  // worth. The shadows are fixed notional for exactly that reason.
  // §16 — the cohort is frozen at open time, not recomputed later.
  //
  // A position opened at four minutes old is a four-minute experiment for its
  // whole life. Recomputing from the token's current age would migrate a
  // running position into an older bucket and silently change what the bucket
  // means. AGE_UNKNOWN is its own value: absent is not young.
  const cohort = cohortOf(result.snapshot.tokenAgeMs ?? null);

  await openShadowBooks(
    db,
    jupiter,
    config,
    taker,
    mint,
    contextHash,
    sizing.allowed ? 'accepted_by_portfolio' : (sizing.refusal ?? 'unknown'),
    cohort,
    result.snapshot.tokenAgeMs ?? null,
    blobs,
    simulator,
  );

  // The shadow ledger records what the SIGNAL said, before the portfolio had
  // its say. Without this the corpus is censored by our own losses: the engine
  // stops entering after a bad day, so the observations that follow a loss are
  // systematically absent, and every estimate built on what remains is biased.
  // §P2.2 — measurement only. This is not a wallet and is never summed with one.
  if (!sizing.allowed) {
    insertLedgerEntry(db, {
      ledger: 'alpha_shadow',
      positionId: null,
      mint,
      event: 'signal_refused_by_portfolio',
      utcMs: Date.now(),
      notionalLamports: null,
      realizedLamports: null,
      navLamports: ledger.navLamports,
      freeLamports: ledger.freeLamports,
      lockedRentLamports: ledger.lockedRentLamports,
      refusal: sizing.refusal,
      detail: sizing.detail,
      contextHash,
    });
    insertLedgerEntry(db, {
      ledger: 'portfolio_paper',
      positionId: null,
      mint,
      event: 'refused',
      utcMs: Date.now(),
      notionalLamports: null,
      realizedLamports: null,
      navLamports: ledger.navLamports,
      freeLamports: ledger.freeLamports,
      lockedRentLamports: ledger.lockedRentLamports,
      refusal: sizing.refusal,
      detail: sizing.detail,
      contextHash,
    });
    log.info({ mint, refusal: sizing.refusal, detail: sizing.detail }, 'entry refused by portfolio caps');

    // §5 — THE repair. A refusal used to write a row and follow nothing, which
    // does not remove loss-dependent censoring: the engine stops entering after
    // a bad day, so the observations that follow a loss are systematically
    // absent and every estimate built on the survivors is biased. A row saying
    // "we did not take this" is not a substitute for tracking what it did.
    //
    // The books were already opened above, for every eligible signal rather
    // than only for refused ones. This branch records WHY the portfolio said
    // no; it does not open anything.
    return;
  }

  // §3.1 — the probe screens; it does not price the fill.
  //
  // The old code took the 0.05 SOL probe quote's `otherAmountThreshold` and
  // multiplied it by `lamportsIn / probe`. Impact is not linear in size, so
  // that scaling is wrong at every size, and it is wrong in the flattering
  // direction below the probe. The exact-size route is requested instead.
  const lamportsIn = sizing.lamports;

  if (taker === null) {
    recordHealth(db, 'buildability_unverifiable', 'critical', 'PAPER_TAKER_PUBKEY unset; no route can be observed');
    log.warn({ mint }, 'entry refused — no taker configured');
    return;
  }

  /**
   * P8 — the entry DECISION is `admitPortfolioEntry`. This function supplies
   * collaborators and persists the outcome; it no longer decides.
   *
   * The observe → simulate → measure → observe exit → simulate → measure →
   * gate sequence lived here AND in `paper-core.ts`, and only this copy ran.
   * Two implementations of one decision is two chances to forget a term, and
   * the way you find out is that the tested behaviour and the shipped
   * behaviour disagree about whether an exit was ever required.
   *
   * The core cannot reach the database, so the measured credit and the
   * measured round trip are read here and handed in. The core decides on them.
   */
  const admission = await admitPortfolioEntry(
    {
      observer: {
        observe: async (req) =>
          await observeRoute(db, jupiter, {
            family: config.primaryRouteFamily as 'BUILD_CUSTOM',
            mint,
            side: req.side,
            positionId: null,
            shadowPositionId: null,
            purpose: req.purpose,
            inputMint: req.inputMint,
            outputMint: req.outputMint,
            amount: req.amount,
            taker,
            slippageBps:
              req.side === 'sell' ? Math.min(config.risk.maxSlippageBps, 300) : config.risk.maxSlippageBps,
            maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
            broadcasterTipLamports: config.assumedBroadcasterTipLamports,
            priority: 'risk',
            contextHash,
          }).catch(() => null),
      },
      simulator: {
        simulate: async (observationId, leg) => {
          await simulateLeg(db, blobs, simulator, observationId, taker, {
            mode: 'DEVELOPMENT_JIT',
            side: leg.side,
            inputMint: leg.inputMint,
            outputMint: leg.outputMint,
            inputAmount: leg.inputAmount,
            routeFamily: config.primaryRouteFamily,
            capabilityFingerprint: fingerprintForObservation(db, blobs, observationId),
            // Each side named as the asset it is. A buy RECEIVES the token, so
            // its program must be given or the credit has no account to bind
            // to — the defect that produced zero effect-verified legs.
            inputTokenProgram:
              leg.inputMint === WSOL_MINT ? null : tokenProgramFor(db, blobs, observationId, taker, leg.inputMint),
            outputTokenProgram:
              leg.outputMint === WSOL_MINT ? null : tokenProgramFor(db, blobs, observationId, taker, leg.outputMint),
            fundingLamports: leg.side === 'buy' ? leg.inputAmount * 10n : 100_000_000n,
            maxLamportsSpent: leg.side === 'buy' ? leg.inputAmount * 2n : 30_000_000n,
            expectedOutput: leg.expectedOutput,
            minimumOutput: leg.minimumOutput,
            contextHash,
          });
          // Re-read: the simulation wrote onto the row and the in-memory
          // observation predates it.
          return {
            simulation: simulationStatusOf(db, observationId),
            effect: simulationEffectOf(db, observationId),
          };
        },
      },
      acquired: {
        measure: (observationId) => {
          const jobId = latestJobFor(db, observationId);
          if (jobId === null) return null;
          const st = measuredSettlementOf(db, observationId, jobId, taker);
          if (st === null || !isPnlEligible(st).ok) return null;
          try {
            return acquiredTokens(st);
          } catch {
            return null;
          }
        },
      },
      roundTrip: {
        measure: (buyId, sellId) => {
          const buyJob = latestJobFor(db, buyId);
          const sellJob = latestJobFor(db, sellId);
          if (buyJob === null || sellJob === null) return null;
          const b = measuredSettlementOf(db, buyId, buyJob, taker);
          const x = measuredSettlementOf(db, sellId, sellJob, taker);
          if (b === null || x === null) return null;
          const rt = immediateRoundTrip(b, x);
          return {
            tradingLossBps: rt.tradingLossBps,
            allInLossBps: rt.lossBps,
            netLamports: rt.netLamports,
            recoverableRentLamports: rt.recoverableRentLamports,
            complete: rt.complete,
            reasons: rt.reasons,
          };
        },
      },
    },
    {
      mint,
      lamportsIn,
      economics: {
        allInCostLamports: lamportsIn + config.assumedSignatureFeeLamports + config.assumedPriorityFeeLamports,
        requireLocalSimulation: config.requireLocalSimulation,
        maxRoundTripLossBps: config.gates.maxRoundTripLossBps,
      },
    },
  );

  const entry = admission.buy;
  const entrySell = admission.sell;
  if (entry === null) {
    recordHealth(db, 'entry_unobservable', 'warn', `${mint.slice(0, 12)}: ${admission.reasons.join('; ').slice(0, 200)}`);
    return;
  }
  if (!admission.ok || entrySell === null || admission.tokensAcquired === null) {
    recordHealth(db, 'entry_refused', 'warn', `${mint.slice(0, 12)}: ${admission.reasons.join('; ').slice(0, 200)}`);
    log.info({ mint, symbol, reasons: admission.reasons }, 'entry refused by core admission');
    return;
  }

  const tokensReceived = admission.tokensAcquired;

  /**
   * P4 — an unknown transfer fee refuses the entry.
   *
   * `?? 0n` turned "we did not measure it" into "there is none", and on a
   * Token-2022 mint that is the fee which makes the position a bad one.
   * `transferFeeOrUnknown` returns 0 only when the asset CANNOT have a fee,
   * which is a fact about the token program rather than about our coverage.
   */
  const entryTransferFeeOrNull = (() => {
    const jobId = latestJobFor(db, entry.observationId);
    if (jobId === null) return null;
    const st = measuredSettlementOf(db, entry.observationId, jobId, taker);
    return st === null ? null : transferFeeOrUnknown(st);
  })();
  if (entryTransferFeeOrNull === null) {
    recordHealth(
      db,
      'entry_transfer_fee_unknown',
      'warn',
      `${mint.slice(0, 12)}: Token-2022 transfer fee not measured; refusing rather than charging zero`,
    );
    return;
  }
  const entryTransferFee = entryTransferFeeOrNull;

  /**
   * P15 — watch this position's pool reserve from the moment it opens.
   *
   * The reserve token account is the one whose BALANCE is the pool's depth.
   * Registering at entry and removing at close is what keeps the alarm's
   * subscription set equal to actual exposure rather than to everything ever
   * screened.
   */
  if (alarm !== null) {
    const watched = riskAccountsFor(mint);
    for (const account of watched) alarm.watch({ mint, reserveTokenAccount: account });
    if (watched.length === 0) {
      // A position with no alarm coverage is a fact, recorded rather than
      // implied by the absence of alarms.
      recordHealth(db, 'reserve_alarm_uncovered', 'warn', `${mint.slice(0, 12)}: no derivable pool to watch`);
    }
  }

  // The settlement the position is booked from. Present by construction: the
  // core refused above unless both legs were measured.
  const entryJobId = latestJobFor(db, entry.observationId);
  const entrySettlement =
    entryJobId === null ? null : measuredSettlementOf(db, entry.observationId, entryJobId, taker);
  if (entrySettlement === null) {
    recordHealth(db, 'entry_settlement_vanished', 'critical', `${mint.slice(0, 12)}: admitted then unmeasurable`);
    return;
  }

  const rentLamports = config.assumedAtaRentLamports;
  const entryCosts = {
    inputLamports: lamportsIn,
    signatureFeeLamports: config.assumedSignatureFeeLamports,
    priorityFeeLamports: config.assumedPriorityFeeLamports,
    broadcasterTipLamports: config.assumedBroadcasterTipLamports,
    ataRentLamports: rentLamports,
    /**
     * P6 — the transfer fee this leg actually paid.
     *
     * Read from the MEASURED settlement. It was hardcoded 0n with the gap
     * named in a doc, which makes every Token-2022 position understate its
     * cost by exactly the fee that makes it a bad position.
     *
     * Null there means unobserved, and an unobserved money-critical fee is
     * refused above rather than charged as zero here.
     */
    transferFeeLamports: entryTransferFee,
    // BUILD_CUSTOM carries no platform fee. Charging one would be inventing it.
    platformFeeLamports: 0n,
    /**
     * P6 — a SUCCESSFUL leg pays for no failed attempt.
     *
     * This charged `assumedFailedAttemptLamports` at probability 1 on every
     * entry that worked. That is not an expected-failure model: it fabricates
     * exactly one failure per success, and it is charged against realised PnL
     * where the failure demonstrably did not occur.
     *
     * Realised labels carry actual failures. Prospective sizing still uses the
     * assumption, from the route's own attempt history, and keeps it separate.
     */
    assumedFailedAttemptLamports: 0n,
  };
  const costLamports = totalEntryCost(entryCosts);

  // The core already refused anything above the cap, on the same measured
  // settlements. Recorded here so the admitted number is in the corpus too.
  const entryRoundTripLossBps = admission.roundTripLossBps;
  recordHealth(
    db,
    'entry_round_trip',
    'info',
    `${mint.slice(0, 12)}: measured trading round trip ${entryRoundTripLossBps} bps ` +
      `(cap ${config.gates.maxRoundTripLossBps})`,
  );

  const positionId = randomUUID();
  const position: Position = {
    positionId,
    mint,
    state: 'POSITION_OPEN',
    tokenAmount: tokensReceived,
    costLamports,
    realizedLamports: 0n,
    openedUtcMs: Date.now(),
    closedUtcMs: null,
    strategyVersion: config.strategyVersion,
    simulated: true,
    // P4 — the explicit economics, from the MEASURED entry settlement.
    //
    // The cost is what actually left the payer, fees and rent included. Gross
    // proceeds and net PnL are NULL because an open position has not realised
    // either, and null here means undetermined rather than zero.
    /**
     * P4 — costs only. NEVER principal.
     *
     * This was `entryCashOut().cashOut`, which is principal plus costs: on a
     * 0.02 SOL entry it reported ~24,000,000 lamports of "execution cost"
     * against ~4,087,000 of actual cost, and a 2x-cost stress test then
     * doubled the principal.
     */
    executionCostLamports: executionCost(entrySettlement),
    grossProceedsLamports: null,
    netPnlLamports: null,
    // P9 — both ends of the cash flow, with rent identified separately.
    // Exit-side fields are NULL because an open position has not realised
    // them; null is undetermined, not zero.
    entryCashOutLamports: entryCashOut(entrySettlement).cashOut,
    exitCashInLamports: null,
    lockedRentLamports: entryCashOut(entrySettlement).lockedRent,
    residualTokenAtoms: null,
  };
  insertPosition(db, position);
  stampContext(db, 'positions', positionId, contextHash);
  // The position now points at the ONE observation it was built from. A leg
  // that cannot name its observation is not an executable leg.
  bindEntryObservation(db, positionId, entry.observationId, entry.family);

  const fillId = randomUUID();
  const fill: Fill = {
    fillId,
    intentId: result.outcome.snapshotId,
    mint,
    side: 'buy',
    actualInAmount: lamportsIn,
    actualOutAmount: tokensReceived,
    // BUILD_CUSTOM returns no platform fee, so none is charged here. The
    // previous value multiplied an /order amount that had already had its
    // fee deducted.
    feeLamports: 0n,
    priorityFeeLamports: config.assumedPriorityFeeLamports,
    rentLamports,
    signature: null,
    slot: null,
    simulated: true,
    utcMs: Date.now(),
  };
  insertFill(db, fill);
  stampContext(db, 'fills', fillId, contextHash);

  ledger.freeLamports -= costLamports;
  ledger.lockedRentLamports += rentLamports;

  for (const name of ['portfolio_paper', 'alpha_shadow'] as const) {
    insertLedgerEntry(db, {
      ledger: name,
      positionId,
      mint,
      event: 'entry',
      utcMs: Date.now(),
      notionalLamports: lamportsIn,
      realizedLamports: null,
      navLamports: ledger.navLamports,
      freeLamports: ledger.freeLamports,
      lockedRentLamports: ledger.lockedRentLamports,
      refusal: null,
      detail: `score ${result.outcome.opportunityScore ?? 0}`,
      contextHash,
    });
  }

  log.info(
    {
      positionId,
      mint,
      symbol,
      inSol: formatAmount(lamportsIn, 9),
      costSol: formatAmount(costLamports, 9),
      lockedRentSol: formatAmount(rentLamports, 9),
      score: result.outcome.opportunityScore,
      roundTripLossBps: rt.roundTripLossBps,
      family: entry.family,
      observationId: entry.observationId,
      expectedOut: netExpectedOutput(entry).toString(),
      bookedOut: tokensReceived.toString(),
    },
    'PAPER ENTRY (one exact-size observation, policy-valid)',
  );
}

/**
 * Open one position in each shadow book for a signal the portfolio refused.
 *
 * Each book gets its OWN exact-size observation at its own frozen notional —
 * a 0.02 SOL shadow is not a 0.05 SOL result divided by 2.5, because impact is
 * not linear and that is the same error §3.1 removed from entries.
 */
/**
 * Which token program owns this mint, from the transaction the observation was
 * built from. Null when the transaction does not say.
 */
/**
 * The pool's reserve token account for this mint, from the exact bytes.
 *
 * The route's own accounts name the pool it went through. Deriving this from a
 * provider field instead would watch an account the trade never touched, and
 * an alarm on the wrong account is worse than none: it reports coverage.
 *
 * Null when the bytes do not identify one. Null is honest; a guess is not.
 */
/**
 * The accounts whose state IS this position's liquidity risk.
 *
 * The previous version took "the first writable account that is not the
 * taker's and not an ATA". That is a POSITION IN A LIST, not an identity: on a
 * routed swap it lands on whatever the compiler happened to order first — a
 * tick array, a fee account, an event authority — and an alarm on the wrong
 * account is worse than no alarm, because it reports coverage.
 *
 * The canonical PumpSwap pool address is DERIVED from the mint through the
 * SDK's own PDA, so it is the pool or it is nothing. Its data changes when the
 * reserves change, which is the fact the alarm exists to notice.
 *
 * Returns an empty list rather than a guess. No coverage is a fact the engine
 * records; false coverage is one it cannot detect.
 */
function riskAccountsFor(mint: string): string[] {
  try {
    return [canonicalPoolFor(mint, WSOL_MINT)];
  } catch {
    return [];
  }
}

function tokenProgramFor(
  db: Db,
  blobs: BlobStore,
  observationId: string,
  taker: string,
  mint: string,
): string | null {
  try {
    const hash = exactBlobFor(db, observationId);
    if (hash === null) return null;
    const blob = blobs.get<ExactTransactionBlob>(hash);
    const keys = [...blob.staticAccountKeys, ...blob.loadedAddresses];
    // Authoritative: the ATA is derived from the program, so only the right
    // one appears. The previous heuristic asked whether the Token-2022 program
    // id was among the keys at all, which is true whenever ANY account in a
    // routed swap belongs to Token-2022 — regularly some other mint's.
    return tokenProgramFromTransaction(keys, taker, mint);
  } catch {
    // Unknown, and unknown is not Legacy. Returning a guess here creates
    // inventory at an address the transaction will never look at, and the run
    // then fails for a reason that is ours.
    return null;
  }
}

/**
 * What one leg's simulation actually established, read back from the database.
 *
 * Null when no job exists for the observation, which is not the same as a job
 * that failed: one means nothing was attempted, the other means something was
 * and did not hold. Both yield STRUCTURAL_ONLY, and they are distinguished in
 * the job row rather than collapsed here.
 */
function legEvidenceOf(db: Db, observationId: string): LegEvidence | null {
  const r = db
    .prepare(
      `SELECT validity, simulated_effect_ok, account_coverage_ok, mode, confirmatory
       FROM simulation_jobs WHERE execution_observation_id = ?
       ORDER BY requested_utc_ms DESC LIMIT 1`,
    )
    .get(observationId) as
    | {
        validity: string | null;
        simulated_effect_ok: number | null;
        account_coverage_ok: number | null;
        mode: string | null;
        confirmatory: number | null;
      }
    | undefined;
  if (r === undefined) return null;
  return {
    validity: r.validity,
    effectOk: r.simulated_effect_ok === 1,
    accountCoverageOk: r.account_coverage_ok === 1,
    offline: r.mode === 'CONFIRMATORY_OFFLINE',
    confirmatory: r.confirmatory === 1,
  };
}

async function openShadowBooks(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  taker: string | null,
  mint: string,
  contextHash: string,
  refusal: string,
  cohort: CohortAssignment,
  tokenAgeMsAtOpen: number | null,
  blobs: BlobStore,
  simulator: SimulationClient | null,
): Promise<void> {
  if (taker === null) return;
  const books: { book: 'alpha_shadow' | 'canary_shadow'; notional: bigint }[] = [
    { book: 'alpha_shadow', notional: config.alphaShadowNotionalLamports },
    { book: 'canary_shadow', notional: config.canaryShadowNotionalLamports },
  ];

  // §12.3 — one fact, one API call.
  //
  // Both books run at the same notional in every shipped config, and each was
  // taking its own /build for the same mint, size, family and context. That is
  // two calls describing one fact, out of a rate budget that also has to
  // maintain the mark SLA -- and the two answers can differ, which would make
  // the books incomparable for a reason that has nothing to do with either.
  //
  // The observation is taken once per DISTINCT notional and referenced by every
  // book that asked for that size. Different notionals are different facts and
  // still cost a call each.
  const sharedEntry = new Map<string, Awaited<ReturnType<typeof observeRoute>>>();
  const sharedExit = new Map<string, Awaited<ReturnType<typeof observeRoute>>>();

  for (const { book, notional } of books) {
    if (notional <= 0n) continue;

    // §9.2 — one signal is one episode. Discovery rescreens the same mint every
    // cycle, and each rescreen used to open its own position, so a token
    // eligible for ten minutes became dozens of "trades" that were the same
    // trade observed repeatedly.
    const episode = claimSignalEpisode(db, mint, book, Date.now(), contextHash);
    if (!episode.isNew) continue;

    const sizeKey = notional.toString();
    const cachedEntry = sharedEntry.get(sizeKey);
    const obs =
      cachedEntry ??
      (await observeRoute(db, jupiter, {
      family: config.primaryRouteFamily as 'BUILD_CUSTOM',
      mint,
      side: 'buy',
      positionId: null,
      shadowPositionId: null,
      // Named for the size rather than the book, because the row is shared and
      // labelling it with whichever book happened to ask first would be a lie
      // to whoever reads the corpus later.
      purpose: `shadow_entry`,
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: notional,
      taker,
      slippageBps: config.risk.maxSlippageBps,
      maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      priority: 'enrichment',
      contextHash,
    }));
    sharedEntry.set(sizeKey, obs);

    // The shadow book records what the SIGNAL was worth, so it is not gated on
    // simulation the way a paper fill is — but it inherits every other
    // requirement, and an unbuildable route is a fact about the token that no
    // book gets to ignore.
    if (obs.instructionSetHash === null || obs.expectedOutput <= 0n) continue;

    const tokensIn = netMinimumOutput(obs);
    if (tokensIn <= 0n) continue;

    // §9 — simulate the entry leg's EXACT bytes.
    //
    // The entry and its round-trip sell are the pair that constitutes a FILL,
    // and a fill is what §9 requires simulation for. Marks are deliberately not
    // simulated: a mark is a valuation of a position already held, it happens
    // every cycle for every open shadow, and simulating all of them would
    // consume the whole budget to answer a question nobody asked.
    //
    // Development shadows are not gated on the result -- the book records what
    // the signal was worth -- but the result is recorded, and it is what turns
    // "0 observations simulated" into a number.
    await simulateLeg(db, blobs, simulator, obs.observationId, taker, {
      mode: 'DEVELOPMENT_JIT',
      side: 'buy',
      inputMint: WSOL_MINT,
      outputMint: mint,
      inputAmount: notional,
      routeFamily: obs.family,
      capabilityFingerprint: fingerprintForObservation(db, blobs, obs.observationId),
      outputTokenProgram: tokenProgramFor(db, blobs, obs.observationId, taker, mint),
      fundingLamports: notional * 10n,
      maxLamportsSpent: notional * 2n,
      expectedOutput: obs.expectedOutput,
      minimumOutput: obs.minimumOutput,
      contextHash,
    });

    // §7 — a BUILD_CUSTOM buy without a BUILD_CUSTOM sell is not an entry.
    //
    // The exit was previously never requested until a rule wanted out, so a
    // position could exist whose sell had never been shown to be constructible
    // at ANY price. That is the same defect as booking a fill against a quote
    // nobody could build, moved one step later. The sell is requested here, at
    // the exact token amount the buy would produce, in the same family.
    const exitKey = `${sizeKey}:${tokensIn.toString()}`;
    const cachedExit = sharedExit.get(exitKey);
    const exitObs =
      cachedExit ??
      (await observeRoute(db, jupiter, {
      family: config.primaryRouteFamily as 'BUILD_CUSTOM',
      mint,
      side: 'sell',
      positionId: null,
      shadowPositionId: null,
      purpose: `shadow_entry_roundtrip`,
      inputMint: mint,
      outputMint: WSOL_MINT,
      amount: tokensIn,
      taker,
      slippageBps: config.risk.maxSlippageBps,
      maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      priority: 'enrichment',
      contextHash,
    }));
    sharedExit.set(exitKey, exitObs);

    if (exitObs.instructionSetHash === null || exitObs.expectedOutput <= 0n) {
      recordHealth(
        db,
        'shadow_entry_refused_no_exit',
        'info',
        `${book} ${mint.slice(0, 12)}: buy builds, sell does not; not an entry`,
      );
      continue;
    }

    // THE leg that was broken. It spends TOKENS, so the setup must provision
    // tokens -- funding it with SOL alone is what made 43 of 43 sells fail with
    // the identical error at the identical instruction.
    await simulateLeg(db, blobs, simulator, exitObs.observationId, taker, {
      mode: 'DEVELOPMENT_JIT',
      side: 'sell',
      inputMint: mint,
      outputMint: WSOL_MINT,
      // Exactly the amount the buy would have acquired: the hypothetical
      // position, not a convenient number.
      inputAmount: tokensIn,
      routeFamily: exitObs.family,
      capabilityFingerprint: fingerprintForObservation(db, blobs, exitObs.observationId),
      inputTokenProgram: tokenProgramFor(db, blobs, exitObs.observationId, taker, mint),
      fundingLamports: notional,
      maxLamportsSpent: notional * 2n,
      expectedOutput: exitObs.expectedOutput,
      minimumOutput: exitObs.minimumOutput,
      contextHash,
    });

    // The round trip, measured on the pair that would actually be traded
    // rather than on a probe. Recorded whether or not it is favourable — a
    // corpus that stores only the cheap round trips cannot say what the
    // expensive ones cost.
    const back = netExpectedOutput(exitObs);
    const roundTripLossBps = Number(((notional - back) * 10_000n) / notional);

    const cost =
      notional +
      config.assumedSignatureFeeLamports +
      config.assumedPriorityFeeLamports +
      config.assumedBroadcasterTipLamports +
      config.assumedAtaRentLamports +
      config.assumedFailedAttemptLamports;

    const id = openShadowPosition(db, {
      book,
      mint,
      state: 'POSITION_OPEN',
      notionalLamports: notional,
      tokenAmount: tokensIn,
      costLamports: cost,
      entryObservationId: obs.observationId,
      openedUtcMs: Date.now(),
      portfolioRefusal: refusal,
      strategyVersion: config.strategyVersion,
      contextHash,
    });

    /**
     * P19 — the tournament arm, assigned AS THE TRAJECTORY OPENS.
     *
     * Balanced across the six entry-by-exit cells, deterministic given the
     * counts already in the corpus, and independent of everything about this
     * candidate. Allocating by score or liquidity or age would measure each arm
     * on a different population, and labelling an existing corpus afterwards is
     * how an arm ends up holding the trajectories that happen to suit it.
     *
     * The tournament itself does not run yet — the first checkpoint is ten
     * completed trajectories per arm and there are none. This is what makes the
     * ones that arrive usable when they do.
     */
    const arm = allocateArm(armCounts(db));
    assignTournamentArm(db, id, arm.entry, arm.exit);

    // Written straight after the insert rather than threaded through the
    // repository signature, because the cohort is a property of the DECISION
    // and every other caller of openShadowPosition would have to invent one.
    // P10 -- the evidence class this shadow qualified for AT OPEN.
    //
    // Stamped rather than derived later. A derivation runs under whatever the
    // code believes at report time, so a shadow opened when nothing was
    // effect-verified would silently become JIT_EFFECT_VALID the moment some
    // later run of the same observation passed.
    const evidence = evidenceClassOf(
      legEvidenceOf(db, obs.observationId),
      legEvidenceOf(db, exitObs.observationId),
    );
    db.prepare(
      `UPDATE shadow_positions
         SET cohort = ?, token_age_ms_at_open = ?, cohort_source = 'ASSIGNED_AT_OPEN',
             evidence_class = ?
       WHERE shadow_position_id = ?`,
    ).run(cohort, tokenAgeMsAtOpen, evidence, id);
    bindEpisode(db, id, episode.signalEpisodeId, exitObs.observationId, roundTripLossBps);
    log.info(
      {
        book,
        mint,
        shadowPositionId: id,
        episode: episode.signalEpisodeId,
        roundTripLossBps,
        refusal,
      },
      'shadow position opened — buy AND sell both build at this exact size',
    );
  }
}

/**
 * Work the shadow books.
 *
 * Independent state, independent exits, no shared capital. Bounded per cycle so
 * an accumulating shadow book cannot starve the realizable wallet of rate
 * budget — the wallet is the thing that could actually lose money.
 */
/**
 * Is this position close enough to a decision that a mark still matters?
 *
 * Uses the last recorded mark against the stop level. Deliberately crude: the
 * point is to prioritise the marks that can change an outcome, and a position
 * with no mark at all counts as near-trigger because we do not know where it is.
 */
function nearTrigger(
  row: { peak_value_lamports: string | null; cost_lamports: string },
  config: AppConfig,
): boolean {
  const peak = row.peak_value_lamports === null ? null : BigInt(row.peak_value_lamports);
  if (peak === null) return true;
  const cost = BigInt(row.cost_lamports);
  if (cost <= 0n) return true;
  const stopLevel = (cost * BigInt(10_000 - config.exits.stopLossBps)) / 10_000n;
  const band = (cost * BigInt(config.exits.stopLossBps)) / 50_000n;
  return peak <= stopLevel + band;
}

/** The simulation outcome as stored, after a simulation may have written it. */
function simulationStatusOf(db: Db, observationId: string): 'SIMULATED_OK' | 'SIMULATION_FAILED' | 'NOT_SIMULATED' {
  const r = db
    .prepare('SELECT simulation AS s FROM execution_observations WHERE observation_id = ?')
    .get(observationId) as { s: string } | undefined;
  const v = r?.s ?? 'NOT_SIMULATED';
  return v === 'SIMULATED_OK' || v === 'SIMULATION_FAILED' ? v : 'NOT_SIMULATED';
}

/**
 * P3 -- the ECONOMIC verdict the row carries, read back from the database.
 *
 * A missing row, a NULL column and an unrecognised value all read as
 * NOT_VERIFIED. That is the only safe collapse: every one of them means nobody
 * established that the trade happened, and the gate must refuse all three
 * identically.
 */
function simulationEffectOf(db: Db, observationId: string): SimulationEffectOutcome {
  const r = db
    .prepare('SELECT simulation_effect AS e FROM execution_observations WHERE observation_id = ?')
    .get(observationId) as { e: string | null } | undefined;
  const v = r?.e ?? 'NOT_VERIFIED';
  return v === 'SIMULATED_EFFECT_OK' || v === 'EFFECT_REFUSED' ? v : 'NOT_VERIFIED';
}

async function manageShadowBooks(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  taker: string | null,
  contextHash: string,
  // P6 -- a shadow exit is admitted by the same core function the realizable
  // portfolio uses, and that function simulates before it judges. It therefore
  // needs the same two collaborators.
  blobs: BlobStore,
  simulator: SimulationClient | null,
): Promise<number> {
  if (taker === null || config.maxShadowMarksPerCycle === 0) return 0;

  // §12.4 — by urgency, not by age.
  //
  // This used to be `.slice(0, cap)` over a query ordered by opened_utc_ms. With
  // 179 open shadows and a per-cycle cap, the same oldest positions were marked
  // every cycle and the newest were never marked at all -- and a position with
  // no marks looks exactly like a position whose value did not move.
  const all = openShadowPositions(db);
  const byId = new Map(all.map((r) => [r.shadow_position_id, r]));
  const lastMarks = new Map(
    (
      db
        .prepare('SELECT shadow_position_id AS id, MAX(observed_utc_ms) AS t FROM shadow_marks GROUP BY shadow_position_id')
        .all() as { id: string; t: number }[]
    ).map((r) => [r.id, Number(r.t)]),
  );

  const nowForSchedule = Date.now();
  const ranked = scheduleMarks(
    all.map((r) => ({
      id: r.shadow_position_id,
      openedUtcMs: Number(r.opened_utc_ms),
      lastMarkUtcMs: lastMarks.get(r.shadow_position_id) ?? null,
      // A shadow whose exit could not be built is the one that most needs
      // watching, not the one to deprioritise.
      blocked: r.state === 'EXIT_BLOCKED',
      // Within a fifth of the stop distance of the stop. A mark here can still
      // change what happens; one on a position sitting mid-range cannot.
      nearTrigger: nearTrigger(r, config),
    })),
    config.markIntervalMs,
    nowForSchedule,
  );

  const backlog = assessBacklog(ranked, config.maxShadowMarksPerCycle, nowForSchedule);
  if (backlog.overCapacity) {
    recordHealth(db, 'shadow_mark_backlog', 'warn', backlog.detail);
  }

  const open = ranked
    .filter((m) => m.urgency !== 'NOT_DUE')
    .slice(0, config.maxShadowMarksPerCycle)
    .map((m) => byId.get(m.id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  let closed = 0;

  for (const row of open) {
    const tokenAmount = BigInt(row.token_amount);
    const costLamports = BigInt(row.cost_lamports);
    if (tokenAmount <= 0n) continue;

    const obs = await observeRoute(db, jupiter, {
      family: config.primaryRouteFamily as 'BUILD_CUSTOM',
      mint: row.mint,
      side: 'sell',
      positionId: null,
      shadowPositionId: row.shadow_position_id,
      purpose: `${row.book}_mark`,
      inputMint: row.mint,
      outputMint: WSOL_MINT,
      amount: tokenAmount,
      taker,
      slippageBps: Math.min(config.risk.maxSlippageBps, 300),
      maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      priority: 'enrichment',
      contextHash,
    });

    const nowMs = Date.now();
    const routeAvailable = obs.instructionSetHash !== null && obs.expectedOutput > 0n;
    const value = routeAvailable ? netExpectedOutput(obs) : null;

    const seq = (
      db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM shadow_marks WHERE shadow_position_id = ?')
        .get(row.shadow_position_id) as { s: number }
    ).s + 1;
    insertShadowMark(db, {
      shadowPositionId: row.shadow_position_id,
      seq,
      observedUtcMs: nowMs,
      observationId: obs.observationId,
      executableValueLamports: value,
      routeAvailable,
    });

    const peak = BigInt(row.peak_value_lamports ?? row.cost_lamports);
    if (value !== null && value > peak) updateShadowPeak(db, row.shadow_position_id, value);

    /**
     * P6 — the trajectory lifecycle, driven by the state machine that has
     * existed since it was written and that nothing imported.
     *
     *   POSITION_OPEN
     *     -> EXIT_TRIGGERED / AWAITING_FILL_OBSERVATION   on the exit rule
     *     -> POSITION_CLOSED                              on a LATER valid fill
     *     -> EXIT_BLOCKED                                 when no fill exists yet
     *
     * The old loop went from `decideExit` straight to `closeShadowPosition`, at
     * the triggering mark's own value. That books a fill at the price which
     * CAUSED the decision to exit, observed before the decision existed — the
     * one price a real exit can never get. `assertTransition` refuses it in
     * words: "a shadow may not close at its trigger observation".
     */
    const state = (row.state as ShadowState) ?? 'POSITION_OPEN';

    if (state === 'POSITION_OPEN') {
      const decision = decideExit(
        {
          costLamports,
          peakValueLamports: value !== null && value > peak ? value : peak,
          markLamports: value,
          openedUtcMs: row.opened_utc_ms,
          nowUtcMs: nowMs,
          exitRouteExists: routeAvailable,
        },
        config.exits,
      );
      if (!decision.exit) continue;

      // The machine hop is asserted rather than assumed. EXIT_TRIGGERED and
      // AWAITING_FILL_OBSERVATION are the same instant and two different
      // claims: the rule fired, and nothing has filled it.
      assertTransition('POSITION_OPEN', 'EXIT_TRIGGERED');
      assertTransition('EXIT_TRIGGERED', 'AWAITING_FILL_OBSERVATION');
      triggerShadowExit(db, row.shadow_position_id, {
        triggeredUtcMs: nowMs,
        observationId: obs.observationId,
        valueLamports: value,
        reason: decision.reason ?? 'unknown',
      });
      log.info(
        { book: row.book, mint: row.mint, reason: decision.reason },
        'shadow exit TRIGGERED; awaiting a later fill observation',
      );
      continue;
    }

    if (!holdsExposure(state)) continue;

    // ---- awaiting or blocked: is there a fill yet? ------------------------
    const triggeredAt = row.triggered_utc_ms === null ? null : Number(row.triggered_utc_ms);
    if (triggeredAt === null) {
      // A managed state with no trigger is a row from before this migration.
      // It is left alone rather than silently reinterpreted.
      continue;
    }

    /**
     * P9 — SIMULATE THIS OBSERVATION FIRST. The deadlock lived in the order.
     *
     * The previous sequence was:
     *
     *     resolveFill(candidates)      needs an effect-valid candidate
     *       -> none, because nothing simulates a mark
     *       -> blocked
     *       -> simulate something else
     *
     * `resolveFill` asked for a thing the loop never produced. 169 trajectories
     * sat in AWAITING_FILL_OBSERVATION for up to 4.6 hours with 96 later
     * observations each, all recorded as "not effect-valid, unpriced", and not
     * one trajectory in the corpus ever completed through it.
     *
     * The candidate has to exist before it can be chosen, so this observation is
     * simulated and settled BEFORE anything is asked about fills. Only a priced
     * observation is worth the simulation: an unroutable mark cannot become a
     * fill however it is verified.
     */
    if (routeAvailable && value !== null) {
      try {
        await simulateLeg(db, blobs, simulator, obs.observationId, taker, {
          mode: 'DEVELOPMENT_JIT',
          side: 'sell',
          inputMint: row.mint,
          outputMint: WSOL_MINT,
          inputAmount: tokenAmount,
          routeFamily: config.primaryRouteFamily,
          capabilityFingerprint: fingerprintForObservation(db, blobs, obs.observationId),
          inputTokenProgram: tokenProgramFor(db, blobs, obs.observationId, taker, row.mint),
          outputTokenProgram: tokenProgramFor(db, blobs, obs.observationId, taker, WSOL_MINT),
          fundingLamports: 100_000_000n,
          maxLamportsSpent: 20_000_000n,
          expectedOutput: obs.expectedOutput,
          minimumOutput: obs.minimumOutput,
          contextHash,
        });
      } catch (e) {
        // A simulation that could not run leaves the candidate unverified,
        // which `resolveFill` will decline on its own. It is not a reason to
        // lose the trajectory.
        recordHealth(
          db,
          'fill_candidate_simulation_failed',
          'warn',
          `${row.mint.slice(0, 12)}: ${(e as Error).message.slice(0, 140)}`,
        );
      }
    }

    const outcome = resolveFill(
      triggeredAt,
      config.primaryRouteFamily,
      fillCandidatesSince(db, row.shadow_position_id, triggeredAt),
      FROZEN_FILL_LATENCY_MS,
    );

    if (outcome.kind === 'blocked') {
      if (state === 'AWAITING_FILL_OBSERVATION') assertTransition(state, 'EXIT_BLOCKED');
      blockShadowExit(db, row.shadow_position_id, outcome.reason);
      continue;
    }

    if (state === 'EXIT_BLOCKED') {
      assertTransition('EXIT_BLOCKED', 'AWAITING_FILL_OBSERVATION');
      resumeShadowExit(db, row.shadow_position_id);
    }

    /**
     * The SELECTED candidate, which is not necessarily the one just observed.
     *
     * `resolveFill` returns the FIRST valid later observation, and on a blocked
     * trajectory that may be one from a previous cycle. The old code then
     * simulated `obs` — the current mark — and booked `outcome.at`. Simulating
     * B while booking A verifies a price nobody is filling at.
     *
     * Everything from here reads the selected observation's own identity.
     */
    const selectedId = outcome.at.observationId;
    const selectedJobId = latestJobFor(db, selectedId);
    const selectedSettlement =
      selectedJobId === null ? null : measuredSettlementOf(db, selectedId, selectedJobId, taker);

    if (selectedSettlement === null) {
      // No measured settlement for the observation actually being filled. The
      // alternative is a router fallback, which is a number nobody measured.
      assertTransition('AWAITING_FILL_OBSERVATION', 'EXIT_BLOCKED');
      blockShadowExit(
        db,
        row.shadow_position_id,
        `selected candidate ${selectedId.slice(0, 12)} has no measured settlement`,
      );
      continue;
    }

    /**
     * The same admission the realizable portfolio uses.
     *
     * A shadow that closes on a route the portfolio would have refused is a
     * shadow measuring a different strategy. The call graph asserts this edge
     * exists; before P6 it did not.
     */
    /**
     * The admission, on the observation being BOOKED.
     *
     * It is already simulated — either just now, or in the cycle that first
     * observed it — so this reads its stored verdicts rather than simulating
     * anything. A simulator here would be the same defect in a new place:
     * verifying one observation and filling at another.
     */
    const selectedObs = observationById(db, selectedId);
    if (selectedObs === null) {
      assertTransition('AWAITING_FILL_OBSERVATION', 'EXIT_BLOCKED');
      blockShadowExit(db, row.shadow_position_id, `selected candidate ${selectedId.slice(0, 12)} is not stored`);
      continue;
    }
    const selectedExecutable = legIsExecutable(
      {
        ...selectedObs,
        simulation: simulationStatusOf(db, selectedId),
        simulationEffect: simulationEffectOf(db, selectedId),
      },
      { requireLocalSimulation: config.requireLocalSimulation === true },
    );
    if (!selectedExecutable.ok) {
      assertTransition('AWAITING_FILL_OBSERVATION', 'EXIT_BLOCKED');
      blockShadowExit(db, row.shadow_position_id, selectedExecutable.reasons.join('; '));
      continue;
    }

    /**
     * The realized value comes from the SELECTED observation's measured
     * settlement, not from the mark's quoted value. A quote is what a router
     * expected; the settlement is what the simulated leg actually moved.
     */
    const fillValue = exitCashIn(selectedSettlement);
    const bias = lookAheadBiasLamports(BigInt(row.trigger_value_lamports ?? '0'), outcome);
    assertTransition('AWAITING_FILL_OBSERVATION', 'POSITION_CLOSED');
    fillShadowExit(db, row.shadow_position_id, {
      realizedLamports: (fillValue ?? 0n) - costLamports,
      closedUtcMs: nowMs,
      exitReason: row.trigger_reason ?? 'unknown',
      diagnostic: 'NONE',
      exitObservationId: outcome.at.observationId,
      fillLatencyMs: outcome.latencyMs,
      lookAheadBiasLamports: bias,
    });
    /**
     * P11 — the episode ends when the book flattens.
     *
     * Without this an episode stays open forever and the mint is never
     * claimable again. The old wall-clock bucket needed no close because a new
     * bucket arrived every fifteen minutes on its own — which is also why it
     * split one signal into two trades at 14:59 and 15:01.
     */
    if (row.signal_episode_id !== null) {
      closeSignalEpisode(db, row.signal_episode_id, nowMs);
    }
    closed += 1;
    log.info(
      {
        book: row.book,
        mint: row.mint,
        pnlSol: formatAmount((fillValue ?? 0n) - costLamports, 9),
        reason: row.trigger_reason,
        fillLatencyMs: outcome.latencyMs,
        lookAheadBiasSol: bias === null ? null : formatAmount(bias, 9),
      },
      'shadow position closed at a LATER fill (NOT a wallet result and never summed with one)',
    );
  }
  return closed;
}

/** Marks every open position with a live sell quote and applies the exit rules. */
async function manageOpenPositions(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  ledger: Ledger,
  taker: string | null,
  contextHash: string,
  // P3/P9 -- the exit leg is simulated like any other, so this path needs the
  // same two collaborators the entry path has.
  blobs: BlobStore,
  simulator: SimulationClient | null,
): Promise<number> {
  const open = managedPositions(db);
  let exited = 0;

  /**
   * P7 — CONSUME the urgent queue.
   *
   * `urgentMarks` was written by the alarm callback and read by nothing. The
   * whole websocket path therefore ended in a `Set.add` — the socket
   * connected, the pool was watched, a material drop fired the callback, the
   * mint went into a set, and the set was never looked at.
   *
   * An alarm that reaches no decision is an alarm that did not happen. Urgent
   * mints are marked FIRST, ahead of the scheduled order, because the reason
   * they are urgent is that their liquidity moved.
   */
  const urgent = [...urgentMarks];
  urgentMarks.clear();
  if (urgent.length > 0) {
    recordHealth(
      db,
      'urgent_marks_consumed',
      'info',
      `${urgent.length} alarm-driven mint(s) marked ahead of schedule: ${urgent
        .slice(0, 5)
        .map((m) => m.slice(0, 8))
        .join(', ')}`,
    );
  }
  const urgentFirst = new Set(urgent);
  open.sort((a, b) => {
    const ua = urgentFirst.has(a.mint) ? 0 : 1;
    const ub = urgentFirst.has(b.mint) ? 0 : 1;
    return ua - ub;
  });

  if (taker === null) {
    // Without a taker no route can be observed at all, so an open position
    // cannot be marked, let alone exited. Loud, and not silently skipped.
    if (open.length > 0) {
      recordHealth(
        db,
        'exit_management_impossible',
        'critical',
        `${open.length} managed position(s) and no PAPER_TAKER_PUBKEY; no exit can be observed`,
      );
    }
    return 0;
  }

  for (const row of open) {
    // §4.1 — an EXIT_BLOCKED position is retried at a bounded interval rather
    // than hammered every cycle or forgotten forever.
    if (row.state === 'EXIT_BLOCKED' && row.last_exit_attempt_utc_ms !== null) {
      if (Date.now() - row.last_exit_attempt_utc_ms < EXIT_RETRY_INTERVAL_MS) continue;
    }
    const tokenAmount = BigInt(row.token_amount);
    const costLamports = BigInt(row.cost_lamports);

    const res = await jupiter.tryQuote({
      inputMint: row.mint,
      outputMint: WSOL_MINT,
      amount: tokenAmount,
      slippageBps: Math.min(config.risk.maxSlippageBps, 300),
      // The most urgent class there is. An exit quote must never queue behind
      // a discovery call on the shared 0.5 RPS bucket.
      priority: 'emergency_exit',
    });

    const providerFailed = res.providerFailure !== null;
    if (res.providerFailure) {
      // An outage is not a signal about the position. Do not act on it, but do
      // record it: repeated failures are themselves a reason to stop trading.
      recordSourceHealth(db, res.providerFailure.source, false, null, res.providerFailure.kind);
      log.warn({ mint: row.mint, kind: res.providerFailure.kind }, 'mark failed — provider outage, holding');
    }

    const sell = res.quote;
    let rawPayloadHash: string | null = null;
    if (sell) {
      if (sell.rawBody !== null) {
        rawPayloadHash = storeRawPayload(db, 'jupiter.swap.v2.order', '/swap/v2/order', sell.rawBody, sell.receivedUtcMs);
      }
      insertQuote(db, row.mint, 'sell', sell, rawPayloadHash, contextHash);
    }

    // P9 — the decision-bearing mark is an EXACT full-balance BUILD_CUSTOM
    // sell, not the /order quote.
    //
    // /order is a router's opinion about a swap nobody built. Stop, trail,
    // take-profit, collapse, peak and NAV all read the mark, so every exit rule
    // in this system was reacting to a number that had never been through
    // policy, had never been simulated, and might not correspond to a
    // transaction that can be assembled at all.
    //
    // The quote above is still taken and still stored. It is a benchmark, and
    // the gap between it and the executable value is itself a measurement.
    const markObs =
      taker === null
        ? null
        : await observeRoute(db, jupiter, {
            family: (row.route_family ?? config.primaryRouteFamily) as 'BUILD_CUSTOM',
            mint: row.mint,
            side: 'sell',
            positionId: row.position_id,
            shadowPositionId: null,
            purpose: 'mark',
            inputMint: row.mint,
            outputMint: WSOL_MINT,
            // The FULL balance. A mark taken at a smaller size is a price for a
            // trade we are not going to make, and it flatters exactly the
            // positions that are too large for their pool.
            amount: tokenAmount,
            taker,
            slippageBps: Math.min(config.risk.maxSlippageBps, 300),
            maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
            broadcasterTipLamports: config.assumedBroadcasterTipLamports,
            priority: 'risk',
            contextHash,
          }).catch(() => null);

    // The benchmark, kept beside the executable number rather than instead of it.
    const benchmarkLamports = sell ? sell.outAmount : null;

    /**
     * P9 — the decision comes from the CORE, not from arithmetic repeated here.
     *
     * `chooseDecisionMark` is the function the behavioural tests execute. This
     * used to be a second copy of the same rules, which is how a tested
     * function and a running process end up disagreeing without anyone editing
     * either of them.
     */
    const markDecision = chooseDecisionMark({
      executableLamports: markObs === null ? null : markObs.expectedOutput,
      benchmarkLamports,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
    });
    const grossProceeds = markDecision.decisionBearing ? (markObs?.expectedOutput ?? null) : null;
    const markLamports = markDecision.markLamports;
    const benchmarkGapBps = markDecision.benchmarkMinusExecutableBps;

    const routeAvailable = sell !== null && sell.outAmount > 0n;
    const nowMs = Date.now();
    const impact = sell ? sell.impact : null;
    const quoteAgeMs = sell === null ? null : nowMs - sell.receivedUtcMs;

    // Signed, and left signed. A negative return is a real economic statement
    // and `Math.abs` on it is the defect this whole session exists to remove.
    const signedMarkReturnBps =
      markLamports === null || costLamports <= 0n
        ? null
        : Number(((markLamports - costLamports) * 10_000n) / costLamports);

    // Every mark is persisted, whether or not it causes an exit. A rule can
    // only be evaluated against the observations available to it, and marks
    // that are not written are observations that never existed.
    const prev = latestMark(db, row.position_id);
    const markId = randomUUID();
    insertPositionMark(db, {
      markId,
      positionId: row.position_id,
      mint: row.mint,
      seq: prev === null ? 0 : prev.seq + 1,
      observedUtcMs: nowMs,
      rawPriceImpactPct: impact?.signedPct ?? null,
      rawPriceImpactBpsSigned: impact?.signedBps === null || impact?.signedBps === undefined ? null : Math.round(impact.signedBps),
      quotedExitInputTokenAmount: tokenAmount,
      quotedExitOutputLamports: grossProceeds,
      quotedExitThresholdLamports: sell ? sell.otherAmountThreshold : null,
      positionEntryCostLamports: costLamports,
      positionMarkedValueLamports: markLamports,
      exitValueRatio:
        grossProceeds === null || costLamports <= 0n ? null : Number(grossProceeds) / Number(costLamports),
      outputChangeFromPreviousMarkBps:
        prev === null || prev.outLamports === null || prev.outLamports === 0n || grossProceeds === null
          ? null
          : Number(((grossProceeds - prev.outLamports) * 10_000n) / prev.outLamports),
      routeAvailable,
      routeLabels: sell ? sell.routeLabels.join('>') : null,
      platformFeeBps: sell ? sell.platformFeeBps : null,
      platformFeeAmount:
        sell?.platformFeeAmount ??
        (sell && grossProceeds !== null ? (grossProceeds * BigInt(sell.platformFeeBps)) / 10_000n : null),
      // Null, not zero: paper does not observe transfer-fee extensions yet, and
      // recording an unobserved cost as zero would understate exit cost.
      transferFeeAmount: null,
      estimatedNetworkFeeLamports: sell ? sell.signatureFeeLamports : null,
      estimatedPriorityFeeLamports: config.assumedPriorityFeeLamports,
      poolQuoteReserve: null,
      poolTokenReserve: null,
      quoteReserveChangeFromEntryBps: null,
      quoteReserveChangeFromPrevBps: null,
      liquidityUsd: null,
      liquidityChangeFromEntryBps: null,
      developerNetTokenFlow: null,
      clusteredInsiderNetTokenFlow: null,
      quoteRequestedUtcMs: sell ? sell.requestedUtcMs : null,
      quoteReceivedUtcMs: sell ? sell.receivedUtcMs : null,
      quoteLatencyMs: sell ? sell.latencyMs : null,
      sourceUtcMs: sell ? sell.provenance.receivedUtcMs : null,
      slot: markObs?.contextSlot ?? sell?.contextSlot ?? null,
      source: 'jupiter',
      backfilled: false,
      markSource: markDecision.source,
      markObservationId: markObs?.observationId ?? null,
      benchmarkOrderLamports: benchmarkLamports,
      benchmarkMinusExecutableBps: benchmarkGapBps,
      // Only an executable mark may move a stop, a trail, a peak or NAV.
      decisionBearing: markDecision.decisionBearing,
    });

    // §P1.2 — mutually exclusive diagnostics, derived from economic quantities
    // and from whether the provider answered at all. `routeBuildable` is null
    // here: the exit build is only requested when a rule actually wants out,
    // and null means "not asked", never "failed".
    const markDiagnostic = diagnoseExit({
      providerFailed,
      impact,
      routeExists: routeAvailable,
      routeBuildable: null,
      executableSellValueLamports: grossProceeds,
      allInCostLamports: costLamports,
      quoteAgeMs,
      roundTripLossBps: null,
    });

    recordMarkAnalysis(db, markId, {
      impact,
      diagnostic: markDiagnostic,
      executableSellValueLamports: grossProceeds,
      allInCostLamports: costLamports,
      signedMarkReturnBps,
      roundTripRouteLossBps: null,
      quoteAgeMs,
      routeExists: routeAvailable,
      routeBuildable: null,
      rawPayloadHash,
      contextHash,
    });

    if (providerFailed) continue;

    // P9 — an unpriceable mark holds. It is written (a mark that is not written
    // is an observation that never existed) and it drives nothing: a null
    // executable value read as a stop trigger would exit every position the
    // moment the builder had a bad minute.
    if (grossProceeds === null || markLamports === null) {
      recordHealth(
        db,
        'mark_not_executable',
        'warn',
        `${row.mint.slice(0, 12)}: no BUILD_CUSTOM sell could be observed for the full balance; ` +
          'the position is held and the mark drives nothing',
      );
      continue;
    }

    const peak = BigInt(row.peak_value_lamports ?? row.cost_lamports);
    const newPeak = markLamports !== null && markLamports > peak ? markLamports : peak;
    if (newPeak !== peak) updatePosition(db, row.position_id, { peakValueLamports: newPeak });

    const decision = decideExit(
      {
        costLamports,
        peakValueLamports: newPeak,
        markLamports,
        openedUtcMs: row.opened_utc_ms,
        nowUtcMs: nowMs,
        exitRouteExists: routeAvailable,
      },
      config.exits,
    );

    if (!decision.exit) continue;

    const marksObserved = (prev === null ? 0 : prev.seq + 1) + 1;

    if (!sell || markLamports === null || grossProceeds === null) {
      // Wanted out, cannot get out. A real terminal state, recorded as such
      // rather than quietly retried forever.
      updatePosition(db, row.position_id, { state: 'EXIT_BLOCKED', exitReason: decision.reason });
      recordHealth(db, 'exit_blocked', 'critical', `${row.mint} ${decision.detail}`);
      log.error({ mint: row.mint, reason: decision.reason }, 'EXIT BLOCKED — no sell route');
      continue;
    }

    /**
     * P10 — the TRIGGER, which is not the fill.
     *
     * The engine used to observe a route, decide to exit, and close against
     * that same observation. That is a fill at the instant of noticing, with
     * no reaction, build, simulation, signature or landing in between — so
     * every exit in the corpus was priced at a moment no real exit could have
     * reached, and the bias is systematically favourable because the policy
     * fires exactly when the price is most extreme.
     *
     * The trigger is recorded and the position moves to
     * AWAITING_FILL_OBSERVATION. The fill comes from a LATER same-family
     * effect-verified observation, at least FROZEN_FILL_LATENCY_MS after it.
     */
    if (row.exit_triggered_utc_ms === null) {
      updatePosition(db, row.position_id, {
        state: 'AWAITING_FILL_OBSERVATION',
        exitTriggeredUtcMs: nowMs,
        exitTriggerReason: decision.reason ?? 'unknown',
      });
      recordHealth(
        db,
        'exit_triggered',
        'info',
        `${row.mint.slice(0, 12)}: ${decision.reason ?? 'unknown'} fired; awaiting a fill at least ` +
          `${FROZEN_FILL_LATENCY_MS}ms later`,
      );
      continue;
    }

    // Already triggered. The fill observation must be strictly later than the
    // trigger plus the frozen latency.
    if (nowMs < row.exit_triggered_utc_ms + FROZEN_FILL_LATENCY_MS) continue;

    // §2.2 / §4.2 — the exit leg is ONE exact-size observation of the same
    // family the entry used, for the exact token amount held.
    const exitObs = await observeRoute(db, jupiter, {
      family: (row.route_family ?? config.primaryRouteFamily) as 'BUILD_CUSTOM',
      mint: row.mint,
      side: 'sell',
      positionId: row.position_id,
      shadowPositionId: null,
      purpose: 'exit',
      inputMint: row.mint,
      outputMint: WSOL_MINT,
      amount: tokenAmount,
      taker,
      slippageBps: Math.min(config.risk.maxSlippageBps, 300),
      maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      priority: 'emergency_exit',
      contextHash,
    });

    // P3/P9 -- simulate the exit before asking whether it is executable.
    //
    // The previous code gated the exit on `legIsExecutable` without ever
    // running the simulator over it, so the simulation clause could only ever
    // read NOT_SIMULATED. An exit is the leg that matters most: an entry that
    // is refused costs nothing, and an exit that is refused strands capital.
    //
    // It is a SELL, so it spends tokens, and the setup provisions exactly the
    // amount actually held rather than a convenient number.
    await simulateLeg(db, blobs, simulator, exitObs.observationId, taker, {
      mode: 'DEVELOPMENT_JIT',
      side: 'sell',
      inputMint: row.mint,
      outputMint: WSOL_MINT,
      inputAmount: tokenAmount,
      routeFamily: exitObs.family,
      capabilityFingerprint: fingerprintForObservation(db, blobs, exitObs.observationId),
      inputTokenProgram: tokenProgramFor(db, blobs, exitObs.observationId, taker, row.mint),
      // Fees and rent only. A sell does not spend SOL on the trade itself, and
      // funding it as though it might would hide a route that quietly does.
      fundingLamports: 100_000_000n,
      maxLamportsSpent: 20_000_000n,
      expectedOutput: exitObs.expectedOutput,
      minimumOutput: exitObs.minimumOutput,
      contextHash,
    });

    /**
     * P9 — the exit admission comes from the CORE.
     *
     * `admitPortfolioExit` simulates the leg and then judges it, in that order,
     * which is the whole point: the previous code tested the observation for
     * simulation without ever having simulated it.
     */
    const exitAdmission = await admitPortfolioExit(
      {
        simulator: {
          simulate: async (observationId, leg) => {
            await simulateLeg(db, blobs, simulator, observationId, taker, {
              mode: 'DEVELOPMENT_JIT',
              side: leg.side,
              inputMint: leg.inputMint,
              outputMint: leg.outputMint,
              inputAmount: leg.inputAmount,
              routeFamily: (row.route_family ?? config.primaryRouteFamily) as string,
              capabilityFingerprint: fingerprintForObservation(db, blobs, observationId),
              inputTokenProgram: tokenProgramFor(db, blobs, observationId, taker, leg.inputMint),
              outputTokenProgram: tokenProgramFor(db, blobs, observationId, taker, leg.outputMint),
              fundingLamports: 100_000_000n,
              maxLamportsSpent: 20_000_000n,
              expectedOutput: leg.expectedOutput,
              minimumOutput: leg.minimumOutput,
              contextHash,
            });
            return {
              simulation: simulationStatusOf(db, observationId),
              effect: simulationEffectOf(db, observationId),
            };
          },
        },
      },
      {
        exit: exitObs,
        mint: row.mint,
        tokenAmount,
        requireLocalSimulation: config.requireLocalSimulation,
      },
    );
    const exitExecutable = { ok: exitAdmission.ok, reasons: exitAdmission.reasons };
    if (!exitExecutable.ok) {
      // §4.2 — THE repair. The previous code recorded the failure, closed the
      // position, realized the PnL and returned the capital to the free
      // balance. That is not a wallet path that exists: an exit that cannot be
      // built cannot be taken, so the tokens are still held, the rent is still
      // locked, and the exposure is still ours.
      //
      // The position stays managed and is retried. Capital is NOT released.
      markExitBlocked(db, row.position_id, nowMs, exitExecutable.reasons.join('; '));
      recordHealth(
        db,
        'exit_blocked',
        'critical',
        `${row.mint.slice(0, 12)} wants out and cannot: ${exitExecutable.reasons.join('; ')}. ` +
          'Tokens still held, rent still locked, capital NOT released.',
      );
      log.error(
        { mint: row.mint, positionId: row.position_id, reasons: exitExecutable.reasons },
        'EXIT BLOCKED — position remains managed, capital remains committed',
      );
      // The failed attempt still costs what a failed attempt costs.
      continue;
    }

    bindExitObservation(db, row.position_id, exitObs.observationId);
    const exitBuildable = true;

    // §3.4 — every exit cost subtracted, and the ATA rent credited only if a
    // close was shown to be possible (it never is in paper; see ata.ts).
    const grossFromObservation = netExpectedOutput(exitObs);

    // ATA rent settlement. In paper this always returns zero recovery, and it
    // says which unknown stopped it: withheld transfer fees are unobserved, and
    // an unobserved value is never treated as zero. That makes the previous
    // implicit "rent is fully sunk" explicit and auditable, and it makes the
    // recovery assumption a thing a reader can argue with. §P5.
    const ata: AtaState = {
      ataCreated: true,
      ataRentLockedLamports: config.assumedAtaRentLamports,
      // Never asked: paper builds no close transaction. Null, not false.
      ataCloseBuildable: null,
      ataCloseSimulated: null,
      ataCloseAttempted: false,
      ataCloseConfirmed: false,
      // A full-position sell leaves nothing behind, by construction.
      residualTokenAmount: 0n,
      // Unobserved. This is the field that keeps recovery at zero.
      withheldTransferFeeLamports: null,
      ataCloseFeeLamports: config.assumedSignatureFeeLamports,
    };
    const ataVerdict = settleAtaRent(ata);

    /**
     * P10 — is THIS observation a valid fill for that trigger?
     *
     * `resolveFill` refuses the trigger itself whatever its id says, refuses a
     * cross-family observation, refuses one whose own effect did not verify,
     * and refuses an unpriced one. A fill at an unknown price is a number
     * invented at the moment it matters most.
     */
    const fill = resolveFill(
      row.exit_triggered_utc_ms,
      (row.route_family ?? config.primaryRouteFamily) as string,
      [
        {
          observationId: exitObs.observationId,
          observedUtcMs: nowMs,
          family: exitObs.family,
          effectValid: simulationEffectOf(db, exitObs.observationId) === 'SIMULATED_EFFECT_OK',
          executableLamports: grossFromObservation,
        },
      ],
    );
    if (fill.kind !== 'filled') {
      recordHealth(db, 'exit_awaiting_fill', 'warn', `${row.mint.slice(0, 12)}: ${fill.reason}`.slice(0, 200));
      continue;
    }

    // P6 — the exit's MEASURED settlement, derived before the cost model that
    // reads its transfer fee. Null when the leg was not effect-verified, and a
    // null fee is refused rather than charged as zero.
    const exitJobId = latestJobFor(db, exitObs.observationId);
    const exitSettlement =
      exitJobId === null ? null : measuredSettlementOf(db, exitObs.observationId, exitJobId, taker);

    const proceeds = netExitProceeds({
      grossProceedsLamports: grossFromObservation,
      signatureFeeLamports: config.assumedSignatureFeeLamports,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      // P4 — zero ONLY when the asset cannot carry a fee. An unmeasured
      // Token-2022 fee is refused above rather than charged as nothing.
      transferFeeLamports: exitSettlement === null ? 0n : (transferFeeOrUnknown(exitSettlement) ?? 0n),
      closeAccountFeeLamports: config.assumedSignatureFeeLamports,
      // P6 — this exit succeeded. It pays for no failed attempt. See the entry.
      assumedFailedAttemptLamports: 0n,
      ataRentRecoveredLamports: ataVerdict.ataRentRecoveredLamports,
    });
    const realized = proceeds - costLamports;

    // Classified from executable value, independently of which rule fired.
    // `decision.reason` is kept beside it rather than replaced by it.
    const verdict = classifyExit({
      quotedExitOutputLamports: grossProceeds,
      positionEntryCostLamports: costLamports,
      routeAvailable,
      triggerRule: decision.reason as TriggerRule,
    });

    const exitDiagnostic = diagnoseExit({
      providerFailed: false,
      impact,
      routeExists: routeAvailable,
      routeBuildable: exitBuildable,
      executableSellValueLamports: grossProceeds,
      allInCostLamports: costLamports,
      quoteAgeMs,
      roundTripLossBps: null,
    });

    const exitFillId = randomUUID();
    insertFill(db, {
      fillId: exitFillId,
      intentId: row.position_id,
      mint: row.mint,
      side: 'sell',
      actualInAmount: tokenAmount,
      // Gross, and therefore never negative. The priority fee lives in its own
      // column; folding it into the output produced a fill claiming the swap
      // returned less SOL than it did.
      actualOutAmount: grossFromObservation,
      feeLamports: sell.platformFeeAmount ?? (grossProceeds * BigInt(sell.platformFeeBps)) / 10_000n,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
      rentLamports: 0n,
      signature: null,
      slot: null,
      simulated: true,
      utcMs: nowMs,
    });
    stampContext(db, 'fills', exitFillId, contextHash);

    insertPositionExit(db, {
      positionId: row.position_id,
      mint: row.mint,
      outcome: verdict.outcome,
      triggerRule: decision.reason ?? 'unknown',
      outcomeRationale: verdict.rationale,
      exitValueRatio: verdict.exitValueRatio,
      positionEntryCostLamports: costLamports,
      quotedExitOutputLamports: grossFromObservation,
      grossProceedsLamports: grossFromObservation,
      exitFeesLamports: config.assumedPriorityFeeLamports,
      netProceedsLamports: proceeds,
      realizedLamports: realized,
      entryNotionalLamports: costLamports - config.assumedPriorityFeeLamports - config.assumedAtaRentLamports,
      entryFixedCostsLamports: config.assumedPriorityFeeLamports + config.assumedAtaRentLamports,
      ataRentLamports: config.assumedAtaRentLamports,
      ataRentRefunded: ataVerdict.ataRentRecoveredLamports > 0n,
      finalMarkId: markId,
      marksObserved,
      openedUtcMs: row.opened_utc_ms,
      closedUtcMs: nowMs,
      heldMs: nowMs - row.opened_utc_ms,
      strategyVersion: config.strategyVersion,
      accountingVersion: ACCOUNTING_VERSION,
      backfilled: false,
    });

    annotateExit(db, row.position_id, {
      diagnostic: exitDiagnostic,
      ata,
      ataVerdict,
      ataAccountingVersion: ATA_ACCOUNTING_VERSION,
      // §P4 — what the response actually reported, beside what we assumed.
      // Documentation says 50bps under 24h; a live probe measured 10bps.
      // Neither is a fact about this trade. This is.
      fees: {
        feeBps: sell.platformFeeBps,
        feeMint: sell.feeMint,
        platformFeeAmount: sell.platformFeeAmount,
        platformFeeBps: sell.platformFeeBps,
        signatureFeeLamports: sell.signatureFeeLamports,
        prioritizationFeeLamports: sell.prioritizationFeeLamports,
        rentFeeLamports: sell.rentFeeLamports,
      },
      contextHash,
    });

    /**
     * P4 — settle the explicit economics at close.
     *
     * The exit's MEASURED settlement when there is one; the observed gross
     * otherwise, which is stated rather than silently substituted. `bookedCost`
     * is what the entry actually spent — read back from the row rather than
     * recomputed, so the two ends of the position agree by construction.
     */
    const settledGross =
      exitSettlement !== null && isPnlEligible(exitSettlement).ok
        ? exitCashIn(exitSettlement)
        : grossFromObservation;
    /**
     * P4 — two DIFFERENT numbers, read from the two columns that mean them.
     *
     * `bookedCashOut` is what left the wallet to open: principal plus costs,
     * and it is what net PnL subtracts. `bookedEntryExecutionCost` is the
     * costs alone.
     *
     * These were one number read from `execution_cost_lamports`, which is why
     * the column held principal — the reader wanted cash out and the column
     * was the only place it had been written.
     */
    const readCol = (col: string, fallback: bigint): bigint => {
      try {
        const r = db.prepare(`SELECT ${col} v FROM positions WHERE position_id = ?`).get(row.position_id) as
          | { v: string | null }
          | undefined;
        return r?.v == null ? fallback : BigInt(r.v);
      } catch {
        return fallback;
      }
    };
    const bookedCashOut = readCol('entry_cash_out_lamports', costLamports);
    const bookedEntryExecutionCost = readCol('execution_cost_lamports', 0n);

    updatePosition(db, row.position_id, {
      state: 'POSITION_CLOSED',
      realizedLamports: realized,
      closedUtcMs: nowMs,
      exitReason: decision.reason,
      tokenAmount: 0n,
      // P4 — the EXECUTION cost of both legs, principal excluded.
      // Both legs' costs, principal excluded. The entry side was written at
      // open and is read back rather than recomputed, so the two ends of the
      // position agree by construction.
      executionCostLamports: bookedEntryExecutionCost + (exitSettlement === null ? 0n : executionCost(exitSettlement)),
      grossProceedsLamports: settledGross,
      // P10 — how long the exit actually took, so the assumption can be
      // checked against what happened rather than trusted.
      exitFillLatencyMs: fill.latencyMs,
      /**
       * P9 — the invariant, not a second opinion.
       *
       *   net_pnl_lamports = exit_cash_in_lamports - entry_cash_out_lamports
       *
       * Both operands are written on this same row in this same statement, so
       * a reader can check the identity rather than trust it.
       */
      netPnlLamports: settledGross - bookedCashOut,
      exitCashInLamports: settledGross,
      entryCashOutLamports: bookedCashOut,
      lockedRentLamports:
        exitSettlement === null
          ? undefined
          : exitSettlement.costs.rentCreatedLamports - exitSettlement.costs.rentRecoveredLamports,
      // The tokens the exit did NOT manage to sell. Zero is a measurement;
      // undefined is the absence of one.
      residualTokenAtoms: exitSettlement?.residualTokenAtoms ?? undefined,
    });

    /**
     * P7 — unwatch the EXACT accounts that were subscribed.
     *
     * This passed an empty string, so the watcher deleted nothing and the
     * subscription outlived the position. Every closed position leaked one.
     */
    if (alarm !== null) {
      for (const account of riskAccountsFor(row.mint)) {
        alarm.unwatch({ mint: row.mint, reserveTokenAccount: account });
      }
    }

    ledger.freeLamports += proceeds + ataVerdict.ataRentRecoveredLamports;
    ledger.navLamports += realized;
    ledger.realizedTodayLamports += realized;
    ledger.lockedRentLamports -= config.assumedAtaRentLamports;
    if (ledger.lockedRentLamports < 0n) ledger.lockedRentLamports = 0n;
    if (ledger.navLamports > ledger.peakNavLamports) ledger.peakNavLamports = ledger.navLamports;
    exited += 1;

    for (const name of ['portfolio_paper', 'alpha_shadow'] as const) {
      insertLedgerEntry(db, {
        ledger: name,
        positionId: row.position_id,
        mint: row.mint,
        event: 'exit',
        utcMs: nowMs,
        notionalLamports: costLamports,
        realizedLamports: realized,
        navLamports: ledger.navLamports,
        freeLamports: ledger.freeLamports,
        lockedRentLamports: ledger.lockedRentLamports,
        refusal: null,
        detail: `${decision.reason ?? 'unknown'} / ${exitDiagnostic.diagnostic}`,
        contextHash,
      });
    }

    log.info(
      {
        positionId: row.position_id,
        mint: row.mint,
        reason: decision.reason,
        diagnostic: exitDiagnostic.diagnostic,
        exitBuildable,
        pnlEligible: exitBuildable === true,
        detail: decision.detail,
        costSol: formatAmount(costLamports, 9),
        proceedsSol: formatAmount(proceeds, 9),
        pnlSol: formatAmount(realized, 9),
        rentRecoveredSol: formatAmount(ataVerdict.ataRentRecoveredLamports, 9),
        rentBlockedBy: ataVerdict.ataCloseFailureReason,
        executableValueRatioBps: executableValueRatioBps(grossProceeds, costLamports),
        heldSec: Math.round((nowMs - row.opened_utc_ms) / 1000),
      },
      realized >= 0n ? 'PAPER EXIT (win)' : 'PAPER EXIT (loss)',
    );
  }

  return exited;
}

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const tick = (): void => {
      if (cancelled() || waited >= ms) {
        resolve();
        return;
      }
      waited += step;
      setTimeout(tick, Math.min(step, ms - waited + step));
    };
    tick();
  });
}

void LAMPORTS_PER_SOL;

main().catch((e: Error) => {
  log.error({ err: e.message, stack: e.stack }, 'paper engine fatal');
  process.exitCode = 1;
});
