# MIGRATION_MICROSTRUCTURE_V1

Feature version string: `migration-microstructure-v1`
Module: `packages/intelligence/src/migration-microstructure.ts`
Fetcher: `packages/intelligence/src/migration-history.ts`

## Why the pre-migration curve

A migrated token's bonding-curve history is **closed**. The migration signature is
its last transaction and nothing can be appended. That single property gives three
things nothing else in this system has at once:

1. **Immutability.** Fetch once, hash, cache forever. This matters because history
   is the most expensive read available and `pnpm rpc:usage` already reports 48
   quota refusals at 1.84 calls/active second.
2. **Leakage impossibility.** A feature computed over a closed interval cannot
   drift as the post-migration price moves. Contrast every "momentum" feature ever
   computed over a live window.
3. **Testability.** "Append a post-migration transaction; assert no feature moved"
   is a real mutation test, and it is P19 test 2.

## Feature families, and where they came from

Chosen from current published work — **families only, never coefficients**:

- **MemeTrans** (>40k migrated Solana launches, >200m transactions): timing,
  concentration and activity families materially reduce high-risk-launch losses.
- **SolRugDetector**: Solana rug behaviour is highly organised, extremely
  short-lived, and visible in on-chain state and transaction behaviour.
- **Pump.fun graduation work**: structural launch variables beat SOL-locked alone.
- **Coordinated-wallet research**: persistent cohorts exist, but raw association
  with later flow is **confounded**. A cohort is therefore risk and context here,
  never automatically bullish.

**No external model is imported and none is fitted.** The protocol, fee schedule,
migration venue and participant population all changed; a 2024 model declared valid
in 2026 is a fabricated result, not a weaker estimate. Prospective Epitaxy data has
to supply the weights, and until it has, the only thing built on top is a sparse
mechanism-based risk filter (`MIGRATION_MICROSTRUCTURE_RISK_V1`).

## The families

| family | fields |
|---|---|
| timing / intensity | creation→migration seconds, trades to migration, trades/min, median and p10/p90 inter-trade time, burstiness, seconds to 25/50/75% of migration reserve |
| flow | total buy/sell SOL, net inflow, buy/sell counts, volume ratio, unique buyers/sellers, repeat-buyer fraction, wallets fully exited, new buyers in the final 30/60/180s |
| creator | initial buy, total buys/sells, net SOL, net token position at migration, sells in the final 30/60/180s |
| holder / entity | unique entities among the first 10/20 buyers, largest first-buyer entity share, common-funder concentration, first-10/20 retention at migration, unknown-history share, migration path entity dominance |
| path dynamics | return over the final 30/60/180s, max run-up, max drawdown, late acceleration, late sell pressure, reserve slope, real-SOL inflow slope |

Compact on purpose — not 122 features. A wide feature set fitted to 13 settled
paths is a curve fit with a schema.

## Coverage: what survives an incomplete history

The fetch pages **backward** from the migration signature, so incompleteness is
always at the OLD end.

- **Creation-anchored** features (every total, every unique count, the timing
  clocks) require `COMPLETE` coverage and are `null` otherwise.
- **Tail-anchored** features (the final-N-second windows, the path dynamics)
  survive `INCOMPLETE`, because the tail is the part that is never missing.

One subtlety worth stating because it looks like an exception: *new buyers in the
final 30s* is a tail window and is still COMPLETE-only, because "new" means "not
seen earlier" and an incomplete history cannot know what was seen earlier. What
decides is whether the feature references the missing part, not where its window
sits.

`COMPLETE` additionally requires that **nothing was pruned**. A history that
reached creation but could not read 40 of its transactions is not complete; calling
it complete would turn those 40 into implicit zeros in every total.

## Decoding: balances, not instruction layouts

A trade is derived from what the chain recorded — the curve's lamport delta and its
token-account delta — rather than from a decoded instruction:

1. Pump has changed instruction layouts before, and a layout drift produces a
   *silently wrong* trade rather than a refusal. Balance deltas are ground truth.
2. Anything that moves the curve's SOL and tokens is a trade for our purposes.

Cost: a transaction touching the curve twice nets to one event. That is recorded in
the `eventIndex` semantics rather than hidden, so an instruction-level decoder can
later raise the count without changing the key.

## Integrity

- `source_signatures_hash` — sha256 over the deduped, pre-migration, non-failed
  `(signature, eventIndex)` list in canonical order. Two runs that saw the same
  history agree; a run that silently saw less does not.
- `features_hash` — sha256 over the feature vector.
- Rows are keyed `(mint, feature_version)`, so recomputing under a new definition
  never overwrites the evidence an old decision used.

## Commands

```bash
pnpm microstructure:coverage              # FIELD-level coverage, not row counts
pnpm microstructure:trace -- --mint=<mint>
```

Field-level, because aggregate coverage hides the shape of the failure: "68%
coverage" is consistent with most mints mostly covered, or a third fully covered
and the rest empty — and only the second explains why a policy still cannot decide.
