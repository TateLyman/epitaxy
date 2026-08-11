import { loadConfig, loadSecrets, signerAllowed } from '../../../packages/domain/src/config.js';
import { WSOL_MINT } from '../../../packages/domain/src/types.js';
import type { Candidate, LaunchpadName, RoundTrip } from '../../../packages/domain/src/types.js';
import { openDb, ProcessLock } from '../../../packages/storage/src/db.js';
import {
  candidateExists,
  counters,
  insertCandidate,
  insertQuote,
  insertScreening,
  insertSnapshot,
  recordHealth,
  recordRejectObservation,
  maturingMints,
  recordSourceHealth,
  rejectionBreakdown,
} from '../../../packages/storage/src/repo.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { JupiterClient, measureRoundTrip } from '../../../packages/adapters/src/jupiter/client.js';
import type { MintInformation } from '../../../packages/adapters/src/jupiter/schemas.js';
import { SourceFetchError } from '../../../packages/adapters/src/http.js';
import { finalizeScreen, screenCheap, tokenAgeMs } from '../../../packages/strategy/src/screen.js';
import { primaryReason } from '../../../packages/strategy/src/score.js';
import { logger, sanitizeExternal } from '../../../packages/observability/src/log.js';
import { parseUtc } from '../../../packages/intelligence/src/gates.js';

/**
 * Observe mode.
 *
 * Discovers, screens, and RECORDS. It never opens a position, never constructs
 * a signer, and never calls a Jupiter endpoint that can return a signable
 * transaction (quotes are requested without `taker`).
 *
 * Its product is a dataset: every candidate, every gate decision, and — the
 * part that actually matters — every REJECT, so that later analysis can ask
 * whether each filter earned its place or merely felt prudent.
 */

const log = logger.child({ app: 'collector' });

interface CycleStats {
  discovered: number;
  newCandidates: number;
  screened: number;
  cheapPassed: number;
  quoted: number;
  eligible: number;
  providerFailures: number;
  maturing: number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();

  if (config.mode !== 'observe') {
    throw new Error(`collector runs only in observe mode; got "${config.mode}"`);
  }
  if (signerAllowed(config.mode)) {
    throw new Error('internal invariant violated: signer must never be permitted in observe mode');
  }

  const db = openDb({ path: secrets.databasePath });
  const lock = new ProcessLock(db, 'collector', config.mode);
  const held = lock.acquire();
  if (!held.ok) {
    throw new Error(
      `another collector holds the lock (pid=${held.heldBy}, heartbeat ${held.ageMs}ms ago). ` +
        `Two collectors would double-count discovery and waste the shared quote budget.`,
    );
  }

  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });

  log.info(
    {
      mode: config.mode,
      strategyVersion: config.strategyVersion,
      discoveryIntervalMs: config.discoveryIntervalMs,
      maxQuotesPerCycle: config.maxQuotesPerCycle,
      keyed: secrets.jupiterApiKey !== null,
      db: secrets.databasePath,
    },
    'observe mode starting',
  );

  let stop = false;
  const shutdown = (signal: string): void => {
    if (stop) return;
    stop = true;
    log.info({ signal }, 'shutdown requested');
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const seen = new Set<string>();
  let cycle = 0;

  while (!stop) {
    const started = Date.now();
    cycle += 1;
    let stats: CycleStats = {
      discovered: 0,
      newCandidates: 0,
      screened: 0,
      cheapPassed: 0,
      quoted: 0,
      eligible: 0,
      providerFailures: 0,
      maturing: 0,
    };

    try {
      stats = await runCycle(db, jupiter, config, seen, cycle);
    } catch (e) {
      const err = e as Error;
      if (e instanceof SourceFetchError) {
        recordSourceHealth(db, e.source, false, null, e.kind);
        log.warn({ source: e.source, kind: e.kind, msg: e.message }, 'discovery failed');
      } else {
        recordHealth(db, 'cycle_error', 'warn', err.message);
        log.error({ err: err.message }, 'cycle error');
      }
    }

    lock.heartbeat();

    const c = counters(db);
    log.info(
      {
        cycle,
        ...stats,
        totalCandidates: c.candidates,
        totalScreenings: c.screenings,
        totalEligible: c.eligible,
        totalQuotes: c.quotes,
        elapsedMs: Date.now() - started,
      },
      'cycle complete',
    );

    if (cycle % 10 === 0) printBreakdown(db);

    const wait = Math.max(1_000, config.discoveryIntervalMs - (Date.now() - started));
    await sleep(wait, () => stop);
  }

  printBreakdown(db);
  lock.release();
  db.close();
  log.info('observe mode stopped cleanly');
}

