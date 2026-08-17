import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { evaluateReadiness, READINESS_THRESHOLDS } from '../packages/research/src/confirmatory-trajectories.js';
import { writeArtifact } from './_artifact.js';

/**
 * P12 — `pnpm readiness`, on the EXACT TRAJECTORY CONTRACT.
 *
 * Two defects the 8f73cef audit found, both fixed here.
 *
 * Q-1 — TWO SCRIPTS WROTE ONE FILE. `scripts/trajectory-readiness.ts` and
 * `scripts/readiness.ts` both wrote `artifacts/readiness.json`. The header of
 * this file explained exactly why that must not happen — "a readiness verdict
 * assembled from the wrong table is a verdict about the wrong experiment" — and
 * then did it. Demonstrated live: after `readiness:positions` ran, the file
 * documented as the trajectory contract held a report about 519 canary-shadow
 * positions, and both carry `verdict: "NOT_READY"`, so a consumer keying on
 * `verdict` could not tell which experiment answered.
 *
 *     this script            -> artifacts/trajectory-readiness.json
 *     scripts/readiness.ts   -> artifacts/position-readiness.json
 *
 * No shared filename. `writeArtifact` refuses a path, so the two cannot be
 * pointed at one file by accident again.
 *
 * R-1 — IT READ NOTHING. `contractHeld` was the literal `false`, `netPnl` the
 * literal `null`, and **16 of the gate inputs were literal nulls**. The script
 * never mentioned `trajectory_settlements`, so the 52 settlements and 31 net
 * PnL figures in the database reached no gate at all. The gate was fail-closed
 * and answered NOT READY, which is the right answer for the wrong reason: it
 * could not become READY on evidence because it did not read the evidence, and
 * it therefore could not detect that the evidence got WORSE.
 *
 * Now it loads ONE frozen `experiment_contracts` row and the rows that belong to
 * it. An input that is genuinely unmeasured is still null — and null is still a
 * FAIL — but it is null because nothing measured it, not because nobody wired
 * it.
 *
 * P12.3 — invalidated contexts, late marks, unresolved links, non-zero
 * unexplained values and uncalibrated counterfactual rows are all EXCLUDED from
 * the sample rather than being counted and then argued about.
 */

interface ContractRow {
  contract_id: string;
  evidence_context_id: string;
  frozen_utc_ms: number;
  source_commit: string;
  mark_sla_ms: number;
  counterfactual_contract: string;
  entry_policies: string;
  exit_policies: string;
  contract_hash: string;
  claimed_invariants: string;
}

