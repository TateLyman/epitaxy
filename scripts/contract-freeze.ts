/**
 * `pnpm contract:freeze` — freeze ONE experiment contract before a window opens.
 *
 * P12.2. `pnpm readiness` loads exactly one of these and the rows that belong to
 * it. The 8f73cef audit's R-1 found the alternative: `contractHeld` passed as
 * the literal `false`, `netPnl` as the literal `null`, sixteen gate inputs
 * hardcoded, and no contract table at all — so there were "no frozen fields to
 * mutate". A gate with nothing frozen behind it is fail-closed for the wrong
 * reason: it cannot become READY on evidence because it does not read the
 * evidence, and it therefore cannot detect that the evidence got worse.
 *
 * Everything below is frozen BEFORE any outcome exists. Changing one of these
 * is a new contract, never an edit — which is what makes the multiple-testing
 * ledger meaningful rather than decorative.
 *
 * `claimed_invariants` is the list of adversarial-audit invariants this window
 * CLAIMS. P13 requires FAIL = 0 and NOT TESTABLE = 0 for exactly this list. An
 * invariant that is deliberately out of scope is removed from it here, and is
 * then not claimed anywhere else either — rather than being carried as
 * "NOT TESTABLE but promoted anyway".
 */
import { createHash } from 'node:crypto';
import { openDb } from '../packages/storage/src/db.js';
import { ENTRY_POLICIES, EXIT_POLICIES } from '../packages/strategy/src/treatments.js';
import { MARK_SLA_MS } from '../packages/pipeline/src/mark-scheduler.js';
import { COUNTERFACTUAL_CONTRACT_VERSION, BOUNDED_IMPACT_CAP_BPS } from '../packages/pipeline/src/counterfactual.js';
import { SDK_VERSIONS } from '../packages/pipeline/src/open-trajectory.js';
import { readTreeState } from '../packages/storage/src/collector-lock.js';
import { writeArtifact } from './_artifact.js';

/**
 * The invariants THIS contract claims.
 *
 * Scoped deliberately. Sections F (worker exactness), I (cashback fail-closed),
 * J-1/J-2 (fee tier as a function of market cap) and D-1 (routed entries
 * refused) are claimed because they were PASS in the audit and remain in scope.
 *
 * Not claimed, and therefore not asserted anywhere: the live-websocket lane
 * (P-2 — off by default and never fired), the cold/warm refusal lane (H-3/H-4 —
 * no warm lane exists), cashback amortisation (I-4 — no claim has been made),
 * and the network-dependent confirmations (E-4, J-4, O-3). Each is listed in
 * `outOfScope` with the reason, so removing it from the claim is a recorded act
 * rather than an omission.
 */
const CLAIMED_INVARIANTS = [
  'A-1', 'A-2',
  'B-1', 'B-2', 'B-3', 'B-4',
  'C-1', 'C-2', 'C-3', 'C-4',
  'D-1', 'D-2',
  'E-1', 'E-2', 'E-3',
  'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6',
  'G-1', 'G-2',
  'H-1', 'H-2',
  'I-1', 'I-2', 'I-3',
  'J-1', 'J-2', 'J-3',
  'K-1', 'K-2', 'K-3',
  'L-1',
  'M-1', 'M-2',
  'N-1', 'N-2', 'N-3',
  'O-1', 'O-2',
  'P-1',
  'Q-1', 'Q-2',
  'R-1', 'R-2', 'R-3',
  'S-1', 'S-2', 'S-3', 'S-4',
];

const OUT_OF_SCOPE: Record<string, string> = {
  'E-4': 'confirming SDK 1.19.0 against current official Pump docs needs network access this harness does not take; tracked in docs/SOURCE_MATRIX.csv instead of claimed here',
  'F-7': 'a 0.04 SOL round trip under the output limit — this contract opens at 0.02 SOL, so no such job exists to inspect',
  'H-3': 'cold / prewarmed / repeat runs for one snapshot need three full worker round trips per pool; not in this window',
  'H-4': 'a warm lane that could REFUSE shared account creation does not exist, so the guard cannot be exercised',
  'I-4': 'cashback amortisation changing allocated cost — no claim has ever been made, so there is nothing to check',
  'J-4': 'the Pump SDK does not export `calculateFeeTier`, so `selectFeeTier` cannot be compared against the official result in-process',
  'O-3': 'the currently disclosed Mayhem agent wallet needs the live disclosure; pinned by date in docs instead',
  'P-2': 'the live websocket lane is OFF by default (219 messages/second, measured, exhausted both endpoints) and 0 urgent marks have ever fired',
};