async function runCycle(
  db: ReturnType<typeof openDb>,
  jupiter: JupiterClient,
  config: ReturnType<typeof loadConfig>,
  seen: Set<string>,
  cycleIndex: number,
): Promise<CycleStats> {
  const stats: CycleStats = {
    discovered: 0,
    newCandidates: 0,
    screened: 0,
    cheapPassed: 0,
    quoted: 0,
    eligible: 0,
    providerFailures: 0,
    maturing: 0,
  };

  const { tokens, latencyMs, payloadHash } = await jupiter.recentTokens();
  recordSourceHealth(db, 'jupiter.tokens.recent', true, latencyMs, null);
  stats.discovered = tokens.length;

  const nowUtcMs = Date.now();
  const provenanceBase = {
    source: 'jupiter.tokens.recent',
    sourceType: 'official_indexer' as const,
    receivedMonotonicMs: Math.round(performance.now()),
    receivedUtcMs: nowUtcMs,
    slot: null,
    sourceUtcMs: null,
    schemaVersion: 'jup-2026-08-11',
    parserVersion: '1',
    payloadHash,
  };

  // Phase 1 — record every newly launched mint. These are almost always too
  // young to screen meaningfully; they are banked for the maturation queue.
  for (const info of tokens) {
    if (!seen.has(info.id) && !candidateExists(db, info.id)) {
      insertCandidate(db, toCandidate(info, nowUtcMs, provenanceBase));
      stats.newCandidates += 1;
    }
    seen.add(info.id);
  }

  // Phase 2a — ranked feeds. The recent feed is a biased sample: first-pool
  // launches only. Trending carries tokens that already survived their opening
  // minutes, which is exactly the population this strategy is defined over.
  // One feed per cycle keeps discovery breadth at 1 request, not 2.
  const ranked = cycleIndex % 2 === 0 ? 'toptrending' : 'toporganicscore';
  let rankedTokens: MintInformation[] = [];
  try {
    rankedTokens = await jupiter.category(ranked, '5m', 50);
    recordSourceHealth(db, `jupiter.tokens.${ranked}`, true, null, null);
    for (const info of rankedTokens) {
      if (!seen.has(info.id) && !candidateExists(db, info.id)) {
        insertCandidate(db, toCandidate(info, nowUtcMs, { ...provenanceBase, source: `jupiter.tokens.${ranked}` }));
        stats.newCandidates += 1;
      }
      seen.add(info.id);
    }
  } catch (e) {
    log.warn({ feed: ranked, err: (e as Error).message }, 'ranked feed failed');
  }

  // Phase 2b — re-fetch mints that have aged INTO the eligible window. One
  // request covers up to 100 mints, which is the cheapest enrichment available.
  const mature = maturingMints(db, nowUtcMs, config.gates.minTokenAgeMs, config.gates.maxTokenAgeMs, 100);
  stats.maturing = mature.length;

  // Ranked-feed entries already carry fresh stats, so re-fetching them would
  // spend a request on data already in hand.
  const rankedById = new Map(rankedTokens.map((t) => [t.id, t]));
  const needFetch = mature.filter((m) => !rankedById.has(m));
  const fetched = needFetch.length > 0 ? await jupiter.search(needFetch.slice(0, 100)) : [];
  if (needFetch.length > 0) recordSourceHealth(db, 'jupiter.tokens.search', true, null, null);

  const toScreen: MintInformation[] = [
    ...fetched,
    ...mature.flatMap((m) => {
      const hit = rankedById.get(m);
      return hit ? [hit] : [];
    }),
  ];

  const promoted: { info: MintInformation; gates: ReturnType<typeof screenCheap>['gates'] }[] = [];
  for (const info of toScreen) {
    const sourceAgeMs = nowUtcMs - (parseUtc(info.updatedAt) ?? nowUtcMs);
    const { gates, deservesQuote } = screenCheap(info, config, nowUtcMs, sourceAgeMs);
    if (deservesQuote) {
      stats.cheapPassed += 1;
      promoted.push({ info, gates });
    } else {
      // A cheap reject is still a full, persisted decision — that is the point.
      persist(db, config, info, gates, null, nowUtcMs, stats);
    }
  }

  // Phase 3 — spend the scarce quote budget on the best survivors only.
  // Ranking by liquidity is a cheap proxy; the true ranking needs the quote we
  // are trying to avoid spending, so this is deliberately a heuristic.
  promoted.sort((a, b) => (b.info.liquidity ?? 0) - (a.info.liquidity ?? 0));

  for (const { info, gates } of promoted.slice(0, config.maxQuotesPerCycle)) {
    let roundTrip: RoundTrip | null = null;
    try {
      const rt = await measureRoundTrip(
        jupiter,
        WSOL_MINT,
        info.id,
        config.quoteProbeLamports,
        config.gates.maxRoundTripLossBps > 0 ? Math.min(config.risk.maxSlippageBps, 300) : 300,
      );
      if (rt.providerFailure) {
        stats.providerFailures += 1;
        recordSourceHealth(db, rt.providerFailure.source, false, null, rt.providerFailure.kind);
        // A provider outage is NOT a token fact. Do not record a decision.
        continue;
      }
      stats.quoted += 1;
      recordSourceHealth(db, 'jupiter.swap.v2.order', true, rt.buy?.latencyMs ?? null, null);
      if (rt.buy) {
        insertQuote(db, info.id, 'buy', rt.buy);
        if (rt.sell) insertQuote(db, info.id, 'sell', rt.sell);
        roundTrip = {
          buy: rt.buy,
          sell: rt.sell,
          roundTripLossBps: rt.roundTripLossBps,
          exitExists: rt.sell !== null && rt.sell.outAmount > 0n,
        };
      }
    } catch (e) {
      stats.providerFailures += 1;
      log.warn({ mint: info.id, err: (e as Error).message }, 'round trip failed');
      continue;
    }

    persist(db, config, info, gates, roundTrip, Date.now(), stats);
  }

  // Anything promoted but not quoted this cycle is left undecided rather than
  // recorded as a rejection we did not actually make.
  return stats;
}

