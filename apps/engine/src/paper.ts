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
  openPositions,
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
import { checkLeg } from './buildleg.js';

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
      openPositions: openPositions(db).length,
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
  let lastClock: ClockReading = readClock();
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
      const openNow = openPositions(db).length;
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

    // Reconciliation after a discontinuity: every open position has now been
    // re-quoted from a fresh executable route and re-marked above, and the
    // database is checked below. Only then are entries allowed again.
    if (pendingResync !== null) {
      const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])[0];
      if (integrity?.integrity_check === 'ok') {
        markResyncDone(db, pendingResync.checkpointId, Date.now());
        recordHealth(db, 'clock_resync_complete', 'info', 'positions re-marked from fresh routes; entries re-enabled');
        log.info('clock resync complete — entries re-enabled');
        pendingResync = null;
      } else {
        log.error({ integrity: integrity?.integrity_check }, 'database integrity check failed during resync');
      }
    }

    const heldMints = new Set(openPositions(db).map((p) => p.mint));

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
    const open = openPositions(db);
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

  const open = openPositions(db);
  const state: PortfolioState = {
    navLamports: ledger.navLamports,
    freeLamports: ledger.freeLamports,
    openPositions: open.length,
    totalExposureLamports: open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n),
    realizedTodayLamports: ledger.realizedTodayLamports,
    peakNavLamports: ledger.peakNavLamports,
    realizedWeekLamports: realizedWeek(db, Date.now()),
    // Planned loss across the open book: each position's cost times the stop
    // distance, i.e. what the book loses if every stop fills at its level.
    plannedLossLamports: open.reduce(
      (a, p) => a + (BigInt(p.cost_lamports) * BigInt(config.exits.stopLossBps)) / 10_000n,
      0n,
    ),
  };

  const sizing = sizePosition(state, config, result.outcome.opportunityScore ?? 0);

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
    return;
  }

  // The quote was taken at probe size. Scale its worst-case output linearly and
  // then charge the documented new-token fee on top. Linear scaling understates
  // impact at larger size, so the size is also capped at the probe notional to
  // keep the extrapolation honest.
  const probe = config.quoteProbeLamports;
  const lamportsIn = sizing.lamports > probe ? probe : sizing.lamports;
  const guaranteedOut = (rt.buy.otherAmountThreshold * lamportsIn) / probe;
  const feeBps = BigInt(Math.max(config.assumedNewTokenFeeBps, rt.buy.platformFeeBps));
  const tokensReceived = (guaranteedOut * (10_000n - feeBps)) / 10_000n;

  if (tokensReceived <= 0n) return;

  // A price is not an execution.
  //
  // Every quote in the original corpus was fetched without a `taker`, so
  // Jupiter returned routing and fees but never a transaction, and
  // `transactionBuildable` was false on all 2255 of them. Booking a fill anyway
  // asserted that a trade could have happened when nothing had demonstrated
  // that it could. The flag was stored from the first commit and read by no
  // decision.
  //
  // The check is a separate `/swap/v2/build` call rather than the quote's own
  // flag, because `/swap/v2/order` refuses to build for an unfunded taker
  // (errorCode 1, "Insufficient funds") while `/swap/v2/build` returns the
  // instruction set regardless of balance. Verified 2026-08-12 against a wallet
  // holding 0 lamports. This establishes STRUCTURAL buildability only, and is
  // never reported as a mainnet simulation.
  if (config.requireBuildableFill) {
    if (taker === null) {
      recordHealth(db, 'buildability_unverifiable', 'critical', 'PAPER_TAKER_PUBKEY unset; cannot establish buildability');
      log.warn({ mint }, 'entry refused — no taker configured, buildability cannot be established');
      return;
    }
    const leg = await checkLeg(db, jupiter, {
      mint,
      side: 'buy',
      positionId: null,
      quoteId: rt.buy.quoteId,
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: lamportsIn,
      taker,
      slippageBps: config.risk.maxSlippageBps,
      maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
      priority: 'risk',
      contextHash,
    });

    if (!leg.buildable) {
      recordHealth(
        db,
        'unbuildable_entry_refused',
        'warn',
        `${mint.slice(0, 12)} priced but not tradable: ${leg.reason}`,
      );
      log.info(
        { mint, symbol, router: rt.buy.router, reason: leg.reason },
        'entry refused — route priced but no policy-valid transaction could be constructed',
      );
      return;
    }
    log.info(
      {
        mint,
        symbol,
        instructions: leg.outcome?.instructionCount,
        policy: leg.policyStatus,
        lastValidBlockHeight: leg.outcome?.lastValidBlockHeight,
      },
      'entry buildability and policy established',
    );
  }

  // ATA rent is LOCKED capital, not a fee. It leaves free capital and stays in
  // the position until a close is shown to be possible. See §P5.
  const rentLamports = config.assumedAtaRentLamports;
  const fixedCosts = config.assumedPriorityFeeLamports + rentLamports;
  const costLamports = lamportsIn + fixedCosts;

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

  const fillId = randomUUID();
  const fill: Fill = {
    fillId,
    intentId: result.outcome.snapshotId,
    mint,
    side: 'buy',
    actualInAmount: lamportsIn,
    actualOutAmount: tokensReceived,
    feeLamports: (lamportsIn * feeBps) / 10_000n,
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
      modelledFeeBps: Number(feeBps),
      actualFeeBps: rt.buy.platformFeeBps,
    },
    'PAPER ENTRY (simulated fill, real quote, build-validated)',
  );
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
  const open = openPositions(db);
  let exited = 0;

  for (const row of open) {
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

    // §P0.2 — the exit leg. This is the half that was missing: the entry was
    // build-gated and the exit was not, so a closed position could carry a
    // realized PnL derived from a price that had never been shown to be
    // tradable. A trade is PAPER_PNL_ELIGIBLE only when BOTH legs built.
    let exitBuildable: boolean | null = null;
    if (config.requireBuildableFill) {
      if (taker === null) {
        exitBuildable = null;
      } else {
        const leg = await checkLeg(db, jupiter, {
          mint: row.mint,
          side: 'sell',
          positionId: row.position_id,
          quoteId: sell.quoteId,
          inputMint: row.mint,
          outputMint: WSOL_MINT,
          amount: tokenAmount,
          taker,
          slippageBps: Math.min(config.risk.maxSlippageBps, 300),
          maxPriorityFeeLamports: config.risk.maxPriorityFeeLamports,
          priority: 'emergency_exit',
          contextHash,
        });
        exitBuildable = leg.buildable;
        if (!leg.buildable) {
          // The exit is still taken — refusing to close a position because the
          // build check failed would leave real exposure open on a route we
          // have just been told is unhealthy, which is worse. What changes is
          // the CLAIM: the row is marked UNBUILDABLE_EXIT and is excluded from
          // confirmatory results by `disqualifiesFromConfirmatory`.
          recordHealth(
            db,
            'unbuildable_exit',
            'critical',
            `${row.mint.slice(0, 12)} exit priced but not buildable: ${leg.reason} — this trade is NOT PnL-eligible`,
          );
          log.error({ mint: row.mint, reason: leg.reason }, 'exit leg not buildable — closing, but not PnL-eligible');
        }
      }
    }

    const proceeds = markLamports;

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

    const realized = proceeds - costLamports + ataVerdict.ataRentRecoveredLamports;

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
      actualOutAmount: grossProceeds,
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
      quotedExitOutputLamports: grossProceeds,
      grossProceedsLamports: grossProceeds,
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