function main(): void {
  const apply = process.argv.includes('--apply');
  const cohort = process.argv.find((a) => a.startsWith('--cohort='))?.slice(9) ?? 'FIRST_HOUR';
  const notional = process.argv.find((a) => a.startsWith('--notional='))?.slice(11) ?? '20000000';
  const windowId = process.argv.find((a) => a.startsWith('--window='))?.slice(9) ?? 'DEV_WINDOW_5D24E';

  const tree = readTreeState();
  if (tree.dirty && !process.argv.includes('--instrument-development')) {
    console.error(
      `\nREFUSED: the tree is DIRTY (${tree.dirtyFiles.length} modified file(s)).\n` +
        'A contract frozen at an uncommitted tree names a commit that does not describe the code that ran.\n',
    );
    process.exit(2);
  }

  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  try {
    const evidenceContextId = `ctx-${tree.commit.slice(0, 12)}-${windowId}`;

    const body = {
      sourceCommit: tree.commit,
      cohort,
      notionalRule: `fixed ${notional} lamports per entry`,
      entryPolicies: [...ENTRY_POLICIES],
      exitPolicies: [...EXIT_POLICIES],
      markSlaMs: MARK_SLA_MS,
      counterfactualContract: `${COUNTERFACTUAL_CONTRACT_VERSION} (bounded impact cap ${BOUNDED_IMPACT_CAP_BPS} bps)`,
      cashbackTreatment:
        'accrued and claimable are MEASURED and are NOT cash; only claimed enters PnL, and the claim cost enters execution cost',
      mayhemTreatment: 'separate stratum; unknown agent separation is CONTAMINATED_UNUSABLE for flow continuation',
      costRentTreatment:
        'principal never enters execution cost; rent enters as the part NOT recovered; the trajectory-level failed-attempt fee enters exactly once',
      riskFacts: ['MINT_2022', 'TRANSFER_FEE', 'MAYHEM', 'CONCENTRATION_RAW', 'CONCENTRATION_ENTITY_ADJUSTED'],
      thresholds: {
        boundedImpactCapBps: BOUNDED_IMPACT_CAP_BPS,
        markSlaMs: MARK_SLA_MS,
        maxPerMint: 3,
      },
      sdkVersions: SDK_VERSIONS,
      claimedInvariants: CLAIMED_INVARIANTS,
      outOfScope: OUT_OF_SCOPE,
    };
    const contractHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const contractId = `contract-${contractHash.slice(0, 16)}`;

    console.log('experiment contract\n');
    console.log(`  contract id        ${contractId}`);
    console.log(`  contract hash      ${contractHash}`);
    console.log(`  evidence context   ${evidenceContextId}`);
    console.log(`  source commit      ${tree.commit}`);
    console.log(`  cohort             ${cohort}`);
    console.log(`  notional           ${notional} lamports`);
    console.log(`  entry policies     ${ENTRY_POLICIES.join(', ')}`);
    console.log(`  exit policies      ${EXIT_POLICIES.join(', ')}`);
    console.log(`  mark SLA           ${MARK_SLA_MS} ms`);
    console.log(`  counterfactual     ${body.counterfactualContract}`);
    console.log(`  claimed invariants ${CLAIMED_INVARIANTS.length}`);
    console.log(`  out of scope       ${Object.keys(OUT_OF_SCOPE).length}`);
    for (const [k, why] of Object.entries(OUT_OF_SCOPE)) {
      console.log(`    ${k}  ${why.slice(0, 96)}`);
    }

    if (!apply) {
      console.log('\n(dry run — pass --apply to freeze it)');
      writeArtifact('experiment-contract.json', { applied: false, contractId, contractHash, ...body });
      return;
    }

    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO evidence_contexts
           (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms, closed_utc_ms,
            validity, reasons, audit_artifact_hash, notes)
         VALUES (?, ?, ?, ?, ?, NULL, 'DEVELOPMENT_EVIDENCE', '[]', NULL, ?)
         ON CONFLICT(evidence_context_id) DO NOTHING`,
      ).run(
        evidenceContextId,
        createHash('sha256').update(`${tree.commit}|${windowId}|DEVELOPMENT_EVIDENCE`).digest('hex'),
        tree.commit,
        tree.dirty ? 1 : 0,
        now,
        `opened by contract:freeze for ${contractId}`,
      );

      db.prepare(
        `INSERT INTO experiment_contracts
           (contract_id, evidence_context_id, frozen_utc_ms, source_commit, context_hash,
            collector_version, kernel_version, route_fingerprint, capability_fingerprint,
            notional_rule, cohort, entry_policies, exit_policies, mark_sla_ms,
            counterfactual_contract, cashback_treatment, mayhem_treatment, cost_rent_treatment,
            risk_facts, thresholds, claimed_invariants, contract_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contract_id) DO NOTHING`,
      ).run(
        contractId,
        evidenceContextId,
        now,
        tree.commit,
        contractHash,
        'trajectory-collect-v2',
        'trajectory-kernel-v1',
        'PUMPSWAP_DIRECT',
        // The per-trajectory fingerprint is a property of each capture; this is
        // the contract-level statement of what the venue model IS.
        createHash('sha256').update(JSON.stringify(SDK_VERSIONS)).digest('hex'),
        body.notionalRule,
        cohort,
        JSON.stringify(body.entryPolicies),
        JSON.stringify(body.exitPolicies),
        MARK_SLA_MS,
        body.counterfactualContract,
        body.cashbackTreatment,
        body.mayhemTreatment,
        body.costRentTreatment,
        JSON.stringify(body.riskFacts),
        JSON.stringify(body.thresholds),
        JSON.stringify(CLAIMED_INVARIANTS),
        contractHash,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const path = writeArtifact('experiment-contract.json', {
      applied: true,
      contractId,
      contractHash,
      evidenceContextId,
      ...body,
    });
    console.log(`\nFROZEN.\n-> ${path}`);
  } finally {
    db.close();
  }
}

main();
