import type { ExecutionObservation, SimulationOutcome, SimulationEffectOutcome } from '../../../packages/domain/src/execution.js';
import { legIsExecutable } from '../../../packages/domain/src/execution.js';

/**
 * P8 — the paper engine's decisions, as importable behaviour.
 *
 * `paper.ts` was a process shell and a decision engine in one file, so the only
 * tests that could reach the decisions read the source as a string. Those tests
 * made false claims: one found the substring `shadow_entry_roundtrip` somewhere
 * in the file and concluded portfolio entry required a round trip, when it did
 * not; another sliced the shadow-book function and concluded marks were
 * executable, when `manageOpenPositions` was still marking from `/order`.
 *
 * A test that greps for a reassuring phrase passes against the implementation
 * that has the phrase and the defect. Everything here executes.
 *
 * Collaborators are injected — observer, simulator, clock, verdict reader — so
 * a test supplies doubles rather than a network and a database. The doubles are
 * written against the real return types; a stub returning a shape the real
 * client never returns produces failures that look like production defects.
 */

export interface Clock {
  now(): number;
}

/** What the caller wants observed. Deliberately the shape `observeRoute` takes. */
export interface RouteRequest {
  readonly side: 'buy' | 'sell';
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amount: bigint;
  readonly purpose: string;
}

export interface RouteObserver {
  /** Null means the route could not be observed at all. Not an empty route. */
  observe(req: RouteRequest): Promise<ExecutionObservation | null>;
}

export interface LegSimulator {
  /**
   * Simulate one leg and return what the database now says about it.
   *
   * Returns the two verdicts separately because they answer different
   * questions: whether the runtime complained, and whether the trade happened.
   */
  simulate(
    observationId: string,
    leg: {
      side: 'buy' | 'sell';
      inputMint: string;
      outputMint: string;
      inputAmount: bigint;
      expectedOutput: bigint | null;
      minimumOutput: bigint | null;
    },
  ): Promise<{ simulation: SimulationOutcome; effect: SimulationEffectOutcome }>;
}

export interface EntryEconomics {
  /** Every fixed cost of getting in, already summed. */
  readonly allInCostLamports: bigint;
  readonly requireLocalSimulation: boolean;
  /**
   * P6 — the frozen cap the measured round trip must clear.
   *
   * A score can rank economically viable trades. It cannot rescue a
   * mechanically losing one, so this refuses rather than penalises.
   */
  readonly maxRoundTripLossBps: number;
}

/**
 * The measured economics of a settled leg pair.
 *
 * Supplied by the caller because only it can reach the database the simulator
 * wrote to. The core decides; it does not query.
 */