function persist(
  db: ReturnType<typeof openDb>,
  config: ReturnType<typeof loadConfig>,
  info: MintInformation,
  gates: ReturnType<typeof screenCheap>['gates'],
  roundTrip: RoundTrip | null,
  nowUtcMs: number,
  stats: CycleStats,
): void {
  const result = finalizeScreen(info, config, nowUtcMs, gates, roundTrip, null);
  insertSnapshot(db, result.snapshot);
  insertScreening(db, result.outcome);
  stats.screened += 1;

  if (result.outcome.eligible) {
    stats.eligible += 1;
    log.info(
      {
        mint: info.id,
        symbol: sanitizeExternal(info.symbol ?? '', 16),
        score: result.outcome.opportunityScore,
        softRisk: result.outcome.softRiskScore,
        roundTripLossBps: roundTrip?.roundTripLossBps ?? null,
        ageMs: tokenAgeMs(info, nowUtcMs),
        liquidityUsd: info.liquidity ?? null,
      },
      'ELIGIBLE (observe only — no position taken)',
    );
  } else {
    // Counterfactual tracking: record what the rejected token looked like at
    // reject time so a later pass can ask what we gave up.
    recordRejectObservation(db, info.id, nowUtcMs, primaryReason(result.outcome.gates), {
      priceUsd: info.usdPrice ?? null,
      liquidityUsd: info.liquidity ?? null,
      routeExists: roundTrip === null ? null : roundTrip.exitExists,
    });
  }
}

function toCandidate(
  info: MintInformation,
  nowUtcMs: number,
  provenance: Candidate['provenance'],
): Candidate {
  return {
    mint: info.id,
    // External strings are sanitized at the boundary. A token "name" is
    // attacker-controlled input, never a label we can trust.
    name: sanitizeExternal(info.name ?? '', 64),
    symbol: sanitizeExternal(info.symbol ?? '', 32),
    decimals: info.decimals,
    tokenProgram: info.tokenProgram ?? 'unknown',
    creator: info.dev ?? null,
    launchpad: normalizeLaunchpad(info.launchpad),
    firstSeenUtcMs: nowUtcMs,
    createdAtUtcMs: parseUtc(info.firstPool?.createdAt) ?? parseUtc(info.createdAt),
    provenance,
  };
}

const LAUNCHPADS: Record<string, LaunchpadName> = {
  'pump.fun': 'pump.fun',
  pumpfun: 'pump.fun',
  pumpswap: 'pumpswap',
  'raydium launchlab': 'raydium_launchlab',
  launchlab: 'raydium_launchlab',
  'meteora dbc': 'meteora_dbc',
  bags: 'bags',
  boop: 'boop',
  believe: 'believe',
  'jup studio': 'jup_studio',
};

/**
 * The provider's launchpad label is a free-form external string. It is mapped
 * onto a closed set rather than trusted, and anything unrecognised becomes
 * `unknown` — which the gates treat as less trustworthy, not as safe.
 */
function normalizeLaunchpad(raw: string | null | undefined): LaunchpadName {
  const key = sanitizeExternal(raw ?? '', 32).toLowerCase().trim();
  return LAUNCHPADS[key] ?? 'unknown';
}

function printBreakdown(db: ReturnType<typeof openDb>): void {
  const rows = rejectionBreakdown(db).slice(0, 12);
  if (rows.length === 0) return;
  const total = rows.reduce((a, r) => a + r.count, 0);
  log.info(
    { top: rows.map((r) => `${r.reason}=${r.count}`).join(' '), totalShown: total },
    'rejection breakdown',
  );
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

main().catch((e: Error) => {
  log.error({ err: e.message, stack: e.stack }, 'collector fatal');
  process.exitCode = 1;
});
