# Window invalidation at 02483ca

Every context up to and including the production-equivalence repair is
**instrument/development-only**. The rows are preserved. No threshold, score
weight, exit rule, cohort selection or size is fitted to them.

## Why this window cannot be a strategy sample

Not because the results were bad. Because the instrument and the production
path were measuring different things, so the numbers do not describe one
system.

| | |
|---|---|
| proof and production request builders differed | the harness sent asset-aware bounds; production sent the generic `mint + minTokenDelta` form |
| production never named the asset it received | no caller passed `outputTokenProgram`, so a buy's credit had no account to bind to |
| proof cases were independent legs | ten fresh-SVM legs, not one wallet carrying a post-buy state into a sell |
| explicit PnL fields were not written | migration 22 added the columns; no writer populated them |
| production entry did not call `admitPortfolioEntry` | the core's admission logic had no production caller |
| trigger-to-later-fill lifecycle was not running | the trigger mark was its own fill |
| four cohort queues were not running | only the configured 2–60m window matured |
| offline Pump replay was not established | `surfnet_writeProgram` drops its RPC on the 10.5 MB program |

## What the corpus at this head actually contains

```
30,912  execution observations
   136  simulation jobs
     0  effect-verified   (production)
     8  effect-verified   (proof harness only, of 10 legs)
     0  stateful round trips
     0  valid completed development positions
     0  confirmatory positions
```

## The three measurement defects found by running it

Each was found by deriving a settlement from live rows, not by reading code.

1. **`unexplained` read the wrong column.** `unexpected_movement_lamports`
   counts value reaching accounts the request did not name — on any AMM swap,
   the pool vaults and the token account just created. It measured 24,078,560
   lamports on a leg whose true residual was **0**. Used as a residual it
   condemns exactly the legs that worked.

2. **The exit's own costs were dropped.** `exitCashIn` was
   `realized + rentRecovered`: gross credit, with the sell's signature fee,
   priority fee and rent missing. 19,288,556 reported against 15,202,728
   actually received.

3. **Rent was charged against the edge.** All-in, the first measured round trip
   loses 3688 bps. The market charged **363**. The remainder is 8,157,120
   lamports of account rent, which does not scale with the edge and returns
   when the account closes.

Any threshold fitted to numbers produced under (1), (2) or (3) would be fitted
to the instrument.

## The one number this window did establish

Measured on the first effect-verified production round trip, mint
`6e5KR79A5L`, 0.02 SOL, 300 bps slippage allowance:

```
acquired (measured credit)   16,227,715,590 atoms
router floor (netMinimum)    15,741,505,674 atoms
difference                      486,209,916 atoms
```

Production booked the second. That is the defect this directive names, and it
is not an estimate — it is the gap between the trade that was verified and the
trade that was recorded, on every entry.

## Rule for what follows

A new valid-development context does not start until the production path
builds the same request the proof harness does, produces stateful round trips,
and writes the explicit PnL fields. Until then every row written is
`INSTRUMENT_DEVELOPMENT`.
