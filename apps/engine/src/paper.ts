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
import { chooseDecisionMark, admitPortfolioExit } from './paper-core.js';
import {
  bindEntryObservation,
  bindExitObservation,
  managedPositions,
  markExitBlocked,
  openShadowPosition,
  openShadowPositions,
  insertShadowMark,
  closeShadowPosition,
  updateShadowPeak,
  unmanagedPositions,
  claimSignalEpisode,
  bindEpisode,
} from '../../../packages/storage/src/observation-repo.js';
import {
  legIsExecutable,
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
      await manageShadowBooks(db, jupiter, config, taker, contextHash);
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

  // ONE observation. Amount, expected output, minimum output, route plan, fee
  // model, instructions, blockhash and expiry all come from this single
  // response. Nothing is borrowed from the `/order` quote that screened it —
  // that quote is a QUOTE_ONLY_BENCHMARK and is never mixed in.
  const entry = await observeRoute(db, jupiter, {
    family: config.primaryRouteFamily as 'BUILD_CUSTOM',
    mint,
    side: 'buy',
    positionId: null,
    shadowPositionId: null,
    purpose: 'entry',
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount: lamportsIn,
    taker,
    slippageBps: config.risk.maxSlippageBps,
    maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
    broadcasterTipLamports: config.assumedBroadcasterTipLamports,
    priority: 'risk',
    contextHash,
  });

  // §9 — simulate the EXACT bytes before asking whether the leg is executable.
  //
  // Order matters: legIsExecutable requires SIMULATED_OK when
  // requireLocalSimulation is set, so running it first would refuse every entry
  // for a simulation that was never attempted. That is what has been happening.
  await simulateLeg(db, blobs, simulator, entry.observationId, taker, {
    mode: 'DEVELOPMENT_JIT',
    side: 'buy',
    inputMint: WSOL_MINT,
    outputMint: mint,
    inputAmount: lamportsIn,
    // Enough hypothetical SOL to cover the leg, its fees and any rent it
    // creates, inside a throwaway SVM. Not a wallet.
    fundingLamports: lamportsIn * 10n,
    maxLamportsSpent: lamportsIn * 2n,
    expectedOutput: entry.expectedOutput,
    minimumOutput: entry.minimumOutput,
    contextHash,
  });
  // Re-read: the simulation wrote onto the row, and the in-memory observation
  // predates it.
  const simulated = simulationStatusOf(db, entry.observationId);

  // §2.2 / §3.1 — every gate is re-evaluated at the size actually being
  // entered, against the response that priced it.
  const executable = legIsExecutable(
    { ...entry, simulation: simulated, simulationEffect: simulationEffectOf(db, entry.observationId) },
    { requireLocalSimulation: config.requireLocalSimulation },
  );
  if (!executable.ok) {
    recordHealth(
      db,
      'entry_not_executable',
      'warn',
      `${mint.slice(0, 12)} refused: ${executable.reasons.join('; ')}`,
    );
    log.info(
      { mint, symbol, reasons: executable.reasons, observationId: entry.observationId },
      'entry refused — the exact-size observation is not an executable leg',
    );
    // §5 — the realizable portfolio declining is exactly the case the shadow
    // book exists for, but a shadow position may only be opened on an
    // observation that was itself obtained. An unbuildable route is a fact
    // about the token and there is nothing to shadow.
    return;
  }

  // §3.2 — the fee is charged ONCE, by the family contract. BUILD_CUSTOM
  // returns no fee fields at all (verified live), so there is nothing to
  // deduct; the old code multiplied by (1 - feeBps) on top of an /order amount
  // that already had the fee taken out.
  const tokensReceived = netMinimumOutput(entry);
  if (tokensReceived <= 0n) return;

  // P9 — a buy without a verified same-family sell is not a portfolio entry.
  //
  // The exit half, at the EXACT amount this buy would leave us holding,
  // observed on the SAME family, policy-checked and effect-verified. A position
  // opened on a buy alone is a position whose exit has never been shown to
  // exist, and capital has already been booked into one of those.
  const entrySell = await observeRoute(db, jupiter, {
    family: entry.family,
    mint,
    side: 'sell',
    positionId: null,
    shadowPositionId: null,
    purpose: 'entry_roundtrip',
    inputMint: mint,
    outputMint: WSOL_MINT,
    amount: tokensReceived,
    taker,
    slippageBps: Math.min(config.risk.maxSlippageBps, 300),
    maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
    broadcasterTipLamports: config.assumedBroadcasterTipLamports,
    priority: 'risk',
    contextHash,
  }).catch(() => null);

  if (entrySell === null) {
    recordHealth(
      db,
      'entry_without_exit',
      'warn',
      `${mint.slice(0, 12)}: the entry buy is executable and no same-family sell could be observed. ` +
        'Not entered: an entry whose exit does not exist is not an entry.',
    );
    return;
  }

  await simulateLeg(db, blobs, simulator, entrySell.observationId, taker, {
    mode: 'DEVELOPMENT_JIT',
    side: 'sell',
    inputMint: mint,
    outputMint: WSOL_MINT,
    inputAmount: tokensReceived,
    inputTokenProgram: tokenProgramFor(db, blobs, entrySell.observationId),
    fundingLamports: 100_000_000n,
    maxLamportsSpent: 20_000_000n,
    expectedOutput: entrySell.expectedOutput,
    minimumOutput: entrySell.minimumOutput,
    contextHash,
  });

  const sellExecutable = legIsExecutable(
    {
      ...entrySell,
      simulation: simulationStatusOf(db, entrySell.observationId),
      simulationEffect: simulationEffectOf(db, entrySell.observationId),
    },
    { requireLocalSimulation: config.requireLocalSimulation },
  );
  if (!sellExecutable.ok) {
    recordHealth(
      db,
      'entry_without_exit',
      'warn',
      `${mint.slice(0, 12)}: the exit half is not executable — ${sellExecutable.reasons.join('; ')}`,
    );
    log.info(
      { mint, symbol, reasons: sellExecutable.reasons },
      'entry refused — the round trip does not close',
    );
    return;
  }
  if (entrySell.family !== entry.family) {
    recordHealth(
      db,
      'entry_without_exit',
      'critical',
      `${mint.slice(0, 12)}: entry family ${entry.family} but exit family ${entrySell.family}. ` +
        'Two families are two markets and their difference is not a round trip.',
    );
    return;
  }

  // §3.4 — every fixed cost, charged once each, nothing omitted for being
  // small. The signature fee is 5000 lamports; against the 0.02 SOL canary cap
  // that is 2.5 bps, and the whole question is whether a few hundred bps of
  // edge exists. An accounting model that skips the costs it considers
  // negligible cannot test a thin edge.
  //
  // ATA rent is LOCKED capital rather than a fee: it leaves free capital and
  // stays in the position until a close is shown to be possible. See §P5.
  const rentLamports = config.assumedAtaRentLamports;
  const entryCosts = {
    inputLamports: lamportsIn,
    signatureFeeLamports: config.assumedSignatureFeeLamports,
    priorityFeeLamports: config.assumedPriorityFeeLamports,
    broadcasterTipLamports: config.assumedBroadcasterTipLamports,
    ataRentLamports: rentLamports,
    // Not observed for this mint. Null would be more honest than 0, but this
    // field feeds an amount rather than a label, so it is 0 with the gap named
    // in docs/AUDIT_HEAD_3155EA.md rather than silently absent.
    transferFeeLamports: 0n,
    // BUILD_CUSTOM carries no platform fee. Charging one would be inventing it.
    platformFeeLamports: 0n,
    assumedFailedAttemptLamports: config.assumedFailedAttemptLamports,
  };
  const costLamports = totalEntryCost(entryCosts);

  // What this round trip actually costs, measured rather than assumed. It is
  // the number that decides whether an edge has to clear 200 bps or 1,400.
  const entryRoundTripLossBps =
    costLamports <= 0n ? null : Number(((costLamports - entrySell.expectedOutput) * 10_000n) / costLamports);
  if (entryRoundTripLossBps !== null) {
    recordHealth(
      db,
      'entry_round_trip',
      'info',
      `${mint.slice(0, 12)}: buy then immediate same-family sell loses ${entryRoundTripLossBps} bps all-in`,
    );
  }

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
 * Which token program the input asset uses.
 *
 * Token and Token-2022 are different programs with different account layouts,
 * and provisioning inventory under the wrong one creates an account the
 * transaction will not find. Read from the accounts the route actually names,
 * so it is the route's answer rather than a default.
 *
 * Falls back to legacy Token, which is what the overwhelming majority of these
 * mints use, and the fallback is visible in the observation's own account list
 * if it is ever wrong.
 */
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function tokenProgramFor(db: Db, blobs: BlobStore, observationId: string): string {
  try {
    const hash = exactBlobFor(db, observationId);
    if (hash === null) return LEGACY_TOKEN_PROGRAM;
    const blob = blobs.get<ExactTransactionBlob>(hash);
    const keys = [...blob.staticAccountKeys, ...blob.loadedAddresses];
    return keys.includes(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : LEGACY_TOKEN_PROGRAM;
  } catch {
    // An unreadable blob is not a reason to guess Token-2022; the legacy
    // program is what the overwhelming majority of these mints use, and a wrong
    // guess here creates inventory the transaction will not find.
    return LEGACY_TOKEN_PROGRAM;
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
      inputTokenProgram: tokenProgramFor(db, blobs, exitObs.observationId),
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

    // A shadow exit needs a buildable route for the same reason a real one
    // does. Without it the position stays open and keeps being worked.
    if (!routeAvailable) continue;

    closeShadowPosition(db, row.shadow_position_id, {
      realizedLamports: (value ?? 0n) - costLamports,
      closedUtcMs: nowMs,
      exitReason: decision.reason ?? 'unknown',
      diagnostic: routeAvailable ? 'NONE' : 'NO_EXIT_ROUTE',
      exitObservationId: obs.observationId,
    });
    closed += 1;
    log.info(
      {
        book: row.book,
        mint: row.mint,
        pnlSol: formatAmount((value ?? 0n) - costLamports, 9),
        reason: decision.reason,
      },
      'shadow position closed (NOT a wallet result and never summed with one)',
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
      inputTokenProgram: tokenProgramFor(db, blobs, exitObs.observationId),
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
              inputTokenProgram: tokenProgramFor(db, blobs, observationId),
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

    const proceeds = netExitProceeds({
      grossProceedsLamports: grossFromObservation,
      signatureFeeLamports: config.assumedSignatureFeeLamports,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
      broadcasterTipLamports: config.assumedBroadcasterTipLamports,
      transferFeeLamports: 0n,
      closeAccountFeeLamports: config.assumedSignatureFeeLamports,
      assumedFailedAttemptLamports: config.assumedFailedAttemptLamports,
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

    updatePosition(db, row.position_id, {
      state: 'POSITION_CLOSED',
      realizedLamports: realized,
      closedUtcMs: nowMs,
      exitReason: decision.reason,
      tokenAmount: 0n,
    });

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
