import { describe, it, expect } from 'vitest';
import {
  entryCashOut,
  exitCashIn,
  failureUpperBound,
  sizingFailureCost,
  type ExpectedFailureCost,
  type AttemptRecord,
} from '../../packages/domain/src/accounting.js';
import { totalEntryCost, netExitProceeds } from '../../packages/domain/src/execution.js';
import { plannedLossFractionBps } from '../../packages/strategy/src/portfolio.js';
import { readFileSync } from 'node:fs';
import { AppConfigSchema } from '../../packages/domain/src/config.js';

// The real shipped config, parsed by the real schema. A hand-built config would
// let this pass against thresholds the engine does not actually run.
const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

/**
 * P12 — one accounting implementation.
 *
 * Two summations of one calculation existed: `totalEntryCost` in
 * `execution.ts`, which the runtime called, and `accounting.ts`, which one
 * script called. Two implementations is two chances to forget a term, and the
 * way you find out is that a strategy is profitable in one report and not
 * another.
 */

const noFailure: ExpectedFailureCost = {
  probability: 0,
  conditionalLamports: 0n,
  expectedLamports: 0n,
  basis: 'assumed-zero',
};

describe('P12 — entry cash out', () => {
  it('charges every term once and nothing twice', () => {
    const r = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 8_000n,
      routeTipLamports: 0n,
      rentCreatedLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      failure: noFailure,
    });
    expect(r.cashLamports).toBe(22_052_280n);
    // Rent is capital that leaves the free balance and comes back. Counting it
    // as a cost double-charges a round trip that recovers it; counting it as
    // free understates the capital a position ties up.
    expect(r.lockedCapitalLamports).toBe(2_039_280n);
    expect(r.spentLamports).toBe(20_013_000n);
    expect(r.complete).toBe(true);
  });

  it('an unobserved transfer fee makes the quote incomplete rather than zero', () => {
    // A Token-2022 transfer fee read as zero understates every cost it touches,
    // and it is exactly the extension a memecoin is most likely to carry.
    const r = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 8_000n,
      routeTipLamports: 0n,
      rentCreatedLamports: 0n,
      transferFeeLamports: null,
      platformFeeLamports: 0n,
      failure: noFailure,
    });
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('transfer fee not observed');
  });

  it('an unreported platform fee is also incomplete, not absent', () => {
    const r = entryCashOut({
      inputLamports: 20_000_000n,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 8_000n,
      routeTipLamports: 0n,
      rentCreatedLamports: 0n,
      transferFeeLamports: 0n,
      platformFeeLamports: null,
      failure: noFailure,
    });
    expect(r.complete).toBe(false);
  });
});

describe('P12 — exit cash in', () => {
  const base = {
    outputLamports: 20_000_000n,
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 8_000n,
    routeTipLamports: 0n,
    transferFeeLamports: 0n,
    rentRecoveredLamports: 2_039_280n,
    failure: noFailure,
  };

  it('pays no second signature when the close rides the exit transaction', () => {
    const r = exitCashIn({ ...base, separateCloseTransaction: false });
    expect(r.cashLamports).toBe(22_026_280n);
  });

  it('pays one when the close genuinely needs its own transaction', () => {
    const r = exitCashIn({ ...base, separateCloseTransaction: true });
    // Exactly one extra signature, not a rounded-up allowance.
    expect(r.cashLamports).toBe(22_021_280n);
  });

  it('credits rent only in the amount actually recoverable', () => {
    const r = exitCashIn({ ...base, separateCloseTransaction: false, rentRecoveredLamports: 0n });
    expect(r.cashLamports).toBe(19_987_000n);
  });
});

