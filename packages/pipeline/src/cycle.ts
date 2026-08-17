import type { AppConfig } from '../../domain/src/config.js';
import type { Candidate, LaunchpadName, RoundTrip } from '../../domain/src/types.js';
import { WSOL_MINT } from '../../domain/src/types.js';
import { COHORT_BOUNDS } from '../../domain/src/cohort.js';
import { allocate } from '../../strategy/src/exploration.js';
import {
  readMintFacts,
  gateFactsFrom,
  MintFactsCache,
  type DirectMintFacts,
} from '../../intelligence/src/mintfacts-source.js';
import { disagreements } from '../../intelligence/src/mintfacts.js';
import { buildEntityLinks, entityConcentrationFrom } from '../../intelligence/src/entity-links.js';
import { mayhemFactsOf, breadthUsability } from '../../solana/src/mayhem.js';
import { canonicalPool, poolAddressesFrom, accountSourceOf } from '../../solana/src/pumpswap-offline.js';

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
import { declarePanel, admitSample } from '../../storage/src/prospective-repo.js';
import { REJECT_PANEL_V1 } from '../../domain/src/reject-panel.js';
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
  /** Finding G — fractional exploration entitlement carried to the next cycle. */
  explorationDebt?: number;
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
  /**
   * The current epoch, when it is known.
   *
   * A Token-2022 transfer-fee config carries an older and a newer schedule and
   * the epoch selects between them. Absent, the WORST of the two is used: an
   * unknown epoch means either could be live, and only one direction of that
   * error is safe.
   */
  readonly currentEpoch?: bigint | null;
}

/**
 * Process-lifetime, bounded, TTL'd.
 *
 * A cycle-scoped cache would miss on every candidate every ten seconds,
 * which is the same as no cache with extra allocation.
 */
const mintFactsCache = new MintFactsCache();

export async function runCycle(deps: CycleDeps): Promise<CycleStats> {
  const { db, jupiter, config, seen, cycleIndex } = deps;
  const stats = emptyStats();

  /**
   * `reject:panel-v2` — freeze the rule before the cycle admits anything.
   *
   * Idempotent: the definition is a literal at a fixed commit, so every run
   * declares the same thing and `declarePanel` returns without writing.
   * Declaring here rather than in a migration keeps the rule in source, where a
   * change to it shows up in a diff, instead of in a schema step that ran once
   * on a machine nobody still has.
   */
  try {
    declarePanel(db, {
      panelId: REJECT_PANEL_V1.panelId,
      declaredUtcMs: REJECT_PANEL_V1.declaredUtcMs,
      horizonsMs: [...REJECT_PANEL_V1.horizonsMs],
      metric: REJECT_PANEL_V1.metric,
      sourceCommit: 'frozen-in-source',
      notes: REJECT_PANEL_V1.notes,
    });
  } catch {
    // A missing table is a migration problem. A PanelViolation here means the
    // frozen rule was edited in place, which `pnpm reject:panel-v2` reports.
  }

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
  const cohortOf = new Map(cohortRows.map((r) => [r.mint, r.cohort] as const));
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
     * P11 — read the MINT, in EVERY mode.
     *
     * This used to be gated on `capitalAtRisk(mode)` with the reasoning that
     * observe and paper risk nothing. They risk nothing and they produce the
     * entire research corpus, so the effect was that no row anywhere records
     * how often a candidate carries a freeze authority, a transfer hook or a
     * permanent delegate — and the gate that would refuse one in a capital mode
     * had therefore never fired, on any token, ever. Its false-positive rate,
     * its cost in missed winners and its actual protective value were all
     * unmeasured, and the first run with money on it would have been the first
     * run at all.
     *
     * The mode still decides what a hostile fact DOES. It no longer decides
     * whether the fact is looked at.
     */
    const direct = await directMintFactsFor(deps, info, nowUtcMs);
    const t22 = direct === null ? null : gateFactsFrom(direct);
    if (direct !== null) persistMintFacts(deps, info, direct);
    /**
     * P9 — screen under THIS candidate's cohort window.
     *
     * The global 2m-60m bound was applied to every cohort, so a token that
     * matured into AGE_1H_5H was vetoed `too_old` by a window describing a
     * different arm. Three of four arms could not produce a screening.
     */
    const cohort = cohortOf.get(info.id) ?? null;
    const bounds =
      cohort === null ? null : ((COHORT_BOUNDS as Record<string, { fromMs: number; toMs: number }>)[cohort] ?? null);
    const { gates, deservesQuote } = screenCheap(info, config, nowUtcMs, sourceAgeMs, null, t22, bounds);
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
  /**
   * P10 — a ROLLING allocation.
   *
   * `floor(maxQuotesPerCycle * 0.25)` is 0 whenever the budget is under four,
   * and the configured budget is 2. The stated 25% exploration arm therefore
   * never ran a single quote — the fraction was real, the floor ate it, and
   * nothing said so.
   *
   * The debt carries across cycles instead: every cycle adds its fractional
   * entitlement, and a whole slot is spent when one has accumulated. Over many
   * cycles the realised share converges on the target from below, which is the
   * honest direction.
   */
  /**
   * Finding G — the entitlement is read from the corpus, not recomputed.
   *
   * `allocate()` has always accepted a carried remainder and returned the next
   * one. Nothing read or stored it, so every cycle started from zero and
   * `floor(2 * 0.25) = 0` meant the exploration arm never ran. Four cycles of
   * two quotes now spend one exploration slot between them, which is the 25%
   * the design claims.
   */
  const debtKey = deps.config.strategyVersion;
  const carriedDebt = (() => {
    try {
      const r = deps.db
        .prepare('SELECT debt FROM exploration_debt WHERE strategy_version = ? AND stratum = ?')
        .get(debtKey, 'ALL') as { debt: number } | undefined;
      return r?.debt ?? 0;
    } catch {
      return 0;
    }
  })();

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
    carriedDebt,
  );
  stats.explored = allocation.filter((a) => a.arm === 'explore').length;

  // Store the remainder back. A debt that is not persisted is not a debt.
  try {
    const nextDebt = (allocation as { nextDebt?: number }).nextDebt ?? 0;
    deps.db
      .prepare(
        `INSERT INTO exploration_debt (strategy_version, stratum, debt, updated_utc_ms)
         VALUES (?,?,?,?)
         ON CONFLICT(strategy_version, stratum) DO UPDATE SET
           debt = excluded.debt, updated_utc_ms = excluded.updated_utc_ms`,
      )
      .run(debtKey, 'ALL', nextDebt, Date.now());
    stats.explorationDebt = nextDebt;
  } catch {
    // A missing table is a migration problem, not a reason to lose the cycle.
  }

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
    await measureEntities(deps, mint, facts);
    await measureMayhem(deps, mint);
    return facts;
  } catch (e) {
    recordSourceHealth(deps.db, 'solana.rpc.concentration', false, null, (e as Error).message);
    stats.concentrationUnavailable += 1;
    log.warn({ mint, err: (e as Error).message }, 'concentration unavailable');
    return null;
  }
}

