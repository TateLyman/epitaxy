import { SequentialWorker, assertQuoteStateSurvived, type ObserveResult } from '../../simulator/src/sequential-worker.js';
import type { FrozenRuntimeSnapshot, SequentialStepResult } from '../../simulator/src/sequential-runtime.js';
import { accountSourceOf, overlaySource, buildSellFrom, quoteSellFrom } from '../../solana/src/pumpswap-offline.js';
import type { AccountBytesSource } from '../../solana/src/pumpswap-offline.js';

/**
 * P3 — the one-pass round trip.
 *
 * This is the function the two-pass proof should have been. The old shape was:
 *
 * ```
 * pass 1: runtime A ← buy                       (to learn what the buy produced)
 *         build the sell from A's post-state
 * pass 2: runtime B ← buy, sell, close          (a FRESH runtime)
 * ```
 *
 * The sell was priced against runtime A's state and executed against runtime
 * B's. Those *should* be identical — same snapshot, same buy — but nothing
 * checked, and "should be identical" is the phrase that precedes most silent
 * measurement errors. The design could not even express the check: comparing an
 * account across two runtimes proves they agreed on a replay, not that a quote
 * and an execution saw one state.
 *
 * The shape here:
 *
 * ```
 * init → step(buy) → observe(price-bearing accounts)
 *      → build the sell FROM THOSE BYTES
 *      → step(sell)   ← same runtime, same committed state, hashes compared
 *      → step(close)
 * ```
 *
 * `observe` is the load-bearing call. It reads the runtime WITHOUT executing
 * anything, so the bytes the sell is built from are the bytes that exist at that
 * instant in the runtime the sell will execute in.
 */

export interface RoundTripRequest {
  readonly snapshot: FrozenRuntimeSnapshot;
  readonly pool: string;
  readonly taker: string;
  readonly takerAta: string;
  readonly slippagePct: number;
  readonly buyTransactionBase64: string;
  readonly blockhash: string;
  /** Accounts whose bytes determine the sell price. These are what get hashed. */
  readonly priceBearingAccounts: readonly string[];
  /** Everything to observe on each step. A superset of the above. */
  readonly observe: readonly string[];
  /** Builds the close once the acquired amount is known. */
  readonly buildCloseBase64: (acquiredAtoms: bigint) => string;
  /**
   * Builds the sell FROM the observed post-buy state.
   *
   * Injected rather than called directly, and the separation is the point: this
   * module owns the ORDER of operations, and the caller owns pricing. Calling
   * the pool decoder in here made the ordering — the thing the two-pass design
   * got wrong — untestable without a live pool, which is precisely the code
   * least able to afford being hard to test.
   */
  readonly buildSell: (state: AccountBytesSource, acquiredAtoms: bigint) => Promise<{
    transactionBase64: string;
    /** The buy's own effect on the price the sell got, when measurable. */
    selfImpactLamports: bigint | null;
  }>;
  readonly jobId: string;
}

export type RoundTripFailure =
  | 'BUY_FAILED'
  | 'NO_MEASURED_CREDIT'
  | 'BUY_DID_NOT_MOVE_THE_SELL_POOL'
  | 'SELL_BUILD_FAILED'
  | 'SELL_FAILED'
  | 'QUOTE_STATE_MOVED'
  | 'CLOSE_FAILED'
  | 'RUNTIME_UNAVAILABLE';

export interface RoundTripResult {
  readonly ok: boolean;
  readonly failure: RoundTripFailure | null;
  readonly detail: string | null;

  readonly buy: SequentialStepResult | null;
  readonly sell: SequentialStepResult | null;
  readonly close: SequentialStepResult | null;

  readonly acquiredAtoms: bigint | null;
  /** The state the sell was priced from, and its hash. */
  readonly quoted: ObserveResult | null;
  /** Proven, not assumed: the quote state was the execution state. */
  readonly quoteStateSurvived: boolean;
  /** The buy's own effect on the price the sell got. */
  readonly selfImpactLamports: bigint | null;
  readonly runtimeIdentity: unknown;
  readonly incompleteness: readonly string[];
}

function fail(f: RoundTripFailure, detail: string, partial: Partial<RoundTripResult> = {}): RoundTripResult {
  return {
    ok: false,
    failure: f,
    detail,
    buy: null,
    sell: null,
    close: null,
    acquiredAtoms: null,
    quoted: null,
    quoteStateSurvived: false,
    selfImpactLamports: null,
    runtimeIdentity: null,
    incompleteness: [],
    ...partial,
  };
}

const tokenAmount = (a: { dataBase64: string } | undefined): bigint | null => {
  if (a === undefined) return null;
  const b = Buffer.from(a.dataBase64, 'base64');
  // SPL token account: amount is a u64 at offset 64.
  if (b.length < 72) return null;
  return b.readBigUInt64LE(64);
};

/**
 * The standard PumpSwap sell builder.
 *
 * Provided here so injecting `buildSell` does not push pool decoding onto every
 * caller — the seam exists for testability and for alternative venues, not to
 * make the common case harder.
 *
 * `selfImpactLamports` is the buy's own effect on the price the sell gets:
 * quote the same size against the pre-buy and post-buy states and subtract. That
 * number is the reason a future mainnet state cannot stand in for a
 * counterfactual exit without a haircut.
 */
