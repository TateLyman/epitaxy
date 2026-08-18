import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeMicrostructureFeatures,
  type PreMigrationTrade,
} from '../../packages/intelligence/src/migration-microstructure.js';
import { decodeCurveTrade, fetchPreMigrationHistory } from '../../packages/intelligence/src/migration-history.js';
import {
  buildFlowBars,
  buildAccountInclude,
  reconcileToConfirmed,
  ForbiddenSubscriptionAddress,
  type FlowEvent,
} from '../../packages/intelligence/src/targeted-flow.js';
import { computePreEntrySignals } from '../../packages/intelligence/src/pre-entry-signals.js';
import { mintBehaviourSafe } from '../../packages/intelligence/src/mintfacts.js';
import { externalPriorScore, refuseExternalPriorInPolicy, ExternalPriorMisuse } from '../../packages/intelligence/src/external-prior.js';
import { evaluateWithCoverage } from '../../packages/strategy/src/policy-coverage.js';
import { decideEntry, type PreEntryFeatures } from '../../packages/strategy/src/treatments.js';
import {
  chooseSize,
  pooledSetupCost,
  SetupPoolingError,
  CANDIDATE_SIZES_LAMPORTS as CANDIDATE_SIZES,
  type SizeMechanics,
} from '../../packages/strategy/src/size-rule.js';
import { labelStrata, cashbackAdjustedPnl, CashbackNotMeasured } from '../../packages/strategy/src/fee-strata.js';
import {
  assertDistinctSnapshots,
  assertNoFutureInput,
  EntryClockViolation,
  type ClockDecision,
} from '../../packages/pipeline/src/entry-clocks.js';
import { fragility, pairedDeltas, type MintOutcome } from '../../packages/research/src/robust-stats.js';
import { rejectPanelReport } from '../../packages/research/src/reject-panel-v4.js';
import { SharedEndpointBudget, endpointIdentity } from '../../packages/adapters/src/endpoint-budget.js';
import { planDemotion } from '../../scripts/evidence-invalidate-old.js';
import { collectorTrees } from '../../scripts/collector-ops.js';
import { expectedRemainingTail, decodeUserVolumeAccumulator } from '../../packages/solana/src/cashback.js';
import { signerAllowed } from '../../packages/domain/src/config.js';
import { openDb } from '../../packages/storage/src/db.js';
import { base58Encode } from '../../packages/solana/src/base58.js';
import {
  chunkForAccountBatch,
  MAX_ACCOUNTS_PER_CALL,
  isBudgetExhausted,
  RpcError,
} from '../../packages/solana/src/rpc.js';

/**
 * P19 — the tests that must FAIL against the audited head `aaf6d6a`.
 *
 * Every one exercises a real function on real data. There is not a single
 * source grep in this file, because a grep asserts that a string is present and
 * this directive is being run precisely because strings were present and the
 * behaviour was not: six signal fields were declared, typed, documented,
 * threaded into a policy — and set to the literal `null`.
 */

const MIGRATION_SLOT = 1_000;
const MIGRATION_MS = 1_700_000_000_000;

function trade(over: Partial<PreMigrationTrade> = {}): PreMigrationTrade {
  return {
    signature: 'sigA',
    eventIndex: 0,
    slot: 900,
    blockTimeMs: MIGRATION_MS - 60_000,
    side: 'buy',
    quoteLamports: 1_000_000n,
    baseAtoms: 100n,
    actor: 'buyer1',
    failed: false,
    curveRealSolAfterLamports: 10_000_000n,
    ...over,
  };
}

function baseInput(trades: readonly PreMigrationTrade[], coverage: 'COMPLETE' | 'INCOMPLETE' = 'COMPLETE') {
  return {
    mint: 'MINT',
    bondingCurve: 'CURVE',
    creator: 'creator1',
    migrationSignature: 'migSig',
    migrationSlot: MIGRATION_SLOT,
    migrationBlockTimeMs: MIGRATION_MS,
    trades,
    coverage,
    migrationReserveLamports: 85_000_000_000n,
  };
}

function features(over: Partial<PreEntryFeatures> = {}): PreEntryFeatures {
  return {
    mint: 'MINT',
    hardGatesPass: true,
    independentBuyerPersistence: null,
    nonMayhemNetQuoteInflowLamports: null,
    effectiveQuoteReserveTrend: null,
    executableExitCapacityTrend: null,
    continuationSlope: null,
    creatorNetSellingLamports: null,
    entityConcentration: null,
    mintBehaviourSafe: null,
    mechanicsViable: true,
    correctedQualityScore: null,
    scoreCoverageOk: false,
    ...over,
  };
}

function flowEvent(over: Partial<FlowEvent> = {}): FlowEvent {
  return {
    signature: 'fsig',
    eventIndex: 0,
    mint: 'MINT',
    pool: 'POOL',
    slot: 1_100,
    blockTimeMs: MIGRATION_MS + 10_000,
    side: 'buy',
    quoteLamports: 5_000_000n,
    baseAtoms: 500n,
    actor: 'w1',
    actorClass: 'INDEPENDENT',
    failed: false,
    commitment: 'confirmed',
    ...over,
  };
}

