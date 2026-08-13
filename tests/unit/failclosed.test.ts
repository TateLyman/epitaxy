import { describe, it, expect } from 'vitest';
import {
  missingBuildField,
  isIncompleteBuild,
  isProviderFailure,
  isTokenFact,
  OBSERVATION_FAILURES,
  type BuildFields,
  type BuildExpectation,
} from '../../packages/domain/src/execution.js';

/**
 * §6 — a build that arrives missing a load-bearing field is refused, and the
 * refusal names the field.
 *
 * Every one of these used to become a zero or an empty list somewhere
 * downstream. The dangerous one is the minimum output: absent, it becomes 0,
 * and a transaction with a minimum output of zero accepts ANY fill including
 * almost none. It is not a safer trade than a tight one, it is an unbounded
 * one, and on the stored row it looks identical to a route with generous
 * slippage.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const want: BuildExpectation = { inputMint: SOL, outputMint: MINT, requestedAmount: 20_000_000n };

const complete = (over: Partial<BuildFields> = {}): BuildFields => ({
  inputMint: SOL,
  outputMint: MINT,
  inAmount: 20_000_000n,
  outAmount: 1_500_000n,
  otherAmountThreshold: 1_400_000n,
  routePlanEntries: 1,
  instructionCount: 7,
  hasSwapInstruction: true,
  lookupTablesResolved: true,
  blockhash: 'BH',
  lastValidBlockHeight: 400_000_000,
  contextSlot: 438_000_000,
  ...over,
});

describe('missingBuildField', () => {
  it('accepts a complete response', () => {
    expect(missingBuildField(complete(), want)).toBeNull();
  });

  it.each([
    ['MISSING_MINIMUM_OUTPUT', { otherAmountThreshold: null }],
    ['MISSING_MINIMUM_OUTPUT', { otherAmountThreshold: 0n }],
    ['MISSING_MINIMUM_OUTPUT', { outAmount: null }],
    ['MISSING_ROUTE_PLAN', { routePlanEntries: 0 }],
    ['MISSING_SWAP_INSTRUCTION', { hasSwapInstruction: false }],
    ['MISSING_SWAP_INSTRUCTION', { instructionCount: 0 }],
    ['MISSING_LOOKUP_TABLE', { lookupTablesResolved: false }],
    ['MISSING_BLOCKHASH', { blockhash: null }],
    ['MISSING_BLOCKHASH', { blockhash: '' }],
    ['MISSING_EXPIRY', { lastValidBlockHeight: null }],
    ['MISSING_EXPIRY', { lastValidBlockHeight: 0 }],
  ] as [string, Partial<BuildFields>][])('returns %s', (expected, over) => {
    expect(missingBuildField(complete(over), want)).toBe(expected);
  });

  it('refuses a route for a different mint', () => {
    expect(missingBuildField(complete({ outputMint: SOL }), want)).toBe('MINT_MISMATCH');
    expect(missingBuildField(complete({ inputMint: null }), want)).toBe('MINT_MISMATCH');
  });

  it('refuses a route for a different size, exactly', () => {
    // One lamport off is a different trade. This system prices the exact size
    // it asked for, and inheriting another size's economics prices a position
    // that was never proposed.
    expect(missingBuildField(complete({ inAmount: 19_999_999n }), want)).toBe('AMOUNT_MISMATCH');
    expect(missingBuildField(complete({ inAmount: 20_000_001n }), want)).toBe('AMOUNT_MISMATCH');
    expect(missingBuildField(complete({ inAmount: null }), want)).toBe('AMOUNT_MISMATCH');
  });

  it('does NOT refuse a build for a missing contextSlot', () => {
    // MT026. Measured: context_slot is null on all 22,177 observations, because
    // Jupiter's /build does not return it. A hard veto here refuses 100% of
    // builds and halts collection -- the same defect as MT001 and MT002, and
    // against the standing invariant that absence of a provider field is a fact
    // about the PROVIDER and never hard-vetoes.
    //
    // The unit tests passed while this was broken, because the fixtures
    // supplied a contextSlot on the strength of the directive saying the field
    // existed. Only a live build caught it.
    expect(missingBuildField(complete({ contextSlot: null }), want)).toBeNull();
    expect(missingBuildField(complete({ contextSlot: 0 }), want)).toBeNull();
  });

  it('checks the mints before anything else, so the reason is the most informative one', () => {
    // A response for the wrong mint that is ALSO missing a blockhash is a wrong
    // -mint problem. Reporting the blockhash would send someone chasing the
    // provider's uptime instead of their routing.
    expect(missingBuildField(complete({ outputMint: SOL, blockhash: null }), want)).toBe('MINT_MISMATCH');
  });
});

describe('the failure taxonomy keeps its three kinds apart', () => {
  it('classifies an incomplete build as neither an outage nor a token fact', () => {
    for (const f of ['MISSING_MINIMUM_OUTPUT', 'MISSING_BLOCKHASH', 'AMOUNT_MISMATCH', 'MINT_MISMATCH'] as const) {
      expect(isIncompleteBuild(f)).toBe(true);
      // The provider answered, so it is not an outage...
      expect(isProviderFailure(f)).toBe(false);
      // ...and the answer was about a real route, so it is not "no route".
      expect(isTokenFact(f)).toBe(false);
    }
  });

  it('keeps outages and no-route where they were', () => {
    expect(isProviderFailure('HTTP_429')).toBe(true);
    expect(isIncompleteBuild('HTTP_429')).toBe(false);
    expect(isTokenFact('NO_ROUTE')).toBe(true);
    expect(isIncompleteBuild('NO_ROUTE')).toBe(false);
  });

  it('has every typed missing-field failure in the persisted enum', () => {
    // execution_observations.failure is plain TEXT with no CHECK constraint, so
    // an unlisted value would be stored silently rather than rejected. That is
    // worse than a throw: the corpus would carry a failure kind that no report
    // groups and no reader knows to look for. This list is the only thing
    // keeping the taxonomy closed.
    for (const f of [
      'MISSING_MINIMUM_OUTPUT',
      'MISSING_BLOCKHASH',
      'MISSING_EXPIRY',
      'MISSING_ROUTE_PLAN',
      'MISSING_SWAP_INSTRUCTION',
      'MISSING_LOOKUP_TABLE',
      'MISSING_CONTEXT_SLOT',
      'AMOUNT_MISMATCH',
      'MINT_MISMATCH',
    ]) {
      expect(OBSERVATION_FAILURES).toContain(f);
    }
  });
});

describe('§6 contextSlot blocks EVIDENCE, not collection', () => {
  it('keeps MISSING_CONTEXT_SLOT in the taxonomy for a provider that does send it', () => {
    // Not removed: another router may populate it, and a build that claims a
    // slot of zero is still wrong.
    expect(OBSERVATION_FAILURES).toContain('MISSING_CONTEXT_SLOT');
  });
});
