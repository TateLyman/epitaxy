import { SequentialWorker, assertQuoteStateSurvived, type ObserveResult } from '../../simulator/src/sequential-worker.js';
import type { FrozenRuntimeSnapshot, SequentialStepResult } from '../../simulator/src/sequential-runtime.js';
import { observedBytes } from '../../simulator/src/sequential-runtime.js';
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
  /**
   * F8 — which observed accounts the run needs the BYTES of.
   *
   * The price-bearing set, essentially: the sell is BUILT from those bytes, so
   * they must come back in full. Everything else is observed for its balance,
   * its owner and whether it was created, none of which needs a payload.
   *
   * Omitting this returns every payload, which is what emitted ~280 MB on a
   * size surface and killed the worker.
   */
  readonly economicAccounts?: readonly string[];
  /**
   * Builds a SEPARATE close transaction once the acquired amount is known.
   *
   * P6 — optional, and normally omitted. A separate close costs another
   * signature and another landing interval to recover rent the sell could have
   * recovered for free, and it is one more thing that can fail after the
   * position is already flat. `standardPumpSwapSell({ appendInstructions })`
   * puts the close inside the sell instead; this field remains for the venues
   * and token programs where appending is not valid.
   */
  readonly buildCloseBase64?: (acquiredAtoms: bigint) => string;
  /**
   * The base token account the close is supposed to remove.
   *
   * Named so the trip can CHECK that it is gone after the sell rather than
   * trusting that an appended instruction did what it was appended to do.
   */
  readonly takerBaseAtaToClose?: string;
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
  | 'QUOTE_STATE_UNOBSERVED'
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
  /**
   * P6 — the base ATA was gone after the sell, so its rent came back inside the
   * exit rather than costing a third signature.
   *
   * Measured from the sell's own post-state, not inferred from having appended
   * an instruction. `null` when there was no ATA named to check.
   */
  readonly baseAtaClosedInSell: boolean | null;
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
    baseAtaClosedInSell: null,
    runtimeIdentity: null,
    incompleteness: [],
    ...partial,
  };
}

const tokenAmount = (a: { pubkey: string; dataBase64: string | null } | undefined): bigint | null => {
  if (a === undefined) return null;
  const b = observedBytes(a);
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
  /**
   * P6 — instructions appended AFTER the sell, in the same transaction.
   *
   * The base token account close goes here. Recovering ~2,039,280 lamports of
   * rent is worth a 5,000 lamport signature, so a separate close is not wrong
   * economically — it is wrong operationally: a second transaction has its own
   * landing interval and its own way to fail once the position is already flat,
   * and on a busy pool the interval is the expensive part.
   *
   * Appended rather than prepended, because the account has to be empty first.
   */
  appendInstructions?: (acquiredAtoms: bigint) => readonly unknown[];
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
    const appended = p.appendInstructions === undefined ? [] : [...p.appendInstructions(acquiredAtoms)];
    return {
      transactionBase64: p.encode([...(built.instructions as unknown[]), ...appended], p.blockhash),
      selfImpactLamports,
    };
  };
}

