import { describe, it, expect } from 'vitest';
import {
  appliedComputeLimit,
  chargedPriorityFee,
  MAX_COMPUTE_UNIT_LIMIT,
} from '../../packages/solana/src/computebudget.js';
import { frozenComputeLimit, FROZEN_CU_MARGIN_PCT, MIN_REQUESTED_CU } from '../../packages/solana/src/cu-budget.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';
import { decodeTransaction, readComputeBudget } from '../../packages/solana/src/transaction.js';
import {
  entryCashOut,
  exitCashIn,
  expectedFailureCost,
  quoteLeg,
  quoteRoundTrip,
  costBps,
} from '../../packages/domain/src/accounting.js';
import {
  missingBuildField,
  FAMILY_CONTRACTS,
  ROUTE_FAMILIES,
  type BuildFields,
} from '../../packages/domain/src/execution.js';
import {
  classifyRejectOutcome,
  rejectReturnBps,
  isReturnBearing,
  isConfirmedWorthless,
} from '../../packages/domain/src/rejectoutcome.js';
import { isPnlEligible, transferFeeOrUnknown, type MeasuredLegSettlement } from '../../packages/domain/src/settlement.js';
import { judgeConfirmatory, requiredPositions } from '../../packages/domain/src/confirmatory.js';
import { boundedCounterfactual, BOUNDED_IMPACT_CAP_BPS, CounterfactualRefused } from '../../packages/pipeline/src/counterfactual.js';
import { takeMark, MARK_OFFSETS_MS } from '../../packages/pipeline/src/mark-path.js';
import { parseAmount, formatAmount } from '../../packages/domain/src/amounts.js';
import { BlobStore, EXACT_TRANSACTION_SCHEMA_VERSION, type ExactTransactionBlob } from '../../packages/storage/src/blobstore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * d70b4a9a §2 — THE BLOCKING SET, in one place, each item passing or failing.
 *
 * Of the 54 regression tests in §22 of 4890af0, the measurement-power directive
 * names a subset that can "fabricate or destroy edge" and blocks collection on
 * them. The directive's final report has to state each one's verdict, and until
 * now those verdicts were spread across a dozen files under three different
 * numbering schemes: `accounting.test.ts` labels them §10.1 to §10.6,
 * `daemon-contract.test.ts` labels five of them §22.5 to §22.21, and
 * `paper-core.test.ts` labels none of them at all.
 *
 * So this file is an INDEX, not a replacement. Each item below carries its §22
 * number and asserts the invariant that makes the behaviour possible, at the
 * module boundary, executing the code. Where the end-to-end behaviour is proven
 * somewhere else, the primary test is NAMED in the comment — never re-proved by
 * reading its source as a string, which is the failure mode
 * `tests/unit/directive-coverage.test.ts` documents at length.
 *
 * THE GAP IN §2.1 IS DELIBERATE AND VISIBLE
 *
 * The delivered PDF's §2.1, "Blocking — lookahead and family coherence", carries
 * its heading and NO item list; the text layer lost it. Rather than invent
 * numbers, the last describe block asserts the property the heading names, and
 * says that is what it is doing.
 */

// ---------------------------------------------------------------------------
// FIXTURES, against the real return types
// ---------------------------------------------------------------------------

const SOL = 'So11111111111111111111111111111111111111112';
/** A real 32-byte pubkey, because the encoder decodes base58 and checks the length. */
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

const completeBuild: BuildFields = {
  inputMint: SOL,
  outputMint: MINT,
  inAmount: 20_000_000n,
  outAmount: 16_227_715_590n,
  otherAmountThreshold: 15_741_505_674n,
  routePlanEntries: 1,
  instructionCount: 7,
  hasSwapInstruction: true,
  lookupTablesResolved: true,
  blockhash: 'H4rXNVpTQ2rZ9Cc2h4bSMEtC5rYYRTAcCzrbY6zpNQ5A',
  lastValidBlockHeight: 350_000_000,
  contextSlot: 349_999_000,
};
const want = { inputMint: SOL, outputMint: MINT, requestedAmount: 20_000_000n };

