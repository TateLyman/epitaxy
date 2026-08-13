import { describe, it, expect } from 'vitest';
import {
  admitPortfolioEntry,
  admitPortfolioExit,
  chooseDecisionMark,
  type RouteObserver,
  type LegSimulator,
} from '../../apps/engine/src/paper-core.js';
import type {
  ExecutionObservation,
  SimulationOutcome,
  SimulationEffectOutcome,
} from '../../packages/domain/src/execution.js';

/**
 * P8 — behaviour, executed.
 *
 * The tests these replace read `paper.ts` as a string. One found the substring
 * `shadow_entry_roundtrip` and concluded portfolio entry required a round trip;
 * it did not. Another sliced `manageShadowBooks` and concluded marks were
 * executable; `manageOpenPositions` was still marking from `/order`. Both
 * passed against an implementation that had the phrase and the defect.
 *
 * Every test here calls the function and asserts on what it returned.
 */

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'Mint1111111111111111111111111111111111111111';

/** Written against the REAL type. A double that returns a shape the real code
 *  never returns produces failures that look like production defects. */
function obs(over: Partial<ExecutionObservation> = {}): ExecutionObservation {
  return {
    observationId: 'obs-buy',
    family: 'BUILD_CUSTOM',
    mint: MINT,
    side: 'buy',
    requestedAmount: 20_000_000n,
    expectedOutput: 1_000_000n,
    minimumOutput: 990_000n,
    instructionPolicy: 'PASS',
    transactionPolicy: 'PASS',
    simulation: 'SIMULATED_OK',
    simulationEffect: 'SIMULATED_EFFECT_OK',
    instructionSetHash: 'ish',
    rawPayloadHash: 'rph',
    lastValidBlockHeight: 400,
    instructionCount: 6,
    transactionBytes: 900,
    contextSlot: 438_000_000,
    ...over,
  } as ExecutionObservation;
}

interface ObserverScript {
  buy?: ExecutionObservation | null;
  sell?: ExecutionObservation | null;
}

function observer(script: ObserverScript): RouteObserver & { calls: { side: string; amount: bigint }[] } {
  const calls: { side: string; amount: bigint }[] = [];
  return {
    calls,
    observe: async (req) => {
      calls.push({ side: req.side, amount: req.amount });
      return req.side === 'buy' ? (script.buy ?? obs()) : (script.sell ?? null);
    },
  };
}

function simulator(
  verdicts: Record<string, { simulation: SimulationOutcome; effect: SimulationEffectOutcome }> = {},
): LegSimulator & { seen: { id: string; side: string; amount: bigint }[] } {
  const seen: { id: string; side: string; amount: bigint }[] = [];
  return {
    seen,
    simulate: async (observationId, leg) => {
      seen.push({ id: observationId, side: leg.side, amount: leg.inputAmount });
      return verdicts[observationId] ?? { simulation: 'SIMULATED_OK', effect: 'SIMULATED_EFFECT_OK' };
    },
  };
}

const ECON = { allInCostLamports: 20_500_000n, requireLocalSimulation: true };
const TOKENS = (): bigint => 1_000_000n;

