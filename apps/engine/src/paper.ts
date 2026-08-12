import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  loadSecrets,
  signerAllowed,
  killSwitchEngaged,
  modeFromArgv,
} from '../../../packages/domain/src/config.js';
import type { AppConfig } from '../../../packages/domain/src/config.js';
import { LAMPORTS_PER_SOL, WSOL_MINT } from '../../../packages/domain/src/types.js';
import type { Fill, Position } from '../../../packages/domain/src/types.js';
import { openDb, ProcessLock } from '../../../packages/storage/src/db.js';
import type { Db } from '../../../packages/storage/src/db.js';
import {
  counters,
  insertFill,
  insertPosition,
  insertQuote,
  openPositions,
  recordHealth,
  recordSourceHealth,
  updatePosition,
} from '../../../packages/storage/src/repo.js';
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

/**
 * Paper mode.
 *
 * Runs the identical screening pipeline as observe, then maintains simulated
 * positions against REAL executable quotes. Nothing here is signed or sent:
 * quotes are requested without `taker`, so no signable transaction can even be
 * returned to this process.
 *
 * Fill honesty rules, applied without exception:
 *  - a simulated fill uses the quote's `otherAmountThreshold` (the worst amount
 *    the router guarantees at that slippage), never the optimistic `outAmount`;
 *  - priority fee and ATA rent are charged on entry even though no transaction
 *    was sent, because a live entry would pay them;
 *  - the modelled new-token fee is the DOCUMENTED 50 bps, not the 10 bps we
 *    measured, so paper results cannot be flattered by an unexplained discount.
 *
 * A paper P&L that would not survive being wrong about those three things is
 * not evidence of anything.
 */

const log = logger.child({ app: 'paper' });

interface Ledger {
  navLamports: bigint;
  freeLamports: bigint;
  realizedTodayLamports: bigint;
  dayStartUtcMs: number;
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

  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });
  const rpc = new SolanaRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback });

  const ledger = restoreLedger(db, config);
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

  while (!stop) {
    const started = Date.now();
    cycle += 1;
    let stats = emptyStats();

    // Checked every cycle, before any work. A switch consulted only at startup
    // cannot stop a process that is already running, which is the only case
    // anyone reaches for it in.
    const killed = killSwitchEngaged();
    if (killed !== null) {
      recordHealth(db, 'kill_switch', 'critical', `KILL file at ${killed}`);
      log.error({ path: killed }, 'KILL file present — stopping');
      break;
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
          await tryEnter(db, config, ledger, info.id, sanitizeExternal(info.symbol ?? '', 16), result);
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

    lock.heartbeat();
    const open = openPositions(db);
    const exposure = open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n);
    const c = counters(db);

    log.info(
      {
        cycle,
        ...stats,
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

    await sleep(Math.max(1_000, config.discoveryIntervalMs - (Date.now() - started)), () => stop);
  }

  lock.release();
  db.close();
  log.info('paper mode stopped cleanly');
}

/**
 * Reconstructs NAV from persisted positions and fills so a restart does not
 * silently reset the experiment to a fresh, flattering starting balance.
 */
function restoreLedger(db: Db, config: AppConfig): Ledger {
  const realized = db.prepare('SELECT COALESCE(SUM(CAST(realized_lamports AS INTEGER)),0) AS r FROM positions').get() as {
    r: number;
  };
  const open = openPositions(db);
  const exposure = open.reduce((a, p) => a + BigInt(p.cost_lamports), 0n);
  const nav = config.paperStartLamports + BigInt(realized.r);
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);
  const realizedToday = db
    .prepare('SELECT COALESCE(SUM(CAST(realized_lamports AS INTEGER)),0) AS r FROM positions WHERE closed_utc_ms >= ?')
    .get(dayStart) as { r: number };
  return {
    navLamports: nav,
    freeLamports: nav - exposure,
    realizedTodayLamports: BigInt(realizedToday.r),
    dayStartUtcMs: dayStart,
  };
}

async function tryEnter(
  db: Db,
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

    const markLamports = sell ? sell.otherAmountThreshold - config.assumedPriorityFeeLamports : null;
    const peak = BigInt(row.peak_value_lamports ?? row.cost_lamports);
    const newPeak = markLamports !== null && markLamports > peak ? markLamports : peak;
    if (newPeak !== peak) updatePosition(db, row.position_id, { peakValueLamports: newPeak });

    const decision = decideExit(
      {
        costLamports,
        peakValueLamports: newPeak,
        markLamports,
        openedUtcMs: row.opened_utc_ms,
        nowUtcMs: Date.now(),
        exitRouteExists: sell !== null && sell.outAmount > 0n,
        exitPriceImpactBps: sell ? Math.round(Math.abs(sell.priceImpactPct) * 10_000) : null,
      },
      config.exits,
    );

    if (!decision.exit) continue;

    if (!sell || markLamports === null) {
      // Wanted out, cannot get out. This is a real terminal state and must be
      // recorded as such rather than quietly retried forever.
      updatePosition(db, row.position_id, { state: 'EXIT_BLOCKED', exitReason: decision.reason });
      recordHealth(db, 'exit_blocked', 'critical', `${row.mint} ${decision.detail}`);
      log.error({ mint: row.mint, reason: decision.reason }, 'EXIT BLOCKED — no sell route');
      continue;
    }

    const proceeds = markLamports;
    const realized = proceeds - costLamports;

    insertFill(db, {
      fillId: randomUUID(),
      intentId: row.position_id,
      mint: row.mint,
      side: 'sell',
      actualInAmount: tokenAmount,
      actualOutAmount: proceeds,
      feeLamports: (proceeds * BigInt(sell.platformFeeBps)) / 10_000n,
      priorityFeeLamports: config.assumedPriorityFeeLamports,
      rentLamports: 0n,
      signature: null,
      slot: null,
      simulated: true,
      utcMs: Date.now(),
    });

    updatePosition(db, row.position_id, {
      state: 'POSITION_CLOSED',
      realizedLamports: realized,
      closedUtcMs: Date.now(),
      exitReason: decision.reason,
      tokenAmount: 0n,
    });

    ledger.freeLamports += proceeds;
    ledger.navLamports += realized;
    ledger.realizedTodayLamports += realized;
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