export async function sequentialRoundTrip(req: RoundTripRequest, worker?: SequentialWorker): Promise<RoundTripResult> {
  const w = worker ?? new SequentialWorker({ commandTimeoutMs: 240_000 });
  const ownsWorker = worker === undefined;

  try {
    const identity = await w.init(req.snapshot, { jobId: req.jobId });
    const incompleteness = [...w.initIncompleteness];

    // ---- the buy, committed -------------------------------------------
    // The bytes the sell will be built from must come back; the rest need
    // only their balances. `priceBearingAccounts` is the floor, because
    // `buildSell` decodes exactly those.
    const economic = req.economicAccounts ?? req.priceBearingAccounts;
    const buy = await w.step(
      { label: 'buy', transactionBase64: req.buyTransactionBase64, observe: [...req.observe] },
      economic,
    );
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
    const quoted = await w.observe(req.priceBearingAccounts, economic);

    /**
     * F1 — THE GUARD THE ASSERTION ALWAYS RELIED ON, AND NOBODY PERFORMED.
     *
     * `assertQuoteStateSurvived` iterates the quoted accounts. When that list is
     * EMPTY it iterates nothing and throws nothing, so an empty observation
     * reported `quoteStateSurvived: true`. Worse, `overlaySource` over an empty
     * source degrades silently to the PRE-BUY snapshot, so the sell was then
     * priced from a state that never contained the entry — the exact defect P3
     * exists to remove, certified as proof it was removed.
     *
     * The vacuity was documented at the assertion. Documenting it there was not
     * enough: the only production caller never performed the guard the comment
     * assumed. An invariant that depends on every caller remembering is not an
     * invariant.
     *
     * A price-bearing account that could not be observed is an APPARATUS
     * failure, and recording one as a market fact is the substitution this
     * whole module exists to prevent.
     */
    const quotedKeys = new Set(quoted.accounts.map((a) => a.pubkey));
    const unquoted = req.priceBearingAccounts.filter((a) => !quotedKeys.has(a));
    if (quoted.accounts.length === 0 || unquoted.length > 0) {
      return fail(
        'QUOTE_STATE_UNOBSERVED',
        quoted.accounts.length === 0
          ? 'the observation returned no accounts, so the sell would have been priced from the pre-buy snapshot'
          : `${unquoted.length} price-bearing account(s) were not observed: ${unquoted.slice(0, 3).join(', ')}`,
        {
          buy: buy.step,
          acquiredAtoms: acquired,
          quoted,
          runtimeIdentity: identity,
          incompleteness: [...incompleteness, ...quoted.unobserved.map((u) => `unobserved at quote time: ${u}`)],
        },
      );
    }

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
    const sell = await w.step(
      { label: 'sell', transactionBase64: sellBytes, observe: [...req.observe] },
      economic,
    );

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

    /**
     * P6 — was the base token account actually closed?
     *
     * Read from the SELL's own post-state, because "we appended a close
     * instruction" and "the account is gone" are different claims and only the
     * second is evidence. An account at zero lamports with no data has been
     * closed; one still holding its rent exemption has not, whatever the
     * transaction contained.
     */
    let baseAtaClosedInSell: boolean | null = null;
    if (req.takerBaseAtaToClose !== undefined) {
      const after = sell.step.postAccounts.find((a) => a.pubkey === req.takerBaseAtaToClose);
      baseAtaClosedInSell = after === undefined || after.lamports === 0n;
    }

    // ---- the close, when it was NOT appended to the sell ------------------
    const close =
      req.buildCloseBase64 === undefined
        ? null
        : await w.step({
            label: 'close',
            transactionBase64: req.buildCloseBase64(acquired),
            observe: [...req.observe],
          });

    /**
     * F2 — per-step `unobserved` reaches the result.
     *
     * `incompleteness` used to carry only `initIncompleteness`, so a trip whose
     * sell step reported an unobserved writable was INDISTINGUISHABLE from one
     * that observed everything. "Every required writable is observed" was a
     * claim nothing checked.
     *
     * An unobserved writable does not fail the trip on its own — it may be an
     * account the leg legitimately never touched — but it is never silently
     * dropped, because a replay cannot restore state nobody recorded.
     */
    const stepUnobserved = [
      ...buy.step.unobserved.map((u) => `unobserved on buy: ${u}`),
      ...sell.step.unobserved.map((u) => `unobserved on sell: ${u}`),
      ...(close?.step.unobserved ?? []).map((u) => `unobserved on close: ${u}`),
    ];

    // With the close appended, the sell IS the last step and its success is the
    // trip's. A separate close still has to land: rent nobody recovered is rent
    // spent, and calling it recovered because an instruction existed is the
    // substitution this file exists to prevent.
    const closeOk = close === null ? true : close.step.status === 'SIMULATED_OK';

    return {
      ok: closeOk,
      failure: closeOk ? null : 'CLOSE_FAILED',
      detail: close?.step.transactionError ?? null,
      buy: buy.step,
      sell: sell.step,
      close: close?.step ?? null,
      acquiredAtoms: acquired,
      quoted,
      quoteStateSurvived: true,
      selfImpactLamports,
      baseAtaClosedInSell,
      runtimeIdentity: identity,
      incompleteness: [
        ...incompleteness,
        ...stepUnobserved,
        // A close that was appended and did not take effect is not a detail.
        // The rent it was supposed to recover is still locked, and the
        // settlement has to know that rather than assume the float came back.
        ...(baseAtaClosedInSell === false
          ? [`the base token account ${req.takerBaseAtaToClose} survived the sell, so its rent was not recovered`]
          : []),
      ],
    };
  } catch (e) {
    // An apparatus failure and a market refusal are different facts, and only
    // the second is evidence.
    return fail('RUNTIME_UNAVAILABLE', (e as Error).message.slice(0, 200));
  } finally {
    if (ownsWorker) await w.close();
  }
}
