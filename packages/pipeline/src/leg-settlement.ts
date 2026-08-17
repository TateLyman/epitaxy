import type { MeasuredLegSettlement } from '../../domain/src/settlement.js';
import type { CreatedAccount } from '../../solana/src/created-accounts.js';

/**
 * P5 — a canonical settlement for a leg that ran in the sequential runtime.
 *
 * `buildTrajectorySettlement` has existed and been correct for several commits.
 * Nothing called it: the only call site is `trajectory-kernel.ts`, which the
 * collector never reaches, and there was no `trajectory_settlements` table. So
 * every trajectory's net PnL was UNKNOWN by CONSTRUCTION rather than for want
 * of a sample — the collector measured a round trip in full and then threw the
 * economics away.
 *
 * The gap was never the arithmetic. It was that nothing turned a runtime leg
 * into a `MeasuredLegSettlement`, which is what this does.
 *
 * ## The one primitive
 *
 * Everything is derived from the PAYER'S OWN NATIVE DELTA. That is the single
 * quantity that cannot disagree with itself. Assembling a round trip out of a
 * credit read here and a debit read there is exactly how the exit's fees and
 * rent went missing from an earlier version of this system's accounting.
 *
 * ## Unexplained is DERIVED, never assumed
 *
 * ```
 * unexplained = payerNativeDelta
 *             − (credit − tradeDebit − fees − tip − rentCreated + rentRecovered)
 * ```
 *
 * It must be zero for a PnL-eligible leg. A residue is not rounding: it is a
 * cost the model does not know about, and a cost the model does not know about
 * is what turns a positive backtest into a negative account. It is reported at
 * whatever value it takes.
 */

/** One account as the worker observed it. */
export interface ObservedAccount {
  readonly pubkey: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly dataLen: number;
  readonly dataBase64: string | null;
}

/**
 * A single-signer transaction's base fee.
 *
 * A FAMILY FACT, not an estimate: these legs carry exactly one signature, the
 * taker's, and Solana charges 5,000 lamports per signature. It is stated here
 * rather than measured because the runtime reports a payer delta with the fee
 * already inside it, and separating a known constant out of a total is not the
 * same as guessing at one.
 */
export const BASE_FEE_PER_SIGNATURE_LAMPORTS = 5_000n;

const tokenAmount = (a: ObservedAccount | undefined): bigint | null => {
  if (a === undefined || a.dataBase64 === null) return null;
  const b = Buffer.from(a.dataBase64, 'base64');
  return b.length >= 72 ? b.readBigUInt64LE(64) : null;
};

const lamportsOf = (xs: readonly ObservedAccount[], key: string): bigint | null =>
  xs.find((a) => a.pubkey === key)?.lamports ?? null;

export interface LegSettlementInput {
  readonly observationId: string;
  readonly simulationJobId: string;
  readonly side: 'buy' | 'sell';
  readonly capabilityFingerprint: string;
  readonly taker: string;
  readonly takerBaseAta: string;
  readonly mint: string;
  readonly baseTokenProgram: string;
  readonly poolQuoteVault: string;
  /** What the caller asked for: lamports on a buy, atoms on a sell. */
  readonly requested: bigint;
  /** The router/builder floor, when one was quoted. */
  readonly minimumOut: bigint;
  readonly pre: readonly ObservedAccount[];
  readonly post: readonly ObservedAccount[];
  readonly createdAccounts: readonly CreatedAccount[];
  /** Accounts the leg closed, whose rent came back to the payer. */
  readonly closedAccounts: readonly string[];
  /**
   * Where the rent of a closed account was originally paid.
   *
   * The base ATA is opened on the BUY and closed on the SELL, so the sell's own
   * `createdAccounts` is empty and a recovery lookup against it finds nothing.
   * Measured live: `rentRecovered` was 0 on every settlement while
   * `baseAtaClosedInSell` was true and the lamports had visibly returned.
   */
  readonly rentSourceAccounts?: readonly CreatedAccount[];
  /**
   * Accounts whose gain is NOT a venue fee.
   *
   * The payer, our own token accounts and the pool vaults are excluded
   * automatically; this is for anything else that legitimately receives value
   * without it being a cost — the taker WSOL ATA, for instance.
   */
  readonly notSkimAccounts?: readonly string[];
  readonly runtimeOk: boolean;
  readonly incompleteness: readonly string[];
  /**
   * Whether every writable the leg touched was observed.
   *
   * Passed in rather than inferred: this module cannot know what the
   * instruction declared writable, and guessing would make the strongest
   * coverage claim in the system the least grounded one.
   */
  readonly fullAccountCoverage: boolean;
  readonly snapshotManifestHash: string | null;
}