/** The first effect-verified round trip production produced, as settlement.test.ts uses it. */
const settlement = (over: Partial<MeasuredLegSettlement> = {}): MeasuredLegSettlement => ({
  observationId: 'obs',
  simulationJobId: 'job',
  side: 'buy',
  family: 'BUILD_CUSTOM',
  capabilityFingerprint: 'fp',
  input: {
    kind: 'native_sol',
    requestedLamports: 20_000_000n,
    actualTradeDebitLamports: 20_000_000n,
    totalPayerDebitLamports: 24_087_331n,
  },
  output: {
    kind: 'token',
    mint: MINT,
    tokenProgram: LEGACY_TOKEN_PROGRAM,
    tokenAccount: 'Ata',
    minimumAtoms: 15_741_505_674n,
    expectedAtoms: 16_227_715_590n,
    actualCreditAtoms: 16_227_715_590n,
  },
  costs: {
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 3_771n,
    tipLamports: 0n,
    protocolFeeLamports: null,
    creatorFeeLamports: null,
    lpFeeLamports: null,
    platformFeeLamports: 0n,
    transferFeeAtoms: null,
    transferFeeLamportsEquivalent: null,
    rentCreatedLamports: 4_078_560n,
    rentRecoveredLamports: 0n,
    failedAttemptCostLamports: 0n,
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: 24_078_560n,
  },
  createdAccounts: ['a', 'b'],
  closedAccounts: [],
  residualTokenAtoms: 0n,
  payerNativeDeltaLamports: -24_087_331n,
  fullAccountCoverage: true,
  effectValid: true,
  effectRefusals: [],
  snapshotManifestHash: 'snap',
  replayable: true,
  complete: true,
  incompleteness: [],
  ...over,
});

const confirmatoryEvidence = {
  completedPositions: 400,
  cvObserved: 6,
  tailConcentrationDisclosed: true,
  distinctUtcDays: 24,
  netPnlLamports: 50_000_000n,
  expectedLogGrowth: 0.02,
  robustLowerBound: 0.004,
  profitFactor: 1.4,
  maxDrawdownBps: 800,
  cvarBps: 900,
  catastrophicIncidence: 0.01,
  blockedExitIncidence: 0.05,
  recentFiftyNetLamports: 8_000_000n,
  netWithoutTopThreeLamports: 20_000_000n,
  maxSingleDayShare: 0.2,
  maxSingleMintShare: 0.25,
  netUnderDoubleCostsLamports: 12_000_000n,
  netUnderLatencyStressLamports: 9_000_000n,
  exactCanarySizeShadowNetLamports: 3_000_000n,
  replayDivergences: 0,
  unresolvedReconciliations: 0,
  fingerprintsStable: true,
  maxDrawdownBpsAllowed: 1_500,
  maxCvarBpsAllowed: 1_500,
  maxCatastrophicIncidence: 0.05,
  maxBlockedExitIncidence: 0.2,
};

// ---------------------------------------------------------------------------
// §2.3 — SILENT NUMERIC CORRUPTION
// ---------------------------------------------------------------------------

