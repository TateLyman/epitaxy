# The counterfactual future-state problem

`packages/domain/src/trajectory-evidence.ts`

## The problem, stated exactly

**A future mainnet pool state does not contain the hypothetical entry.**

"Entry exact, future mark exact" is **false** unless the entry's persistent
effect on the pool is handled. A buy moves reserves; every later price on that
pool is a price in a world where the buy did not happen. Quoting a later mainnet
state as the counterfactual exit silently assumes the entry was free of
consequence.

This is not a rounding concern. It is the difference between measuring a strategy
and measuring a market that the strategy never touched.

## Two evidence modes

### A. `BOUNDED_COUNTERFACTUAL`

Allowed **only** when the entry's maximum influence on every price-bearing
reserve is below a frozen small-impact bound.

`boundEntryImpact` records:

```
entry input / effective quote reserve       quoteImpactRatio
entry tokens / base reserve                 baseImpactRatio
the larger of the two                       maxImpactRatio
a conservative haircut                      haircutBps
```

`SMALL_IMPACT_BOUND = 0.005` — 50 bps of either reserve. Frozen. A larger bound
admits an entry whose own effect on the pool is a material part of the return
being measured.

The haircut is the impact **doubled**, rounded up: the entry moved the price in,
and the exit pays to move back through its own footprint. `haircutExitValue`
only ever reduces value — a nonsensical haircut cannot increase it.

An infinite ratio (a zero reserve) yields a 10,000 bps haircut and fails the
bound, rather than a divide-by-zero.

Ratios are computed by scaled integer division so a u64 never crosses a double
before it has been reduced to a small number.

**This is development evidence, never confirmatory.**

### B. `FULL_EVENT_REPLAY`

Replay the settled intervening pool transactions onto the local post-entry state
before evaluating the exit. The stronger counterfactual.

**Not built.** It is the requirement for `CANARY_READY`, which is therefore
unreachable today, and saying so is the point of grading evidence at all.

## The comparison that must happen before A is used at scale

Compare A against B on a calibration subset and freeze a maximum approximation
error. Until that comparison exists, A is a bound rather than a measurement, and
its haircut is a guess with a defensible direction rather than a calibrated
correction.

## Why the ceiling is decided at open

`TrajectoryKernel.open` fixes `maximumAttainableGrade` at entry time. A
trajectory whose entry exceeds the bound is capped at `SIMULATED_EXECUTION`
permanently.

Deciding this later — when the outcome is known — is how a weak trajectory gets
counted as a strong one once the number looks good. The ceiling is a property of
the entry, and the entry is over before any of its returns exist.

## Current position

Nothing in this repository has reached `BOUNDED_COUNTERFACTUAL`. Every completed
trajectory is an **immediate** round trip: buy and sell in one runtime, no future
state involved at all, therefore `SIMULATED_EXECUTION`.

The moment a trajectory is held and marked forward, this document governs what
may be claimed about it.
