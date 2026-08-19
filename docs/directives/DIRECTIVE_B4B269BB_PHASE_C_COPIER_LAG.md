<!--
  RECEIVED 2026-08-19 as b4b269bb-epitaxy_phase_c_copier_lag_directive.md, immediately
  after PR #58 merged as 2f34907. Committed VERBATIM and before execution, so that what
  was asked for is a fixed artifact and cannot be reconciled after the fact with what was
  delivered. Nothing in this file has been reworded, reordered, or summarised.

  Execution record: docs/PHASE_C_REPORT.md. Preregistered rule: MT079. Selectivity
  change: MT080.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE C: THE COPIER'S PRICE

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #58, `H1_CONFIRMED_H2_UNDECIDABLE_NEITHER_TRADABLE`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Budget:** ~1,910 Dune credits remain. This phase should cost under 200. Do not exceed 400
without stopping to report.

---

## 0 — WHAT THIS PHASE IS FOR

H1 established that wallet skill persists out of sample and survives every adversarial re-cut
the panel supports, including censoring at −100% and closed-positions-only. It also holds on
both entry venues, which means — unlike every prior positive result in this repository — it is
not confined to the pre-migration population the apparatus cannot enter.

H1 measures the **wallet's own realised return**. That quantity is a sum of two components:

```
SELECTION  they chose a mint that appreciated        transferable
EXECUTION  their fill, their sizing, their exit      not transferable
```

A copier inherits selection and forfeits execution. H1 therefore places an **upper bound** on a
copy strategy and says nothing about its value. H2 was meant to isolate selection and could not,
because the flag fired on 82.6% of 85,615 mints — a saturation failure in the delivered query,
not a measurement of the world.

Phase C measures the copier's return directly, as a function of lag, on the same wallet buys H1
already validated. The output is an alpha decay curve. It resolves MT072 (quote-to-land
slippage, UNKNOWN since inception) using public data and no new apparatus.

---

## 1 — SELECTIVITY CORRECTIONS BEFORE ANYTHING RUNS

Three defects in the delivered design, all of which inflate the flag and dilute the cohort.

### 1.1 The cut is far too wide

`top_fraction = 0.10` yields 21,123 wallets. Published all-time base rates put roughly 0.4% of
pump.fun wallets above $10,000 realised and ~0.002% above $1M. A decile cannot be mostly skill.

Run the lag sweep at **`top_fraction ∈ {0.001, 0.01}`** and report both. Do not run 0.10 again
except as a reported comparison row. Record the change as availability-driven in the ledger; it
was already flagged as review item L-frozen-top_fraction and never applied.

### 1.2 The two ranking statistics select different populations — do not pool them

```
fit-mean cut     +39.09% at a 36.7% win rate     tail hunters
fit-median cut    +2.43% at a 53.6% win rate     grinders
```

They disagree on 10,859 of 21,123 wallets. These have different selection/execution splits by
construction: a 36.7% win rate paying +39% is tail capture, and tail capture is mostly *exit*
skill. Run every Phase C cell **separately for each cohort**. Pooling them averages two different
mechanisms into one uninterpretable number.

### 1.3 Restrict the primary arm to the tradable venue

Primary: `entry_project = pumpswap`. Curve entries reported beside it as comparison only. Phase B
established that a result on a population the apparatus cannot enter is not actionable, however
large.

---

## 2 — THE LAG SWEEP

### 2.1 Construction

For every buy by a top-cohort wallet in the holdout window, at time `T` on mint `M`:

```
copier_entry_px(L)  = VWAP of all trades on M in [T+L, T+L+60s]
copier_exit_px      = VWAP of all trades on M in [T+3600s, T+3660s]
copier_return(L)    = copier_exit_px / copier_entry_px - 1 - cost_floor
wallet_return       = the wallet's own realised return on the same position
```

`L ∈ {2s, 5s, 15s, 30s, 60s, 300s}`.

The 60-minute exit matches the Phase B convention. Do not introduce a new horizon in the same
phase that introduces a new estimand.

### 2.2 Cost treatment — note the asymmetry, it was got wrong once already

The **full 2.69% round-trip floor applies to `copier_return`**, because the trade being priced is
ours. It does **not** apply to `wallet_return`: on-chain `sol_in` is gross of the AMM fee and
`sol_out` is net of fee and impact, so both are already inside the amounts, and only the fixed
component (~12,094 lamports, ~6 bps at 0.02 SOL) is missing. The delivered header double-counted
2.63 of those points — a 40× error in the threshold. That correction stands; do not re-apply the
floor to the wallet side.

