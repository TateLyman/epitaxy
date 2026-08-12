import { COMPUTE_BUDGET_PROGRAM, priorityFeeLamports } from './transaction.js';
import { DEFAULT_ALLOWED_PROGRAMS, type PolicyViolation } from './txpolicy.js';

/**
 * Policy over raw instructions, rather than over a serialized transaction.
 *
 * P2a.1 §P0.2 requires that the same transaction-policy decoder used by the
 * executor run over what `/swap/v2/build` returns. It cannot run unchanged:
 * `evaluateTransactionPolicy` takes signed-transaction BYTES, and
 * `/swap/v2/build` deliberately returns instructions instead — which is the
 * only reason paper mode can establish buildability for an unfunded taker at
 * all.
 *
 * So the checks are separated from their input format. Everything decidable
 * from instructions alone is decided here and uses the same allowlist as the
 * byte path. Everything that needs the assembled message — fee-payer position,
 * signature count, recent blockhash, packet size — is NOT claimed here.
 * `coverage` records which of the two this is, so a row can never store
 * instruction-level approval as though it were the full signer check.
 *
 * This is a research check. Nothing it approves may be signed. The signer's
 * contract is unchanged: it validates the exact bytes it is about to sign, and
 * no instruction-level pass substitutes for that.
 */

/** Which questions an instruction-level evaluation is entitled to answer. */
export const INSTRUCTION_POLICY_COVERAGE = 'instructions-only';

export interface RawInstruction {
  readonly programId: string;
  readonly accounts?: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[] | undefined;
  /** base64, as returned by /swap/v2/build. */
  readonly data?: string | undefined;
}

export interface InstructionPolicyLimits {
  readonly expectedSigner: string;
  readonly allowedPrograms: readonly string[];
  readonly maxInstructions: number;
  readonly maxPriorityFeeLamports: bigint;
}

export interface InstructionPolicyResult {
  readonly allowed: boolean;
  readonly violations: readonly { violation: PolicyViolation; detail: string }[];
  readonly priorityFeeLamports: bigint;
  readonly computeUnitLimit: number | null;
  readonly programIds: readonly string[];
  /** Always `instructions-only`. Never widened without the bytes. */
  readonly coverage: string;
}

export function instructionPolicyLimits(
  expectedSigner: string,
  maxPriorityFeeLamports: bigint,
): InstructionPolicyLimits {
  return {
    expectedSigner,
    allowedPrograms: DEFAULT_ALLOWED_PROGRAMS,
    maxInstructions: 24,
    maxPriorityFeeLamports,
  };
}

/** The value stored in `build_attempts.policy_status`. */
export function policyStatusLabel(r: InstructionPolicyResult): string {
  return r.allowed
    ? `POLICY_PASS(${INSTRUCTION_POLICY_COVERAGE})`
    : `POLICY_FAIL(${[...new Set(r.violations.map((v) => v.violation))].join(',')})`;
}

export function evaluateInstructionPolicy(
  instructions: readonly RawInstruction[],
  limits: InstructionPolicyLimits,
): InstructionPolicyResult {
  const violations: { violation: PolicyViolation; detail: string }[] = [];
  const programIds = instructions.map((i) => i.programId);

  const allowed = new Set(limits.allowedPrograms);
  for (const program of programIds) {
    if (!allowed.has(program)) {
      violations.push({ violation: 'disallowed_program', detail: `program ${program}` });
    }
  }

  if (instructions.length > limits.maxInstructions) {
    violations.push({
      violation: 'too_many_instructions',
      detail: `${instructions.length} > ${limits.maxInstructions}`,
    });
  }

  // A signer other than the taker means the transaction only executes once some
  // third party co-signs — a structure our flow never produces, and one a
  // malicious router could use to make execution contingent on its own key.
  const signers = new Set<string>();
  for (const ix of instructions) {
    for (const a of ix.accounts ?? []) if (a.isSigner) signers.add(a.pubkey);
  }
  for (const s of signers) {
    if (s !== limits.expectedSigner) {
      violations.push({ violation: 'extra_signers_required', detail: `unexpected signer ${s}` });
    }
  }

  // Compute budget, read from the instruction data rather than from whatever
  // the quote claimed. It is the one field a router can inflate without
  // changing anything visible in the price.
  let unitLimit: number | null = null;
  let unitPriceMicroLamports: bigint | null = null;
  for (const ix of instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM || ix.data === undefined) continue;
    let d: Buffer;
    try {
      d = Buffer.from(ix.data, 'base64');
    } catch {
      violations.push({ violation: 'undecodable', detail: 'compute budget instruction data is not base64' });
      continue;
    }
    if (d.length === 0) continue;
    const tag = d[0] as number;
    if (tag === 2 && d.length >= 5) {
      unitLimit = d.readUInt32LE(1);
    } else if (tag === 3 && d.length >= 9) {
      unitPriceMicroLamports = d.readBigUInt64LE(1);
    }
  }

  const fee = priorityFeeLamports({ unitLimit, unitPriceMicroLamports });
  if (unitLimit === null) {
    // Without an explicit limit the transaction is charged at the default
    // ceiling, which makes any fee we modelled a fiction.
    violations.push({ violation: 'compute_limit_missing', detail: 'no SetComputeUnitLimit instruction' });
  }
  if (fee > limits.maxPriorityFeeLamports) {
    violations.push({
      violation: 'priority_fee_too_high',
      detail: `${fee} > ${limits.maxPriorityFeeLamports} lamports`,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
    priorityFeeLamports: fee,
    computeUnitLimit: unitLimit,
    programIds,
    coverage: INSTRUCTION_POLICY_COVERAGE,
  };
}
