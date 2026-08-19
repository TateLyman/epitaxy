# WALLET PERSISTENCE — EXECUTED RESULTS

2026-08-19. The two preregistered hypotheses MT073 (H1) and MT074 (H2), run on Dune
against `dex_solana.trades`, with every interval computed offline by this repo's own
day-clustered bootstrap.

**One-line state: `H1_CONFIRMED_H2_UNDECIDABLE_NEITHER_TRADABLE`.**

H1 passes on the preregistered cut and on the robust cut and on every adversarial
re-cut of it. H2 has no answer on this data. Neither result licenses a position,
and §7 is the part of this document that matters most.

---

## 0 — WHAT RAN

| query | id | execution | what it establishes |
|---|---|---|---|
| schema probe | — | — | column names in `dex_solana.trades`, confirmed, not assumed |
| Q1 reconstruction sanity | 8381175 | (four iterations) | the position reconstruction is estimable; two defects found and fixed |
| Q2 fit deciles, mean cut | 8381177 | `01M0D9EK3GJKQHFXVMY6KNM082` | the decile gradient and the disappearance rates |
| Q2 fit deciles, median cut | 8381294 | `01M0D9JFPTQBPJ02VSYZ9G9JJA` | the same gradient with the contaminated statistic removed |
| Q3 holdout day panel | 8381178 | `01M0DAPQVCY7APVASATB64NT3V` | H1's per-(day, cohort, project) sufficient statistics |
| Q4 token forward return | 8381179 | `01M0DAX9Z32GTK0GVPYG3PSB2E` | H2's per-(day, cohort, venue) statistics |

589.26 of 2,500 monthly credits. Results committed under `ops/dune/results/`;
the SQL is one sectioned source, `ops/dune/wallet-persistence.sql`, composed by
`pnpm dune:assemble` so that what ran and what is in version control are the same
artifact. Nothing was hand-assembled.

Windows: fit 2026-06-01 → 07-15, holdout 2026-07-16 → 08-15, disjoint. 211,225
wallets qualified with ≥20 fit positions; each decile is 21,122–21,123 wallets.
Holdout estimation set: 11.85M positions over 30 days.

The analyses:

```
pnpm wallet:interval    MT073 H1, from ops/dune/results/q3-holdout-day-panel.json
pnpm token:h2           MT074 H2, from ops/dune/results/q4-token-forward-return.json
```

---

## 1 — THE INSTRUMENT HAD TO BE REPAIRED FIRST, TWICE

**Dust denominators.** A return of `sol_out / sol_in − 1` with `sol_in` at 1e-9 SOL
is unbounded. Before the fix, the FIT-window mean was +36.26 with an SD of 22,566.
`min_sol_in = 0.01` was frozen and the mean fell to interpretable. Positions below
it are counted (`below_min_size`) and excluded, at 3.4–5.6% by cohort.

**Broken residual marks.** Open positions were marked at a per-mint residual price
that was 6–7 orders of magnitude wrong on some rows, because WSOL/WSOL trades were
being used as a price source. Fixed by excluding WSOL-both-sides rows, requiring a
liquid mark window (`mark_min_trades = 5`, `mark_min_sol = 1.0`), and returning
NULL rather than a zero mark when no mark exists. Those NULL rows are `unmarkable`
and are excluded from the estimate and counted beside it — see §4, because their
rate is not the same in every cohort and that is the one exclusion that could have
manufactured the result.

After both repairs the FIT pumpswap mean is still contaminated (+2.53, SD 45.45)
while every median and percentile is stable. So: **no level read off a pumpswap
mean in Q1 is trustworthy**, which is exactly why the fit ranking is reported on
both the mean and the median.

---

## 2 — Q2: THE GRADIENT IS MONOTONE, AND SO IS ITS MIRROR IMAGE

Holdout mean return per position by fit decile. Left: deciles cut on the fit
**mean** (the preregistered statistic). Right: cut on the fit **median** (immune
to a single broken mark).

