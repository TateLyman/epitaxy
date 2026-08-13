import { COMPUTE_BUDGET_PROGRAM, type DecodedTransaction, type ComputeBudgetSettings } from './transaction.js';

/**
 * What compute unit limit the runtime will actually apply.
 *
 * §10.2 — "do not pretend the absent router limit is zero".
 *
 * This is the missing input that made the priority fee unmeasurable. The fee is
 * `ceil(unit_price × unit_limit / 1e6)`, and Jupiter's `/build` returns
 * `SetComputeUnitPrice` but never `SetComputeUnitLimit` — measured across every
 * observed route. With no limit in the transaction, `priorityFeeLamports()`
 * multiplied a real price by a null limit and got zero, so every route this
 * system builds appeared to pay no priority fee at all.
 *
 * It does not pay zero. When no explicit limit is set the runtime derives one
 * from the instruction count, and charges the price against THAT.
 *
 * The rule, from the Agave fee model:
 *
 *   - an explicit `SetComputeUnitLimit` wins outright, clamped to the maximum;
 *   - otherwise each instruction contributes a default allocation;
 *   - a non-migrated builtin contributes 3,000;
 *   - anything else — a BPF program, or a builtin that has been migrated to
 *     BPF — contributes 200,000;
 *   - the total is clamped to 1,400,000.
 *
 * Unknown programs are treated as non-builtin, which is the CONSERVATIVE
 * direction: it produces the larger limit and therefore the larger fee. A cost
 * model should be wrong in the direction that makes trades look worse.
 */

export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
export const BUILTIN_UNITS_PER_INSTRUCTION = 3_000;

/**
 * Builtins that still execute natively, and so get the small allocation.
 *
 * Deliberately short and explicit. A program wrongly listed here understates
 * the limit by 197,000 units per instruction and therefore understates the fee,
 * so membership is limited to programs whose native status is not in question.
 * Programs migrated to BPF (Address Lookup Table, Config, Feature Gate) are
 * NOT here: they are ordinary BPF programs now and get the full allocation.
 */
export const NATIVE_BUILTIN_PROGRAMS: readonly string[] = [
  '11111111111111111111111111111111', // System
  COMPUTE_BUDGET_PROGRAM,
  'Vote111111111111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
];

const BUILTINS = new Set(NATIVE_BUILTIN_PROGRAMS);

export function isNativeBuiltin(programId: string): boolean {
  return BUILTINS.has(programId);
}

export interface AppliedComputeLimit {
  readonly units: number;
  /** Where the number came from, so a cost is never silently defaulted. */
  readonly source: 'explicit' | 'derived-from-instructions';
  readonly instructionCount: number;
  readonly builtinCount: number;
  /** True when the derived total hit the 1,400,000 ceiling. */
  readonly clamped: boolean;
}

/**
 * The limit the runtime applies to this transaction.
 *
 * Takes the program id of each instruction, in order. Program ids that came
 * from an address lookup table are unresolvable from static keys alone; pass
 * `null` for those and they are treated as non-builtin, which is the
 * conservative direction.
 */
export function appliedComputeLimit(
  programIds: readonly (string | null)[],
  explicitLimit: number | null,
): AppliedComputeLimit {
  const builtinCount = programIds.filter((p) => p !== null && isNativeBuiltin(p)).length;

  if (explicitLimit !== null) {
    return {
      // An explicit limit above the maximum is not honoured; the runtime caps it.
      units: Math.min(explicitLimit, MAX_COMPUTE_UNIT_LIMIT),
      source: 'explicit',
      instructionCount: programIds.length,
      builtinCount,
      clamped: explicitLimit > MAX_COMPUTE_UNIT_LIMIT,
    };
  }

  let units = 0;
  for (const p of programIds) {
    units += p !== null && isNativeBuiltin(p) ? BUILTIN_UNITS_PER_INSTRUCTION : DEFAULT_UNITS_PER_INSTRUCTION;
  }
  return {
    units: Math.min(units, MAX_COMPUTE_UNIT_LIMIT),
    source: 'derived-from-instructions',
    instructionCount: programIds.length,
    builtinCount,
    clamped: units > MAX_COMPUTE_UNIT_LIMIT,
  };
}

/** Read the program id of each instruction, or null when it lives in a table. */
export function instructionProgramIds(tx: DecodedTransaction): (string | null)[] {
  return tx.instructions.map((ix) => tx.staticAccountKeys[ix.programIdIndex] ?? null);
}

/**
 * The priority fee this transaction will actually be charged.
 *
 * `priorityFeeLamports(readComputeBudget(tx))` returns ZERO whenever the router
 * omits `SetComputeUnitLimit`, because it multiplies a real price by a null
 * limit. Jupiter omits it on every observed route, so that path reported that
 * every leg this system builds pays no priority fee at all.
 *
 * This resolves the limit first -- explicit if present, derived from the
 * instructions otherwise -- and then applies the ceiling. Validated against a
 * live SVM: 2 builtins charge 6,000, 3 charge 9,000, an explicit 50,000 charges
 * 50,000, and an explicit 2,000,000 is clamped to 1,400,000, all measured off
 * the payer's balance at a price of exactly one lamport per unit.
 */
export function chargedPriorityFee(tx: DecodedTransaction, cb: ComputeBudgetSettings): {
  lamports: bigint;
  limit: AppliedComputeLimit;
} {
  const limit = appliedComputeLimit(instructionProgramIds(tx), cb.unitLimit);
  if (cb.unitPriceMicroLamports === null || cb.unitPriceMicroLamports === 0n || limit.units === 0) {
    return { lamports: 0n, limit };
  }
  // CEILING. The runtime rounds up, and a model that floors is optimistic in
  // the same direction on every single leg.
  const numerator = BigInt(limit.units) * cb.unitPriceMicroLamports;
  return { lamports: (numerator + 999_999n) / 1_000_000n, limit };
}
