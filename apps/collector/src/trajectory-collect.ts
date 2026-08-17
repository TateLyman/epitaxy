import { loadSecrets, modeFromArgv } from '../../../packages/domain/src/config.js';
import { openDb } from '../../../packages/storage/src/db.js';
import {
  TrajectoryCollectorLock,
  CollectorLockRefused,
  DirtyEvidenceCollection,
  readTreeState,
  evidenceContextValidity,
} from '../../../packages/storage/src/collector-lock.js';
import {
  reserveCandidate,
  resolveReservation,
  abandonReservation,
  ReservationRefused,
} from '../../../packages/storage/src/reservation-repo.js';
import { EvidenceStore } from '../../../packages/storage/src/evidence-repo.js';
import {
  persistEvidence,
  linkTrajectoryEvidence,
  insertLegSettlement,
  pairLegAccounts,
} from '../../../packages/pipeline/src/persist-evidence.js';
import {
  MARK_SLA_MS,
  DEFAULT_MAX_TICK_MS,
  nextWakeMs,
  classifyMark,
  discoveryAdmissible,
} from '../../../packages/pipeline/src/mark-scheduler.js';
import { createHash } from 'node:crypto';
import {
  decideEntry,
  ENTRY_POLICIES,
  type PreEntryFeatures,
} from '../../../packages/strategy/src/treatments.js';
import { SETTLEMENT_VERSION, SDK_VERSIONS } from '../../../packages/pipeline/src/open-trajectory.js';
import { buildTrajectorySettlement, checkIdentities } from '../../../packages/domain/src/trajectory-settlement.js';
import { isPnlEligible, transferFeeOrUnknown } from '../../../packages/domain/src/settlement.js';
import { researchRpc } from '../../../packages/solana/src/endpoint.js';
import { isQuotaExhausted, EndpointRefusalBreaker } from '../../../packages/solana/src/rpc.js';
import { base58Encode } from '../../../packages/solana/src/base58.js';
import {
  enrichMigration,
  reconcileCommitment,
  findPoolCreation,
} from '../../../packages/solana/src/migration.js';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from '../../../packages/solana/src/pump.js';
import {
  canonicalPool,
  poolAddressesFrom,
  poolFactsFrom,
  accountSourceOf,
  AMM_PROGRAM_ID,
  GLOBAL_CONFIG_ADDR,
  FEE_CONFIG_ADDR,
  WSOL_MINT,
} from '../../../packages/solana/src/pumpswap-offline.js';
import { captureCoherentSnapshotV2, SnapshotIncoherent } from '../../../packages/solana/src/coherent-snapshot.js';
import { captureSnapshot } from '../../../packages/solana/src/snapshot-capture.js';
import { SequentialWorker } from '../../../packages/simulator/src/sequential-worker.js';
import { openTrajectory } from '../../../packages/pipeline/src/open-trajectory.js';
import { takeMark, evaluateExitPolicies, pathIsComplete, MARK_OFFSETS_MS } from '../../../packages/pipeline/src/mark-path.js';
import {
  openTrajectories,
  recordedOffsets,
  insertMark,
  marksFor,
  insertPolicyOutcome,
  closeTrajectory,
  markAndOutcomeCounts,
} from '../../../packages/storage/src/mark-repo.js';
import { mechanicsStratum } from '../../../packages/solana/src/cashback.js';
import { allocate, EXPLORATION_FRACTION } from '../../../packages/strategy/src/exploration.js';
import {
  grantExploration,
  consumeExploration,
  entitlements,
  explorationRealised,
} from '../../../packages/storage/src/exploration-repo.js';
import { swapAccountRoles } from '../../../packages/solana/src/pumpswap-offline.js';
import { decodeMint, type DecodedMint } from '../../../packages/solana/src/mint.js';
import { TOKEN_2022_PROGRAM } from '../../../packages/solana/src/pda.js';
import {
  collectCandidateRiskFacts,
  admitCandidate,
  assertCollectedBeforeDecision,
  type CandidateRiskFacts,
} from '../../../packages/intelligence/src/candidate-risk.js';
import { LiveMigrationLane, LiveVaultWatch } from './live-lane.js';
import { subscriptionFor } from '../../../packages/pipeline/src/vault-watch.js';
import {
  openCollectorSession,
  closeCollectorSession,
  heartbeat,
  countResource,
  recordLatency,
  pendingUrgent,
  consumeUrgent,
  type SessionHandle,
} from '../../../packages/storage/src/collector-telemetry.js';
import {
  insertConfirmedMigration,
  insertTrajectory,
  insertAccountPlan,
  accountPlanCount,
  insertCreatedAccounts,
  setupEconomicsTotals,
  insertLegCashback,
  cashbackLegTotals,
  insertCandidateRiskFacts,
  insertTrajectorySettlement,
  persistTrajectoryEconomics,
  settlementTotals,
  admissionTotals,
  samplingSpread,
  migrationCandidates,
  confirmedMigrationCounts,
  trajectoryCounts,
} from '../../../packages/storage/src/trajectory-repo.js';

/**
 * P8 — `pnpm trajectory:collect`.
 *
 * A development trajectory collector, NOT a fake portfolio.
 *
 * The paper engine's risk budget prevents opening positions, and that is
 * correct: it is enforcing a real portfolio constraint against real (simulated)
 * capital. Loosening it to manufacture positions would destroy the only thing
 * making the paper book informative.
 *
 * So this process does not own capital at all. It reads no NAV, consumes no free
 * capital and respects no portfolio position limit, because a research
 * trajectory is not a position. What it DOES respect is what actually makes a
 * trajectory informative: hard safety facts, mechanics viability, and a frozen
 * sampling design.
 *
 * It writes to `development_trajectories` and never to `positions`, `fills` or
 * `ledger_entries`. The e2e suite asserts the capital-bearing tables are empty
 * against the DATABASE, not against the code path, and that assertion must keep
 * holding while this runs.
 *
 * This process cannot sign. It does not import packages/execution.
 */

const MIGRATION_PROGRAMS = [PUMP_PROGRAM, PUMPSWAP_PROGRAM, AMM_PROGRAM_ID];

/**
 * A seed that is fixed within a cycle and varies between them.
 *
 * `Math.random()` would make a cycle unreplayable, and replay divergence is
 * supposed to mean a defect rather than a coin flip.
 */
const nowSeed = (): number => Math.floor(Date.now() / 60_000);

/** One account read, shaped for `accountSourceOf`. */
async function readPoolRow(
  rpc: Awaited<ReturnType<typeof researchRpc>>['rpc'],
  pubkey: string,
): Promise<{ pubkey: string; owner: string; dataBase64: string; lamports: bigint }> {
  const raw = await rpc.getAccountRaw(pubkey);
  return { pubkey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports };
}

/** Frozen for the development window. Not a size search. */
const NOTIONAL_LAMPORTS = BigInt(process.env['COLLECT_LAMPORTS'] ?? '20000000');