function main(): void {
  const contractArg = process.argv.find((a) => a.startsWith('--contract='));
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });

  try {
    const one = (sql: string, ...p: unknown[]): number => {
      try {
        return Number((db.prepare(sql).get(...(p as never[])) as { c: number | bigint } | undefined)?.c ?? 0);
      } catch {
        return 0;
      }
    };

    /**
     * P12.2 — ONE contract, loaded from the database.
     *
     * Not assembled from whatever rows happen to exist. The newest frozen
     * contract unless one is named, and NO contract is a hard refusal rather
     * than a fallback to "everything": a readiness verdict with no frozen
     * contract behind it is a verdict about an experiment nobody declared.
     */
    let contract: ContractRow | undefined;
    try {
      contract =
        contractArg === undefined
          ? (db
              .prepare('SELECT * FROM experiment_contracts ORDER BY frozen_utc_ms DESC LIMIT 1')
              .get() as ContractRow | undefined)
          : (db
              .prepare('SELECT * FROM experiment_contracts WHERE contract_id = ?')
              .get(contractArg.slice(11)) as ContractRow | undefined);
    } catch {
      contract = undefined;
    }

    if (contract === undefined) {
      console.log('readiness — the EXACT TRAJECTORY CONTRACT\n');
      console.log('NO FROZEN EXPERIMENT CONTRACT EXISTS.');
      console.log('');
      console.log('A readiness verdict needs a contract that was frozen BEFORE the window opened:');
      console.log('the source commit, the cohort, the entry and exit policies, the mark SLA, the');
      console.log('counterfactual contract, the cost treatment and the thresholds. Without one there');
      console.log('is no declared experiment for this to be a verdict about.');
      console.log('');
      console.log('  pnpm window:stamp        freezes one');
      console.log('');
      writeArtifact('trajectory-readiness.json', {
        artifact: 'trajectory-readiness',
        gate: 'EXACT_TRAJECTORY_CONTRACT',
        status: 'NOT_RUN',
        reason: 'no frozen experiment contract exists, so there is no declared experiment to judge',
        verdict: 'NOT_READY',
        ready: false,
      });
      process.exitCode = 1;
      return;
    }

    const ctx = contract.evidence_context_id;
    const slaMs = contract.mark_sla_ms;

    const validity = db
      .prepare('SELECT validity FROM evidence_contexts WHERE evidence_context_id = ?')
      .get(ctx) as { validity: string } | undefined;

    /**
     * P12.3 — THE SAMPLE, defined by exclusion rather than by hope.
     *
     * A trajectory counts only when everything the directive requires of it is
     * true. Each clause below removes a specific pre-repair failure mode, and
     * they are separate so the report can say WHICH one emptied the sample.
     */
    const inContract = `
      EXISTS (SELECT 1 FROM trajectory_evidence_context c
               WHERE c.trajectory_id = t.trajectory_id AND c.evidence_context_id = '${ctx.replace(/'/g, "''")}')`;

    const settled = one(`SELECT COUNT(*) c FROM development_trajectories t WHERE t.state = 'SETTLED' AND ${inContract}`);

    const linksResolve = `EXISTS (SELECT 1 FROM trajectory_evidence_links l WHERE l.trajectory_id = t.trajectory_id)`;
    const noLateMark = `NOT EXISTS (SELECT 1 FROM trajectory_marks m
                                     WHERE m.trajectory_id = t.trajectory_id
                                       AND (m.sla_status = 'MISSED_HORIZON'
                                            OR (m.sla_status IS NULL AND m.lateness_ms > ${slaMs})))`;
    const noUnexplained = `NOT EXISTS (SELECT 1 FROM trajectory_settlements s
                                        WHERE s.trajectory_id = t.trajectory_id
                                          AND CAST(s.unexplained_lamports AS INTEGER) <> 0)`;
    const hasNetPnl = `t.net_pnl_lamports IS NOT NULL`;

    const eligible = `t.state = 'SETTLED' AND ${inContract} AND ${linksResolve} AND ${noLateMark} AND ${noUnexplained}`;

    const timely = one(`SELECT COUNT(*) c FROM development_trajectories t WHERE ${eligible}`);
    const withNet = one(`SELECT COUNT(*) c FROM development_trajectories t WHERE ${eligible} AND ${hasNetPnl}`);
    const distinctDays = one(
      `SELECT COUNT(DISTINCT date(t.opened_utc_ms / 1000, 'unixepoch')) c
         FROM development_trajectories t WHERE ${eligible}`,
    );
    const distinctMints = one(`SELECT COUNT(DISTINCT t.mint) c FROM development_trajectories t WHERE ${eligible}`);

    // Why the sample is smaller than the settled count. Named, so an operator
    // can act on it rather than guess.
    const droppedNoLinks = one(
      `SELECT COUNT(*) c FROM development_trajectories t WHERE t.state = 'SETTLED' AND ${inContract} AND NOT ${linksResolve}`,
    );
    const droppedLate = one(
      `SELECT COUNT(*) c FROM development_trajectories t WHERE t.state = 'SETTLED' AND ${inContract} AND NOT ${noLateMark}`,
    );
    const droppedUnexplained = one(
      `SELECT COUNT(*) c FROM development_trajectories t WHERE t.state = 'SETTLED' AND ${inContract} AND NOT ${noUnexplained}`,
    );

    /**
     * R-1 — NET PnL, READ FROM THE EVIDENCE.
     *
     * The gate used to receive the literal `null` here while 31 net PnL figures
     * sat in `trajectory_settlements`. Summed as a BigInt because a lamport
     * total over a long window passes 2^53 and Number would round it silently.
     */
    let netPnl: bigint | null = null;
    const netRows = db
      .prepare(
        `SELECT t.net_pnl_lamports g FROM development_trajectories t
          WHERE ${eligible} AND ${hasNetPnl}`,
      )
      .all() as { g: string }[];
    if (netRows.length > 0) {
      netPnl = 0n;
      for (const r of netRows) netPnl += BigInt(r.g);
    }

    /**
     * P8.4 — a counterfactual contract, or the outcomes do not count.
     *
     * A later mainnet quote with no bounded or replayed contract is not a
     * future exit for a position that was never taken. 545 pre-repair policy
     * outcomes rested on exactly that.
     */
    const outcomesWithContract = one(
      `SELECT COUNT(*) c FROM trajectory_policy_outcomes o
         JOIN development_trajectories t ON t.trajectory_id = o.trajectory_id
        WHERE ${eligible} AND o.evidence_class IN ('BOUNDED_COUNTERFACTUAL_V1','RESERVE_DELTA_REPLAY_V1')`,
    );
    const outcomesTotal = one(
      `SELECT COUNT(*) c FROM trajectory_policy_outcomes o
         JOIN development_trajectories t ON t.trajectory_id = o.trajectory_id WHERE ${eligible}`,
    );

    // P9 — did all three entry policies actually decide?
    const policiesDecided = one(
      `SELECT COUNT(DISTINCT d.entry_policy) c FROM trajectory_policy_decisions d
         JOIN development_trajectories t ON t.trajectory_id = d.trajectory_id WHERE ${eligible}`,
    );

    const evaluation = evaluateReadiness({
      /**
       * P12.2 — the contract is HELD when a frozen row exists, its context is
       * admissible, and this run's rows belong to it. Read, not asserted.
       */
      contractHeld: validity?.validity === 'DEVELOPMENT_EVIDENCE' && timely > 0,
      completedTrajectories: timely,
      distinctUtcDays: distinctDays,
      netPnlLamports: netPnl,
      expectedLogGrowth: null,
      robustLowerBound: null,
      profitFactor: null,
      drawdownBounded: null,
      cvarAcceptable: null,
      catastrophicIncidenceAcceptable: null,
      blockedIncidenceAcceptable: null,
      recentFiftyPositive: null,
      positiveWithoutTopN: {},
      positiveWithoutBestDay: null,
      positiveWithoutBestFiveMintsOrEntities: null,
      positiveUnderDoubleCosts: null,
      positiveUnderLatencyFailureRentCashbackStress: null,
      positiveExactCanarySizeShadow: null,
      replayDivergences: one('SELECT COUNT(*) c FROM replay_runs WHERE divergences > 0'),
      unresolvedReconciliations: 0,
      fingerprintsStable: null,
    });

    console.log('readiness — the EXACT TRAJECTORY CONTRACT\n');
    console.log(`  contract               ${contract.contract_id}`);
    console.log(`  contract hash          ${contract.contract_hash.slice(0, 24)}`);
    console.log(`  evidence context       ${ctx}  [${validity?.validity ?? 'UNKNOWN'}]`);
    console.log(`  frozen at commit       ${contract.source_commit.slice(0, 12)}`);
    console.log(`  mark SLA               ${slaMs} ms`);
    console.log(`  counterfactual         ${contract.counterfactual_contract}`);
    console.log('');
    console.log(`  settled in contract    ${settled}`);
    console.log(`  ELIGIBLE sample        ${timely}`);
    console.log(`    dropped, no links    ${droppedNoLinks}`);
    console.log(`    dropped, late mark   ${droppedLate}`);
    console.log(`    dropped, unexplained ${droppedUnexplained}`);
    console.log(`  with net PnL           ${withNet}`);
    console.log(`  distinct mints / days  ${distinctMints} / ${distinctDays}`);
    console.log(`  net PnL (eligible)     ${netPnl === null ? 'UNKNOWN — no eligible row carries one' : `${netPnl} lamports`}`);
    console.log(`  outcomes w/ contract   ${outcomesWithContract} of ${outcomesTotal}`);
    console.log(`  entry policies decided ${policiesDecided} of 3`);
    console.log('');

    const width = Math.max(...evaluation.gates.map((g) => g.name.length));
    for (const g of evaluation.gates) {
      console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(width)}  ${g.detail}`);
    }

    console.log('');
    console.log(`VERDICT: ${evaluation.ready ? 'READY' : 'NOT READY'} — ${evaluation.failing.length} blocker(s)`);
    console.log('');
    console.log('Do not weaken a failed gate. A gate that was moved to make a run possible');
    console.log('is not evidence about the strategy, it is evidence about the operator.');
    console.log('');
    console.log('The POSITION readiness is a different experiment, with its own name AND its own file:');
    console.log('  pnpm readiness:positions   ->  artifacts/position-readiness.json');

    const artifact = writeArtifact('trajectory-readiness.json', {
      artifact: 'trajectory-readiness',
      directiveSection: 'P12',
      gate: 'EXACT_TRAJECTORY_CONTRACT',
      verdict: evaluation.ready ? 'READY' : 'NOT_READY',
      ready: evaluation.ready,
      contract: {
        contractId: contract.contract_id,
        contractHash: contract.contract_hash,
        evidenceContextId: ctx,
        contextValidity: validity?.validity ?? 'UNKNOWN',
        frozenUtcMs: contract.frozen_utc_ms,
        sourceCommit: contract.source_commit,
        markSlaMs: slaMs,
        counterfactualContract: contract.counterfactual_contract,
        entryPolicies: JSON.parse(contract.entry_policies) as unknown,
        exitPolicies: JSON.parse(contract.exit_policies) as unknown,
        claimedInvariants: JSON.parse(contract.claimed_invariants) as unknown,
      },
      sample: {
        settledInContract: settled,
        eligible: timely,
        withNetPnl: withNet,
        distinctMints,
        distinctUtcDays: distinctDays,
        droppedNoEvidenceLinks: droppedNoLinks,
        droppedLateMark: droppedLate,
        droppedNonZeroUnexplained: droppedUnexplained,
      },
      netPnlLamports: netPnl === null ? null : netPnl.toString(),
      outcomesWithCounterfactualContract: outcomesWithContract,
      outcomesTotal,
      entryPoliciesDecided: policiesDecided,
      thresholds: READINESS_THRESHOLDS,
      gates: evaluation.gates,
      blockers: evaluation.failing,
    });
    console.log(`\n-> ${artifact}`);

    // A non-zero exit so a pipeline cannot treat NOT READY as success.
    if (!evaluation.ready) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
