# The development tournament, v2

`packages/strategy/src/treatments.ts` · `packages/strategy/src/cohort-comparability.ts`

## What v1 was, and why it measured nothing

v1 allocated **one arm label to one trajectory**. Each arm therefore saw a
different set of tokens, so any difference between arms was confounded with which
tokens each arm happened to draw — and at these sample sizes that difference is
almost entirely noise.

The arms were labels. Nothing was actually decided differently.

## What makes v2 a tournament

Every structurally sampled trajectory provides **one common market path**, and
every applicable policy is evaluated over that same path. The comparison becomes
**paired**: same token, same pool, same marks, same costs, different decision.

That removes the token-selection variance entirely, which is the dominant term.

## Entry policies

**`HARD_GATES_RANDOM`** — the causal control. Among hard-gate-pass candidates, a
persisted seeded inclusion at 50%. It uses no signal beyond the gates, so any
challenger that cannot beat it is not using information.

Deterministic in `(seed, mint)`. `Math.random()` would make the control
unreplayable, which defeats the purpose of having one.

**`CORRECTED_CURRENT_QUALITY_SCORE`** — the current corrected score, with
coverage enforced. An unscored token is **not** a pass.

**`SURVIVOR_FLOW_CONTINUATION_V1`** — pre-entry features only: independent buyer
persistence, non-Mayhem net quote inflow, stable or growing effective quote
reserve, stable or growing exit capacity, nonvertical positive continuation, no
creator or entity net selling, acceptable entity concentration, safe mint
behaviour, viable mechanics.

**No feature may use a post-entry observation.** Leakage is indistinguishable
from edge in a backtest — it is the single most common way a strategy looks
profitable and is not.

**An unknown is never a pass.** A policy that read null as "fine" would enter most
often on exactly the tokens nothing is known about.

Hard safety gates and mechanics viability bind **every** policy. An arm that
could trade through them would not be a different strategy, it would be a
different risk appetite.

## Exit policies

**`FIXED_15M_CONTROL`** — the frozen horizon.

**`FLOW_LIQUIDITY_DETERIORATION_V1`** — leaves when the *ability to leave* is
deteriorating: a 2,000 bps fall in exit capacity between marks. It falls back to
the frozen horizon so it cannot win by holding forever.

**Deliberately not a take-profit grid.** Memecoin returns are heavy-tailed and a
small number of winners carry the result, so an arbitrary early take-profit
truncates exactly the right tail the strategy depends on. This exits on a
liquidity fact, not a price target.

Returns are recorded at 1m, 5m, 15m, 30m and 60m, but only the frozen
15-minute control and one challenger are used for inference. The other horizons
are **descriptive until a new preregistration**.

## Checkpoints

```
 10  apparatus sanity
 25  costs and fillability
 50  early elimination
100  development selection permitted
```

An arm may be eliminated at 50 **only** under the frozen rule: its paired mean is
worse than the control's by more than two paired standard errors. Paired, because
every policy saw the same trajectories — an unpaired comparison would be
dominated by the confound this whole section exists to remove.

Zero variance in the paired differences is treated as an **apparatus fault**, not
a result.

## Cohort comparability

A first-hour freshness feature cannot rank a seven-day cohort; its value is
near-constant there, so ranking on it orders by noise while looking like it
ordered by freshness. See `cohort-comparability.ts`: cohort-relative rank where
it applies, and a hard refusal on raw cross-cohort comparison where it does not.

## Current standing

**No arm has been run over shared trajectories.** The policies are implemented
and tested; the tournament requires held trajectories with mark streams, and
every completed trajectory so far is an immediate round trip.

Twenty completed trajectories is above apparatus sanity and below costs and
fillability. **No arm may be selected or eliminated on it.**
