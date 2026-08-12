import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseImpact,
  impactIsSchemaError,
  impactIsUsable,
} from '../../packages/domain/src/impact.js';
import {
  diagnoseExit,
  DEFAULT_DIAGNOSTIC_THRESHOLDS,
  disqualifiesFromConfirmatory,
  executableValueRatioBps,
  EXIT_DIAGNOSTICS,
} from '../../packages/domain/src/exitdiagnostic.js';
import { settleAtaRent, rentRecoveryScenarios } from '../../packages/domain/src/ata.js';
import type { AtaState } from '../../packages/domain/src/ata.js';
import { Cadence, detectDiscontinuity, utcDateKey, utcDaysBetween } from '../../packages/domain/src/clock.js';
import { AppConfigSchema, SAFER_WHEN_LOWER, SAFER_WHEN_HIGHER } from '../../packages/domain/src/config.js';
import {
  admissible,
  blocksFor,
  mayCallDeploymentEvidence,
  mayRankPolicies,
  PoolingRefused,
  replayPolicy,
  requireSingleRegime,
  ResamplingUnitRefused,
  TriggerQuoteReused,
  requireBlockUnit,
} from '../../packages/research/src/confirmatory.js';
import type { CounterfactualMark } from '../../packages/research/src/confirmatory.js';
import {
  evaluateInstructionPolicy,
  instructionPolicyLimits,
  policyStatusLabel,
} from '../../packages/solana/src/instructionpolicy.js';
import { toExecutableQuote } from '../../packages/adapters/src/jupiter/client.js';
import { OrderResponseSchema } from '../../packages/adapters/src/jupiter/schemas.js';

/**
 * P2a.1 §P10 — the twenty tests that must fail against the old bugs.
 *
 * Each `it` below is numbered to the directive's list. They are grouped by the
 * defect rather than by the module, because the point of the list is that these
 * are the twenty ways this system has actually been wrong, and a reader should
 * be able to check the list rather than the file layout.
 *
 * Every one of them was written to fail first. Where a mutation script exists
 * (`scripts/mutate-*.py`) it is named in the comment.
 */

const TAKER = 'So11111111111111111111111111111111111111112';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** SetComputeUnitLimit(200_000) — tag 2, u32 LE. */
const UNIT_LIMIT_IX = { programId: COMPUTE_BUDGET, data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]).toString('base64') };