| decile | vanish% | hold mean | hold median | SOL-wtd | | vanish% | hold mean | hold median | SOL-wtd |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 36.7% | **+0.2483** | −0.0337 | +0.2026 | | 40.3% | **+0.1146** | **+0.0092** | +0.0921 |
| 2 | 41.8% | −0.0052 | −0.0833 | +0.0018 | | 46.6% | +0.0612 | −0.0435 | +0.0712 |
| 3 | 42.9% | −0.0549 | −0.1195 | −0.0457 | | 36.6% | −0.0225 | −0.1135 | −0.0181 |
| 4 | 35.6% | −0.1152 | −0.1714 | −0.0784 | | 32.5% | −0.1043 | −0.1731 | −0.0723 |
| 5 | 28.3% | −0.1708 | −0.2366 | −0.1063 | | 27.1% | −0.1642 | −0.2468 | −0.0975 |
| 6 | 20.3% | −0.2265 | −0.2933 | −0.1292 | | 18.9% | −0.2166 | −0.3109 | −0.1235 |
| 7 | 13.0% | −0.2600 | −0.3321 | −0.1363 | | 13.2% | −0.2657 | −0.3444 | −0.1380 |
| 8 | 9.3% | −0.2742 | −0.3555 | −0.1330 | | 9.7% | −0.2711 | −0.3566 | −0.1313 |
| 9 | 8.6% | −0.2890 | −0.3666 | −0.1440 | | 9.8% | −0.2850 | −0.3703 | −0.1410 |
| 10 | 14.8% | −0.3703 | −0.4902 | −0.2756 | | 16.7% | −0.3572 | −0.5069 | −0.2739 |

Three things to read here, in the order the review said to read them.

**The two rankings disagree about half the top decile.** 10,859 of the 21,123
mean-ranked top-decile wallets are not in the median-ranked top decile. The
gradient survives anyway, and under the median cut decile 1's holdout **median** is
positive (+0.92%) — the typical position of a top wallet gains, not just the
average. A median cannot be moved by one bad mark in a 20-position wallet, so this
retires the contamination threat rather than arguing about it.

**Disappearance is worst at the top and it is not monotone.** 36.7%/41.8% of
deciles 1–2 stop trading in the holdout, against 8.6–13% at deciles 7–9. The
wallets worth copying are the ones most likely to be gone. `vanish_rate` conflates
*stopped*, *rotated to a fresh address*, and *blew up*, and this dataset cannot
separate them; pump snipers rotate constantly and rotation reads exactly like a
blow-up.

**Decile 10 vanishes more than deciles 7–9** (14.8–16.7% vs 8.6–13%) while
returning −37%. Something is selecting for both tails.

---

## 3 — H1: THE PREREGISTERED TEST PASSES

MT073's rule: *mean return per position in the holdout, top decile minus the rest,
on a day-clustered 95% lower bound*, with the decile ranked on the fit mean and the
median reported beside it. 30 days, 10,000 resamples, days resampled with
replacement and both cohorts taken from the same drawn days.

```
PREREGISTERED (fit MEAN cut)        +36.74%   [+33.57%, +40.03%]   lower bound > 0: YES
REPORTED BESIDE IT (fit MEDIAN cut) +12.67%   [+11.38%, +14.00%]   lower bound > 0: YES
```

**H1 is not rejected.** Both cuts, same direction, lower bounds far from zero.

Composition of the estimation set, and every exclusion rate that produced it:

| cohort | kept n | ext inflow | dust | **unmarkable** | closed | positive | mean ret |
|---|---|---|---|---|---|---|---|
| TOP_BOTH | 978,728 | 11.13% | 4.87% | **4.67%** | 92.0% | 62.7% | +26.51% |
| TOP_MEAN_ONLY | 1,041,350 | 5.68% | 4.34% | **1.72%** | 87.2% | 36.7% | +39.09% |
| TOP_MEDIAN_ONLY | 1,305,555 | 2.78% | 3.44% | **0.06%** | 98.0% | 53.6% | +2.43% |
| REST_NEITHER | 8,525,088 | 5.98% | 5.61% | **0.28%** | 93.3% | 33.4% | −4.70% |

