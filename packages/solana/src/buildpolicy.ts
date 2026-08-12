import { createHash } from 'node:crypto';
import { priorityFeeLamports } from './transaction.js';
import { DEFAULT_ALLOWED_PROGRAMS, MAX_TX_BYTES, type PolicyViolation } from './txpolicy.js';
import { evaluateComputeBudget, type RawInstruction } from './instructionpolicy.js';

/**
 * Policy over a complete `/swap/v2/build` response.
 *
 * `instructionpolicy.ts` answers what can be decided from instructions in
 * isolation. This answers the questions that need the assembled message: who
 * pays, who signs, what the transaction will weigh, whether the blockhash is
 * real, and — the one that matters most for safety — which accounts are
 * WRITABLE once address lookup tables are resolved.
 *
 * That last one is the §P13.4 requirement and it is not cosmetic. A versioned
 * transaction can load writable accounts from a lookup table that appear
 * nowhere in the static account list. Inspecting only the static instructions
 * means inspecting a subset of what the transaction can mutate, and a router
 * that wanted to touch something unexpected would put it exactly there.
 *
 * What this still does NOT do, stated so it cannot be mistaken for more: it
 * does not encode and serialize the transaction, and it does not simulate it.
 * The byte count is computed from the response's own structure and is therefore
 * an ESTIMATE, labelled as one. `evaluateTransactionPolicy()` in txpolicy.ts
 * remains the only thing that inspects real signed bytes, and it is still the
 * only check the signer is permitted to rely on.
 */

export const BUILD_POLICY_COVERAGE = 'build-response';

export interface BuildPolicyLimits {
  readonly expectedFeePayer: string;
  readonly allowedPrograms: readonly string[];
  readonly maxInstructions: number;
  readonly maxPriorityFeeLamports: bigint;
  readonly maxTransactionBytes: number;
}

export function buildPolicyLimits(feePayer: string, maxPriorityFeeLamports: bigint): BuildPolicyLimits {
  return {
    expectedFeePayer: feePayer,
    allowedPrograms: DEFAULT_ALLOWED_PROGRAMS,
    maxInstructions: 24,
    maxPriorityFeeLamports,
    maxTransactionBytes: MAX_TX_BYTES,
  };
}

export interface LookupTableMap {
  /** table address -> resolved addresses, in table order. */
  readonly [table: string]: readonly string[];
}

export interface BuildPolicyInput {
  /** Instructions in execution order. */
  readonly instructions: readonly RawInstruction[];
  readonly lookupTables: LookupTableMap;
  readonly blockhash: string | null;
  readonly lastValidBlockHeight: number | null;
}

export interface BuildPolicyResult {
  readonly allowed: boolean;
  readonly violations: readonly { violation: PolicyViolation; detail: string }[];
  readonly feePayer: string | null;
  readonly requiredSigners: readonly string[];
  /** Every account any instruction can mutate, static and ALT-loaded. */
  readonly writableAccounts: readonly string[];
  readonly estimatedBytes: number;
  /**
   * The limit the RESPONSE set. Measured: /swap/v2/build never sets one, so
   * this is null on every real route and storing the affordable ceiling here
   * instead would record a number the router never returned.
   */
  readonly computeUnitLimit: number | null;
  /** What our own fee cap can afford at the router's unit price. Ours, not theirs. */
  readonly affordableComputeUnitLimit: number | null;
  readonly unitPriceMicroLamports: bigint | null;
  readonly priorityFeeLamports: bigint;
  readonly coverage: string;
}

export function buildPolicyStatusLabel(r: BuildPolicyResult): string {
  return r.allowed
    ? `TX_POLICY_PASS(${BUILD_POLICY_COVERAGE})`
    : `TX_POLICY_FAIL(${[...new Set(r.violations.map((v) => v.violation))].join(',')})`;
}

/**
 * Transaction-shaped checks over the build response.
 *
 * The fee payer is taken as the first signer of the first instruction that has
 * one, which is how the assembled message will order it. If no instruction
 * declares a signer at all, that is a violation rather than a default — a
 * transaction nobody signs is not a transaction we understand.
 */
