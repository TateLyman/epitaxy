# FEE_CASHBACK_STRATA_V1

Module: `packages/strategy/src/fee-strata.ts`

## The mechanics hypothesis

The current Pump canonical SOL fee schedule is economically unusual:

```text
0–420 SOL      creator 30 bps + protocol 93 bps + LP  2 bps  = 125 bps per leg
>= 420 SOL     protocol 5 bps + LP 20 bps, creator varies by tier
```

Cashback redirects the **creator** component back to the user — but only when the
required current remaining accounts are present **and** the cashback actually
accrues. So, when fully measured and claimable:

```text
bottom tier with cashback     ~95 bps per leg    ~190 bps round trip
>= 420 SOL with cashback      ~25 bps per leg     ~50 bps round trip
```

A round trip costing 50 bps instead of 190 is not a detail. It is most of the edge
a memecoin strategy could plausibly have, and if the gap is real the strategy's job
may be mostly to find the cell where it applies.

**This is a hypothesis read off a published fee schedule. It is not an Epitaxy
profitability result**, and `pnpm fee-strata:status` will not report it as one.

## Strata, not collectors

One trajectory receives immutable labels. There are **not** sixteen collectors.

```text
fee tier         BOTTOM_TIER | HIGHER_TIER | UNKNOWN_TIER
cashback         CASHBACK | NONCASHBACK | UNKNOWN_CASHBACK
Mayhem           MAYHEM | NON_MAYHEM | UNKNOWN_MAYHEM
token program    LEGACY_TOKEN | TOKEN_2022 | UNKNOWN_TOKEN_PROGRAM
```

and the four required cells:

```text
BOTTOM_CASHBACK   BOTTOM_NONCASHBACK   HIGHER_TIER_CASHBACK   HIGHER_TIER_NONCASHBACK
```

### Why a tier is UNKNOWN without a fee config

Even when the market cap is known. The 420-SOL boundary is a property of the
**schedule**, not of the token: a row labelled from a market cap alone would keep
its label across a schedule change and would then describe a tier that no longer
exists. `fee_config_hash` is what pins the label to the table it was read from.

## Cashback accounting: four numbers, kept apart

```text
accrued       what the accumulator moved
claimable     what the accumulator state says can be taken now
claimed       what was actually taken
claim cost    what taking it cost
```

Only the last three are money. The failure this prevents is one line long and very
easy to write:

```ts
if (pool.cashbackFlag) pnl += creatorFee;   // WRONG
```

That subtracts a fee nobody was refunded, on every row where the pool advertises
cashback and the remaining accounts were not present, and it improves every result
in the corpus by roughly 60 bps per leg.

`cashbackAdjustedPnl()` **throws** when a pool flag is present and no accumulator
state was read. A silent zero would be safe for the cash figure and would make the
economic figure a lie by omission — and the whole reason both figures exist is to
make the gap between them visible.

## Two PnL figures, always both

```text
cash PnL       excludes unclaimed cashback entirely  (the conservative contract)
economic PnL   includes only MEASURED CLAIMABLE cashback, less amortised claim cost
```

Capital readiness later uses the conservative one, frozen in advance.

## Account layouts

Both legs carry a cashback tail and they are **different**:

```text
buy    [accumulator WSOL ATA]                              then [pool v2]
sell   [accumulator WSOL ATA, UserVolumeAccumulator PDA]   then [pool v2]
```

The repository asserted for two commits that `sell` carried no accumulator, which
would have dropped the sell leg's cashback on every round trip. P19 test 19 pins
both layouts and asserts they differ.

## Command

```bash
pnpm fee-strata:status   # population size per cell
```