`TOP_MEAN_ONLY` earns +39.09% on a **36.7% win rate** — barely above
`REST_NEITHER`'s 33.4%. That cohort's mean is a tail, and the mean ranking selects
for wallets with fat right tails, which is self-consistent but is not the same
claim as "these wallets are better". `TOP_MEDIAN_ONLY` earns +2.43% on a 53.6% win
rate: a smaller, steadier edge. The preregistered statistic and the robust one are
finding two genuinely different kinds of wallet, and both beat the rest.

The full battery, both cuts (`pnpm wallet:interval` prints all of it):

| | MEAN cut | MEDIAN cut |
|---|---|---|
| top level, gross | +32.99% [+29.61, +36.59] | +12.74% [+11.71, +14.11] |
| top level, net of the 2.69% floor | +30.30% [+26.92, +33.90] | +10.05% [+9.02, +11.42] |
| rest level, gross | −3.75% [−4.47, −2.90] | +0.07% [−0.99, +1.28] |
| difference, SOL-weighted | +25.59% [+23.49, +27.77] | +19.55% [+18.25, +20.76] |
| difference, closed positions only | +17.94% [+17.35, +18.53] | +13.83% [+13.37, +14.28] |
| difference, unmarkable back at −100% | +32.12% [+29.11, +35.22] | +10.37% [+9.14, +11.68] |
| top level, unmarkable dead, net of floor | +25.41% [+22.27, +28.76] | +7.27% [+6.23, +8.53] |
| difference, unsold remainder worthless | +13.73% [+13.07, +14.38] | +16.32% [+15.82, +16.81] |
| difference, pumpdotfun entries | +35.46% [+32.26, +38.73] | +12.15% [+10.84, +13.56] |
| difference, pumpswap entries | +40.36% [+25.63, +57.08] | +14.48% [+10.55, +19.14] |
| per-day difference positive | 30/30 days | 30/30 days |
| difference, dropping the best day | +36.23% [+33.07, +39.48] | +12.28% [+11.19, +13.40] |

---

## 4 — THE FOUR WAYS THIS COULD HAVE BEEN AN ARTIFACT, AND WHAT KILLED EACH

**A ranking that saw the future.** The delivered SQL aggregated each position over
both windows, so the fit ranking was computed partly from holdout sells and from a
carry-forward mark taken up to two months after the fit window closed. Fixed before
anything ran: positions are window-scoped, and the windows are disjoint. This was
the largest defect in the delivered version and it would have produced exactly this
result out of nothing.

**A broken mark doing the ranking.** Retired twice over: the median-ranked cut
gives the same answer, and the **closed-only** cut — positions where the wallet
sold ≥99% of what it bought, so no mark enters the return at all — gives +17.94%
and +13.83%. 92–98% of the estimation set is closed, so this is not a corner of the
data.

**Differential exclusion.** The top cohorts lose more positions to unmarkability
than the rest does — 4.67% and 1.72% against 0.28%, a factor of 6 to 17. Dropping
them is therefore not neutral. Adding every unmarkable position back at **−100%**,
deliberately over-conservatively (the count includes rows also excluded as dust or
externally funded, so more −100% rows go back to the top cohorts than were ever
dropped from them), still leaves +32.12% and +10.37%, and the top level still
clears the cost floor at +25.41% and +7.27%.

**One good day, or one good token.** The difference is positive on **30 of 30
days**, and dropping the single best day moves it by 0.5 and 0.4 points. What is
*not* checkable from this panel is fragility to individual positions, because
per-day (n, sum) cannot express "drop the best 5 positions" — and for the
mean-ranked cut, whose win rate is 36.7%, that is the fragility that matters. The
median-ranked cut, at a 53.6–62.7% win rate, does not depend on it in the same way.

One exclusion channel remains unbounded: **external inflow**, 11.13% of TOP_BOTH
against 5.98% of the rest. Those positions have tokens arriving from somewhere
other than a WSOL swap, so `sol_in` is not the cost basis and no return can be
computed for them at all — not conservatively, not adversarially. They are simply
absent, at twice the rate in the top cohort.