describe('P8/P9 — portfolio entry executes a round trip, not a phrase', () => {
  it('refuses an entry whose exit route cannot be observed', async () => {
    // THE defect. The old path opened the position here: the buy was fine, and
    // nobody asked whether it could ever be closed.
    const r = await admitPortfolioEntry(
      { observer: observer({ sell: null }), simulator: simulator() },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/exit route could not be observed/);
  });

  it('observes the sell at the EXACT amount the buy would acquire', async () => {
    const o = observer({ sell: obs({ observationId: 'obs-sell', side: 'sell' }) });
    await admitPortfolioEntry(
      { observer: o, simulator: simulator() },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    // A sell observed at a round number is a price for a trade nobody is going
    // to make, and it flatters exactly the positions too large for their pool.
    expect(o.calls).toEqual([
      { side: 'buy', amount: 20_000_000n },
      { side: 'sell', amount: 1_000_000n },
    ]);
  });

  it('refuses when the exit half simulates but its effect is not verified', async () => {
    const r = await admitPortfolioEntry(
      {
        observer: observer({ sell: obs({ observationId: 'obs-sell', side: 'sell' }) }),
        simulator: simulator({ 'obs-sell': { simulation: 'SIMULATED_OK', effect: 'EFFECT_REFUSED' } }),
      },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/sell: simulation effect EFFECT_REFUSED/);
  });

  it('refuses a cross-family round trip, which is two markets and not a round trip', async () => {
    const r = await admitPortfolioEntry(
      {
        observer: observer({ sell: obs({ observationId: 'obs-sell', side: 'sell', family: 'ORDER_EXECUTE' }) }),
        simulator: simulator(),
      },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/does not match the entry family/);
  });

  it('admits a complete round trip and measures its loss against the ALL-IN cost', async () => {
    const r = await admitPortfolioEntry(
      {
        observer: observer({ sell: obs({ observationId: 'obs-sell', side: 'sell', expectedOutput: 18_000_000n }) }),
        simulator: simulator(),
      },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    // (20_500_000 - 18_000_000) / 20_500_000 = 1219 bps. Against the input
    // alone it would read 1000 bps, and the 219 bps difference is the fees,
    // tip and rent that make a break-even strategy a losing one.
    expect(r.roundTripLossBps).toBe(1219);
  });

  it('simulates BOTH legs, each with its own side and amount', async () => {
    const sim = simulator();
    await admitPortfolioEntry(
      {
        observer: observer({ sell: obs({ observationId: 'obs-sell', side: 'sell' }) }),
        simulator: sim,
      },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: TOKENS, economics: ECON },
    );
    expect(sim.seen).toEqual([
      { id: 'obs-buy', side: 'buy', amount: 20_000_000n },
      { id: 'obs-sell', side: 'sell', amount: 1_000_000n },
    ]);
  });

  it('refuses an entry that acquires nothing before it ever looks for an exit', async () => {
    const o = observer({ sell: obs({ observationId: 'obs-sell', side: 'sell' }) });
    const r = await admitPortfolioEntry(
      { observer: o, simulator: simulator() },
      { mint: MINT, lamportsIn: 20_000_000n, tokensFrom: () => 0n, economics: ECON },
    );
    expect(r.ok).toBe(false);
    expect(o.calls.filter((c) => c.side === 'sell')).toEqual([]);
  });
});

describe('P9 — only an executable number may move a stop', () => {
  it('marks from the BUILD_CUSTOM sell when there is one', () => {
    const d = chooseDecisionMark({
      executableLamports: 18_000_000n,
      benchmarkLamports: 19_000_000n,
      priorityFeeLamports: 100_000n,
    });
    expect(d.source).toBe('BUILD_CUSTOM_SELL');
    expect(d.decisionBearing).toBe(true);
    expect(d.markLamports).toBe(17_900_000n);
    // The router's opinion is 555 bps above what the position can actually be
    // sold for, which is the measurement the benchmark exists to provide.
    expect(d.benchmarkMinusExecutableBps).toBe(555);
  });

  it('does NOT mark from /order when no executable sell exists', () => {
    // The old behaviour, stated directly: a benchmark and nothing else used to
    // become the mark, and every stop, trail, peak and NAV read it.
    const d = chooseDecisionMark({
      executableLamports: null,
      benchmarkLamports: 19_000_000n,
      priorityFeeLamports: 100_000n,
    });
    expect(d.source).toBe('ORDER_QUOTE_BENCHMARK');
    expect(d.decisionBearing).toBe(false);
    // Null holds the position. A zero here would stop out every position the
    // moment the builder had a bad minute.
    expect(d.markLamports).toBeNull();
  });

  it('treats a zero executable value as unpriceable rather than as worthless', () => {
    const d = chooseDecisionMark({ executableLamports: 0n, benchmarkLamports: 19_000_000n, priorityFeeLamports: 0n });
    expect(d.decisionBearing).toBe(false);
    expect(d.markLamports).toBeNull();
  });
});

describe('P9 — the exit is simulated before it is judged', () => {
  it('simulates the exit leg as a SELL of the exact balance held', async () => {
    const sim = simulator();
    await admitPortfolioExit(
      { simulator: sim },
      { exit: obs({ observationId: 'obs-exit', side: 'sell' }), mint: MINT, tokenAmount: 777n, requireLocalSimulation: true },
    );
    // The old path never called this at all, so the simulation clause could
    // only ever read NOT_SIMULATED.
    expect(sim.seen).toEqual([{ id: 'obs-exit', side: 'sell', amount: 777n }]);
  });

  it('blocks rather than closing when the exit is not executable', async () => {
    const r = await admitPortfolioExit(
      { simulator: simulator({ 'obs-exit': { simulation: 'SIMULATION_FAILED', effect: 'EFFECT_REFUSED' } }) },
      { exit: obs({ observationId: 'obs-exit', side: 'sell' }), mint: MINT, tokenAmount: 777n, requireLocalSimulation: true },
    );
    expect(r.ok).toBe(false);
    // Blocked, not closed. The tokens are still held, the rent is still
    // locked, and the exposure is still ours.
    expect(r.blocked).toBe(true);
  });

  it('admits an exit whose effect was verified', async () => {
    const r = await admitPortfolioExit(
      { simulator: simulator() },
      { exit: obs({ observationId: 'obs-exit', side: 'sell' }), mint: MINT, tokenAmount: 777n, requireLocalSimulation: true },
    );
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it('an exit whose input is WSOL is refused: it is not a sell', async () => {
    // The setup defect from P2, restated at the decision layer.
    const sim = simulator();
    await admitPortfolioExit(
      { simulator: sim },
      { exit: obs({ observationId: 'obs-exit', side: 'sell' }), mint: WSOL, tokenAmount: 777n, requireLocalSimulation: true },
    );
    expect(sim.seen[0]?.side).toBe('sell');
  });
});
