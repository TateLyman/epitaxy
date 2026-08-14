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
import { mechanicsStratum } from '../../../packages/solana/src/cashback.js';
import {
  insertConfirmedMigration,
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

interface Args {
  readonly discoverOnly: boolean;
  readonly maxCandidates: number;
  readonly once: boolean;
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

async function main(): Promise<void> {
  const mode = modeFromArgv() ?? 'observe';
  if (mode === 'canary' || mode === 'live') {
    throw new Error('trajectory:collect never runs in a mode that can trade');
  }
  const args = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);
  const db = openDb({ path: secrets.databasePath, skipBackup: true });

  console.log(`trajectory:collect  mode=${mode}  endpoint=${host}`);
  console.log('this process owns no capital: no NAV, no free capital, no portfolio position limit');
  console.log('');

  const disc = await discover(db, rpc, args.maxCandidates);
  console.log(`discovery: ${disc.found} confirmed migration(s) recorded`);
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
   * Deliberately stops here for now.
   *
   * Opening a trajectory requires the one-pass sequential worker (P3) to execute
   * the buy and then build the sell from the buy-mutated state inside the same
   * runtime. Until that exists, opening one would mean pricing the exit from a
   * state that does not contain the entry — which is the exact approximation
   * this directive forbids being made silently.
   *
   * So the collector discovers, snapshots and reports viability, and refuses to
   * manufacture an entry it cannot measure. That refusal is the finding.
   */
  console.log('');
  console.log('NOT OPENING TRAJECTORIES: the one-pass sequential worker (P3) is not built.');
  console.log('Opening one would price the exit from a state that never contained the entry.');

  db.close();
}

await main();
