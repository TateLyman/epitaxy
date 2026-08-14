# The round-trip cost, and what it actually is

`scripts/live-one-pass-trajectory.ts` → `artifacts/live-one-pass-trajectory.json`
`scripts/size-cost-surface.ts` → `artifacts/size-cost-surface.json`
`pnpm trajectory:one-pass` · `pnpm size:surface`

## The headline

**The round-trip drag on a freshly migrated PumpSwap token is a FIXED cost of
roughly 10,100,000 lamports (~0.0101 SOL), not price impact and not a
proportional fee.**

It is dominated by **account setup rent** — five rent-exempt minimums of
2,039,280 lamports each, for accounts the first trade on a new token has to
open (coin-creator fee vault, volume accumulators, associated token accounts).

This matters because the naive reading is exactly backwards.

## How it was established

P14's size sweep: five notionals against **one shared snapshot per token**, the
buy built offline by the official PumpSwap builder so no network read is spent
per size. Eight tokens.

```
size (lamports)    n   drag p50 (bps)   drag p50 (lamports)
    2,500,000      8         40,313          10,078,250
    5,000,000      8         20,279          10,139,978
   10,000,000      8         10,263          10,263,436
```

```
spread of median drag across sizes, in LAMPORTS  0.018   ← essentially constant
spread of median drag across sizes, in BPS       2.928   ← varies 293%
```

A 4× change in size moves the lamport cost by **1.8%** and the rate by **293%**.
The bps figure halves every time the size doubles. That is the signature of a
fixed cost, and it is not compatible with price impact.

The arithmetic closes: `10,078,250 = 5 × 2,039,280 − 118,150`. Five rent-exempt
minimums.

## Why the first reading was wrong

The initial 20-token run at a single 0.02 SOL notional measured losses on 20 of
20 and a median drag of −12.7%. Publishing that as a "mechanics floor" would
have been wrong in the most consequential way available: **it would have
implied the cost scales with size, when it does not.**

The tell was there and was acted on. The losses clustered on repeated *exact*
lamport values across *different* tokens (−21.67% eight times), and the same
token gave different values on different runs. Price impact into twenty
different pools cannot do that.

## The measurement bug this exposed, in my own instrument

`createdAccountRentAcross` reported **zero created accounts** for every trip,
which is what made the rent hypothesis look refuted.

It was not wrong — it was blind. It decides an account was created by comparing
its pre and post state, and the coin-creator vault and volume accumulators were
in the *snapshot* but not in the per-step `observe` list. **An account nobody
observed is not an account that cost nothing**, but it reports identically to
one.

The drag was visibly moving in exact multiples of 2,039,280 while the rent
column read 0. Two instruments disagreeing is the signal; the one reporting a
clean zero was the one that was broken.

## What this means for the strategy

**Size dominates.** The fixed cost is ~0.0101 SOL per new token:

| notional | fixed-cost drag alone |
|---|---|
| 0.0025 SOL | ~403% |
| 0.005 SOL | ~203% |
| 0.01 SOL | ~103% |
| 0.02 SOL | ~50% |
| 0.1 SOL | ~10% |
| 1 SOL | ~1% |

At the research notionals used so far, the setup cost *is* the result. A
strategy cannot be evaluated at 0.0025 SOL — the answer there is arithmetic
about rent, not about the market.

**It is a first-trade cost, not a per-trade cost.** Those accounts persist. A
second trade on the same token pays the venue fee and impact but not the setup
again, so repeat drag and first-mint drag are different regimes and must not be
pooled. The surface stratifies on this.

**The proportional floor is still 250 bps.** The bottom canonical tier round
trip (LP 2 + protocol 93 + creator 30, doubled) is what remains once setup is
amortised, and the single cleanest observation in the 20-token run — −2.54% —
is exactly that.

## What is still NOT established

- **The 20 and 40 million lamport sizes did not complete** in the final sweep,
  so the constancy is demonstrated over a 4× range, not the full 16×.
- **Eight tokens.** Above apparatus sanity (10 rows per size, 8 tokens), below
  costs/fillability (25).
- **No holding period was evaluated.** Every number here is an immediate round
  trip; the strategy holds a frozen 15 minutes.
- **Nothing was signed, submitted or funded on chain.** Wallet balances are
  local runtime mutations.
- **Evidence grade `SIMULATED_EXECUTION`** — exact sequential mechanics, no
  future state involved.

## The 20-token single-size run

Retained because the completion and coherence results stand independently:

```
complete round trips              20 of 20
quoteStateSurvived                20 of 20   (per account, by content hash)
buy actually moved the sell pool  20 of 20
wrapped SOL / residual stranded    0 of 20
```

Its *drag* numbers should be read through the size surface above, not as a
proportional cost.
