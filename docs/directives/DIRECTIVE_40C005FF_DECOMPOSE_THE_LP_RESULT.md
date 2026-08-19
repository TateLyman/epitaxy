<!--
  RECEIVED 2026-08-19 as 40c005ff-epitaxy_decompose_the_lp_result.pdf, immediately after PR #66
  merged.

  THIS IS A TRANSCRIPTION, NOT THE ORIGINAL BYTES. The source is a PDF and this repository's
  convention for PDF directives is to transcribe faithfully and mark what the PDF lost rather
  than to reconstruct it. Two losses are marked inline with [PDF LOST: ...]. The first is a
  single glyph — a multiplication sign in "~50x difference" — whose identity the surrounding
  text fixes. The second is a real layout artifact in §5's state table, where three state names
  and their descriptions were emitted as two separate column runs and came back interleaved
  against the wrong rows; the only reading the text admits is given, with the reasoning, and the
  raw extracted ordering is preserved beside it so a later reader can check the reconstruction
  rather than trust it.

  The extractor's glyph substitutions for em-dashes, section signs and list bullets have been
  restored to their evident intent, and nothing else has been reworded, reordered or summarised.
  The two definition blocks in §1 and §2 were laid out as aligned columns; they are rendered here
  as definition lists with the same pairings and no change of content.

  The original PDF is at
  C:\Users\lyman\.claude\uploads\c257a710-620c-44df-97b1-550f4354341c\40c005ff-epitaxy_decompose_the_lp_result.pdf

  Execution record: docs/LP_DECOMPOSITION_REPORT.md.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY: DECOMPOSE THE LP RESULT

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #66, `FEE_ON_FLOW_SURVEYED`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, claiming profitability. `MEASUREMENT_ONLY`.

**Credits: 0.** Everything here runs on `trajectory_marks` and the stored trade tape. If any step
appears to need a Dune query, stop and report instead — the whole point is that the number is
already held.

## 0 — WHAT #66 ESTABLISHED AND WHAT IT DID NOT

**Established:** on PumpSwap, LP − HODL is −0.278% over 377 clean pools in under an hour, −1.674%
on the 61 pools that moved more than 10%, and the LP beat holding in 8.0% of cases. The worst
cases are symmetric in direction and quadratic in size, which is loss-versus-rebalancing and
carries no drift term.

**Not established:** anything about venues with a different fee split. PumpSwap tier 0 pays the LP
2 of 125 bps — 1.6% of the fee, and 392 of 405 trajectories sit in that tier. Raydium's AMM pools
pay LPs 0.22% of a 0.25% fee (88%); its CPMM and CLMM pools pay LPs 84% of the trading fee. That
is a ~50[PDF LOST: a single glyph between "50" and "difference" did not survive extraction; the
surviving text reads "~50 difference"] difference in the LP's share, and the measurement covered
only the extractive end.

The −0.278% is a difference of two terms that were never separated. `fee_income − LVR`. A small
fee term minus a large LVR term, and a large fee term minus the same large LVR term, are different
questions with the same reported answer.

## 1 — SEPARATE THE TWO TERMS

For each of the 377 clean pools, over the same window used in #66, compute directly from the
stored tape and reserve path:

- **`V`** — total swap volume through the pool, in SOL
- **`L`** — pool liquidity, in SOL-equivalent, at window open
- **`turnover`** — `V / L`
- **`fee_income`** — `V x 0.0002 / L`, the LP's actual take at tier 0, as a fraction of pool value
- **`LVR_implied`** — `fee_income - (LP - HODL)`, backed out, not modelled
- **`sigma_hour`** — realised volatility of the price path over the window

Do not use the sigma-squared-over-eight formula to produce LVR. Back it out from the measured
LP − HODL, which is ground truth and carries no model risk. Report the closed-form value beside it
only as a consistency check, and report the discrepancy if they disagree.

Report turnover at p10 / p50 / p90. **That distribution is the finding, whichever way it runs.**

## 2 — RESCALE THE FEE TERM ONLY

