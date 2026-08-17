import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { entitlements, explorationRealised } from '../packages/storage/src/exploration-repo.js';
import { EXPLORATION_FRACTION } from '../packages/strategy/src/exploration.js';

/**
 * Item 55 / P12 — `pnpm exploration:status`, which reports on EXPLORATION.
 *
 * It aliased `cohort:status`. That command answers which CELLS ARE
 * UNDER-FILLED, which is a different question from HOW MUCH EXPLORATION BUDGET
 * REMAINS — and the alias is exactly why nobody noticed that the exploration
 * arm had never run at all. `allocate()` existed, was tested, was pure, and no
 * production caller invoked it, so 100% of the budget went to the ranking while
 * a command called `exploration:status` printed a healthy-looking report about
 * something else.
 *
 * Two numbers, deliberately kept apart:
 *
 *   GRANTED / CONSUMED   the ledger: what the design allowed and what was spent
 *   REALISED             the corpus: what fraction of rows came from the draw
 *
 * They can disagree — a stratum can run out of candidates with entitlement
 * unspent — and only comparing them shows it. One number would hide whichever
 * half was inconvenient.
 */

function main(): void {
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });
  const ledger = entitlements(db);
  const realised = explorationRealised(db);

  const byWindow = new Map<string, { granted: number; consumed: number }>();
  for (const e of ledger) {
    const cur = byWindow.get(e.windowId) ?? { granted: 0, consumed: 0 };
    byWindow.set(e.windowId, { granted: cur.granted + e.granted, consumed: cur.consumed + e.consumed });
  }
  db.close();

  let sourceCommit = 'unknown';
  let dirty = true;
  try {
    sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* unknown provenance is reported, never omitted */
  }

  console.log('exploration:status — entitlement, and what was actually drawn');
  console.log('');
  console.log(`frozen fraction        : ${(EXPLORATION_FRACTION * 100).toFixed(0)}%`);
  console.log('');

  if (ledger.length === 0) {
    console.log('NO ENTITLEMENT HAS EVER BEEN GRANTED.');
    console.log('The exploration arm has not run. This is not "0% explored by choice" —');
    console.log('it is an arm that was never allocated a budget.');
  } else {
    console.log('ledger, by window and stratum:');
    for (const e of ledger) {
      console.log(
        `  ${e.windowId.padEnd(18)} ${e.stratum.padEnd(26)} granted ${String(e.granted).padStart(4)}` +
          `  consumed ${String(e.consumed).padStart(4)}  remaining ${String(e.remaining).padStart(4)}`,
      );
    }
    console.log('');
    for (const [w, t] of byWindow) {
      console.log(`  ${w}: ${t.consumed} of ${t.granted} spent`);
    }
  }

  console.log('');
  console.log('realised, from the trajectory rows:');
  console.log(`  explore    ${String(realised.explore).padStart(5)}`);
  console.log(`  exploit    ${String(realised.exploit).padStart(5)}`);
  console.log(
    `  unassigned ${String(realised.unassigned).padStart(5)}  ` +
      '(opened before the arm was recorded; NOT counted as exploitation)',
  );
  console.log(
    `  realised fraction ${
      realised.realisedFraction === null ? 'n/a' : (realised.realisedFraction * 100).toFixed(1) + '%'
    }`,
  );

  if (realised.realisedFraction !== null && realised.realisedFraction < EXPLORATION_FRACTION * 0.5) {
    console.log('');
    console.log('WARNING: the realised fraction is far below the frozen one. Either strata are');
    console.log('running out of candidates before their entitlement is spent, or the arm is not');
    console.log('reaching the open path. Both are apparatus facts, not market facts.');
  }

  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/exploration-status.json',
    JSON.stringify(
      {
        artifact: 'exploration-status',
        directiveSection: 'item 55',
        generatedUtcMs: Date.now(),
        sourceCommit,
        dirty,
        frozenFraction: EXPLORATION_FRACTION,
        ledger,
        byWindow: [...byWindow.entries()].map(([windowId, t]) => ({ windowId, ...t })),
        realised,
        supersedes: 'the cohort:status alias, which answers which cells are under-filled',
        notClaimed:
          'an entitlement is a budget, not an outcome. A spent entitlement says the draw happened, ' +
          'not that the drawn rows were informative.',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/exploration-status.json');
}

main();