Use the tier-specific floor where `entry_project = pumpswap` and the tier is known: 2.669 / 2.469
/ 2.350 / 1.722 / 1.025 percent at tiers 0 / 1 / 2 / 8 / 16.

### 2.3 Censoring — build it in from the start

77–93% of mints had no exit price in H2 and that is what made H2 undecidable. Report every cell
under **both** treatments:

```
as-priced          mints with no exit price excluded, count reported beside the estimate
censored           every unpriceable position added back at -100%
```

Exclusions are returned as counts, never filtered in a `WHERE` clause. That convention is what
surfaced the unmarkability gradient in H1 and it is not optional here.

### 2.4 Intervals

`clusterBootstrapAggregated`, day-clustered, paired on the same drawn days for any difference.
Reuse the machinery exactly as H1 did; do not introduce a second interval method mid-programme.

---

## 3 — PREREGISTERED DECISION RULE

Freeze before running. Write to the ledger as MT079 before the first execution.

A lag `L` is **copyable** if and only if all four hold:

```
1. copier_return(L) day-clustered 95% LOWER BOUND > 0, net of the tier floor
2. as-priced and censored treatments AGREE IN SIGN
3. the cell is entry_project = pumpswap
4. n >= 7.84 x CV_observed squared, computed on the copier return, not the wallet return
```

Condition 2 is the one H2 failed. It is not negotiable and no threshold search follows a failure.

Report `copier_return(L) / wallet_return` at every lag. That ratio is the selection share, and it
is the number this phase exists to produce:

```
ratio ~ 0 at every lag       edge is execution, copying is dead, close the branch
ratio > 0 decaying with L    edge has a selection component; the decay curve
                             sets the latency budget and the next build
```

---

## 4 — THE ROTATION QUESTION

Deciles 1–2 vanish at 36.7–46.6% against 8.6–13% at deciles 7–9. `stopped`, `rotated to a fresh
address` and `blew up` are one column.

This now cuts in a direction it did not before. H1 passed, so *address* persistence is
established — but if a large share of the vanishing is rotation, H1's estimate is conditioned on
a non-random survivor set, and separately, any live copy list decays to nothing within weeks.

Walk the funding graph over `trader_id` the way `entity-links.ts` already walks it over holders.
For each vanished top-cohort wallet, ask whether its residual SOL moved to an address that then
began trading. Report:

```
vanished, funds moved to a newly-active address       -> ROTATION
vanished, funds dispersed or dormant                  -> STOPPED_OR_BLEW_UP
```

Re-run the H1 difference with rotations stitched to their successors as one entity. If H1 holds at
entity level, the copy list is durable. If it only holds at address level, it is not, and that
governs everything downstream.

This is a second-priority item. Do the lag sweep first.

---

## 5 — H2 REPAIR (THIRD PRIORITY, ONLY IF THE LAG SWEEP SURVIVES)

Do not re-run H2 as specified. Three changes:

1. **Continuous, not binary.** Replace the flag with (a) count of top-cohort wallets buying in
   the first 10 minutes and (b) sum of their fit-period scores. The median flagged mint had 80 —
   the distribution between 1 and 80 is the entire signal a boolean discarded.
2. **Selectivity per §1.1.** At `top_fraction = 0.001` the flag prevalence should fall out of
   saturation. Report prevalence before interpreting anything.
3. **Size and timing.** A top wallet buying 5 SOL at second 30 is not the same observation as one
   buying 0.05 SOL at minute 9. Carry both.

---

## 6 — FINAL REPORT

1. lag sweep table: `L` × cohort × `top_fraction` × venue, both censoring treatments
2. `copier_return / wallet_return` at every lag — the selection share
3. the largest `L` satisfying all four conditions of §3, or the statement that none does
4. implied latency budget, and what infrastructure that would require
5. rotation classification and the entity-level H1 re-run, if reached
6. credits consumed
7. ledger diff from MT079, every cell examined
8. one final state:

```
COPYABLE_LAG_IDENTIFIED       name it, and it owes a preregistered confirmatory design
EDGE_IS_EXECUTION_ONLY        ratio ~ 0 at every lag; the copy branch closes
UNDECIDABLE_CENSORING         treatments disagree in sign; no threshold search follows
```

`EDGE_IS_EXECUTION_ONLY` closes the branch honestly and is a real result. It is the most likely
outcome and reporting it is not a failure of the phase.

Do not open a window. Do not run canary or live. Do not fund a wallet.
