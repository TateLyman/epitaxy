import { createHash } from 'node:crypto';
import type { RawInstruction } from './instructionpolicy.js';

/**
 * P2/F12 — the exact account plan of a leg, frozen once.
 *
 * The SDK chooses things. It selects a fee recipient from a list, it appends
 * remaining accounts when cashback applies, and it derives associated token
 * accounts from whatever token program the mint happens to use. Two builds of
 * "the same" leg are therefore not guaranteed to be the same transaction, and
 * a system that captures state for one build, simulates a second and
 * fingerprints a third is comparing three different experiments.
 *
 * The rule this module exists to enforce is:
 *
 * ```
 * build once -> capture from THAT plan -> execute THOSE bytes -> fingerprint THEM
 * ```
 *
 * A plan is a description of the bytes that actually ran. Nothing here rebuilds
 * anything, and nothing derives an account a second time and assumes it landed
 * on the same answer.
 */

export interface PlannedAccount {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
  /**
   * Where it sits in the instruction.
   *
   * Position is the identity for a remaining account: PumpSwap reads the
   * cashback accumulator ATA at remaining index 0 and the accumulator PDA at
   * index 1, so "present" and "present in the right place" are different facts.
   */
  readonly index: number;
}

export interface PlannedInstruction {
  readonly programId: string;
  /** base64. The exact instruction data, not a re-encoding of its arguments. */
  readonly data: string;
  readonly accounts: readonly PlannedAccount[];
}

export interface AccountPlan {
  readonly leg: string;
  readonly instructions: readonly PlannedInstruction[];
  /** Every program the plan invokes directly, in first-seen order. */
  readonly programIds: readonly string[];
  /** Every account any instruction touches, deduped, in first-seen order. */
  readonly accounts: readonly string[];
  /** Accounts the plan will WRITE. A read-only account cannot bear a fee. */
  readonly writableAccounts: readonly string[];
  /**
   * sha256 over programs, data and ordered metas.
   *
   * Two plans with this fingerprint are the same transaction shape. A plan
   * whose fingerprint moved between capture and execution is a different
   * experiment wearing the same label.
   */
  readonly fingerprint: string;
}

export class AccountPlanIncomplete extends Error {
  constructor(readonly reason: string) {
    super(`account plan incomplete: ${reason}`);
    this.name = 'AccountPlanIncomplete';
  }
}

/**
 * Freeze a built leg.
 *
 * Refuses an instruction with no data or no metas rather than recording an
 * empty list. An instruction whose accounts are unknown cannot be checked
 * against a snapshot, and a plan that silently describes nothing would pass
 * every coverage test written against it.
 */
export function freezeAccountPlan(leg: string, instructions: readonly RawInstruction[]): AccountPlan {
  if (instructions.length === 0) throw new AccountPlanIncomplete(`${leg} built no instructions`);

  const planned: PlannedInstruction[] = [];
  for (const [i, ix] of instructions.entries()) {
    if (typeof ix.programId !== 'string' || ix.programId.length === 0) {
      throw new AccountPlanIncomplete(`${leg} instruction ${i} names no program`);
    }
    if (ix.accounts === undefined) {
      throw new AccountPlanIncomplete(
        `${leg} instruction ${i} (${ix.programId}) carries no account metas, so nothing can verify what it touches`,
      );
    }
    if (ix.data === undefined) {
      throw new AccountPlanIncomplete(`${leg} instruction ${i} (${ix.programId}) carries no data`);
    }
    planned.push({
      programId: ix.programId,
      data: ix.data,
      accounts: ix.accounts.map((a, index) => ({
        pubkey: a.pubkey,
        isSigner: a.isSigner,
        isWritable: a.isWritable,
        index,
      })),
    });
  }

  const programIds: string[] = [];
  const accounts: string[] = [];
  const writable: string[] = [];
  for (const ix of planned) {
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
    for (const a of ix.accounts) {
      if (!accounts.includes(a.pubkey)) accounts.push(a.pubkey);
      if (a.isWritable && !writable.includes(a.pubkey)) writable.push(a.pubkey);
    }
  }

  const h = createHash('sha256');
  h.update(leg);
  for (const ix of planned) {
    h.update('|p:');
    h.update(ix.programId);
    h.update('|d:');
    h.update(ix.data);
    for (const a of ix.accounts) {
      // Position is part of the identity, so reordering changes the hash.
      h.update(`|a${a.index}:${a.pubkey}:${a.isSigner ? 1 : 0}${a.isWritable ? 1 : 0}`);
    }
  }

  return {
    leg,
    instructions: planned,
    programIds,
    accounts,
    writableAccounts: writable,
    fingerprint: h.digest('hex'),
  };
}

/**
 * Every account the plan touches must be in the captured state.
 *
 * This is the check the derived-address approach could not make. The snapshot
 * was built from `swapAccountAddresses`, which RE-DERIVES what it thinks the
 * leg will use; the plan says what it actually uses. A fee recipient the SDK
 * selected from a list, an ATA derived under a token program nobody predicted,
 * or a remaining account appended for cashback all appear here and in none of
 * the derivations.
 *
 * Returns the accounts that are missing. An empty result is the only safe one:
 * an account absent from the runtime does not fail loudly, it executes as an
 * uninitialised account and produces an error that reads as a fact about the
 * token.
 */
export function planAccountsNotCaptured(
  plan: AccountPlan,
  captured: readonly string[],
): readonly string[] {
  const have = new Set(captured);
  return plan.accounts.filter((a) => !have.has(a));
}

/**
 * The plan that was captured is the plan that ran.
 *
 * Called with the fingerprint frozen before capture and the one taken from the
 * bytes handed to the runtime. They are the same object today, and this exists
 * so that they still have to be the same object tomorrow — the defect it guards
 * against is somebody adding a convenient rebuild between the two.
 */
export function assertPlanUnchanged(frozen: AccountPlan, executed: AccountPlan): void {
  if (frozen.fingerprint === executed.fingerprint) return;
  const differing: string[] = [];
  if (frozen.instructions.length !== executed.instructions.length) {
    differing.push(`instruction count ${frozen.instructions.length} -> ${executed.instructions.length}`);
  }
  for (const [i, a] of frozen.instructions.entries()) {
    const b = executed.instructions[i];
    if (b === undefined) continue;
    if (a.programId !== b.programId) differing.push(`ix${i} program ${a.programId} -> ${b.programId}`);
    if (a.data !== b.data) differing.push(`ix${i} data changed`);
    for (const [j, m] of a.accounts.entries()) {
      const n = b.accounts[j];
      if (n === undefined) differing.push(`ix${i} account ${j} disappeared`);
      else if (m.pubkey !== n.pubkey) differing.push(`ix${i} account ${j} ${m.pubkey} -> ${n.pubkey}`);
    }
  }
  throw new AccountPlanIncomplete(
    `the plan changed between capture and execution: ${differing.slice(0, 4).join('; ') || 'fingerprint differs'}`,
  );
}