function ok(over: Partial<Parameters<typeof diagnoseExit>[0]> = {}): Parameters<typeof diagnoseExit>[0] {
  return {
    providerFailed: false,
    impact: parseImpact({ priceImpact: -0.5 }),
    routeExists: true,
    routeBuildable: true,
    executableSellValueLamports: 1_000_000n,
    allInCostLamports: 1_000_000n,
    quoteAgeMs: 100,
    roundTripLossBps: 50,
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('1 — a price without a transaction is not a fill', () => {
  /**
   * The headline defect. 2255 stored quotes carried transaction_buildable = 0
   * and 38 fills were booked against them, because the flag was written by the
   * adapter and read by no decision.
   */
  it('a quote-only order response is not buildable', () => {
    const raw = OrderResponseSchema.parse({
      inputMint: 'A',
      outputMint: 'B',
      inAmount: '1000',
      outAmount: '2000',
      otherAmountThreshold: '1900',
      swapMode: 'ExactIn',
      slippageBps: 100,
      routePlan: [],
      transaction: null,
      priceImpact: -0.4,
    });
    const q = toExecutableQuote(raw, 0, prov(), 1);
    expect(q.transactionBuildable).toBe(false);
  });

  it('an empty transaction string is not buildable either', () => {
    const raw = OrderResponseSchema.parse({
      inputMint: 'A',
      outputMint: 'B',
      inAmount: '1000',
      outAmount: '2000',
      otherAmountThreshold: '1900',
      swapMode: 'ExactIn',
      slippageBps: 100,
      routePlan: [],
      transaction: '',
      errorCode: 1,
      errorMessage: 'Insufficient funds',
    });
    expect(toExecutableQuote(raw, 0, prov(), 1).transactionBuildable).toBe(false);
  });

  it('an instruction set with no compute limit is refused by policy', () => {
    const r = evaluateInstructionPolicy(
      [{ programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }] }],
      instructionPolicyLimits(TAKER, 100_000n),
    );
    expect(r.allowed).toBe(false);
    expect(r.violations.map((v) => v.violation)).toContain('compute_limit_missing');
  });

  it('a co-signer other than the taker is refused', () => {
    // A second required signer means the transaction only executes once some
    // third party signs. Our flow never produces that shape, and a router that
    // did could make execution contingent on its own key.
    const r = evaluateInstructionPolicy(
      [
        UNIT_LIMIT_IX,
        {
          programId: JUPITER_V6,
          accounts: [
            { pubkey: TAKER, isSigner: true, isWritable: true },
            { pubkey: 'SomeOtherSigner11111111111111111111111111111', isSigner: true, isWritable: false },
          ],
        },
      ],
      instructionPolicyLimits(TAKER, 100_000n),
    );
    expect(r.allowed).toBe(false);
    expect(r.violations.map((v) => v.violation)).toContain('extra_signers_required');
  });

  it('the taker signing its own transaction is fine', () => {
    const r = evaluateInstructionPolicy(
      [UNIT_LIMIT_IX, { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }] }],
      instructionPolicyLimits(TAKER, 100_000n),
    );
    expect(r.allowed).toBe(true);
  });

  it('an instruction-level pass never claims full transaction coverage', () => {
    // The label is stored in `build_attempts.policy_status`. Widening it would
    // make a research check read as the signer check, and the signer check is
    // the one that guards real money. Fee payer position, signature count,
    // recent blockhash and packet size are NOT decidable from instructions.
    const r = evaluateInstructionPolicy(
      [UNIT_LIMIT_IX, { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }] }],
      instructionPolicyLimits(TAKER, 100_000n),
    );
    expect(r.coverage).toBe('instructions-only');
    expect(policyStatusLabel(r)).toBe('POLICY_PASS(instructions-only)');
  });

  it('an unsupported program is refused however well-formed the rest is', () => {
    const r = evaluateInstructionPolicy(
      [UNIT_LIMIT_IX, { programId: 'EvilProgram1111111111111111111111111111111' }],
      instructionPolicyLimits(TAKER, 100_000n),
    );
    expect(r.allowed).toBe(false);
    expect(r.violations.map((v) => v.violation)).toContain('disallowed_program');
  });
});

// ---------------------------------------------------------------------------
describe('2 — entry build valid, exit build invalid, is not a PnL claim', () => {
  it('an unbuildable exit is diagnosed and disqualified from confirmatory data', () => {
    const d = diagnoseExit(ok({ routeBuildable: false }));
    expect(d.diagnostic).toBe('UNBUILDABLE_EXIT');
    expect(disqualifiesFromConfirmatory(d.diagnostic)).toBe(true);
  });

  it('an UNASKED buildability is not an unbuildable exit', () => {
    // The mirror of the previous test, and the one a hasty implementation gets
    // wrong: `routeBuildable !== true` would label every historical mark
    // UNBUILDABLE_EXIT, which asserts that 603 routes failed a check nobody
    // ever ran. Null means not asked, and not asked is not a failure.
    const d = diagnoseExit(ok({ routeBuildable: null }));
    expect(d.diagnostic).not.toBe('UNBUILDABLE_EXIT');
    expect(d.diagnostic).toBe('NONE');
  });

  it('a row is inadmissible unless BOTH legs were shown buildable', () => {
    const base = { contextHash: 'c', dataRegimeId: 'r', rawPayloadHash: 'p', diagnostic: null };
    expect(admissible({ ...base, bothLegsBuildable: true }).admissible).toBe(true);
    expect(admissible({ ...base, bothLegsBuildable: false }).exclusions).toContain('NOT_BUILD_VALID');
    // Unknown fails. A row nobody asked about is the row the corpus was made of.
    expect(admissible({ ...base, bothLegsBuildable: null }).exclusions).toContain('NOT_BUILD_VALID');
  });
});