interface Args {
  readonly discoverOnly: boolean;
  readonly maxCandidates: number;
  readonly once: boolean;
  readonly maxOpen: number;
  readonly loop: boolean;
  readonly intervalSeconds: number;
  /**
   * How many unseen mints the history backfill may probe per cycle.
   *
   * Small on purpose. The unbounded version exhausted the endpoint's rate limit
   * and left nothing for the primary path.
   */
  readonly backfillScan: number;
  /**
   * Run the live migration socket. OFF by default, and the default is measured.
   *
   * `logsSubscribe` has no server-side filter finer than "mentions this
   * program", so subscribing to the pump programs delivers EVERY pump.fun buy
   * and sell and every PumpSwap swap. Measured on 2026-08-16 over a 256-second
   * window: **219 messages per second**, about 18.9 million per day, to catch
   * migrations that arrive a few dozen times an hour.
   *
   * Priced against the providers this operator has, that firehose alone is
   * larger than any free allowance and larger than most paid ones — it is what
   * exhausted both endpoints. The backfill lane reaches the same migrations for
   * ONE `getAccountRaw` per mint, because `canonicalPool(mint)` either exists or
   * does not.
   *
   * So the lane stays built and stays off. It becomes correct with a
   * server-side filtered stream (a Geyser/LaserStream `transactionSubscribe`
   * with an account filter), which is a paid product, and buying it before a
   * positive untouched edge exists is exactly what P13 forbids.
   */
  readonly liveLane: boolean;
  /**
   * How many trajectories one mint may ever contribute.
   *
   * Default 3. Exposed because the ceiling is real: with N deep candidate mints
   * known, the corpus cannot exceed N x this until new migrations arrive, and
   * an operator who cannot see that knob reads the resulting empty cycles as a
   * dead chain rather than as an exhausted candidate set.
   */
  readonly maxPerMint: number;
  /**
   * Which window this run belongs to.
   *
   * Keys the exploration ledger, so a restart RESUMES an entitlement instead of
   * re-granting it.
   */
  readonly windowId: string;
  /**
   * P1.3 — permit a run from a DIRTY tree, quarantined.
   *
   * A development-evidence collector runs from a clean tree at a known commit,
   * because a trajectory opened from an uncommitted tree cannot be re-derived
   * from its commit — and 26 of 31 pre-repair sessions were opened that way.
   *
   * Refusing outright would make the collector unrunnable during development,
   * so a dirty run is allowed with this flag and writes to an evidence context
   * that is PERMANENTLY excluded from evidence. Not refusing, and not lying.
   */
  readonly instrumentDevelopment: boolean;
  /** The frozen experiment contract this run collects under. */
  readonly contractId: string | null;
  /** The mark SLA, in milliseconds. Frozen before collection. */
  readonly markSlaMs: number;
  /** Longest the scheduler may sleep between mark checks. */
  readonly maxTickMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const num = (flag: string, dflt: number): number => {
    const a = argv.find((x) => x.startsWith(`${flag}=`));
    const v = a === undefined ? NaN : Number(a.slice(flag.length + 1));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  return {
    discoverOnly: argv.includes('--discover-only'),
    maxCandidates: num('--max-candidates', 25),
    once: argv.includes('--once'),
    maxOpen: num('--max-open', 5),
    // A daemon by default; --once is the escape hatch for a single pass.
    loop: !argv.includes('--once'),
    intervalSeconds: num('--interval', 300),
    backfillScan: num('--backfill-scan', 25),
    // Opt-in. See the field comment: 219 messages/second, measured.
    liveLane: argv.includes('--live-lane'),
    maxPerMint: num('--max-per-mint', 3),
    windowId: (argv.find((x) => x.startsWith('--window=')) ?? '--window=DEV_WINDOW_V1').slice(9),
    instrumentDevelopment: argv.includes('--instrument-development'),
    contractId: argv.find((x) => x.startsWith('--contract='))?.slice(11) ?? null,
    markSlaMs: num('--mark-sla-ms', MARK_SLA_MS),
    maxTickMs: num('--max-tick-ms', DEFAULT_MAX_TICK_MS),
  };
}

/**
 * Discover confirmed migrations.
 *
 * The candidate stream is the whole problem this addresses. Measured on the
 * corpus: only 5 of 300 sampled screened mints have a canonical PumpSwap pool,
 * so 98% of the trajectory budget was being spent on tokens that can never be
 * sold through the direct path.
 */
async function discover(
  db: ReturnType<typeof openDb>,
  rpc: Awaited<ReturnType<typeof researchRpc>>['rpc'],
  limit: number,
  /** How many unseen mints this cycle may probe. Recovery, not the main lane. */
  scanBudget: number,
): Promise<{ found: number; refusals: Record<string, number> }> {
  const refusals: Record<string, number> = {};
  let found = 0;

  /**
   * Where to look.
   *
   * Scanning the AMM program's own signatures is a poor strategy and the data
   * says so: in 200 recent AMM transactions there were ZERO `create_pool`
   * instructions — 58 were swaps correctly refused by the discriminator check,
   * 87 had failed outright, and the rest referenced no derivable pool. Swaps
   * outnumber migrations by orders of magnitude, so the AMM's signature stream
   * is almost entirely the wrong thing.
   *
   * The creation is reachable directly instead: page a POOL's history to the
   * end, then walk forward from the oldest until an instruction actually carries
   * a creation discriminator. `findPoolCreation` documents why neither half of
   * that can be skipped — one live pool needed 25 pages to reach its creation,
   * and its single oldest signature was a FAILED snipe, not the creation.
   */
  /**
   * P13 — THE BACKFILL GETS A SMALL BUDGET, AND IT GETS IT LAST.
   *
   * This used to scan `max(200, limit × 40)` mints per cycle, one
   * `getAccountRaw` each, to learn what it already knew: only about 3% of
   * screened mints ever have a canonical PumpSwap pool. Measured on 2026-08-16
   * the scan exhausted the endpoint's rate limit outright — 200 calls returning
   * "no canonical pool", then HTTP 429 for every read the admission and open
   * passes needed. The refusal histogram for that cycle read as a chain with no
   * canonical pools, which was a fact about our quota.
   *
   * Now it is what P8 says it is: RECOVERY, on leftover budget. The live lane
   * is the primary path, and mints already resolved are skipped rather than
   * re-derived every cycle — a negative result about a mint does not expire.
   */
  const alreadyKnown = new Set(
    (
      db
        .prepare(
          `SELECT mint FROM confirmed_migrations
            UNION SELECT mint FROM candidate_risk_facts
            UNION SELECT mint FROM development_trajectories`,
        )
        .all() as { mint: string }[]
    ).map((r) => r.mint),
  );

  // Mints the screening stream has seen. `chain_events` identities are
  // untrustworthy (that is finding J), so the pool is DERIVED from the mint and
  // verified on chain rather than believed.
  const seen = db
    .prepare('SELECT DISTINCT mint FROM screenings WHERE mint IS NOT NULL ORDER BY rowid DESC LIMIT ?')
    .all(Math.max(200, limit * 40)) as { mint: string }[];

  let probed = 0;
  for (const { mint } of seen) {
    if (found >= limit) break;
    // The bound that matters. Reached long before the SELECT's, and it is what
    // leaves the endpoint with budget for the primary path.
    if (probed >= scanBudget) {
      // Named as a BUDGET, not as a market fact. Raise it with --backfill-scan
      // when the endpoint has headroom; it is the throttle, not a finding.
      refusals[`backfill scan budget of ${scanBudget} mint(s) reached this cycle`] =
        (refusals[`backfill scan budget of ${scanBudget} mint(s) reached this cycle`] ?? 0) + 1;
      break;
    }
    if (alreadyKnown.has(mint)) continue;
    probed++;
    let pool: string;
    try {
      pool = canonicalPool(mint);
    } catch {
      continue;
    }
    try {
      await rpc.getAccountRaw(pool);
    } catch {
      // Not a defect. Most Pump mints never migrate, and that ratio is the
      // finding that motivates this whole lane.
      refusals['no canonical PumpSwap pool'] = (refusals['no canonical PumpSwap pool'] ?? 0) + 1;
      continue;
    }

    const res = await findPoolCreation(rpc, pool, {
      commitment: 'confirmed',
      migrationProgramIds: MIGRATION_PROGRAMS,
    });
    if ('refusal' in res) {
      refusals[res.refusal] = (refusals[res.refusal] ?? 0) + 1;
      continue;
    }
    for (const e of res.migrations) {
      const rich = await enrichMigration(rpc, e);
      // The creation transaction was read at confirmed and it landed, so the
      // sighting is reconciled by construction. A processed-only sighting would
      // be STILL_UNKNOWN and would not enter the candidate queue.
      const reversal = reconcileCommitment('confirmed', { found: true, failed: false });
      insertConfirmedMigration(db, rich, reversal, Date.now());
      found++;
    }
  }
  return { found, refusals };
}

/**
 * P10 — read what the risk gates need, for ONE candidate, before deciding.
 *
 * Deliberately shallow. Everything here comes from accounts the open path is
 * about to read anyway — the mint and the pool — so admission costs two reads
 * rather than a holder crawl. The expensive fact, entity-adjusted
 * concentration, is reported as HISTORY_INCOMPLETE rather than fabricated:
 * paginating every top holder's full signature history is a Helius-tier
 * operation, and claiming a clustered share we did not measure is worse than
 * refusing on it.
 *
 * That refusal is deliberate and it BITES: with no holder histories the
 * concentration gate fails and nothing is admitted. Which is correct — an
 * incomplete history can only UNDERSTATE clustering, so passing on it would
 * pass exactly the tokens we know least about. The development limits below
 * make that visible rather than quietly waiving it.
 */
async function candidateFacts(
  rpc: Awaited<ReturnType<typeof researchRpc>>['rpc'],
  mint: string,
  count: (kind: string, detail?: string) => void,
): Promise<CandidateRiskFacts> {
  const nowMs = Date.now();
  let pool = '';
  let canonical = false;
  let poolMayhem: boolean | null = null;
  let cashback: boolean | null = null;
  let accumulator: string | null = null;
  let poolBaseVault = '';
  let poolReadFailure: string | null = null;
  let effectiveQuote: bigint | null = null;

  try {
    pool = canonicalPool(mint);
    const raw = await rpc.getAccountRaw(pool);
    count('solana_rpc', 'getAccountInfo');
    const addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
      pool,
    );
    canonical = true;
    poolBaseVault = addrs.poolBaseTokenAccount;
    /**
     * The pool's DEPTH, read before the decision.
     *
     * Measured across 29 candidates on 2026-08-16: 19 held 18-57 SOL, where a
     * 0.02 SOL entry is 0.1% of the pool; ten were drained to 0.01-0.32 SOL,
     * where the same entry is 6-170%. The sampler kept selecting the drained
     * ones, and a round trip at 112% of a pool measures our own footprint.
     */
    try {
      const vaults = await Promise.all(
        [addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount].map(async (pk) => {
          const a = await rpc.getAccountRaw(pk);
          return { pubkey: pk, owner: a.owner, dataBase64: a.dataBase64, lamports: a.lamports };
        }),
      );
      count('solana_rpc', 'getAccountInfo');
      const facts = poolFactsFrom(
        accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }, ...vaults]),
        pool,
      );
      effectiveQuote = facts.quoteReserveRaw + facts.virtualQuoteReserves;
    } catch {
      // Null, never zero. An unread reserve has not been shown to be shallow OR
      // deep, and `admitCandidate` refuses on null.
    }
    poolMayhem = addrs.isMayhemMode;
    cashback = addrs.isCashbackCoin;
    accumulator = swapAccountRoles({
      user: 'So11111111111111111111111111111111111111112',
      baseMint: mint,
      coinCreator: addrs.coinCreator,
    }).accumulatorWsolAta;
  } catch (e) {
    /**
     * "The pool does not exist" and "we were rate limited" are DIFFERENT FACTS.
     *
     * Both refuse, and they must not refuse under the same name. Collapsing
     * them reports an apparatus failure as a property of the token, and a run
     * that hit its RPC quota then reads as a chain with no canonical pools —
     * which is precisely the substitution this project keeps finding. The first
     * live run of this gate did exactly that: six candidates admitted under one
     * reading became six "not canonical" under the next, because the endpoint
     * started returning 429.
     */
    poolReadFailure = (e as Error).message.slice(0, 120);
  }

  let decoded: DecodedMint | null = null;
  let decodeFailure: string | null = null;
  let isToken2022 = false;
  try {
    const raw = await rpc.getAccountRaw(mint);
    count('solana_rpc', 'getAccountInfo');
    isToken2022 = raw.owner === TOKEN_2022_PROGRAM;
    decoded = decodeMint(Buffer.from(raw.dataBase64, 'base64'), raw.owner);
  } catch (e) {
    // `decodeMint` THROWS on an extension newer than itself rather than
    // returning one, so an unknown extension arrives here as a decode failure
    // and not as a field. That is stronger than grading it.
    decodeFailure = (e as Error).message.slice(0, 140);
  }

  /**
   * The CHEAP concentration tier: balances alone.
   *
   * One call, and a real measurement of a real thing — it just cannot tell one
   * wallet holding five accounts from five independent holders. The pool's own
   * vault is excluded: it is the largest holder of every migrated token and
   * counting it would report every pool as maximally concentrated.
   */
  const raw: { share: number | null; examined: number } = { share: null, examined: 0 };
  try {
    const [largest, supply] = await Promise.all([
      rpc.getTokenLargestAccounts(mint),
      rpc.getTokenSupply(mint),
    ]);
    count('solana_rpc', 'getTokenLargestAccounts');
    count('solana_rpc', 'getTokenSupply');
    if (supply.amount > 0n) {
      let held = 0n;
      for (const a of largest.accounts) {
        if (a.address === poolBaseVault) continue;
        held += a.amount;
        raw.examined++;
      }
      raw.share = Number((held * 10_000n) / supply.amount) / 10_000;
    }
  } catch {
    // Null, not zero. An unread holder list is not an unconcentrated one, and
    // `admitCandidate` refuses on null.
  }

  const fee = decoded?.transferFeeConfig ?? null;
  return collectCandidateRiskFacts({
    mint,
    pool,
    nowMs,
    decodedMint: decoded,
    mintDecodeFailure: decodeFailure,
    isToken2022,
    hasTransferFeeExtension: fee !== null,
    transferFeeCurrentBps: decoded?.transferFee?.basisPoints ?? null,
    // The NEWER schedule, which is the one a future exit pays.
    transferFeeFutureBps: fee === null ? null : fee.newer.basisPoints,
    transferFeeWithheldAtoms: fee === null ? null : fee.withheldAmount,
    poolIsMayhemMode: poolMayhem,
    isCashbackCoin: cashback,
    accumulatorWsolAta: accumulator,
    /**
     * The strong tier is NOT walked here.
     *
     * An empty history list is HISTORY_INCOMPLETE — never a measured zero
     * clustering, which is what it used to report. Paginating every top
     * holder's full signature history to justify "initial funder" is a
     * Helius-tier operation this system does not have, and the oldest item in a
     * capped newest page is not the first transaction.
     */
    holderHistories: [],
    clusteredShare: 0,
    rawTopHolderShare: raw.share,
    holdersExamined: raw.examined,
    canonicalPool: canonical,
    poolReadFailure,
    effectiveQuoteReserveLamports: effectiveQuote,
    notionalLamports: NOTIONAL_LAMPORTS,
  });
}

