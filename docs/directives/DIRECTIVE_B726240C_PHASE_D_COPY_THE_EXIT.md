<!--
  RECEIVED 2026-08-19 as b726240c-epitaxy_phase_d_copy_the_exit_directive.md, after PR #59
  merged as 30b7f1b. Committed VERBATIM and before execution, so that what was asked for is a
  fixed artifact and cannot be reconciled after the fact with what was delivered. Nothing in
  this file has been reworded, reordered, or summarised.

  Execution record: docs/PHASE_D_REPORT.md. Preregistered rule: MT083. Depth gate: MT084.
  Rolling re-rank: MT085.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE D: COPY THE EXIT

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #59 (`30b7f1b`), `UNDECIDABLE_CENSORING`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Credits:** 1,544 remain of 2,500. Target 400, **stop-and-report ceiling 700**. Phase C's
overage was one non-prunable `sol_transfers` scan; every query here is on `dex_solana.trades`,
which prunes by `block_time`. If any single query exceeds 150, stop and report before continuing.

---

## 0 — WHAT PHASE C SETTLED, AND WHAT IT DID NOT

Settled, and it changes the shape of the problem:

- **The edge is not execution-only.** With one exit horizon applied to both sides, a copier two
  seconds behind keeps 0.725–0.779 of the appreciation, 0.670–0.701 at sixty seconds. The paired
  execution premium is +9.27% [+6.23%, +13.21%] at 2s over 30/30 days. A transferable selection
  component exists and is large.
- **Latency is not the binding constraint on the AMM.** MT072 resolved: +2.94% mean but **+0.03%
  median** slippage at a 2-second lag on 11,494 followable AMM positions. The cost is a tail, not
  a level. The +86.13% figure belongs to the bonding curve, which Phase B already closed.
- **The vanishing is attrition, not renaming.** Rotation is 4.5–5.3% flat across all ten deciles
  and 12–16% under the loose definition against 12.6% for everyone else. A flat rate cannot
  produce a 36.7%-vs-8.6% gradient. ~32% of decile 1 stopped or blew up.

Not settled, and it is the only thing blocking a decision:

- **46% of followable AMM positions have no exit price** in the 60s window at t+3600s. Widening
  to five minutes at the same horizon admits 26% more positions and moves as-priced from +24.45%
  to +5.42%. As-priced is biased up by survivorship; censored-at-−100% is biased down by pricing
  a survivable exit as total loss. Two defensible treatments, opposite signs.

Phase D changes the **estimand** so that coverage is a property of the construction rather than
of whether anyone else happened to be trading.

---

## 1 — THE PRIMARY ESTIMAND: PAIRED ROUND-TRIP COPY

### 1.1 Construction

For every top-cohort wallet position in the holdout window with an observed buy at `T_buy` and an
observed sell at `T_sell`:

```
copier_entry_px(L) = VWAP of trades on M in [T_buy  + L, T_buy  + L + 60s]
copier_exit_px(L)  = VWAP of trades on M in [T_sell + L, T_sell + L + 60s]
copier_return(L)   = copier_exit_px / copier_entry_px - 1 - tier_floor
wallet_return      = the wallet's own realised return on the SAME position
```

`L ∈ {2s, 5s, 15s, 30s, 60s, 300s}`, `top_fraction ∈ {0.001, 0.01}`, both ranking cohorts
separately, `entry_project = pumpswap` primary and curve as comparison.

**Why this fixes coverage:** the exit is anchored on a trade the wallet itself executed, so a
trade exists in that window by construction. The 46% gap was an artifact of demanding a price at
an arbitrary wall-clock instant on mints nobody was trading.

**Why this fixes the ratio:** `copier_return / wallet_return` now divides two round trips over the
same legs, differing only in entry and exit price. Phase C's −7.5 was a 60-minute return over a
whole-position return and was correctly reported without interpretation. This one is
interpretable and is the primary reported quantity beside the paired difference.

### 1.2 Report coverage before anything else

```
positions with both legs priced at each L, as a fraction of followable positions
```

If this is below 90% at any `L`, say so before reporting a single return. If it is below 70%,
stop and go to §2 rather than reporting an estimate that carries the same defect under a new name.

### 1.3 Residual censoring

Positions the wallet never closed have no `T_sell`. The copier would also still be holding, so
these are genuinely open rather than missing.

Report them as a **counted third category**, never filtered in a `WHERE` clause, and report the
estimate under all three treatments:

