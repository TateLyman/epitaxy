import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { evaluateExitPolicies, pathIsComplete, MARK_OFFSETS_MS, type CollectedMark } from '../../packages/pipeline/src/mark-path.js';
import { buildTrajectorySettlement, blocksPnl, notApplicable, measured, unknownCost } from '../../packages/domain/src/trajectory-settlement.js';
import type { MeasuredLegSettlement } from '../../packages/domain/src/settlement.js';

/**
 * Directive `29c7cc7` — the wiring, not the pure functions.
 *
 * These fail against `29c7cc7`, where the collector printed
 * `NOT OPENING TRAJECTORIES`, settlement double-counted rent, and no shared
 * mark path existed.
 */

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function costs(over: Record<string, unknown> = {}) {
  return {
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 0n,
    tipLamports: 0n,
    protocolFeeLamports: null,
    creatorFeeLamports: null,
    lpFeeLamports: null,
    platformFeeLamports: 0n,
    transferFeeAtoms: 0n,
    transferFeeLamportsEquivalent: 0n,
    rentCreatedLamports: 0n,
    rentRecoveredLamports: 0n,
    failedAttemptCostLamports: 0n,
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: 0n,
    ...over,
  };
}

function leg(side: 'buy' | 'sell', over: Record<string, unknown> = {}): MeasuredLegSettlement {
  const base = {
    observationId: 'obs-' + side,
    simulationJobId: 'job-' + side,
    side,
    family: 'BUILD_CUSTOM',
    capabilityFingerprint: 'fp',
    input:
      side === 'buy'
        ? { kind: 'native_sol', requestedLamports: 20_000_000n, actualTradeDebitLamports: 20_000_000n, totalPayerDebitLamports: 20_005_000n }
        : { kind: 'token', mint: 'M', tokenProgram: TOKEN_PROGRAM_ID, tokenAccount: 'A', requestedAtoms: 1n, actualDebitAtoms: 1n },
    output:
      side === 'buy'
        ? { kind: 'token', mint: 'M', tokenProgram: TOKEN_PROGRAM_ID, tokenAccount: 'A', minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1n }
        : { kind: 'native_sol', minimumLamports: 0n, expectedLamports: 21_000_000n, actualCreditLamports: 21_000_000n },
    costs: costs(),
    createdAccounts: [],
    closedAccounts: [],
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: side === 'buy' ? -20_005_000n : 20_995_000n,
    fullAccountCoverage: true,
    effectValid: true,
    effectRefusals: [] as string[],
    snapshotManifestHash: 'snap',
    replayable: true,
    complete: true,
    incompleteness: [] as string[],
    ...over,
  };
  return base as unknown as MeasuredLegSettlement;
}

describe('29c7cc7 — the collector opens trajectories', () => {
  it('the refusal string is GONE from the collector', () => {
    // At 29c7cc7 this printed for two commits after the worker was built, so
    // the database carried zero trajectories while a proof artifact was read
    // as the running system's output.
    const src = readFileSync('apps/collector/src/trajectory-collect.ts', 'utf8');
    expect(src).not.toMatch(/NOT OPENING TRAJECTORIES: the one-pass sequential worker/);
  });

  it('the collector reaches the persistent worker and the open path', () => {
    const src = readFileSync('apps/collector/src/trajectory-collect.ts', 'utf8');
    expect(src).toMatch(/SequentialWorker/);
    expect(src).toMatch(/openTrajectory/);
    expect(src).toMatch(/insertTrajectory/);
  });

  it('a proof artifact cannot increase the database trajectory count', () => {
    // The artifact may exist and may be entirely correct about what it
    // measured. It is still not a row.
    const status = existsSync('artifacts/trajectory-status.json')
      ? (JSON.parse(readFileSync('artifacts/trajectory-status.json', 'utf8')) as Record<string, unknown>)
      : null;
    if (status === null) return;

    // P12 — the settled count is the DATABASE's answer, and the proof
    // artifacts are counted separately and explicitly as zero. Reporting them
    // in one number is the substitution; reporting them in two fields, one of
    // which is always zero, is the correction.
    const db = status['trajectories'] as Record<string, unknown> | undefined;
    expect(db?.['settled']).not.toBe(undefined);
    expect(status['proofArtifactsCounted']).toBe(0);
    expect(status['proofArtifactsCounted']).not.toBe(db?.['settled']);
  });
});