/**
 * Build the leg settlement, measuring everything from the observation.
 *
 * A quantity that could not be read is `null`, and `complete` becomes false
 * with the reason named. Nothing here substitutes a zero for an absence.
 */
export function legSettlementFromRuntime(p: LegSettlementInput): MeasuredLegSettlement {
  const incompleteness: string[] = [...p.incompleteness];

  const payerPre = lamportsOf(p.pre, p.taker);
  const payerPost = lamportsOf(p.post, p.taker);
  if (payerPre === null || payerPost === null) {
    incompleteness.push('the payer was not observed on both sides, so no cash figure is derivable');
  }
  const payerDelta = payerPre === null || payerPost === null ? 0n : payerPost - payerPre;

  // What the POOL took in or gave out. Read from the vault, never from a quote.
  const qPre = tokenAmount(p.pre.find((a) => a.pubkey === p.poolQuoteVault));
  const qPost = tokenAmount(p.post.find((a) => a.pubkey === p.poolQuoteVault));
  if (qPre === null || qPost === null) {
    incompleteness.push('the pool quote vault was not readable, so the trade leg is unmeasured');
  }
  const quoteVaultDelta = qPre === null || qPost === null ? 0n : qPost - qPre;

  const basePre = tokenAmount(p.pre.find((a) => a.pubkey === p.takerBaseAta)) ?? 0n;
  const basePost = tokenAmount(p.post.find((a) => a.pubkey === p.takerBaseAta)) ?? 0n;

  const rentCreated = p.createdAccounts.reduce((n, a) => n + a.rentExemptMinimumLamports, 0n);
  const rentSource = [...p.createdAccounts, ...(p.rentSourceAccounts ?? [])];
  const rentRecovered = p.closedAccounts.reduce((n, key) => {
    // Only rent we actually opened comes back, and only for accounts we closed
    // — but the account may have been opened by the OTHER leg.
    const created = rentSource.find((a) => a.pubkey === key);
    return n + (created?.rentExemptMinimumLamports ?? 0n);
  }, 0n);

  const baseFee = BASE_FEE_PER_SIGNATURE_LAMPORTS;
  // No SetComputeUnitPrice instruction is built, so the unit price is zero and
  // the priority fee is zero. A FACT about the transaction, not an assumption.
  const priorityFee = 0n;
  const tip = 0n;

  const isBuy = p.side === 'buy';
  const tradeDebit = isBuy ? quoteVaultDelta : 0n;
  const credit = isBuy ? 0n : -quoteVaultDelta;

  /**
   * What the venue skimmed, NAMED.
   *
   * The pool releases X on a sell and the payer receives X minus the protocol,
   * buyback and creator cuts, which land in accounts the plan names. Reading
   * the vault delta as the payer's credit and calling the difference
   * unexplained turns a known cost into a mystery.
   */
  /**
   * The venue skim, defined COMPLETELY rather than enumerated.
   *
   * Three attempts named it by role and each missed a different account: first
   * the buyback recipient, then the accumulator, then the PROTOCOL fee
   * recipient — a named account the SDK selects from the global config, worth
   * 183,704 lamports on a measured leg. A cost model that depends on somebody
   * remembering every role is wrong on exactly the role nobody remembered.
   *
   * So it is defined by exclusion instead: every observed account that GAINED
   * lamports and is not the payer, not one of our token accounts, and not a
   * pool vault, has been paid by this leg. What remains after removing the rent
   * of accounts we opened is what the venue took.
   *
   * This cannot be incomplete in the same way. A new fee recipient in a future
   * IDL is captured the day it appears, without anyone naming it.
   */
  const notASkim = new Set([p.taker, p.takerBaseAta, p.poolQuoteVault, ...(p.notSkimAccounts ?? [])]);
  let venueFee = 0n;
  for (const a of p.post) {
    if (notASkim.has(a.pubkey)) continue;
    const before = lamportsOf(p.pre, a.pubkey) ?? 0n;
    const gained = a.lamports - before;
    if (gained <= 0n) continue;
    // Rent is not a fee, even when both land in the same account. An account
    // opened AND paid in one transaction carries two different quantities.
    const created = rentSource.find((x) => x.pubkey === a.pubkey);
    venueFee += created === undefined ? gained : created.excessLamports;
  }

  /**
   * THE CONSERVATION IDENTITY, which needs no model at all.
   *
   * Lamports are conserved. Rent is a transfer from the payer to a new account;
   * a venue fee is a transfer from the payer to a recipient; both net to zero
   * across the observed set. The ONLY lamports that leave are the transaction
   * fee. So if every account the leg touched was observed:
   *
   *   sum of every observed lamport delta  ==  -(transaction fee)
   *
   * Two earlier attempts itemised the outflows instead — trade, rent, then the
   * venue skim — and each got the residue WRONG in a new way, because an
   * itemisation is only as complete as the list of roles someone remembered.
   * This asks the question the itemisation was standing in for, and it cannot
   * be incomplete in the same way: an unattributed lamport shows up whether or
   * not anybody knew what to call it.
   *
   * A non-zero value means one of exactly two things, and both are worth
   * knowing: an account moved that nobody observed, or lamports left the system
   * by a route this does not model.
   *
   * The itemised figures below are kept for REPORTING. They say where the money
   * went; this says whether the account of it is complete.
   */
  const observedKeys = new Set([...p.pre.map((a) => a.pubkey), ...p.post.map((a) => a.pubkey)]);
  let totalDelta = 0n;
  for (const key of observedKeys) {
    const before = lamportsOf(p.pre, key) ?? 0n;
    const after = lamportsOf(p.post, key) ?? 0n;
    totalDelta += after - before;
  }
  const unexplained = totalDelta + baseFee;

  /**
   * Value that reached accounts the request did not name.
   *
   * NOT the same as unexplained, and the distinction cost a measurement cycle
   * once already: every AMM swap moves lamports into pool vaults and into the
   * accounts it creates, so this is large and non-zero on every SUCCESSFUL
   * leg. Read as "unexplained cost" it condemns exactly the legs that worked.
   */
  const named = new Set([p.taker, p.takerBaseAta, p.poolQuoteVault]);
  let toUnnamed = 0n;
  for (const a of p.post) {
    if (named.has(a.pubkey)) continue;
    const before = lamportsOf(p.pre, a.pubkey) ?? 0n;
    const d = a.lamports - before;
    if (d > 0n) toUnnamed += d;
  }

  if (!p.runtimeOk) incompleteness.push('the leg did not commit in the runtime');
  if (!p.fullAccountCoverage) incompleteness.push('not every writable the leg touched was observed');

  const acquired = basePost - basePre;

  return {
    observationId: p.observationId,
    simulationJobId: p.simulationJobId,
    side: p.side,
    // The direct builder, not a router. A family is a claim about what produced
    // the bytes, and these bytes came from the official PumpSwap builder.
    family: 'BUILD_CUSTOM',
    capabilityFingerprint: p.capabilityFingerprint,
    input: isBuy
      ? {
          kind: 'native_sol',
          requestedLamports: p.requested,
          actualTradeDebitLamports: tradeDebit,
          totalPayerDebitLamports: payerDelta < 0n ? -payerDelta : 0n,
        }
      : {
          kind: 'token',
          mint: p.mint,
          tokenProgram: p.baseTokenProgram,
          tokenAccount: p.takerBaseAta,
          requestedAtoms: p.requested,
          actualDebitAtoms: basePre - basePost,
        },
    output: isBuy
      ? {
          kind: 'token',
          mint: p.mint,
          tokenProgram: p.baseTokenProgram,
          tokenAccount: p.takerBaseAta,
          minimumAtoms: p.minimumOut,
          expectedAtoms: null,
          actualCreditAtoms: acquired > 0n ? acquired : 0n,
        }
      : {
          kind: 'native_sol',
          minimumLamports: p.minimumOut,
          expectedLamports: null,
          actualCreditLamports: credit,
        },
    costs: {
      baseFeeLamports: baseFee,
      priorityFeeLamports: priorityFee,
      tipLamports: tip,
      // The venue's split is not decomposed here. That does not make PnL
      // unknown: input and output were both measured, and how the venue divided
      // its cut between LP, protocol and creator does not change what the
      // wallet did.
      // MEASURED as a total from the accounts that received it. The split
      // between protocol, buyback and creator is not decomposed, and that does
      // not make PnL unknown: input and output were both measured, and how the
      // venue divided its cut does not change what the wallet did.
      protocolFeeLamports: venueFee,
      creatorFeeLamports: null,
      lpFeeLamports: null,
      // A FAMILY FACT for a directly-built leg: there is no platform fee
      // because there is no platform. Zero here is measured, not assumed.
      platformFeeLamports: 0n,
      // NOT_APPLICABLE rather than unknown: a legacy SPL mint has no transfer
      // fee extension, so there is no fee to measure. The caller supplies a
      // Token-2022 figure by naming it in `incompleteness` when it could not
      // be read.
      transferFeeAtoms: 0n,
      transferFeeLamportsEquivalent: 0n,
      rentCreatedLamports: rentCreated,
      rentRecoveredLamports: rentRecovered,
      failedAttemptCostLamports: 0n,
      unexplainedLamports: unexplained,
      valueToUnnamedAccountsLamports: toUnnamed,
    },
    createdAccounts: p.createdAccounts.map((a) => a.pubkey),
    closedAccounts: [...p.closedAccounts],
    residualTokenAtoms: isBuy ? acquired : basePost,
    payerNativeDeltaLamports: payerDelta,
    fullAccountCoverage: p.fullAccountCoverage,
    effectValid: p.runtimeOk,
    effectRefusals: p.runtimeOk ? [] : ['the leg did not commit in the runtime'],
    snapshotManifestHash: p.snapshotManifestHash,
    // Every leg here ran against exact captured state inside one runtime, and
    // the plan of the bytes that ran is frozen alongside it.
    replayable: p.runtimeOk,
    complete: incompleteness.length === 0,
    incompleteness,
  };
}