export function standardPumpSwapSell(p: {
  preState: AccountBytesSource;
  pool: string;
  taker: string;
  slippagePct: number;
  blockhash: string;
  encode: (instructions: unknown[], blockhash: string) => string;
}) {
  return async (
    postState: AccountBytesSource,
    acquiredAtoms: bigint,
  ): Promise<{ transactionBase64: string; selfImpactLamports: bigint | null }> => {
    let selfImpactLamports: bigint | null = null;
    try {
      const qPre = quoteSellFrom(p.preState, p.pool, acquiredAtoms, p.slippagePct);
      const qPost = quoteSellFrom(postState, p.pool, acquiredAtoms, p.slippagePct);
      selfImpactLamports = qPre.quoteOutLamports - qPost.quoteOutLamports;
    } catch {
      // An unmeasurable self-impact is null, never zero. Zero would claim the
      // entry had no effect on its own exit price, which is the assumption this
      // whole module exists to stop being made silently.
      selfImpactLamports = null;
    }
    const built = await buildSellFrom(postState, {
      poolKey: p.pool,
      user: p.taker,
      baseAtoms: acquiredAtoms,
      slippagePct: p.slippagePct,
    });
    return { transactionBase64: p.encode(built.instructions as unknown[], p.blockhash), selfImpactLamports };
  };
}

export async function sequentialRoundTrip(req: RoundTripRequest, worker?: SequentialWorker): Promise<RoundTripResult> {
  const w = worker ?? new SequentialWorker({ commandTimeoutMs: 240_000 });
  const ownsWorker = worker === undefined;

  try {
    const identity = await w.init(req.snapshot, { jobId: req.jobId });
    const incompleteness = [...w.initIncompleteness];

    // ---- the buy, committed -------------------------------------------
    const buy = await w.step({ label: 'buy', transactionBase64: req.buyTransactionBase64, observe: [...req.observe] });
    if (buy.step.status !== 'SIMULATED_OK') {
      return fail('BUY_FAILED', buy.step.transactionError ?? 'the buy did not commit', {
        buy: buy.step,
        runtimeIdentity: identity,
        incompleteness,
      });
    }

    const acquired = tokenAmount(buy.step.postAccounts.find((a) => a.pubkey === req.takerAta));
    if (acquired === null || acquired <= 0n) {
      return fail('NO_MEASURED_CREDIT', 'the buy committed but credited no tokens', {
        buy: buy.step,
        runtimeIdentity: identity,
        incompleteness,
      });
    }

    // ---- the state the sell will be priced from, read WITHOUT executing --
    //
    // This is what the two-pass design could not do. These are the bytes in the
    // runtime the sell is about to execute in, at this instant.
    const quoted = await w.observe(req.priceBearingAccounts);

    // A route that landed on some other venue leaves the canonical pool
    // untouched, and a "stateful" claim over an untouched pool is vacuous.
    const preSrc: AccountBytesSource = accountSourceOf(req.snapshot.accounts as never);
    const postSrc = overlaySource(
      preSrc,
      accountSourceOf(
        quoted.accounts.map((a) => ({
          pubkey: a.pubkey,
          owner: a.owner,
          dataBase64: a.dataBase64,
          lamports: BigInt(a.lamports),
        })) as never,
      ),
    );

    let selfImpactLamports: bigint | null = null;
    let sellBytes: string;
    try {
      const built = await req.buildSell(postSrc, acquired);
      sellBytes = built.transactionBase64;
      selfImpactLamports = built.selfImpactLamports;
    } catch (e) {
      return fail('SELL_BUILD_FAILED', (e as Error).message.slice(0, 200), {
        buy: buy.step,
        acquiredAtoms: acquired,
        quoted,
        runtimeIdentity: identity,
        incompleteness,
      });
    }

    // ---- the sell, in the SAME runtime ---------------------------------
    const sell = await w.step({ label: 'sell', transactionBase64: sellBytes, observe: [...req.observe] });

    // THE ASSERTION, before anything is believed about the price.
    let quoteStateSurvived = true;
    let quoteDetail: string | null = null;
    try {
      assertQuoteStateSurvived(quoted, sell.step);
    } catch (e) {
      quoteStateSurvived = false;
      quoteDetail = (e as Error).message;
    }
    if (!quoteStateSurvived) {
      return fail('QUOTE_STATE_MOVED', quoteDetail ?? 'the quote state moved', {
        buy: buy.step,
        sell: sell.step,
        acquiredAtoms: acquired,
        quoted,
        selfImpactLamports,
        runtimeIdentity: identity,
        incompleteness,
      });
    }

    if (sell.step.status !== 'SIMULATED_OK') {
      return fail('SELL_FAILED', sell.step.transactionError ?? 'the sell did not commit', {
        buy: buy.step,
        sell: sell.step,
        acquiredAtoms: acquired,
        quoted,
        quoteStateSurvived: true,
        selfImpactLamports,
        runtimeIdentity: identity,
        incompleteness,
      });
    }

    // ---- the close, which is not optional accounting --------------------
    const close = await w.step({
      label: 'close',
      transactionBase64: req.buildCloseBase64(acquired),
      observe: [...req.observe],
    });

    return {
      ok: close.step.status === 'SIMULATED_OK',
      failure: close.step.status === 'SIMULATED_OK' ? null : 'CLOSE_FAILED',
      detail: close.step.transactionError,
      buy: buy.step,
      sell: sell.step,
      close: close.step,
      acquiredAtoms: acquired,
      quoted,
      quoteStateSurvived: true,
      selfImpactLamports,
      runtimeIdentity: identity,
      incompleteness,
    };
  } catch (e) {
    // An apparatus failure and a market refusal are different facts, and only
    // the second is evidence.
    return fail('RUNTIME_UNAVAILABLE', (e as Error).message.slice(0, 200));
  } finally {
    if (ownsWorker) await w.close();
  }
}
