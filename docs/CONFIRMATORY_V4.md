# Confirmatory trajectories v1 (supersedes confirmatory positions v4)

`packages/research/src/confirmatory-trajectories.ts` · `pnpm readiness`
→ `artifacts/readiness.json`

The directive offers `confirmatory_positions_v4` or, preferably,
`confirmatory_trajectories_v1`. The second is implemented, because a trajectory —
not a position — is the unit that has one entry, one exit and one set of
economics.

## The defect this removes

Readiness computed by summing every historical shadow answers **"has anything
ever looked good"**, which has a yes in any large enough corpus.

The question that matters is "did the thing I committed to in advance do what I
said it would", and only a contract frozen **before the first outcome** can
answer it.

## One trajectory, one row

Every identity field is exact: trajectory id, entry observation/job/settlement,
exit observation/job/settlement. `contractHeld` rejects a duplicated
`trajectoryId`.

**No unrelated qualifying job may satisfy another trajectory's requirement.**
That is how a corpus of near misses becomes a confirmed result.

## The frozen contract

```
contractId · frozenAtUtcMs · sourceCommit · strategyVersion · kernelVersion
notional · cohort · migrationAgeBand · cashbackPolicy · mayhemPolicy
entryPolicy · exitPolicy · approvedFingerprints · costModel · rentTreatment
counterfactualEvidenceClass
```

`contractHeld` checks **every** bound field, not a sample. Checking a subset
would let the interesting differences through, because the interesting
differences are exactly the ones nobody thought to check. The test asserts a
failure on each of ten fields individually.

A row whose `capabilityFingerprint` is not in `approvedFingerprints` violates the
contract. A row with `usedFallbackExecutionCost` violates it too: **no invented
execution cost is allowed in confirmatory data.**

## Thresholds are constants here

```
minCompletedTrajectories  200
minDistinctUtcDays         21
minProfitFactor          1.25
recentWindow               50
dropTopN          1, 3, 5, 10
dropBestMintsOrEntities     5
costStressMultiple          2
```

**None may be supplied by observed evidence.** A threshold read from the data it
judges is not a threshold.

## Every UNKNOWN is a FAIL

Most readiness inputs are null in a system that has not run long enough. A gate
treating null as satisfied would report ready **fastest when least is known** —
which is precisely backwards.

The gates: contract held · completed trajectories · distinct UTC days · net PnL
positive · expected log growth positive · robust lower bound positive · profit
factor · drawdown bounded · CVaR acceptable · catastrophic incidence · blocked
incidence · recent 50 positive · positive without top 1/3/5/10 · positive without
best day · positive without best five mints or entities · positive under 2×
costs · positive under latency/failure/rent/cashback-claim stress · positive
exact canary-size shadow · zero replay divergence · zero unresolved
reconciliation · fingerprints stable.

## Readiness reads only the contract and current clean artifacts

It does **not** sum historical shadows. That is the whole correction.

## Current standing

```
contract stamped   NO
ready              false
failing gates      22 of 22
```

No confirmatory contract has been stamped, so readiness cannot pass and does not
try. The artifact says so explicitly rather than emitting a number that looks
like a near miss.