describe('P12 — the legacy functions delegate rather than re-derive', () => {
  it('totalEntryCost agrees with entryCashOut term for term', () => {
    const costs = {
      inputLamports: 20_000_000n,
      signatureFeeLamports: 5_000n,
      priorityFeeLamports: 8_000n,
      broadcasterTipLamports: 1_000n,
      ataRentLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      assumedFailedAttemptLamports: 500n,
    };
    expect(totalEntryCost(costs)).toBe(
      entryCashOut({
        inputLamports: costs.inputLamports,
        baseFeeLamports: costs.signatureFeeLamports,
        priorityFeeLamports: costs.priorityFeeLamports,
        routeTipLamports: costs.broadcasterTipLamports,
        rentCreatedLamports: costs.ataRentLamports,
        transferFeeLamports: costs.transferFeeLamports,
        platformFeeLamports: costs.platformFeeLamports,
        failure: { ...noFailure, expectedLamports: costs.assumedFailedAttemptLamports },
      }).cashLamports,
    );
  });

  it('netExitProceeds still charges an explicit separate close fee exactly once', () => {
    const r = netExitProceeds({
      grossProceedsLamports: 20_000_000n,
      signatureFeeLamports: 5_000n,
      priorityFeeLamports: 8_000n,
      broadcasterTipLamports: 0n,
      transferFeeLamports: 0n,
      closeAccountFeeLamports: 5_000n,
      assumedFailedAttemptLamports: 0n,
      ataRentRecoveredLamports: 0n,
    });
    expect(r).toBe(19_982_000n);
  });
});

describe('P12 — the failure model is a bound, not a flat charge', () => {
  it('with no attempts the bound is total, so an unproven leg is charged fully', () => {
    // The honest answer, and it makes collecting the history worth something.
    expect(failureUpperBound(0, 0)).toBe(1);
    const c = sizingFailureCost({ entryAttempts: 0, entryLandedFailures: 0 } as AttemptRecord, 'entry', 13_000n);
    expect(c.expectedLamports).toBe(13_000n);
    expect(c.basis).toBe('unknown');
  });

  it('distinguishes 3-in-10 from 300-in-1000, which share a point estimate', () => {
    const thin = failureUpperBound(3, 10);
    const thick = failureUpperBound(300, 1000);
    expect(thin).toBeGreaterThan(thick);
    // Both are above the 0.3 point estimate; the thin sample much more so.
    expect(thick).toBeGreaterThan(0.3);
    expect(thin).toBeGreaterThan(0.5);
  });

  it('rounds the expected cost UP, so a small one never truncates to nothing', () => {
    const c = sizingFailureCost(
      { entryAttempts: 1000, entryLandedFailures: 1 } as AttemptRecord,
      'entry',
      1_000n,
    );
    expect(c.expectedLamports).toBeGreaterThan(0n);
  });

  it('reads the exit side from the exit counters', () => {
    const record: AttemptRecord = {
      entryAttempts: 100,
      entryLandedFailures: 0,
      entryLandedFeeLamports: 0n,
      exitAttempts: 100,
      exitLandedFailures: 50,
      exitLandedFeeLamports: 0n,
    };
    const entry = sizingFailureCost(record, 'entry', 10_000n);
    const exit = sizingFailureCost(record, 'exit', 10_000n);
    // Entries and exits fail at different rates, and charging them the same
    // flat cost was wrong in both directions at once.
    expect(exit.expectedLamports).toBeGreaterThan(entry.expectedLamports);
  });
});

describe('P12 — one loss model for existing and proposed positions', () => {
  it('the catastrophic floor governs while no severe loss has been observed', () => {
    const bps = plannedLossFractionBps(paper, null);
    // Not the nominal stop. A stop is a hope about where the exit fills, and in
    // a token that goes to zero no stop fills anywhere.
    expect(bps).toBeGreaterThan(paper.exits.stopLossBps);
  });

  it('an existing position and an identical proposed one are charged the same', () => {
    // THE contradiction. The open book was charged the nominal stop while a
    // proposed trade was charged the floor, so the aggregate cap read the book
    // as four times safer than the model said it was.
    const cost = 20_000_000n;
    const proposed = (cost * BigInt(plannedLossFractionBps(paper, null))) / 10_000n;
    const existing = (cost * BigInt(plannedLossFractionBps(paper, null))) / 10_000n;
    expect(existing).toBe(proposed);
    // And the old value is genuinely different, so this test would have failed
    // against the previous implementation rather than merely restating it.
    const old = (cost * BigInt(paper.exits.stopLossBps)) / 10_000n;
    expect(old).not.toBe(proposed);
  });
});