describe('§2.3 blocking — §22.9 a u64 above 2^53 is exact or refused', () => {
  it('carries a 1e9-supply mint at 6 decimals through parse and format unchanged', () => {
    // 1e9 supply at 6 decimals is 1e15 atoms and 2^53 is about 9.007e15, so an
    // ordinary position in a high-supply mint sits within a factor of nine of
    // the boundary and a large one crosses it.
    const atoms = parseAmount('1000000000', 6);
    expect(atoms).toBe(1_000_000_000_000_000n);
    expect(formatAmount(atoms, 6)).toBe('1000000000');
  });

  it('keeps two amounts distinct that a double would merge', () => {
    const a = 9_007_199_254_740_993n; // 2^53 + 1
    const b = 9_007_199_254_740_992n; // 2^53
    expect(a).not.toBe(b);
    // The float round trip that would merge them, shown merging them.
    expect(Number(a)).toBe(Number(b));
    // And the exact path keeping them apart, through the money formatter.
    expect(formatAmount(a, 6)).not.toBe(formatAmount(b, 6));
  });

  it('costs a leg exactly at a size no double could represent', () => {
    const huge = 12_345_678_901_234_567n;
    const leg = quoteLeg(
      {
        signatureFeeLamports: 5_000n,
        priorityFeeLamports: 1_047n,
        ataRentLamports: 2_039_280n,
        broadcasterTipLamports: 0n,
        platformFeeLamports: 0n,
      },
      expectedFailureCost({ landedFailures: 0, total: 0 }, 6_047n, 'assumed-zero'),
    );
    expect(leg.totalCostLamports).toBe(6_047n);
    // The bps of a huge notional is a small integer and is still computed on
    // bigints, so it can never round through a float on the way.
    expect(costBps(leg.totalCostLamports, huge)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §2.2 — COST FABRICATION
// ---------------------------------------------------------------------------

describe('§2.2 blocking — §22.16 a missing minimum output fails', () => {
  it('accepts the complete build', () => {
    expect(missingBuildField(completeBuild, want)).toBeNull();
  });

  it('refuses a null and a zero minimum, which are the same unbounded fill', () => {
    expect(missingBuildField({ ...completeBuild, otherAmountThreshold: null }, want)).toBe('MISSING_MINIMUM_OUTPUT');
    expect(missingBuildField({ ...completeBuild, otherAmountThreshold: 0n }, want)).toBe('MISSING_MINIMUM_OUTPUT');
    expect(missingBuildField({ ...completeBuild, outAmount: null }, want)).toBe('MISSING_MINIMUM_OUTPUT');
  });
});

describe('§2.2 blocking — §22.17 a missing blockhash, expiry or context fails', () => {
  it('refuses a missing blockhash and a missing expiry', () => {
    expect(missingBuildField({ ...completeBuild, blockhash: null }, want)).toBe('MISSING_BLOCKHASH');
    expect(missingBuildField({ ...completeBuild, blockhash: '' }, want)).toBe('MISSING_BLOCKHASH');
    expect(missingBuildField({ ...completeBuild, lastValidBlockHeight: null }, want)).toBe('MISSING_EXPIRY');
    expect(missingBuildField({ ...completeBuild, lastValidBlockHeight: 0 }, want)).toBe('MISSING_EXPIRY');
  });

  it('blocks EVIDENCE rather than collection on a context slot the provider never sends', () => {
    // Measured: Jupiter's /build returns no contextSlot on any observation in
    // the corpus. A hard veto there refuses 100% of builds and halts collection,
    // which is the MT001/MT002 error. The absence blocks confirmatory grading
    // instead, which is where a fact about provider coverage belongs.
    expect(missingBuildField({ ...completeBuild, contextSlot: null }, want)).toBeNull();
  });
});

describe('§2.2 blocking — §22.26 the priority fee uses the ceiling', () => {
  const priced = (unitPriceMicroLamports: bigint, explicitLimit: number | null): bigint => {
    const ix = [
      // SetComputeUnitPrice: discriminator 3, u64 LE.
      {
        programId: COMPUTE_BUDGET_PROGRAM,
        accounts: [],
        data: Buffer.concat([
          Buffer.from([3]),
          (() => {
            const b = Buffer.alloc(8);
            b.writeBigUInt64LE(unitPriceMicroLamports);
            return b;
          })(),
        ]).toString('base64'),
      },
      ...(explicitLimit === null
        ? []
        : [
            {
              programId: COMPUTE_BUDGET_PROGRAM,
              accounts: [],
              data: Buffer.concat([
                Buffer.from([2]),
                (() => {
                  const b = Buffer.alloc(4);
                  b.writeUInt32LE(explicitLimit);
                  return b;
                })(),
              ]).toString('base64'),
            },
          ]),
      { programId: SYSTEM_PROGRAM, accounts: [{ pubkey: MINT, isSigner: false, isWritable: true }], data: '' },
    ];
    const tx = decodeTransaction(
      encodeUnsignedTransaction(compileMessage(ix, MINT, 'H4rXNVpTQ2rZ9Cc2h4bSMEtC5rYYRTAcCzrbY6zpNQ5A')),
    );
    return chargedPriorityFee(tx, readComputeBudget(tx)).lamports;
  };

  it('rounds UP, so a fee never disappears into truncation', () => {
    // A price of 1 microlamport against a 50,000-unit limit is 0.05 lamports.
    // Floored that is nothing, and it is charged on every leg forever.
    expect(priced(1n, 50_000)).toBe(1n);
    expect(priced(1_000_000n, 50_000)).toBe(50_000n);
  });

  it('is not zero when the router omits SetComputeUnitLimit', () => {
    // The defect this replaced: a real price multiplied by a null limit.
    const withoutLimit = priced(3_810n, null);
    expect(withoutLimit).toBeGreaterThan(0n);
  });

  it('clamps an explicit limit at the runtime maximum rather than honouring it', () => {
    expect(priced(1_000_000n, 5_000_000)).toBe(BigInt(MAX_COMPUTE_UNIT_LIMIT));
  });
});

describe('§2.2 blocking — §22.27 the default CU limit matches the official rule', () => {
  it('gives a native builtin 3,000 and everything else 200,000', () => {
    expect(appliedComputeLimit([SYSTEM_PROGRAM], null).units).toBe(3_000);
    expect(appliedComputeLimit([MINT], null).units).toBe(200_000);
    expect(appliedComputeLimit([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, MINT], null).units).toBe(206_000);
  });

  it('clamps the derived total at 1,400,000', () => {
    const many = Array.from({ length: 20 }, () => MINT);
    const r = appliedComputeLimit(many, null);
    expect(r.units).toBe(MAX_COMPUTE_UNIT_LIMIT);
    expect(r.clamped).toBe(true);
  });

  it('treats an unresolvable ALT-loaded program as non-builtin, the dearer answer', () => {
    // Wrong in the direction that makes the trade look worse.
    expect(appliedComputeLimit([null], null).units).toBe(200_000);
  });

  it('says where the number came from, so a cost is never silently defaulted', () => {
    expect(appliedComputeLimit([SYSTEM_PROGRAM], null).source).toBe('derived-from-instructions');
    expect(appliedComputeLimit([SYSTEM_PROGRAM], 50_000).source).toBe('explicit');
  });
});

describe('§2.2 blocking — §22.28 the two-pass rebuild uses the frozen margin', () => {
  it('requests the measured units plus exactly the frozen margin', () => {
    const plan = frozenComputeLimit(228_985);
    expect(plan).not.toBeNull();
    expect(plan?.marginPct).toBe(FROZEN_CU_MARGIN_PCT);
    expect(plan?.requestedUnits).toBe(Math.ceil(228_985 * (1 + FROZEN_CU_MARGIN_PCT / 100)));
    expect(plan?.derivedFromMeasurement).toBe(true);
  });

  it('returns null rather than a default when nothing was measured', () => {
    // A guessed limit is indistinguishable in the transaction from a measured
    // one and costs real lamports in either direction.
    expect(frozenComputeLimit(null)).toBeNull();
    expect(frozenComputeLimit(0)).toBeNull();
  });

  it('floors a tiny measurement at the minimum request', () => {
    expect(frozenComputeLimit(100)?.requestedUnits).toBe(MIN_REQUESTED_CU);
  });
});

describe('§2.2 blocking — §22.29 the failed-attempt expectation is not double-charged', () => {
  it('charges the expectation once per leg and never twice for one leg', () => {
    const failure = expectedFailureCost({ landedFailures: 50, total: 1_000 }, 6_047n, 'upper-confidence-bound');
    const out = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 0n,
      rentCreatedLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      failure,
    });
    const withoutFailure = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 0n,
      rentCreatedLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      failure: expectedFailureCost({ landedFailures: 0, total: 1_000 }, 6_047n, 'observed'),
    });
    expect(out.cashLamports - withoutFailure.cashLamports).toBe(failure.expectedLamports);
  });

  it('scales with the conditional cost instead of charging one flat amount', () => {
    const cheap = expectedFailureCost({ landedFailures: 1, total: 10 }, 5_000n, 'observed');
    const dear = expectedFailureCost({ landedFailures: 1, total: 10 }, 500_000n, 'observed');
    expect(dear.expectedLamports).toBeGreaterThan(cheap.expectedLamports * 50n - 1n);
  });

  it('labels an unobserved rate rather than presenting zero as measured', () => {
    const none = expectedFailureCost({ landedFailures: 0, total: 0 }, 6_047n, 'observed');
    expect(none.expectedLamports).toBe(0n);
    expect(none.basis).toBe('assumed-zero');
    // And an unknown basis makes the whole quote incomplete.
    const unknown = expectedFailureCost({ landedFailures: 0, total: 0 }, 6_047n, 'unknown');
    expect(quoteLeg(
      {
        signatureFeeLamports: 5_000n,
        priorityFeeLamports: 1_047n,
        ataRentLamports: 0n,
        broadcasterTipLamports: 0n,
        platformFeeLamports: 0n,
      },
      unknown,
    ).complete).toBe(false);
  });
});

describe('§2.2 blocking — §22.30 a same-transaction ATA close pays no extra signature', () => {
  const exit = (separateCloseTransaction: boolean): bigint =>
    exitCashIn({
      outputLamports: 19_500_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 0n,
      transferFeeLamports: 0n,
      separateCloseTransaction,
      rentRecoveredLamports: 2_039_280n,
      failure: expectedFailureCost({ landedFailures: 0, total: 1_000 }, 6_047n, 'observed'),
    }).cashLamports;

  it('charges exactly one base fee when the close rides the exit', () => {
    expect(exit(false) - exit(true)).toBe(5_000n);
  });

  it('does charge the second one when the close genuinely needs its own transaction', () => {
    expect(exit(true)).toBeLessThan(exit(false));
  });
});

describe('§2.2 blocking — §22.31 the rent treatment matches viability and PnL', () => {
  const leg = quoteLeg(
    {
      signatureFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      ataRentLamports: 2_039_280n,
      broadcasterTipLamports: 0n,
      platformFeeLamports: 0n,
    },
    expectedFailureCost({ landedFailures: 0, total: 1_000 }, 6_047n, 'observed'),
  );

  it('keeps recoverable rent OUT of cost and IN locked capital', () => {
    expect(leg.totalCostLamports).toBe(6_047n);
    expect(leg.lockedCapitalLamports).toBe(2_039_280n);
  });

  it('books rent as a real loss exactly when it is not recovered', () => {
    const recovered = quoteRoundTrip({ entry: leg, exit: leg, closesAtaInExitTransaction: true, ataRentRecovered: true });
    const lost = quoteRoundTrip({ entry: leg, exit: leg, closesAtaInExitTransaction: true, ataRentRecovered: false });
    expect(recovered.unrecoveredRentLamports).toBe(0n);
    expect(lost.unrecoveredRentLamports).toBe(2_039_280n);
    expect(lost.totalCostLamports - recovered.totalCostLamports).toBe(2_039_280n);
    // The size of the mistake: on a 0.02 SOL notional, charging a recovered
    // rent is 1,020 bps, four times the whole real cost of the round trip.
    expect(costBps(2_039_280n, 20_000_000n)).toBe(1_020);
  });

  it('agrees with the cash-flow view term for term', () => {
    const out = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 0n,
      rentCreatedLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      failure: expectedFailureCost({ landedFailures: 0, total: 1_000 }, 6_047n, 'observed'),
    });
    // Capital leaves including rent; what is SPENT excludes it.
    expect(out.cashLamports - out.spentLamports).toBe(2_039_280n);
    expect(out.lockedCapitalLamports).toBe(leg.lockedCapitalLamports);
  });
});

