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

## What the repair experiment actually showed

`pnpm simulation:sell-proof` re-ran eight of the failed sells through the
repaired setup, against the same stored bytes.

```
now SIMULATED_OK   1
still failed       7
```

Two things follow, and only two.

**The provisioning works.** The runtime logs show the taker's associated token
account for the mint -- `5WwuMzak...`, derived independently and matched against
the address the transaction uses -- holding exactly `1653146653` atoms, the
exact sell amount. The account the transaction spends from is funded with the
amount it spends. That was the defect, and it is fixed.

**The uniformity is gone.** Forty-three identical failures became a mixture. A
mixture is what a market produces; an identical error at an identical
instruction index across every venue, mint and size is what an apparatus
produces. The original window is invalid on that ground alone, independent of
what the replays now do.

## What it did NOT show

The seven that still fail cannot be attributed. They are stale transactions --
built days earlier, replayed just-in-time against today's chain -- and
`context_slot` is NULL on these rows, so there is no point in time for the
replay to stand at. Jupiter rejects them after 1,160 compute units, before any
AMM is invoked, which is consistent with a route whose pool has since moved and
inconsistent with a slippage outcome.

That is a **different** confound, and it does not restore the original
conclusion. It means this experiment is the wrong instrument for the residual
question, not that the residual question has been answered.

The decisive test is a sell built now and simulated now, which is what the
restarted engine produces. Until that window exists, the honest statement is:

- the setup defect was real, is understood, and is repaired;
- the 108 pre-repair jobs remain `INSTRUMENT_DEVELOPMENT` and are not evidence;
- whether these specific routes were sellable at the time they were observed is
  **not established and is not going to be**, because the state they were
  observed in no longer exists.
