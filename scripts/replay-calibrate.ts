import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { SequentialWorker } from '../packages/simulator/src/sequential-worker.js';
import { openTrajectory, encodeForPayer } from '../packages/pipeline/src/open-trajectory.js';
import { standardReplayBuild } from '../packages/pipeline/src/sequential-round-trip.js';
import { fetchInterveningEvents, windowFrom } from '../packages/pipeline/src/event-source.js';
import { replayPlan, planIsUsable, replayEvidenceClass } from '../packages/pipeline/src/event-replay.js';
import { seedActor, sharedActorCaveat, REPLAY_ACTOR } from '../packages/pipeline/src/replay-actor.js';
import { poolAddressesFrom, accountSourceOf, canonicalPool } from '../packages/solana/src/pumpswap-offline.js';

/**
 * Item 49 — `pnpm replay:calibrate`, the production caller for full event replay.
 *
 * ## Why this is two phases
 *
 * A replay needs the LOCAL post-entry state and the trades that happened after
 * it. Those trades take a holding period to happen, and the collector does not
 * persist entry snapshots — so a settled row in the corpus cannot be replayed
 * after the fact. There is no way to fake this: the state has to be kept from
 * the moment of entry.
 *
 *   --arm <mint>      capture the coherent snapshot, record the slot, keep both
 *   --settle <file>   fetch the intervening trades, replay them, price the exit
 *
 * ## What it produces, and what it does NOT
 *
 * It produces the exact exit: proceeds priced against a pool containing both
 * our entry and everything that traded after it. That number is the reference
 * `BOUNDED_COUNTERFACTUAL_TRAJECTORY` is calibrated against.
 *
 * It does NOT make the bounded class confirmatory. One replayed trajectory is a
 * measurement, not a calibration; the bound and the haircut are frozen only
 * after a subset large enough to characterise the error. Until then this script
 * writes evidence and `docs/FUTURE_COUNTERFACTUAL_CALIBRATION.md` continues to
 * say the bound is uncalibrated.
 */

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const ARMED_DIR = 'artifacts/replay-armed';

interface ArmedFile {
  readonly mint: string;
  readonly pool: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseTokenProgram: string;
  readonly entrySlot: number;
  readonly armedUtcMs: number;
  readonly notionalLamports: string;
  readonly slippagePct: number;
  readonly isCashbackCoin: boolean;
  readonly snapshot: {
    accounts: { pubkey: string; dataBase64: string; owner: string; lamports: string; executable?: boolean; rentEpoch?: string }[];
    programs: { programId: string; elfBase64: string }[];
    slot: number;
    unixTimestamp: number;
  };
}

function provenance(): { sourceCommit: string; dirty: boolean } {
  try {
    return {
      sourceCommit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      dirty: execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0,
    };
  } catch {
    // Unknown provenance is REPORTED, never omitted.
    return { sourceCommit: 'unknown', dirty: true };
  }
}

