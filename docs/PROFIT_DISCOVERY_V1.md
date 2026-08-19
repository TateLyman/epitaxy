# Profit Discovery V1

**Source commit basis:** `aaf6d6a502ff354d92e6c06a3aba1f96d01a6791` (merged PR #56)
**Branch:** `directive/profit-discovery-v1`
**Date:** 2026-08-18

## What this phase is, and what it is not

It is not another accounting rewrite. The previous phase did the hard part: Epitaxy
produces independently recomputable trajectories with zero unexplained lamports,
durable raw evidence, coherent snapshots, explicit counterfactual contracts, real
paired policy decisions, and timely marks when the scheduler is not starved.

The problem this phase attacks is economic, and it has one root cause that was
visible in six lines of source at the audited head:

```ts
independentBuyerPersistence:      null
nonMayhemNetQuoteInflowLamports:  null
effectiveQuoteReserveTrend:       null
executableExitCapacityTrend:      null
continuationSlope:                null
creatorNetSellingLamports:        null
correctedQualityScore:            null
scoreCoverageOk:                  false
```

Those are not defaults awaiting data. They are literals. Consequently:

| policy | what it could do |
|---|---|
| `HARD_GATES_RANDOM` | the only arm that could enter |
| `CORRECTED_CURRENT_QUALITY_SCORE` | rejected everything — the score was never computed |
| `SURVIVOR_FLOW_CONTINUATION_V1` | rejected everything — every input unknown |

The tournament was correctly wired and economically empty. Every REJECT row it
produced was indistinguishable from a policy that had looked at real numbers and
declined, and read naively the two challengers looked like extremely conservative
filters when they were unplugged instruments.

## The strategy result this phase inherits

```text
settled window   n     FIXED_15M    FLOW/LIQUIDITY
window A         15    +1.23m       +14.59m lamports
window B         45    -3.93m       -35.12m
window C         13    +9.59m        +8.73m
```

In window C, 2 of 13 paths were positive and one ~+14m winner carried the total.
Remove it and both policies are negative. The largest window is negative.

That shape governs every design decision below. A strategy carried by a handful of
enormous winners cannot be improved by anything that raises the win rate, and most
things that raise the win rate remove the winners.

## What was built

| part | module | what it does |
|---|---|---|
| P3 | `packages/intelligence/src/migration-microstructure.ts` | features over the CLOSED pre-migration bonding curve |
| P3 | `packages/intelligence/src/migration-history.ts` | fetch that history once, hash it, cache it forever |
| P4 | `packages/intelligence/src/targeted-flow.ts` | candidate-scoped post-migration flow bars |
| P5 | `packages/intelligence/src/pre-entry-signals.ts` | the six nulls, computed |
| P2 | `packages/strategy/src/policy-coverage.ts` | `NOT_EVALUABLE` as a third verdict |
| P9 | `packages/strategy/src/treatments.ts` | `MIGRATION_MICROSTRUCTURE_RISK_V1` |
| P7 | `packages/strategy/src/size-rule.ts` | size as a rule, outcome-blind |
| P8 | `packages/strategy/src/fee-strata.ts` | fee/cashback/Mayhem strata, honest cashback |
| P6 | `packages/pipeline/src/entry-clocks.ts` | T0 and T120, with the leakage guards |
| P12 | `packages/research/src/robust-stats.ts` | mint-level, cluster-bootstrapped, fragility |
| P16 | `packages/research/src/reject-panel-v4.ts` | what the filters refused, and what it cost |
| P13 | `packages/intelligence/src/external-prior.ts` | external models, structurally non-decision-bearing |
| S079 | `packages/adapters/src/endpoint-budget.ts` | one endpoint budget shared across processes |

## The three ideas that matter

### 1. The closed curve is the only free lunch

A migrated token's bonding-curve history cannot change. It is immutable, it is
cheap relative to anything else that predicts, and — the part that matters — it is
structurally impossible to contaminate with the future. A feature computed there
cannot drift as the post-migration price moves.

That is why P3 is the centre of this phase rather than a nice-to-have, and why it
is cached against `(mint, feature_version)` and never re-fetched.

### 2. Unknown is a third state, everywhere

Every feature is `number | null`. Every null carries a recorded reason. Every
policy verdict carries `ENTER` / `REJECTED_ON_SIGNAL` / `NOT_EVALUABLE`.

The incompleteness in a fetched history is always at the OLD end, because the fetch
pages backward from the migration signature. So creation-anchored features
(totals, unique counts, time-to-migration) require COMPLETE coverage and are null
otherwise, while tail-anchored ones survive. That asymmetry is load-bearing: if the
fetch ever paged forward, the reasoning inverts and a truncated history would
produce confident totals over the wrong half of the launch.

### 3. Nothing here is fitted to the current outcomes

Every threshold in `MIGRATION_MICROSTRUCTURE_RISK_V1`, every candidate size bound,
the 120-second clock and every signal definition is registered in
`docs/MULTIPLE_TESTING_LEDGER.csv` (MT049–MT052) BEFORE the window opens, and all
four are availability-driven. With 13 settled paths in the last window, tuning
anything on them would be fitting noise and calling it a policy.

## What this phase does NOT claim

- No edge is established. No arm has been selected.
- No capital is authorised. Nothing signs, funds, or submits.
- The ~190 bps versus ~50 bps round-trip difference between fee tiers is a
  MECHANICS HYPOTHESIS read off the published fee schedule. It is not an Epitaxy
  result and `pnpm fee-strata:status` refuses to report it as one.
- `DEVELOPMENT_EDGE_CANDIDATE` requires 100 distinct valid mints, positivity after
  top-three removal, a positive robust mean, and a material margin over random.
  None of that exists.

## Commands

```bash
pnpm policy:coverage          # what each policy KNEW — the key command for this phase
pnpm microstructure:coverage  # field-level coverage, not row counts
pnpm microstructure:trace -- --mint=<mint>
pnpm flow:status / flow:coverage
pnpm entry-clock:status
pnpm size-rule:surface
pnpm fee-strata:status
pnpm policy:paired-report
pnpm reject:prospective-v4
pnpm development:robustness
pnpm rpc:shared-budget
```

## Related

- [MIGRATION_MICROSTRUCTURE_V1.md](MIGRATION_MICROSTRUCTURE_V1.md)
- [TARGETED_FLOW_V1.md](TARGETED_FLOW_V1.md)
- [DYNAMIC_SIZE_RULE_V1.md](DYNAMIC_SIZE_RULE_V1.md)
- [FEE_CASHBACK_STRATA_V1.md](FEE_CASHBACK_STRATA_V1.md)
- [DEVELOPMENT_ANALYSIS_V1.md](DEVELOPMENT_ANALYSIS_V1.md)
