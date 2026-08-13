import { describe, it, expect } from 'vitest';
import { verifyEffect, type EffectContext } from '../../packages/simulator/src/effect.js';
import type { SimulationRequest, SimulationResponse } from '../../packages/simulator/src/protocol.js';

/**
 * P3 — runtime success is not economic success.
 *
 * Each of these is one of the directive's required refusals, expressed as a
 * response the runtime accepted without complaint. Every one of them would have
 * been recorded as `SIMULATED_OK` and read downstream as "the leg works".
 */

const TAKER = 'Taker11111111111111111111111111111111111111';
const FEE_PAYER = TAKER;
const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'Mint1111111111111111111111111111111111111111';
const STRANGER = 'Str4nger11111111111111111111111111111111111';

function req(over: Partial<SimulationRequest> = {}): SimulationRequest {
  return {
    protocolVersion: 1,
    jobId: 'job-1',
    requestHash: 'rh',
    executionObservationId: 'obs-1',
    mode: 'DEVELOPMENT_JIT',
    transactionBase64: 'AQID',
    originalTransactionHash: 'th',
    originalMessageHash: 'mh',
    originalBlockhash: 'bh',
    originalLastValidBlockHeight: 400,
    routeFamily: 'BUILD_CUSTOM',
    requestedAmount: '20000000',
    targetSlot: 438_000_000,
    snapshotManifestHash: 'jit-no-frozen-snapshot',
    snapshotAccounts: [],
    balanceMutations: [{ kind: 'sol', owner: TAKER, amount: '200000000' }],
    bounds: { feePayer: FEE_PAYER, maxLamportsSpent: '40000000', mint: MINT, minTokenDelta: '900' },
    contextHash: null,
    ...over,
  };
}

/**
 * A buy of 0.02 SOL that worked: the taker paid the input plus a 5,000 base fee
 * and a 1,000 priority fee, received 1,000 tokens, and nothing else moved.
 */
function res(over: Partial<SimulationResponse> = {}): SimulationResponse {
  return {
    protocolVersion: 1,
    jobId: 'job-1',
    requestHash: 'rh',
    identity: {} as never,
    snapshotManifestHash: 'jit-no-frozen-snapshot',
    status: 'SIMULATED_OK',
    transactionError: null,
    logs: [],
    unitsConsumed: 120_000,
    preSolBalances: { [TAKER]: '200000000', [STRANGER]: '1000000' },
    postSolBalances: { [TAKER]: '179994000', [STRANGER]: '1000000' },
    preTokenBalances: { [`${TAKER}:${MINT}`]: '0' },
    postTokenBalances: { [`${TAKER}:${MINT}`]: '1000' },
    baseFeeLamports: '5000',
    priorityFeeLamports: '1000',
    rentCreatedLamports: '0',
    rentRecoveredLamports: '0',
    transferFeeLamports: '0',
    withheldFeeLamports: '0',
    createdAccounts: [],
    closedAccounts: [],
    boundsViolations: [],
    mutatedAccountHashes: { [TAKER]: 'h1' },
    blockhashReplacement: null,
    contextSlot: 438_000_000,
    runtimeEventDigest: 'd',
    exportedSnapshot: [],
    exportOmissions: [],
    jitFetchedAccounts: [],
    queueWaitMs: 0,
    startupMs: 1,
    simulateMs: 1,
    totalMs: 2,
    detail: '',
    ...over,
  } as SimulationResponse;
}

const ctx: EffectContext = { taker: TAKER, side: 'buy', inputMint: WSOL, outputMint: MINT };

