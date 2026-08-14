import type { AppConfig } from '../../domain/src/config.js';
import type { Candidate, LaunchpadName, RoundTrip } from '../../domain/src/types.js';
import { WSOL_MINT } from '../../domain/src/types.js';
import { COHORT_BOUNDS } from '../../domain/src/cohort.js';
import { allocate } from '../../strategy/src/exploration.js';
import { capitalAtRisk } from '../../domain/src/types.js';
import { TOKEN_2022_PROGRAM } from '../../solana/src/pda.js';
import { decodeToken2022Mint } from '../../solana/src/token2022.js';
import type { Token2022Facts } from '../../strategy/src/screen.js';

/** A stable 32-bit seed from a context hash, so a cycle's draw is replayable. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
import type { Db } from '../../storage/src/db.js';
import {
  candidateExists,
  insertCandidate,
  insertQuote,
  insertScreening,
  insertSnapshot,
  maturingByCohort,
  recordForwardObservation,
  recordRejectObservation,
  recordSourceHealth,
  rejectsNeedingFollowUp,
} from '../../storage/src/repo.js';
import { JupiterClient, measureRoundTrip } from '../../adapters/src/jupiter/client.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import { fetchConcentration } from '../../solana/src/rpc.js';
import type { ConcentrationFacts, SolanaRpc } from '../../solana/src/rpc.js';
import { finalizeScreen, screenCheap } from '../../strategy/src/screen.js';
import type { ScreenResult } from '../../strategy/src/screen.js';
import { primaryReason } from '../../strategy/src/score.js';
import { parseUtc } from '../../intelligence/src/gates.js';
import { logger, sanitizeExternal } from '../../observability/src/log.js';

/**
 * The discovery → screening cycle, shared by observe and paper.
 *
 * Both modes MUST run this exact code. If paper screened differently from
 * observe, the observe dataset would not describe the thing paper is doing,
 * and every conclusion drawn from it would be about a system that does not
 * exist. Modes differ only in what they do with an eligible candidate.
 */

const log = logger.child({ mod: 'cycle' });

export interface CycleStats {
  discovered: number;
  /** P17 — how many of this cycle's quotes went to the exploration arm. */
  explored?: number;
  /** P16 — how many candidates each age cohort actually matured this cycle. */
  maturingByCohort?: Readonly<Record<string, number>>;
  newCandidates: number;
  screened: number;
  cheapPassed: number;
  quoted: number;
  eligible: number;
  providerFailures: number;
  maturing: number;
  concentrationMeasured: number;
  concentrationUnavailable: number;
  followUpRequested: number;
  followUpObserved: number;
  followUpVanished: number;
}

export function emptyStats(): CycleStats {
  return {
    discovered: 0,
    newCandidates: 0,
    screened: 0,
    cheapPassed: 0,
    quoted: 0,
    eligible: 0,
    providerFailures: 0,
    maturing: 0,
    concentrationMeasured: 0,
    concentrationUnavailable: 0,
    followUpRequested: 0,
    followUpObserved: 0,
    followUpVanished: 0,
  };
}

export interface CycleDeps {
  readonly db: Db;
  readonly jupiter: JupiterClient;
  readonly config: AppConfig;
  readonly seen: Set<string>;
  readonly cycleIndex: number;
  /**
   * Called for each eligible candidate. Observe passes a logger; paper passes
   * entry logic. Returning is awaited so a mode can spend its own budget.
   */
  readonly onEligible: (info: MintInformation, result: ScreenResult) => Promise<void> | void;
  /** Mints to skip screening entirely, e.g. ones already held. */
  readonly skip?: ReadonlySet<string>;
  /**
   * Read-only chain access for the authoritative concentration measurement.
   * Absent means the check reports unavailable, which the gates grade as risk
   * in observe/paper and refuse outright once capital is at stake.
   */
  readonly rpc?: SolanaRpc | null;
}