describe('§2.2 blocking — §22.32 an unknown transfer fee cannot be confirmatory', () => {
  it('is zero for legacy Token, which HAS no such extension', () => {
    const legacy = settlement();
    expect(transferFeeOrUnknown(legacy)).toBe(0n);
  });

  it('is UNKNOWN, never zero, for an unmeasured Token-2022 leg', () => {
    const t22 = settlement({
      output: {
        kind: 'token',
        mint: MINT,
        tokenProgram: TOKEN_2022,
        tokenAccount: 'Ata',
        minimumAtoms: 1n,
        expectedAtoms: 2n,
        actualCreditAtoms: 2n,
      },
    });
    expect(transferFeeOrUnknown(t22)).toBeNull();
  });

  it('and an incomplete settlement is not PnL-eligible', () => {
    const incomplete = settlement({ complete: false, incompleteness: ['transfer fee not measured'] });
    const v = isPnlEligible(incomplete);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('transfer fee');
  });
});

describe('§2.2 blocking — §22.43 a shadow exit includes all costs', () => {
  it('nets the exit base fee, priority fee and failure expectation out of the proceeds', () => {
    const gross = 19_500_000n;
    const cash = exitCashIn({
      outputLamports: gross,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 250n,
      transferFeeLamports: 100n,
      separateCloseTransaction: false,
      rentRecoveredLamports: 0n,
      failure: expectedFailureCost({ landedFailures: 50, total: 1_000 }, 6_047n, 'upper-confidence-bound'),
    });
    // Every term, once, and none of them optional.
    expect(cash.cashLamports).toBe(gross - 5_000n - 1_047n - 250n - 100n - 303n);
  });

  it('refuses to be complete when the exit transfer fee was never observed', () => {
    const cash = exitCashIn({
      outputLamports: 19_500_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 1_047n,
      routeTipLamports: 0n,
      transferFeeLamports: null,
      separateCloseTransaction: false,
      rentRecoveredLamports: 0n,
      failure: expectedFailureCost({ landedFailures: 0, total: 1_000 }, 6_047n, 'observed'),
    });
    expect(cash.complete).toBe(false);
  });
});

