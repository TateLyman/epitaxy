# Development window V1 — invalidated after ten minutes

**Started:** 2026-08-16T20:58:04Z at `153341ac` (clean tree)
**Stopped:** 2026-08-16T21:08Z, after two cycles
**Verdict:** `INVALIDATED — DEFECT IN THE SAMPLER`

## What happened

The window started correctly: clean tree, stamped baseline, frozen parameters,
live endpoint, and it opened trajectories on the first cycle. Then cycle 2
opened the **same three mints again**.

```
cycle 1   OPENED  38p2gd3pnT   24fTiNwEG3   3Ydh3BiTFP
cycle 2   OPENED  38p2gd3pnT   24fTiNwEG3   3Ydh3BiTFP
```

## Why that ends the window rather than being tidied up later

`migrationCandidates` was:

```sql
SELECT ... FROM confirmed_migrations
 WHERE reversal_status = 'CONFIRMED'
 ORDER BY slot DESC LIMIT ?
```

No reference to what had already been sampled. Every cycle returned the newest
confirmed migrations, and the collector opened a trajectory on each of them,
forever.

The threshold that matters is **100 valid complete paths per policy-cohort**. A
hundred paths across three pools is three outcomes with a hundred observations
of them, and no amount of further collection converts one into the other. A
corpus built that way would have hit the numeric threshold while supporting no
claim about a population — which is the same shape as every other defect this
directive exists to correct: the count looks right and the thing being counted
is wrong.

Collecting for another day and filtering afterwards was the alternative. It was
rejected: the trajectories are real measurements that cost real RPC budget, and
a corpus that needs a post-hoc filter to be interpretable is one where the
filter becomes a choice made after seeing outcomes.

## The fix

Two rules, in `migrationCandidates`:

- a mint with a trajectory in any **non-SETTLED** state is excluded outright —
  two concurrent trajectories on one pool share a mark path and duplicate each
  other exactly;
- the remainder is ordered **least-sampled first** (`ORDER BY sampled ASC, slot
  DESC`), so coverage spreads across pools before it deepens on any one, with
  the fresher migration breaking ties.

Plus a cap, `maxPerMint = 3`. A cap rather than a ban: the same pool at a
different hour is a different market, so a repeat is informative — it is simply
not *independent*, and it may not dominate.

`samplingSpread()` now prints every cycle:

```
sampling spread : N trajector(ies) across M mint(s), most-sampled mint has K
```

so this cannot go unnoticed again.

## What survives

The trajectories opened during the window are **kept**. They are valid
mechanics measurements — sole-venue attributed, quote-state proven, plans
frozen, cashback measured on both legs. What they are not is an independent
sample, so they may not be counted toward a policy-cohort threshold.

They are distinguishable by `opened_utc_ms` between the window start and stop
above, and by mint concentration.

## Also observed, and not a defect

The window's first cycles printed:

```
HIGH_IMPACT  entry is 111.7% of the pool (bound 0.5%), haircut 22346 bps
HIGH_IMPACT  entry is  70.5% of the pool (bound 0.5%), haircut 14110 bps
```

That is the impact bound working for the first time — it had been computed and
discarded (`void impact`) with hardcoded zeros written to every row. The finding
it reveals is real and separate: **the frozen 0.02 SOL notional is 70–112% of
these pools' quote reserves.** A round trip at that size measures our own
footprint, not the venue.

That is a question about the notional and the candidate filter, and it is
recorded rather than fixed silently, because changing either is a preregistered
act. See `docs/MULTIPLE_TESTING_LEDGER.csv`.