export async function runCycle(deps: CycleDeps): Promise<CycleStats> {
  const { db, jupiter, config, seen, cycleIndex } = deps;
  const stats = emptyStats();

  const { tokens, latencyMs, payloadHash } = await jupiter.recentTokens();
  recordSourceHealth(db, 'jupiter.tokens.recent', true, latencyMs, null);
  stats.discovered = tokens.length;

  const nowUtcMs = Date.now();
  const provenanceBase: Candidate['provenance'] = {
    source: 'jupiter.tokens.recent',
    sourceType: 'official_indexer',
    receivedMonotonicMs: Math.round(performance.now()),
    receivedUtcMs: nowUtcMs,
    slot: null,
    sourceUtcMs: null,
    schemaVersion: 'jup-2026-08-11',
    parserVersion: '1',
    payloadHash,
  };

  // Phase 1 — bank every newly launched mint. Almost all are too young to
  // screen meaningfully; they exist to be picked up later by the queue.
  for (const info of tokens) {
    if (!seen.has(info.id) && !candidateExists(db, info.id)) {
      insertCandidate(db, toCandidate(info, nowUtcMs, provenanceBase));
      stats.newCandidates += 1;
    }
    seen.add(info.id);
  }

  // Phase 2a — ranked feeds. The recent feed is a biased sample: first-pool
  // launches only. Trending carries tokens that already survived their opening
  // minutes, which is the population this strategy is defined over. One feed
  // per cycle keeps discovery breadth at one request instead of two.
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

  // Phase 2b — mints that have aged INTO the eligible window. One request
  // covers up to 100 mints, the cheapest enrichment available.
  /**
   * P16 — all FOUR cohorts mature, each with its own quota.
   *
   * This drew one window from `config.gates`, so three of the four arms were
   * never populated. An experiment comparing a populated cohort against three
   * empty ones has one arm.
   */
  const cohortRows = maturingByCohort(db, nowUtcMs, COHORT_BOUNDS, 25).filter((r) => !deps.skip?.has(r.mint));
  const mature = cohortRows.map((r) => r.mint);
  stats.maturing = mature.length;
  stats.maturingByCohort = Object.fromEntries(
    [...new Set(cohortRows.map((r) => r.cohort))].map((c) => [c, cohortRows.filter((r) => r.cohort === c).length]),
  );

  // Ranked-feed entries already carry fresh stats; re-fetching them would spend
  // a request on data already in hand.
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

  // `sourceAgeMs` travels with the candidate rather than being recomputed at
  // persist time. Recomputing it against a later clock would store a freshness
  // the gates never saw, and replay would then diverge from a decision that was
  // correct when it was made.
  const promoted: {
    info: MintInformation;
    gates: ReturnType<typeof screenCheap>['gates'];
    sourceAgeMs: number | null;
  }[] = [];
  for (const info of toScreen) {
    // §7.6 -- a missing provider timestamp is UNKNOWN, not zero age. The
    // previous expression fell back to `nowUtcMs`, which made a token with no
    // `updatedAt` score as perfectly fresh: the most favourable possible value,
    // derived from the absence of information.
    const updatedAt = parseUtc(info.updatedAt);
    const sourceAgeMs = updatedAt === null ? null : nowUtcMs - updatedAt;
    /**
     * P14 — read the MINT, in modes where being wrong costs money.
     *
     * `evaluateCheapGates` has always read `token2022` and no caller ever
     * supplied it, so `token2022_money_critical` could not fire: a transfer
     * hook, a permanent delegate, a pausable mint and a default-frozen mint
     * all presented as silence.
     *
     * Only in capital modes, because it costs an RPC call per candidate and
     * observe/paper risk nothing. In those modes an unread Token-2022 mint is
     * refused by `screenCheap` rather than passed as unknown.
     */
    const t22 = await token2022FactsFor(deps, info);
    const { gates, deservesQuote } = screenCheap(info, config, nowUtcMs, sourceAgeMs, null, t22);
    if (deservesQuote) {
      stats.cheapPassed += 1;
      promoted.push({ info, gates, sourceAgeMs });
    } else {
      await persist(deps, info, gates, null, null, nowUtcMs, stats, sourceAgeMs);
    }
  }

  /**
   * Phase 3 — 75% to the best survivors, 25% to a stratified random draw.
   *
   * The whole budget used to go to the highest-liquidity survivors, which
   * produces a corpus that can only answer "how do high-liquidity survivors
   * perform". It cannot answer the question that decides whether the gates are
   * any good: what did we refuse that would have worked? A gate evaluated only
   * on the candidates it admitted is evaluated on its own output.
   *
   * The 25% is FROZEN before collection, and every row carries the probability
   * it had of being selected — a biased sample whose bias is unrecorded is
   * worse than no sample, because it looks like evidence.
   */
  const allocation = allocate(
    promoted.map((p) => ({
      item: p,
      // Stratified by cohort, so exploration does not collapse into whichever
      // age band happens to have the most candidates.
      stratum: cohortRows.find((r) => r.mint === p.info.id)?.cohort ?? 'UNKNOWN',
      rank: p.info.liquidity ?? 0,
    })),
    config.maxQuotesPerCycle,
    // Deterministic: the same corpus and code reproduce the same decisions, so
    // a replay divergence still means a defect rather than a coin flip.
    hashSeed(deps.config.strategyVersion) + Math.floor(nowUtcMs / 60_000),
  );
  stats.explored = allocation.filter((a) => a.arm === 'explore').length;

  for (const sel of allocation) {
    const { info, gates, sourceAgeMs } = sel.item;
    const roundTrip = await priceRoundTrip(deps, info, stats);
    if (roundTrip === 'provider_failure') continue;
    const concentration = await measureConcentration(deps, info.id, stats);
    await persist(deps, info, gates, roundTrip, concentration, Date.now(), stats, sourceAgeMs, {
      arm: sel.arm,
      inclusionProbability: sel.inclusionProbability,
      stratum: sel.stratum,
    });
  }

  // Phase 4 — forward observations on things we already refused. One batched
  // request buys up to 100 of them, which is the cheapest evidence available
  // about whether the gates are removing losers or just removing volume.
  await followUpRejects(deps, stats);

  // Anything promoted but not quoted this cycle is left undecided rather than
  // recorded as a rejection we did not actually make.
  return stats;
}