describe('§2.2 blocking — §22.48 a provider disappearance is not -100%', () => {
  it('classifies a vanished provider as PROVIDER_MISSING and prices it as nothing at all', () => {
    const outcome = classifyRejectOutcome({
      providerAnswered: false,
      routeExists: null,
      executableValueLamports: null,
      buildable: null,
      poolReservesLamports: null,
      sourceGap: false,
    });
    expect(outcome).toBe('PROVIDER_MISSING');
    expect(isReturnBearing(outcome)).toBe(false);
    // null, and emphatically not -10,000 bps.
    expect(rejectReturnBps(outcome, 20_000_000n, null)).toBeNull();
  });

  it('checks OUR blindness before anything else', () => {
    const outcome = classifyRejectOutcome({
      providerAnswered: false,
      routeExists: null,
      executableValueLamports: null,
      buildable: null,
      poolReservesLamports: null,
      sourceGap: true,
    });
    expect(outcome).toBe('SOURCE_GAP');
  });

  it('still accepts a CONFIRMED total loss as one', () => {
    const outcome = classifyRejectOutcome({
      providerAnswered: true,
      routeExists: false,
      executableValueLamports: null,
      buildable: null,
      poolReservesLamports: 0n,
      sourceGap: false,
    });
    expect(outcome).toBe('NO_ROUTE_CONFIRMED');
    // Worthless and return-BEARING are different predicates: only an
    // EXECUTABLE_VALUE carries a number that may be averaged into a return,
    // while a confirmed absence of any route is priced at -100% directly.
    expect(isConfirmedWorthless(outcome)).toBe(true);
    expect(isReturnBearing(outcome)).toBe(false);
    expect(rejectReturnBps(outcome, 20_000_000n, 0n)).toBe(-10_000);
  });
});

