import { writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { createTrajectoryKernel, assertSameIdentity, IdentitySubstituted } from '../packages/pipeline/src/trajectory-kernel.js';
import { boundEntryImpact, claimIsSupported, weakestGrade } from '../packages/domain/src/trajectory-evidence.js';
import type { TrajectoryIdentity } from '../packages/pipeline/src/trajectory-kernel.js';

/**
 * P20 — `pnpm trajectory:kernel-proof`.
 *
 * Exercises the kernel's four contracts against constructed inputs and records
 * the results. This is the kernel's OWN proof: the live-chain evidence lives in
 * artifacts/live-one-pass-trajectory.json, and the two answer different
 * questions — this one asks whether the kernel can be made to violate its
 * invariants, which a live run cannot demonstrate because a live run only
 * exercises the paths it happens to take.
 */

const identity: TrajectoryIdentity = {
  trajectoryId: 't-proof',
  entryObservationId: 'obs-entry',
  entrySimulationJobId: 'job-entry',
  entrySettlementId: 'set-entry',
  venue: 'PUMPSWAP',
  pool: 'PoolAAA',
  capabilityFingerprint: 'fp',
  snapshotHash: 'snap-1',
  mint: 'MintAAA',
  cohort: 'FIRST_HOUR',
  migrationAgeMs: 60_000,
  notionalLamports: 20_000_000n,
  entryPolicyInputs: {},
  stratum: 'CANONICAL_NONCASHBACK',
};

const kernel = createTrajectoryKernel();
const findings: Record<string, unknown> = {};

// 1. Identity may not be substituted.
const substitutions: Record<string, boolean> = {};
for (const [field, patch] of Object.entries({
  entryObservationId: { entryObservationId: 'other' },
  entrySimulationJobId: { entrySimulationJobId: 'other' },
  snapshotHash: { snapshotHash: 'other' },
  pool: { pool: 'other' },
  mint: { mint: 'other' },
  trajectoryId: { trajectoryId: 'other' },
})) {
  try {
    assertSameIdentity(identity, { ...identity, ...patch });
    substitutions[field] = false;
  } catch (e) {
    substitutions[field] = e instanceof IdentitySubstituted;
  }
}
findings['identitySubstitutionRefused'] = substitutions;

// 2. The evidence ceiling is decided at OPEN.
const small = boundEntryImpact({
  entryQuoteInLamports: 20_000_000n,
  effectiveQuoteReserveLamports: 100_000_000_000n,
  tokensAcquiredAtoms: 1_000_000n,
  baseReserveAtoms: 10_000_000_000_000n,
});
const large = boundEntryImpact({
  entryQuoteInLamports: 20_000_000n,
  effectiveQuoteReserveLamports: 100_000_000n,
  tokensAcquiredAtoms: 1_000_000n,
  baseReserveAtoms: 2_000_000n,
});
findings['evidenceCeilingDecidedAtOpen'] = {
  smallEntry: { withinBound: small.withinSmallImpactBound, haircutBps: small.haircutBps },
  largeEntry: { withinBound: large.withinSmallImpactBound, haircutBps: large.haircutBps },
  note:
    'a trajectory whose entry moves the pool beyond the frozen bound can never be BOUNDED_COUNTERFACTUAL however ' +
    'well it is measured later, because the future state it would be evaluated against never contained the entry',
};

// 3. advance() cannot express select-A-simulate-B-book-A.
const exitOf = (id: string, credit: bigint) =>
  ({
    observationId: id,
    simulationJobId: 'job-' + id,
    side: 'sell',
    family: 'BUILD_CUSTOM',
    capabilityFingerprint: 'fp',
    input: { kind: 'token', mint: 'MintAAA', tokenProgram: 'Tok', tokenAccount: 'Ata', requestedAtoms: 1n, actualDebitAtoms: 1n },
    output: { kind: 'native_sol', minimumLamports: 0n, expectedLamports: credit, actualCreditLamports: credit },
    costs: {
      baseFeeLamports: 5_000n, priorityFeeLamports: 0n, tipLamports: 0n, protocolFeeLamports: null,
      creatorFeeLamports: null, lpFeeLamports: null, platformFeeLamports: 0n, transferFeeAtoms: 0n,
      transferFeeLamportsEquivalent: 0n, rentCreatedLamports: 0n, rentRecoveredLamports: 0n,
      failedAttemptCostLamports: 0n, unexplainedLamports: 0n, valueToUnnamedAccountsLamports: 0n,
    },
    createdAccounts: [], closedAccounts: [], residualTokenAtoms: 0n, payerNativeDeltaLamports: credit,
    fullAccountCoverage: true, effectValid: true, effectRefusals: [], snapshotManifestHash: 'snap-1',
    replayable: true, complete: true, incompleteness: [],
  }) as never;

const advanced = kernel.advance({
  identity,
  state: 'AWAITING_FILL_OBSERVATION',
  triggeredAtMs: 0,
  minimumFillLatencyMs: 400,
  settledCandidates: [
    { observationId: 'A', atMs: 500, settlement: exitOf('A', 1n), executable: false },
    { observationId: 'B', atMs: 600, settlement: exitOf('B', 21_000_000n), executable: true },
    { observationId: 'C', atMs: 900, settlement: exitOf('C', 99_000_000n), executable: true },
  ],
});
findings['selectedObservationIsTheBookedObservation'] = {
  selected: advanced.selectedObservationId,
  bookedSettlementObservation: advanced.exit?.observationId ?? null,
  identical: advanced.selectedObservationId === (advanced.exit?.observationId ?? null),
  // C is better and is deliberately NOT taken: the first VALID candidate past
  // the latency floor is the fill, and picking the best would be hindsight.
  betterCandidateNotTaken: advanced.selectedObservationId !== 'C',
};

// 4. A claim may not rest on evidence weaker than its gate requires.
findings['claimsRequireTheirEvidence'] = {
  canaryOnDevelopmentEvidence: claimIsSupported('CANARY_READY', ['BOUNDED_COUNTERFACTUAL']),
  kernelRunningOnSimulatedExecution: claimIsSupported('VALID_TRAJECTORY_KERNEL_RUNNING', ['SIMULATED_EXECUTION']),
  weakestOfMixedSet: weakestGrade(['LANDED_MAINNET', 'SYNTHETIC']),
};

const ok =
  Object.values(substitutions).every((x) => x) &&
  small.withinSmallImpactBound &&
  !large.withinSmallImpactBound &&
  advanced.selectedObservationId === 'B' &&
  advanced.exit?.observationId === 'B' &&
  !claimIsSupported('CANARY_READY', ['BOUNDED_COUNTERFACTUAL']).supported;
findings['ok'] = ok;

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/trajectory-kernel-proof.json', JSON.stringify(findings, null, 2) + '\n');

// The directive names `sequential-worker-proof.json`; the generator writes
// `one-pass-sequential-proof.json`. Copied rather than renamed so the name the
// directive asks for exists without breaking the existing reference.
if (existsSync('artifacts/one-pass-sequential-proof.json')) {
  copyFileSync('artifacts/one-pass-sequential-proof.json', 'artifacts/sequential-worker-proof.json');
}
if (existsSync('artifacts/size-cost-surface.json')) {
  copyFileSync('artifacts/size-cost-surface.json', 'artifacts/trajectory-size-surface.json');
}

console.log(JSON.stringify(findings['selectedObservationIsTheBookedObservation'], null, 2));
console.log('identity substitution refused on every bound field:', Object.values(substitutions).every((x) => x));
console.log('ok:', ok);
if (!ok) process.exitCode = 1;
void readFileSync;