/**
 * P11 — Mayhem, recorded where it can be established and refused where it cannot.
 *
 * I first recorded this requirement as having no verifiable source. That was
 * wrong: `isMayhemMode` is a decoded field on the PumpSwap pool account, in the
 * same IDL already used to price every swap. What genuinely is not available is
 * the Mayhem program's own account layout, so agent inventory, buys, sells and
 * the burn transition stay null with the reason attached rather than being read
 * out of guessed offsets.
 */
async function measureMayhem(deps: CycleDeps, mint: string): Promise<void> {
  const rpc = deps.rpc;
  if (rpc === undefined || rpc === null) return;
  try {
    const poolKey = canonicalPool(mint);
    let isMayhem: boolean | null = null;
    try {
      const raw = await rpc.getAccountRaw(poolKey);
      isMayhem = poolAddressesFrom(
        accountSourceOf([
          { pubkey: poolKey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports },
        ]),
        poolKey,
      ).isMayhemMode;
    } catch {
      // No canonical pool: nothing has been shown about this mint's Mayhem
      // mode, which is null and not false.
      isMayhem = null;
    }

    const f = mayhemFactsOf({ mint, nowUtcMs: Date.now(), poolIsMayhemMode: isMayhem });
    const breadth = breadthUsability(f);
    deps.db
      .prepare(
        `INSERT INTO mayhem_facts
           (mint, observed_utc_ms, enabled, agent_identity, agent_state, agent_inventory_atoms,
            agent_buy_count, agent_sell_count, agent_buy_lamports, agent_sell_lamports,
            additional_supply_atoms, burn_transition, hours_since_launch, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           observed_utc_ms = excluded.observed_utc_ms,
           enabled = excluded.enabled,
           agent_state = excluded.agent_state,
           source = excluded.source`,
      )
      .run(
        mint,
        f.observedUtcMs,
        f.enabled === null ? null : f.enabled ? 1 : 0,
        null,
        `${breadth.usability}: ${breadth.reason}`.slice(0, 400),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        f.source,
      );
  } catch (e) {
    log.warn({ mint, err: (e as Error).message }, 'mayhem facts unavailable');
  }
}