// ---------------------------------------------------------------------------
// §2.4 — EVIDENCE INTEGRITY
// ---------------------------------------------------------------------------

describe('§2.4 blocking — §22.15 an exact transaction blob round-trips', () => {
  it('returns the same bytes it was given, and refuses altered ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocking-set-'));
    try {
      const store = new BlobStore(dir);
      const blob: ExactTransactionBlob = {
        schemaVersion: EXACT_TRANSACTION_SCHEMA_VERSION,
        rawBuildResponse: '{"ok":true}',
        instructions: [{ programId: SYSTEM_PROGRAM, accounts: [], data: 'AQID' }],
        lookupTables: { TableA: ['AddrOne', 'AddrTwo'] },
        transactionBase64: 'AQAAAAAA',
        messageBase64: 'AAAA',
        messageHash: 'm',
        transactionHash: 't',
        blockhash: 'H4rXNVpTQ2rZ9Cc2h4bSMEtC5rYYRTAcCzrbY6zpNQ5A',
        lastValidBlockHeight: 350_000_000,
        contextSlot: 349_999_000,
        packetBytes: 1_039,
        feePayer: MINT,
        requiredSignatures: 1,
        staticAccountKeys: [MINT, SYSTEM_PROGRAM],
        loadedAddresses: ['AddrOne'],
        writableAccounts: [MINT],
        readonlyAccounts: [SYSTEM_PROGRAM],
        capturedUtcMs: 1_787_000_000_000,
      };
      const ref = store.put(blob);
      const back = store.get<ExactTransactionBlob>(ref.hash);
      expect(back).toEqual(blob);
      // The resolved table CONTENTS come back, not just the table address: a
      // table extended since resolves to different accounts under the same key.
      expect(back.lookupTables['TableA']).toEqual(['AddrOne', 'AddrTwo']);
      expect(store.verify(ref.hash)).toBe(true);
      // A hash nothing was stored under is a miss, not an empty blob.
      expect(() => store.get('0'.repeat(64))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('§2.4 blocking — §22.21 and §22.22 incomplete account coverage refuses', () => {
  it('refuses a leg that did not observe every writable it touched', () => {
    const v = isPnlEligible(settlement({ fullAccountCoverage: false }));
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('every writable');
  });

  it('refuses a residue no named cost explains, however small', () => {
    const one = settlement({
      costs: { ...settlement().costs, unexplainedLamports: 1n },
    });
    expect(isPnlEligible(one).ok).toBe(false);
  });

  it('does NOT refuse the value that legitimately reaches unnamed accounts', () => {
    // Every AMM swap moves lamports into pool vaults and the account it creates.
    // Read as unexplained cost, that condemns exactly the legs that worked.
    const s = settlement({
      costs: { ...settlement().costs, valueToUnnamedAccountsLamports: 24_078_560n, unexplainedLamports: 0n },
    });
    expect(isPnlEligible(s).ok).toBe(true);
  });

  it('§22.22 an unverified effect is not a pass', () => {
    // The ALT-loaded writable post-state is observed through the same coverage
    // flag; the manifest's key_source column is what distinguishes STATIC from
    // ALT_LOADED, and neither may be missing. The behavioural proof over real
    // manifests is tests/simulator/daemon-contract.test.ts §22.21.
    const v = isPnlEligible(settlement({ effectValid: false, effectRefusals: ['post-state not observed'] }));
    expect(v.ok).toBe(false);
  });
});

describe('§2.4 blocking — §22.34 a portfolio mark cannot use /order', () => {
  it('never treats the router families as PnL-eligible', () => {
    expect(FAMILY_CONTRACTS.ORDER_EXECUTE.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.QUOTE_ONLY_BENCHMARK.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.BUILD_CUSTOM.pnlEligible).toBe(true);
    // And every family is accounted for, so a new one cannot arrive unclassified.
    for (const f of ROUTE_FAMILIES) expect(FAMILY_CONTRACTS[f]).toBeDefined();
  });

  it('takes a mark from the pool bytes, and refuses rather than falling back', async () => {
    // The mark path's reader exposes getAccountRaw and nothing else, so no
    // router response can enter it even by mistake. A reader that cannot answer
    // yields a REFUSAL with its reason, never a price from somewhere else.
    const mark = await takeMark(
      {
        getAccountRaw: async () => {
          throw new Error('endpoint refused');
        },
      },
      {
        mint: MINT,
        tokenAmount: 16_227_715_590n,
        slippagePct: 3,
        globalConfig: 'GlobalConfig',
        feeConfig: 'FeeConfig',
        offsetMs: MARK_OFFSETS_MS[0],
        openedAtMs: 1_787_000_000_000,
      },
    );
    expect(mark.executableLamports).toBeNull();
    expect(mark.refusal).not.toBeNull();
    // A refusal still carries its offset and lateness, so the gap is countable.
    expect(mark.offsetMs).toBe(MARK_OFFSETS_MS[0]);
    expect(mark.latenessMs).toBeGreaterThanOrEqual(0);
  });
});

describe('§2.4 blocking — §22.53 zero simulator observations cannot be valid PnL', () => {
  it('refuses a settlement whose effect was never verified', () => {
    expect(isPnlEligible(settlement({ effectValid: false, effectRefusals: ['NOT_VERIFIED'] })).ok).toBe(false);
  });

  it('refuses a confirmatory window with no positions at all', () => {
    const v = judgeConfirmatory({ ...confirmatoryEvidence, completedPositions: 0 });
    expect(v.passed).toBe(false);
    expect(v.sufficientSample).toBe(false);
  });

  it('and the sample requirement cannot be met by omitting the CV', () => {
    expect(requiredPositions(null)).toBeNull();
    expect(judgeConfirmatory({ ...confirmatoryEvidence, cvObserved: null }).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2.1 — LOOKAHEAD AND FAMILY COHERENCE
//
// The PDF carries this heading and no item list. What follows asserts the
// PROPERTY the heading names, and is labelled as inferred rather than as the
// list that was delivered.
// ---------------------------------------------------------------------------

describe('§2.1 blocking (item list lost in the PDF) — lookahead and family coherence', () => {
  it('§22.35 the counterfactual is bounded, and refuses above the frozen cap', () => {
    const input = {
      trajectoryId: 'traj',
      offsetMs: 60_000,
      entryBaseDeltaAtoms: -16_227_715_590n,
      entryQuoteDeltaLamports: 20_000_000n,
      observedBaseReserve: 900_000_000_000_000n,
      observedQuoteReserve: 18_000_000_000n,
      tokensHeldAtoms: 16_227_715_590n,
      entryImpactBps: BOUNDED_IMPACT_CAP_BPS,
      nowMs: 1_787_000_000_000,
    };
    const ok = boundedCounterfactual(input);
    expect(ok.evidenceGrade).toBe('DEVELOPMENT');
    expect(ok.refusal).toBeNull();
    // One basis point above the frozen cap and the row is refused, not haircut
    // harder: a bound that stretches to cover any impact is not a bound.
    expect(() => boundedCounterfactual({ ...input, entryImpactBps: BOUNDED_IMPACT_CAP_BPS + 1 })).toThrow(
      CounterfactualRefused,
    );
  });

  it('§22.35 the haircut can only make the counterfactual exit worse', () => {
    const input = {
      trajectoryId: 'traj',
      offsetMs: 60_000,
      entryBaseDeltaAtoms: -16_227_715_590n,
      entryQuoteDeltaLamports: 20_000_000n,
      observedBaseReserve: 900_000_000_000_000n,
      observedQuoteReserve: 18_000_000_000n,
      tokensHeldAtoms: 16_227_715_590n,
      entryImpactBps: 5,
      nowMs: 1_787_000_000_000,
    };
    const r = boundedCounterfactual(input);
    expect(r.haircutBps).toBeGreaterThan(0);
    expect(r.haircutLamports).toBeGreaterThanOrEqual(0n);
    // A later state the entry moved by more than the cap is not approximately
    // the state the position would have faced, and no haircut makes it so.
    expect(r.counterfactualExitLamports).toBeGreaterThanOrEqual(0n);
  });

  it('one family per round trip: the contracts differ in what they may claim', () => {
    // A round trip whose legs come from two families is two markets, not one
    // round trip. The behavioural refusal is tests/unit/paper-core.test.ts
    // "refuses a cross-family round trip"; what is asserted here is that the
    // families really do carry different contracts, so mixing them is not a
    // cosmetic distinction.
    const contracts = ROUTE_FAMILIES.map((f) => FAMILY_CONTRACTS[f]);
    const distinct = new Set(contracts.map((c) => `${c.pnlEligible}|${c.feeIncludedInAmounts}`));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('the mark schedule is fixed in advance, so a horizon cannot be chosen after the fact', () => {
    // Seven offsets, frozen as a constant. A mark taken at a moment picked once
    // the price is known is the purest form of lookahead available here.
    expect([...MARK_OFFSETS_MS]).toEqual([60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]);
    expect(MARK_OFFSETS_MS.length).toBe(7);
  });
});