export interface MeasuredRoundTrip {
  readonly tradingLossBps: number;
  readonly allInLossBps: number;
  readonly netLamports: bigint;
  readonly recoverableRentLamports: bigint;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface RoundTripReader {
  /**
   * The measured round trip for these two observations, or null when either
   * leg has no effect-verified settlement.
   *
   * Null is not "assume it is fine". An entry whose economics were never
   * measured is refused.
   */
  measure(buyObservationId: string, sellObservationId: string): MeasuredRoundTrip | null;
}

/**
 * The tokens a buy ACTUALLY acquired, from its measured settlement.
 *
 * Returns null when the credit was not measured. The old contract took a
 * `tokensFrom(buy)` function that read the router's floor off the observation,
 * which is what the buy promised not to go below — not what it delivered. The
 * two differ by the slippage allowance on every trade.
 */
export interface AcquiredReader {
  measure(buyObservationId: string): bigint | null;
}

export interface EntryAdmission {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly buy: ExecutionObservation | null;
  readonly sell: ExecutionObservation | null;
  readonly tokensAcquired: bigint | null;
  /**
   * What a buy-then-immediately-sell would lose, in bps of the amount put in.
   *
   * Positive is a loss. This is the number that decides whether an edge has to
   * clear 200 bps or 1,400, and until it is measured on the exact size, on the
   * exact family, against a sell that was actually built, it is not known.
   */
  readonly roundTripLossBps: number | null;
}

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * P9 — a buy without a verified same-family sell is not a portfolio entry.
 *
 * The order is the design: observe the buy, verify its effect, take the EXACT
 * amount it would acquire, observe the same-family sell of that exact amount,
 * verify ITS effect, and only then compute round-trip economics and rerun the
 * gates. A position opened on a buy alone is a position whose exit has never
 * been shown to exist, and this repository has already booked capital into one.
 */
export async function admitPortfolioEntry(
  deps: {
    observer: RouteObserver;
    simulator: LegSimulator;
    /** P8 — measured credit and measured round trip, read by the caller. */
    acquired: AcquiredReader;
    roundTrip: RoundTripReader;
  },
  input: {
    mint: string;
    lamportsIn: bigint;
    economics: EntryEconomics;
  },
): Promise<EntryAdmission> {
  const reasons: string[] = [];

  const buy = await deps.observer.observe({
    side: 'buy',
    inputMint: WSOL,
    outputMint: input.mint,
    amount: input.lamportsIn,
    purpose: 'entry',
  });
  if (buy === null) {
    return { ok: false, reasons: ['the entry route could not be observed'], buy: null, sell: null, tokensAcquired: null, roundTripLossBps: null };
  }

  const buyVerdict = await deps.simulator.simulate(buy.observationId, {
    side: 'buy',
    inputMint: WSOL,
    outputMint: input.mint,
    inputAmount: input.lamportsIn,
    expectedOutput: buy.expectedOutput,
    minimumOutput: buy.minimumOutput,
  });

  const buyExecutable = legIsExecutable(
    { ...buy, simulation: buyVerdict.simulation, simulationEffect: buyVerdict.effect },
    { requireLocalSimulation: input.economics.requireLocalSimulation },
  );
  if (!buyExecutable.ok) reasons.push(...buyExecutable.reasons.map((r) => `buy: ${r}`));

  /**
   * THE measured credit. Not the router's floor.
   *
   * Refuses rather than falling back: an entry booked on an estimate records a
   * position the simulator never verified, which is the exact divergence this
   * whole repair exists to close.
   */
  const tokensAcquired = deps.acquired.measure(buy.observationId);
  if (tokensAcquired === null) {
    reasons.push('buy: no measured token credit; refusing to enter on an estimate');
    return { ok: false, reasons, buy, sell: null, tokensAcquired: null, roundTripLossBps: null };
  }
  if (tokensAcquired <= 0n) {
    reasons.push('buy: acquires no tokens');
    return { ok: false, reasons, buy, sell: null, tokensAcquired: null, roundTripLossBps: null };
  }

  // The exit half, at the EXACT amount the buy would leave us holding. A sell
  // observed at a round number is a price for a trade we are not going to make.
  const sell = await deps.observer.observe({
    side: 'sell',
    inputMint: input.mint,
    outputMint: WSOL,
    amount: tokensAcquired,
    purpose: 'entry_roundtrip',
  });
  if (sell === null) {
    reasons.push('sell: the exit route could not be observed, so this entry has no demonstrated exit');
    return { ok: false, reasons, buy, sell: null, tokensAcquired, roundTripLossBps: null };
  }

  if (sell.family !== buy.family) {
    // A buy on one family and a sell on another measure two different markets
    // and their difference is not a round trip.
    reasons.push(`sell: family ${sell.family} does not match the entry family ${buy.family}`);
  }

  const sellVerdict = await deps.simulator.simulate(sell.observationId, {
    side: 'sell',
    inputMint: input.mint,
    outputMint: WSOL,
    inputAmount: tokensAcquired,
    expectedOutput: sell.expectedOutput,
    minimumOutput: sell.minimumOutput,
  });
  const sellExecutable = legIsExecutable(
    { ...sell, simulation: sellVerdict.simulation, simulationEffect: sellVerdict.effect },
    { requireLocalSimulation: input.economics.requireLocalSimulation },
  );
  if (!sellExecutable.ok) reasons.push(...sellExecutable.reasons.map((r) => `sell: ${r}`));

  /**
   * P6 — the round trip from two MEASURED settlements, and it REFUSES.
   *
   * This was computed from `sell.expectedOutput` — a router quote — and
   * returned for the caller to log. The gate existed, the measurement existed,
   * and nothing connected them, so a position whose immediate round trip lost
   * more than the cap opened anyway.
   */
  const measured = deps.roundTrip.measure(buy.observationId, sell.observationId);
  if (measured === null) {
    reasons.push('the round trip was never measured; both legs need an effect-verified settlement');
    return { ok: false, reasons, buy, sell, tokensAcquired, roundTripLossBps: null };
  }
  if (!measured.complete) {
    reasons.push(...measured.reasons.map((r) => `round trip: ${r}`));
    return { ok: false, reasons, buy, sell, tokensAcquired, roundTripLossBps: null };
  }

  // The TRADING loss. Rent is capital the account holds and returns on close;
  // charging it against the edge refuses trades for a cost the market never
  // made. Measured live: 3,688 bps all-in against 363 bps of trading cost.
  const roundTripLossBps = measured.tradingLossBps;
  if (roundTripLossBps > input.economics.maxRoundTripLossBps) {
    reasons.push(
      `mechanics: the measured round trip loses ${roundTripLossBps} bps against a ` +
        `${input.economics.maxRoundTripLossBps} bps cap`,
    );
  }

  return { ok: reasons.length === 0, reasons, buy, sell, tokensAcquired, roundTripLossBps };
}

export interface MarkInputs {
  /** Executable value from an exact full-balance same-family sell. */
  readonly executableLamports: bigint | null;
  /** The `/order` router quote. A benchmark. Never decision-bearing. */
  readonly benchmarkLamports: bigint | null;
  readonly priorityFeeLamports: bigint;
}

export interface MarkDecision {
  readonly source: 'BUILD_CUSTOM_SELL' | 'ORDER_QUOTE_BENCHMARK';
  readonly decisionBearing: boolean;
  /** Null when nothing executable priced it. Null holds; it never stops out. */
  readonly markLamports: bigint | null;
  readonly benchmarkMinusExecutableBps: number | null;
}

/**
 * P9 — which number may move a stop.
 *
 * Pure, and separated from the I/O around it precisely so a test can state the
 * old defect directly: given a benchmark and no executable value, the old code
 * marked at the benchmark and this returns nothing decision-bearing.
 */
export function chooseDecisionMark(m: MarkInputs): MarkDecision {
  const gap =
    m.benchmarkLamports === null || m.executableLamports === null || m.executableLamports <= 0n
      ? null
      : Number(((m.benchmarkLamports - m.executableLamports) * 10_000n) / m.executableLamports);

  if (m.executableLamports === null || m.executableLamports <= 0n) {
    // The benchmark is still recorded — a mark that is not written is an
    // observation that never existed — and it drives nothing.
    return {
      source: 'ORDER_QUOTE_BENCHMARK',
      decisionBearing: false,
      markLamports: null,
      benchmarkMinusExecutableBps: gap,
    };
  }
  return {
    source: 'BUILD_CUSTOM_SELL',
    decisionBearing: true,
    markLamports: m.executableLamports - m.priorityFeeLamports,
    benchmarkMinusExecutableBps: gap,
  };
}

export interface ExitAdmission {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  /** What the caller must do when the exit cannot execute. */
  readonly blocked: boolean;
}

/**
 * P9 — an exit is simulated BEFORE it is asked whether it is executable.
 *
 * The previous code tested the exit observation for simulation without ever
 * having simulated it, so the clause could only read `NOT_SIMULATED` and the
 * only question was whether the config happened to require it.
 *
 * When the exit cannot execute the position stays managed: tokens are still
 * held, rent is still locked, exposure is still ours, and retries continue.
 * Releasing capital here is booking a wallet path that does not exist.
 */
export async function admitPortfolioExit(
  deps: { simulator: LegSimulator },
  input: {
    exit: ExecutionObservation;
    mint: string;
    tokenAmount: bigint;
    requireLocalSimulation: boolean;
  },
): Promise<ExitAdmission> {
  const verdict = await deps.simulator.simulate(input.exit.observationId, {
    side: 'sell',
    inputMint: input.mint,
    outputMint: WSOL,
    inputAmount: input.tokenAmount,
    expectedOutput: input.exit.expectedOutput,
    minimumOutput: input.exit.minimumOutput,
  });
  const r = legIsExecutable(
    { ...input.exit, simulation: verdict.simulation, simulationEffect: verdict.effect },
    { requireLocalSimulation: input.requireLocalSimulation },
  );
  return { ok: r.ok, reasons: r.reasons, blocked: !r.ok };
}
