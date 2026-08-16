import { execSync } from 'node:child_process';
import { loadSecrets, modeFromArgv } from '../../../packages/domain/src/config.js';
import { openDb } from '../../../packages/storage/src/db.js';
import { researchRpc } from '../../../packages/solana/src/endpoint.js';
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
  // Mints the screening stream has seen. `chain_events` identities are
  // untrustworthy (that is finding J), so the pool is DERIVED from the mint and
  // verified on chain rather than believed.
  const seen = db
    .prepare('SELECT DISTINCT mint FROM screenings WHERE mint IS NOT NULL ORDER BY rowid DESC LIMIT ?')
    .all(Math.max(200, limit * 40)) as { mint: string }[];

  for (const { mint } of seen) {
    if (found >= limit) break;
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
}

async function runCycle(lanes: LaneContext | null = null): Promise<void> {
  const mode = modeFromArgv() ?? 'observe';
  if (mode === 'canary' || mode === 'live') {
    throw new Error('trajectory:collect never runs in a mode that can trade');
  }
  const args = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);
  const db = openDb({ path: secrets.databasePath, skipBackup: true });
  const sessionId = lanes?.session.sessionId ?? null;
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
  const disc = await discover(db, rpc, args.maxCandidates);
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

  const candidates = migrationCandidates(db, args.maxCandidates);
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

  try {
    for (const c of candidates) {
      if (opened >= args.maxOpen) break;

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
        continue;
      }

      const t = res.trajectory;
      // P2/F12 — the plan goes in FIRST, keyed by the trajectory it belongs to.
      //
      // The capability fingerprint below is the snapshot hash, which says what
      // the market looked like. It does not say which fee recipient the SDK
      // picked or what the instruction's account order was, and those are the
      // things a replay has to reproduce exactly.
      insertTrajectory(db, {
        identity: {
          trajectoryId: t.trajectoryId,
          entryObservationId: t.entryObservationId,
          entrySimulationJobId: t.entrySimulationJobId,
          entrySettlementId: t.entrySettlementId,
          venue: 'PUMPSWAP_DIRECT',
          pool: t.pool,
          capabilityFingerprint: t.snapshotHash,
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
        entryPolicy: 'HARD_GATES_RANDOM',
        exitPolicy: 'FIXED_15M_CONTROL',
        state: 'AWAITING_FILL_OBSERVATION',
        impact: {
          quoteImpactRatio: 0,
          baseImpactRatio: 0,
          maxImpactRatio: 0,
          haircutBps: 0,
          withinSmallImpactBound: true,
          boundUsed: 0.005,
        },
        maxAttainableGrade: 'SIMULATED_EXECUTION',
        refusals: t.incompleteness,
        openedUtcMs: t.openedUtcMs,
      });

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
      console.log(
        `  ${c.mint.slice(0, 10)}  OPENED  acquired=${t.acquiredAtoms} soleVenue=${t.soleVenueAttributed} ` +
          `quoteState=${t.quoteStateSurvived}`,
      );
    }
  } finally {
    await worker.close();
  }

  console.log('');
  console.log('opened trajectories :', opened);
  for (const [r, n] of Object.entries(refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${String(n).padStart(3)}  ${r}`);
  }

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
      insertMark(db, t.trajectoryId, m);
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

  /**
   * P7 — the count that settles F13 empirically.
   *
   * `sell accrued` is the number the repository's old claim said would always
   * be zero. If it stays zero while `buy accrued` climbs, the one-leg model was
   * right and this correction is wrong — which is why it is counted rather than
   * asserted.
   */
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
  let commit = 'unknown';
  let dirty = true;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* provenance that cannot be read is recorded unknown, never omitted */
  }
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
  const wsUrl = secrets.rpcWs;
  const lanes: LaneContext = {
    session,
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
  if (wsUrl === null) {
    console.log('NO WEBSOCKET: SOLANA_RPC_WS is not configured, so the live lanes are off and');
    console.log('discovery falls back to history paging, which is structurally late.');
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

  console.log(`collector daemon: every ${args.intervalSeconds}s until stopped`);
  let cycle = 0;

  while (!stopping) {
    cycle++;
    const started = Date.now();
    console.log(`\n===== cycle ${cycle} @ ${new Date(started).toISOString()} =====`);
    try {
      await runCycle(lanes);
    } catch (e) {
      /**
       * A cycle that throws must not kill the daemon.
       *
       * An apparatus failure is a fact about this cycle, and stopping on it
       * would silently end collection at the first RPC hiccup — which then
       * reads later as "the market produced nothing" rather than "we stopped
       * looking".
       */
      console.error(`cycle ${cycle} failed: ${(e as Error).message.slice(0, 200)}`);
    }
    /**
     * The heartbeat advances whether the cycle succeeded or threw.
     *
     * A cycle that failed is still active time — the process was up, it spent
     * RPC, and it produced a refusal. Advancing only on success would make an
     * hour of failing cycles look like an hour of downtime, and the two call
     * for opposite responses.
     */
    heartbeat(telemetryDb, session.sessionId, Date.now(), cycle);
    if (stopping) break;
    const elapsed = Date.now() - started;
    const wait = Math.max(0, args.intervalSeconds * 1_000 - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  await lanes.migrations?.stop();
  await lanes.vaults?.stop();
  finish();
  console.log('collector daemon stopped.');
}

await main();