/**
 * P11 — entity-adjusted concentration, from links actually built.
 *
 * `intelligence/entity.ts` has had union-find clustering and an
 * entity-vs-address comparison since it was written, and NOTHING built a link.
 * `cluster()` was therefore always called with an empty list, every holder was
 * its own entity, and the entity figure was the address figure under another
 * name. The gap between the two is the whole point — a token whose top ten
 * addresses hold 18% and whose top ten entities hold 71% is not a decentralised
 * token that happens to be clustered.
 *
 * Runs only where concentration already ran, which is the quote stage, so it
 * costs the budget on candidates that survived screening rather than on every
 * discovered mint. A holder whose history could not be read is recorded as
 * UNKNOWN history, and `concentration()` uses that to decide whether the entity
 * figure may be trusted at all.
 */
async function measureEntities(deps: CycleDeps, mint: string, facts: ConcentrationFacts): Promise<void> {
  const rpc = deps.rpc;
  if (rpc === undefined || rpc === null) return;
  // Cluster on the OWNER; read history from the TOKEN ACCOUNT, whose first
  // transaction is its creation and whose fee payer is the funder.
  const holders = facts.holders
    .filter((h) => h.owner !== null && !h.programControlled)
    .map((h) => ({ address: h.owner as string, amount: h.amount, historyAddress: h.tokenAccount }));
  if (holders.length < 2) return;

  try {
    const built = await buildEntityLinks(
      {
        oldestSignatures: async (address, limit) => {
          const sigs = await rpc.getSignaturesForAddress(address, 200);
          // The RPC returns newest first. The FIRST transaction is the funding
          // one, so the oldest page entry is the one that matters.
          return sigs.slice(-limit);
        },
        feePayerOf: (signature) => rpc.getTransactionFeePayer(signature),
      },
      holders,
      { maxHolders: 20 },
    );
    const reading = entityConcentrationFrom(built);
    deps.db
      .prepare(
        `INSERT INTO entity_concentration
           (mint, measured_utc_ms, address_count, entity_count, unknown_history_count, trustworthy,
            top_entity_1_bps, top_entity_5_bps, top_entity_10_bps, top_entity_20_bps,
            top_address_1_bps, top_address_5_bps, top_address_10_bps, top_address_20_bps,
            links_built, detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           measured_utc_ms = excluded.measured_utc_ms,
           address_count = excluded.address_count,
           entity_count = excluded.entity_count,
           unknown_history_count = excluded.unknown_history_count,
           trustworthy = excluded.trustworthy,
           top_entity_1_bps = excluded.top_entity_1_bps,
           top_entity_5_bps = excluded.top_entity_5_bps,
           top_entity_10_bps = excluded.top_entity_10_bps,
           top_entity_20_bps = excluded.top_entity_20_bps,
           top_address_1_bps = excluded.top_address_1_bps,
           top_address_5_bps = excluded.top_address_5_bps,
           top_address_10_bps = excluded.top_address_10_bps,
           top_address_20_bps = excluded.top_address_20_bps,
           links_built = excluded.links_built,
           detail = excluded.detail`,
      )
      .run(
        mint,
        Date.now(),
        reading.addressCount,
        reading.entityCount,
        reading.unknownHistoryCount,
        reading.trustworthy ? 1 : 0,
        reading.topEntityBps[1],
        reading.topEntityBps[5],
        reading.topEntityBps[10],
        reading.topEntityBps[20],
        reading.topAddressBps[1],
        reading.topAddressBps[5],
        reading.topAddressBps[10],
        reading.topAddressBps[20],
        built.links.length,
        [reading.detail, ...built.notes].join(' | ').slice(0, 500),
      );
  } catch (e) {
    // Entity measurement is enrichment. Losing it must never lose the
    // screening row, because a filter whose rejects are not stored can never
    // be evaluated.
    log.warn({ mint, err: (e as Error).message }, 'entity concentration unavailable');
  }
}

/**
 * The mint's own bytes, graded.
 *
 * Null only when there is no RPC to read with. Everything else — an unreadable
 * account, an undecodable one, an extension newer than this build — comes back
 * as facts whose verdict is UNKNOWN, because those are three different reasons
 * to distrust a token and none of them is "it is fine".
 *
 * Legacy mints are read too. Mint authority and freeze authority live on a
 * plain SPL mint as much as on a Token-2022 one, and the gates were taking the
 * provider's word for both.
 */
