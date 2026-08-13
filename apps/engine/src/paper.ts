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
import { Cadence, detectDiscontinuity, readClock, monotonicMs } from '../../../packages/domain/src/clock.js';
import type { ClockReading } from '../../../packages/domain/src/clock.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../../../packages/adapters/src/jupiter/client.js';
import { SCHEMA_VERSION as JUPITER_SCHEMA_VERSION } from '../../../packages/adapters/src/jupiter/schemas.js';
import { SourceFetchError } from '../../../packages/adapters/src/http.js';
import { SolanaRpc } from '../../../packages/solana/src/rpc.js';
import { emptyStats, runCycle } from '../../../packages/pipeline/src/cycle.js';
import { decideExit } from '../../../packages/strategy/src/exits.js';
import { sizePosition } from '../../../packages/strategy/src/portfolio.js';
import type { PortfolioState } from '../../../packages/strategy/src/portfolio.js';
import { logger, sanitizeExternal } from '../../../packages/observability/src/log.js';
import { formatAmount } from '../../../packages/domain/src/amounts.js';
import { realizedWeek, restoreLedger, rollDayIfNeeded } from './ledger.js';
import type { Ledger } from './ledger.js';
import { observeRoute } from './observe-route.js';
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
      exits = await manageOpenPositions(db, jupiter, config, ledger, taker, contextHash);
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
    // Planned loss across the open book: each position's cost times the stop
    // distance, i.e. what the book loses if every stop fills at its level.
    plannedLossLamports: open.reduce(
      (a, p) => a + (BigInt(p.cost_lamports) * BigInt(config.exits.stopLossBps)) / 10_000n,
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
  await openShadowBooks(
    db,
    jupiter,
    config,
    taker,
    mint,
    contextHash,
    sizing.allowed ? 'accepted_by_portfolio' : (sizing.refusal ?? 'unknown'),
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

  // §2.2 / §3.1 — every gate is re-evaluated at the size actually being
  // entered, against the response that priced it.
  const executable = legIsExecutable(entry, { requireLocalSimulation: config.requireLocalSimulation });
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
async function openShadowBooks(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  taker: string | null,
  mint: string,
  contextHash: string,
  refusal: string,
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
async function manageShadowBooks(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  taker: string | null,
  contextHash: string,
): Promise<number> {
  if (taker === null || config.maxShadowMarksPerCycle === 0) return 0;
  const open = openShadowPositions(db).slice(0, config.maxShadowMarksPerCycle);
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

    // The mark is the router's expected output, not `otherAmountThreshold`.
    // The threshold is a slippage floor — a number chosen by our own slippage
    // setting, not an observation of the market — so marking against it made
    // every position look worse by exactly `slippageBps` and made the mark
    // series unusable as evidence about liquidity. Both are recorded.
    //
    // `outAmount` is the SOL the router says the swap returns; route and
    // platform fees are already reflected in it, so they are recorded as
    // metadata and NOT subtracted again. The priority fee is not reflected in
    // it, so it is the one cost deducted here.
    const grossProceeds = sell ? sell.outAmount : null;
    const markLamports = grossProceeds === null ? null : grossProceeds - config.assumedPriorityFeeLamports;

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
      slot: sell?.contextSlot ?? null,
      source: 'jupiter',
      backfilled: false,
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

    const exitExecutable = legIsExecutable(exitObs, {
      requireLocalSimulation: config.requireLocalSimulation,
    });
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