/** How long a rejected mint stays interesting, and how often it is re-checked. */
const FOLLOWUP = {
  lookbackMs: 24 * 3_600_000,
  minGapMs: 10 * 60_000,
  maxObservations: 6,
  batch: 100,
} as const;

/**
 * A mint the provider no longer returns is not missing data — it is the single
 * most common outcome in this population, and dropping those rows would leave a
 * panel made entirely of survivors. It is therefore recorded explicitly, with a
 * null price meaning "gone", so the backtest can count it rather than infer it.
 */
async function followUpRejects(deps: CycleDeps, stats: CycleStats): Promise<void> {
  const now = Date.now();
  const targets = rejectsNeedingFollowUp(deps.db, now, {
    lookbackMs: FOLLOWUP.lookbackMs,
    minGapMs: FOLLOWUP.minGapMs,
    maxObservations: FOLLOWUP.maxObservations,
    limit: FOLLOWUP.batch,
  });
  if (targets.length === 0) return;
  stats.followUpRequested = targets.length;

  let observed: MintInformation[];
  try {
    observed = await deps.jupiter.search(targets.map((t) => t.mint));
    recordSourceHealth(deps.db, 'jupiter.tokens.search.followup', true, null, null);
  } catch (e) {
    recordSourceHealth(deps.db, 'jupiter.tokens.search.followup', false, null, (e as Error).message);
    log.warn({ err: (e as Error).message }, 'follow-up observation failed');
    return;
  }

  const byMint = new Map(observed.map((o) => [o.id, o]));
  const at = Date.now();
  for (const t of targets) {
    const hit = byMint.get(t.mint);
    if (!hit) {
      stats.followUpVanished += 1;
      recordForwardObservation(deps.db, t, at, { priceUsd: null, liquidityUsd: null, routeExists: null });
      continue;
    }
    stats.followUpObserved += 1;
    recordForwardObservation(deps.db, t, at, {
      priceUsd: hit.usdPrice ?? null,
      liquidityUsd: hit.liquidity ?? null,
      // Route existence needs a quote we are not spending here; left null rather
      // than guessed from liquidity, which is a different claim.
      routeExists: null,
    });
  }
}

/** Returns null for "no route" (a token fact) and a sentinel for an outage. */
async function priceRoundTrip(
  deps: CycleDeps,
  info: MintInformation,
  stats: CycleStats,
): Promise<RoundTrip | null | 'provider_failure'> {
  const { db, jupiter, config } = deps;
  try {
    const rt = await measureRoundTrip(
      jupiter,
      WSOL_MINT,
      info.id,
      config.quoteProbeLamports,
      Math.min(config.risk.maxSlippageBps, 300),
    );
    if (rt.providerFailure) {
      stats.providerFailures += 1;
      recordSourceHealth(db, rt.providerFailure.source, false, null, rt.providerFailure.kind);
      return 'provider_failure';
    }
    stats.quoted += 1;
    recordSourceHealth(db, 'jupiter.swap.v2.order', true, rt.buy?.latencyMs ?? null, null);
    if (!rt.buy) return null;
    insertQuote(db, info.id, 'buy', rt.buy);
    if (rt.sell) insertQuote(db, info.id, 'sell', rt.sell);
    return {
      buy: rt.buy,
      sell: rt.sell,
      roundTripLossBps: rt.roundTripLossBps,
      exitExists: rt.sell !== null && rt.sell.outAmount > 0n,
    };
  } catch (e) {
    stats.providerFailures += 1;
    log.warn({ mint: info.id, err: (e as Error).message }, 'round trip failed');
    return 'provider_failure';
  }
}

