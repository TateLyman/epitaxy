import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb, MIGRATIONS } from '../packages/storage/src/db.js';

const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const applied = db.prepare('SELECT MAX(id) AS m FROM schema_migrations').get() as { m: number };
console.log(`schema applied ${applied.m} of ${MIGRATIONS.reduce((a, x) => (x.id > a ? x.id : a), 0)}`);

for (const [label, sql] of [
  ['simulation_jobs', 'SELECT COUNT(*) c FROM simulation_jobs'],
  ['  SIMULATED_OK', "SELECT COUNT(*) c FROM simulation_jobs WHERE status='SIMULATED_OK'"],
  ['  SIMULATION_FAILED', "SELECT COUNT(*) c FROM simulation_jobs WHERE status='SIMULATION_FAILED'"],
  ['  UNAVAILABLE/UNKNOWN', "SELECT COUNT(*) c FROM simulation_jobs WHERE status LIKE '%UNAVAIL%' OR status LIKE '%UNKNOWN%'"],
  ['observations simulated', "SELECT COUNT(*) c FROM execution_observations WHERE simulation != 'NOT_SIMULATED'"],
  ['observations with exact bytes', 'SELECT COUNT(*) c FROM execution_observations WHERE exact_transaction_blob IS NOT NULL'],
  ['observations with blockhash', 'SELECT COUNT(*) c FROM execution_observations WHERE blockhash IS NOT NULL'],
  ['shadows with a cohort', 'SELECT COUNT(*) c FROM shadow_positions WHERE cohort IS NOT NULL'],
  ['rejects classified', 'SELECT COUNT(*) c FROM reject_tracking WHERE outcome IS NOT NULL'],
] as [string, string][]) {
  try {
    const r = db.prepare(sql).get() as { c: number };
    console.log(`${label.padEnd(30)} ${r.c}`);
  } catch (e) {
    console.log(`${label.padEnd(30)} ERR ${(e as Error).message.slice(0, 60)}`);
  }
}

const recent = db.prepare("SELECT purpose, blockhash, exact_transaction_blob, instruction_policy, simulation FROM execution_observations ORDER BY rowid DESC LIMIT 6").all() as any[];
console.log('recent observations:');
for (const r of recent) console.log(`  ${String(r.purpose).padEnd(26)} bh=${r.blockhash === null ? 'NULL' : 'set'} blob=${r.exact_transaction_blob === null ? 'NULL' : 'set'} ix=${r.instruction_policy} sim=${r.simulation}`);

const ctx = db.prepare('SELECT data_regime_id AS d, source_commit AS s FROM run_contexts ORDER BY rowid DESC LIMIT 2').all() as {
  d: string;
  s: string;
}[];
console.log('\nlatest run contexts:');
for (const c of ctx) console.log(`  ${c.d}  ${c.s}`);