/**
 * Which unobserved writables are a real COVERAGE GAP.
 *
 * The worker reports `unobserved` for anything it was asked to read and could
 * not find. Once the observe set became the full frozen plan, that list began
 * including three quite different things, and only one is a defect:
 *
 *   - accounts the leg CREATES, absent before execution by definition;
 *   - accounts created AND CLOSED inside the same transaction, such as the
 *     taker WSOL ATA the SDK wraps and unwraps on every leg, which exists in
 *     neither the pre nor the post observation;
 *   - a writable that was there all along and nobody looked at. THIS one.
 *
 * Measured live: all seven blocking addresses were in the frozen plan and
 * ABSENT ON CHAIN. Treating them as missing coverage made
 * `fullAccountCoverage` false on every leg, so the canonical settlement refused
 * a net PnL for runs where nothing was actually unmeasured — an impossibility
 * reported as an omission.
 *
 * The test is the PRE state alone. An earlier version checked pre OR post,
 * which counted an account the leg created as one that existed and so excluded
 * nothing at all.
 */
export function coverageGap(
  unobserved: readonly string[],
  preAccounts: readonly { pubkey: string; lamports: bigint }[],
): string[] {
  const existed = new Set<string>();
  for (const a of preAccounts) if (a.lamports > 0n) existed.add(a.pubkey);
  // Entries may carry a reason alongside the address, so match by containment.
  return unobserved.filter((u) => [...existed].some((k) => u.includes(k)));
}