/**
 * Never throws: an RPC outage is a fact about our visibility, not about the
 * token, so it degrades to "unavailable" and lets the gates decide what that
 * is worth in the current mode.
 */
async function measureConcentration(
  deps: CycleDeps,
  mint: string,
  stats: CycleStats,
): Promise<ConcentrationFacts | null> {
  if (!deps.rpc) {
    stats.concentrationUnavailable += 1;
    return null;
  }
  try {
    const facts = await fetchConcentration(deps.rpc, mint);
    recordSourceHealth(deps.db, 'solana.rpc.concentration', true, null, null);
    stats.concentrationMeasured += 1;
    return facts;
  } catch (e) {
    recordSourceHealth(deps.db, 'solana.rpc.concentration', false, null, (e as Error).message);
    stats.concentrationUnavailable += 1;
    log.warn({ mint, err: (e as Error).message }, 'concentration unavailable');
    return null;
  }
}

/**
 * The mint's Token-2022 behaviour, decoded from its own account bytes.
 *
 * Null when we did not read it — never a fabricated "no extensions". The
 * caller decides what null means, and in a capital mode it means refused.
 */
async function token2022FactsFor(
  deps: CycleDeps,
  info: MintInformation,
): Promise<Token2022Facts | null> {
  if (!capitalAtRisk(deps.config.mode)) return null;
  if (info.tokenProgram !== TOKEN_2022_PROGRAM) return null;
  if (deps.rpc === undefined || deps.rpc === null) return null;
  try {
    const raw = await deps.rpc.getAccountRaw(info.id);
    const facts = decodeToken2022Mint(Buffer.from(raw.dataBase64, 'base64'), raw.owner);
    return {
      hasMoneyCriticalBehaviour: facts.hasMoneyCriticalBehaviour,
      hasUnknownExtension: facts.hasUnknownExtension,
      transferFeeBps: facts.transferFeeBps,
      detail: facts.detail,
    };
  } catch {
    // Unreadable is UNKNOWN, and in a capital mode `screenCheap` refuses on
    // null. Returning EMPTY here would assert the mint is plain.
    return null;
  }
}

async function persist(
  deps: CycleDeps,
  info: MintInformation,
  gates: ReturnType<typeof screenCheap>['gates'],
  roundTrip: RoundTrip | null,
  concentration: ConcentrationFacts | null,
  nowUtcMs: number,
  stats: CycleStats,
  sourceAgeMs: number | null,
  /** P17 — how this row entered the sample. Absent for rows nobody quoted. */
  selection?: { arm: 'exploit' | 'explore'; inclusionProbability: number; stratum: string },
): Promise<void> {
  const result = finalizeScreen(info, deps.config, nowUtcMs, gates, roundTrip, null, concentration, sourceAgeMs);
  insertSnapshot(deps.db, result.snapshot);
  insertScreening(deps.db, result.outcome);
  if (selection !== undefined) {
    try {
      deps.db
        .prepare(
          `UPDATE screenings SET selection_arm = ?, inclusion_probability = ?, selection_stratum = ?
           WHERE mint = ? AND snapshot_id = ?`,
        )
        .run(selection.arm, selection.inclusionProbability, selection.stratum, info.id, result.snapshot.snapshotId);
    } catch {
      // A missing column is a migration problem, not a reason to lose the row.
    }
  }
  stats.screened += 1;

  if (result.outcome.eligible) {
    stats.eligible += 1;
    await deps.onEligible(info, result);
  } else {
    // Counterfactual tracking: record what the rejected token looked like at
    // reject time, so a later pass can ask what each filter actually cost.
    recordRejectObservation(deps.db, info.id, nowUtcMs, primaryReason(result.outcome.gates), {
      priceUsd: info.usdPrice ?? null,
      liquidityUsd: info.liquidity ?? null,
      routeExists: roundTrip === null ? null : roundTrip.exitExists,
    });
  }
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
 * onto a closed set rather than trusted; anything unrecognised becomes
 * `unknown`, which the gates treat as less informative, not as safe.
 */
export function normalizeLaunchpad(raw: string | null | undefined): LaunchpadName {
  const key = sanitizeExternal(raw ?? '', 32).toLowerCase().trim();
  return LAUNCHPADS[key] ?? 'unknown';
}

export function toCandidate(
  info: MintInformation,
  nowUtcMs: number,
  provenance: Candidate['provenance'],
): Candidate {
  return {
    mint: info.id,
    // A token name is attacker-controlled input, never a label we can trust.
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
