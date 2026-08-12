import {
  decodeTransaction,
  readComputeBudget,
  priorityFeeLamports,
  COMPUTE_BUDGET_PROGRAM,
  TxDecodeError,
  type DecodedTransaction,
} from './transaction.js';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './mint.js';

/**
 * Transaction policy.
 *
 * The signer's contract is: it signs a transaction it has understood, or it
 * signs nothing. Not "it signs what Jupiter sent, because Jupiter is
 * reputable". A compromised or merely buggy router is indistinguishable from a
 * malicious one at the point where bytes arrive, and the loss is total either
 * way.
 *
 * Every check below is a refusal. There are no warnings, because a warning in
 * an automated path is a value that gets logged and ignored.
 */

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Programs our own trades legitimately invoke. Routing programs reached by CPI
 * from Jupiter are not in this list and do not need to be: they are invoked by
 * an allowed program, not by us, and the aggregator's own output constraint is
 * what bounds their behaviour.
 */
export const DEFAULT_ALLOWED_PROGRAMS: readonly string[] = [
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  JUPITER_V6,
  MEMO_PROGRAM,
];

export type PolicyViolation =
  | 'undecodable'
  | 'wrong_fee_payer'
  | 'extra_signers_required'
  | 'disallowed_program'
  | 'too_many_instructions'
  | 'priority_fee_too_high'
  | 'compute_limit_missing'
  | 'blockhash_missing'
  | 'oversized';

export interface PolicyLimits {
  /** The only key this process may ever sign with. */
  readonly expectedFeePayer: string;
  readonly allowedPrograms: readonly string[];
  readonly maxInstructions: number;
  readonly maxPriorityFeeLamports: bigint;
  readonly maxTransactionBytes: number;
}

export interface PolicyResult {
  readonly allowed: boolean;
  readonly violations: readonly { violation: PolicyViolation; detail: string }[];
  readonly decoded: DecodedTransaction | null;
  readonly priorityFeeLamports: bigint;
}

/** Solana's packet limit; anything larger cannot land and is a sign of trouble. */
export const MAX_TX_BYTES = 1232;

export function defaultLimits(feePayer: string, maxPriorityFeeLamports: bigint): PolicyLimits {
  return {
    expectedFeePayer: feePayer,
    allowedPrograms: DEFAULT_ALLOWED_PROGRAMS,
    maxInstructions: 24,
    maxPriorityFeeLamports,
    maxTransactionBytes: MAX_TX_BYTES,
  };
}

export function evaluateTransactionPolicy(raw: Uint8Array, limits: PolicyLimits): PolicyResult {
  const violations: { violation: PolicyViolation; detail: string }[] = [];

  if (raw.length > limits.maxTransactionBytes) {
    return {
      allowed: false,
      violations: [{ violation: 'oversized', detail: `${raw.length} > ${limits.maxTransactionBytes} bytes` }],
      decoded: null,
      priorityFeeLamports: 0n,
    };
  }

  let decoded: DecodedTransaction;
  try {
    decoded = decodeTransaction(raw);
  } catch (e) {
    const detail = e instanceof TxDecodeError ? e.message : `unexpected decode failure: ${(e as Error).message}`;
    return {
      allowed: false,
      violations: [{ violation: 'undecodable', detail }],
      decoded: null,
      priorityFeeLamports: 0n,
    };
  }

  // The fee payer is account 0 by definition. If it is not us, this transaction
  // was built for someone else's wallet and our signature would be a gift.
  const feePayer = decoded.staticAccountKeys[0];
  if (feePayer !== limits.expectedFeePayer) {
    violations.push({ violation: 'wrong_fee_payer', detail: `fee payer ${feePayer ?? 'none'}` });
  }

  // A second required signer means the transaction only executes once some
  // other party co-signs — a structure our flow never legitimately produces.
  if (decoded.numRequiredSignatures !== 1) {
    violations.push({
      violation: 'extra_signers_required',
      detail: `${decoded.numRequiredSignatures} signatures required`,
    });
  }

  const allowed = new Set(limits.allowedPrograms);
  for (const ix of decoded.instructions) {
    const program = decoded.staticAccountKeys[ix.programIdIndex];
    if (program === undefined || !allowed.has(program)) {
      violations.push({ violation: 'disallowed_program', detail: `program ${program ?? 'unknown'}` });
    }
  }

  if (decoded.instructions.length > limits.maxInstructions) {
    violations.push({
      violation: 'too_many_instructions',
      detail: `${decoded.instructions.length} > ${limits.maxInstructions}`,
    });
  }

  const cb = readComputeBudget(decoded);
  const fee = priorityFeeLamports(cb);
  if (cb.unitLimit === null) {
    // Without an explicit unit limit the transaction is charged at the default
    // ceiling, which makes the fee we modelled a fiction.
    violations.push({ violation: 'compute_limit_missing', detail: 'no SetComputeUnitLimit instruction' });
  }
  if (fee > limits.maxPriorityFeeLamports) {
    violations.push({
      violation: 'priority_fee_too_high',
      detail: `${fee} > ${limits.maxPriorityFeeLamports} lamports`,
    });
  }

  if (decoded.recentBlockhash === '1'.repeat(32)) {
    violations.push({ violation: 'blockhash_missing', detail: 'all-zero recent blockhash' });
  }

  return { allowed: violations.length === 0, violations, decoded, priorityFeeLamports: fee };
}