async function arm(mint: string): Promise<void> {
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);
  const pool = canonicalPool(mint);
  const poolRaw = await rpc.getAccountRaw(pool);
  const addrs = poolAddressesFrom(
    accountSourceOf([{ pubkey: pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports }]),
    pool,
  );
  const baseTokenProgram = (await rpc.getAccountRaw(mint)).owner;

  console.log(`arming ${mint} on ${host}`);
  console.log(`  pool        ${pool}`);
  console.log(`  base vault  ${addrs.poolBaseTokenAccount}`);
  console.log(`  quote vault ${addrs.poolQuoteTokenAccount}`);

  /**
   * The open runs for real, and its snapshot is KEPT.
   *
   * Running it is not incidental: capturing a snapshot nobody executed would
   * leave the settle phase replaying onto a state no entry ever committed
   * against, which is the pre-entry pool wearing a post-entry label.
   */
  let captured: ArmedFile['snapshot'] | null = null;
  const worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });
  const res = await openTrajectory(rpc as never, worker, {
    mint,
    taker: secrets.paperTakerPubkey as string,
    notionalLamports: 20_000_000n,
    slippagePct: 3,
    isCashbackCoin: false,
    captureSnapshot: async (accounts, programs) => {
      const s = (await captureSnapshot(rpc, [], {
        extraAccounts: [...accounts],
        extraPrograms: [...programs],
      })) as never as {
        accounts: { pubkey: string; dataBase64: string; owner: string; lamports: bigint; executable?: boolean; rentEpoch?: bigint }[];
        programs: { programId: string; elfBase64: string }[];
        slot: number;
        unixTimestamp: number;
      };
      /**
       * MERGED across calls, never overwritten.
       *
       * `openTrajectory` captures twice: the coherent snapshot first, then a
       * second read for the plan accounts the SDK selected — fee recipients,
       * ATAs, builtin programs — which cannot be predicted from a pool address.
       * Keeping only the last call armed 4 accounts and 2 programs, which is a
       * runtime no swap can execute in, and the settle phase would have read it
       * as a fact about the pool.
       *
       * The FIRST call's slot and timestamp are kept: that is the coherent
       * capture, and the second read is explicitly not price-bearing.
       */
      const rows = s.accounts.map((a) => ({
        pubkey: a.pubkey,
        dataBase64: a.dataBase64,
        owner: a.owner,
        lamports: a.lamports.toString(),
        ...(a.executable === undefined ? {} : { executable: a.executable }),
        ...(a.rentEpoch === undefined ? {} : { rentEpoch: a.rentEpoch.toString() }),
      }));
      const progs = s.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 }));
      if (captured === null) {
        captured = { accounts: rows, programs: progs, slot: s.slot, unixTimestamp: s.unixTimestamp };
      } else {
        const have = new Set(captured.accounts.map((a) => a.pubkey));
        const havePrograms = new Set(captured.programs.map((x) => x.programId));
        captured = {
          accounts: [...captured.accounts, ...rows.filter((a) => !have.has(a.pubkey))],
          programs: [...captured.programs, ...progs.filter((x) => !havePrograms.has(x.programId))],
          slot: captured.slot,
          unixTimestamp: captured.unixTimestamp,
        };
      }
      return s as never;
    },
  });
  await worker.close();

  if (captured === null) {
    console.log('REFUSED: the open path never reached the snapshot capture, so there is nothing to arm.');
    return;
  }
  if (!res.ok) {
    // Armed anyway. The snapshot is what the settle phase needs, and a mechanics
    // refusal is a fact about the entry, not about the state.
    console.log(`  the entry refused (${res.refusal}: ${res.detail.slice(0, 80)}) — arming the snapshot regardless`);
  }

  const snap: ArmedFile['snapshot'] = captured;
  const armed: ArmedFile = {
    mint,
    pool,
    baseVault: addrs.poolBaseTokenAccount,
    quoteVault: addrs.poolQuoteTokenAccount,
    baseTokenProgram,
    entrySlot: snap.slot,
    armedUtcMs: Date.now(),
    notionalLamports: '20000000',
    slippagePct: 3,
    isCashbackCoin: false,
    snapshot: snap,
  };

  mkdirSync(ARMED_DIR, { recursive: true });
  const path = `${ARMED_DIR}/${mint.slice(0, 12)}-${armed.entrySlot}.json`;
  writeFileSync(path, JSON.stringify(armed));
  console.log('');
  console.log(`armed at slot ${armed.entrySlot} (${snap.accounts.length} accounts, ${snap.programs.length} programs)`);
  console.log(`wrote ${path}`);
  console.log('');
  console.log('Let a holding period pass, then:');
  console.log(`  pnpm replay:calibrate --settle=${path}`);
}

