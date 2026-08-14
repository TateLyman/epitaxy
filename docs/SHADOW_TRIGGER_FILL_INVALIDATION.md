# Invalidated: every shadow result closed before P6

## What is void

**All 1,038 closed shadow positions in the corpus**, and every figure derived
from them. Summed realized PnL across them is −18,338,967,174 lamports, and that
number is not a strategy result.

```sql
SELECT COUNT(*) FROM shadow_positions
 WHERE state = 'POSITION_CLOSED' AND fill_latency_ms IS NULL;
-- 1038
```

`fill_latency_ms IS NULL` is the marker. Every row without it was closed by the
pre-P6 loop.

## Why

The shadow loop ran `decideExit` on a mark and, in the same iteration, called
`closeShadowPosition` with `realizedLamports = thatMark - cost`.

That books a fill **at the price which caused the decision to exit**, observed
before the decision existed. It is the one price a real exit can never get: by
the time an exit is built, simulated, signed, submitted and landed, the price
that triggered it is in the past. The error is not random — a stop fires on a
drop and fills at the drop, a take-profit fires on a spike and fills at the
spike. It flatters in both directions.

There was no waiting, no later observation, no latency, and no route check
beyond `routeAvailable` on the trigger mark itself.

## The part that makes this worth writing down

`packages/domain/src/shadow-lifecycle.ts` has forbidden this transition since it
was written. Its guard says so in words:

> a shadow may not close at its trigger observation; it must await a later fill

**No production file imported that module.** The states, the transition table,
`holdsExposure`, `schedulePriority` — all declared, all unit-tested, all read by
no decision. It is the same defect class as the urgent-mark queue that ended in
a `Set.add` and the exploration arm allocated a budget of zero: code that exists,
passes review, has tests, and is not called.

Reading the source would not have caught it. `manageShadowBooks` looks correct in
isolation, and `shadow-lifecycle.test.ts` passes. What caught it was
`scripts/call-graph.ts` resolving the actual AST through the TypeScript checker
and reporting one missing edge:

```
MISS manageShadowBooks -> admitPortfolioExit
```

The shadow book was not merely filling at the wrong price. It was closing on
routes the realizable portfolio would have refused, which means it was
shadowing a strategy nobody was running.

## What replaces it

Migration 32 and the rewired loop:

```
POSITION_OPEN
  -> EXIT_TRIGGERED -> AWAITING_FILL_OBSERVATION    the rule fired; nothing filled it
  -> POSITION_CLOSED                                a LATER valid observation filled it
  -> EXIT_BLOCKED                                   no valid fill exists yet
```

A fill must be strictly later than the trigger, past the frozen 1,200 ms
latency, in the same route family, effect-valid on its own, and priced. The
first such observation is the fill — not the best one, because choosing among
later observations after seeing them all is look-ahead under another name.

`EXIT_BLOCKED` is not terminal. The tokens are still held, the rent is still
locked, and the position keeps being worked.

Each close now records `fill_latency_ms` and `look_ahead_bias_lamports`, so the
size of what the old design was booking for free becomes a measurement rather
than an argument.

## What this does not invalidate

The realizable portfolio path (`manageOpenPositions`) already went through
`admitPortfolioExit` and already used measured settlement. It has produced no
closed position, so there is nothing there to void either way.
