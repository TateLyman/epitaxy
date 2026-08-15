# The running trajectory collector

`apps/collector/src/trajectory-collect.ts` · `packages/pipeline/src/open-trajectory.ts`
`pnpm trajectory:collect`

## What was wrong

For two commits after the persistent worker was built, `pnpm trajectory:collect`
ended by printing:

```
NOT OPENING TRAJECTORIES: the one-pass sequential worker (P3) is not built.
```

The worker existed. The collector was never updated. So the database carried
**zero** trajectories while a proof script's twenty round trips were being read
as the running system's output — and the state was promoted on that reading.

## What it does now

```
confirmed migration
  → canonical pool verified on chain
  → coherent snapshot v2          (not legacy captureSnapshot)
  → EXACT direct PumpSwap buy     (not a router)
  → one persistent runtime        (SequentialWorker, not the proof script)
  → immediate mechanics
  → SOLE-VENUE attribution check
  → append-only OPEN trajectory row
```

## Sole-venue attribution, and why the old check was not enough

The previous evidence showed the canonical base vault **changed**. A split or
routed entry changes it too, so that check cannot distinguish "the canonical pool
was the venue" from "the canonical pool was one of the venues".

The collector now requires the flow to reconcile:

```
pool base-vault decrease  ==  taker token credit
pool quote-vault increase  >  0
```

A mismatch is refused as `ENTRY_NOT_SOLE_VENUE` with both figures named. This is
also why the buy is built by the official PumpSwap builder rather than Jupiter:
a routed buy could satisfy the old check and never satisfy this one.

## Measured result

```
opened trajectories        3
venue                      PUMPSWAP_DIRECT
soleVenueAttributed        true  on all three
quoteStateSurvived         true  on all three
state                      AWAITING_FILL_OBSERVATION
```

These are **real database rows**, not artifact rows.

## Refusals are the product

`NO_CANONICAL_POOL` · `POOL_UNDECODABLE` · `SNAPSHOT_INCOHERENT` ·
`BUY_BUILD_FAILED` · `MECHANICS_FAILED` · `ENTRY_NOT_SOLE_VENUE` ·
`RUNTIME_UNAVAILABLE`

Each carries its own detail. Collapsing them into one word is how 93% of a
previous corpus became uninformative.

## A defect this work introduced, found by running it

Moving the Clock into the economic tier (audit finding F4) was correct — the
`UserVolumeAccumulator` is time-windowed, so a Clock from another slot can move a
simulated trade into a different fee window.

Fetching it in a **second** `getMultipleAccounts` call was not. A separate call is
served a slot or two later almost every time, so the capture guaranteed the very
drift the check exists to catch: **half the live candidate queue was refused at
`drift 1 > bound 0`** — drift this module created rather than observed.

The Clock now rides in the same call as the price-bearing accounts, so a
mixed-slot Clock is **unrepresentable** rather than merely detected. Enforcement
by construction beats enforcement by check, and the test asserting the old shape
was updated to the stronger one.

## Safety

The collector owns no NAV, opens no capital-bearing `positions`, writes no live
ledger, imports no signer, and cannot run in canary or live. It writes only to
`development_trajectories`, and the insert is **append-only** —
`INSERT OR REPLACE` was refused because an outcome that can be overwritten is an
outcome that can be improved after the fact.

## Not done

The later-fill path is **not** built. These rows are `AWAITING_FILL_OBSERVATION`
and no trajectory has settled, so:

- no later shared mark path is collected;
- no policy is evaluated;
- no exit settlement exists;
- **the terminal state stays `MEASUREMENT_REPAIR_REQUIRED`.**

Opening a trajectory is necessary and not sufficient. The directive's gate is a
row that goes all the way to a canonical exit settlement, and none does.
