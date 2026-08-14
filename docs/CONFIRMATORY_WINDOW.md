# The confirmatory window (P22)

`packages/domain/src/confirmatory.ts` · `tests/unit/confirmatory-p22.test.ts`

## Status

**Not started, and it cannot be.** It opens only after P19 selects an arm, and
P19 has zero completed trajectories against a first checkpoint of ten per arm.

What exists now is the contract: what must be frozen before the first outcome,
and what the finished window has to clear.

## Why it exists

A development tournament picks an arm by looking at results. That is what it is
for, and it is also why its number cannot be an estimate — the arm that won was
chosen because it won. The confirmatory window asks the same question once, of
an untouched sample, with every parameter fixed beforehand.

## The freeze

Sixteen fields, all required. `checkFreeze` refuses a contract missing any of
them, and a test deletes each field in turn to prove it.

```
routeFamilies            capabilityFingerprints    directBuilder
fallbackBuilder          notionalLamports          cohort
migrationAgeBand         mayhemPolicy              entryPolicy
exitPolicy               fillLatencyMs             costModel
rentTreatment            riskFacts                 strategyVersion
sourceCommit             frozenUtcMs
```

`fallbackBuilder` is the one field allowed to be null, because "there is no
fallback" is a decision. Everything else absent means it was never decided, and
an undecided parameter gets decided by whatever happens.

An **empty** route-family list is refused separately from a missing one. Empty
admits everything, which is the opposite of a freeze while looking like one.

A contract that cannot name its commit is refused: a window that cannot be
re-derived is an anecdote.

## Drift

`contractHeld` compares what was frozen against what was collected. A notional
that moved partway through does not make one experiment with a wobble — it makes
two experiments sharing a name, where the second saw the first one's results.

Caught: extra route families, a changed notional, cohorts outside the freeze,
more than one entry or exit policy, a strategy-version change mid-window, and a
retuned fill latency.

## The gate

Every condition is **AND**. No scoring, no weighting, no "mostly passed".

| condition | threshold |
|---|---|
| completed positions | ≥ 200 |
| distinct UTC days | ≥ 21 |
| net PnL | > 0 |
| expected log growth | > 0 |
| robust lower bound | > 0 |
| profit factor | ≥ 1.25 |
| drawdown, CVaR | within their bounds |
| catastrophic, blocked-exit incidence | within their bounds |
| most recent 50 | net > 0 on their own |
| net without the top three | > 0 |
| single day / single mint share of net | ≤ 50% |
| net under 2× actual costs | > 0 |
| net under latency and failure stress | > 0 |
| exact canary-size shadow | > 0 |
| replay divergences | 0 |
| unresolved reconciliations | 0 |
| capability fingerprints | stable |

200 positions across 20 days fails on days alone. Two hundred trades in a
fortnight is a fortnight, not a sample of regimes.

## Why the thresholds are constants

The directive says: do not weaken a failed gate. In code that means
`CONFIRMATORY_THRESHOLDS` is a frozen object in the module, with no
configuration path and no override argument — `judgeConfirmatory` takes exactly
one parameter, the evidence.

The only way to pass a window that failed is to edit a constant, which is a diff
a reviewer sees and a row in `docs/MULTIPLE_TESTING_LEDGER.csv`.