async function directMintFactsFor(
  deps: CycleDeps,
  info: MintInformation,
  nowUtcMs: number,
): Promise<DirectMintFacts | null> {
  if (deps.rpc === undefined || deps.rpc === null) return null;
  return readMintFacts(deps.rpc, info.id, {
    nowUtcMs,
    currentEpoch: deps.currentEpoch ?? null,
    cache: mintFactsCache,
  });
}

/**
 * One row per mint, replaced on a re-read.
 *
 * Failure here never costs the screening: a mint-facts write that throws would
 * drop a candidate, and a filter whose rejects are not stored can never be
 * evaluated.
 */
function persistMintFacts(deps: CycleDeps, info: MintInformation, f: DirectMintFacts): void {
  try {
    const disagree = disagreements(f, info.audit ?? null);
    deps.db
      .prepare(
        `INSERT INTO direct_mint_facts (
           mint, read_utc_ms, token_program, mint_authority, freeze_authority,
           permanent_delegate, default_account_state, transfer_hook, non_transferable,
           pausable, confidential, overall, current_epoch_fee_bps, worst_case_fee_bps,
           maximum_fee_atoms, extension_types, has_unknown_extension, decode_failure,
           reasons, provider_disagreements)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           read_utc_ms = excluded.read_utc_ms,
           token_program = excluded.token_program,
           mint_authority = excluded.mint_authority,
           freeze_authority = excluded.freeze_authority,
           permanent_delegate = excluded.permanent_delegate,
           default_account_state = excluded.default_account_state,
           transfer_hook = excluded.transfer_hook,
           non_transferable = excluded.non_transferable,
           pausable = excluded.pausable,
           confidential = excluded.confidential,
           overall = excluded.overall,
           current_epoch_fee_bps = excluded.current_epoch_fee_bps,
           worst_case_fee_bps = excluded.worst_case_fee_bps,
           maximum_fee_atoms = excluded.maximum_fee_atoms,
           extension_types = excluded.extension_types,
           has_unknown_extension = excluded.has_unknown_extension,
           decode_failure = excluded.decode_failure,
           reasons = excluded.reasons,
           provider_disagreements = excluded.provider_disagreements`,
      )
      .run(
        f.mint,
        f.readUtcMs,
        f.tokenProgram,
        f.mintAuthority,
        f.freezeAuthority,
        f.permanentDelegate,
        f.defaultAccountState,
        f.transferHook,
        f.nonTransferable,
        f.pausable,
        f.confidential,
        f.overall,
        f.currentEpochTransferFeeBps,
        f.worstCaseTransferFeeBps,
        f.maximumFeeAtoms === null ? null : f.maximumFeeAtoms.toString(),
        f.extensionTypes.join(','),
        f.hasUnknownExtension ? 1 : 0,
        f.decodeFailure,
        f.reasons.join('; ').slice(0, 400),
        disagree.length === 0 ? null : JSON.stringify(disagree),
      );
  } catch {
    // A missing table is a migration problem, not a reason to lose the row.
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

    /**
     * `reject:panel-v2` — the PROSPECTIVE sample, admitted here and nowhere else.
     *
     * `reject_tracking` above records THAT this token was rejected. It does not
     * record the STATE the rejection was made on, and a panel scored from state
     * fetched later is a different experiment: the pool has traded, the
     * reserves have moved, and the thing being scored is no longer the thing
     * the filter saw.
     *
     * The snapshot id is the whole point — it is the state, by reference, at
     * the instant the decision was made. Admitting anywhere other than inside
     * this branch would break that: a row added by a later pass would carry a
     * snapshot the rejection did not happen on.
     *
     * Every gate verdict is stored, not just the one that fired first. A
     * filter's cost cannot be attributed when only the winning reason was kept.
     */
    try {
      admitSample(deps.db, {
        sampleId: `${result.snapshot.snapshotId}:${info.id}`,
        panelId: REJECT_PANEL_V1.panelId,
        mint: info.id,
        snapshotId: result.snapshot.snapshotId,
        rejectedUtcMs: nowUtcMs,
        primaryReason: primaryReason(result.outcome.gates),
        gateVerdicts: result.outcome.gates.map((g) => ({
          gate: g.gate,
          passed: g.passed,
          severity: g.severity,
          reason: g.reason,
          riskContribution: g.riskContribution,
        })),
        inclusionProbability: selection?.inclusionProbability ?? null,
        stratum: selection?.stratum ?? null,
        routeExists: roundTrip === null ? null : roundTrip.exitExists,
      });
    } catch {
      // A missing table is a migration problem, and a panel violation is a
      // rule problem. Neither is a reason to lose the screening row that was
      // already written above.
    }
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
