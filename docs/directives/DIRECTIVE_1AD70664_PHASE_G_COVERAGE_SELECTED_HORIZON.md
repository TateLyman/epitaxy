<!--
  RECEIVED 2026-08-19 as 1ad70664-epitaxy_phase_g_coverage_selected_horizon.md, after PR #62 was
  opened. Committed VERBATIM and before execution. Nothing here has been reworded or summarised.

  LEDGER ID COLLISION, recorded rather than silently resolved: this directive asks for H* to be
  written as MT089, but MT089 was already spent on Phase F's carry-forward correction and a
  ledger row is never reassigned. H* is preregistered as MT092 instead, with the same content
  and the same before-any-return ordering the directive requires.

  Execution record: docs/PHASE_G_REPORT.md. H* preregistration: MT092. Fee-split correction:
  MT093. Collector terminal states: MT094.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE G: CHOOSE A HORIZON WHERE PRICES EXIST

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #62, `PRE_MIGRATION: UNDECIDABLE` / `PHASE_C_CELL: RECONSTRUCTION_FAILED_VALIDATION`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Credits: 895 remain of 2,500.** Target 300, stop-and-report ceiling 500, per-query 250.

---

## 0 — THE CORRECTION THIS PHASE CARRIES

The external analysis that preceded Phase F closed the Phase C cell by interpolating from two
coverage points. Phase F establishes that it should not have:

- the interpolation's own sensitivity spans −18.1% to −2.5% depending on how "26% more positions"
  is read, and the second reading is inside the noise;
- §2.4 did not run, so the cell is unevaluated at honest coverage rather than evaluated and closed;
- §1 found that on the 27 markable censored T1 mints the mean is **+282.9% against +234.2%** for
  survivors — weak, selected, and pointing **against** the assumption that uncovered positions are
  worse.

**The Phase C cell is open.** Any report from this phase that describes it as previously closed is
wrong and must not repeat that.

---

## 1 — THE COVERAGE-SELECTED HORIZON (PRIMARY)

Phase C's 46% gap is a property of demanding a price at t+3600s. Coverage is a function of the
horizon, and it is measurable **without reading a single return**. That makes horizon selection
outcome-independent and therefore not a forking path.

### 1.1 Measure coverage first, alone

For copier entries at lag `L ∈ {2s, 15s}` on top-cohort buys, over horizons:

```
H ∈ {120s, 300s, 600s, 1200s, 3600s}
```

Report, per `H` × `L` × cohort × `top_fraction`, and **nothing else in this step**:

```
followable positions
positions with a priced entry
positions with a priced exit at H
both legs priced, as a fraction of followable
```

`H = 3600s` is included solely as the anchor to Phase C. It is not a candidate.

### 1.2 Select before evaluating — this ordering is the whole design

```
H* = the shortest H in {120s, 300s, 600s, 1200s} whose both-legs-priced fraction >= 90%
```

Write `H*` to the ledger as MT089 **before** any return is computed or read. If no horizon reaches
90%, report that and stop; do not lower the bar to whatever the best horizon achieved.

The person running this will be able to see returns in the same query output. Structure the query
so the coverage columns are read and `H*` committed in a separate execution from the returns, and
assert by test that the committed `H*` does not depend on any return field.

### 1.3 Evaluate at H* only

Apply MT079's four conditions at `H*`:

```
1. day-clustered 95% lower bound > 0, net of the tier floor
2. as-priced and censored-at--100% agree in sign
3. entry_project = pumpswap
4. n >= 7.84 x CV_observed squared, on the copier return at H*
```

Other horizons are reported as sensitivity, never as candidates. A cell that fails at `H*` and
passes at some other `H` is a failure, and the report says so.

**Note the expected tension and do not resolve it by choosing:** shorter horizons buy coverage and
may cost return, since Phase C's share decayed from 0.725 at 2s toward 0.520 at 300s of *lag*.
Whether the same holds for *holding period* is unmeasured and is the second question this phase
answers.

