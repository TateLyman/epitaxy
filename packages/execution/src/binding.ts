import { SYSTEM_PROGRAM } from '../../solana/src/txpolicy.js';
import { readComputeBudget, priorityFeeLamports, type DecodedTransaction } from '../../solana/src/transaction.js';
import type { TradeIntent } from '../../domain/src/types.js';

/**
 * Binding a transaction to the intent that asked for it.
 *
 * The transaction policy answers "is this transaction structurally sane". It
 * does not answer "is this the transaction we asked for". A perfectly
 * well-formed Jupiter swap that spends ten times the intended amount passes
 * every policy check, because nothing in the policy knows what we intended.
 *
 * What this file can prove from the bytes alone is deliberately narrow, and the
 * narrowness is the point. Swap amounts live inside an aggregator's instruction
 * data whose layout we do not control and cannot verify against a current
 * source at signing time; guessing at a discriminator would produce a check
 * that appears to bound the amount and does not. So the byte-level check bounds
 * only what is unambiguous — explicit lamport transfers out of our own account,
 * the priority fee, and the clock — and the amount bound is established
 * separately by simulating the transaction and reading the resulting balances.
 *
 * The signer requires both. Neither alone is sufficient and neither pretends to
 * be.
 */

export type BindingViolation =
  | 'intent_expired'
  | 'priority_fee_exceeds_intent'
  | 'lamport_outflow_exceeds_intent'
  | 'undecodable_system_transfer';

export interface BindingResult {
  readonly bound: boolean;
  readonly violations: readonly { violation: BindingViolation; detail: string }[];
  /** Lamports moved out of the fee payer by explicit System transfers. */
  readonly lamportOutflow: bigint;
  readonly priorityFeeLamports: bigint;
}

const SYSTEM_TRANSFER_TAG = 2;
const SYSTEM_TRANSFER_LEN = 12;

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i] as number);
  return v;
}

/**
 * Sums lamports leaving the fee payer through System Program transfers. Account
 * index 0 is the fee payer by definition, so a transfer whose source is index 0
 * is money leaving us. Transfers between other accounts are not ours to bound.
 */
function lamportOutflowFromPayer(tx: DecodedTransaction): { total: bigint; undecodable: number } {
  let total = 0n;
  let undecodable = 0;
  for (const ix of tx.instructions) {
    if (tx.staticAccountKeys[ix.programIdIndex] !== SYSTEM_PROGRAM) continue;
    const d = ix.data;
    if (d.length < 4) {
      undecodable++;
      continue;
    }
    const tag = (d[0] as number) | ((d[1] as number) << 8) | ((d[2] as number) << 16) | ((d[3] as number) << 24);
    if (tag !== SYSTEM_TRANSFER_TAG) continue;
    if (d.length !== SYSTEM_TRANSFER_LEN) {
      // A Transfer whose data is the wrong length is not a Transfer we
      // understand, and an amount we cannot read is not an amount we can bound.
      undecodable++;
      continue;
    }
    if (ix.accountIndexes[0] !== 0) continue;
    total += readU64LE(d, 4);
  }
  return { total, undecodable };
}

/**
 * Largest lamport outflow the intent tolerates. A buy spends its input in SOL
 * plus whatever fees and rent the round trip incurs; a sell spends only the
 * latter, because its input is the token.
 */
function outflowCeiling(intent: TradeIntent): bigint {
  return intent.side === 'buy'
    ? intent.maxInputAmount + intent.maxTotalFeeLamports
    : intent.maxTotalFeeLamports;
}

export function evaluateBinding(
  tx: DecodedTransaction,
  intent: TradeIntent,
  nowUtcMs: number,
): BindingResult {
  const violations: { violation: BindingViolation; detail: string }[] = [];

  if (nowUtcMs >= intent.deadlineUtcMs) {
    violations.push({
      violation: 'intent_expired',
      detail: `now ${nowUtcMs} >= deadline ${intent.deadlineUtcMs}`,
    });
  }

  const fee = priorityFeeLamports(readComputeBudget(tx));
  if (fee > intent.maxPriorityFeeLamports) {
    violations.push({
      violation: 'priority_fee_exceeds_intent',
      detail: `${fee} > ${intent.maxPriorityFeeLamports}`,
    });
  }

  const { total, undecodable } = lamportOutflowFromPayer(tx);
  if (undecodable > 0) {
    violations.push({
      violation: 'undecodable_system_transfer',
      detail: `${undecodable} System instruction(s) could not be read as a transfer`,
    });
  }
  const ceiling = outflowCeiling(intent);
  if (total > ceiling) {
    violations.push({
      violation: 'lamport_outflow_exceeds_intent',
      detail: `${total} > ${ceiling} lamports for a ${intent.side}`,
    });
  }

  return {
    bound: violations.length === 0,
    violations,
    lamportOutflow: total,
    priorityFeeLamports: fee,
  };
}
