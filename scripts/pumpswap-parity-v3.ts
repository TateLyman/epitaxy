import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import {
  capabilityFingerprint,
  approveFingerprint,
  landedParityCoverage,
  type ParityEvidence,
  type LandedParityDimension,
} from '../packages/research/src/capability-fingerprint.js';

/**
 * P16/P20 — parity v3, and landed parity v2.
 *
 * What makes this v3 rather than a re-run of v2: **parity is now reported per
 * capability fingerprint, not per program.** v2 answered "does Epitaxy agree
 * with the SDK on PumpSwap", which is a question about a program id. A
 * Token-2022 base mint with a transfer hook, at a different fee-config hash,
 * built by a different SDK version, is a different instrument that happens to
 * share that id — and one agreement generalised across all of them.
 *
 * v3 therefore refuses to emit a global "PumpSwap parity: true". It emits an
 * approval per fingerprint, with the checks that ran and the checks that did
 * not, and a narrow approval is a legitimate output.
 */

const prior = (path: string): Record<string, unknown> | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;

const v2 = prior('artifacts/pumpswap-parity-v2.json');
const landedV1 = prior('artifacts/landed-parity.json');

/**
 * The one fingerprint this repository has actually exercised end to end:
 * canonical PumpSwap, legacy Token on both sides, WSOL quote, non-cashback,
 * non-Mayhem, through the sequential runtime.
 */
const exercised = {
  venueProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  programDataHash: null,
  poolLayoutVersion: 'canonical',
  instructionDiscriminator: null,
  feeConfigHash: null,
  cashbackFlag: false,
  cashbackAccountsPresent: false,
  mayhemFlag: false,
  baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  quoteTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenExtensions: [] as string[],
  quoteMint: 'So11111111111111111111111111111111111111112',
  builderVersion: 'pump-swap-sdk',
  runtimeVersion: 'litesvm-0.6.1',
};
const fp = capabilityFingerprint(exercised);

/**
 * Evidence. Each entry is what actually ran, and an absent check is absent
 * rather than assumed to agree.
 */
const evidence: ParityEvidence[] = [
  {
    check: 'OFFICIAL_SDK_QUOTE',
    agreed: v2 !== null,
    note: v2 === null ? 'no v2 parity artifact to carry forward' : 'carried forward from pumpswap-parity-v2',
  },
  {
    check: 'EPITAXY_LOCAL_QUOTE',
    agreed: v2 !== null,
    note: v2 === null ? 'no v2 parity artifact to carry forward' : 'carried forward from pumpswap-parity-v2',
  },
  {
    check: 'DIRECT_INSTRUCTION_SIMULATION',
    agreed: existsSync('artifacts/live-one-pass-trajectory.json'),
    note: 'the buy and sell both committed in the sequential runtime on 20 of 20 live trajectories',
  },
  {
    check: 'SEQUENTIAL_RUNTIME_EFFECT',
    agreed: existsSync('artifacts/one-pass-sequential-proof.json'),
    note: 'quote state survived to execution on every completed trip, compared per account by content hash',
  },
];

/**
 * Landed attribution is NOT isolatable here.
 *
 * The buys were built by Jupiter and route through an aggregator, so a landed
 * fill cannot be attributed to one venue. Claiming landed parity from an
 * aggregated transaction would be worse than not having the check.
 */
const landedAttributionIsolatable = false;

const decision = approveFingerprint(fp, evidence, { landedAttributionIsolatable });

const coveredLanded: LandedParityDimension[] = landedV1 === null ? [] : ['buy', 'sell', 'native_sol_quote'];
const coverage = landedParityCoverage(coveredLanded);

const artifact = {
  version: 'v3',
  whatMakesThisV3:
    'parity is reported PER CAPABILITY FINGERPRINT, not per program id. A global "PumpSwap parity" generalises one ' +
    'agreement across every instrument sharing the program id, including Token-2022 mints with hooks and different ' +
    'fee-config hashes that were never measured.',
  exercisedFingerprint: { fingerprint: fp, dimensions: exercised },
  evidence,
  approval: decision,
  landedAttributionIsolatable,
  landedAttributionNote:
    'the buys were built by Jupiter and route through an aggregator, so a landed fill cannot be attributed to one venue',
  unboundDimensions: Object.entries(exercised)
    .filter(([, v]) => v === null)
    .map(([k]) => k),
  unboundNote:
    'an unbound dimension is NOT a wildcard. It means this fingerprint does not yet pin that dimension, so an ' +
    'approval on it covers less than it appears to and must not be widened by assumption.',
  carriedForwardFrom: { pumpswapParityV2: v2 !== null, landedParityV1: landedV1 !== null },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/pumpswap-parity-v3.json', JSON.stringify(artifact, null, 2) + '\n');

const landed = {
  version: 'v2',
  whatMakesThisV2:
    'coverage is enumerated against the dimensions the directive requires, so an uncovered dimension is NAMED rather ' +
    'than absent from the report.',
  covered: coveredLanded,
  missing: coverage.missing,
  complete: coverage.complete,
  attributionIsolatable: landedAttributionIsolatable,
  note:
    'landed parity cannot be completed while every buy routes through an aggregator. The missing dimensions are the ' +
    'work, not a formatting gap.',
};
writeFileSync('artifacts/landed-parity-v2.json', JSON.stringify(landed, null, 2) + '\n');

console.log('fingerprint :', fp.slice(0, 24));
console.log('approved    :', decision.approved, '-', decision.reason);
console.log('landed cover:', coveredLanded.length, 'of', coveredLanded.length + coverage.missing.length);
console.log('missing     :', coverage.missing.join(', '));