---

## 2 — THE FEE-SPLIT CORRECTION TO THE RECONSTRUCTION

Phase F diagnosed the roll-forward bias precisely: `dex_solana.trades` carries the trader's
amounts, and the protocol and creator portions of the PumpSwap fee leave the pool while the LP
portion stays. That term is not missing from your data — `FeeConfig` was decoded in Phase B with
`lpFeeBps`, `protocolFeeBps` and `creatorFeeBps` per market-cap tier.

### 2.1 Correct

```
pool_sol_delta = trader_sol x (1 - (protocolFeeBps + creatorFeeBps) / 10000)
```

Decode the actual direction from the program rather than assuming it: whether the fee is taken on
input or output, and whether it differs between buy and sell, changes the arithmetic and must be
read from the instruction, not inferred. Tier depends on market cap depends on reserves; iterate
to convergence and report the iteration count and any pool that fails to converge.

### 2.2 Revalidate on the identical 271 pairs

Same bar, and it is a **conjunction**: p50 within 1% **and** agreement above 95%. Phase F's tests
already guard against reading it as a disjunction; keep that guard.

Report the trade-count-stratified table in the same form as Phase F:

```
trades between snapshots | pairs | base p50 | within 1%
1 / 2-5 / 6-20 / 21-100 / 101+
```

**This is the falsification test for the diagnosis itself.** If the mechanism is right, the
monotonic drift should collapse and the 101+ bucket should return from p50 1.925 toward 1.000. If
it does not, the diagnosis was wrong, the route is closed for real, and the report says so rather
than trying a third estimator.

### 2.3 Only if validation passes

Run Phase C's §2.4 as specified: every position priced, three pricings side by side, and the
explicitly stated realised value of the previously-uncovered positions. That single number is what
the interpolation guessed at, and it is reported whatever it says.

If validation fails, `PHASE_C_CELL` stays `RECONSTRUCTION_FAILED_VALIDATION` and §1's coverage
route is the only evaluation of that cell this programme will produce.

---

## 3 — THE COLLECTOR FIX (NO CREDITS, DO IT REGARDLESS OF EVERYTHING ABOVE)

§1 of Phase F could not decide the pre-migration branch because **97.5% of censored mints have no
post-entry price at all** — the collector stopped snapshotting them. That is a collection defect,
not an analysis one, and no amount of re-analysis of the existing corpus repairs it.

Change the collector so that once a mint enters the corpus it continues to be snapshotted on the
mark schedule until a terminal condition, and make death an **observed** terminal state rather than
an absence:

```
terminal states: pool drained below a frozen threshold | no trade for a frozen interval |
                 explicit horizon reached
```

Record which terminal state fired. A mint that stops being observed for any other reason is a
collection failure and is counted as one.

This changes nothing about the existing corpus and everything about the next one. It is the single
highest-value zero-credit action available and it should ship in this PR whatever else does.

---

## 4 — FINAL REPORT

1. §1.1 coverage table, and `H*`, before any return appears in the document
2. §1.3 evaluation at `H*`, four conditions, both censoring treatments
3. sensitivity across the other horizons, explicitly labelled as sensitivity
4. §2.2 stratified revalidation, and whether the diagnosis survived its own falsification test
5. §2.3 if reached, with the previously-uncovered positions' realised value stated explicitly
6. §3 shipped, with the terminal-state taxonomy
7. credits per query
8. ledger diff from MT089
9. one final state:

```
COPYABLE_HORIZON_IDENTIFIED   all four conditions hold at H*; owes a preregistered
                              confirmatory design; NOT permission to trade
NO_COPYABLE_HORIZON           conditions fail at H* with treatments agreeing in sign
NO_HORIZON_REACHES_COVERAGE   no H achieves 90%; the venue cannot be priced honestly
                              at any holding period this data supports
```

Do not open a window. Do not run canary or live. Do not fund a wallet.