```
LP_HODL(f) = (f / 0.0002) x fee_income - LVR_implied
```

Evaluate at:

- **`0.0002`** — PumpSwap tier 0 (the measured case, must reproduce −0.278%)
- **`0.0021`** — Raydium CPMM / CLMM, 84% of 0.25%
- **`0.0022`** — Raydium AMM v4, 0.22% of 0.25%

The tier-0 case reproducing −0.278% exactly is the correctness check on the whole decomposition.
**If it does not reproduce, the decomposition is wrong and nothing downstream is valid.**

Report per-pool and pooled, with the same stratification #66 used: all clean pools, pools that
moved at all, pools moving >10%.

## 3 — THE INTERVAL PROBLEM IS UNCHANGED AND MUST BE RESTATED

MT099 recorded that #66's 377 trajectories fall on two days, so a day-clustered resample has two
clusters and only the point estimate stands. That limitation carries forward in full. This
directive changes the fee coefficient, not the sample. Every figure produced here inherits the
same defect and the report must say so in the same words.

A rescaled point estimate on two clusters is a hypothesis worth testing, not a result. Label it
that way.

## 4 — WHAT THIS CANNOT SETTLE, AND MUST SAY

Even a strongly positive rescaled figure would not establish that LP is viable, because:

- **The population is wrong.** These are PumpSwap pools. Raydium CPMM pools are LaunchLab and
  Bonk.fun graduations — a different population with different volatility and turnover. The
  rescaling asks whether the mechanism *could* clear at a normal fee share, not whether it *does*
  on the venue that pays it.
- **Two days.** See §3.
- **Entry and exit are unpriced.** Becoming and ceasing to be an LP has its own cost, unmeasured.
- **Total loss is not IL.** A pool whose token dies leaves the LP holding it. #66's worst case was
  −21.30% at a −87.9% move; the tail is the risk, and rescaling a fee term does not touch it.

If §2 comes back positive, the honest next step is a new measurement on actual Raydium CPMM
memecoin pools over more than two days — **not a conclusion**.

## 5 — FINAL REPORT

1. the turnover distribution, p10 / p50 / p90 — before any rescaled figure
2. `fee_income` and `LVR_implied` separately, pooled and stratified
3. the tier-0 reproduction check against −0.278%
4. §2's rescaled table at all three fee shares
5. the §3 restatement of the two-cluster limitation, in full
6. one final state:

<!--
  [PDF LOST: layout artifact. The three state names and their descriptions were emitted as two
  separate column runs and came back interleaved against the wrong rows. The raw extraction reads,
  line for line:

      MECHANISM_CLEARS_AT_NORMAL_FEE_SHARE  owes a real measurement on the right venue
      MECHANISM_FAILS_AT_ANY_FEE_SHARE      over a real number of days; not a result
      DECOMPOSITION_FAILED                  fee income is too small relative to LVR for any
                                            observed split to close it; LP closes for good
                                            tier 0 did not reproduce -0.278%

  Five description lines against three states. The reconstruction below is the only reading the
  text admits: lines 1-2 are one sentence ("owes a real measurement on the right venue over a real
  number of days; not a result") and belong to the CLEARS state, since only a clearing result could
  owe a further measurement; lines 3-4 are one sentence and belong to FAILS, since only a failure
  closes LP for good; line 5 is the DECOMPOSITION_FAILED condition and matches §2's stated
  correctness check verbatim. The pairing is reconstructed, not extracted.]
-->

| state | condition |
|---|---|
| `MECHANISM_CLEARS_AT_NORMAL_FEE_SHARE` | owes a real measurement on the right venue over a real number of days; not a result |
| `MECHANISM_FAILS_AT_ANY_FEE_SHARE` | fee income is too small relative to LVR for any observed split to close it; LP closes for good |
| `DECOMPOSITION_FAILED` | tier 0 did not reproduce −0.278% |

The author of the hypothesis being tested here has been wrong about LP economics twice in one day —
once on the fee split and once on the theory. **Weight the measurement, not the framing that
produced it.**

Do not open a window. Do not run canary or live. Do not fund a wallet.