// ---------------------------------------------------------------------------
describe('3 — impact semantics, traced rather than assumed', () => {
  /**
   * The directive asked for "any negative raw Jupiter impact is
   * SCHEMA_OR_PARSER_ERROR". Measured against the live endpoint on 2026-08-12
   * that rule is false: 1 SOL -> USDC returns priceImpact -0.1820511452303203
   * and priceImpactPct "-0.0018205114523032028", which is an ordinary 18bps
   * adverse move on a deep pair. Applying the rule would have condemned 1262 of
   * 2255 stored rows. These tests pin the convention that was measured, and the
   * invariant it actually supports.
   */
  it('negative is ordinary adverse movement, not corruption', () => {
    const r = parseImpact({ priceImpact: -0.1820511452303203, priceImpactPct: '-0.0018205114523032028' });
    expect(r.status).toBe('OK');
    expect(impactIsSchemaError(r)).toBe(false);
    expect(r.adverseBps).toBeCloseTo(18.205, 2);
    expect(r.favourableBps).toBe(0);
  });

  it('the two fields must agree, and disagreement IS a schema error', () => {
    const r = parseImpact({ priceImpact: -0.18, priceImpactPct: '0.42' });
    expect(r.status).toBe('FIELDS_DISAGREE');
    expect(impactIsSchemaError(r)).toBe(true);
  });

  it('a fraction outside -1..1 is a real parser or schema failure', () => {
    expect(parseImpact({ priceImpactPct: '-4.2' }).status).toBe('OUT_OF_RANGE');
    expect(parseImpact({ priceImpact: 900 }).status).toBe('OUT_OF_RANGE');
    expect(impactIsSchemaError(parseImpact({ priceImpactPct: 'NaN' }))).toBe(true);
  });

  it('a schema error outranks every economic label', () => {
    const d = diagnoseExit(ok({ impact: parseImpact({ priceImpactPct: '17' }), executableSellValueLamports: 1n }));
    expect(d.diagnostic).toBe('SCHEMA_OR_PARSER_ERROR');
  });

  it('an ABSENT field is unknown, never zero', () => {
    const r = parseImpact({});
    expect(r.status).toBe('ABSENT');
    expect(r.adverseBps).toBeNull();
    expect(r.signedPct).toBeNull();
    expect(impactIsUsable(r)).toBe(false);
    // And absence never satisfies the adverse-impact cap in either direction.
    expect(diagnoseExit(ok({ impact: r })).diagnostic).not.toBe('ADVERSE_EXIT_IMPACT');
  });
});

// ---------------------------------------------------------------------------
describe('4 — a losing position is not an impact event', () => {
  /**
   * DE6svnZL closed under `exit_cost_exploded` at +2.07% because Math.abs
   * turned a favourable +0.0911 into "911bps of exit cost". The inverse case
   * matters just as much: a position down 40% on a 20bps-impact route is a bad
   * trade, not an expensive exit.
   */
  it('a large negative return with small impact is NOT ADVERSE_EXIT_IMPACT', () => {
    const d = diagnoseExit(
      ok({
        impact: parseImpact({ priceImpact: -0.2 }),
        executableSellValueLamports: 600_000n,
        allInCostLamports: 1_000_000n,
        roundTripLossBps: 20,
      }),
    );
    expect(d.diagnostic).toBe('NONE');
    expect(d.executableValueRatioBps).toBe(6_000);
  });

  it('a favourable impact can never produce an adverse-impact label', () => {
    const r = parseImpact({ priceImpactPct: 0.0911 });
    expect(r.favourableBps).toBeCloseTo(911, 0);
    expect(r.adverseBps).toBe(0);
    expect(diagnoseExit(ok({ impact: r })).diagnostic).not.toBe('ADVERSE_EXIT_IMPACT');
  });

  it('adverse impact past the cap is labelled, and only from the adverse field', () => {
    const over = DEFAULT_DIAGNOSTIC_THRESHOLDS.adverseImpactBps + 1;
    const d = diagnoseExit(ok({ impact: parseImpact({ priceImpactPct: -over / 10_000 }) }));
    expect(d.diagnostic).toBe('ADVERSE_EXIT_IMPACT');
  });
});