describe('29c7cc7 — settlement counts each cost exactly once', () => {
  it('rent appears ONCE, not twice', () => {
    // executionCost(leg) already contains NET rent. buildTrajectorySettlement
    // then added rentStillLockedLamports again.
    const entry = leg('buy', { costs: costs({ rentCreatedLamports: 2_039_280n }) });
    const exit = leg('sell', { costs: costs({ rentRecoveredLamports: 0n }) });
    const s = buildTrajectorySettlement({ trajectoryId: 't', entry, exit });
    // base 5,000 x2 + rent 2,039,280, counted once.
    expect(s.executionCostLamports).toBe(2_049_280n);
  });

  it('the transfer fee is INCLUDED in execution cost', () => {
    // It was reported and then omitted from the total.
    const entry = leg('buy', {
      output: { kind: 'token', mint: 'M', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', tokenAccount: 'A', minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1n },
      costs: costs({ transferFeeLamportsEquivalent: 7_777n, transferFeeAtoms: 1n }),
    });
    const s = buildTrajectorySettlement({ trajectoryId: 't', entry, exit: leg('sell') });
    expect(s.transferFeesLamports).toBe(7_777n);
    expect(s.executionCostLamports).toBe(5_000n + 5_000n + 7_777n);
  });

  it('the failed-attempt cost appears once', () => {
    const entry = leg('buy', { costs: costs({ failedAttemptCostLamports: 11_000n }) });
    const s = buildTrajectorySettlement({ trajectoryId: 't', entry, exit: leg('sell') });
    expect(s.executionCostLamports).toBe(5_000n + 11_000n + 5_000n);
  });

  it('unexplained movement is DERIVED, not hardcoded to zero', () => {
    // A payer whose native delta does not match the named flows has an
    // unexplained remainder, and writing zero asserted none exists. The exit
    // here moves the payer by an amount the named flows cannot account for.
    const s = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg('buy'),
      exit: leg('sell', { payerNativeDeltaLamports: 1_234_567n }),
    });
    expect(s.unexplainedLamports).not.toBe(0n);
  });

  it('a fully reconciling payer delta leaves NO unexplained remainder', () => {
    // The other half of the same claim: the field is a measurement, so it must
    // come out ZERO when every flow is named — otherwise it is just noise.
    //
    // Payer: -20,000,000 trade out -5,000 fee on the buy;
    //        +21,000,000 trade in  -5,000 fee on the sell.
    const entry = leg('buy', { payerNativeDeltaLamports: -20_005_000n });
    const exit = leg('sell', { payerNativeDeltaLamports: 20_995_000n });
    const s = buildTrajectorySettlement({ trajectoryId: 't', entry, exit });
    expect(s.unexplainedLamports).toBe(0n);
  });

  it('an incomplete or effect-invalid leg blocks PnL', () => {
    for (const patch of [{ complete: false, incompleteness: ['x'] }, { effectValid: false, effectRefusals: ['y'] }, { fullAccountCoverage: false }]) {
      const s = buildTrajectorySettlement({ trajectoryId: 't', entry: leg('buy'), exit: leg('sell', patch) });
      expect(s.netPnlLamports).toBeNull();
    }
  });

  it('NOT_APPLICABLE is not UNKNOWN', () => {
    expect(blocksPnl(notApplicable)).toBe(false);
    expect(blocksPnl(measured(5n))).toBe(false);
    expect(blocksPnl(unknownCost)).toBe(true);
  });
});

describe('29c7cc7 — one shared mark path, every policy on it', () => {
  const opened = 1_000_000;
  const path: CollectedMark[] = MARK_OFFSETS_MS.map((o, i) => ({
    atMs: opened + o,
    offsetMs: o,
    latenessMs: 0,
    // Capacity collapses after the 15m mark.
    executableLamports: BigInt(20_000_000 - i * 1_000_000),
    exitCapacityLamports: i >= 3 ? 1_000_000n : 20_000_000n,
    effectiveQuoteReserveLamports: 100_000_000_000n,
    refusal: null,
  }));

  it('every policy sees the SAME path', () => {
    const out = evaluateExitPolicies(path, {
      openedAtMs: opened,
      policies: ['FIXED_15M_CONTROL', 'FLOW_LIQUIDITY_DETERIORATION_V1'],
      entryCashOutLamports: 20_000_000n,
    });
    expect(out).toHaveLength(2);
    // Paired by construction: same token, same marks, same costs.
    expect(out.every((o) => o.triggeredAtMs === null || path.some((m) => m.atMs === o.triggeredAtMs))).toBe(true);
  });

  it('the two exit policies DIFFER on a shared path', () => {
    const out = evaluateExitPolicies(path, {
      openedAtMs: opened,
      policies: ['FIXED_15M_CONTROL', 'FLOW_LIQUIDITY_DETERIORATION_V1'],
      entryCashOutLamports: 20_000_000n,
    });
    const control = out.find((o) => o.exitPolicy === 'FIXED_15M_CONTROL');
    const challenger = out.find((o) => o.exitPolicy === 'FLOW_LIQUIDITY_DETERIORATION_V1');
    // The challenger leaves when capacity collapses; the control holds to 15m.
    expect(challenger?.triggeredAtMs).not.toBe(control?.triggeredAtMs);
  });

  it('a BACKFILLED path is flagged, because its horizons are labels', () => {
    // Every horizon coming due at once means five labels and one instant, and
    // every policy then triggers on the same mark. Measured on the first live
    // run: two exit policies returned identical outcomes on 8 of 8 paths.
    const late = path.map((m) => ({ ...m, latenessMs: 3_600_000 }));
    const r = pathIsComplete(late);
    expect(r.backfilled).toBe(true);
    expect(r.reason).toMatch(/BACKFILLED/);
  });

  it('a timely path is not flagged', () => {
    expect(pathIsComplete(path).backfilled).toBe(false);
  });

  it('a truncated path is not treated as finished', () => {
    // A path missing its 60-minute mark cannot evaluate a policy that might
    // have held that long.
    const short = path.slice(0, 3);
    expect(pathIsComplete(short).complete).toBe(false);
    expect(pathIsComplete(short).reason).toMatch(/missing marks/);
  });

  it('an entirely unpriced path is incomplete, not a result', () => {
    const unpriced = path.map((m) => ({ ...m, executableLamports: null, exitCapacityLamports: null }));
    expect(pathIsComplete(unpriced).complete).toBe(false);
  });

  it('a complete path says so', () => {
    expect(pathIsComplete(path).complete).toBe(true);
  });
});
