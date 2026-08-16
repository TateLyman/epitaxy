# The future counterfactual, and what it is allowed to claim

**Directive section:** P9 / F20
**Status:** the evidence classes are defined and enforced. **Calibration has not
been performed**, so no bounded counterfactual may be called confirmatory.

## The problem, stated exactly

A development entry did not happen on mainnet. The pool it would have moved was
never moved, so every later mainnet state is a state in which our entry does not
exist. A later quote against that state is therefore **not** the trajectory's
exit price; it is the exit price of a trajectory that never entered.

The size of the error is not zero and it is not unbounded. It is the entry's own
effect on the price its exit gets, and this repository already measures that:
`selfImpactLamports` is the difference between quoting the same size against the
pre-buy and post-buy states, and it is `null` rather than `0` whenever it could
not be measured — because zero would be the claim that the entry had no effect on
its own exit, which is exactly the assumption the whole apparatus exists to stop
being made silently.

## The two admissible classes

Every future outcome must carry one of these, and no outcome may carry neither.

### `BOUNDED_COUNTERFACTUAL_TRAJECTORY`

The later mainnet state is used directly, with:

1. a **precondition** on entry reserve ratios — the entry must be small enough
   relative to the effective quote reserve that its own displacement is inside a
   frozen bound;
2. a **calibrated error** established against full replay on a subset, not
   asserted from the ratio alone;
3. a **conservative adverse haircut** applied in the direction that makes the
   trajectory look worse.

Admissible for elimination. **Not admissible as confirmatory evidence** until (2)
exists, which it does not.

### `FULL_EVENT_REPLAY_TRAJECTORY`

The intervening settled pool events are replayed, in order, onto the local
post-entry state. The exit is then priced against a state that contains our
entry, which is the only construction that is exact.

Expensive: it needs every trade against the pool between entry and exit, decoded
and applied. It is the calibration reference, not the routine path.

## Why the bounded class cannot self-certify

The bound is on the *approximation*, and the approximation's error is only known
by comparison with something exact. A bounded trajectory whose error was never
compared against replay is an assumption wearing an interval.

So the ordering is forced:

```
build full replay for a calibration subset
  → measure the bounded class's error against it
    → freeze the bound and the haircut
      → only then may bounded outcomes be called confirmatory
```

Doing this in the other order — declaring a bound, collecting on it, and
calibrating later — produces a corpus whose validity depends on a measurement
taken after the fact, which is the same shape as a gate reading a fact collected
after the decision.

## What is currently collected

The mark path (`MARK_OFFSETS_MS`: 1m, 5m, 15m, 30m, 60m) is a **shared** later
path: every policy sees the same candidate and the same marks, so paired outcomes
differ only by policy. Marks are direct executable quotes against the pool's own
reserves, not router quotes — 93% of the previous corpus had no route at all, and
an unpriced mark can never become a fill however correct the ordering above it is.

Each mark records `lateness_ms`. A horizon reached late carries the right label
and the wrong instant, and `pnpm readiness` counts only timely paths for exactly
that reason.

**These marks are still counterfactual.** They are prices in a world where our
entry did not happen. Nothing in the current corpus has been calibrated, so the
honest class for every path collected so far is bounded-uncalibrated, which is
adequate for eliminating a policy and inadequate for confirming one.

## The one thing that must never happen

A later mainnet quote must never be recorded as *the* exit fill without a class
and an error. That single substitution would make every number downstream —
policy comparison, profit factor, readiness — a statement about a market that
did not contain us.
