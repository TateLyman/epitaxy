import { writeArtifact } from './_artifact.js';
import { execSync } from 'node:child_process';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { buildReadiness } from '../packages/research/src/readiness.js';

/**
 * `pnpm readiness` — P18. Machine-generated canary readiness.
 *
 * Read-only, and it starts nothing. A green verdict here is a statement that
 * the evidence exists; funding a wallet and running `pnpm canary` remains a
 * human act, and `.claude/hooks/guard.mjs` blocks the assistant from either.
 */

function commit(): string {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

const config = loadConfig();
const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const report = buildReadiness(db, commit(), config.strategyVersion, Date.now());

console.log(`canary readiness — ${report.verdict}\n`);
console.log(`  confirmatory positions   ${report.confirmatoryTrades}`);
console.log(`  valid development        ${report.validDevelopmentTrades}\n`);

const width = Math.max(...report.gates.map((x) => x.id.length));
for (const x of report.gates) {
  console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.id.padEnd(width)}  ${x.observed}`);
  if (!x.pass) console.log(`        ${' '.repeat(width)}  requires ${x.required}`);
}

console.log(`\n${report.blockers.length} blocker(s)`);
if (!report.allPass) {
  console.log('\nDo not weaken a failed gate. A gate that was moved to make a run possible');
  console.log('is not evidence about the strategy, it is evidence about the operator.');
}

/**
 * Q-1 — ITS OWN FILE, not the trajectory gate's.
 *
 * This script and `scripts/trajectory-readiness.ts` both wrote
 * `artifacts/readiness.json`. The NAMES were separate; the ARTIFACT was not, so
 * whichever ran last owned the file a downstream reader keys on. The audit
 * caught it live: after this script ran, the file documented as the exact
 * trajectory contract held a report about 519 canary-shadow positions, and both
 * carry `verdict: "NOT_READY"` — so a consumer could not tell which experiment
 * had answered.
 *
 * `writeArtifact` refuses a path, so the two cannot be pointed at one file
 * again by accident.
 */
const artifactPath = writeArtifact('position-readiness.json', {
  artifact: 'position-readiness',
  gate: 'LEGACY_POSITION_CONTRACT',
  note: 'The paper/shadow POSITION book. A trajectory is not a position — see pnpm readiness.',
  ...(report as unknown as Record<string, unknown>),
});
console.log(`\n-> ${artifactPath}`);
db.close();
