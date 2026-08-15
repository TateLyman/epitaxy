# Evidence taxonomy

`packages/domain/src/trajectory-evidence.ts`

## Why this exists

A report that says "profitable" without saying what the number rests on is not a
result. A development counterfactual and a landed mainnet fill are both "a trade"
in a table, and pooling them produces a number that means nothing while looking
authoritative.

## The grades, ordered

| grade | what it means |
|---|---|
| `SYNTHETIC` | a model evaluated against a model — proves arithmetic, never economics |
| `OBSERVED_PRICE` | a quote or pool-derived price at a real state; nobody executed at it |
| `SIMULATED_EXECUTION` | a leg the runtime executed against real captured state, sequentially, post-state measured |
| `BOUNDED_COUNTERFACTUAL` | exit evaluated against a *later* real pool state, with the entry's own impact bounded and haircut |
| `FULL_EVENT_REPLAY` | as above, but intervening pool events replayed onto the local post-entry state first |
| `LANDED_MAINNET` | a transaction that landed and was reconciled from the chain |

## The two rules that carry the weight

**A set takes the grade of its WEAKEST member.** Taking the strongest is how one
landed fill launders a hundred synthetic ones into "mainnet evidence". Taking the
mean is worse — it produces a grade no member actually has.

**A claim may not rest on evidence weaker than its gate requires.**

```
MEASUREMENT_REPAIR_REQUIRED        SYNTHETIC
VALID_TRAJECTORY_KERNEL_RUNNING    SIMULATED_EXECUTION
DEVELOPMENT_EDGE_CANDIDATE         BOUNDED_COUNTERFACTUAL
PUMP_CONFIRMATORY_COLLECTION       BOUNDED_COUNTERFACTUAL
CANARY_READY                       FULL_EVENT_REPLAY
STRATEGY_KILLED_BY_CORRECTED_ECON  SIMULATED_EXECUTION
```

`LIVE_READY` is deliberately absent. No combination of evidence in this
repository can produce it.

## Not the same axis as `EvidenceClass`

`packages/domain/src/evidence.ts` grades how well a single **leg's simulation**
was verified: structural → effect-valid → offline-reproducible → confirmatory.

`EvidenceGrade` here grades what an entire **trajectory's economics** rest on.

They are kept in separate files because they are genuinely different questions. A
trajectory built from confirmatory legs can still be only
`BOUNDED_COUNTERFACTUAL`, because its exit was evaluated against a future state
that never contained its entry.

## The counterfactual problem, stated where it cannot be forgotten

A future mainnet pool state does not contain the hypothetical entry. Calling a
later mainnet quote an exact counterfactual exit is **false** unless the entry's
persistent effect is handled. See `COUNTERFACTUAL_FUTURE_STATE.md`.

## Current holdings

Everything measured in this directive is `SIMULATED_EXECUTION`: exact sequential
mechanics with no future state involved at all. Nothing has reached
`BOUNDED_COUNTERFACTUAL`, because no trajectory has been held and marked forward.