/**
 * Take a coherent snapshot of one candidate's pool and report its mechanics.
 *
 * This is the step that establishes whether a trajectory is even possible before
 * any budget is spent on it.
 */
async function snapshotCandidate(
  rpc: Awaited<ReturnType<typeof researchRpc>>['rpc'],
  mint: string,
): Promise<
  | { ok: true; pool: string; snapshotHash: string; stratum: string; baseReserve: bigint; quoteReserve: bigint; virtualQuote: bigint; cashback: boolean | null; mayhem: boolean | null; driftSlots: number }
  | { ok: false; reason: string }
> {
  let pool: string;
  try {
    pool = canonicalPool(mint);
  } catch {
    return { ok: false, reason: 'the mint is not a valid pubkey' };
  }

  let poolRaw;
  try {
    poolRaw = await rpc.getAccountRaw(pool);
  } catch {
    return { ok: false, reason: 'no canonical PumpSwap pool' };
  }

  let addrs;
  try {
    addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports }]),
      pool,
    );
  } catch {
    return { ok: false, reason: 'the pool account did not decode' };
  }

  try {
    const snap = await captureCoherentSnapshotV2(
      rpc as never,
      {
        economicAccounts: [pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, mint],
        feeConfig: FEE_CONFIG_ADDR,
        staticAccounts: [GLOBAL_CONFIG_ADDR],
        requireDecodable: [pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount],
        commitment: 'confirmed',
      },
      base58Encode,
    );

    const src = accountSourceOf(
      snap.accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: BigInt(a.lamports),
      })),
    );
    const facts = poolFactsFrom(src, pool);

    return {
      ok: true,
      pool,
      snapshotHash: snap.snapshotHash,
      stratum: mechanicsStratum({ canonicalPool: true, cashbackCoin: addrs.isCashbackCoin === true }),
      baseReserve: facts.baseReserve,
      quoteReserve: facts.quoteReserveRaw,
      virtualQuote: facts.virtualQuoteReserves,
      cashback: addrs.isCashbackCoin,
      mayhem: addrs.isMayhemMode,
      driftSlots: snap.economicDriftSlots,
    };
  } catch (e) {
    if (e instanceof SnapshotIncoherent) return { ok: false, reason: `snapshot refused: ${e.reason.slice(0, 80)}` };
    return { ok: false, reason: (e as Error).message.slice(0, 80) };
  }
}

/**
 * The lanes and telemetry that outlive one cycle.
 *
 * A websocket that reconnected every cycle would spend its whole life in
 * backoff and would report a coverage gap for every interval between cycles —
 * gaps that describe the collector's schedule rather than the chain's.
 */
interface LaneContext {
  readonly session: SessionHandle;
  readonly migrations: LiveMigrationLane | null;
  readonly vaults: LiveVaultWatch | null;
  /**
   * P0.4 / P12.2 — which evidence context this cycle's rows belong to, and
   * whether that context is admissible.
   *
   * Carried rather than looked up so a cycle cannot write into a context
   * different from the one the run's provenance gate approved.
   */
  readonly evidenceContextId: string;
  readonly contextValidity: 'DEVELOPMENT_EVIDENCE' | 'INSTRUMENT_DEVELOPMENT_INVALID';
  readonly contractId: string | null;
  readonly sourceCommit: string;
}

/**
 * P7 — one pass.
 *
 * `marksOnly` is the mark half. The 8f73cef audit's B-4 found 697 of 1,448
 * marks more than 60 seconds late, and the cause was structural: the mark pass
 * ran at the top of a 300-second discovery cycle, so the mark clock and the
 * discovery clock were the same clock. A one-minute horizon cannot be met by a
 * five-minute loop.
 *
 * Splitting them means discovery keeps its 300 seconds — migrations are
 * backfilled from the chain and nothing is missed by looking every five
 * minutes — while marks run on a monotonic due-time schedule.
 */
