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
import { openDb, ProcessLock } from '../../../packages/storage/src/db.js';
import type { Db } from '../../../packages/storage/src/db.js';
import {
  counters,
  insertBuildAttempt,
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
import { ACCOUNTING_VERSION, classifyExit } from '../../../packages/domain/src/exitoutcome.js';
import type { TriggerRule } from '../../../packages/domain/src/exitoutcome.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../../../packages/adapters/src/jupiter/client.js';
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

/**
 * Paper mode.
 *
 * Runs the identical screening pipeline as observe, then maintains simulated
 * positions against REAL executable quotes. Nothing here is signed or sent:
 * quotes are requested without `taker`, so no signable transaction can even be
 * returned to this process.
 *
 * Fill honesty rules, applied without exception:
 *  - an ENTRY fill uses the quote's `otherAmountThreshold` — the worst amount
 *    the router guarantees at that slippage — never the optimistic `outAmount`,
 *    so we never credit ourselves tokens a live buy might not have received;
 *  - an EXIT is valued at `outAmount`, the router's expected output. This is
 *    deliberately the other field, and the asymmetry is the conservative
 *    direction in both cases. `otherAmountThreshold` is derived from our own
 *    `slippageBps` and is therefore not an observation of the market at all;
 *    marking an open position against it subtracted a constant `slippageBps`
 *    from every mark and made a position look impaired by an amount we had
 *    chosen ourselves. Exit slippage is modelled where slippage belongs — in
 *    the cost model — not smuggled into the price;
 *  - priority fee and ATA rent are charged on entry even though no transaction
 *    was sent, because a live entry would pay them;
 *  - the modelled new-token fee is the DOCUMENTED 50 bps, not the 10 bps we
 *    measured, so paper results cannot be flattered by an unexplained discount.
 *
 * A paper P&L that would not survive being wrong about those four things is
 * not evidence of anything.
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
  log.info(
    {
      mode: config.mode,
      strategyVersion: config.strategyVersion,
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
  // Discovery is expensive and slow-moving; marking an open position is cheap
  // and urgent. Before P2 they shared one interval, so the mark cadence was
  // whatever discovery happened to be — 31s in the observed corpus, which is
  // wider than the entire lifetime of every collapse we have measured. The loop
  // now ticks at the mark cadence and discovery runs on its own schedule.
  let lastDiscoveryUtcMs = 0;
  // A halt is announced once, not every 10s for as long as the file exists.
  let haltAnnounced = false;

  while (!stop) {
    const started = Date.now();
    cycle += 1;
    let stats = emptyStats();

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
    // ended. `dayStartUtcMs` used to be set once in `restoreLedger` and read
    // by nothing, which made the cap permanent rather than daily: paper mode
    // had been halted for the whole measurement window with 145 eligible
    // candidates and zero open positions, and the only cure was a restart.
    if (rollDayIfNeeded(db, ledger, started)) {
      log.info(
        { dayStartUtcMs: ledger.dayStartUtcMs, realizedTodaySol: formatAmount(ledger.realizedTodayLamports, 9) },
        'UTC day rolled — daily loss budget reset',
      );
    }

    // Exits run FIRST, every cycle, before any entry may compete for the quote
    // budget. Getting out is always more urgent than getting in.
    let exits = 0;
    try {
      exits = await manageOpenPositions(db, jupiter, config, ledger);
    } catch (e) {
      log.error({ err: (e as Error).message }, 'exit management failed');
      recordHealth(db, 'exit_management_error', 'critical', (e as Error).message);
    }

    const heldMints = new Set(openPositions(db).map((p) => p.mint));

    // Entries are refused for as long as any halt file exists, whatever its
    // mode. Discovery still runs so the corpus keeps growing, and marks still
    // run so open positions stay observed.
    const entriesHalted = halt !== null;

    // Discovery runs on its own, much slower schedule. The loop itself now
    // ticks at the mark cadence, so an open position is re-quoted every
    // `markIntervalMs` regardless of how expensive discovery is; when the two
    // shared an interval, the resolution of the entire exit corpus was set by
    // whatever the discovery budget happened to allow.
    const discoveryDue = started - lastDiscoveryUtcMs >= config.discoveryIntervalMs;

    if (discoveryDue) {
      lastDiscoveryUtcMs = started;
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
            await tryEnter(db, jupiter, taker, config, ledger, info.id, sanitizeExternal(info.symbol ?? '', 16), result);
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
        exposureSol: formatAmount(exposure, 9),
        realizedTodaySol: formatAmount(ledger.realizedTodayLamports, 9),
        totalScreenings: c.screenings,
        elapsedMs: Date.now() - started,
      },
      'cycle complete',
    );

    // The tick is the MARK cadence, not the discovery cadence. Discovery
    // gates itself above on its own, longer interval.
    await sleep(Math.max(1_000, config.markIntervalMs - (Date.now() - started)), () => stop);
  }

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
    plannedLossLamports: openPositions(db).reduce(
      (a, p) => a + (BigInt(p.cost_lamports) * BigInt(config.exits.stopLossBps)) / 10_000n,
      0n,
    ),
  };

  const sizing = sizePosition(state, config, result.outcome.opportunityScore ?? 0);
  if (!sizing.allowed) {
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
  // Every quote in the corpus was fetched without a `taker`, so Jupiter
  // returned routing and fees but never a transaction, and
  // `transactionBuildable` was false on all 2255 of them. Booking a fill anyway
  // asserted that a trade could have happened when nothing had demonstrated
  // that it could. The flag was stored from the first commit and read by no
  // decision.
  //
  // The check is a separate `/swap/v2/build` call rather than the quote's own
  // flag, because `/swap/v2/order` refuses to build for an unfunded taker
  // (errorCode 1, "Insufficient funds") while `/swap/v2/build` returns the
  // instruction set regardless of balance. Verified 2026-08-12 against a wallet
  // holding 0 lamports. This establishes STRUCTURAL buildability only: that a
  // transaction could have been constructed for this route at this size. It is
  // not a mainnet simulation and is never reported as one.
  if (config.requireBuildableFill) {
    if (taker === null) {
      recordHealth(db, 'buildability_unverifiable', 'critical', 'PAPER_TAKER_PUBKEY unset; cannot establish buildability');
      log.warn({ mint }, 'entry refused — no taker configured, buildability cannot be established');
      return;
    }
    const built = await jupiter.build({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: lamportsIn,
      taker,
      slippageBps: config.risk.maxSlippageBps,
    });
    // Recorded whether or not it succeeded. A refused entry is as much a fact
    // about the route as an accepted one, and without the failures the corpus
    // cannot say what fraction of eligible candidates were actually tradable.
    insertBuildAttempt(db, {
      buildId: randomUUID(),
      mint,
      side: 'buy',
      positionId: null,
      quoteId: rt.buy.quoteId,
      requestedUtcMs: built?.requestedUtcMs ?? Date.now(),
      receivedUtcMs: built?.receivedUtcMs ?? null,
      latencyMs: built?.latencyMs ?? null,
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: lamportsIn,
      taker,
      slippageBps: config.risk.maxSlippageBps,
      buildEndpoint: built?.endpoint ?? '/swap/v2/build',
      buildRouter: built?.router ?? null,
      buildRequestId: built?.requestId ?? null,
      buildStatus: built === null ? 'UNVERIFIABLE' : built.buildable ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED',
      buildErrorCode: built?.errorCode ?? null,
      buildErrorClass: built === null ? 'request_failed' : built.errorMessage,
      instructionCount: built?.instructionCount ?? null,
      programIds: built?.programIds ?? null,
      hasSetup: built?.hasSetup ?? null,
      hasCleanup: built?.hasCleanup ?? null,
      transactionBytesHash: null,
      lastValidBlockHeight: null,
      expireAt: null,
      quoteContextSlot: null,
      buildContextSlot: null,
      // NULL, not a pass. The decoder and a local SVM fixture are not wired,
      // and a row must never claim validation it did not receive.
      policyStatus: null,
      simulationStatus: null,
    });

    if (built === null || !built.buildable) {
      recordHealth(
        db,
        'unbuildable_entry_refused',
        'warn',
        `${mint.slice(0, 12)} priced but not buildable: ${built === null ? 'build request failed' : (built.errorMessage ?? `errorCode ${built.errorCode}`)}`,
      );
      log.info(
        { mint, symbol, router: rt.buy.router, errorCode: built?.errorCode ?? null },
        'entry refused — route priced but no transaction could be constructed',
      );
      return;
    }
    log.info(
      { mint, symbol, instructions: built.instructionCount, setup: built.hasSetup, cleanup: built.hasCleanup },
      'entry buildability established',
    );
  }

  const fixedCosts = config.assumedPriorityFeeLamports + config.assumedAtaRentLamports;
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

  const fill: Fill = {
    fillId: randomUUID(),
    intentId: result.outcome.snapshotId,
    mint,
    side: 'buy',
    actualInAmount: lamportsIn,
    actualOutAmount: tokensReceived,
    feeLamports: (lamportsIn * feeBps) / 10_000n,
    priorityFeeLamports: config.assumedPriorityFeeLamports,
    rentLamports: config.assumedAtaRentLamports,
    signature: null,
    slot: null,
    simulated: true,
    utcMs: Date.now(),
  };
  insertFill(db, fill);

  ledger.freeLamports -= costLamports;

  log.info(
    {
      positionId,
      mint,
      symbol,
      inSol: formatAmount(lamportsIn, 9),
      costSol: formatAmount(costLamports, 9),
      score: result.outcome.opportunityScore,
      roundTripLossBps: rt.roundTripLossBps,
      modelledFeeBps: Number(feeBps),
    },
    'PAPER ENTRY (simulated fill, real quote)',
  );
}

/** Marks every open position with a live sell quote and applies the exit rules. */
async function manageOpenPositions(
  db: Db,
  jupiter: JupiterClient,
  config: AppConfig,
  ledger: Ledger,
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
    });

    if (res.providerFailure) {
      // An outage is not a signal about the position. Do not act on it, but do
      // record it: repeated failures are themselves a reason to stop trading.
      recordSourceHealth(db, res.providerFailure.source, false, null, res.providerFailure.kind);
      log.warn({ mint: row.mint, kind: res.providerFailure.kind }, 'mark failed — provider outage, holding');
      continue;
    }

    const sell = res.quote;
    if (sell) insertQuote(db, row.mint, 'sell', sell);

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

    // Every mark is persisted, whether or not it causes an exit. A rule can
    // only be evaluated against the observations that were available to it,
    // and marks that are not written are observations that never existed.
    const prev = latestMark(db, row.position_id);
    const markId = randomUUID();
    insertPositionMark(db, {
      markId,
      positionId: row.position_id,
      mint: row.mint,
      seq: prev === null ? 0 : prev.seq + 1,
      observedUtcMs: nowMs,
      rawPriceImpactPct: sell ? sell.priceImpactPct : null,
      rawPriceImpactBpsSigned: sell ? Math.round(sell.priceImpactPct * 10_000) : null,
      quotedExitInputTokenAmount: tokenAmount,
      quotedExitOutputLamports: grossProceeds,
      quotedExitThresholdLamports: sell ? sell.otherAmountThreshold : null,
      positionEntryCostLamports: costLamports,
      positionMarkedValueLamports: markLamports,
      exitValueRatio:
        grossProceeds === null || costLamports <= 0n
          ? null
          : Number(grossProceeds) / Number(costLamports),
      outputChangeFromPreviousMarkBps:
        prev === null || prev.outLamports === null || prev.outLamports === 0n || grossProceeds === null
          ? null
          : Number(((grossProceeds - prev.outLamports) * 10_000n) / prev.outLamports),
      routeAvailable,
      routeLabels: sell ? sell.routeLabels.join('>') : null,
      platformFeeBps: sell ? sell.platformFeeBps : null,
      platformFeeAmount:
        sell && grossProceeds !== null ? (grossProceeds * BigInt(sell.platformFeeBps)) / 10_000n : null,
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
      slot: null,
      source: 'jupiter',
      backfilled: false,
    });

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
      // Wanted out, cannot get out. This is a real terminal state and must be
      // recorded as such rather than quietly retried forever.
      updatePosition(db, row.position_id, { state: 'EXIT_BLOCKED', exitReason: decision.reason });
      recordHealth(db, 'exit_blocked', 'critical', `${row.mint} ${decision.detail}`);
      log.error({ mint: row.mint, reason: decision.reason }, 'EXIT BLOCKED — no sell route');
      continue;
    }

    const proceeds = markLamports;
    const realized = proceeds - costLamports;

    // Classified from executable value, independently of which rule fired.
    // `decision.reason` is kept beside it rather than replaced by it.
    const verdict = classifyExit({
      quotedExitOutputLamports: grossProceeds,
      positionEntryCostLamports: costLamports,
      routeAvailable,
      triggerRule: decision.reason as TriggerRule,
    });

    insertFill(db, {
      fillId: randomUUID(),
      intentId: row.position_id,
      mint: row.mint,
      side: 'sell',
      actualInAmount: tokenAmount,
      // Gross, and therefore never negative. The priority fee lives in its own
      // column; folding it into the output produced a fill claiming the swap
      // returned less SOL than it did.
      actualOutAmount: grossProceeds,
      feeLamports: (grossProceeds * BigInt(sell.platformFeeBps)) / 10_000n,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
      rentLamports: 0n,
      signature: null,
      slot: null,
      simulated: true,
      utcMs: nowMs,
    });

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
      entryNotionalLamports: null,
      entryFixedCostsLamports: null,
      ataRentLamports: config.assumedAtaRentLamports,
      // Paper has never modelled the ATA-rent refund. Unknown, not false.
      ataRentRefunded: null,
      finalMarkId: markId,
      marksObserved,
      openedUtcMs: row.opened_utc_ms,
      closedUtcMs: nowMs,
      heldMs: nowMs - row.opened_utc_ms,
      strategyVersion: config.strategyVersion,
      accountingVersion: ACCOUNTING_VERSION,
      backfilled: false,
    });

    updatePosition(db, row.position_id, {
      state: 'POSITION_CLOSED',
      realizedLamports: realized,
      closedUtcMs: nowMs,
      exitReason: decision.reason,
      tokenAmount: 0n,
    });

    ledger.freeLamports += proceeds;
    ledger.navLamports += realized;
    ledger.realizedTodayLamports += realized;
    if (ledger.navLamports > ledger.peakNavLamports) ledger.peakNavLamports = ledger.navLamports;
    exited += 1;

    log.info(
      {
        positionId: row.position_id,
        mint: row.mint,
        reason: decision.reason,
        detail: decision.detail,
        costSol: formatAmount(costLamports, 9),
        proceedsSol: formatAmount(proceeds, 9),
        pnlSol: formatAmount(realized, 9),
        heldSec: Math.round((Date.now() - row.opened_utc_ms) / 1000),
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