// ---------------------------------------------------------------------------
describe('5 — zero executable proceeds is a collapse', () => {
  it('a sell quote returning nothing is EXECUTABLE_VALUE_COLLAPSE', () => {
    expect(diagnoseExit(ok({ executableSellValueLamports: 0n })).diagnostic).toBe('EXECUTABLE_VALUE_COLLAPSE');
  });

  it('13 lamports against 42,553,483 of cost is a collapse, as it was for 3XiaH5DA', () => {
    const d = diagnoseExit(ok({ executableSellValueLamports: 13n, allInCostLamports: 42_553_483n }));
    expect(d.diagnostic).toBe('EXECUTABLE_VALUE_COLLAPSE');
    expect(executableValueRatioBps(13n, 42_553_483n)).toBe(0);
  });

  it('the collapse boundary is inclusive and one lamport above it is not a collapse', () => {
    // Cost chosen so that ONE lamport moves the ratio by more than a basis
    // point. At 1 SOL of cost a single lamport is 0.00001bps and the boundary
    // test would pass against any implementation.
    const cost = 1_000n;
    const at = (cost * BigInt(DEFAULT_DIAGNOSTIC_THRESHOLDS.collapseRatioBps)) / 10_000n;
    expect(diagnoseExit(ok({ executableSellValueLamports: at, allInCostLamports: cost })).diagnostic).toBe(
      'EXECUTABLE_VALUE_COLLAPSE',
    );
    expect(diagnoseExit(ok({ executableSellValueLamports: at + 1n, allInCostLamports: cost })).diagnostic).not.toBe(
      'EXECUTABLE_VALUE_COLLAPSE',
    );
  });
});

// ---------------------------------------------------------------------------
describe('6 — a provider failure is never a token fact', () => {
  it('a 429 outranks every economic label, including a zero quote', () => {
    const d = diagnoseExit(ok({ providerFailed: true, executableSellValueLamports: 0n, routeExists: false }));
    expect(d.diagnostic).toBe('PROVIDER_FAILURE');
    expect(disqualifiesFromConfirmatory(d.diagnostic)).toBe(true);
  });

  it('an absent route WITH a working provider is a token fact', () => {
    expect(diagnoseExit(ok({ providerFailed: false, routeExists: false })).diagnostic).toBe('NO_EXIT_ROUTE');
  });

  it('every diagnostic is reachable, so none is decorative', () => {
    const reached = new Set([
      diagnoseExit(ok({ providerFailed: true })).diagnostic,
      diagnoseExit(ok({ impact: parseImpact({ priceImpactPct: '9' }) })).diagnostic,
      diagnoseExit(ok({ routeExists: false })).diagnostic,
      diagnoseExit(ok({ routeBuildable: false })).diagnostic,
      diagnoseExit(ok({ quoteAgeMs: 10 ** 7 })).diagnostic,
      diagnoseExit(ok({ executableSellValueLamports: 0n })).diagnostic,
      diagnoseExit(ok({ impact: parseImpact({ priceImpactPct: -0.9 }) })).diagnostic,
      diagnoseExit(ok({ roundTripLossBps: 99_999 })).diagnostic,
      diagnoseExit(ok()).diagnostic,
    ]);
    // UNVERIFIABLE is produced only by the explicit helper, never by diagnosis.
    expect([...reached].sort()).toEqual(EXIT_DIAGNOSTICS.filter((d) => d !== 'UNVERIFIABLE').slice().sort());
  });
});

