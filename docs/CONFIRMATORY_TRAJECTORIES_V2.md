# Confirmatory trajectories V2

**Directive section:** P12
**Status:** the gate is implemented and is the default `pnpm readiness`.
**No contract has been stamped.** No confirmatory collection has started.

## What changed, and why it had to

`pnpm readiness` read the POSITION view: fallback costs, historical shadow
structures, and a canary-size gate computed over 519 closed canary-shadow
positions. Those numbers are real. None of them is about the thing this
directive built.

A trajectory is not a position. It has no NAV, consumes no portfolio limit, and
its exit is a policy applied to a shared mark path rather than a decision taken
under capital. A readiness verdict assembled from the wrong table is a verdict
about the wrong experiment — the same defect class as a proof artifact standing
in for a database, which is what this whole directive exists to correct.

The old gate still runs, under `pnpm readiness:positions`. The paper book is
still real evidence about the paper book.

## The gate, as it stands today

```
settled trajectories   59
TIMELY complete paths   8   of 200 required
distinct UTC days       2   of 21 required
net PnL                 UNKNOWN
VERDICT             NOT READY — 22 blockers
```

### An UNKNOWN is a FAIL

Most inputs are null in a system that has not run long enough. That is the normal
state, not an error. A gate that treated null as satisfied would report ready
fastest when least is known, which inverts the entire purpose.

### Net PnL is deliberately UNKNOWN

`trajectory_policy_outcomes.gross_delta_lamports` is the exit mark minus the
entry cash-out. It contains no unrecoverable rent, no failed attempt, no claim
cost and no cashback. Publishing it as net PnL would be the single most
flattering substitution available in this repository.

So the gross figure is printed, labelled gross, and net stays null until a
canonical settlement exists per trajectory. Because UNKNOWN fails, this costs
nothing in safety and buys the ability to say what is actually known.

### Only TIMELY paths count

A backfilled horizon carries the right label and the wrong instant. The first
live window fetched five horizons in one burst, so every exit policy agreed
trivially — 8 of 59 settled paths are timely, and only those 8 count. Counting
the rest would inflate the sample with observations that cannot distinguish the
policies they exist to compare.

## What a contract must bind, before its first outcome

`ConfirmatoryContract` is stored **in the database, before collection starts**,
and `contractHeld` checks **every** bound field on every row — not a sample.
A row that differs in any bound dimension is a different experiment, and checking
a subset lets exactly the interesting differences through, because the
interesting differences are the ones nobody thought to check.

```
source commit          notional             cohort
strategy version       migration age band   cashback policy
kernel version         Mayhem policy        entry policy
approved fingerprints  exit policy          cost model
rent treatment         counterfactual evidence class
```

Two of those deserve naming here:

- **cost model / rent treatment.** `usedFallbackExecutionCost` on any row is
  disqualifying. A cost that had to be invented is not a cost that was measured.
- **counterfactual evidence class.** Every outcome is
  `BOUNDED_COUNTERFACTUAL_TRAJECTORY` or `FULL_EVENT_REPLAY_TRAJECTORY`, and the
  bounded class is not confirmatory until its error is calibrated against
  replay. See `docs/FUTURE_COUNTERFACTUAL_CALIBRATION.md`.

## The thresholds

```
minCompletedTrajectories  200      recentWindow           50
minDistinctUtcDays         21      dropTopN               1, 3, 5, 10
minProfitFactor          1.25      dropBestMintsOrEntities 5
                                   costStressMultiple      2
```

The robustness gates are the load-bearing ones. Positive overall is easy on a
small sample; positive without the best trajectory, without the best day, without
the best five mints, at double the measured costs, and at the exact canary
notional is what distinguishes an edge from a handful of lucky rows.

## Order of operations

```
1. the development window closes with >= 100 valid paths per policy-cohort
2. ONE arm is selected  -> DEVELOPMENT_EDGE_CANDIDATE
3. a contract is stamped in the database, BEFORE any confirmatory outcome
4. confirmatory collection runs untouched
   -> PUMP_CONFIRMATORY_COLLECTION_STARTED
5. the window passes untouched, and a real safe canary path exists
   -> CANARY_READY
```

Step 3 before step 4 is the whole design. A contract stamped after an outcome is
not frozen, and a window that was adjusted while running is a description of the
adjustments.

`CANARY_READY` cannot be awarded by development shadows, however positive. It
requires an actual canary, which spends real funds and is a human act;
`.claude/hooks/guard.mjs` blocks the assistant from starting one or from creating
the live acknowledgement file.

## Where this stands

Step 1 is not close: 8 timely paths against 100 per cell, and the collector is
currently blocked on an exhausted RPC daily quota. Nothing has been selected,
nothing has been stamped, and the honest terminal state remains
`MEASUREMENT_REPAIR_REQUIRED`.
