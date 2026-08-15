/**
 * P2 — prove the runtime is SEQUENTIAL, on a case where the answer is known.
 *
 * Before running a Pump lifecycle through it, establish the property itself:
 * a second transaction must see the state the first committed. If that does not
 * hold, every downstream number is the linked-leg defect again with more steps.
 *
 * The test is a plain SOL transfer, whose arithmetic nobody can dispute:
 *
 *   A holds 10 SOL, B holds 0
 *   step 1: A -> B, 1 SOL
 *   step 2: A -> B, 2 SOL
 *
 * Sequential gives B = 3 SOL, and step 2's PRE-state already shows 1 SOL. Two
 * fresh states would show step 2 starting from zero and ending at 2.
 *
 * The amounts DIFFER on purpose. Two identical transfers produce byte-identical
 * transactions, and the runtime correctly refuses the second as AlreadyProcessed
 * — a real property of the chain that would have masked the thing under test.
 *
 * The transfer is the whole point: no external program, no ELF, no pool. What
 * is being tested is the runtime, not a route.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  runSequential,
  type FrozenRuntimeSnapshot,
  type SequentialStep,
} from '../packages/simulator/src/sequential-runtime.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { base58Encode } from '../packages/solana/src/base58.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const LAMPORT = 1_000_000_000n;

/** A deterministic 32-byte pubkey, so the proof reproduces exactly. */
function key(seed: number): string {
  const b = new Uint8Array(32);
  b[0] = seed;
  b[31] = 1;
  return base58Encode(b);
}

const A = key(11);
const B = key(22);

/** SystemProgram::Transfer — instruction 2, then a u64 LE amount. */
function transferIx(from: string, to: string, lamports: bigint) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data: data.toString('base64'),
  };
}

// A blockhash the runtime never validates: blockhash checking is disabled,
// because these transactions are built against state this runtime has not seen.
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));

function step(label: string, amount: bigint): SequentialStep {
  const msg = compileMessage([transferIx(A, B, amount)], A, BLOCKHASH, {});
  return {
    label,
    transactionBase64: Buffer.from(encodeUnsignedTransaction(msg)).toString('base64'),
    observe: [A, B],
  };
}

const snapshot: FrozenRuntimeSnapshot = {
  programs: [],
  accounts: [
    { pubkey: A, dataBase64: '', owner: SYSTEM_PROGRAM, lamports: 10n * LAMPORT },
    { pubkey: B, dataBase64: '', owner: SYSTEM_PROGRAM, lamports: 0n },
  ],
  slot: 438_000_000,
  unixTimestamp: 1_786_000_000,
};

const result = runSequential({
  jobId: 'sequential-property-proof',
  snapshot,
  steps: [step('transfer-1', LAMPORT), step('transfer-2', 2n * LAMPORT)],
});

const balanceOf = (accs: readonly { pubkey: string; lamports: bigint }[], k: string): string | null =>
  accs.find((a) => a.pubkey === k)?.lamports.toString() ?? null;

const s1 = result.steps[0];
const s2 = result.steps[1];

const observed = {
  step1: {
    status: s1?.status ?? 'MISSING',
    preB: s1 === undefined ? null : balanceOf(s1.preAccounts, B),
    postB: s1 === undefined ? null : balanceOf(s1.postAccounts, B),
  },
  step2: {
    status: s2?.status ?? 'MISSING',
    preB: s2 === undefined ? null : balanceOf(s2.preAccounts, B),
    postB: s2 === undefined ? null : balanceOf(s2.postAccounts, B),
  },
};

/**
 * THE assertion.
 *
 * Step 2's PRE-state must already hold step 1's transfer. If it shows zero, the
 * runtime restored a fresh state between them and every sequential claim built
 * on it is false.
 */
const sequential =
  observed.step1.postB === String(LAMPORT) &&
  observed.step2.preB === String(LAMPORT) &&
  observed.step2.postB === String(3n * BigInt(LAMPORT));

const out = {
  generatedUtcMs: Date.now(),
  sourceCommit: execSync('git rev-parse HEAD').toString().trim(),
  dirty: execSync('git status --porcelain').toString().trim().length > 0,
  runtime: result.runtime,
  litesvmVersion: result.litesvmVersion,
  binarySha256: result.binarySha256,
  sequentialComplete: result.sequentialComplete,
  observed,
  expected: {
    step1PostB: Number(LAMPORT),
    step2PreB: Number(LAMPORT),
    step2PostB: 3 * Number(LAMPORT),
    note: 'Two fresh states would show step2.preB = 0 and step2.postB = 2 SOL.',
  },
  sequentialPropertyHolds: sequential,
  incompleteness: result.incompleteness,
  steps: result.steps.map((s) => ({ label: s.label, status: s.status, error: s.transactionError })),
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/sequential-runtime-proof.json', JSON.stringify(out, null, 2));

console.log(`runtime            ${result.runtime} litesvm ${result.litesvmVersion}`);
console.log(`binary             ${result.binarySha256.slice(0, 16)}...`);
console.log(`step 1  ${observed.step1.status}  B: ${observed.step1.preB} -> ${observed.step1.postB}`);
console.log(`step 2  ${observed.step2.status}  B: ${observed.step2.preB} -> ${observed.step2.postB}`);
console.log(`sequential property holds: ${sequential}`);
if (result.incompleteness.length > 0) console.log(`incompleteness: ${result.incompleteness.join('; ')}`);
console.log('artifacts/sequential-runtime-proof.json');
if (!sequential) process.exitCode = 1;