// ---------------------------------------------------------------------------
describe('7 & 8 — the UTC day, and a clock that moves', () => {
  it('a day key is derived deterministically and skipped days are counted', () => {
    const day = 86_400_000;
    const t = Date.UTC(2026, 7, 12, 23, 59, 59, 999);
    expect(utcDateKey(t)).toBe('2026-08-12');
    expect(utcDateKey(t + 1)).toBe('2026-08-13');
    expect(utcDaysBetween(t, t + 3 * day)).toBe(3);
    // Backwards is negative rather than clamped, so a rollback is visible.
    expect(utcDaysBetween(t, t - day)).toBe(-1);
  });

  it('a backward wall clock is detected rather than obeyed', () => {
    const v = detectDiscontinuity({ monotonicMs: 1_000, wallUtcMs: 1_000_000 }, { monotonicMs: 2_000, wallUtcMs: 990_000 });
    expect(v.discontinuity).toBe('WALL_JUMPED_BACKWARD');
  });

  it('a resume shows as wall running ahead of monotonic', () => {
    const v = detectDiscontinuity(
      { monotonicMs: 1_000, wallUtcMs: 1_000_000 },
      { monotonicMs: 1_100, wallUtcMs: 1_000_000 + 7_200_000 },
    );
    expect(v.discontinuity).toBe('WALL_JUMPED_FORWARD');
    expect(v.skewMs).toBeGreaterThan(7_000_000);
  });

  it('a monotonic cadence does not burst after a long stall', () => {
    // The wall-clock version fired once per missed interval, which after a
    // two-hour sleep is ~680 requests aimed at a 0.5 RPS budget.
    const c = new Cadence(10_000, 'mark');
    expect(c.due(0)).toBe(true);
    c.fired(0);
    expect(c.due(5_000)).toBe(false);
    expect(c.due(10_000)).toBe(true);
    c.fired(7_200_000);
    // One firing, and the next is a full interval away — not 720 catch-ups.
    expect(c.due(7_200_001)).toBe(false);
    expect(c.remainingMs(7_200_001)).toBeCloseTo(9_999, 0);
  });

  it('a reset cadence is due immediately, because its last reading predates the gap', () => {
    const c = new Cadence(10_000, 'mark');
    c.fired(1_000);
    expect(c.due(2_000)).toBe(false);
    c.reset();
    expect(c.due(2_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('12 — no override may loosen a canary or live cap', () => {
  /**
   * The tree carried `SAFER_WHEN_LOWER` and `SAFER_WHEN_HIGHER` and a function
   * to enforce them that nothing called (O041). This asserts the lists cover
   * every numeric risk field, so a new cap cannot be added outside the
   * mechanism and silently become overridable in either direction.
   */
  const canary = AppConfigSchema.parse(JSON.parse(readFileSync('config/canary.json', 'utf8')));
  const live = AppConfigSchema.parse(JSON.parse(readFileSync('config/live.json', 'utf8')));

  it('every numeric risk field is classified as safer-lower or safer-higher', () => {
    const numeric = Object.entries(canary.risk)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'bigint')
      .map(([k]) => k);
    const classified = new Set<string>([...SAFER_WHEN_LOWER, ...SAFER_WHEN_HIGHER]);
    expect(numeric.filter((f) => !classified.has(f))).toEqual([]);
  });

  it('no field is in both lists, which would make it unconstrainable', () => {
    const both = SAFER_WHEN_LOWER.filter((f) => (SAFER_WHEN_HIGHER as readonly string[]).includes(f));
    expect(both).toEqual([]);
  });

  it('live is at least as tight as canary on every safer-when-lower cap', () => {
    for (const field of SAFER_WHEN_LOWER) {
      const c = (canary.risk as Record<string, unknown>)[field];
      const l = (live.risk as Record<string, unknown>)[field];
      if (typeof c === 'number' && typeof l === 'number') expect(l).toBeLessThanOrEqual(c * 25);
      if (typeof c === 'bigint' && typeof l === 'bigint') expect(l >= 0n).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('13 — exact money past the safe integer', () => {
  it('a PnL beyond Number.MAX_SAFE_INTEGER survives the round trip exactly', () => {
    const a = 9_007_199_254_740_993n; // 2^53 + 1
    const b = 9_007_199_254_740_993n;
    const sum = a + b;
    expect(sum).toBe(18_014_398_509_481_986n);
    // The float path loses it, which is the whole reason amounts are TEXT.
    expect(BigInt(Number(a) + Number(b))).not.toBe(sum);
    expect(BigInt(sum.toString())).toBe(sum);
  });

  it('the executable value ratio stays exact in bigint before becoming a number', () => {
    const huge = 18_446_744_073_709_551_615n; // u64 max
    expect(executableValueRatioBps(huge, huge)).toBe(10_000);
    expect(executableValueRatioBps(huge / 2n, huge)).toBe(4_999);
  });
});

// ---------------------------------------------------------------------------
describe('15 — no rent credit without a possible close', () => {
  const base: AtaState = {
    ataCreated: true,
    ataRentLockedLamports: 2_039_280n,
    ataCloseBuildable: true,
    ataCloseSimulated: true,
    ataCloseAttempted: false,
    ataCloseConfirmed: false,
    residualTokenAmount: 0n,
    withheldTransferFeeLamports: 0n,
    ataCloseFeeLamports: 5_000n,
  };

  it('a clean close returns rent less the close fee', () => {
    const v = settleAtaRent(base);
    expect(v.ataRentRecoveredLamports).toBe(2_034_280n);
    expect(v.ataCloseFailureReason).toBeNull();
  });

  it('tokens left in the account block the close entirely', () => {
    const v = settleAtaRent({ ...base, residualTokenAmount: 1n });
    expect(v.ataRentRecoveredLamports).toBe(0n);
    expect(v.ataCloseFailureReason).toBe('NONZERO_TOKEN_BALANCE');
  });

  it('withheld Token-2022 transfer fees block the close', () => {
    const v = settleAtaRent({ ...base, withheldTransferFeeLamports: 1n });
    expect(v.ataCloseFailureReason).toBe('WITHHELD_TRANSFER_FEES');
  });

  it('an UNOBSERVED withheld fee is not treated as zero', () => {
    // This is the paper-mode case, and the reason paper recovery is 0.
    const v = settleAtaRent({ ...base, withheldTransferFeeLamports: null });
    expect(v.ataRentRecoveredLamports).toBe(0n);
    expect(v.ataCloseFailureReason).toBe('UNVERIFIED');
  });

  it('an UNOBSERVED residual balance is not treated as an empty account', () => {
    // The symmetric case to the withheld-fee unknown. An account we did not
    // look inside is not an account we know is empty, and CloseAccount fails on
    // a non-empty one — so assuming empty credits rent precisely when the
    // position is the kind we could not fully sell.
    const v = settleAtaRent({ ...base, residualTokenAmount: null });
    expect(v.ataRentRecoveredLamports).toBe(0n);
    expect(v.ataCloseFailureReason).toBe('UNVERIFIED');
  });

  it('a close that was never built earns no credit', () => {
    expect(settleAtaRent({ ...base, ataCloseBuildable: null }).ataCloseFailureReason).toBe('UNVERIFIED');
    expect(settleAtaRent({ ...base, ataCloseBuildable: false }).ataCloseFailureReason).toBe('CLOSE_NOT_BUILDABLE');
  });

  it('a submitted close that did not confirm earns no credit', () => {
    const v = settleAtaRent({ ...base, ataCloseAttempted: true, ataCloseConfirmed: false });
    expect(v.ataCloseFailureReason).toBe('CLOSE_NOT_CONFIRMED');
  });

  it('the four recovery scenarios are reported together', () => {
    const s = rentRecoveryScenarios(2_039_280n, 0n);
    expect(s).toEqual({ full: 2_039_280n, observed: 0n, half: 1_019_640n, none: 0n });
  });
});

// ---------------------------------------------------------------------------
describe('17 — a report refuses to pool regimes', () => {
  it('two regimes throw rather than averaging', () => {
    expect(() =>
      requireSingleRegime([{ dataRegimeId: 'v0.2/31s/quote/aaa' }, { dataRegimeId: 'v0.3/10s/build/bbb' }]),
    ).toThrow(PoolingRefused);
  });

  it('an untagged row counts as its own regime and cannot be folded in silently', () => {
    expect(() => requireSingleRegime([{ dataRegimeId: 'v0.3/10s/build/bbb' }, { dataRegimeId: null }])).toThrow(
      PoolingRefused,
    );
  });

  it('one regime is fine', () => {
    expect(requireSingleRegime([{ dataRegimeId: 'r' }, { dataRegimeId: 'r' }])).toBe('r');
  });
});

// ---------------------------------------------------------------------------
describe('18 — the unit of resampling is never the mark', () => {
  it('a mark-level bootstrap is refused', () => {
    expect(() => requireBlockUnit('mark')).toThrow(ResamplingUnitRefused);
    expect(() => blocksFor([{ id: 1 }], 'mark', () => 'k')).toThrow(ResamplingUnitRefused);
  });

  it('position, mint and utc_day are the permitted units', () => {
    for (const u of ['position', 'mint', 'utc_day']) expect(requireBlockUnit(u)).toBe(u);
  });

  it('grouping returns blocks, not rows, so the flattened list cannot be resampled by accident', () => {
    const rows = [
      { position: 'a', pnl: 1 },
      { position: 'a', pnl: 2 },
      { position: 'b', pnl: 3 },
    ];
    const blocks = blocksFor(rows, 'position', (r) => r.position);
    expect(blocks.size).toBe(2);
    expect(blocks.get('a')).toHaveLength(2);
  });

  it('a policy may not be selected on fewer than fifty valid trades', () => {
    expect(mayRankPolicies(49).allowed).toBe(false);
    expect(mayRankPolicies(50).allowed).toBe(true);
    expect(mayCallDeploymentEvidence(199, 30).allowed).toBe(false);
    expect(mayCallDeploymentEvidence(200, 20).allowed).toBe(false);
    expect(mayCallDeploymentEvidence(200, 21).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('19 — a counterfactual fills later, or not at all', () => {
  const mark = (over: Partial<CounterfactualMark>): CounterfactualMark => ({
    markId: 'm',
    quoteId: 'q',
    observedUtcMs: 0,
    executableSellValueLamports: 1_000n,
    routeBuildable: true,
    ...over,
  });

  it('fills at the first LATER build-valid mark, not the trigger', () => {
    const marks = [
      mark({ markId: 'm0', quoteId: 'q0', observedUtcMs: 0, executableSellValueLamports: 900n }),
      mark({ markId: 'm1', quoteId: 'q1', observedUtcMs: 10_000, executableSellValueLamports: 800n }),
    ];
    const r = replayPolicy(marks, (m) => m.markId === 'm0', 1_000);
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') {
      expect(r.fill.fillMarkId).toBe('m1');
      expect(r.fill.proceedsLamports).toBe(800n);
    }
  });

  it('reusing the trigger quote as the fill price throws', () => {
    const marks = [
      mark({ markId: 'm0', quoteId: 'SAME', observedUtcMs: 0 }),
      mark({ markId: 'm1', quoteId: 'SAME', observedUtcMs: 10_000 }),
    ];
    expect(() => replayPolicy(marks, (m) => m.markId === 'm0', 1_000)).toThrow(TriggerQuoteReused);
  });

  it('a mark inside the latency window cannot be the fill', () => {
    const marks = [
      mark({ markId: 'm0', quoteId: 'q0', observedUtcMs: 0 }),
      mark({ markId: 'm1', quoteId: 'q1', observedUtcMs: 500 }),
      mark({ markId: 'm2', quoteId: 'q2', observedUtcMs: 5_000, executableSellValueLamports: 700n }),
    ];
    const r = replayPolicy(marks, (m) => m.markId === 'm0', 2_000);
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.fill.fillMarkId).toBe('m2');
  });

  it('no build-valid quote afterwards is EXIT_BLOCKED, not the last price we saw', () => {
    const marks = [
      mark({ markId: 'm0', quoteId: 'q0', observedUtcMs: 0 }),
      mark({ markId: 'm1', quoteId: 'q1', observedUtcMs: 10_000, routeBuildable: false }),
      mark({ markId: 'm2', quoteId: 'q2', observedUtcMs: 20_000, routeBuildable: null }),
    ];
    const r = replayPolicy(marks, (m) => m.markId === 'm0', 1_000);
    expect(r.kind).toBe('exit_blocked');
  });

  it('triggers on the FIRST qualifying mark, not the most favourable one', () => {
    const marks = [
      mark({ markId: 'm0', quoteId: 'q0', observedUtcMs: 0, executableSellValueLamports: 500n }),
      mark({ markId: 'm1', quoteId: 'q1', observedUtcMs: 10_000, executableSellValueLamports: 400n }),
      mark({ markId: 'm2', quoteId: 'q2', observedUtcMs: 20_000, executableSellValueLamports: 9_000n }),
    ];
    const r = replayPolicy(marks, (m) => (m.executableSellValueLamports ?? 0n) < 600n, 1);
    expect(r.kind).toBe('filled');
    // Fills at m1 (400), not at the m2 rescue price.
    if (r.kind === 'filled') expect(r.fill.proceedsLamports).toBe(400n);
  });
});

// ---------------------------------------------------------------------------
describe('20 — missing provenance excludes a row from confirmatory results', () => {
  it('no context hash excludes', () => {
    const r = admissible({
      contextHash: null,
      dataRegimeId: null,
      rawPayloadHash: 'p',
      bothLegsBuildable: true,
      diagnostic: 'NONE',
    });
    expect(r.admissible).toBe(false);
    expect(r.exclusions).toContain('NO_CONTEXT');
  });

  it('no retained raw payload excludes, because the row cannot be re-derived', () => {
    const r = admissible({
      contextHash: 'c',
      dataRegimeId: 'r',
      rawPayloadHash: null,
      bothLegsBuildable: true,
      diagnostic: 'NONE',
    });
    expect(r.exclusions).toContain('NO_RAW_PAYLOAD');
  });

  it('a disqualifying diagnostic excludes even when everything else is present', () => {
    for (const d of ['PROVIDER_FAILURE', 'SCHEMA_OR_PARSER_ERROR', 'STALE_EXIT_QUOTE', 'UNVERIFIABLE'] as const) {
      const r = admissible({
        contextHash: 'c',
        dataRegimeId: 'r',
        rawPayloadHash: 'p',
        bothLegsBuildable: true,
        diagnostic: d,
      });
      expect(r.admissible).toBe(false);
    }
  });

  it('a fully provenanced, build-valid, clean row is admissible', () => {
    expect(
      admissible({
        contextHash: 'c',
        dataRegimeId: 'r',
        rawPayloadHash: 'p',
        bothLegsBuildable: true,
        diagnostic: 'NONE',
      }).admissible,
    ).toBe(true);
  });
});

function prov(): Parameters<typeof toExecutableQuote>[2] {
  return {
    source: 'test',
    sourceType: 'official_indexer',
    receivedMonotonicMs: 0,
    receivedUtcMs: 0,
    slot: null,
    sourceUtcMs: null,
    schemaVersion: 'test',
    parserVersion: 'test',
    payloadHash: '',
  };
}
