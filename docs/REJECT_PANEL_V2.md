# The reject panel

`pnpm reject:panel` → `artifacts/reject-panel.json`

## Why counting rejections is not evaluating a gate

`reject:status` reports 505,074 rejections for `stale_source` and 302,894 for
`insufficient_liquidity`. That answers "what did we refuse". It cannot answer the
only question that decides whether a gate is any good:

```
which gate prevents catastrophe
which gate removes future winners
which gate merely removes missing data
```

A provider that stopped publishing a field is not a token that stopped being
tradeable. Counting those rejections as refusals of bad tokens gives the gate
credit for a provider outage.

## Method

A **stratified probability sample**, one stratum per rejection reason, drawn
without replacement from the *distinct mints* in each stratum — distinct because
one mint rejected two hundred times is one token, and sampling rows would make
the panel a study of cycle frequency rather than of tokens.

Every row carries the probability it had of being drawn, and the shares below
are inverse-probability weighted: the strata differ in size by three orders of
magnitude, so an unweighted count would describe the sample rather than the
population.

The draw is seeded (`20260813`) and the panel is versioned (`v1`). **A gate must
not be tuned on the panel version it is then evaluated on**, which is why the
version is stamped rather than implied.

Each sampled mint is then re-examined against the chain and the sequential
runtime — its mint account decoded, its canonical pool read, and a real buy at
the panel notional executed in the runtime — rather than against the provider
that dropped it.

## Result

68 mints, 24 strata.

```
NO_ROUTE_CONFIRMED       55
EXECUTABLE_VALUE          9
UNBUILDABLE               3
SIMULATION_UNAVAILABLE    1
```

| gate | reading |
|---|---|
| `excessive_impact` | **removes tokens the chain would have filled** |
| `insufficient_flow` | **removes tokens the chain would have filled** |
| `too_old` | mixed |
| `round_trip_too_expensive` | mixed |
| everything else (20 gates) | removes tokens with no canonical PumpSwap pool |

## What this says

**Twenty of twenty-four gates are refusing tokens the direct family could not
have traded anyway.** They are not protecting the book from anything; they are
removing tokens that have no pool. Their measured cost in foregone entries,
through this family, is approximately zero — and so is their measured benefit.

**`excessive_impact` and `insufficient_flow` are the two that bite.** Every
sampled reject under `excessive_impact` had a canonical pool and filled in the
runtime, one of them for 806 billion atoms at the panel notional. These are the
gates whose thresholds are worth arguing about, and the only ones where the
exploration arm has anything to measure.

## The caveat, stated rather than buried

`NO_ROUTE_CONFIRMED` here means **no canonical PumpSwap pool**. It is not a claim
that no venue exists. A token still on the bonding curve lands in this class and
a router might well reach it. What the panel establishes is that the direct
family this system is being built around could not have traded it — which is the
relevant question for these gates and is not the same question.

A second limitation: the panel executes a **buy** and reads the credit. It does
not run the exit, so `EXECUTABLE_VALUE` means the entry would have filled, not
that the position could have been closed at a profit or at all.
