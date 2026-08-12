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
  /** Limit the response set, if it set one. Measured: /build never does. */
  readonly computeUnitLimit: number | null;
  /** Limit our own fee cap can afford at the router's price. */
  readonly affordableComputeUnitLimit: number | null;
  readonly unitPriceMicroLamports: bigint | null;
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
  const cb = evaluateComputeBudget(instructions, limits.maxPriorityFeeLamports);
  if (cb.violation !== null) violations.push(cb.violation);

  const fee = priorityFeeLamports({
    unitLimit: cb.unitLimit ?? cb.affordableUnitLimit,
    unitPriceMicroLamports: cb.unitPriceMicroLamports,
  });

  return {
    allowed: violations.length === 0,
    violations,
    priorityFeeLamports: fee,
    computeUnitLimit: cb.unitLimit,
    affordableComputeUnitLimit: cb.affordableUnitLimit,
    unitPriceMicroLamports: cb.unitPriceMicroLamports,
    programIds,
    coverage: INSTRUCTION_POLICY_COVERAGE,
  };
}
/**
 * Smallest compute-unit limit a Jupiter swap can plausibly execute within.
 *
 * A route that our own fee cap could not afford to run is a route we cannot
 * take, whatever else is true of it.
 */
export const MIN_PLAUSIBLE_COMPUTE_UNITS = 200_000;

/** Solana's per-transaction ceiling. A limit above it cannot be set. */
export const MAX_COMPUTE_UNITS = 1_400_000;

export interface ComputeBudgetVerdict {
  readonly unitLimit: number | null;
  readonly unitPriceMicroLamports: bigint | null;
  /**
   * Limit implied by our own priority-fee cap at the router's unit price.
   * Null when no price was returned.
   */
  readonly affordableUnitLimit: number | null;
  readonly violation: { violation: PolicyViolation; detail: string } | null;
}

/**
 * Decide the compute budget from what the response actually returns.
 *
 * Measured live 2026-08-12: `/swap/v2/build` returns exactly ONE compute-budget
 * instruction and it is always `SetComputeUnitPrice` — never a limit. Passing
 * `dynamicComputeUnitLimit=true` or `computeUnitPriceMicroLamports=N` changes
 * nothing; the price came back 2054 µL/unit in all four variants.
 *
 * That is not a defect in the route. `/build` returns raw instructions for
 * LOCAL assembly, and the unit limit is one of the things the assembler
 * supplies. So an earlier version of this check — "SetComputeUnitLimit must be
 * present" — was asserting something about the caller and blaming the router
 * for it, and it failed every real route.
 *
 * The substantive question survives, and is asked properly: given the router's
 * unit PRICE and our own maximum priority fee, what unit limit could we afford
 * to set, and is a swap executable within it? If the price is high enough that
 * our cap buys fewer units than a swap needs, the route is genuinely
 * unaffordable and that is a refusal about economics rather than about format.
 *
 * A response with neither a price nor a limit leaves the fee unknown, and
 * unknown is refused.
 */
export function evaluateComputeBudget(
  instructions: readonly RawInstruction[],
  maxPriorityFeeLamports: bigint,
): ComputeBudgetVerdict {
  let unitLimit: number | null = null;
  let unitPriceMicroLamports: bigint | null = null;

  for (const ix of instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM || ix.data === undefined) continue;
    let d: Buffer;
    try {
      d = Buffer.from(ix.data, 'base64');
    } catch {
      return {
        unitLimit: null,
        unitPriceMicroLamports: null,
        affordableUnitLimit: null,
        violation: { violation: 'undecodable', detail: 'compute budget instruction data is not base64' },
      };
    }
    if (d.length === 0) continue;
    const tag = d[0] as number;
    if (tag === 2 && d.length >= 5) unitLimit = d.readUInt32LE(1);
    else if (tag === 3 && d.length >= 9) unitPriceMicroLamports = d.readBigUInt64LE(1);
  }

  // Both present: the fee is fully determined by the response.
  if (unitLimit !== null && unitPriceMicroLamports !== null) {
    const fee = priorityFeeLamports({ unitLimit, unitPriceMicroLamports });
    return {
      unitLimit,
      unitPriceMicroLamports,
      affordableUnitLimit: unitLimit,
      violation:
        fee > maxPriorityFeeLamports
          ? { violation: 'priority_fee_too_high', detail: `${fee} > ${maxPriorityFeeLamports} lamports` }
          : null,
    };
  }

  // Price only — the observed shape. The limit is ours to set.
  if (unitPriceMicroLamports !== null) {
    if (unitPriceMicroLamports === 0n) {
      return { unitLimit, unitPriceMicroLamports, affordableUnitLimit: MAX_COMPUTE_UNITS, violation: null };
    }
    const affordable = Number((maxPriorityFeeLamports * 1_000_000n) / unitPriceMicroLamports);
    const capped = Math.min(affordable, MAX_COMPUTE_UNITS);
    return {
      unitLimit,
      unitPriceMicroLamports,
      affordableUnitLimit: capped,
      violation:
        capped < MIN_PLAUSIBLE_COMPUTE_UNITS
          ? {
              violation: 'priority_fee_too_high',
              detail:
                `router priced compute at ${unitPriceMicroLamports} µL/unit; a ${maxPriorityFeeLamports} lamport ` +
                `cap buys only ${capped} units, below the ${MIN_PLAUSIBLE_COMPUTE_UNITS} a swap needs`,
            }
          : null,
    };
  }

  // Limit only. No unit price means no priority fee at all: the transaction
  // pays base fee and competes on nothing. Cheap and fully determined, so it
  // passes -- refusing it would be refusing the least expensive shape there is.
  if (unitLimit !== null) {
    return { unitLimit, unitPriceMicroLamports: null, affordableUnitLimit: unitLimit, violation: null };
  }

  // Neither. The fee is unbounded and unknown, which is not a pass.
  return {
    unitLimit: null,
    unitPriceMicroLamports: null,
    affordableUnitLimit: null,
    violation: {
      violation: 'compute_limit_missing',
      detail: 'response carried neither a compute unit limit nor a unit price; the priority fee is unknown',
    },
  };
}