---

## 5 — H2: NOT DECIDABLE, AND IT FAILS SELECTIVITY BEFORE IT GETS THERE

MT074 asked whether a top-decile wallet buying inside a token's first 10 minutes
predicts that *token's* forward return, t0+10m mark to t0+70m mark. This is the
version that becomes a screening feature and needs no latency race, so it is the
one that maps onto this apparatus.

**It fails before the return is even consulted.** The flag is set on **82.6% of all
85,615 holdout mints**, and the median flagged mint had **80 distinct flagged
wallets** buy inside its first ten minutes. The threshold is the top 10% of 211,225
qualifying wallets — 21,123 addresses — and a launch has hundreds of early buyers.
A feature set on four of every five tokens cannot admit a subset of them.

| cohort | mints | share | censored | priced | median early flagged buyers |
|---|---|---|---|---|---|
| TOP_BOTH | 64,027 | 74.8% | 82.2% | 11,421 | 80 |
| TOP_MEAN_ONLY | 6,699 | 7.8% | 77.5% | 1,508 | 16 |
| TOP_MEDIAN_ONLY | 2,429 | 2.8% | 83.8% | 393 | 19 |
| RANKED_NOT_TOP | 7,309 | 8.5% | 92.5% | 548 | 6 |
| NO_RANKED_WALLET | 5,151 | 6.0% | 91.7% | 430 | 2 |

**And the outcome is censored 77–93% of the time.** A mint has no exit price
because nobody traded it in the t0+70m..t0+72m window — which is the most
informative outcome in the dataset and the one an `AVG` silently drops. So every
statistic is computed twice: *as priced* (censored excluded, what an AVG reports)
and *dead* (censored entered at −100%, bounding the survivor bias). On the AMM side,
the enterable one:

| treatment | TEST A: top − no-ranked-wallet | TEST B: top level vs 2.69% |
|---|---|---|
| as priced | +37.2% [+10.4, +70.3] — passes | +58.2% [+32.4, +92.3] — passes |
| dead | −16.8% [−30.1, −0.8] — fails | −40.9% [−50.5, −28.7] — fails |

**The two treatments disagree in sign, so H2 has no answer on this data.** The
disagreement is not noise: censoring is correlated with the flag (flagged launches
are bigger and survive to the exit mark more often), which is precisely the
survivor bias that makes the *as priced* column meaningless on its own. The median
of the per-day medians points the other way from the *as priced* mean — top −20.1%
against control +16.9%.

The point estimates are not usable numbers regardless. The largest cell mean is
+451,244% on **one** mint: a ratio of two 2-minute VWAPs on a near-zero-volume
token is unbounded above and floored at −100%, so a cell mean is a tail draw.

**H2 is rejected as a decision and recorded as undecidable as a measurement.** No
threshold search follows. Tuning the decile depth or the flag window after seeing
this table is exactly the search MT071 counted the cost of, and it would be
outcome-driven.

---

## 6 — DEVIATIONS FROM PREREGISTRATION, EACH WITH ITS REASON

Recorded because a deviation nobody wrote down is indistinguishable from a search.

1. **The median-ranked cut was added beside the mean-ranked one, and both are
   reported.** MT073 froze the mean with the median "reported beside it", which is
   what happened; the reason it mattered is measurement, not outcome — Q1 found the
   mean of `ret_carryfwd` contaminated. Both are in the ledger and the preregistered
   one is named as the test. Recorded as MT076.
2. **Q3 returns per-(day, cohort) sufficient statistics instead of the raw panel.**
   A day-clustered bootstrap of a mean is a function of (n, sum) alone, so this is a
   change of representation, asserted exactly by a unit test against the same
   `clusterBootstrap` Phase B used. What it costs: no bootstrap of a median, and no
   drop-the-best-position fragility. Cost-driven. MT077.
3. **Three post-Q1 parameters were frozen after looking at Q1's output**:
   `min_sol_in = 0.01`, `mark_min_trades = 5`, `mark_min_sol = 1.0`. All three are
   availability-driven — they are the conditions under which a price exists at all —
   and all three were fixed before any decile or holdout number was read. MT078.