describe('P3 — SIMULATED_EFFECT_OK is four checks, not one', () => {
  it('passes a buy that actually delivered', () => {
    const v = verifyEffect(req(), res(), ctx);
    expect(v.refusals).toEqual([]);
    expect(v.simulatedEffectOk).toBe(true);
    expect(v.checks).toEqual({
      RUNTIME_OK: true,
      EFFECT_OK: true,
      FEE_DECOMPOSITION_OK: true,
      ACCOUNT_COVERAGE_OK: true,
    });
    // The debit is the input NET of fees: 200000000 - 179994000 = 20006000,
    // less 6000 of fee, is exactly the 20000000 that was requested.
    expect(v.inputDebit).toBe(20_000_000n);
    expect(v.outputCredit).toBe(1000n);
  });

  it('runtime succeeds but output delta is missing', () => {
    // The transaction ran, charged the fee, debited the input, and delivered
    // nothing. No error, so `SIMULATED_OK` — and a fill would have been booked.
    const v = verifyEffect(req(), res({ postTokenBalances: { [`${TAKER}:${MINT}`]: '0' } }), ctx);
    expect(v.checks.RUNTIME_OK).toBe(true);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.refusals.join(' ')).toMatch(/output delta is missing/);
  });

  it('runtime succeeds but the output balance was never observed', () => {
    // Absent is not zero, and it is not "fine" either. It is unknown, and an
    // unknown output cannot support a claim that an output arrived.
    const v = verifyEffect(req(), res({ postTokenBalances: {} }), ctx);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.outputCredit).toBeNull();
    expect(v.refusals.join(' ')).toMatch(/output delta is missing/);
  });

  it('runtime succeeds but output is below minimum', () => {
    const v = verifyEffect(req(), res({ postTokenBalances: { [`${TAKER}:${MINT}`]: '400' } }), ctx);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.refusals.join(' ')).toMatch(/below minimum: 400 < 900/);
  });

  it('runtime succeeds but input debit exceeds maximum', () => {
    // Spent 0.05 SOL against a 0.04 ceiling. The runtime has no opinion about
    // the caller's ceiling; that is precisely why the caller must check it.
    const v = verifyEffect(req(), res({ postSolBalances: { [TAKER]: '149994000', [STRANGER]: '1000000' } }), ctx);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.refusals.join(' ')).toMatch(/exceeds maximum|exceeds the requested amount/);
  });

  it('runtime succeeds but an unexpected writable receives value', () => {
    // A skim. Every asserted party is whole, the trade looks right, and value
    // left to an address nobody named.
    const v = verifyEffect(req(), res({ postSolBalances: { [TAKER]: '179994000', [STRANGER]: '1500000' } }), ctx);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.unexpectedRecipients).toEqual([STRANGER]);
    expect(v.unexpectedMovementLamports).toBe(500_000n);
    expect(v.refusals.join(' ')).toMatch(/unexpected writable receives value/);
  });

  it('an expected recipient is not unexpected movement', () => {
    const v = verifyEffect(
      req(),
      res({ postSolBalances: { [TAKER]: '179994000', [STRANGER]: '1500000' } }),
      { ...ctx, expectedRecipients: [STRANGER] },
    );
    expect(v.unexpectedRecipients).toEqual([]);
    expect(v.simulatedEffectOk).toBe(true);
  });

  it('runtime succeeds but a writable account was unobserved', () => {
    const v = verifyEffect(req(), res({ mutatedAccountHashes: { [TAKER]: 'h1', 'Pool111': 'h2' } }), ctx);
    expect(v.checks.ACCOUNT_COVERAGE_OK).toBe(false);
    expect(v.unobservedAccounts).toContain('Pool111');
    expect(v.refusals.join(' ')).toMatch(/writable account was unobserved/);
  });

  it('an export omission is missing coverage, whatever the balances say', () => {
    const v = verifyEffect(req(), res({ exportOmissions: ['Pool111: no ELF'] }), ctx);
    expect(v.checks.ACCOUNT_COVERAGE_OK).toBe(false);
    expect(v.simulatedEffectOk).toBe(false);
  });

  it('an unreported fee component fails decomposition rather than defaulting to zero', () => {
    // A fee the model does not know about is exactly what turns a positive
    // backtest into a negative account, and it is never zero by default.
    for (const missing of [
      { priorityFeeLamports: null },
      { baseFeeLamports: null },
      { rentCreatedLamports: null },
      { rentRecoveredLamports: null },
    ]) {
      const v = verifyEffect(req(), res(missing), ctx);
      expect(v.checks.FEE_DECOMPOSITION_OK, JSON.stringify(missing)).toBe(false);
      expect(v.simulatedEffectOk).toBe(false);
    }
  });

  it('a runtime failure fails every downstream check and is not silently a pass', () => {
    const v = verifyEffect(
      req(),
      res({ status: 'SIMULATION_FAILED', transactionError: '{"InstructionError":[2,{"Custom":6025}]}' }),
      ctx,
    );
    expect(v.checks.RUNTIME_OK).toBe(false);
    expect(v.checks.EFFECT_OK).toBe(false);
    expect(v.simulatedEffectOk).toBe(false);
  });

  it('a daemon-reported bounds violation is a refusal even if everything else holds', () => {
    const v = verifyEffect(req(), res({ boundsViolations: ['maxLamportsSpent exceeded'] }), ctx);
    expect(v.simulatedEffectOk).toBe(false);
    expect(v.refusals.join(' ')).toMatch(/asserted bounds violated/);
  });

  it('verifies a SELL by its token debit rather than its SOL delta', () => {
    const sellReq = req({
      requestedAmount: '1000',
      bounds: { feePayer: FEE_PAYER, maxLamportsSpent: '20000000', minTokenDelta: '15000000' },
    });
    const sellRes = res({
      preTokenBalances: { [`${TAKER}:${MINT}`]: '1000' },
      postTokenBalances: { [`${TAKER}:${MINT}`]: '0' },
      preSolBalances: { [TAKER]: '100000000', [STRANGER]: '1000000' },
      postSolBalances: { [TAKER]: '119994000', [STRANGER]: '1000000' },
    });
    const v = verifyEffect(sellReq, sellRes, { taker: TAKER, side: 'sell', inputMint: MINT, outputMint: WSOL });
    expect(v.inputDebit).toBe(1000n);
    expect(v.outputCredit).toBe(20_000_000n);
    expect(v.simulatedEffectOk).toBe(true);
  });
});
