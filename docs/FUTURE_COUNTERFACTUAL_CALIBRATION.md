# The future counterfactual, and what it is allowed to claim

**Directive section:** P9 / F20 / item 49
**Status:** the evidence classes are defined and enforced, and **full event
replay is now built and has run end to end** (`pnpm replay:calibrate`).
**Calibration has still not been performed**, so no bounded counterfactual may
be called confirmatory. See "What has actually run" below for the exact extent.

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

**Built.** `pnpm replay:calibrate`, in two phases:

```
--arm=<mint>      capture the coherent snapshot, run the entry, keep both
--settle=<file>   fetch the intervening trades, replay them, price the exit
```

Two phases because the trades a replay needs take a holding period to happen and
the collector does not persist entry snapshots — a settled row already in the
corpus **cannot** be replayed after the fact. That is a real limitation, not an
implementation gap: the state has to be kept from the moment of entry.

Four design decisions carry the honesty of the construction:

- **Events are read off the two vaults, not off the swap instruction.** A trade
  can reach the pool through a router, an aggregator, or an instruction version
  we have never decoded. Enumerating shapes means the replay silently omits
  whatever shape is new, and an omitted trade is a reserve change that never
  happened locally. Direction is derived from the signs of the two deltas;
  anything whose signs do not describe a swap — a deposit, a withdrawal, a
  one-sided move — is refused by name rather than skipped.
- **The mainnet trader's INPUT is replayed, never their output.** Their output
  came from mainnet's reserves. Forcing it would reproduce mainnet's prices and
  erase the displacement our entry caused, which is the whole quantity being
  measured.
- **Refusals kill the whole trajectory, never one event.** A replay missing one
  trade is a pool at the wrong reserves for every event after it, presented as
  the exact reference the bounded class is calibrated against.
- **Seeding the replay actor does not inflate supply.** The base tokens mainnet
  sellers sold already exist in the mint's `supply`, held by accounts our
  snapshot never fetched. Giving them to one local actor models those holders.
  The mint account is left untouched — market cap is
  `quoteReserve × supply / baseReserve` and the fee tier is selected from market
  cap, so inflating supply would move replayed trades into a tier mainnet never
  used.

One thing a shared actor gets wrong, stated rather than corrected: PumpSwap
keeps a **per-user** volume accumulator and cashback accrues against it. Running
every intervening trade through one wallet concentrates volume mainnet spread
across many. The reserve trajectory — what the exit is priced from — is
unaffected; **cashback accrued during the hold is not measurable from a replay**
and is refused rather than adjusted.

## What has actually run

Two live runs, both earning `FULL_EVENT_REPLAY_TRAJECTORY`, and both on the
**degenerate case** where exactness is trivial:

| mint | slots held | replayable | failed, excluded |
|---|---|---|---|
| `3Ydh3BiTFP4h…` | 1,132 | 0 | 0 |
| `38p2gd3pnTMT…` | 1,806 | 0 | 3 |

The first pool's last trade was 255,341 slots before the entry. The second had
three real transactions during the hold and **every one of them failed**, so
each was excluded and counted — the exclusion path exercised against mainnet
rather than a fixture. A failed transaction changed no balances and is not an
event; counting it rather than dropping it keeps "nothing happened" and "we
chose not to replay it" apart.

That run found a real defect. The first version refused this pool with
`EVENT_LIST_INCOMPLETE` because the listing's newest slot was below the exit
slot. That reasoning is wrong: the signature listing is queried newest-first
with no cursor, so a newest slot below the exit is the *observation that nothing
traded*, not evidence of a gap. A quiet pool is the one case where the replay is
trivially exact, and the check was rejecting it. Only an empty listing is
refused now — a pool vault was created by a transaction, so a vault with no
signatures at all is a provider that answered without answering.

**The replay loop has not yet been exercised against a pool that traded
successfully during the hold.** Until it has, "full replay works" means the
ordering, refusals and seeding are tested, and that the zero-event path and the
failed-transaction exclusion have run live. It does not yet mean a multi-event
replay has been observed.

Getting one is a sampling problem, not a code problem: every pool reachable from
the current corpus is quiet, which is the same finding the depth gate produced
(19 of 29 candidates deep, 10 drained). An armed pool has to be one that is
actually trading.

## Why the bounded class cannot self-certify

The bound is on the *approximation*, and the approximation's error is only known
by comparison with something exact. A bounded trajectory whose error was never
compared against replay is an assumption wearing an interval.

So the ordering is forced:

```
build full replay for a calibration subset      ← the MACHINERY exists; the
  → measure the bounded class's error against it    subset does not
    → freeze the bound and the haircut
      → only then may bounded outcomes be called confirmatory
```

Step one is now two things, and only the first is done. `pnpm replay:calibrate`
exists and runs. A *subset* — enough armed pools, held long enough, with enough
intervening trades to characterise the error — has not been collected. Building
the instrument is not taking the measurement, and the gap between those is
exactly where a project talks itself into calling something calibrated.

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