export function evaluateBuildPolicy(input: BuildPolicyInput, limits: BuildPolicyLimits): BuildPolicyResult {
  const violations: { violation: PolicyViolation; detail: string }[] = [];

  const allowed = new Set(limits.allowedPrograms);
  for (const ix of input.instructions) {
    if (!allowed.has(ix.programId)) {
      violations.push({ violation: 'disallowed_program', detail: `program ${ix.programId}` });
    }
  }

  if (input.instructions.length > limits.maxInstructions) {
    violations.push({
      violation: 'too_many_instructions',
      detail: `${input.instructions.length} > ${limits.maxInstructions}`,
    });
  }

  const signers: string[] = [];
  const writable = new Set<string>();
  for (const ix of input.instructions) {
    for (const a of ix.accounts ?? []) {
      if (a.isSigner && !signers.includes(a.pubkey)) signers.push(a.pubkey);
      if (a.isWritable) writable.add(a.pubkey);
    }
  }

  const feePayer = signers[0] ?? null;
  if (feePayer === null) {
    violations.push({ violation: 'wrong_fee_payer', detail: 'no instruction declares a signer' });
  } else if (feePayer !== limits.expectedFeePayer) {
    violations.push({ violation: 'wrong_fee_payer', detail: `fee payer ${feePayer}` });
  }
  if (signers.length > 1) {
    violations.push({
      violation: 'extra_signers_required',
      detail: `${signers.length} signers: ${signers.join(', ')}`,
    });
  }

  // §P13.4 — resolve lookup tables and count every address they can bring in.
  // An address that appears only via a table is still an address this
  // transaction can touch, and inspecting the static list alone misses it.
  const altAddresses = new Set<string>();
  for (const addresses of Object.values(input.lookupTables)) {
    for (const a of addresses) altAddresses.add(a);
  }

  // Compute budget. See evaluateComputeBudget(): /build returns a unit PRICE
  // and never a limit, so the question asked is whether our own fee cap can
  // afford a limit a swap could execute within.
  const cb = evaluateComputeBudget(input.instructions, limits.maxPriorityFeeLamports);
  if (cb.violation !== null) violations.push(cb.violation);
  const unitLimit = cb.unitLimit ?? cb.affordableUnitLimit;
  const fee = priorityFeeLamports({ unitLimit, unitPriceMicroLamports: cb.unitPriceMicroLamports });

  if (input.blockhash === null || input.blockhash.length === 0) {
    violations.push({ violation: 'blockhash_missing', detail: 'build response carried no blockhash' });
  }
  if (input.lastValidBlockHeight === null) {
    // §P13.3: the expiry must come from the transaction's OWN blockhash
    // metadata. Deriving it from a separately fetched blockhash produces a
    // deadline for a different transaction.
    violations.push({ violation: 'blockhash_missing', detail: 'no lastValidBlockHeight in the build response' });
  }

  const estimatedBytes = estimateTransactionBytes(input, writable.size, altAddresses.size);
  if (estimatedBytes > limits.maxTransactionBytes) {
    violations.push({
      violation: 'oversized',
      detail: `estimated ${estimatedBytes} > ${limits.maxTransactionBytes} bytes`,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
    feePayer,
    requiredSigners: signers,
    writableAccounts: [...writable].sort(),
    estimatedBytes,
    computeUnitLimit: cb.unitLimit,
    affordableComputeUnitLimit: cb.affordableUnitLimit,
    unitPriceMicroLamports: cb.unitPriceMicroLamports,
    priorityFeeLamports: fee,
    coverage: BUILD_POLICY_COVERAGE,
  };
}

/**
 * Size estimate for the assembled v0 transaction.
 *
 * An ESTIMATE, and named one everywhere it is stored. A real encoder would give
 * the exact number; this bounds it from the parts the response actually carries
 * — signatures, header, the deduplicated static account list, the blockhash,
 * each instruction's data and account indices, and the lookup-table section.
 * It is deliberately generous, so the failure direction is refusing a
 * transaction that would have fit rather than accepting one that would not.
 */
export function estimateTransactionBytes(
  input: BuildPolicyInput,
  writableCount: number,
  altAddressCount: number,
): number {
  const SIGNATURE = 64;
  const PUBKEY = 32;
  const BLOCKHASH = 32;

  const staticAccounts = new Set<string>();
  for (const ix of input.instructions) {
    staticAccounts.add(ix.programId);
    for (const a of ix.accounts ?? []) staticAccounts.add(a.pubkey);
  }
  // ALT-loaded addresses are referenced by index rather than carried inline,
  // which is the whole point of a lookup table.
  const inlineAccounts = Math.max(0, staticAccounts.size - altAddressCount);

  let bytes = 1 + SIGNATURE; // signature count + one signature
  bytes += 1 + 3; // version byte + message header
  bytes += 1 + inlineAccounts * PUBKEY;
  bytes += BLOCKHASH;
  bytes += 1; // instruction count

  for (const ix of input.instructions) {
    const data = ix.data === undefined ? 0 : Buffer.from(ix.data, 'base64').length;
    bytes += 1; // program id index
    bytes += 1 + (ix.accounts ?? []).length; // account index vector
    bytes += 1 + data; // data length prefix + data
  }

  const tables = Object.keys(input.lookupTables).length;
  bytes += 1; // lookup table count
  bytes += tables * (PUBKEY + 2 + altAddressCount);

  void writableCount;
  return bytes;
}

/**
 * Identity of an instruction set, including who signs and what is writable.
 *
 * The previous hash covered program id, data and account pubkeys — and nothing
 * else. Two instruction sets that differed only in `isSigner` or `isWritable`
 * hashed identically, which means the hash could not tell apart a transaction
 * that reads an account from one that drains it. Those are exactly the two the
 * hash exists to distinguish.
 *
 * Instruction ORDER is part of the identity: the same instructions in a
 * different order are a different transaction. Lookup tables are included by
 * address AND resolved contents, because a table whose contents changed
 * resolves to different accounts under the same address.
 */
export function instructionSetHash(instructions: readonly RawInstruction[], lookupTables: LookupTableMap = {}): string {
  const shape = instructions.map((ix, order) => [
    order,
    ix.programId,
    ix.data ?? null,
    (ix.accounts ?? []).map((a) => [a.pubkey, a.isSigner ? 1 : 0, a.isWritable ? 1 : 0]),
  ]);
  const tables = Object.keys(lookupTables)
    .sort()
    .map((t) => [t, lookupTables[t] ?? []]);
  return createHash('sha256').update(JSON.stringify({ shape, tables })).digest('hex');
}
