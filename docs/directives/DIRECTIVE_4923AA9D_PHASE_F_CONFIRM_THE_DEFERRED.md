<!--
  RECEIVED 2026-08-19 as 4923aa9d-epitaxy_phase_f_confirm_the_deferred.md, after PR #61 merged as
  21bd485. Committed VERBATIM and before execution, so that what was asked for is a fixed artifact
  and cannot be reconciled after the fact with what was delivered. Nothing in this file has been
  reworded, reordered, or summarised.

  Execution record: docs/PHASE_F_REPORT.md. Carry-forward correction: MT089. Reserve
  reconstruction and its validation bar: MT090. Entity-level H1: MT091.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE F: MEASURE THE THREE THINGS THAT WERE SKIPPED

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #61 (`21bd485`), `UNDECIDABLE_CENSORING`, copy branch closed on condition 5
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Credits: 1,069 remain of 2,500.** Target 400, stop-and-report ceiling 700, per-query 250.

---

## 0 — WHY THIS PHASE EXISTS

Three measurements were deferred because stop conditions fired, not because results settled them.
Two of them cost nothing. One of them is the thing an external interpolation tried to substitute
for, and that interpolation does not survive its own sensitivity check:

```
Phase C reported 46% of followable AMM positions unpriced at t+3600s, and that
widening the window to five minutes "admits 26% more positions" while moving the
as-priced figure from +24.45% to +5.42%.

read as multiplicative   coverage 54 -> 68   marginal -67.98%   full ~ -18.1%
read as additive points  coverage 54 -> 80   marginal -34.10%   full ~  -2.5%
```

One reading closes the branch; the other lands inside the noise. It also assumes the uncovered
positions are worse than the marginal ones, assumes linearity, and generalises a diagnostic to a
primary estimate. **None of that is measured.** §2 measures it.

Nothing in this phase is a new hypothesis. Every item was already specified and already skipped.

---

## 1 — CARRY-FORWARD ON THE PHASE B PRE-MIGRATION MEANS (NO CREDITS, DO THIS FIRST)

The T1–T5 conditional means of +193.2% to +341% on pre-migration bonding-curve tokens are the only
positive figures this programme has produced. Holdout censoring on T1 was **94%** — the mean rests
on roughly 68 of 1,140 mints that still had a price an hour later.

D70B4A9A already established the correction machinery: at 34.5% censoring, carry-forward moved the
2m–60m cohort from +3.04% to +2.85%. Phase E established that at 34.5% censoring a `ret_carryfwd`
mark manufactured a 3–6× gap that **reversed sign** when measured on closed positions only.

Apply carry-forward to every Phase B trigger mean, on stored data:

```
per trigger T0-T7, per tier, per notional:
  n fired
  n with observable exit
  censoring fraction
  as-reported mean
  carry-forward-corrected mean
  residual-at-zero mean
  day-clustered 95% interval on the corrected mean
```

**Do not interpret the direction in advance.** Phase E is an argument for measuring this, not a
prediction of its result, and the report must not cite Phase E as though it settled it.

Report the corrected means against the tier-appropriate cost floor. Bonding-curve entries pay the
flat 1.25% per leg with no tier relief, so the applicable floor is 2.50% plus impact.

---

## 2 — THE RESERVE MARK ON PHASE C'S ESTIMAND

Phase C's estimand — a fixed t+3600s exit, not the wallet's — cleared condition 1 on 12 of 24
cells at +17.22% to +30.56% net, lower bounds +1.24% to +11.94%, and failed only condition 2. It
is the single cell in the copy design space that has never been evaluated at honest coverage.

### 2.1 Reconstruction

A constant-product pool's reserves follow from an initial state and the sequence of swaps against
it. Every swap in `dex_solana.trades` carries both leg amounts, so reserves can be rolled forward
and a price computed at **any** timestamp, including ones with no trade — which is exactly the 46%.

### 2.2 The anchor is the technical risk — state it, do not assume it

Rolling forward requires one absolute reserve observation per pool. Rank the options and report
which was used per pool:

```
A  the collector's own stored pool bytes, where a snapshot exists     (413 snapshots, 142 pools)
B  the migration deposit, if it is a protocol constant for the era covered
C  pool creation state from the initialising transaction
```

If no anchor exists for a pool, that pool is **excluded and counted**, not estimated.

### 2.3 Validate before any use at scale

Reconstruct reserves for the 142 pools where real on-chain bytes are held and compare. Report:

```
ratio distribution reconstructed:stored, p10 / p50 / p90
fraction agreeing within 1%
count of pools showing a discontinuity in k (liquidity event) -> excluded, not smoothed
```

**Do not use the reconstruction at scale unless p50 is within 1% and agreement exceeds 95%**, the
same bar the provider market-cap check cleared at p50 1.000 / 98.4%. If it fails, report the
failure and stop — a reconstruction that cannot reproduce known bytes cannot price unknown ones.

### 2.4 Re-evaluate

Re-run Phase C's four conditions with every position priced. Report:

```
coverage before and after
the as-priced, censored-at--100%, and reserve-marked figures side by side
which of the four MT079 conditions each cell now passes
the realised value of the marginal and previously-uncovered positions
```

That last line is the direct measurement of the quantity the interpolation guessed at. Report it
whatever it says.

---

## 3 — ENTITY-LEVEL H1 (ONLY IF CREDITS REMAIN AFTER §2)

H1 is an address-level result. Phase C measured rotation at 4.5–5.3% fresh-address and 12–16%
loose, flat across deciles, on a scan that cost 218 credits because `sol_transfers` is not
partition-prunable by a wallet set.

This is the one unmeasured item in the closing account that could move a number **up**. Stitch
rotated successors to their predecessors as one entity and re-run the H1 difference.

Report the share of *positions* the successors contribute, not just the share of wallets — Phase C
flagged that the direction and size of any correction is unknown precisely because activity level
was unmeasured.

If §2 consumes more than 450 credits, do not start this. Report it as still deferred.

---

## 4 — WHAT THIS PHASE MAY NOT DO

- No new triggers, no new cohorts, no new size definitions. The size dimension closed on its own
  preregistered criterion in MT088 and stays closed.
- No re-running of the proportional exit. Condition 5 failed and no threshold search follows.
- No reinterpretation of Phase D's 3–6× gap. Phase E asserted the correction as a test; it stands.
- No estimate presented where a stop condition fired. Deferred is deferred, and is reported as
  such.

---

## 5 — FINAL REPORT

1. §1 carry-forward table, corrected means against the bonding-curve floor, with intervals
2. §2.3 validation figures, before any §2.4 result
3. §2.4 re-evaluation, three pricings side by side, with the measured value of the previously
   uncovered positions stated explicitly
4. §3 if reached, or the statement that it was not
5. credits per query
6. ledger diff, every cell examined
7. one final state per branch:

```
PRE_MIGRATION:  SURVIVES_CARRY_FORWARD | COLLAPSES_UNDER_CARRY_FORWARD | UNDECIDABLE
PHASE_C_CELL:   COPYABLE_LAG_IDENTIFIED | NO_COPYABLE_LAG | RECONSTRUCTION_FAILED_VALIDATION
```

A branch that comes back positive owes a preregistered confirmatory design and is **not**
permission to trade. A branch that comes back negative is a measured close, and replaces an
inference that was never entitled to the word.

Do not open a window. Do not run canary or live. Do not fund a wallet.