4. **H2's cohort became five-way** (from three) so one export answers both flag
   definitions. Structural, no threshold moved.

---

## 7 — WHAT H1 DOES NOT LICENSE

H1 is a strong, robust, out-of-sample result about wallet identity. It is not a
strategy, and the distance between the two is the whole content of this section.

**The return is measured at the wallet's own fill, in the pool the wallet just
moved.** A copier is behind it by construction: it sees the buy after it lands,
quotes after that, and lands after that, against the impact the wallet caused. This
apparatus has never measured its own quote-to-land slippage, and crowding is
UNKNOWN (MT072). Both bite hardest exactly here. **+36.74% is the wallet's number,
not ours, and nothing in this dataset can convert one into the other.**

**The estimate is conditional on the wallet still being there.** A wallet
contributes holdout positions only if it traded in the holdout, and the top deciles
vanish fastest (36.7–46.6%). That is the right conditional for a copier — you can
only follow a wallet that trades — but it is not the cohort's unconditional return,
and it means the followable population turns over by a third to a half per month.

**Persistence OF ADDRESSES is what was measured.** Rotation, stopping and blowing
up are one column. The corroborating step is a funding-graph walk over `trader_id`
the way `entity-links.ts` already walks it over holders; until that runs, "skill
persists" is not what the data says.

**Selectivity for entries has not been demonstrated.** H1 says which *wallets* are
better. The apparatus admits *tokens*. H2 was the bridge and it is undecidable, so
the bridge does not exist yet at this threshold.

**Nothing here is corroborated locally.** The nearest local evidence points the
other way: the collector's own executable marks put the median hour-old position at
−2.7% of notional, and Phase B found 81 tradable cells with positive point
estimates and zero that survived a lower bound. This result is from a different
population (wallets, not this system's admissions) measured by a different
instrument (Dune reconstruction, not our own quotes).

No mode changed. No gate moved. No wallet was funded, nothing was signed, and no
threshold in `packages/strategy` or `packages/execution` was touched by any of
this.

---

## 8 — WHAT WOULD ACTUALLY SETTLE IT, IN ORDER OF COST

1. **A sharper flag, preregistered before it runs.** The top decile is 21,123
   addresses and is not selective. The candidates are a top-0.1% cut, a count of
   flagged buyers rather than presence, or flagged *size* — but each is a new
   hypothesis with its own ledger row and its own hold-out, not a re-read of this
   table. ~60 credits each on Dune.
2. **The funding-graph walk over `trader_id`**, to split rotation from death. Until
   this runs, the disappearance column cannot be interpreted and it is the largest
   qualitative unknown in H1. Local code exists for the holder case.
3. **Our own fill, measured in observe mode.** The one thing that converts a
   wallet's return into ours is our own executable quote against a flagged token, at
   the moment the flag fires, with the fill we would actually get. That needs a
   flagged-wallet list in the collector and costs nothing but observation time — no
   capital, no mode change. This is the only item on the list that closes the gap in
   §7's first paragraph, and it is where the next effort belongs.
4. **Only then** is there a question about capital, and it would still start from
   the `pnpm paper` path with a preregistered rule, not from a canary.

---

## 9 — FINAL STATE

`H1_CONFIRMED_H2_UNDECIDABLE_NEITHER_TRADABLE`

Wallet performance persists across disjoint windows, at +36.74% [+33.57%, +40.03%]
per position on the preregistered mean-ranked cut and +12.67% [+11.38%, +14.00%] on
the robust median-ranked cut, positive on 30 of 30 days and surviving every
adversarial re-cut available from this panel. The token-level screening version is
undecidable: the flag is set on 82.6% of mints and the outcome is censored 77–93%
of the time, and the two defensible censoring treatments disagree in sign.

The measured edge belongs to wallets we would be following, not to us, and the
apparatus has never measured what it would pay to follow them. Establishing that is
observation work, not capital work.
