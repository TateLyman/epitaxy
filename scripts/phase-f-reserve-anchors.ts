/**
 * Phase F §2.2 — the anchor inventory, before a single credit is spent.
 *
 * Rolling a constant-product pool's reserves forward or backward through its swap
 * stream needs ONE absolute reserve observation per pool. The directive ranks three
 * candidates and says to report which was used per pool, and that a pool without an
 * anchor is excluded and counted rather than estimated:
 *
 *   A  the collector's own stored pool bytes    (413 snapshots, 142 pools)
 *   B  the migration deposit, if it is a protocol constant for the era
 *   C  pool creation state from the initialising transaction
 *
 * This reads A out of the corpus and states exactly what it covers, because whether
 * A covers Phase C's positions decides whether §2 is a measurement or a plan. It
 * costs nothing and it runs first for that reason.
 *
 * Usage: pnpm anchors
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { accountSourceOf, poolFactsFrom } from '../packages/solana/src/pumpswap-offline.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

interface StoredAccount {
  pubkey: string;
  owner: string;
  dataBase64: string | null;
  lamports: string | number;
}

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const evidence = new EvidenceStore(db, 'data/evidence-blobs');

/** Phase C's window, so the overlap question is answered against a constant. */
const HOLD_START_MS = Date.UTC(2026, 6, 16);
const HOLD_END_MS = Date.UTC(2026, 7, 15);

const snapshots = db
  .prepare(
    `SELECT snapshot_hash AS hash, slot, captured_utc_ms AS captured, mint, pool,
            manifest_blob_sha256 AS manifest
       FROM coherent_snapshots
      ORDER BY captured_utc_ms ASC`,
  )
  .all() as { hash: string; slot: number; captured: number; mint: string; pool: string; manifest: string }[];

const migratedAtMs = new Map<string, number>();
for (const r of db
  .prepare(
    `SELECT mint, MIN(block_time) * 1000 AS ms FROM confirmed_migrations WHERE block_time IS NOT NULL GROUP BY mint`,
  )
  .all() as { mint: string; ms: number }[]) {
  migratedAtMs.set(r.mint, r.ms);
}

interface Anchor {
  readonly mint: string;
  readonly pool: string;
  readonly slot: number;
  readonly capturedUtcMs: number;
  readonly baseReserve: string | null;
  readonly quoteReserve: string | null;
  readonly readable: boolean;
  readonly failure: string | null;
  readonly migratedAtUtcMs: number | null;
  /** Whether this anchor's pool existed during Phase C's holdout window at all. */
  readonly migratedBeforeHoldEnd: boolean | null;
}

const anchors: Anchor[] = [];
for (const s of snapshots) {
  let baseReserve: string | null = null;
  let quoteReserve: string | null = null;
  let failure: string | null = null;
  try {
    const accounts = evidence.get<StoredAccount[]>(s.manifest);
    const src = accountSourceOf(
      accounts.map((a) => ({
        pubkey: a.pubkey,
        owner: a.owner,
        dataBase64: a.dataBase64,
        lamports: BigInt(a.lamports),
      })),
    );
    const facts = poolFactsFrom(src, s.pool);
    baseReserve = facts.baseReserve.toString();
    quoteReserve = facts.quoteReserveRaw.toString();
  } catch (err) {
    failure = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
  }
  const migrated = migratedAtMs.get(s.mint) ?? null;
  anchors.push({
    mint: s.mint,
    pool: s.pool,
    slot: s.slot,
    capturedUtcMs: s.captured,
    baseReserve,
    quoteReserve,
    readable: baseReserve !== null && quoteReserve !== null,
    failure,
    migratedAtUtcMs: migrated,
    migratedBeforeHoldEnd: migrated === null ? null : migrated < HOLD_END_MS,
  });
}

const readable = anchors.filter((a) => a.readable);
const pools = new Set(anchors.map((a) => a.pool));
const readablePools = new Set(readable.map((a) => a.pool));
const iso = (ms: number): string => new Date(ms).toISOString();

