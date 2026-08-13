# Simulation window invalidation at 2617bb7

P1 of the profitability directive. Every simulation job produced before the P2
repair is **`INSTRUMENT_DEVELOPMENT`**. The rows are preserved and are not
deleted or relabelled. None of them is a route failure, a token outcome, or
evidence about any strategy.

No threshold, score weight or model may be fitted on this window.

## The split

Taken from the live corpus by `pnpm simulation:audit`:

| side | SIMULATED_OK | SIMULATION_FAILED | error |
|---|---|---|---|
| buy | 40 | 3 (7%) | `{"InstructionError":[5,{"Custom":6001}]}` |
| sell | **0** | **43 (100%)** | `{"InstructionError":[2,{"Custom":6025}]}` |

The committed status quoted 13/13; the engine had continued running, and the
proportions held exactly as the sample grew.

## Root cause

`simulateObservation()` built every request as:

```
requestedAmount = '0'
balanceMutations = [ { kind: 'sol', owner: taker, amount: fundingLamports } ]
```

SOL, always, whatever the transaction spent. `openShadowBooks()` submits a buy
and then its round-trip sell for every episode.

So a buy — which spends lamports — was funded correctly and executed. A sell —
which spends **tokens** — was handed a taker who had never been given any. The
associated token account existed with a zero balance, and the venue rejected the
transfer.

## Why this is a setup defect and not a market fact

The uniformity is the proof. Every one of the 43 sells failed with the **same
error at the same instruction index**, across different venues and different
mints and three orders of magnitude of position size:

```
sell  shadow_entry_roundtrip  ADhNZ9XaWs  amount=4370721661   Pump.fun Amm  [2, Custom 6025]
sell  shadow_entry_roundtrip  7EKoK1KK1Z  amount=14899115629  Pump.fun Amm  [2, Custom 6025]
sell  shadow_entry_roundtrip  F6rRey6eLU  amount=2348098368   Pump.fun Amm  [2, Custom 6025]
```

A market-driven failure varies with route, size and liquidity. The three genuine
buy failures do vary — `Custom 6001` on Pump.fun Amm and Meteora DLMM, a real
slippage rejection. The sells do not vary at all, because they never reached the
market: they failed on inventory.

## Classification

```
SELL_INPUT_NOT_PROVISIONED   43
ACTUAL_PROGRAM_REJECTION      3
```

Only the second category says anything about a token.

## What would have happened had this gone unnoticed

The sells were the *exit* half of every round trip. A corpus where 100% of exits
fail says either "no position can ever be closed" or, read the other way, "every
route is untradeable". Both readings are false, and either would have justified
killing the strategy or rebuilding a component that was working.

It also would have flowed straight into the readiness gate, which counted
`simulation='SIMULATED_OK'` without distinguishing a leg whose setup was valid.

## The repair

`SimulateOptions` now describes the economic leg: side, input mint, output mint,
exact input amount, and the input's token program. `validateSetup()` refuses,
**before any request is sent**, a sell with no token program, an input amount of
zero, a sell whose input is SOL, and a leg whose input and output are the same
asset. A sell is provisioned with exactly the hypothetical position balance —
not more, because funding more would let a sell succeed that the real balance
could not cover.

An invalid setup is recorded as a `critical` health event and produces **no
simulation job at all**. It is a caller defect, and running it would record a
runtime failure as though it were a simulation outcome.

## Status of the window

- rows preserved, marked `INSTRUMENT_DEVELOPMENT`
- 43 sell failures: **not** route failures, **not** token outcomes
- 3 buy failures: genuine program rejections, retained as such
- 40 buy successes: genuine runtime successes, but see `docs/SIMULATION_EFFECTS.md`
  — runtime success is not economic-effect success, and these were never
  effect-verified
- no threshold, weight or model may be fitted on any of it