async function settle(path: string): Promise<void> {
  if (!existsSync(path)) {
    console.log(`no armed file at ${path}`);
    return;
  }
  const armed = JSON.parse(readFileSync(path, 'utf8')) as ArmedFile;
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);
  const exitSlot = await rpc.getSlot();

  console.log(`settling ${armed.mint} on ${host}`);
  console.log(`  entry slot ${armed.entrySlot} → exit slot ${exitSlot} (${exitSlot - armed.entrySlot} slots held)`);

  const listing = await fetchInterveningEvents(rpc, {
    baseVault: armed.baseVault,
    quoteVault: armed.quoteVault,
    entrySlot: armed.entrySlot,
    exitSlot,
  });
  const plan = replayPlan({ events: listing.events, window: windowFrom(listing, armed.entrySlot, exitSlot) });

  console.log('');
  console.log(`intervening events    : ${plan.steps.length} replayable, ${plan.inert} inert`);
  console.log(`failed, excluded      : ${listing.failedExcluded}`);
  console.log(`unreadable            : ${listing.unreadable.length}`);
  if (plan.refusals.length > 0) {
    console.log('');
    console.log('REFUSED. A replay with a hole in it is a pool at the wrong reserves for every');
    console.log('event after the hole, presented as the exact reference the bounded class is');
    console.log('calibrated against. The trajectory keeps its bounded class, with the reason:');
    for (const r of plan.refusals.slice(0, 8)) console.log(`  ${r.code}  ${r.detail}`);
    writeArtifact({ armed, exitSlot, listing, plan, replay: null });
    return;
  }

  const seed = seedActor({
    steps: plan.steps,
    baseMint: armed.mint,
    baseTokenProgram: armed.baseTokenProgram,
  });
  if (seed.refusals.length > 0) {
    console.log('');
    console.log('REFUSED at the seed:');
    for (const r of seed.refusals) console.log(`  ${r.code}  ${r.detail}`);
    writeArtifact({ armed, exitSlot, listing, plan, replay: null });
    return;
  }
  console.log(
    `replay actor          : ${REPLAY_ACTOR} seeded ${seed.baseAtomsSeeded} base atoms, ${seed.lamportsSeeded} lamports`,
  );

  /**
   * The ARMED snapshot, plus the actor. Nothing captured is modified.
   *
   * Re-capturing here would replay the intervening trades onto TODAY's pool,
   * which already contains them — the events would be applied twice and the
   * result would look like a much larger price move than happened.
   */
  const blockhash = '11111111111111111111111111111111';
  const worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });
  const res = await openTrajectory(rpc as never, worker, {
    mint: armed.mint,
    taker: secrets.paperTakerPubkey as string,
    notionalLamports: BigInt(armed.notionalLamports),
    slippagePct: armed.slippagePct,
    isCashbackCoin: armed.isCashbackCoin,
    captureSnapshot: async () => ({
      accounts: [
        ...armed.snapshot.accounts.map((a) => ({
          pubkey: a.pubkey,
          dataBase64: a.dataBase64,
          owner: a.owner,
          lamports: BigInt(a.lamports),
          ...(a.executable === undefined ? {} : { executable: a.executable }),
          ...(a.rentEpoch === undefined ? {} : { rentEpoch: BigInt(a.rentEpoch) }),
        })),
        ...seed.accounts,
      ],
      programs: armed.snapshot.programs,
      slot: armed.snapshot.slot,
      unixTimestamp: armed.snapshot.unixTimestamp,
    }),
    intervening: {
      steps: plan.steps,
      // Slippage wide on purpose: an intervening trade must LAND. A refused one
      // leaves the pool at reserves mainnet never had, and the honest answer to
      // "it would not have gone through at our prices" is a landed trade at our
      // prices, not a missing one.
      build: standardReplayBuild({
        pool: armed.pool,
        actor: REPLAY_ACTOR,
        slippagePct: 100,
        blockhash,
        encode: (ixs, bh) => encodeForPayer(ixs, REPLAY_ACTOR, bh),
      }),
    },
  });
  await worker.close();

  console.log('');
  if (!res.ok) {
    console.log(`REFUSED: ${res.refusal}  ${res.detail.slice(0, 120)}`);
    writeArtifact({ armed, exitSlot, listing, plan, replay: null });
    return;
  }

  const t = res.trajectory;
  const klass = replayEvidenceClass(plan);
  console.log(`class                 : ${klass.klass}`);
  console.log(`acquired              : ${t.acquiredAtoms} atoms`);
  console.log(`self impact           : ${t.selfImpactLamports ?? 'unmeasured'} lamports`);
  console.log('');
  const caveat = sharedActorCaveat(plan.steps);
  if (caveat !== null) console.log(`CAVEAT: ${caveat}`);

  /**
   * The BOUNDED number for the same horizon, from the corpus.
   *
   * Printed beside the replayed one because the error between them is the whole
   * point. Absent when this mint has no marked trajectory, and absent is said
   * rather than substituted with a zero.
   */
  const db = openDb({ path: secrets.databasePath, readonly: true });
  const mark = db
    .prepare(
      `SELECT m.offset_ms, m.executable_lamports
         FROM trajectory_marks m
         JOIN development_trajectories d ON d.trajectory_id = m.trajectory_id
        WHERE d.mint = ? AND m.executable_lamports IS NOT NULL
        ORDER BY m.observed_utc_ms DESC LIMIT 1`,
    )
    .get(armed.mint) as { offset_ms: number; executable_lamports: string } | undefined;
  db.close();

  if (mark === undefined) {
    console.log('bounded comparison    : none — this mint has no marked trajectory in the corpus');
  } else {
    console.log(
      `bounded comparison    : mark at ${mark.offset_ms}ms = ${mark.executable_lamports} lamports (uncalibrated)`,
    );
  }
  console.log('');
  console.log('NOT CLAIMED: one replayed trajectory is a measurement, not a calibration. The');
  console.log('bounded class stays uncalibrated until a subset large enough to characterise');
  console.log('its error has been replayed and the bound and haircut frozen against it.');

  writeArtifact({
    armed,
    exitSlot,
    listing,
    plan,
    replay: {
      acquiredAtoms: t.acquiredAtoms.toString(),
      selfImpactLamports: t.selfImpactLamports === null ? null : t.selfImpactLamports.toString(),
      quoteStateSurvived: t.quoteStateSurvived,
      caveat,
      boundedMark: mark === undefined ? null : { offsetMs: mark.offset_ms, lamports: mark.executable_lamports },
    },
  });
}