console.log('PHASE F §2.2 — ANCHOR INVENTORY (option A, the collector\'s own stored bytes)\n');
console.log(`  snapshots stored            ${anchors.length}`);
console.log(`  distinct pools             ${pools.size}`);
console.log(`  snapshots with READABLE reserves  ${readable.length}`);
console.log(`  pools with at least one     ${readablePools.size}`);
if (readable.length > 0) {
  console.log(
    `  captured span              ${iso(Math.min(...readable.map((a) => a.capturedUtcMs)))} .. ${iso(
      Math.max(...readable.map((a) => a.capturedUtcMs)),
    )}`,
  );
}
const failures = anchors.filter((a) => !a.readable);
if (failures.length > 0) {
  const byMessage = new Map<string, number>();
  for (const f of failures) byMessage.set(f.failure ?? 'unknown', (byMessage.get(f.failure ?? 'unknown') ?? 0) + 1);
  console.log(`\n  unreadable ${failures.length}, by reason:`);
  for (const [m, n] of [...byMessage.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${n} x ${m}`);
}

// -------------------------------------------------------------------------
// The question that decides the phase
// -------------------------------------------------------------------------
console.log(`\n  PHASE C's WINDOW is ${iso(HOLD_START_MS)} .. ${iso(HOLD_END_MS)}`);
const anchoredPoolsInWindow = readable.filter(
  (a) => a.migratedAtUtcMs !== null && a.migratedAtUtcMs < HOLD_END_MS,
);
const distinctInWindow = new Set(anchoredPoolsInWindow.map((a) => a.pool));
console.log(`  anchored pools whose migration PRECEDES the window end: ${distinctInWindow.size} of ${readablePools.size}`);
console.log(`  migration timestamps known for ${readable.filter((a) => a.migratedAtUtcMs !== null).length} of ${readable.length} readable snapshots`);
if (readable.some((a) => a.migratedAtUtcMs !== null)) {
  const ms = readable.map((a) => a.migratedAtUtcMs).filter((x): x is number => x !== null);
  console.log(`  known migrations span      ${iso(Math.min(...ms))} .. ${iso(Math.max(...ms))}`);
}

console.log('\n  WHAT THIS MEANS FOR §2, stated before any credit is spent:');
if (distinctInWindow.size === 0) {
  console.log('    NO anchored pool existed during Phase C\'s holdout window. Option A cannot anchor a');
  console.log('    reconstruction of Phase C\'s positions: every stored snapshot is of a pool that migrated');
  console.log('    AFTER the window closed, so rolling backwards from it reaches a pool that did not yet');
  console.log('    exist. §2.4 is therefore not reachable through option A, and the directive\'s own rule —');
  console.log('    a pool without an anchor is excluded and counted, not estimated — excludes all of them.');
  console.log('    Option B, the migration deposit as a protocol constant, is the only remaining route, and');
  console.log('    these 142 pools are exactly the sample on which B can be VALIDATED rather than assumed.');
} else {
  console.log(`    ${distinctInWindow.size} anchored pools overlap the window and option A can price them directly.`);
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/phase-f-anchors.json',
  `${JSON.stringify(
    {
      provenance: currentProvenance({
        strategyVersion: 'delayed-momentum-v0.6.0',
        schemaVersion: 'phase-f-anchors-v1',
        sampleInclusionQuery:
          'every coherent_snapshots row, with the pool base and quote reserves decoded from the stored ' +
          'account bytes through poolFactsFrom, joined to confirmed_migrations for the pool migration time',
      }),
      label: 'DEVELOPMENT_RECONSTRUCTED',
      isEvidence: false,
      directive: 'Phase F §2.2',
      holdWindowUtc: { start: iso(HOLD_START_MS), end: iso(HOLD_END_MS) },
      snapshots: anchors.length,
      pools: pools.size,
      readableSnapshots: readable.length,
      readablePools: readablePools.size,
      anchoredPoolsOverlappingPhaseCWindow: distinctInWindow.size,
      optionAViableForPhaseC: distinctInWindow.size > 0,
      anchors,
    },
    null,
    2,
  )}\n`,
);
console.log('\n  artifact           artifacts/phase-f-anchors.json');
db.close();