describe('P19 — profit discovery, tested as behaviour', () => {
  it('1 — a smart policy with null signal fields is NOT_EVALUABLE, not losing', () => {
    // Exactly the audited head's state: every flow input null.
    const v = evaluateWithCoverage('SURVIVOR_FLOW_CONTINUATION_V1', features(), {}, { seed: 's' });
    expect(v.decision.enter).toBe(false);
    expect(v.evaluability).toBe('NOT_EVALUABLE');
    expect(v.fullCoverage).toBe(false);
    expect(v.unknownFields).toContain('independentBuyerPersistence');

    // And a policy that HAD its inputs and declined is a different verdict.
    const declined = evaluateWithCoverage(
      'SURVIVOR_FLOW_CONTINUATION_V1',
      features({
        independentBuyerPersistence: 0.9,
        nonMayhemNetQuoteInflowLamports: 1n,
        effectiveQuoteReserveTrend: 0.1,
        // The one that fails, with everything else known.
        executableExitCapacityTrend: -0.5,
        continuationSlope: 1,
        creatorNetSellingLamports: 0n,
        entityConcentration: 0.1,
        mintBehaviourSafe: true,
      }),
      {},
      { seed: 's' },
    );
    expect(declined.evaluability).toBe('REJECTED_ON_SIGNAL');
  });

  it('2 — a post-migration transaction cannot alter migration-microstructure features', () => {
    const clean = computeMicrostructureFeatures(baseInput([trade(), trade({ signature: 'sigB', slot: 950 })]));

    // The mutation: a transaction AFTER the migration, with a huge amount.
    const contaminated = computeMicrostructureFeatures(
      baseInput([
        trade(),
        trade({ signature: 'sigB', slot: 950 }),
        trade({ signature: 'future', slot: MIGRATION_SLOT + 5, quoteLamports: 999_000_000_000n, actor: 'whale' }),
      ]),
    );

    expect(contaminated.featuresHash).toBe(clean.featuresHash);
    expect(contaminated.sourceSignaturesHash).toBe(clean.sourceSignaturesHash);
    expect(contaminated.droppedPostMigration).toBe(1);

    // The migration signature itself is also not part of the history.
    const withMigration = computeMicrostructureFeatures(
      baseInput([trade(), trade({ signature: 'sigB', slot: 950 }), trade({ signature: 'migSig', slot: 999 })]),
    );
    expect(withMigration.featuresHash).toBe(clean.featuresHash);
  });

  it('3 — an incomplete history cannot become zero flow', () => {
    const incomplete = computeMicrostructureFeatures(baseInput([trade()], 'INCOMPLETE'));
    // Every creation-anchored total is NULL, never 0.
    expect(incomplete.features.totalBuyLamports).toBeNull();
    expect(incomplete.features.netInflowLamports).toBeNull();
    expect(incomplete.features.uniqueBuyers).toBeNull();
    expect(incomplete.features.tradesToMigration).toBeNull();
    expect(incomplete.unknownFields).toContain('totalBuyLamports');

    const complete = computeMicrostructureFeatures(baseInput([trade()], 'COMPLETE'));
    expect(complete.features.totalBuyLamports).toBe('1000000');
  });

  it('4 — a duplicate transaction does not double flow', () => {
    const once = computeMicrostructureFeatures(baseInput([trade()]));
    const twice = computeMicrostructureFeatures(baseInput([trade(), trade()]));
    expect(twice.droppedDuplicate).toBe(1);
    expect(twice.features.totalBuyLamports).toBe(once.features.totalBuyLamports);

    // And in the flow bars.
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent(), flowEvent()],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.droppedDuplicate).toBe(1);
    expect(bars.bars[0]?.buyQuoteLamports).toBe(5_000_000n);
  });

  it('5 — a failed transaction does not count as flow', () => {
    const withFailed = computeMicrostructureFeatures(
      baseInput([trade(), trade({ signature: 'bad', failed: true, quoteLamports: 500_000_000n })]),
    );
    expect(withFailed.droppedFailed).toBe(1);
    expect(withFailed.features.totalBuyLamports).toBe('1000000');

    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent(), flowEvent({ signature: 'bad', failed: true, quoteLamports: 900_000_000n })],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.droppedFailed).toBe(1);
    expect(bars.bars[0]?.buyQuoteLamports).toBe(5_000_000n);

    // The decoder emits a failed transaction with ZERO amounts, so a missed
    // downstream filter is harmless rather than inflating volume.
    const decoded = decodeCurveTrade(
      {
        signature: 'f',
        slot: 10,
        blockTime: 1,
        failed: true,
        accountKeys: ['payer', 'CURVE'],
        preTokenBalances: [],
        postTokenBalances: [],
        preBalances: [0n, 1_000n],
        postBalances: [0n, 9_000_000n],
      },
      { bondingCurve: 'CURVE', mint: 'MINT' },
    );
    expect(decoded?.failed).toBe(true);
    expect(decoded?.quoteLamports).toBe(0n);
  });

  it('6 — two events in one transaction remain two events', () => {
    const both = computeMicrostructureFeatures(
      baseInput([trade({ eventIndex: 0 }), trade({ eventIndex: 1, quoteLamports: 3_000_000n })]),
    );
    expect(both.droppedDuplicate).toBe(0);
    expect(both.features.totalBuyLamports).toBe('4000000');

    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent({ eventIndex: 0 }), flowEvent({ eventIndex: 1, quoteLamports: 2_000_000n })],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.acceptedEvents).toBe(2);
    expect(bars.bars[0]?.buyQuoteLamports).toBe(7_000_000n);
  });

  it('7 — creator flow is separated from independent flow', () => {
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [
        flowEvent({ actor: 'w1', actorClass: 'INDEPENDENT', quoteLamports: 4_000_000n }),
        flowEvent({ signature: 'c1', actor: 'creator1', actorClass: 'CREATOR', side: 'sell', quoteLamports: 7_000_000n }),
      ],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    const b = bars.bars[0];
    expect(b?.creatorSellLamports).toBe(7_000_000n);
    // The creator is NOT one of the independent seller entities.
    expect(b?.uniqueSellerEntities).toBe(0);
    expect(b?.uniqueBuyerEntities).toBe(1);
  });

  it('8 — an entity/common-funder cluster is separated from independent buyers', () => {
    const entityOf = (a: string): string | null => (a.startsWith('cluster') ? 'ENTITY_A' : null);
    const r = computeMicrostructureFeatures({
      ...baseInput([
        trade({ actor: 'cluster1', quoteLamports: 8_000_000n }),
        trade({ signature: 's2', actor: 'cluster2', quoteLamports: 8_000_000n }),
        trade({ signature: 's3', actor: 'solo', quoteLamports: 1_000_000n }),
      ]),
      entityOf,
    });
    // Three wallets, two entities.
    expect(r.features.uniqueEntitiesFirst10Buyers).toBe(2);
    // And one entity dominates the path.
    expect(r.features.migrationPathEntityDominance).toBeGreaterThan(0.9);
    expect(r.features.commonFunderConcentration).toBeCloseTo(2 / 3, 5);
  });

  it('9 — known Mayhem/protocol-controlled flow cannot count as independent', () => {
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [
        flowEvent({ actor: 'mayhem1', actorClass: 'MAYHEM', quoteLamports: 50_000_000n }),
        flowEvent({ signature: 'i1', actor: 'w1', actorClass: 'INDEPENDENT' }),
      ],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.bars[0]?.uniqueBuyerEntities).toBe(1);
    expect(bars.bars[0]?.mayhemBuyLamports).toBe(50_000_000n);

    // And the signal refuses outright when Mayhem cannot be isolated.
    const s = computePreEntrySignals({
      entryClock: 'T120',
      decisionUtcMs: MIGRATION_MS + 120_000,
      flowEvents: [flowEvent()],
      checkpoints: [],
      microstructure: null,
      mayhemIsolable: false,
    });
    expect(s.nonMayhemNetQuoteInflowLamports).toBeNull();
    expect(s.nullReasons['nonMayhemNetQuoteInflowLamports']).toMatch(/could not be isolated/);
  });

  it('10 — the targeted stream contains no unrelated Pump transaction', () => {
    // A program id in the subscription is refused outright.
    expect(() =>
      buildAccountInclude([{ pool: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', baseVault: null, quoteVault: null }]),
    ).toThrow(ForbiddenSubscriptionAddress);

    const ok = buildAccountInclude([{ pool: 'POOL', baseVault: 'BV', quoteVault: 'QV' }]);
    expect(ok).toEqual(expect.arrayContaining(['POOL', 'BV', 'QV']));
    expect(ok).toHaveLength(3);

    // And an event for another pool is dropped rather than counted.
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent(), flowEvent({ signature: 'other', pool: 'OTHER_POOL', quoteLamports: 900_000_000n })],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.droppedOutOfWindow).toBe(1);
    expect(bars.bars[0]?.buyQuoteLamports).toBe(5_000_000n);
  });

  it('11 — a reconnect gap is persisted and makes its bar INCOMPLETE, not empty', () => {
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent()],
      gaps: [{ startedUtcMs: MIGRATION_MS + 5_000, endedUtcMs: MIGRATION_MS + 8_000, reason: 'socket reconnect', generation: 2 }],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    const first = bars.bars[0];
    expect(first?.coverage).toBe('INCOMPLETE');
    expect(first?.coverageReason).toMatch(/reconnect/);
    // NULL, not zero: three lost seconds are not "nobody traded".
    expect(first?.buyQuoteLamports).toBeNull();
    expect(first?.tradeCount).toBeNull();
    // A later bar the gap did not touch is unaffected.
    expect(bars.bars[1]?.coverage).toBe('COMPLETE');
  });

  it('12 — confirmed reconciliation can invalidate a processed event', () => {
    const processed = [
      flowEvent({ signature: 'kept', commitment: 'processed' }),
      flowEvent({ signature: 'rolledback', commitment: 'processed' }),
    ];
    const { kept, invalidated } = reconcileToConfirmed(processed, new Set(['kept']));
    expect(kept).toHaveLength(1);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]?.signature).toBe('rolledback');
    expect(kept[0]?.commitment).toBe('confirmed');

    // A processed event never reaches a decision-bearing bar on its own.
    const bars = buildFlowBars({
      mint: 'MINT',
      pool: 'POOL',
      migrationUtcMs: MIGRATION_MS,
      events: [flowEvent({ commitment: 'processed' })],
      gaps: [],
      observedUntilUtcMs: MIGRATION_MS + 600_000,
    });
    expect(bars.droppedUnconfirmed).toBe(1);
    expect(bars.bars[0]?.buyQuoteLamports).toBe(0n);
  });

  it('13 — T0 and T120 use distinct decision-time snapshots', () => {
    const mk = (clock: 'T0' | 'T120', hash: string, at: number): ClockDecision => ({
      opportunityId: `o-${clock}`,
      mint: 'MINT',
      entryClock: clock,
      snapshotHash: hash,
      decisionUtcMs: at,
      migrationUtcMs: MIGRATION_MS,
      mechanicallyViable: true,
      refusal: null,
    });
    expect(() =>
      assertDistinctSnapshots([mk('T0', 'SAME', MIGRATION_MS), mk('T120', 'SAME', MIGRATION_MS + 120_000)]),
    ).toThrow(EntryClockViolation);

    expect(() =>
      assertDistinctSnapshots([mk('T0', 'A', MIGRATION_MS), mk('T120', 'B', MIGRATION_MS + 120_000)]),
    ).not.toThrow();

    // A T120 that decided before T0 is not a delayed entry either.
    expect(() =>
      assertDistinctSnapshots([mk('T0', 'A', MIGRATION_MS + 5_000), mk('T120', 'B', MIGRATION_MS + 1_000)]),
    ).toThrow(EntryClockViolation);
  });

  it('14 — T120 cannot use a future mark', () => {
    const decision = MIGRATION_MS + 120_000;
    expect(() =>
      assertNoFutureInput(decision, [
        { name: 'flowBar_60_120s', observationUtcMs: decision - 1 },
        { name: 'descriptive_180s', observationUtcMs: MIGRATION_MS + 180_000 },
      ]),
    ).toThrow(EntryClockViolation);

    expect(() =>
      assertNoFutureInput(decision, [{ name: 'flowBar_60_120s', observationUtcMs: decision - 1 }]),
    ).not.toThrow();
  });

  it('15 — dynamic size is selected from mechanics only, never from future PnL', () => {
    const mech = (lamports: bigint, impact: number): SizeMechanics => ({
      candidateLamports: lamports,
      mechanicsComplete: true,
      reserveShareBps: 10,
      priceImpactBps: impact,
      counterfactualImpactBps: 5,
      roundTripDragBps: 200,
      capacitySufficient: true,
    });
    const candidates = [mech(2_500_000n, 10), mech(5_000_000n, 20), mech(10_000_000n, 40), mech(20_000_000n, 400)];

    const a = chooseSize(candidates);
    // Deterministic in the mechanics alone: same input, same answer, every time.
    const b = chooseSize([...candidates].reverse());
    expect(a.chosenLamports).toBe(b.chosenLamports);
    expect(a.chosenLamports).toBe(10_000_000n);
    // The refused size records WHICH condition bound it.
    expect(a.evaluations.find((e) => e.candidateLamports === 20_000_000n)?.boundBy).toBe('PRICE_IMPACT');
    // Every candidate is persisted, not only the winner.
    expect(a.evaluations).toHaveLength(4);
  });

  it('16 — a shallower pool chooses a SMALLER size instead of refusing the arbitrary 0.02 SOL', () => {
    // Reserve share scales with size: a shallow pool admits only the smallest.
    const shallow: SizeMechanics[] = [
      { candidateLamports: 2_500_000n, mechanicsComplete: true, reserveShareBps: 40, priceImpactBps: 20, counterfactualImpactBps: 4, roundTripDragBps: 200, capacitySufficient: true },
      { candidateLamports: 5_000_000n, mechanicsComplete: true, reserveShareBps: 80, priceImpactBps: 45, counterfactualImpactBps: 8, roundTripDragBps: 250, capacitySufficient: true },
      { candidateLamports: 10_000_000n, mechanicsComplete: true, reserveShareBps: 160, priceImpactBps: 90, counterfactualImpactBps: 16, roundTripDragBps: 300, capacitySufficient: true },
      { candidateLamports: 20_000_000n, mechanicsComplete: true, reserveShareBps: 320, priceImpactBps: 180, counterfactualImpactBps: 32, roundTripDragBps: 400, capacitySufficient: true },
    ];
    const choice = chooseSize(shallow);
    // The old fixed notional would have been refused outright and the candidate lost.
    expect(choice.evaluations.find((e) => e.candidateLamports === 20_000_000n)?.admissible).toBe(false);
    // The pool is still perfectly tradable at a smaller size.
    expect(choice.chosenLamports).toBe(2_500_000n);
    expect(choice.refusal).toBeNull();

    // An UNMEASURED bound still refuses — fail closed.
    const unmeasured = chooseSize([
      { candidateLamports: 2_500_000n, mechanicsComplete: true, reserveShareBps: null, priceImpactBps: 10, counterfactualImpactBps: 1, roundTripDragBps: 10, capacitySufficient: true },
    ]);
    expect(unmeasured.chosenLamports).toBeNull();
  });

  it('17 — first-ever wallet setup and recurring economics cannot pool', () => {
    expect(() =>
      pooledSetupCost([
        { setupClass: 'FIRST_EVER_WALLET_SETUP', globalOneTimeLamports: 2_039_280n, perMintLamports: 2_039_280n, recoverableLamports: 0n },
        { setupClass: 'NEW_MINT_RECURRING', globalOneTimeLamports: 0n, perMintLamports: 2_039_280n, recoverableLamports: 2_039_280n },
      ]),
    ).toThrow(SetupPoolingError);

    // Recurring classes pool with each other perfectly well.
    expect(
      pooledSetupCost([
        { setupClass: 'NEW_MINT_RECURRING', globalOneTimeLamports: 0n, perMintLamports: 2_039_280n, recoverableLamports: 2_039_280n },
        { setupClass: 'REPEAT_MINT', globalOneTimeLamports: 0n, perMintLamports: 0n, recoverableLamports: 0n },
      ]),
    ).toBe(0n);
  });

  it('18 — a cashback FLAG alone cannot add PnL', () => {
    expect(() =>
      cashbackAdjustedPnl(
        1_000_000n,
        { accruedLamports: 0n, claimableLamports: 600_000n, claimedLamports: 0n, claimCostLamports: 0n, measuredFromAccumulator: false, poolFlag: true },
        0n,
      ),
    ).toThrow(CashbackNotMeasured);

    // Measured cashback moves only the ECONOMIC figure, never the cash one.
    const r = cashbackAdjustedPnl(
      1_000_000n,
      { accruedLamports: 600_000n, claimableLamports: 600_000n, claimedLamports: 0n, claimCostLamports: 0n, measuredFromAccumulator: true, poolFlag: true },
      100_000n,
    );
    expect(r.cashPnlLamports).toBe(1_000_000n);
    expect(r.economicPnlLamports).toBe(1_500_000n);
  });

  it('19 — BUY and SELL cashback account layouts are current and DIFFERENT', () => {
    const common = {
      isCashbackCoin: true,
      hasCoinCreator: true,
      accumulatorWsolAta: 'ACCUM_WSOL_ATA',
      userVolumeAccumulator: 'USER_VOLUME_PDA',
      poolV2: 'POOL_V2',
    };
    const buy = expectedRemainingTail({ leg: 'buy', ...common });
    const sell = expectedRemainingTail({ leg: 'sell', ...common });

    /**
     * The SELL leg carries the UserVolumeAccumulator PDA and the BUY leg does
     * not. The repository asserted for two commits that `sell` carried no
     * accumulator at all, which would have silently dropped the sell leg's
     * cashback on every round trip.
     */
    expect(buy.accounts).toEqual(['ACCUM_WSOL_ATA', 'POOL_V2']);
    expect(sell.accounts).toEqual(['ACCUM_WSOL_ATA', 'USER_VOLUME_PDA', 'POOL_V2']);
    expect(sell.accounts.length).toBeGreaterThan(buy.accounts.length);

    // A non-cashback coin gets no accumulator accounts on either leg.
    const plain = expectedRemainingTail({ leg: 'sell', ...common, isCashbackCoin: false });
    expect(plain.accounts).toEqual(['POOL_V2']);

    // An address the caller could not derive is REPORTED, not silently omitted.
    const undervivable = expectedRemainingTail({ leg: 'sell', ...common, userVolumeAccumulator: null });
    expect(undervivable.underivable.length).toBe(1);
    expect(undervivable.accounts).not.toContain('USER_VOLUME_PDA');
  });

  it('20 — claimable cashback is measured from accumulator STATE, not assumed', () => {
    // A real decode of a real layout: the discriminator has to match.
    const bad = new Uint8Array(64);
    expect(() => decodeUserVolumeAccumulator(bad, base58Encode)).toThrow();

    // And the PnL path refuses to use an unmeasured accumulator.
    const r = cashbackAdjustedPnl(
      500_000n,
      { accruedLamports: 0n, claimableLamports: 0n, claimedLamports: 0n, claimCostLamports: 0n, measuredFromAccumulator: false, poolFlag: false },
      0n,
    );
    expect(r.economicPnlLamports).toBe(r.cashPnlLamports);
    expect(r.note).toMatch(/no cashback accumulator/);
  });

  it('21 — the fee tier comes from the current fee config and market cap', () => {
    const bottom = labelStrata({
      feeConfigHash: 'cfg1',
      marketCapLamports: 100n * 1_000_000_000n,
      selectedTier: 't0',
      cashbackVerified: true,
      isMayhem: false,
      isToken2022: false,
    });
    expect(bottom.feeTier).toBe('BOTTOM_TIER');
    expect(bottom.cell).toBe('BOTTOM_CASHBACK');

    const higher = labelStrata({
      feeConfigHash: 'cfg1',
      marketCapLamports: 500n * 1_000_000_000n,
      selectedTier: 't3',
      cashbackVerified: false,
      isMayhem: null,
      isToken2022: true,
    });
    expect(higher.feeTier).toBe('HIGHER_TIER');
    expect(higher.cell).toBe('HIGHER_TIER_NONCASHBACK');
    expect(higher.mayhem).toBe('UNKNOWN_MAYHEM');

    // Without a fee config the tier is UNKNOWN even when the cap is known: the
    // boundary is a property of the SCHEDULE, not of the token.
    const noConfig = labelStrata({
      feeConfigHash: null,
      marketCapLamports: 500n * 1_000_000_000n,
      selectedTier: null,
      cashbackVerified: true,
      isMayhem: false,
      isToken2022: false,
    });
    expect(noConfig.feeTier).toBe('UNKNOWN_TIER');
    expect(noConfig.cell).toBe('UNKNOWN_CELL');
  });

  it('22 — a fee-config mutation changes the stratum', () => {
    const before = labelStrata({
      feeConfigHash: 'cfg-old',
      marketCapLamports: 419n * 1_000_000_000n,
      selectedTier: 't0',
      cashbackVerified: true,
      isMayhem: false,
      isToken2022: false,
    });
    // The SAME token, one lamport of market cap later, crosses the boundary.
    const after = labelStrata({
      feeConfigHash: 'cfg-old',
      marketCapLamports: 420n * 1_000_000_000n,
      selectedTier: 't1',
      cashbackVerified: true,
      isMayhem: false,
      isToken2022: false,
    });
    expect(before.cell).toBe('BOTTOM_CASHBACK');
    expect(after.cell).toBe('HIGHER_TIER_CASHBACK');
    expect(before.feeTier).not.toBe(after.feeTier);
  });

  it('23 — policy comparison is PAIRED by mint', () => {
    const a: MintOutcome[] = [
      { mint: 'm1', utcDay: '2026-08-18', logReturn: 0.5, netPnlLamports: 100n, catastrophic: false, blockedExit: false },
      { mint: 'm2', utcDay: '2026-08-18', logReturn: -0.2, netPnlLamports: -50n, catastrophic: false, blockedExit: false },
      { mint: 'onlyA', utcDay: '2026-08-18', logReturn: 9.0, netPnlLamports: 9_000n, catastrophic: false, blockedExit: false },
    ];
    const b: MintOutcome[] = [
      { mint: 'm1', utcDay: '2026-08-18', logReturn: 0.1, netPnlLamports: 20n, catastrophic: false, blockedExit: false },
      { mint: 'm2', utcDay: '2026-08-18', logReturn: -0.1, netPnlLamports: -20n, catastrophic: false, blockedExit: false },
    ];
    const p = pairedDeltas(a, b);
    // The mint only one policy traded contributes NOTHING — counting it as if
    // the other scored zero would reward the policy that traded less.
    expect(p.pairedMints).toBe(2);
    expect(p.unpairedA).toBe(1);
    expect(p.deltas).toEqual([0.4, -0.1]);
  });

  it('24 — top-three removal is computed on MINT-level outcomes', () => {
    // One mint contributing three rows must count as ONE removal, not three.
    const outcomes: MintOutcome[] = [
      { mint: 'winner', utcDay: 'd1', logReturn: 3.0, netPnlLamports: 3_000n, catastrophic: false, blockedExit: false },
      { mint: 'winner', utcDay: 'd1', logReturn: 3.0, netPnlLamports: 3_000n, catastrophic: false, blockedExit: false },
      { mint: 'winner', utcDay: 'd1', logReturn: 3.0, netPnlLamports: 3_000n, catastrophic: false, blockedExit: false },
      { mint: 'l1', utcDay: 'd1', logReturn: -0.5, netPnlLamports: -500n, catastrophic: false, blockedExit: false },
      { mint: 'l2', utcDay: 'd2', logReturn: -0.5, netPnlLamports: -500n, catastrophic: false, blockedExit: false },
      { mint: 'l3', utcDay: 'd2', logReturn: -0.5, netPnlLamports: -500n, catastrophic: false, blockedExit: false },
    ];
    const f = fragility(outcomes);
    expect(f.full).toBeGreaterThan(0);
    // Removing the single best MINT removes all three of its rows.
    expect(f.withoutTop1).toBeLessThan(0);
    expect(f.survivesAll).toBe(false);
  });

  it('25 — reject-panel winners are counted as opportunity cost', () => {
    const report = rejectPanelReport(
      'MIGRATION_MICROSTRUCTURE_RISK_V1',
      [
        { mint: 'rejWinner', policy: 'MIGRATION_MICROSTRUCTURE_RISK_V1', rejectionReason: 'entity dominance', selectionProbability: 0.5, logReturn: 2.0, catastrophic: false, blockedExit: false },
        { mint: 'rejLoser', policy: 'MIGRATION_MICROSTRUCTURE_RISK_V1', rejectionReason: 'creator selling', selectionProbability: 0.5, logReturn: -1.5, catastrophic: true, blockedExit: false },
      ],
      [{ mint: 'entered', logReturn: 0.05, catastrophic: false }],
    );
    expect(report.tailWinnersDiscarded).toBe(1);
    expect(report.rightTailRateAmongRejected).toBe(0.5);
    expect(report.rightTailRateAmongEntered).toBe(0);
    // A filter that removed the only tail winner is named HARMFUL, not praised
    // for its low catastrophic incidence.
    expect(report.verdict).toMatch(/HARMFUL/);
    expect(report.catastrophicRateAmongRejected).toBe(0.5);
  });

  it('26 — the current score with no coverage cannot enter', () => {
    const d = decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', features({ scoreCoverageOk: false }), { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('scoreCoverage');

    const v = evaluateWithCoverage('CORRECTED_CURRENT_QUALITY_SCORE', features(), {}, { seed: 's' });
    expect(v.evaluability).toBe('NOT_EVALUABLE');
  });

  it('27 — an external prior score is non-decision-bearing', () => {
    const s = externalPriorScore({
      mint: 'MINT',
      modelId: 'memetrans-lr-v1',
      trainedOnCorpus: 'MemeTrans 2024-2025',
      trainedThroughUtc: '2025-12-31T00:00:00Z',
      score: 0.93,
    });
    expect(s.decisionBearing).toBe(false);
    expect(() => refuseExternalPriorInPolicy(s)).toThrow(ExternalPriorMisuse);
  });

  it('28 — the S079 endpoint budget is SHARED across processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-'));
    const db = openDb({ path: join(dir, 'b.db'), skipBackup: true });
    try {
      const limits = {
        totalRatePerSecond: 0,
        totalBurst: 3,
        family: {
          history: { ratePerSecond: 0, burst: 3 },
          account: { ratePerSecond: 0, burst: 3 },
          token: { ratePerSecond: 0, burst: 3 },
          light: { ratePerSecond: 0, burst: 3 },
        },
      };
      // TWO independent instances, exactly as two processes would be.
      const now = 1_000_000;
      const a = new SharedEndpointBudget(db as never, limits, () => now);
      const b = new SharedEndpointBudget(db as never, limits, () => now);

      expect(a.lease('ep', 'getTransaction').granted).toBe(true);
      expect(b.lease('ep', 'getTransaction').granted).toBe(true);
      expect(a.lease('ep', 'getTransaction').granted).toBe(true);
      // The fourth lease is refused REGARDLESS of which instance asks: the
      // budget belongs to the endpoint, not to the process.
      expect(b.lease('ep', 'getTransaction').granted).toBe(false);
      expect(a.lease('ep', 'getTransaction').granted).toBe(false);

      // A different endpoint key has its own budget.
      expect(a.lease('other-ep', 'getTransaction').granted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('28b — an endpoint key carries no API key', () => {
    const id = endpointIdentity('https://mainnet.helius-rpc.com/?api-key=SUPER_SECRET_VALUE');
    expect(id.key).not.toContain('SUPER_SECRET_VALUE');
    expect(id.key).not.toContain('api-key');
    expect(id.host).toBe('mainnet.helius-rpc.com');
    // Two different keys against one host are two different budgets.
    expect(endpointIdentity('https://h.io/?api-key=A').key).not.toBe(endpointIdentity('https://h.io/?api-key=B').key);
  });

  it('29 — S091: an empty, code-only or truncated invalidation reason refuses', () => {
    const argv = (r: string): string[] => ['node', 'evidence-invalidate-old.ts', '--context=ctx-1', `--reason=${r}`];

    expect(planDemotion(argv('')).kind).toBe('REFUSE');
    expect(planDemotion(argv('   ')).kind).toBe('REFUSE');
    expect(planDemotion(argv('S090')).kind).toBe('REFUSE');
    expect(planDemotion(argv('P2a.1')).kind).toBe('REFUSE');
    expect(planDemotion(argv('the window was demoted because')).kind).toBe('REFUSE');
    expect(planDemotion(argv('breached')).kind).toBe('REFUSE');
    expect(planDemotion(argv('mark SLA breached (measured 43s late')).kind).toBe('REFUSE');

    // A real reason is accepted.
    const ok = planDemotion(argv('S090 demoted this window because its gate refused every candidate on our own bookkeeping'));
    expect(ok.kind).toBe('DEMOTE');
    expect(ok.contextId).toBe('ctx-1');

    // And a missing reason still refuses.
    expect(planDemotion(['node', 'x', '--context=ctx-1']).kind).toBe('REFUSE');
  });

  it('30 — S096: one sh -> npx -> tsx -> node wrapper tree counts as ONE collector', () => {
    const tree = collectorTrees([
      { pid: 100, parentPid: 1, createdUtc: null, commandLine: 'sh -c tsx trajectory-collect.ts' },
      { pid: 101, parentPid: 100, createdUtc: null, commandLine: 'npx tsx trajectory-collect.ts' },
      { pid: 102, parentPid: 101, createdUtc: null, commandLine: 'node tsx trajectory-collect.ts' },
      { pid: 103, parentPid: 102, createdUtc: null, commandLine: 'node trajectory-collect.ts' },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.rootPid).toBe(100);
    expect(tree[0]?.pids).toEqual([100, 101, 102, 103]);

    // TWO genuinely separate launches are still two.
    const two = collectorTrees([
      { pid: 100, parentPid: 1, createdUtc: null, commandLine: 'sh trajectory-collect.ts' },
      { pid: 101, parentPid: 100, createdUtc: null, commandLine: 'node trajectory-collect.ts' },
      { pid: 200, parentPid: 1, createdUtc: null, commandLine: 'sh trajectory-collect.ts' },
      { pid: 201, parentPid: 200, createdUtc: null, commandLine: 'node trajectory-collect.ts' },
    ]);
    expect(two).toHaveLength(2);

    // A cyclic pid table does not hang the status command.
    const cyclic = collectorTrees([
      { pid: 1, parentPid: 2, createdUtc: null, commandLine: 'a trajectory-collect.ts' },
      { pid: 2, parentPid: 1, createdUtc: null, commandLine: 'b trajectory-collect.ts' },
    ]);
    expect(cyclic.length).toBeGreaterThan(0);
  });

  it('31 — the development code still cannot sign or send', () => {
    expect(signerAllowed('observe')).toBe(false);
    expect(signerAllowed('paper')).toBe(false);
  });

  it('32 — canary and live remain the only modes a signer is permitted in, and neither is reachable here', () => {
    expect(signerAllowed('canary')).toBe(true);
    expect(signerAllowed('live')).toBe(true);
    // Nothing in this phase runs in them: the collector refuses outright.
    // Asserted through the same predicate the collector uses, so a change to
    // the predicate breaks this test rather than silently widening the mode.
    for (const mode of ['observe', 'paper'] as const) {
      expect(signerAllowed(mode)).toBe(false);
    }
  });

  it('P5 — the six null fields are actually FILLED from a closed pre-migration curve', () => {
    // The regression this whole directive exists to prevent: all six null.
    const r = computeMicrostructureFeatures(
      baseInput([
        trade({ actor: 'creator1', side: 'buy', quoteLamports: 2_000_000n, blockTimeMs: MIGRATION_MS - 300_000, curveRealSolAfterLamports: 2_000_000n }),
        trade({ signature: 's2', actor: 'b1', quoteLamports: 5_000_000n, blockTimeMs: MIGRATION_MS - 200_000, curveRealSolAfterLamports: 7_000_000n }),
        trade({ signature: 's3', actor: 'b1', quoteLamports: 5_000_000n, blockTimeMs: MIGRATION_MS - 100_000, curveRealSolAfterLamports: 12_000_000n }),
        trade({ signature: 's4', actor: 'b2', quoteLamports: 3_000_000n, blockTimeMs: MIGRATION_MS - 20_000, curveRealSolAfterLamports: 15_000_000n }),
      ]),
    );

    const s = computePreEntrySignals({
      entryClock: 'T0',
      decisionUtcMs: MIGRATION_MS + 1_000,
      flowEvents: [],
      checkpoints: [
        { atUtcMs: MIGRATION_MS - 60_000, effectiveQuoteReserveLamports: 10_000_000n, executableExitLamports: 9_000_000n, executablePriceLamports: 1_000n },
        { atUtcMs: MIGRATION_MS, effectiveQuoteReserveLamports: 12_000_000n, executableExitLamports: 11_000_000n, executablePriceLamports: 1_200n },
      ],
      microstructure: r.features,
      mayhemIsolable: true,
    });

    expect(s.independentBuyerPersistence).not.toBeNull();
    expect(s.nonMayhemNetQuoteInflowLamports).not.toBeNull();
    // Compared at basis-point resolution, because the trend is computed in
    // bigint basis points rather than floats: a bigint ratio never loses
    // precision to a float BEFORE it is compared against a threshold, and one
    // basis point is far finer than any threshold reads.
    expect(s.effectiveQuoteReserveTrend).toBeCloseTo(0.2, 4);
    expect(s.executableExitCapacityTrend).toBeCloseTo(11 / 9 - 1, 3);
    expect(s.continuationSlope).not.toBeNull();
    expect(s.creatorNetSellingLamports).not.toBeNull();
    // The creator bought and never sold, so net selling is negative.
    expect(s.creatorNetSellingLamports as bigint).toBeLessThan(0n);
    // Every source is named, so no analysis can pool curve-derived and
    // flow-derived values as if they were the same measurement.
    expect(s.sources['independentBuyerPersistence']).toBe('PRE_MIGRATION_CURVE');
    expect(s.sources['effectiveQuoteReserveTrend']).toBe('CHECKPOINTS');
  });

  /**
   * The four below were found by RUNNING the collector on 2026-08-18, not by
   * reading the code. Each one is a defect this phase introduced and shipped
   * into a live window, and each is the same species: a quantity that was
   * plausible, computed, and measuring the wrong thing.
   */
  it('F1 — a truncated signature index cannot report COMPLETE', async () => {
    /**
     * Measured: one migrated mint's ENTIRE indexed curve history was 296
     * signatures inside a 25-slot window AT the migration, 197 of the newest
     * 200 of them failed. The walk saw a short page, concluded it had reached
     * creation, and reported COMPLETE over zero pre-migration trades — so every
     * creation-anchored total was written as 0 instead of null, and the token
     * became the cleanest-looking launch in the corpus.
     *
     * A bonding curve cannot be created at or after the slot it migrates in.
     */
    const sigs = Array.from({ length: 5 }, (_, i) => ({
      signature: `s${i}`,
      blockTime: 1_700_000,
      slot: MIGRATION_SLOT + i, // every one AT OR AFTER the migration
      failed: false,
    }));
    const rpc = {
      getSignaturesForAddress: async () => sigs,
      getTransactionWithMeta: async () => null,
    };
    const r = await fetchPreMigrationHistory(rpc as never, {
      mint: 'MINT',
      bondingCurve: 'CURVE',
      migrationSignature: 'migSig',
      migrationSlot: MIGRATION_SLOT,
    });
    expect(r.coverage.reachedCreation).toBe(false);
    expect(r.coverage.coverage).toBe('INCOMPLETE');
    expect(r.coverage.coverageReason).toMatch(/does not reach before the migration slot/);
  });

  it('F2 — a history that decoded no trade is not COMPLETE, and its totals are null', () => {
    // Even if a caller insists the coverage is COMPLETE, an empty trade set
    // cannot produce totals. This is the second line of defence: the fetcher
    // classifies, and the feature layer refuses to trust the classification.
    const r = computeMicrostructureFeatures(baseInput([], 'COMPLETE'));
    expect(r.features.totalBuyLamports).toBeNull();
    expect(r.features.uniqueBuyers).toBeNull();
    expect(r.features.tradesToMigration).toBeNull();
    expect(r.features.netInflowLamports).toBeNull();
    // Not a single zero anywhere among the creation-anchored fields.
    expect(r.unknownFields).toContain('totalBuyLamports');
    expect(r.unknownFields).toContain('uniqueBuyers');
  });

  it('F3 — a signature the index already reports as failed is never fetched', async () => {
    const fetched: string[] = [];
    const sigs = [
      { signature: 'ok1', blockTime: 1_700_000, slot: 10, failed: false },
      { signature: 'bad1', blockTime: 1_700_001, slot: 11, failed: true },
      { signature: 'bad2', blockTime: 1_700_002, slot: 12, failed: true },
      { signature: 'unknown1', blockTime: 1_700_003, slot: 13, failed: null },
    ];
    const rpc = {
      getSignaturesForAddress: async (_a: string, _l?: number, before?: string) => (before === undefined ? sigs : []),
      getTransactionWithMeta: async (sig: string) => {
        fetched.push(sig);
        return {
          signature: sig,
          slot: 10,
          blockTime: 1_700_000,
          failed: false,
          accountKeys: ['payer', 'CURVE'],
          preTokenBalances: [],
          postTokenBalances: [],
          preBalances: [0n, 1_000n],
          postBalances: [0n, 2_000n],
        };
      },
    };
    const r = await fetchPreMigrationHistory(rpc as never, {
      mint: 'MINT',
      bondingCurve: 'CURVE',
      migrationSignature: 'migSig',
      migrationSlot: MIGRATION_SLOT,
    });
    // The two known-failed signatures cost no request at all.
    expect(fetched).toEqual(['ok1', 'unknown1']);
    expect(r.coverage.transactionsSkippedFailed).toBe(2);
    // `failed: null` means the provider did not say, which is not "it succeeded".
    expect(fetched).toContain('unknown1');
  });

  it('F5 — the cheap signature walk is not truncated by the expensive fetch budget', async () => {
    /**
     * Measured: a launch reported "stopped at the 1200-transaction bound"
     * having fetched 147 transactions, because 1,200 SIGNATURES had been
     * listed and the walk was bounded by the fetch budget. One
     * getSignaturesForAddress returns 200 rows and one getTransaction returns
     * one, so bounding the cheap walk with the expensive budget truncates the
     * history long before the budget is spent — and it is the walk that
     * decides whether coverage can be COMPLETE at all.
     */
    const PAGE = 200;
    // 1,400 signatures: more than a 1,200 transaction budget, all of them
    // failed so the fetch costs nothing at all.
    const total = 1_400;
    const all = Array.from({ length: total }, (_, i) => ({
      signature: `s${i}`,
      blockTime: 1_700_000 + i,
      slot: 100 + i,
      failed: true,
    }));
    let listCalls = 0;
    const rpc = {
      getSignaturesForAddress: async (_a: string, limit = PAGE, before?: string) => {
        listCalls++;
        const start = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
        return all.slice(start, start + limit);
      },
      getTransactionWithMeta: async () => null,
    };
    const r = await fetchPreMigrationHistory(rpc as never, {
      mint: 'MINT',
      bondingCurve: 'CURVE',
      migrationSignature: 'migSig',
      migrationSlot: 100_000,
    });
    // The walk reached the end of the history rather than stopping at 1,200.
    expect(r.coverage.pages).toBeGreaterThan(total / PAGE - 1);
    expect(listCalls).toBeGreaterThan(6);
    expect(r.coverage.coverageReason).not.toMatch(/1200-transaction bound/);
    // Every signature was known-failed, so not one transaction was fetched.
    expect(r.coverage.transactionsFetched).toBe(0);
    expect(r.coverage.transactionsSkippedFailed).toBe(total);
  });

  it('F6 — mintBehaviourSafe is a verdict, not a null check, and UNKNOWN stays null', () => {
    /**
     * The collector read `freezeAuthority === null ? true : null` against a
     * STRING UNION, so the answer was permanently null — on every candidate
     * this system has ever evaluated. It is a required input of both smart
     * policies, so both were NOT_EVALUABLE on 100% of rows for a reason that
     * had nothing to do with any token. TypeScript permits comparing a string
     * union to null, and the expression sat inside a loop that needs a chain to
     * run, so nothing caught it until the P2 coverage histogram named the same
     * field on every row.
     */
    const facts = (overall: 'SAFE' | 'HOSTILE' | 'UNKNOWN'): Parameters<typeof mintBehaviourSafe>[0] =>
      ({
        mintAuthority: overall,
        freezeAuthority: overall,
        permanentDelegate: overall,
        defaultAccountState: overall,
        transferHook: overall,
        nonTransferable: overall,
        pausable: overall,
        confidential: overall,
        transferFeeBps: null,
        decodeFailure: null,
        overall,
        reasons: [],
      }) as never;

    expect(mintBehaviourSafe(facts('SAFE'))).toBe(true);
    expect(mintBehaviourSafe(facts('HOSTILE'))).toBe(false);
    // UNKNOWN is null, NOT false: an unread mint is not a hostile one, and
    // attributing an apparatus failure to an issuer is its own error.
    expect(mintBehaviourSafe(facts('UNKNOWN'))).toBeNull();

    // The regression itself: the old expression is always false on this type,
    // so it could only ever produce null.
    const v = facts('SAFE');
    expect((v.freezeAuthority as unknown) === null).toBe(false);
  });

  it('F7 — getMultipleAccounts is chunked to the MEASURED bound, not the spec bound', () => {
    /**
     * The spec allows 100 keys per call. This endpoint allows 5. Probed
     * directly, interleaved to rule out an accumulating bucket:
     *
     *     n=5 OK 28ms | n=20 429 | n=5 again OK 27ms
     *     n=6 429 | n=7 429 | n=8 429
     *     20 addresses as 4x5 -> 20/20 resolved in 468ms
     *
     * `getTokenAccountOwners` passes the top TWENTY holders in one call, so it
     * failed 100% of the time, which made measureEntityTier refuse, which made
     * entityConcentration null, which made BOTH smart policies NOT_EVALUABLE on
     * 84% of the corpus. The 429 reads `max usage reached`, so it was diagnosed
     * as an exhausted account and nearly answered with a subscription purchase.
     *
     * After chunking, the same four mints measured 4/4 with trustworthy=true.
     */
    expect(MAX_ACCOUNTS_PER_CALL).toBeLessThanOrEqual(5);

    const keys = Array.from({ length: 20 }, (_, i) => `key${i}`);
    const chunks = chunkForAccountBatch(keys);

    // No chunk may exceed the measured bound — that is the whole point.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_ACCOUNTS_PER_CALL);
    // Nothing lost, nothing duplicated, order preserved.
    expect(chunks.flat()).toEqual(keys);
    expect(new Set(chunks.flat()).size).toBe(keys.length);
    expect(chunks).toHaveLength(Math.ceil(keys.length / MAX_ACCOUNTS_PER_CALL));

    // Edge cases: empty issues no call, and a short list is one chunk.
    expect(chunkForAccountBatch([])).toEqual([]);
    expect(chunkForAccountBatch(['a'])).toEqual([['a']]);
    expect(chunkForAccountBatch(keys.slice(0, MAX_ACCOUNTS_PER_CALL))).toHaveLength(1);
  });

  it('F8 — our own budget refusal must not fail over and drain the other endpoint', () => {
    /**
     * `call()` tries the primary then the fallback, which is right for a
     * transport failure. A budget refusal is not one: it means this endpoint has
     * capacity we are choosing not to use yet. Failing over on it spends the
     * FALLBACK's credits to avoid waiting on a healthy primary.
     */
    const budget = new RpcError('budget_exhausted', 'endpoint budget exhausted for getTransaction');
    const transport = new RpcError('rpc_error', 'connection reset');
    expect(isBudgetExhausted(budget)).toBe(true);
    // A real transport failure still fails over.
    expect(isBudgetExhausted(transport)).toBe(false);
    expect(isBudgetExhausted(new Error('429'))).toBe(false);
    expect(isBudgetExhausted(null)).toBe(false);
  });

  it('F4 — fees alone cannot refuse a size: a deep pool admits the ceiling', () => {
    /**
     * The defect: the all-in round-trip COST (~190-250 bps of fees at the
     * current schedule) was assigned to `priceImpactBps` and tested against the
     * 50 bps IMPACT cap. Fees are charged on every pool at every size, so all
     * four sizes were refused on every candidate — including a live pool
     * holding 1,048 SOL, where 0.0025 SOL moves essentially nothing. The
     * collector opened zero trajectories and called it a depth refusal.
     */
    const deepPool: SizeMechanics[] = CANDIDATE_SIZES.map((size) => ({
      candidateLamports: size,
      mechanicsComplete: true,
      // A 1,048 SOL pool: impact is negligible at every candidate size.
      reserveShareBps: 1,
      priceImpactBps: 1,
      counterfactualImpactBps: 1,
      // The fee, which is present at every size and is NOT impact.
      roundTripDragBps: 220,
      capacitySufficient: true,
    }));
    const choice = chooseSize(deepPool);
    expect(choice.chosenLamports).toBe(20_000_000n);
    expect(choice.refusal).toBeNull();

    // And a genuinely shallow pool is still refused on IMPACT, not on fees.
    const shallow = deepPool.map((m) => ({ ...m, counterfactualImpactBps: 400 }));
    expect(chooseSize(shallow).chosenLamports).toBeNull();
  });

  it('P9 — the new risk policy removes catastrophic structure and keeps a wide tail', () => {
    const good = features({
      mintBehaviourSafe: true,
      entityConcentration: 0.3,
      creatorNetSellingLamports: -1_000n,
      largestFirstBuyerEntityShare: 0.4,
      buyerRetention: 0.5,
      lateSellPressure: 0.3,
      migrationPathEntityDominance: 0.4,
    });
    expect(decideEntry('MIGRATION_MICROSTRUCTURE_RISK_V1', good, { seed: 's' }).enter).toBe(true);

    // A creator selling into their own migration is refused.
    const selling = { ...good, creatorNetSellingLamports: 5_000_000n };
    expect(decideEntry('MIGRATION_MICROSTRUCTURE_RISK_V1', selling, { seed: 's' }).enter).toBe(false);

    // One entity behind the whole path is refused.
    const bundled = { ...good, migrationPathEntityDominance: 0.95 };
    expect(decideEntry('MIGRATION_MICROSTRUCTURE_RISK_V1', bundled, { seed: 's' }).enter).toBe(false);

    // THE TAIL IS PRESERVED: a volatile launch that is structurally sound —
    // heavy late selling short of the reversal bound, concentrated but not
    // dominated — still enters. This is the assertion that fails first if
    // anybody tightens these thresholds to improve the win rate.
    const volatile = { ...good, lateSellPressure: 0.75, entityConcentration: 0.55, largestFirstBuyerEntityShare: 0.65 };
    expect(decideEntry('MIGRATION_MICROSTRUCTURE_RISK_V1', volatile, { seed: 's' }).enter).toBe(true);

    // An unknown is never a pass.
    const unknown = { ...good, buyerRetention: null };
    const d = decideEntry('MIGRATION_MICROSTRUCTURE_RISK_V1', unknown, { seed: 's' });
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('buyerRetention');
  });
});