async function runCycle(
  lanes: LaneContext | null = null,
  opts: { readonly marksOnly?: boolean } = {},
): Promise<void> {
  const mode = modeFromArgv() ?? 'observe';
  if (mode === 'canary' || mode === 'live') {
    throw new Error('trajectory:collect never runs in a mode that can trade');
  }
  const args = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);
  const db = openDb({ path: secrets.databasePath, skipBackup: true });
  const sessionId = lanes?.session.sessionId ?? null;
  /**
   * P3.1 — the content-addressed store, opened once per cycle.
   *
   * Its root is `data/evidence-blobs`, separate from the older `data/blobs`,
   * because the two answer different questions and mixing them would make a
   * blob-store sweep report on evidence it does not own.
   */
  const evidence = new EvidenceStore(db, 'data/evidence-blobs');
  const count = (kind: string, detail?: string): void => {
    if (sessionId !== null) countResource(db, sessionId, kind, detail === undefined ? {} : { detail });
  };

  console.log(`trajectory:collect  mode=${mode}  endpoint=${host}`);
  console.log('this process owns no capital: no NAV, no free capital, no portfolio position limit');
  console.log('');

  /**
   * P8 — THE PRIMARY LANE: what the chain just did.
   *
   * Drained before the history scan, and its yield is reported separately, so
   * "the live lane found nothing" and "the live lane is not running" are
   * different lines rather than one silence.
   */
  if (lanes?.migrations != null) {
    const live = await lanes.migrations.drain(args.maxCandidates);
    console.log(
      `live migration lane: ${live.recorded} recorded from ${live.fetched} fetched, ` +
        `${lanes.migrations.pending} still queued` +
        (live.droppedForBound > 0 ? `, ${live.droppedForBound} DROPPED for the queue bound` : ''),
    );
    for (const [r, n] of Object.entries(live.refusals).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      console.log(`  refused ${String(n).padStart(4)}  ${r}`);
    }
    const cov = lanes.migrations.coverage;
    console.log(
      `  socket: ${lanes.migrations.fullyCovered ? 'fully covered' : 'DEGRADED'} — ` +
        cov.map((c) => `${c.programId.slice(0, 6)}${c.subscribed ? '' : '(unsubscribed)'}=${c.events}`).join(' '),
    );
  } else {
    console.log('live migration lane: NOT RUNNING (no websocket endpoint configured)');
  }

  // The RECOVERY lane. Structurally late — a pool only enters it once a
  // screening happened to mention its mint — and kept because it reaches
  // creations the socket was not alive for.
  if (opts.marksOnly === true) {
    // Straight to the mark pass. No discovery, no opening, no candidate reads:
    // this pass exists to hit deadlines, and spending its RPC budget on
    // discovery is what made the deadlines unreachable.
    await runMarkPass(db, rpc, args, lanes, sessionId, evidence);
    db.close();
    return;
  }

  const disc = await discover(db, rpc, args.maxCandidates, args.backfillScan);
  console.log(`history backfill: ${disc.found} confirmed migration(s) recorded`);
  for (const [r, n] of Object.entries(disc.refusals).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  refused ${String(n).padStart(4)}  ${r}`);
  }
  console.log('  stored by reconciliation:', JSON.stringify(confirmedMigrationCounts(db)));

  if (args.discoverOnly) {
    console.log('');
    console.log('--discover-only: stopping before snapshot');
    db.close();
    return;
  }

  const candidates = migrationCandidates(db, args.maxCandidates, args.maxPerMint);
  console.log('');
  console.log(`candidate queue: ${candidates.length} confirmed migration(s)`);

  let viable = 0;
  const reasons: Record<string, number> = {};
  for (const c of candidates) {
    const s = await snapshotCandidate(rpc, c.mint);
    if (!s.ok) {
      reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      continue;
    }
    viable++;
    console.log(
      `  ${c.mint.slice(0, 10)}  ${s.stratum.padEnd(24)} base=${s.baseReserve} quote=${s.quoteReserve} drift=${s.driftSlots} snap=${s.snapshotHash.slice(0, 12)}`,
    );
  }

  console.log('');
  console.log(`mechanically viable: ${viable} of ${candidates.length}`);
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${r}`);
  }
  console.log('');
  console.log('trajectories by state:', JSON.stringify(trajectoryCounts(db)));

  /**
   * P4 — OPEN THEM.
   *
   * This printed a refusal naming the sequential worker as unbuilt for two
   * commits after that worker was built. The collector was
   * never updated, so the database carried zero trajectories while a proof
   * script's round trips were being read as the running system's output.
   */
  if (secrets.paperTakerPubkey === null) {
    console.log('');
    console.log('NOT OPENING: PAPER_TAKER_PUBKEY is not configured, so no taker exists to build for.');
    db.close();
    return;
  }
  const taker = secrets.paperTakerPubkey;

  console.log('');
  console.log(`opening trajectories at ${NOTIONAL_LAMPORTS} lamports (direct PumpSwap, both legs)`);

  const worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });
  const refusals: Record<string, number> = {};
  let opened = 0;

  /**
   * Item 55 - the EXPLORATION ARM, which had never run.
   *
   * `allocate()` existed, was tested, was pure, and no production caller
   * invoked it, so 100% of the budget went to the ranking. A gate evaluated
   * only on the candidates it admitted is evaluated on its own output; the
   * random draw exists so the corpus contains rows the ranking would never
   * have bought.
   *
   * The window id keys the ledger, so a restart RESUMES an entitlement rather
   * than re-granting it. All the state is in the database, which is the same
   * property the mark scheduler already relies on.
   */
  const windowId = args.windowId;
  const armOf = new Map<string, { arm: 'exploit' | 'explore'; p: number }>();
  {
    const ranked = candidates.map((c, i) => ({
      item: c.mint,
      // Least-sampled-first is the exploit RANKING, so the arm split is a
      // disagreement with that ranking rather than a reshuffle of it.
      rank: -i,
      stratum: mechanicsStratum({ canonicalPool: true, cashbackCoin: c.is_cashback_coin === 1 }),
    }));
    const selected = allocate(ranked, Math.min(args.maxOpen, ranked.length), Math.floor(nowSeed()), 0);
    for (const sel of selected) armOf.set(sel.item, { arm: sel.arm, p: sel.inclusionProbability });
  }
  /**
   * Grants happen at the END of the cycle, against rows that were actually
   * OPENED. See `grantOpened` below.
   *
   * Granting against SELECTIONS was measured wrong: the first live cycle
   * selected eight candidates, the depth gate refused all eight, and the ledger
   * still recorded `granted 3, consumed 0`. Every cycle would add entitlement
   * for rows that never existed, so the budget climbs forever and the fraction
   * it is supposed to hold at 25% becomes unenforceable.
   *
   * Granting on opens makes the ledger track the corpus. A stratum earns
   * exploration budget in proportion to the rows it actually contributed, and
   * the arm spends it on the next cycle — so the first window is all
   * exploitation, visibly, rather than by an accident nobody recorded.
   */
  const openedPerStratum = new Map<string, number>();
  /**
   * Endpoint exhaustion, without matching provider prose.
   *
   * `isQuotaExhausted` reads the message, and messages differ: it was written
   * against QuickNode's `daily request limit reached` and missed Helius's `max
   * usage reached` on the next run, so the stop it guarded never fired and the
   * cycle produced six apparatus refusals instead of one honest line.
   */
  const breaker = new EndpointRefusalBreaker(3);

  try {
    for (const c of candidates) {
      if (opened >= args.maxOpen) break;

      /**
       * P10 — THE RISK FACTS, BEFORE THE DECISION.
       *
       * Every module behind this call existed and was tested, and none of them
       * reached this loop. A candidate was admitted on mechanics alone: it had
       * a canonical pool, the buy simulated, the sell simulated. Whether the
       * mint could freeze our exit was never consulted, and was never stored
       * against the trajectory that resulted.
       *
       * Collected and stamped BEFORE `openTrajectory` runs, because a gate
       * reading a fact collected after selection is a post-hoc annotation and
       * the position was taken either way.
       */
      const facts = await candidateFacts(rpc, c.mint, count);

      /**
       * A SPENT DAILY QUOTA IS NOT A REFUSAL. Stop.
       *
       * A per-second rate limit and an exhausted daily allowance both arrive as
       * HTTP 429, and they call for opposite responses. Backing off works for
       * the first and is pure waste for the second: every remaining candidate
       * this cycle would be refused with `APPARATUS: the pool could not be
       * read`, and the refusal histogram would read as a chain with no
       * canonical pools rather than as an account with no requests left.
       *
       * Measured on 2026-08-16, when exactly that happened.
       */
      const refusedRepeatedly = breaker.record(facts.poolReadFailure === null ? null : new Error(facts.poolReadFailure));
      if (refusedRepeatedly || (facts.poolReadFailure !== null && isQuotaExhausted(new Error(facts.poolReadFailure)))) {
        if (sessionId !== null) countResource(db, sessionId, 'solana_rpc', { detail: 'getAccountInfo', count: 0, quotaErrors: 1 });
        console.log('');
        console.log(
          `STOPPING THIS PASS: the RPC endpoint refused ${breaker.consecutiveRefusals} read(s) in a row.`,
        );
        console.log(`  ${(facts.poolReadFailure ?? '').slice(0, 100)}`);
        console.log('Every further candidate would be refused for an apparatus reason, and a refusal');
        console.log('histogram full of those reads as a fact about the chain. `pnpm rate:budget-v2`');
        console.log('reports it as the binding constraint.');
        break;
      }

      const admission = admitCandidate(facts);
      insertCandidateRiskFacts(db, facts, admission, null);
      if (!admission.admit) {
        // Refusals are the product. Every reason, not the first.
        for (const r of admission.refusals) refusals[r] = (refusals[r] ?? 0) + 1;
        console.log(`  ${c.mint.slice(0, 10)}  RISK_REFUSED  ${admission.refusals[0]?.slice(0, 66) ?? ''}`);
        continue;
      }

      /**
       * P1.4 — RESERVE THE SLOT BEFORE ANY WORK IS DONE.
       *
       * `migrationCandidates()` filtered on `COUNT(*) < maxPerMint` when the
       * queue was built. That is correct per cycle and worthless across
       * processes: five daemons evaluated it against the same instant and all
       * admitted the same mint, producing 15 over-cap mints and one at 58.
       *
       * The reservation is an atomic database fact — BEGIN IMMEDIATE, unique
       * indexes, a CHECK that the ordinal is within the cap. Taken here, before
       * the snapshot and the worker round trip, so a refusal costs nothing.
       */
      let reservation;
      try {
        reservation = reserveCandidate(db, {
          windowId: args.windowId,
          mint: c.mint,
          maxPerMint: args.maxPerMint,
          ownerSessionId: sessionId ?? 'no-session',
          nowMs: Date.now(),
          // The cap is over the STUDY, not over this window. A mint that
          // already produced its allowance in an earlier window has produced
          // it, and the audit's 58-trajectory mint is what ignoring that costs.
          includeHistoric: true,
        });
      } catch (e) {
        if (e instanceof ReservationRefused) {
          refusals[`RESERVATION_${e.code}`] = (refusals[`RESERVATION_${e.code}`] ?? 0) + 1;
          console.log(`  ${c.mint.slice(0, 10)}  RESERVATION_${e.code}  ${e.message.slice(0, 60)}`);
          continue;
        }
        throw e;
      }

      // A fresh runtime per candidate: the client's output bound is cumulative
      // over a worker's lifetime, and one long-lived worker turns a bound meant
      // to catch runaways into a cap on the study.
      await worker.close();
      const w = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });

      const res = await openTrajectory(
        rpc as never,
        w,
        {
          mint: c.mint,
          taker,
          notionalLamports: NOTIONAL_LAMPORTS,
          slippagePct: 3,
          isCashbackCoin: c.is_cashback_coin === 1,
          captureSnapshot: async (accounts, programs) =>
            captureSnapshot(rpc, [], { extraAccounts: [...accounts], extraPrograms: [...programs] }) as never,
        },
      );
      await w.close();

      if (!res.ok) {
        refusals[res.refusal] = (refusals[res.refusal] ?? 0) + 1;
        console.log(`  ${c.mint.slice(0, 10)}  ${res.refusal}  ${res.detail.slice(0, 70)}`);
        // The reservation is released, so a refused candidate does not consume
        // its mint's allowance. A refusal is a fact about the venue or the
        // apparatus, not a sample.
        abandonReservation(db, reservation.reservationId, Date.now(), res.refusal);
        continue;
      }

      const t = res.trajectory;

      /**
       * The facts were true BEFORE the decision. Asserted, not assumed.
       *
       * Throwing here would kill the cycle over a fact ordering that is correct
       * by construction, so it is caught and named. If it ever fires, the
       * collection order changed and every gate downstream became an
       * annotation — which is worth a loud line in the log.
       */
      try {
        assertCollectedBeforeDecision(facts, t.openedUtcMs);
      } catch (e) {
        console.log(`  ${c.mint.slice(0, 10)}  FACT ORDER: ${(e as Error).message.slice(0, 110)}`);
      }
      // Re-recorded against the trajectory it admitted, so the row and the
      // outcome join. The refusal row above stays: a refusal is evidence too.
      insertCandidateRiskFacts(
        db,
        { ...facts, collectedAtMs: facts.collectedAtMs + 1 },
        admission,
        t.trajectoryId,
      );

      // P2/F12 — the plan goes in FIRST, keyed by the trajectory it belongs to.
      //
      // The capability fingerprint below is the snapshot hash, which says what
      // the market looked like. It does not say which fee recipient the SDK
      // picked or what the instruction's account order was, and those are the
      // things a replay has to reproduce exactly.
      const arm = armOf.get(c.mint) ?? null;
      /**
       * An exploration selection SPENDS entitlement. When the stratum has none
       * left the row is exploitation, whatever the draw said - a silent
       * overspend would make the recorded fraction a description of intent
       * rather than of what happened.
       */
      const stratumOfCandidate = mechanicsStratum({
        canonicalPool: true,
        cashbackCoin: c.is_cashback_coin === 1,
      });
      const spent =
        arm?.arm === 'explore' ? consumeExploration(db, windowId, stratumOfCandidate, Date.now()) : false;
      const effectiveArm: 'exploit' | 'explore' = spent ? 'explore' : 'exploit';
      // This row exists, so its stratum earns entitlement for the next cycle.
      openedPerStratum.set(stratumOfCandidate, (openedPerStratum.get(stratumOfCandidate) ?? 0) + 1);

      /**
       * P2.4 / P3 — PERSIST THE RAW EVIDENCE BEFORE THE TRAJECTORY EXISTS.
       *
       * C-4: the buy and sell pre/post account sets lived only in the worker
       * process and were reduced to aggregate columns before anything was
       * written, so every economic amount was recorded once and was
       * unfalsifiable from the database.
       *
       * Every account state goes to the content-addressed store, is read back
       * and re-hashed, and is linked by (job, step, leg, address) with ABSENT
       * explicit on both sides.
       */
      const planWritable = new Set(t.entryPlan.writableAccounts);
      const exitWritable = new Set(t.exitPlan?.writableAccounts ?? []);
      const roleOf: Record<string, string> = {
        [t.pool]: 'POOL',
        [t.mint]: 'BASE_MINT',
      };
      const persisted = persistEvidence(db, evidence, {
        trajectoryId: t.trajectoryId,
        evidenceContextId: lanes?.evidenceContextId ?? 'unassigned',
        reservationId: reservation.reservationId,
        jobId: t.entrySimulationJobId,
        canonicalRequest: {
          mint: t.mint,
          pool: t.pool,
          taker,
          notionalLamports: t.notionalLamports.toString(),
          snapshotHash: t.snapshotHash,
          accountPlanHash: t.entryPlan.fingerprint,
        },
        workerResponse: t.rawEvidence.workerIdentity,
        snapshot: {
          hash: t.snapshotHash,
          slot: 0,
          capturedUtcMs: t.openedUtcMs,
          mint: t.mint,
          pool: t.pool,
          manifest: [],
          feeConfigHash: t.feeConfigHash,
          capabilityFingerprint: t.capabilityFingerprint,
          programDataHashes: {},
          sdkVersions: SDK_VERSIONS,
          workerBinaryHash: null,
        },
        accountPlanHash: t.entryPlan.fingerprint,
        selectedTier: t.selectedTier,
        legs: [
          {
            leg: 'buy',
            stepIndex: 0,
            observationId: t.entryObservationId,
            transactionBase64: t.rawEvidence.buyTransactionBase64,
            accountStates: pairLegAccounts(
              t.rawEvidence.buyPre,
              t.rawEvidence.buyPost,
              roleOf,
              planWritable,
            ),
            declaredUnobserved: t.rawEvidence.buyUnobserved,
            runtimeOk: true,
            effectOk: t.settlement.entry.effectValid,
            unitsConsumed: t.buyComputeUnits,
            transactionError: null,
            mint: t.mint,
            inputMint: WSOL_MINT,
            outputMint: t.mint,
            requestedAmount: t.notionalLamports,
          },
          ...(t.rawEvidence.sellPre === null || t.rawEvidence.sellPost === null || t.exitObservationId === null
            ? []
            : [
                {
                  leg: 'sell' as const,
                  stepIndex: 1,
                  observationId: t.exitObservationId,
                  transactionBase64: t.rawEvidence.buyTransactionBase64,
                  accountStates: pairLegAccounts(
                    t.rawEvidence.sellPre,
                    t.rawEvidence.sellPost,
                    roleOf,
                    exitWritable,
                  ),
                  declaredUnobserved: t.rawEvidence.sellUnobserved ?? [],
                  runtimeOk: true,
                  effectOk: t.settlement.exit?.effectValid ?? false,
                  unitsConsumed: t.sellComputeUnits,
                  transactionError: null,
                  mint: t.mint,
                  inputMint: t.mint,
                  outputMint: WSOL_MINT,
                  requestedAmount: t.acquiredAtoms,
                },
              ]),
        ],
        endpoint: host,
        nowMs: Date.now(),
      });

      /**
       * P2.5 / P4.1 — RE-DERIVE THE SETTLEMENT NOW THAT THE EVIDENCE IS DURABLE.
       *
       * `t.settlement` was built inside `openTrajectory`, before anything
       * existed on disk; its `rawStateDurable` was a claim about process
       * memory. This one is built with the durability the blob store actually
       * reports after read-back, and it is the one that gets stored.
       */
      const settlement = buildTrajectorySettlement({
        trajectoryId: t.trajectoryId,
        entry: t.settlementInputs.entry,
        exit: t.settlementInputs.exit,
        cashback: t.settlementInputs.cashback,
        rentStillLockedLamports: t.settlementInputs.rentStillLockedLamports,
        venueFeeDecompositionKnown: false,
        legEvidence: {
          entry: {
            rawStateDurable: persisted.rawStateDurable,
            linksResolve: true,
            residualSemanticsKnown: true,
          },
          ...(t.settlementInputs.exit === null
            ? {}
            : {
                exit: {
                  rawStateDurable: persisted.rawStateDurable,
                  linksResolve: t.exitObservationId !== null,
                  residualSemanticsKnown: true,
                },
              }),
        },
      });
      const identityViolations = checkIdentities(settlement).violations;

      // P4 — the per-leg settlements, so the trajectory settlement is derived
      // from measured legs rather than recomputed from aggregates handed to it.
      for (const [leg, m, settlementId, stepIndex] of [
        ['buy' as const, t.settlementInputs.entry, t.entrySettlementId, t.entryStepIndex],
        ...(t.settlementInputs.exit === null || t.exitSettlementId === null
          ? []
          : [['sell' as const, t.settlementInputs.exit, t.exitSettlementId, t.exitStepIndex ?? 1] as const]),
      ] as const) {
        const eligible = isPnlEligible(m);
        const fee = transferFeeOrUnknown(m);
        insertLegSettlement(db, {
          settlementId,
          trajectoryId: t.trajectoryId,
          leg,
          observationId: m.observationId,
          jobId: t.entrySimulationJobId,
          stepIndex,
          settlementVersion: SETTLEMENT_VERSION,
          cashOutLamports: leg === 'buy' ? -m.payerNativeDeltaLamports : null,
          cashInLamports: leg === 'sell' ? m.payerNativeDeltaLamports : null,
          grossCreditLamports: m.output.kind === 'native_sol' ? m.output.actualCreditLamports : null,
          baseFeeLamports: m.costs.baseFeeLamports,
          priorityFeeLamports: m.costs.priorityFeeLamports,
          tipLamports: m.costs.tipLamports,
          transferFeeLamports: fee ?? 0n,
          failedAttemptFeeLamports: m.costs.failedAttemptCostLamports,
          rentCreatedLamports: m.costs.rentCreatedLamports,
          rentRecoveredLamports: m.costs.rentRecoveredLamports,
          rentStillLockedLamports:
            m.costs.rentCreatedLamports > m.costs.rentRecoveredLamports
              ? m.costs.rentCreatedLamports - m.costs.rentRecoveredLamports
              : 0n,
          cashbackAccruedLamports: 0n,
          cashbackClaimableLamports: t.settlementInputs.cashback.claimableLamports,
          cashbackClaimedLamports: 0n,
          cashbackClaimCostLamports: 0n,
          residualTokenAtoms: m.residualTokenAtoms ?? 0n,
          unexplainedLamports: m.costs.unexplainedLamports,
          complete: m.complete,
          effectValid: m.effectValid,
          fullAccountCoverage: m.fullAccountCoverage,
          residualSemanticsKnown: true,
          // NOT_APPLICABLE and UNKNOWN are opposite facts that both arrive as an
          // absent number, and only the second blocks PnL.
          transferFeeStatus: fee === null ? 'UNKNOWN' : m.costs.transferFeeLamportsEquivalent === null ? 'NOT_APPLICABLE' : 'MEASURED',
          rawStateDurable: persisted.rawStateDurable,
          pnlEligible: eligible.ok,
          ineligibilityReasons: eligible.reasons,
          nowMs: Date.now(),
        });
      }

      insertTrajectory(db, {
        identity: {
          trajectoryId: t.trajectoryId,
          entryObservationId: t.entryObservationId,
          entrySimulationJobId: t.entrySimulationJobId,
          entrySettlementId: t.entrySettlementId,
          venue: 'PUMPSWAP_DIRECT',
          pool: t.pool,
          // C-3 — a DIFFERENT value from the snapshot hash, because it answers a
          // different question. This argument was literally `t.snapshotHash`,
          // which is how 292 of 292 rows came to carry identical values in the
          // two columns meant to identify their inputs.
          capabilityFingerprint: t.capabilityFingerprint,
          snapshotHash: t.snapshotHash,
          mint: t.mint,
          cohort: 'FIRST_HOUR',
          migrationAgeMs: null,
          notionalLamports: t.notionalLamports,
          entryPolicyInputs: {
            soleVenueAttributed: t.soleVenueAttributed,
            quoteStateSurvived: t.quoteStateSurvived,
            baseVaultDeltaAtoms: t.baseVaultDeltaAtoms.toString(),
            quoteVaultDeltaLamports: t.quoteVaultDeltaLamports.toString(),
          },
          stratum: t.stratum,
        },
        /**
         * N-2 — the entry policy column records the CONTROL's identity, and the
         * decisions themselves live in `trajectory_policy_decisions`.
         *
         * This used to be a string literal written on every row AFTER
         * `admitCandidate` had already decided, so the corpus carried one
         * distinct entry policy against three defined and `decideEntry` had
         * zero production callers. The entry side of the tournament did not
         * exist: the two challengers had a sample of zero and the label
         * described nothing that happened.
         *
         * One column cannot hold three decisions, which is why the decisions
         * are rows. This names which arm the trajectory's own exit path
         * belongs to, and every policy's verdict is stored below.
         */
        entryPolicy: 'HARD_GATES_RANDOM',
        exitPolicy: 'FIXED_15M_CONTROL',
        state: 'AWAITING_FILL_OBSERVATION',
        // The MEASURED bound, not zeros. These were hardcoded, and every row
        // claimed a 0% impact inside a 50 bps bound while the first live
        // surface found entries larger than the pool's whole quote reserve.
        impact: t.impact,
        maxAttainableGrade: 'SIMULATED_EXECUTION',
        refusals: t.incompleteness,
        openedUtcMs: t.openedUtcMs,
      });

      db.prepare(
        `UPDATE development_trajectories
            SET exploration_arm = ?, inclusion_probability = ?, exploration_window = ?,
                fee_config_hash = ?, selected_tier = ?, market_cap_lamports = ?,
                creator_fee_bps = ?, protocol_fee_bps = ?, lp_fee_bps = ?, cashback_flag = ?,
                exit_simulation_job_id = ?, exit_settlement_id = ?,
                entry_step_index = ?, exit_step_index = ?,
                concentration_raw = ?, concentration_entity_adjusted = ?, concentration_stratum = ?
          WHERE trajectory_id = ?`,
      ).run(
        effectiveArm,
        arm?.p ?? null,
        windowId,
        // J-3 — the fee table this trajectory was priced against. No column
        // existed, so no historical row could survive a Pump fee change.
        t.feeConfigHash,
        t.selectedTier,
        t.marketCapLamports?.toString() ?? null,
        t.creatorFeeBps,
        t.protocolFeeBps,
        t.lpFeeBps,
        t.cashbackVerified ? 1 : 0,
        t.exitSimulationJobId,
        t.exitSettlementId,
        t.entryStepIndex,
        t.exitStepIndex,
        // O-2 — RAW and ENTITY-ADJUSTED, kept apart. 1,959 of 1,959 pre-repair
        // risk-fact rows were stratified `CONCENTRATION_RAW_ONLY`, so the raw
        // top-holder share decided every admission — and an incomplete history
        // can only UNDERSTATE clustering, which makes the gate that fires the
        // weaker of the two on every candidate.
        facts.rawTopHolderShare,
        facts.concentration.kind === 'MEASURED' ? facts.concentration.entityAdjustedShare : null,
        facts.concentration.kind === 'MEASURED' ? 'CONCENTRATION_ENTITY' : 'CONCENTRATION_RAW_ONLY',
        t.trajectoryId,
      );

      /**
       * P0.4 — the trajectory belongs to THIS evidence context.
       *
       * Written before the link row, because the link row's foreign key names
       * the context and will refuse if it does not exist.
       */
      db.prepare(
        `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
         VALUES (?, ?, ?) ON CONFLICT(trajectory_id) DO NOTHING`,
      ).run(t.trajectoryId, lanes?.evidenceContextId ?? 'unassigned', Date.now());

      /**
       * P2.3 — THE LINK ROW. Every arrow is a foreign key.
       *
       * If any identifier does not resolve, SQLite refuses this insert and the
       * trajectory does not become a usable sample. The 292 pre-repair rows
       * cannot be represented here at all, which is how "0 of 292 resolve"
       * stops being a thing that can happen rather than a thing that was fixed.
       */
      linkTrajectoryEvidence(db, {
        trajectoryId: t.trajectoryId,
        evidenceContextId: lanes?.evidenceContextId ?? 'unassigned',
        reservationId: reservation.reservationId,
        snapshotHash: t.snapshotHash,
        capabilityFingerprint: t.capabilityFingerprint,
        accountPlanHash: t.entryPlan.fingerprint,
        feeConfigHash: t.feeConfigHash,
        selectedTier: t.selectedTier,
        entryObservationId: t.entryObservationId,
        entryJobId: t.entrySimulationJobId,
        entryStepIndex: t.entryStepIndex,
        entrySettlementId: t.entrySettlementId,
        exitObservationId: t.exitObservationId,
        exitJobId: t.exitSimulationJobId,
        exitStepIndex: t.exitStepIndex,
        exitSettlementId: t.exitSettlementId,
        nowMs: Date.now(),
      });

      // The reservation produced this trajectory. Bound now, so the cap is
      // enforced against rows that exist rather than against intentions.
      resolveReservation(db, reservation.reservationId, t.trajectoryId, Date.now());

      /**
       * P9.1 — ALL THREE ENTRY POLICIES DECIDE, over the SAME pre-entry data.
       *
       * The research sample is selected independently of any entry policy — by
       * mechanics viability and the hard safety gates — and then every policy
       * is asked what IT would have done. That is a paired comparison: same
       * token, same pool, same marks, same costs, different decision.
       *
       * `decideEntry` had zero production callers. This is where it gets them.
       */
      const preEntry: PreEntryFeatures = {
        mint: c.mint,
        hardGatesPass: admission.admit,
        /**
         * Flow features the collector does not yet measure are NULL, and null
         * is never a pass: `survivorFlowContinuation` refuses on every unknown
         * and records which one. That is the honest state of this build — the
         * challenger will REJECT most candidates for want of a flow history,
         * and that rejection is a real decision with a real reason, which is
         * exactly what a sample of zero was not.
         */
        independentBuyerPersistence: null,
        nonMayhemNetQuoteInflowLamports: null,
        effectiveQuoteReserveTrend: null,
        executableExitCapacityTrend: null,
        continuationSlope: null,
        creatorNetSellingLamports: null,
        // O-2 — the ENTITY-ADJUSTED share when it was measured, and null when
        // only balances were read. Never the raw share silently substituted:
        // an incomplete history can only understate clustering.
        entityConcentration:
          facts.concentration.kind === 'MEASURED' ? facts.concentration.entityAdjustedShare : null,
        mintBehaviourSafe: facts.mint2022.freezeAuthority === null ? true : null,
        mechanicsViable: true,
        correctedQualityScore: null,
        scoreCoverageOk: false,
      };
      /**
       * P10.1 — did the entity-adjusted fact CHANGE the decision?
       *
       * Recorded per policy, by running the same policy twice: once with the
       * entity-adjusted concentration and once with the raw share. A risk fact
       * that never alters an outcome is not wired in, and the audit found
       * `entity_concentration` holding 57 rows none of which was joined to a
       * candidate decision.
       */
      const rawOnly: PreEntryFeatures = { ...preEntry, entityConcentration: facts.rawTopHolderShare };
      for (const policy of ENTRY_POLICIES) {
        const decision = decideEntry(policy, preEntry, { seed: `${windowId}:${policy}` });
        const withoutRisk = decideEntry(policy, rawOnly, { seed: `${windowId}:${policy}` });
        db.prepare(
          `INSERT INTO trajectory_policy_decisions
             (trajectory_id, entry_policy, policy_version, decision, reason, feature_snapshot,
              feature_snapshot_hash, decided_utc_ms, risk_facts_applied, decision_without_risk_facts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(trajectory_id, entry_policy) DO NOTHING`,
        ).run(
          t.trajectoryId,
          policy,
          'treatments-v1',
          decision.enter ? 'ENTER' : 'REJECT',
          `${decision.reason}${decision.unknowns.length > 0 ? ` [unknown: ${decision.unknowns.join(',')}]` : ''}`,
          JSON.stringify(preEntry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          createHash('sha256')
            .update(JSON.stringify(preEntry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
            .digest('hex'),
          Date.now(),
          JSON.stringify(facts.concentration.kind === 'MEASURED' ? ['ENTITY_ADJUSTED_CONCENTRATION'] : []),
          withoutRisk.enter ? 'ENTER' : 'REJECT',
        );
      }

      insertAccountPlan(db, t.trajectoryId, t.entryPlan, Date.now());
      // P2/P7 — the exit's plan too. It is the plan the cashback tail was
      // verified against, and until now only the entry's was stored, so a
      // replay had nothing to compare the sell to.
      if (t.exitPlan !== null) insertAccountPlan(db, t.trajectoryId, t.exitPlan, Date.now());

      /**
       * P7/F13 — both legs' cashback movement, stored per leg.
       *
       * The repository asserted that `sell` carries no volume accumulator. It
       * carries two, as optional positional remaining accounts. These rows are
       * what settles that empirically rather than by assertion: if `sell`
       * accrual stays at zero while `buy` climbs, the old model was right.
       */
      insertLegCashback(db, t.trajectoryId, t.cashbackVerified, t.cashbackLegs, Date.now());

      /**
       * P5 - the ONE canonical settlement, written once.
       *
       * Scope is IMMEDIATE_MECHANICS: the legs that actually executed. The
       * policy exit is a mark on a later path and stays a counterfactual, so it
       * is deliberately not settled here.
       */
      insertTrajectorySettlement(
        db,
        t.trajectoryId,
        'IMMEDIATE_MECHANICS',
        // The RE-DERIVED settlement, built after the raw evidence was written
        // and read back — not the provisional one `openTrajectory` returned.
        settlement,
        identityViolations,
        Date.now(),
      );

      /**
       * K-3 — `settleTrajectory()` IS CALLED.
       *
       * It was the only writer of the trajectory row's economics columns and
       * the collector never called it: `closeTrajectory()` set `state` and
       * `settled_utc_ms` and nothing else, so every economics column on
       * `development_trajectories` was permanently NULL — 0 of 292 — while
       * `trajectory_settlements` held 31 net PnL figures. Any consumer reading
       * the trajectory row rather than the settlement row saw a corpus with no
       * costs and no PnL at all.
       *
       * The affected row count is checked, because a zero-row update is a write
       * that went nowhere and reported success.
       */
      persistTrajectoryEconomics(db, t.trajectoryId, settlement, Date.now());

      // P6 — what the entry had to open, and who ends up owning it. Written
      // per leg, so a later exit leg's creations do not merge into the entry's.
      insertCreatedAccounts(db, t.trajectoryId, 'buy', t.createdAccounts, Date.now());
      if (t.requiresSharedSetup) {
        console.log(
          `              COLD_SETUP  paid ${t.setup.subsidyToOtherTradersLamports} lamports of rent ` +
            `for ${t.createdAccounts.filter((a) => a.sharedWithOtherTraders).length} shared account(s)`,
        );
      }
      opened++;
      if (!t.impact.withinSmallImpactBound) {
        // Named on the line, because a row whose exit is dominated by its own
        // footprint is not evidence about the market and must not read as if
        // it were.
        console.log(
          `              HIGH_IMPACT  entry is ${(t.impact.maxImpactRatio * 100).toFixed(1)}% of the pool ` +
            `(bound ${(t.impact.boundUsed * 100).toFixed(1)}%), haircut ${t.impact.haircutBps} bps`,
        );
      }
      console.log(
        `  ${c.mint.slice(0, 10)}  OPENED  acquired=${t.acquiredAtoms} soleVenue=${t.soleVenueAttributed} ` +
          `quoteState=${t.quoteStateSurvived}`,
      );
    }
  } finally {
    await worker.close();
  }

  /**
   * Item 55 — the grant, against rows that EXIST.
   *
   * After the open loop, so a cycle that opened nothing grants nothing. The
   * previous placement granted against selections and a cycle whose candidates
   * were all refused by the depth gate still recorded entitlement, which makes
   * the ledger a record of intent.
   */
  for (const [stratum, n] of openedPerStratum) {
    grantExploration(db, windowId, stratum, EXPLORATION_FRACTION, n, Date.now());
  }

  console.log('');
  console.log('opened trajectories :', opened);
  for (const [r, n] of Object.entries(refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${String(n).padStart(3)}  ${r}`);
  }

  // P7 — the mark half, on its own schedule. See `runMarkPass`.
  await runMarkPass(db, rpc, args, lanes, sessionId, evidence);

  /**
   * P7 — the count that settles F13 empirically.
   *
   * `sell accrued` is the number the repository's old claim said would always
   * be zero. If it stays zero while `buy accrued` climbs, the one-leg model was
   * right and this correction is wrong — which is why it is counted rather than
   * asserted.
   */
  /**
   * P10 — what the risk gates actually did.
   *
   * The refusal histogram is the larger and the more useful half. A screening
   * row is written for every token screened; the same rule holds here, because
   * a filter whose rejects are not stored can never be evaluated.
   */
  /**
   * How concentrated the corpus is. A study of three pools is not a study.
   *
   * The sampler returned the newest confirmed migrations every cycle with no
   * reference to what it had already sampled, so the first window's cycles 1
   * and 2 opened the SAME three mints. This line exists so that never goes
   * unnoticed again.
   */
  const spread = samplingSpread(db);
  console.log('');
  console.log(
    `sampling spread       : ${spread.trajectories} trajector(ies) across ${spread.distinctMints} mint(s), ` +
      `most-sampled mint has ${spread.maxPerMint}`,
  );

  const adm = admissionTotals(db);
  console.log('');
  console.log(`risk admission        : ${adm.admitted} admitted of ${adm.examined} examined`);
  for (const r of adm.topRefusals.slice(0, 5)) {
    console.log(`  refused ${String(r.n).padStart(4)}  ${r.reason.slice(0, 90)}`);
  }
  for (const s of adm.byStratum.slice(0, 5)) {
    console.log(`  stratum ${String(s.n).padStart(4)} (${s.admitted} admitted)  ${s.stratum}`);
  }

  /**
   * P5 - net PnL, or the reasons there is none.
   *
   * `buildTrajectorySettlement` was correct and unreachable for several
   * commits, so this line reports a quantity the system measured in full and
   * then discarded.
   */
  const ent = entitlements(db, args.windowId);
  const realised = explorationRealised(db);
  console.log('');
  console.log(
    `exploration           : realised ${realised.explore} explore / ${realised.exploit} exploit` +
      (realised.realisedFraction === null
        ? ''
        : ` (${(realised.realisedFraction * 100).toFixed(1)}% against a frozen ${(EXPLORATION_FRACTION * 100).toFixed(0)}%)`) +
      (realised.unassigned > 0 ? `, ${realised.unassigned} opened before the arm was recorded` : ''),
  );
  for (const e of ent.slice(0, 4)) {
    console.log(
      `  ${e.stratum.padEnd(26)} granted ${String(e.granted).padStart(4)}  consumed ${String(e.consumed).padStart(4)}` +
        `  remaining ${String(e.remaining).padStart(4)}`,
    );
  }

  const st = settlementTotals(db);
  console.log(
    `settlements           : ${st.settlements} (${st.withNetPnl} with net PnL) — ` +
      `net ${st.netPnlLamports} lamports, ${st.nonZeroUnexplained} with a non-zero unexplained remainder` +
      (st.withIdentityViolations > 0 ? `, ${st.withIdentityViolations} with IDENTITY VIOLATIONS` : ''),
  );
  for (const b of st.topBlockers.slice(0, 3)) {
    console.log(`  blocked ${String(b.n).padStart(4)}  ${b.reason.slice(0, 88)}`);
  }

  const cb = cashbackLegTotals(db);
  console.log(
    `cashback legs         : ${cb.legs} (${cb.cashbackCoinLegs} on cashback coins) — ` +
      `buy accrued ${cb.buyAccrued}, sell accrued ${cb.sellAccrued}, undetermined ${cb.undetermined}, ` +
      `accumulator gained ${cb.accumulatorGainLamports} lamports`,
  );
  console.log('trajectories by state :', JSON.stringify(trajectoryCounts(db)));

  db.close();
}

/**
 * P14 — the collector as a DAEMON.
 *
 * The mark-and-settle pass is already resumable: every invocation marks
 * whatever is due and settles whatever is complete, and all of its state lives
 * in the database. So a daemon is just that pass on a timer — no resident
 * scheduler, no in-memory queue, and a restart loses nothing but the current
 * sleep.
 *
 * That matters for horizons. A path only produces a real 60-minute mark if
 * something is alive to take it at sixty minutes; the first live run settled
 * eight paths whose marks were all fetched in one burst, giving five labels and
 * one instant. Running continuously is what makes the label true.
 *
 * This process still cannot trade. It owns no NAV, opens no capital-bearing
 * positions, imports no signer, and refuses to start in canary or live.
 */

/**
 * P7 — THE MARK AND SETTLE PASS, callable on its own schedule.
 *
 * Extracted from `runCycle` so it can run every few seconds while discovery
 * stays on its 300-second interval. The 8f73cef audit measured what happens
 * when they share a clock: 697 of 1,448 marks more than 60 seconds late, and
 * only 57 of 292 one-minute marks within 60 s of their horizon. A backfilled
 * horizon carries the right label on the wrong instant, so both exit policies
 * see the same prices and agree trivially — which makes the tournament unable
 * to distinguish the policies it exists to compare.
 *
 * Everything it needs is passed in. It holds no state of its own, because all
 * the scheduler state lives in the database — which is what makes a restart
 * resume rather than reset.
 */
async function runMarkPass(
  db: ReturnType<typeof openDb>,
  rpc: Awaited<ReturnType<typeof researchRpc>>['rpc'],
  args: Args,
  lanes: LaneContext | null,
  sessionId: string | null,
  evidence: EvidenceStore,
): Promise<void> {
  const count = (kind: string, detail?: string): void => {
    if (sessionId !== null) countResource(db, sessionId, kind, detail === undefined ? {} : { detail });
  };
  void evidence;
  /**
   * P9 — THE MARK AND SETTLE PASS.
   *
   * This is what makes the process a collector rather than an opener. It runs
   * on EVERY invocation over every still-open trajectory, so a path opened in
   * one run is marked by later runs and closes when its 60-minute horizon
   * arrives. Nothing has to stay resident for an hour, and a restart resumes
   * from the database rather than from memory.
   *
   * Marks are taken only for horizons that are actually DUE and not already
   * recorded. A mark taken early would be a 15-minute number observed at four
   * minutes, which is a different measurement wearing the right label.
   */
  const nowMs = Date.now();
  const openRaw = openTrajectories(db, 100);
  let marksTaken = 0;
  let settled = 0;
  let missedHorizons = 0;

  /**
   * P11 — THE URGENT QUEUE IS DRAINED FIRST.
   *
   * A vault that just moved 5% is the observation whose value decays fastest.
   * Serving it after a queue of routine marks is the same as not having
   * detected it, which would make the whole subscription theatre.
   *
   * `drainOrder`'s rule, applied to the actual work list: urgent trajectories
   * move to the front, and nothing is duplicated.
   */
  const urgentIds =
    sessionId === null ? [] : pendingUrgent(db, sessionId).map((u) => u.trajectory_id);
  const urgentSet = new Set(urgentIds);
  const open = [...openRaw.filter((t) => urgentSet.has(t.trajectoryId)), ...openRaw.filter((t) => !urgentSet.has(t.trajectoryId))];
  if (urgentIds.length > 0) {
    console.log(`urgent queue          : ${urgentIds.length} trajector(ies) ahead of ordinary marks`);
  }

  for (const t of open) {
    /**
     * P11 — watch this trajectory's vaults while it is open.
     *
     * Idempotent: `watch` returns early for an address already subscribed, so
     * a trajectory that survives many cycles subscribes once.
     */
    if (lanes?.vaults != null) {
      try {
        const addrs = poolAddressesFrom(
          accountSourceOf([await readPoolRow(rpc, canonicalPool(t.mint))]),
          canonicalPool(t.mint),
        );
        const set = {
          baseVault: addrs.poolBaseTokenAccount,
          quoteVault: addrs.poolQuoteTokenAccount,
          poolState: canonicalPool(t.mint),
          feeConfig: FEE_CONFIG_ADDR,
          mint: t.mint,
          creatorOrCashbackAccumulator: null,
        };
        lanes.vaults.watch(subscriptionFor(t.trajectoryId, set, nowMs), [
          addrs.poolBaseTokenAccount,
          addrs.poolQuoteTokenAccount,
        ]);
        count('solana_rpc', 'getAccountInfo');
      } catch {
        // A pool that will not read is a mark-time refusal, recorded there.
        // Failing the whole cycle over a subscription would stop collection.
      }
    }

    const already = recordedOffsets(db, t.trajectoryId);
    const due = MARK_OFFSETS_MS.filter((o) => !already.has(o) && nowMs >= t.openedUtcMs + o);

    for (const offsetMs of due) {
      const startedAt = Date.now();
      const m = await takeMark(rpc as never, {
        mint: t.mint,
        tokenAmount: t.acquiredAtoms,
        slippagePct: 3,
        globalConfig: GLOBAL_CONFIG_ADDR,
        feeConfig: FEE_CONFIG_ADDR,
        offsetMs,
        openedAtMs: t.openedUtcMs,
      });
      /**
       * P7.2 — the SLA verdict, on the row, at the instant it is written.
       *
       * Measured from the horizon the mark REPRESENTS, not from when the
       * scheduler got to it. A mark more than `markSlaMs` past its horizon is
       * `MISSED_HORIZON` — not interpolated, not backfilled, and not given the
       * horizon's name on a different instant, which is what 697 of 1,448
       * pre-repair marks did.
       */
      const dueUtcMs = t.openedUtcMs + offsetMs;
      const sla = classifyMark(dueUtcMs, m.atMs, args.markSlaMs);
      insertMark(db, t.trajectoryId, m, {
        dueUtcMs,
        status: sla.status,
        boundMs: args.markSlaMs,
      });
      if (sla.status === 'MISSED_HORIZON') {
        missedHorizons++;
        console.log(
          `  MISSED_HORIZON  ${t.mint.slice(0, 10)} +${offsetMs / 60_000}m late by ` +
            `${Math.round(sla.latenessMs / 1000)}s (SLA ${Math.round(args.markSlaMs / 1000)}s)`,
        );
      }
      marksTaken++;
      count('mark_jobs');
      count('solana_rpc', 'getAccountInfo');
      if (sessionId !== null) {
        // How long the mark itself took. Distinct from LATENESS, which is how
        // late the horizon was reached — one is apparatus, the other is
        // schedule, and merging them hides which is the constraint.
        recordLatency(db, sessionId, 'mark_lag', Date.now() - startedAt, startedAt);
      }
    }

    // Consumed, whether or not a horizon was due: the urgent signal has been
    // acted on by taking whatever this trajectory owed. Leaving it queued would
    // make the same 5% move jump the queue forever.
    if (sessionId !== null && urgentSet.has(t.trajectoryId)) {
      consumeUrgent(db, sessionId, t.trajectoryId, Date.now());
    }

    // A path closes only when every horizon exists. Settling a truncated path
    // would bias every policy toward whatever the collector happened to reach.
    const path = marksFor(db, t.trajectoryId);
    const complete = pathIsComplete(path);
    if (!complete.complete) continue;

    const outcomes = evaluateExitPolicies(path, {
      openedAtMs: t.openedUtcMs,
      policies: ['FIXED_15M_CONTROL', 'FLOW_LIQUIDITY_DETERIORATION_V1'],
      entryCashOutLamports: t.entryCashOutLamports,
    });
    for (const o of outcomes) insertPolicyOutcome(db, t.trajectoryId, t.entryCashOutLamports, o, nowMs);
    closeTrajectory(db, t.trajectoryId, nowMs);
    settled++;
    // P11 — release the subscription, by the addresses that were STORED.
    lanes?.vaults?.unwatch(t.trajectoryId);
    console.log(
      `  SETTLED ${t.trajectoryId.slice(0, 8)} ${t.mint.slice(0, 10)} ` +
        outcomes.map((o) => `${o.exitPolicy}=${o.grossDeltaLamports ?? 'unpriced'}`).join(' '),
    );
  }

  const counts = markAndOutcomeCounts(db);
  console.log('');
  console.log('open trajectories seen:', open.length);
  console.log('marks taken this run  :', marksTaken);
  console.log('settled this run      :', settled);
  // P7.2 — reported every pass, not discovered in an audit. A late mark is a
  // measurement that did not happen at the instant it claims.
  console.log('MISSED_HORIZON marks  :', missedHorizons);
  console.log(
    'totals                : marks',
    counts.marks,
    'outcomes',
    counts.outcomes,
    'settled',
    counts.settled,
    'plans',
    accountPlanCount(db),
  );

  // P6 — the cold/warm picture in lamports rather than in adjectives.
  //
  // `subsidy` is the hypothesis itself: rent this system paid to open accounts
  // that every later trader through the same pool gets for free. If it is a
  // large fraction of total drag, the answer is to wait for a warm pool, not to
  // trade a bigger size.
  const setup = setupEconomicsTotals(db);
  console.log(
    `setup accounts        : ${setup.accounts} across ${setup.trajectories} trajector(ies) — ` +
      `rent ${setup.totalRentLamports}, recoverable ${setup.recoverableLamports}, ` +
      `subsidy to other traders ${setup.subsidyLamports}` +
      (setup.unknownScope > 0 ? `, UNCLASSIFIED ${setup.unknownScope}` : ''),
  );

}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets();

  /**
   * P13 — the session, which is what "active seconds" means.
   *
   * The rate budget this replaces divided counts by ELAPSED WALL TIME, downtime
   * included: a process that ran twenty minutes out of a day reported "48
   * requests/day against a 10,000/day quota" and concluded quota was not the
   * constraint. That describes the downtime.
   *
   * Opened even for `--once`, because a single pass is still active time and
   * excluding it would understate the load.
   */
  const telemetryDb = openDb({ path: secrets.databasePath, skipBackup: true });
  const { host } = researchRpc(secrets as never);

  /**
   * P1.3 — THE PROVENANCE GATE, BEFORE ANYTHING IS WRITTEN.
   *
   * Read from git rather than asserted. 26 of 31 pre-repair collector sessions
   * were opened from a dirty tree, and a trajectory opened from an uncommitted
   * tree cannot be re-derived from its commit — which is this repository's
   * definition of not being evidence.
   */
  const tree = readTreeState();
  let contextValidity: 'DEVELOPMENT_EVIDENCE' | 'INSTRUMENT_DEVELOPMENT_INVALID';
  let contextReason: string | null;
  try {
    const v = evidenceContextValidity(tree, { instrumentDevelopment: args.instrumentDevelopment });
    contextValidity = v.validity;
    contextReason = v.reason;
  } catch (e) {
    if (e instanceof DirtyEvidenceCollection) {
      console.error(`\nREFUSED TO COLLECT.\n\n${e.message}\n`);
      telemetryDb.close();
      process.exit(2);
    }
    throw e;
  }
  if (contextValidity === 'INSTRUMENT_DEVELOPMENT_INVALID') {
    console.log('');
    console.log('=========================================================================');
    console.log('INSTRUMENT DEVELOPMENT RUN — this cycle produces NO admissible evidence.');
    console.log(`  ${contextReason}`);
    console.log('  Its context is permanently excluded from every report and from readiness.');
    console.log('=========================================================================');
  }

  /**
   * P1.1 — ONE SEMANTIC OWNER OF THE CANDIDATE QUEUE.
   *
   * Taken BEFORE a session is opened and before any candidate is read. The
   * audit's A-2: this program never imported `process_locks` at all, five
   * daemons ran against one 7.3 GB database, and `pnpm health` printed
   * `OK engine.collector pid 24924 alive in observe` — a row about
   * `apps/collector/src/main.ts`, a DIFFERENT program that happened to share
   * the lock name. What it cost, measured: 15 mints over a hard cap of 3, the
   * worst at 58.
   *
   * The OS lock file goes first because it covers the window before the
   * database is even open. It does not replace the database lock: a file lock
   * says nothing about who owns the queue in a corpus reachable by another path.
   */
  const lock = new TrajectoryCollectorLock(telemetryDb, {
    mode: modeFromArgv() ?? 'observe',
    sourceCommit: tree.commit,
  });
  const fileLock = lock.acquireFileLock();
  if (!fileLock.ok) {
    console.error(
      `\nREFUSED: another trajectory collector (pid ${fileLock.heldByPid}) holds the OS lock file.\n` +
        'Run `pnpm collector:list` to see it and `pnpm collector:stop-all` to stop it.\n',
    );
    telemetryDb.close();
    process.exit(3);
  }
  try {
    const owner = lock.acquire();
    console.log(`trajectory_collector lock held by pid ${owner.pid} at ${owner.sourceCommit.slice(0, 12)}`);
  } catch (e) {
    if (e instanceof CollectorLockRefused) {
      console.error(`\nREFUSED: ${e.message}\n`);
      lock.release();
      telemetryDb.close();
      process.exit(3);
    }
    throw e;
  }

  const commit = tree.commit;
  const dirty = tree.dirty;
  const session = openCollectorSession(telemetryDb, {
    mode: modeFromArgv() ?? 'observe',
    sourceCommit: commit,
    dirty,
    pid: process.pid,
    endpoint: host,
    nowMs: Date.now(),
  });

  /**
   * P8/P11 — the live lanes, owned here rather than per cycle.
   *
   * A websocket rebuilt every cycle would spend its life in backoff and would
   * report a coverage gap for every interval BETWEEN cycles — gaps describing
   * the collector's schedule rather than the chain's.
   */
  /**
   * P0.4 — the evidence context this run's rows belong to.
   *
   * Opened before the first cycle and named by the source commit, so a run from
   * a different commit is a different context by construction rather than by
   * anyone remembering to say so. A dirty run's context is created with
   * `INSTRUMENT_DEVELOPMENT_INVALID` and can never be promoted.
   */
  const evidenceContextId = `ctx-${commit.slice(0, 12)}-${args.windowId}${
    contextValidity === 'INSTRUMENT_DEVELOPMENT_INVALID' ? '-dirty' : ''
  }`;
  telemetryDb
    .prepare(
      `INSERT INTO evidence_contexts
         (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms, closed_utc_ms,
          validity, reasons, audit_artifact_hash, notes)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)
       ON CONFLICT(evidence_context_id) DO NOTHING`,
    )
    .run(
      evidenceContextId,
      createHash('sha256').update(`${commit}|${args.windowId}|${contextValidity}`).digest('hex'),
      commit,
      dirty ? 1 : 0,
      Date.now(),
      contextValidity,
      JSON.stringify(contextReason === null ? [] : [{ code: 'DIRTY_TREE', statement: contextReason }]),
      `opened by trajectory:collect pid ${process.pid}`,
    );

  const wsUrl = args.liveLane ? secrets.rpcWs : null;
  const lanes: LaneContext = {
    session,
    evidenceContextId,
    contextValidity,
    contractId: args.contractId,
    sourceCommit: commit,
    migrations:
      wsUrl === null
        ? null
        : new LiveMigrationLane({
            wsUrl,
            programs: MIGRATION_PROGRAMS,
            rpc: researchRpc(secrets as never).rpc as never,
            db: telemetryDb,
            sessionId: session.sessionId,
            persist: (m, reversal, nowMs) => insertConfirmedMigration(telemetryDb, m as never, reversal as never, nowMs),
          }),
    vaults: wsUrl === null ? null : new LiveVaultWatch({ wsUrl, db: telemetryDb, sessionId: session.sessionId }),
  };
  if (!args.liveLane) {
    console.log('live lanes OFF (pass --live-lane to enable).');
    console.log('  logsSubscribe cannot filter finer than "mentions this program", so the pump');
    console.log('  programs deliver every buy and sell: 219 messages/second measured, ~18.9M/day,');
    console.log('  to catch a few dozen migrations an hour. That is what exhausted both endpoints.');
    console.log('  The backfill lane reaches the same migrations for ONE account read per mint.');
  } else if (secrets.rpcWs === null) {
    console.log('--live-lane was requested but SOLANA_RPC_WS resolves to nothing, so it is off.');
  }
  lanes.migrations?.start();
  if (lanes.migrations != null) {
    // Connecting takes a moment. Draining in the same millisecond reports
    // DEGRADED and records a gap describing our own startup, which is noise in
    // the one surface that exists to make real gaps visible.
    const covered = await lanes.migrations.waitUntilCovered(10_000);
    if (!covered) console.log('the migration socket did not fully subscribe within 10s; coverage is degraded');
  }

  const finish = (): void => {
    closeCollectorSession(telemetryDb, session.sessionId, Date.now());
    // The lock is released BEFORE the handle closes, so the row is actually
    // deleted rather than left for a stale-takeover to reason about. Seven
    // pre-repair sessions never wrote `ended_utc_ms` because they were killed;
    // an orderly exit should not look the same.
    lock.release();
    telemetryDb.close();
  };

  if (!args.loop) {
    try {
      await runCycle(lanes);
    } finally {
      await lanes.migrations?.stop();
      await lanes.vaults?.stop();
      finish();
    }
    return;
  }

  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig}: finishing the current cycle, then stopping.`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  /**
   * P7 — TWO SCHEDULES, ONE PROCESS.
   *
   * The pre-repair daemon slept `intervalSeconds` between passes and did both
   * jobs at the top of each one, so a one-minute horizon was served by a
   * five-minute loop and 697 of 1,448 marks landed more than 60 seconds late.
   *
   *   MARKS      wake at the next mark deadline, or after `maxTickMs`,
   *              whichever is sooner
   *   DISCOVERY  every `intervalSeconds`, and only when no mark is already
   *              past its SLA (P7.3)
   *
   * Discovery is deliberately subordinate. Opening another trajectory while
   * deadlines are slipping trades a measurement we are already committed to for
   * one we are not, and the marks are the product.
   */
  console.log(
    `collector daemon: marks on a ${args.maxTickMs}ms tick (SLA ${args.markSlaMs}ms), ` +
      `discovery every ${args.intervalSeconds}s`,
  );
  let cycle = 0;
  let markPasses = 0;
  let lastDiscoveryMs = 0;

  while (!stopping) {
    const started = Date.now();
    const discoveryDue = started - lastDiscoveryMs >= args.intervalSeconds * 1_000;

    let ranDiscovery = false;
    if (discoveryDue) {
      const admissible = discoveryAdmissible(telemetryDb, {
        nowMs: started,
        offsets: MARK_OFFSETS_MS,
        slaMs: args.markSlaMs,
      });
      if (!admissible.admissible) {
        // Backpressure, stated. An operator reading "discovery deferred" knows
        // the collector is behind; an operator reading nothing concludes the
        // chain produced no migrations.
        console.log(`\ndiscovery deferred: ${admissible.reason}`);
        lastDiscoveryMs = started;
      } else {
        cycle++;
        ranDiscovery = true;
        console.log(`\n===== discovery cycle ${cycle} @ ${new Date(started).toISOString()} =====`);
        try {
          await runCycle(lanes);
        } catch (e) {
          /**
           * A cycle that throws must not kill the daemon.
           *
           * An apparatus failure is a fact about this cycle, and stopping on it
           * would silently end collection at the first RPC hiccup — which then
           * reads later as "the market produced nothing" rather than "we
           * stopped looking".
           */
          console.error(`cycle ${cycle} failed: ${(e as Error).message.slice(0, 200)}`);
        }
        lastDiscoveryMs = Date.now();
      }
    }

    if (!ranDiscovery) {
      markPasses++;
      try {
        await runCycle(lanes, { marksOnly: true });
      } catch (e) {
        console.error(`mark pass ${markPasses} failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    /**
     * The heartbeat advances whether the pass succeeded or threw.
     *
     * A pass that failed is still active time — the process was up, it spent
     * RPC, and it produced a refusal. Advancing only on success would make an
     * hour of failing passes look like an hour of downtime, and the two call
     * for opposite responses.
     */
    heartbeat(telemetryDb, session.sessionId, Date.now(), cycle);
    if (stopping) break;

    // Wake at the next MARK deadline, bounded by the tick. The discovery
    // interval never governs this sleep — that coupling is the whole defect.
    const now = Date.now();
    const untilMark = nextWakeMs(telemetryDb, {
      nowMs: now,
      offsets: MARK_OFFSETS_MS,
      maxTickMs: args.maxTickMs,
    });
    const untilDiscovery = Math.max(0, lastDiscoveryMs + args.intervalSeconds * 1_000 - now);
    const wait = Math.max(0, Math.min(untilMark, untilDiscovery, args.maxTickMs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  await lanes.migrations?.stop();
  await lanes.vaults?.stop();
  finish();
  console.log('collector daemon stopped.');
}

await main();
