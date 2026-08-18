# DEVELOPMENT_ANALYSIS_V1

Modules: `packages/research/src/robust-stats.ts`, `packages/research/src/reject-panel-v4.ts`

## The sample is not one whose mean is a fact

```text
window   n     FIXED_15M    FLOW/LIQUIDITY
A        15    +1.23m       +14.59m lamports
B        45    -3.93m       -35.12m
C        13    +9.59m        +8.73m
```

Window C: 2 of 13 paths positive, one ~+14m winner carrying the total. Remove it
and both policies are negative. The largest window is negative.

Those sign flips are not measurement noise to be averaged away. They are the shape
of memecoin returns, and any statistic assuming otherwise will keep producing
confident nonsense.

## The sampling unit is the MINT

Not a policy outcome and not a delayed-entry row. Two clocks by three primary
policies on one token is **six rows and one draw from the market**. Treating them
as six independent observations understates uncertainty by roughly the square root
of six — most of the difference between "significant" and "noise".

Everything follows from that:

- **Paired deltas.** Both policies saw the same tokens, so the comparison is paired
  by mint. A mint only one policy traded contributes **nothing**; counting it as if
  the other scored zero would silently reward the policy that traded less.
- **Cluster bootstrap.** Resample whole mints, or whole UTC days — never rows.
- **Median of means.** One enormous winner moves one block's mean and cannot move
  the median of the rest.
- **Fragility, always.** Remove the best 1/3/5/10 **mints** and the best day.
  "Remove the top 3" removes three mints, not three rows: with two clocks and three
  policies, the three best rows are routinely the same token three times.

## Objective: expected log growth

Not arithmetic mean return. A +100% and a −50% are equal and opposite in log terms
and are not in arithmetic terms, and a strategy optimised on arithmetic mean will
happily accept a sequence that compounds to zero.

Costs are subtracted before the log is taken. A gross figure is not a return — it
is the number a strategy looks profitable at right up until it is traded.

## Zero entries is not a performance figure

`performanceIsQuotable()` refuses. A policy that never entered has no return
distribution; printing its mean as 0.00 invents a result and printing it as a loss
invents a worse one. The correct report is `NOT_EVALUABLE` plus the histogram of
which fields were missing — which is what tells an operator whether to fix the
strategy or fix the apparatus.

## The reject panel is the statistic that decides

A risk filter can look excellent by trading less. Refuse enough candidates and
catastrophic incidence falls, the win rate rises, and every summary statistic
improves — while the strategy earns less.

So `pnpm reject:prospective-v4` reports, per policy:

```text
catastrophic-loss rate among REJECTED
right-tail winner rate among REJECTED
opportunity cost (inverse-probability weighted)
tail winners DISCARDED
```

If the right-tail rate among rejects exceeds the rate among entries, the verdict is
**HARMFUL** — that filter is removing the paths that carry the strategy. A filter
that avoids losses and removes every tail winner is worse than no filter.

This is only possible because every policy is evaluated over the same trajectory,
so a rejected candidate still has a mark path. Without that construction there
would be no way to know what a filter refused, which is the state most trading
research is permanently in.

## Checkpoints

| mints | what is permitted |
|---|---|
| 25 | apparatus, coverage and cost sanity only |
| 50 | an arm may be KILLED (negative after costs, negative without top 3, dominated on catastrophic incidence, or too rare to be operationally useful) |
| 100 | one development edge candidate MAY be selected |

Selection requires **all** of: positive all-cost expected log growth; positive after
top-three removal; positive on a robust mean; not carried by one day or one mint;
materially better than hard-gates random; operationally frequent enough.

**The highest raw total is not a selection criterion.**

If nothing satisfies it: `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS`, or one new
preregistered research version. Not massaged thresholds.

## Not tested at this stage

Hour-of-day filters. Existing 2026 evidence found exploratory hour effects
non-significant and selected in-sample, and re-testing them here would spend
multiple-testing budget on a hypothesis that has already failed once.

## Commands

```bash
pnpm development:robustness
pnpm policy:paired-report
pnpm reject:prospective-v4
```