```
closed-only            open positions excluded, count reported
open-at--100%          open positions enter at -1.0
open-at-reserve-mark   open positions priced per §2, if §2 runs
```

The §3 sign-agreement condition applies across `closed-only` and `open-at--100%`.

---

## 2 — RESERVE RECONSTRUCTION (ONLY IF §1.2 COMES BACK UNDER 70%)

A constant-product pool's reserves are determined by its initial state and the sequence of swaps
against it. Every swap in `dex_solana.trades` carries both leg amounts, so reserves can be rolled
forward trade by trade and a price computed at **any** timestamp, including ones with no trade.

Post-migration PumpSwap canonical pools have their liquidity deposited once at migration and rare
subsequent liquidity events, which is what makes this tractable. Detect and flag any pool whose
reconstructed invariant `k` jumps discontinuously — that is a liquidity event, and a pool with one
is excluded rather than smoothed.

**Validate before applying at scale, exactly as the market-cap check was validated.** The
collector holds 413 stored pool snapshots over 142 pools with real on-chain bytes. Reconstruct
reserves for those same pools from the trade stream alone and compare against the stored bytes.
Report the ratio distribution and the fraction agreeing within tolerance. Do not use the
reconstruction at scale unless the p50 ratio is within 1% and agreement exceeds 95%, and record
both numbers in the ledger.

---

## 3 — DECISION RULE — MT083, FROZEN BEFORE THE FIRST EXECUTION

Unchanged in structure from MT079. A lag `L` is **copyable** if and only if:

```
1. copier_return(L) day-clustered 95% lower bound > 0, net of the tier floor
2. closed-only and open-at--100% treatments AGREE IN SIGN
3. entry_project = pumpswap
4. n >= 7.84 x CV_observed squared, on the copier round-trip return
```

Condition 2 remains non-negotiable and no threshold search follows a failure.

Do not relax condition 4 because coverage improved. Recompute CV on the new estimand; a
round-trip return bounded by the wallet's own exit discipline may have materially lower dispersion
than a fixed-horizon one, and if so the power condition gets easier honestly rather than by
assumption.

---

## 4 — THE SIZING ARM

Phase C established the copy cost is a tail: +2.94% mean against +0.03% median. That is a sizing
problem, not a speed problem, and it has never been tested.

Add one treatment dimension:

```
UNGATED     copy every position the cohort takes
DEPTH_GATED skip any position where the wallet's own trade exceeded X% of pool reserves
            X in {1%, 3%, 10%}, frozen before running
```

The hypothesis is that the slippage tail lives in the positions where the wallet itself moved the
pool hard, and that declining those removes most of the cost at little loss of selection. Report
both the return and the fraction of positions declined at each `X`.

---

## 5 — ROLLING RE-RANK, NOT A FIXED COHORT

~32% of decile 1 stopped or blew up, and rotation is flat across deciles so it is not the
mechanism. A fixed cohort ranked once and followed for 30 days therefore decays, and H1's estimate
is conditioned on survivors by an amount whose direction is unknown.

Report the primary estimand under a **rolling re-rank**: re-rank the cohort every 7 days on the
trailing window, and follow whoever is in it at that time. This is both the operationally honest
version and the one whose survivorship properties are stated rather than inherited.

Report the fixed-cohort figure beside it. If they differ materially, the rolling one governs.

The entity-level H1 re-run stays deferred. H1 remains an address-level result and the report must
continue to say so.

---

## 6 — FINAL REPORT

1. coverage per §1.2, at every `L`, before any return figure
2. the round-trip table: `L` × cohort × `top_fraction` × sizing gate, all three censoring
   treatments
3. `copier_return / wallet_return` — now interpretable — and the paired difference with interval
4. the largest `L` satisfying all four conditions of §3, or the statement that none does
5. reserve reconstruction validation figures, if §2 ran
6. depth-gate results: return and decline rate at each `X`
7. rolling re-rank beside fixed cohort
8. credits consumed, per query
9. ledger diff from MT083, every cell examined
10. one final state:

```
COPYABLE_LAG_IDENTIFIED    name it; it owes a preregistered confirmatory design and a
                           required n computed on the copier's CV, not the wallet's
NO_COPYABLE_LAG            all four conditions fail with treatments agreeing; branch closes
UNDECIDABLE_CENSORING      treatments still disagree; report coverage and stop
```

If the state is `COPYABLE_LAG_IDENTIFIED`, that is **not** permission to trade. It is permission
to design a confirmatory window, which is a separate directive and a separate decision.

Do not open a window. Do not run canary or live. Do not fund a wallet.
