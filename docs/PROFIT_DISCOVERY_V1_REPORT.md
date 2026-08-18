# Profit Discovery V1 — Final Report

**Directive:** `epitaxy_aaf6d6a_profit_discovery_v1`
**Date:** 2026-08-18

---

## 1. Starting and ending SHA

| | |
|---|---|
| audited head (start) | `aaf6d6a502ff354d92e6c06a3aba1f96d01a6791` (merge of PR #56) |
| ending HEAD | `b51538d74e232908da0e186a667fa89f4ee8951c` |
| branch | `directive/profit-discovery-v1`, fast-forwarded onto `directive/5d24e39-ledger-first` |
| final contract | `contract-7346e383d6266fbb` |
| final context | `ctx-b51538d74e23-PROFIT_DISCOVERY_V1_R5` |

Development happened in a separate worktree at `aaf6d6a` exactly as P0 requires;
it was removed once the work was committed.

## 2. Did baseline collection continue uninterrupted?

**No trajectory collector was running when this directive began.** The P0 check
found `processes matching trajectory-collect.ts: 0`, with the previous window's
marks already **7,600 s past a 10,000 ms SLA**. Only `pnpm observe` (pid 1916)
was alive; it holds no evidence contract and was left untouched throughout.

`ctx-c3add8bff804-DEV_WINDOW_5D24E` was therefore **closed, not demoted** — its
20 settled trajectories remain valid evidence and remain the unbiased
hard-gates/random control the directive wants to keep. Its 5 unsettled
trajectories are *unfinishable* rather than unfinished: every remaining horizon
was hours past, so a mark taken now would carry a "+30m" label on a +2h price.

This required a new primitive. The repository had exactly one verb for ending a
window — demote to `INSTRUMENT_DEVELOPMENT_INVALID` — which asserts the rows are
not evidence. `pnpm window:close` is the missing second verb.

## 3. S079 / S091 / S096 disposition

| | status | evidence |
|---|---|---|
| **S079** shared endpoint budget | **LANDED** | SQLite lease bucket keyed by endpoint and method family; measured live at 1,098 leases granted, 0 refused, across two endpoints |
| **S091** invalidation reasons | **LANDED** | empty / code-only / truncated `--reason=` refused *before the database is opened*, because demotion is a one-way door |
| **S096** process-tree counting | **LANDED** | `sh → npx → tsx → node` counts as one collector, verified live on a real 6-process chain |

S096 also demonstrated its own limit, live and usefully. The pattern matches any
process whose command line *mentions* `trajectory-collect.ts`, so a monitoring
shell watching the collector was counted as a second tree. The lock told the
truth — one `ALIVE trajectory_collector` — which is exactly why the design says
the database lock remains authoritative and the process count is a machine
inventory. A tree count is a hint; the lock is the invariant.

S079 also revealed that the local rate bucket had been halved *specifically* to
compensate for its absence — the config note said so and said the real fix "is
not built". It is built, so the halving became double-counting. Corrected to
8 req/s; the shared endpoint total stays at 8 req/s, so the cross-process sum is
strictly under the documented ~10 exactly as before.

## 4. Current clean RPC capacity

Recovered since the 2026-08-17 exhaustion, and verified:

```
source.rpc                 getSlot 440146196 from quiknode
source.rpc.largestAccounts getTokenLargestAccounts PERMITTED
source.jupiter             30 tokens in 142ms
15 checks, 0 failed
```

Note `pnpm doctor` does **not** run this — pnpm's own builtin shadows the script.
Use `npx tsx scripts/doctor.ts`.

## 5. Helius recommendation — RETRACTED

**An earlier draft of this report recommended buying Helius Developer. That
recommendation was wrong and is withdrawn.** It is left visible here rather than
edited out, because the way it was reached is the more useful artifact.

The reasoning was: entity-adjusted concentration is unmeasured on 84% of
candidates; the refusal reads

```
the holder owners could not be resolved: HTTP 429: max usage reached
```

`max usage reached` is the wording of an exhausted plan, the corpus showed 1,218
`MEASURED` against 6,391 `HISTORY_INCOMPLETE`, and the conclusion — buy capacity
— followed comfortably from both.

Probing the endpoint directly, with request sizes interleaved to rule out an
accumulating bucket:

```
n=5   OK 28ms        n=20  429        n=5 again  OK 27ms
n=6   429            n=7   429        n=8        429
the same 20 addresses as 4 x 5   ->   20/20 resolved in 468ms
```

A sharp per-request cliff between 5 and 6, with 5 succeeding *immediately after*
a failure. Not rate, not credits: **a batch-size bound of five accounts,
reported with a quota's error message.**

`getTokenAccountOwners` passes the top **twenty** holders in one call, so it
failed 100% of the time on this endpoint. After chunking at 5, the same four
mints measure **4/4 with `trustworthy=true`** and real entity shares — 0.5148,
0.7260, 0.0254, 0.8970 — in 2–4 seconds each. Two of those exceed the 50% gate
and will now be refused at admission, which is the gate acting on a number that
exists instead of on a null.

**No purchase was needed. The blocker was ours.**

What the episode is worth: a provider's error TEXT is not a diagnosis. Every
piece of circumstantial evidence pointed at quota — the message, the corpus
ratio, a genuinely exhausted fallback — and the actual cause was a constant.
Probing the endpoint cost minutes; the recommendation would have cost money and
fixed nothing.

**Jupiter Developer: still NOT recommended.** Nothing in this phase showed the
free bucket limiting completed trajectories.

**Standing capacity note:** the configured *fallback* endpoint does appear to be
credit-exhausted, so the system effectively runs on one endpoint and a primary
hiccup has nowhere to go. That is worth resolving, but it is not what was
blocking coverage and it should not be justified by this report's numbers.

## 6. Migration-history completeness

Priced by walking signatures only — cheap enough to price the fetch without
paying for it:

| mint | pages | pre-migration | failed | to fetch |
|---|---|---|---|---|
| 24qbVJUa2e | 4 | 796 | 179 | 617 |
| 8fkseSjM13 | 2 | 318 | 23 | 295 |
| 6UzjhzmKwh | 3 | 500 | 136 | 364 |
| 9UJiGDgFmU | 4 | 674 | 154 | 520 |
| B7LsPdY86b | 2 | 303 | 117 | 186 |
| H9UoZx4beV | 40+ | 7,591 | 6,018 | 1,573 |

**5 of 6 reach creation inside four pages; mean fetch 396 transactions.** The
failed share runs 23%–79% and is skipped entirely.

Live coverage: **50% COMPLETE** (2 of 4 characterised at the time of the read).

## 7. Feature coverage by field

On a COMPLETE mint, **6 of the 8 fields** `MIGRATION_MICROSTRUCTURE_RISK_V1`
requires are known — up from 0 at session start:

```
KNOWN    mechanicsViable, creatorNetSellingLamports, mintBehaviourSafe,
         largestFirstBuyerEntityShare, buyerRetention, migrationPathEntityDominance
unknown  entityConcentration, lateSellPressure
```

Across all 48 microstructure fields on COMPLETE histories: every
creation-anchored family populated (timing, flow, creator, entity structure,
path dynamics). Four fields reach 100% because they survive INCOMPLETE coverage.

## 8. Targeted-flow coverage

**NOT_RUN.** 0 flow events, 0 bars. The layer is built and tested (dedup,
failed-exclusion, processed→confirmed reconciliation, gap persistence,
program-id refusal) but needs Enhanced WebSockets or the fallback poll. Reported
as `NOT_RUN` rather than zeros.

## 9. T0 / T120 sample counts

```
T0     9 opportunities, 7 mechanically viable
T120   0
paired mints (both clocks): 0
```

The T120 arm is built and its leakage guards are tested — distinct decision-time
snapshots, no future input — but the delayed-decision pass has not been
exercised live.

## 10. Dynamic-size distribution and binding conditions

```
 2,500,000 lamports  evaluated 9  admissible 7  chosen 0
 5,000,000           evaluated 9  admissible 7  chosen 0
10,000,000           evaluated 9  admissible 7  chosen 0
20,000,000           evaluated 9  admissible 7  chosen 7

binding condition on refusal:  8 × PRICE_IMPACT
```

Every admissible candidate chose the 0.02 SOL **ceiling**, so on these pools the
rule agrees with the old fixed notional — which is the correct outcome, not a
null result: it means these pools were deep enough all along and the rule now
*demonstrates* that instead of assuming it.

## 11. Cold / warm setup economics

1,457 accounts across 630 trajectories: rent 2,866,169,760 lamports, recoverable
1,302,459,600, **subsidy to other traders 0**. `pooledSetupCost` throws if a
first-ever setup is pooled with recurring economics.

## 12. Fee-tier / cashback / Mayhem populations

```
5  BOTTOM_TIER / NONCASHBACK / NON_MAYHEM / TOKEN_2022
1  BOTTOM_TIER / CASHBACK    / NON_MAYHEM / TOKEN_2022
1  HIGHER_TIER / NONCASHBACK / NON_MAYHEM / TOKEN_2022
```

**Independent corroboration of the fee schedule:** the measured round-trip drag
on a bottom-tier non-cashback pool came out at **249–266 bps**, against ~250 bps
predicted by the published schedule. That is a cross-check of P8's mechanics
hypothesis from live pricing — it is *not* a profitability result.

## 13. Actual smart-policy enter / reject counts

```
policy                             eligible  ENTER  REJECTED_ON_SIGNAL  NOT_EVALUABLE
HARD_GATES_RANDOM                         7      4                   3              0
MIGRATION_MICROSTRUCTURE_RISK_V1          7      0                   0              7
SURVIVOR_FLOW_CONTINUATION_V1             7      0                   0              7
CORRECTED_CURRENT_QUALITY_SCORE           7      0                   0              7
```

**This is the headline result and it is negative.** The tournament still has one
arm that can enter. What changed is that the corpus can now *say so*: at
`aaf6d6a` these were REJECT rows, indistinguishable from a policy that looked at
real numbers and declined.

## 14. Paired policy outcomes

None. Zero smart-policy entries means zero paired observations. Performance is
reported as **NOT QUOTABLE** rather than 0.00.

## 15. Robust statistics and top-tail fragility

For the only arm with entries, pooled across live contexts (n=10 mints, 1 UTC
day — **descriptive only**):

```
mean log return    -0.32006      median  -0.36961
median-of-means    -0.33049      profit factor  0.085
CVaR 95            -0.56285      max drawdown   -8.32150
mint bootstrap     [-0.40771, -0.18746]
without top1 -0.36936   top3 -0.38246   top5 -0.38567
survives every removal: NO
```

## 16. Prospective rejected-winner statistics

0 tail winners discarded, 0 catastrophic among rejected, opportunity cost
-0.41698 mean log. With 4 of 10 rejects carrying a mark path this is far too
thin to judge any filter.

## 17. Distinct mints and UTC days

10 distinct mints, 1 UTC day.

## 18. Operational valid trajectories/day

Not yet stable — four windows were opened and closed in one session as defects
surfaced. Per-mint cost is now ~25–75 s of history fetch plus the entity walk.

## 19. Is any arm a DEVELOPMENT_EDGE_CANDIDATE?

**No, and it is not close.** Selection requires 100 distinct valid mints; there
are 10. Three of four arms have never entered a position.

## 20. Unresolved blockers

1. **Entity-adjusted concentration** — was the dominant blocker at 84%
   unmeasured. **Cause found and fixed**: a 5-account-per-request limit on
   `getMultipleAccounts` while `getTokenAccountOwners` batched twenty. Verified
   at the entity-tier level (4/4 MEASURED, `trustworthy=true`). **End-to-end
   verification through a collector window is still outstanding** — the window
   at the fixed commit had not yet opened a trajectory when this was written, so
   every `policy_field_coverage` row on record predates the fix.
2. **Targeted flow never exercised** — every post-migration signal is null, so
   `SURVIVOR_FLOW_CONTINUATION_V1` cannot be evaluated at T120 by construction.
3. **T120 arm not exercised** — no paired sample exists.
4. `lateSellPressure` null on launches with no final-minute activity.
5. `transactionsSkippedFailed` computed and tested but not persisted; it folds
   into `transactions_failed`. A 6-minute migration on a 9.3 GB corpus was not
   judged worth a telemetry column.
6. The corrected quality score still has no trajectory-source coverage and is
   **retired from primary inference**, descriptive only.

### Five defects found by RUNNING, not by review

Every one passed a green ~1,900-test suite:

1. round-trip **cost** tested against the **impact** cap → every size refused on
   every pool, including a 1,048 SOL pool, logged as a depth refusal;
2. `COMPLETE` reported over a history with **zero trades** → fabricated zeros,
   producing the cleanest-looking launch in the corpus;
3. failed transactions fetched then discarded — up to 79% of a fetch budget;
4. the cheap signature walk bounded by the expensive transaction budget;
5. **`mintBehaviourSafe: freezeAuthority === null`** against a *string union* —
   always null, on every candidate ever evaluated, silently making both
   challengers unevaluable long before this directive began;
6. every RPC family cap sat BELOW the endpoint total, so the documented
   "families borrow idle capacity" could never happen — the endpoint total
   refused 0 leases while the history family refused **6,662** at its own cap;
7. a shared-budget refusal was caught by the failover loop and sent to the
   fallback, spending the fallback's credits to avoid waiting on a healthy
   primary — which manufactured the very `max usage reached` that made this look
   like a quota problem;
8. **`getMultipleAccounts` batched twenty against a five-account limit**, which
   is what actually caused the 84%.

Two lessons, and they are different. A REJECT count cannot distinguish
"declined" from "unplugged" — the argument for per-field coverage. And a
provider's error TEXT is not a diagnosis: `max usage reached` was a batch-size
bound, and every piece of circumstantial evidence agreed with the wrong reading.

## 21. Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

The apparatus is validated, running under a frozen contract, opening
trajectories, taking marks, and reporting honestly. But the directive conditions
`VALID_PROFIT_DISCOVERY_RUNNING` on **actual non-null signal coverage**, and
every `policy_field_coverage` row on record still shows all three smart policies
at 0% — the tournament is `HARD_GATES_RANDOM` alone, which is the exact
condition this directive set out to end.

The blocking measurement has been **identified and repaired** — a five-account
batch limit, not the capacity it was first diagnosed as — and the repair is
verified where it was made: the entity tier returns 4/4 MEASURED with
`trustworthy=true`. What is NOT yet verified is the consequence: no window has
yet opened a trajectory under the fixed build, so no row exists in which
`entityConcentration` is populated and a smart policy renders a verdict.

The state therefore stays `MEASUREMENT_REPAIR_REQUIRED` rather than advancing on
a repair that is expected to work. The next `pnpm policy:coverage` against
`ctx-b51538d74e23-PROFIT_DISCOVERY_V1_R5` is the measurement that decides it,
and it should be read rather than predicted.

**No result here authorizes capital. No arm was selected. Nothing signed,
funded, or submitted.**
