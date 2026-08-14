# Development preregistration — post-02483ca

Frozen **before** the first valid stateful label exists. Everything here is
chosen on mechanics and arithmetic, not on any outcome, because there are no
outcomes yet to choose from.

## Why a new preregistration

The previous window is invalid (`docs/02483CA_WINDOW_INVALIDATION.md`): proof
and production built different requests, no production caller named the asset a
buy received, the explicit PnL fields were unwritten, and three of the four
cohort queues were never fed. Nothing is carried forward.

## The blocker, stated first

No position can open at the current configuration. From
`artifacts/economic-admission-surface.json`:

```
risk budget per trade  0.023955178 SOL
min viable notional    0.0209128   SOL
effective min score    0.88        (configured: 0.35)
```

Collection cannot begin against these numbers in any useful volume. The honest
lever is the overhead — recovering the 0.00204 SOL of ATA rent, which P6 makes
possible — not raising NAV or the risk fraction, both of which would manufacture
trades rather than earn them.

## Arms

Four cohorts, identical in every other respect. Not pooled.

```
AGE_2M_60M
AGE_1H_5H
AGE_5H_24H
AGE_24H_7D
```

Token age and post-migration age are different mechanisms and are stored
separately. A plausible but unproven hypothesis is that the 5h–24h and 24h–7d
survivor populations carry lower catastrophic incidence than the first hour.
The experiment decides; this sentence is not evidence.

## Identical across every arm

```
notional            the admitted size from the size surface
route family        BUILD_CUSTOM
cost model          measured settlement, rent as locked capital
risk facts          the same gates
entry mechanics     measured round trip below maxRoundTripLossBps
exit control        fixed time exit (control)
fill latency        FROZEN_FILL_LATENCY_MS
evidence class      DEVELOPMENT_JIT
```

## The exit experiment (P19)

Exactly two policies. No grid.

| | |
|---|---|
| **control** | fixed time exit |
| **challenger** | trailing / collapse emergency exit |

Mechanism-distinct, not parameter-distinct. Both use the same later-fill
semantics: the trigger observation is never its own fill.

A stop/trail/take-profit/max-hold grid is explicitly not run. With no valid
labels, a grid search over four dimensions finds the best of hundreds of
combinations on a sample too small to distinguish any of them, and the winner
is noise with a name.

Recorded per position: MFE, MAE, fillability curve, time to no-route, time to
creator/entity dump, return at 1/5/15/30/60 minutes.

Partial exits are not run until a full-position lifecycle is profitable and
exact.

## Checkpoints

| valid stateful positions | what is permitted |
|---|---|
| 10 | instrument and lifecycle sanity only |
| 25 | size, cost and fillability sanity |
| 50 | first directional read |
| 100 | model and arm comparison |

Below 100, only two things are compared: mechanics + hard gates, and the
current corrected deterministic score. No model is fitted.

## Kill rules

An arm is killed or deprioritised if, after **50** valid stateful positions:

- net PnL is negative after all costs;
- it is negative after removing the top three;
- catastrophic or blocked incidence breaches the frozen limit;
- mechanics drag consumes the plausible edge;
- the executable label rate is too low to reach 200 in a reasonable window;
- one mint or one day carries the result.

The original 2m–60m thesis is not protected. It is one of four arms and it is
killed on the same rules as the others.

At 100+, at most one primary cohort/size/policy and one challenger survive into
the confirmatory window.

## Objective

Primary: **robust expected log growth per capital-hour.**

Secondary: CVaR, catastrophic incidence, blocked-exit incidence, top-N/day/mint
fragility.

Win rate is not optimised. A strategy with a 90% win rate and one total loss per
hundred is a losing strategy that reports well.

No hour-of-day filter is added. The prior in-sample hour comparison was
exploratory and not statistically significant, and fitting it would spend alpha
on a coin flip.

## Sample requirement before any comparison is believed

Per arm, and all of them:

```
100 valid completed stateful positions
distinct UTC days, not one session
positive after 2x measured transaction costs
positive after top-three removal
```

Falling short of any of these means the comparison is not run, rather than run
with a caveat.