function writeArtifact(p: {
  armed: ArmedFile;
  exitSlot: number;
  listing: Awaited<ReturnType<typeof fetchInterveningEvents>>;
  plan: ReturnType<typeof replayPlan>;
  replay: Record<string, unknown> | null;
}): void {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/replay-calibrate.json',
    JSON.stringify(
      {
        artifact: 'replay-calibrate',
        directiveSection: 'item 49 / P9',
        generatedUtcMs: Date.now(),
        ...provenance(),
        mint: p.armed.mint,
        pool: p.armed.pool,
        entrySlot: p.armed.entrySlot,
        exitSlot: p.exitSlot,
        heldSlots: p.exitSlot - p.armed.entrySlot,
        listing: {
          listedFromSlot: p.listing.listedFromSlot,
          listedToSlot: p.listing.listedToSlot,
          truncated: p.listing.truncated,
          failedExcluded: p.listing.failedExcluded,
          unreadable: p.listing.unreadable,
        },
        plan: {
          steps: p.plan.steps.map((s) => ({ ...s, inputAmount: s.inputAmount.toString() })),
          inert: p.plan.inert,
          refusals: p.plan.refusals,
          usable: planIsUsable(p.plan),
        },
        evidenceClass: replayEvidenceClass(p.plan),
        replay: p.replay,
        notClaimed:
          'a replayed exit is exact for THIS trajectory. It does not calibrate the bounded ' +
          'class until a subset has been replayed and the bound and haircut frozen against it.',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/replay-calibrate.json');
}

async function main(): Promise<void> {
  const mint = arg('arm');
  const file = arg('settle');
  if (mint !== null) return arm(mint);
  if (file !== null) return settle(file);
  console.log('replay:calibrate — full event replay for a calibration subset (item 49)');
  console.log('');
  console.log('  pnpm replay:calibrate --arm=<mint>      capture and keep the entry state');
  console.log('  pnpm replay:calibrate --settle=<file>   replay the intervening trades');
  console.log('');
  console.log('Two phases because the trades a replay needs take a holding period to happen,');
  console.log('and the collector does not persist entry snapshots — a settled row in the');
  console.log('corpus cannot be replayed after the fact.');
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
