<!--
  RECEIVED 2026-08-19 as 33d303b9-epitaxy_phase_e_proportional_exit_directive.md, after PR #60
  was opened. Committed VERBATIM and before execution, so that what was asked for is a fixed
  artifact and cannot be reconciled after the fact with what was delivered. Nothing in this file
  has been reworded, reordered, or summarised.

  Execution record: docs/PHASE_E_REPORT.md. Per-query limit raise: MT086. Decision rule: MT087.
  Inverted size arm: MT088.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE E: MIRROR THE FRACTION, NOT THE EVENT

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #60, `UNDECIDABLE_CENSORING`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Credits: 1,314 remain of 2,500.** Target 400, **stop-and-report ceiling 550**. Per-query limit
250 — raised from 150 because Phase D established that the two-sided join genuinely costs 230 and
cannot be calendar-bounded, not because 150 was inconvenient. Record the raise as MT086 with that
reason before running.

This is close to the last substantive question the remaining budget supports. Choose the arms
accordingly and do not spend on comparison venues.

---

## 0 — WHAT PHASE D SETTLED

- **The coverage fix worked.** Conditional on the wallet selling, 85–95% of positions have both
  legs priced. Phase C's pricing gap is closed. The residual is a holding-period gap (10.9–38.8%
  never sold), which is a property of the wallets.
- **The exit leg is expensive and was never charged before.** −6.24% mean / −0.75% median at 2s.
  Follower penalty +16.83% [+12.87%, +21.86%], 30/30 days paired.
- **The dominant loss is not slippage.** The wallet's realised return is 3–6× its first-sell
  return. A copier that treats the first observed sell as a full exit forfeits that before paying
  a single basis point of slippage.
- **MT084 is not supported and is adverse.** Median own impact 0.92–2.71%; a 1% gate slices the
  body, declines 51.3%, and cuts +6.22% to +1.68%. The wallet's higher-impact entries are among
  its better ones.

The best reportable primary cell is **+6.07% [−0.66%, +14.16%]**. The lower bound misses zero by
0.66 points.

---

## 1 — THE PRIMARY ESTIMAND: PROPORTIONAL EXIT MIRRORING

### 1.1 Construction

Track each wallet's cumulative token position per mint from its buys. For every sell at `T_k`:

```
fraction_k = tokens_sold_k / tokens_held_before_k
```

The copier holds a position opened at `T_buy + L` and, at each `T_k + L`, sells `fraction_k` of
**its own** remaining tokens, priced at the VWAP of trades in `[T_k + L, T_k + L + 60s]`.

The position closes when the wallet's holding reaches zero. Copier return is the SOL-weighted
round trip across all legs, net of the tier floor on each leg.

`L ∈ {2s, 15s, 60s}` — three lags, not six. Phase C established the decay knee is in minutes and
the budget does not support six.
`top_fraction ∈ {0.001, 0.01}`, both ranking cohorts, `entry_project = pumpswap` only.

### 1.2 The control is Phase D, not a new baseline

Report the **binary first-sell exit** on the identical position set, at the identical lags, in the
same table. The comparison that matters is proportional-minus-binary as a paired difference on the
same drawn days, because that isolates the one thing this phase changes.

If proportional does not beat binary on a paired lower bound, nothing else in this phase matters
and the report should say so in its first paragraph.

### 1.3 What a copier can and cannot know

`fraction_k` is computable in real time from the public tape: cumulative buys minus cumulative
sells, both observable. This is not lookahead.

What **is** lookahead and must not enter: the number of future sells, the wallet's eventual total,
or whether a given sell turns out to be the last. Assert this by test — the estimand must be
computable from a prefix of the tape ending at `T_k`.

### 1.4 Residual censoring, unchanged treatments

```
closed-only          wallet's position reached zero; count reported
open-at--100%        wallet still holding at window end; copier's residual at -1.0
open-at-reserve-mark if §3 runs
```

Condition 2 applies across `closed-only` and `open-at--100%`.

---

## 2 — THE INVERTED SIZE ARM (CHEAP, THE DATA IS ALREADY JOINED)

MT084 gated *out* high-impact entries and made the result worse. Test the inversion.

```
UNGATED              all positions
CONVICTION_WEIGHTED  weight each position by the wallet's own entry impact
CONVICTION_GATED     keep only positions where wallet's entry impact >= 3% of reserves
```

Freeze the 3% threshold before running. Report the kept fraction at each arm. If size is a
conviction signal rather than a cost source, the gated arm should improve on ungated — and if it
does not, MT084's inversion is also unsupported and the size dimension closes for good.

---

## 3 — RESERVE MARK (ONLY IF THE §1.2 PAIRED DIFFERENCE IS POSITIVE AND CREDITS ALLOW)

Unchanged from Phase D §2, including the 142-pool validation requirement: p50 ratio within 1%,
agreement above 95%, both recorded, before any use at scale.

Do not run this if the paired difference in §1.2 fails. Resolving censoring on an estimand that
has already lost to its own control spends credits to sharpen a number that is not going anywhere.

---

## 4 — DECISION RULE — MT087, FROZEN BEFORE THE FIRST EXECUTION

```
1. copier_return(L) day-clustered 95% lower bound > 0, net of the tier floor on every leg
2. closed-only and open-at--100% AGREE IN SIGN
3. entry_project = pumpswap
4. n >= 7.84 x CV_observed squared, on the proportional round-trip return
```

Plus, new and gating:

```
5. proportional-minus-binary paired difference lower bound > 0
```

Condition 5 exists so that a proportional arm that passes 1–4 by accident, on a different position
set or a lucky window, cannot be reported as an improvement it did not produce.

No threshold search follows any failure. Do not relax condition 4 if the multi-leg exit lowers
dispersion; recompute CV on the new estimand as Phase D correctly did.

---

## 5 — FINAL REPORT

1. the §1.2 paired difference, proportional minus binary, first — before any absolute figure
2. coverage: closed / open / both-legs-priced, per arm, before any return figure
3. the return table: `L` × cohort × `top_fraction` × size arm, both censoring treatments
4. per-leg slippage under multi-leg exit — more legs means more slippage events, and whether that
   offsets the recovered fraction is the phase's second question
5. the fraction of the 3–6× first-sell-to-realised gap actually recovered
6. §2 results and kept fractions
7. credits per query
8. ledger diff from MT086, every cell examined
9. one final state:

```
COPYABLE_LAG_IDENTIFIED    all five conditions hold at some L; owes a preregistered
                           confirmatory design and a required n on the copier's CV
NO_COPYABLE_LAG            conditions fail with treatments agreeing in sign
UNDECIDABLE_CENSORING      treatments disagree; report coverage and stop
```

If the state is `NO_COPYABLE_LAG`, write the closing account: the follower penalty, the
first-sell gap, the recovered fraction, and what remains unmeasured. That document is the
deliverable, and it is worth more than another phase.

`COPYABLE_LAG_IDENTIFIED` is not permission to trade. It is permission to design a confirmatory
window, which is a separate directive and a separate decision.

Do not open a window. Do not run canary or live. Do not fund a wallet.
