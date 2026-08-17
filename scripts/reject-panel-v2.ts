import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { panelStatus, dueMarks } from '../packages/storage/src/prospective-repo.js';
import { REJECT_PANEL_V1 } from '../packages/domain/src/reject-panel.js';

/**
 * Item / P12 — `pnpm reject:panel-v2`, which reports on a PROSPECTIVE panel.
 *
 * It aliased `trajectory-status.ts`. That command answers what the OPENED
 * trajectories are doing, which is the opposite population from the one a
 * reject panel is about — and while the alias stood, the thing the command
 * claimed to measure did not exist at all.
 *
 * `reject_tracking` still holds thousands of rows and they are still useful,
 * but they are not this. They record THAT a token was rejected, not the STATE
 * it was rejected on, so a panel scored from them is scored against state
 * fetched later: the pool has traded, the reserves have moved, and the thing
 * being scored is no longer the thing the filter saw. Those rows are reported
 * here as what they are — a retrospective corpus — and are never merged into
 * the prospective count.
 */

function main(): void {
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });

  /**
   * "The migration has not run" and "the panel has no rows" are different
   * facts, and only one of them is about the study. Conflating them would let
   * an unmigrated database report an empty panel as a finding.
   */
  const tableExists =
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='prospective_panels'")
      .get() !== undefined;
  if (!tableExists) {
    console.log('reject:panel-v2 — the panel whose rule was frozen before its rows');
    console.log('');
    console.log('MIGRATION 46 HAS NOT RUN AGAINST THIS DATABASE.');
    console.log('`prospective_panels` does not exist, so nothing can have been admitted. This');
    console.log('is an apparatus fact and says nothing about any filter. Open the database');
    console.log('for writing once — any writing command migrates it — and run this again.');
    db.close();
    process.exitCode = 1;
    return;
  }

  const status = panelStatus(db, REJECT_PANEL_V1.panelId);

  const retrospective =
    (db.prepare('SELECT COUNT(*) c FROM reject_tracking').get() as { c: number } | undefined)?.c ?? 0;

  let sourceCommit = 'unknown';
  let dirty = true;
  try {
    sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    /* unknown provenance is reported, never omitted */
  }

  console.log('reject:panel-v2 — the panel whose rule was frozen before its rows');
  console.log('');
  console.log(`panel        : ${REJECT_PANEL_V1.panelId}`);
  console.log(`declared     : ${new Date(REJECT_PANEL_V1.declaredUtcMs).toISOString()}`);
  console.log(`horizons     : ${REJECT_PANEL_V1.horizonsMs.map((h) => `${h / 60_000}m`).join(', ')}`);
  console.log(`metric       : ${REJECT_PANEL_V1.metric}`);
  console.log('');

  let due: ReturnType<typeof dueMarks> = [];
  if (status === null) {
    console.log('THE PANEL HAS NEVER BEEN DECLARED IN THIS DATABASE.');
    console.log('No screening cycle has run since the rule was frozen, so no row has been');
    console.log('admitted. This is not "the filters cost nothing" — it is a panel with no');
    console.log('sample.');
  } else {
    console.log(`samples      : ${status.samples} admitted at rejection time`);
    console.log(`marks        : ${status.marked} of ${status.samples * status.horizonsMs.length} owed`);
    console.log(`outstanding  : ${status.outstanding}`);
    if (status.samples === 0) {
      console.log('');
      console.log('The rule is frozen and NO ROW HAS BEEN ADMITTED. Every rejection since the');
      console.log('declaration instant should have entered here, so an empty panel with a live');
      console.log('screening path is an apparatus fact, not a market one.');
    } else {
      console.log('');
      console.log('by primary reason:');
      for (const r of status.byReason.slice(0, 12)) {
        console.log(`  ${String(r.n).padStart(5)}  ${r.reason}`);
      }
      due = dueMarks(db, REJECT_PANEL_V1.panelId, Date.now(), 5);
      if (due.length > 0) {
        console.log('');
        console.log(`${due.length}+ horizon(s) are DUE and unmarked, and NOTHING TAKES THEM YET.`);
        console.log('');
        console.log('The prerequisite, named exactly. The metric is the executable value of a');
        console.log('development-notional entry, so a mark is "sell the atoms 0.02 SOL would have');
        console.log('bought AT REJECTION TIME, against the pool as it stands now". The atom count');
        console.log('has to be quoted at the instant of rejection — quoting it later against');
        console.log('current state is the retrospective error this whole panel exists to remove.');
        console.log('');
        console.log('That is one RPC call per rejection. A cycle admits ~200 and the endpoint is');
        console.log('already answering HTTP 429 max usage reached, so quoting every rejection is');
        console.log('not affordable. A marker that quoted at mark time instead would be cheap and');
        console.log('would produce a number that looks like a result and is not one, so it is NOT');
        console.log('built.');
        console.log('');
        console.log('The affordable version is a PROBABILITY SUBSAMPLE: admit every rejection, but');
        console.log('quote the counterfactual entry for a fixed fraction of them, recording the');
        console.log('draw in inclusion_probability — the column is already there for exactly this.');
        console.log('A weighted 5% subsample costs ~10 calls a cycle and is a valid panel; the');
        console.log('unquoted rows remain a complete census of WHAT was rejected and WHY.');
        console.log('');
        console.log('The fraction is a preregistered choice and has not been made. Picking it here');
        console.log('would be choosing a sample size with the corpus in view.');
      }
    }
  }

  console.log('');
  console.log(`retrospective corpus : ${retrospective} reject_tracking rows`);
  console.log('  Kept, and NOT merged into the count above. Those rows record that a token was');
  console.log('  rejected, not the state it was rejected on, so scoring them is a different');
  console.log('  experiment. They are not back-admitted, because a panel cannot be made');
  console.log('  prospective after the fact.');

  console.log('');
  console.log('NOT CLAIMED: an admitted sample is a row, not a result. Nothing here says what');
  console.log('any filter cost until the declared horizons are marked and the metric computed');
  console.log('over a sample large enough to carry it.');

  db.close();

  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/reject-panel-v2.json',
    JSON.stringify(
      {
        artifact: 'reject-panel-v2',
        directiveSection: 'P12 / reject:panel-v2',
        generatedUtcMs: Date.now(),
        sourceCommit,
        dirty,
        panel: {
          panelId: REJECT_PANEL_V1.panelId,
          declaredUtcMs: REJECT_PANEL_V1.declaredUtcMs,
          horizonsMs: [...REJECT_PANEL_V1.horizonsMs],
          metric: REJECT_PANEL_V1.metric,
        },
        status,
        dueSample: due,
        retrospectiveRejectTrackingRows: retrospective,
        supersedes: 'the trajectory-status.ts alias, which answers what the OPENED trajectories are doing',
        notClaimed:
          'an admitted sample is a row, not a result. No filter cost is established until the ' +
          'declared horizons are marked and the metric computed over an adequate sample.',
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log('wrote artifacts/reject-panel-v2.json');
}

main();
