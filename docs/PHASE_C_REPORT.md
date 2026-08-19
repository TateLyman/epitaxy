# PHASE C — THE COPIER'S PRICE

2026-08-19. Directive: `docs/directives/DIRECTIVE_B4B269BB_PHASE_C_COPIER_LAG.md`,
committed verbatim before execution. Predecessor: PR #58,
`H1_CONFIRMED_H2_UNDECIDABLE_NEITHER_TRADABLE`.

**Final state: `UNDECIDABLE_CENSORING`.**

No lag satisfies MT079. Zero of 24 primary cells, zero of 48 including the
comparison venue. But the phase produced three things it was built to produce, and
two of them are firsts for this repository:

- **MT072 is no longer UNKNOWN.** Quote-to-land slippage against the wallet's own
  fill, on the AMM, is **+2.94% at 2 seconds** by the mean and **+0.03% by the
  median of per-day medians**. The cost lives entirely in a tail.
- **The alpha decay curve is nearly flat from 2s to 60s.** A copier at 60 seconds
  keeps 67–70% of the same-horizon appreciation against 72–78% at 2 seconds. There
  is no latency race here, which is the opposite of what a copy strategy is usually
  assumed to require.
- **The vanishing is not rotation.** Only 12–16% of vanished top-cohort wallets sent
  SOL to an address that then traded, and the rate is the same for the top cohorts
  as for everyone else.

The reason the phase is undecidable is unchanged from H2: **the exit is
unobservable for 46% of followable positions on the AMM**, and the two defensible
treatments of that disagree in sign. Per MT079 no threshold search follows.

---

## 1 — LAG SWEEP: L × cohort × top_fraction × venue, both censoring treatments

`pnpm lag:sweep` prints all 48 cells; `docs/PHASE_C_CELL_LEDGER.csv` is every cell
with every count and every condition; `artifacts/phase-c-lag-sweep.json` is the
machine-readable form the unit tests assert against.

Primary arm, `entry_project = pumpswap`, net of the tier-0 floor (2.669%):

| arm | L | priced | as-priced | 95% CI | censored | wide as-priced | wide censored |
|---|---|---|---|---|---|---|---|
| MEAN f=0.01 | 2s | 6,182 | **+24.45%** | [+9.92, +39.45] | **−33.06%** | +5.42% | −28.75% |
| MEAN f=0.01 | 5s | 6,179 | +24.24% | [+9.98, +38.97] | −33.15% | +5.25% | −28.92% |
| MEAN f=0.01 | 15s | 6,171 | +23.39% | [+8.99, +38.26] | −33.42% | +6.19% | −28.20% |
| MEAN f=0.01 | 30s | 6,153 | +23.00% | [+8.69, +37.73] | −33.47% | +5.86% | −28.34% |
| MEAN f=0.01 | 60s | 6,159 | +22.31% | [+8.50, +36.60] | −33.58% | +2.82% | −30.14% |
| MEAN f=0.01 | 300s | 6,104 | +17.61% | [+4.93, +30.54] | −33.43% | −0.16% | −29.64% |
| MEDIAN f=0.01 | 2s | 2,039 | **+30.56%** | [+11.94, +48.33] | **−30.77%** | +9.42% | −27.18% |
| MEDIAN f=0.01 | 60s | 2,028 | +27.59% | [+9.18, +44.93] | −31.76% | +6.52% | −28.68% |
| MEDIAN f=0.01 | 300s | 2,011 | +17.22% | [+1.24, +32.54] | −34.48% | −0.21% | −30.69% |
| MEAN f=0.001 | 2s | 938 | −5.16% | [−13.00, +3.99] | −39.11% | −7.67% | −26.95% |
| MEAN f=0.001 | 300s | 913 | −8.60% | [−14.48, −1.53] | −34.50% | −15.04% | −26.98% |
| MEDIAN f=0.001 | 2s | 76 | +3.87% | [−19.23, +35.34] | −41.09% | −17.89% | −39.34% |

The bonding curve, comparison only — a population Phase B established this
apparatus cannot enter, and the numbers are here to show why that restriction
matters rather than to propose anything: MEAN f=0.01 at 2s is **+212.06%**
as-priced [+131.06, +343.12] and **−66.76%** censored; MEDIAN f=0.001 at 2s is
**+348.16%** as-priced and **−61.88%** censored.

**Both treatments share one denominator** — the followable set, `priced + censored`
— so the pair is two fills of one population and not two populations. Positions
truncated by the holdout window edge (61 minutes of exit horizon that falls outside
the window) are excluded from both and counted separately: 1 to 279 per cell, never
counted as losses, because the window ending is not the token dying.

**A censored position enters at exactly −1.0 and is not charged the floor.** A total
loss already contains every cost, and charging the floor on top would report a loss
larger than the capital deployed. This is asserted by unit test.

---

## 2 — THE SELECTION SHARE, AT EVERY LAG

The directive specifies `copier_return(L) / wallet_return`. Taken literally the
denominator is the wallet's realised return over the whole position — its own exit,
whenever it took it, with a carry-forward mark if it never did — while the numerator
is a fixed 60-minute round trip. Those are different holding periods, and the ratio
of two different holding periods answers no clean question: on MEAN f=0.01 the
wallet's realised return is **−3.26%** while the copier's 60-minute return is
+24.50%, giving a ratio of **−7.5**. Reported for completeness in the printed table,
and not interpreted.

The ratio that answers the question applies **the same t+3600s exit to both sides**
and changes only whose entry price is in the denominator. That required one extra
column — the wallet's own fill price, from the legs of its first buy — and it makes
the decomposition exact:

| arm | L | wallet at THEIR fill | copier at OUR VWAP | entry slippage | **share** |
|---|---|---|---|---|---|
| MEAN f=0.01 | 2s | +33.73% | +24.45% | +2.83% | **0.725** |
| MEAN f=0.01 | 5s | +33.67% | +24.24% | +3.54% | 0.720 |
| MEAN f=0.01 | 15s | +33.32% | +23.39% | +4.40% | 0.702 |
| MEAN f=0.01 | 30s | +33.48% | +23.00% | +5.41% | 0.687 |
| MEAN f=0.01 | 60s | +33.29% | +22.31% | +6.57% | **0.670** |
| MEAN f=0.01 | 300s | +33.88% | +17.61% | +12.49% | 0.520 |
| MEDIAN f=0.01 | 2s | +39.24% | +30.56% | +3.71% | **0.779** |
| MEDIAN f=0.01 | 60s | +39.33% | +27.59% | +11.77% | 0.701 |
| MEDIAN f=0.01 | 300s | +39.80% | +17.22% | +15.66% | 0.433 |

The **execution premium** — what their fill is worth over ours on the same position
and the same exit — is the same statement as a difference, and unlike the ratio it
carries a day-clustered paired interval:

```
MEAN   f=0.01  L=  2s   +9.27%  [+6.23%, +13.21%]   30/30 days paired
MEAN   f=0.01  L= 15s   +9.93%  [+6.74%, +13.91%]
MEDIAN f=0.01  L= 30s  +10.71%  [+6.39%, +15.81%]
MEDIAN f=0.01  L= 60s  +11.75%  [+7.18%, +17.27%]
MEDIAN f=0.01  L=300s  +22.58%  [+15.56%, +29.40%]
```

The ratio's own interval is reported only where no bootstrap resample crossed a zero
denominator; where a resample would have been dropped, the interval is withheld
rather than reported narrower than the truth, and the execution premium above
carries the uncertainty instead.

**This is the number the phase existed to produce, and it is not zero.** The edge is
not purely execution: a copier at two seconds keeps roughly three quarters of the
same-horizon move. That is what makes the censoring failure below the binding
constraint rather than a footnote — the question is live, and this instrument still
cannot answer it.

The `f=0.001` arms are a different story and MT080 predicted it: 212 wallets produce
76 to 938 priced positions against a required 1,367 to 353,817, so the sharpest cut
is the one the power condition rejects outright. Its point estimates are negative or
near zero and its intervals span ±20 to ±35 points.

---

## 3 — THE LARGEST L SATISFYING ALL FOUR CONDITIONS

**None does.** 0 of 24 primary cells, 0 of 48 in total.

| condition | cells passing (of 24 primary) |
|---|---|
| 1. day-clustered 95% lower bound above zero, net of the floor | 12 |
| 2. as-priced and censored agree in sign | 8 |
| 3. entry_project = pumpswap | 24 |
| 4. n ≥ 7.84 × CV² on the copier return | 12 |
| **all four** | **0** |

**The two failing sets are disjoint, and that is the finding.** The 12 cells that
clear condition 1 are all `f=0.01`, and every one of them fails condition 2: the
sign flips from +22…+31% to −31…−34% when unpriceable positions are entered at
−100%. The 8 cells that satisfy condition 2 are all `f=0.001` — the six MEAN cells, whose
as-priced return is negative at every lag, and the two MEDIAN cells at 60s and 300s
where it has turned negative — and every one of them fails condition 1. **Every route through the table
arrives at "no copyable lag", and the two routes fail for opposite reasons.** That
agreement is worth more than either group alone: the result is not one marginal
interval that happened to land the wrong side of zero.

The floor cannot rescue any of it. At tier 8 (1.722% instead of 2.669%) the primary
cells move by 0.6–0.9 points and no sign changes.

### Why the censoring is not a nuisance to be averaged away

On the AMM, of every 100 followable positions, **54 have an exit price in the
60-second window at t+3600s and 46 do not**. On the curve it is 11 of 100. The
`as-priced` figure conditions on the 64, and a token still trading an hour after a
tracked wallet bought it is not the median token. That is precisely the survivor
bias that made H2 undecidable, and it recurs here because it is a property of
measuring an exit on a public tape, not a property of either hypothesis.

The wide-window sensitivity puts a number on it. Widening the exit window from 60
seconds to 5 minutes — **the same horizon**, only the observation granularity moves
— admits 26% more positions and cuts the as-priced return from **+24.45% to
+5.42%**. The positions the narrow window silently dropped were much worse than the
ones it kept. The censoring is therefore *partly* granularity and *mostly*
illiquidity, and neither treatment is the truth: as-priced is biased up by
survivorship, censored-at-−100% is biased down by assuming a total loss where a
worse-but-not-total exit existed. The truth is between two numbers of opposite sign,
which is exactly what "undecidable" means.

---

## 4 — IMPLIED LATENCY BUDGET

Conditional on a future decidable version of this measurement showing the same
shape — which is not established, and this section is not a licence to build:

**The latency budget is generous, and this is the phase's most actionable finding.**
The selection share falls from 0.725 to 0.670 between 2 seconds and 60 seconds, and
the execution premium rises only from +9.27% to about +11%. Losing 58 seconds costs
roughly 5 points of share. Between 60 and 300 seconds it costs another 15, so the
decay is real but its knee is minutes, not milliseconds.

What that would require: **an ordinary RPC poll at a 1–2 second cadence.** No
co-location, no leader-schedule prediction, no Jito bundles, no first-block
contention — none of the infrastructure this project has explicitly refused to
compete on. A `getSignaturesForAddress` sweep over a watchlist of 2,113 addresses at
one-second cadence is well inside what the existing rate-limited HTTP adapter and
provider budget already sustain.

**The mean/median divergence is the operational risk, not the latency.** Entry
slippage on the AMM is +2.94% by the mean and +0.03% by the median of per-day
medians at 2 seconds; at 300 seconds the mean is +12.79% while the median is
**−0.94%**. The typical copy fill is at the wallet's own price or better. A small
tail of positions runs away violently, and it is that tail that produces the whole
average cost. A copier's sizing rule matters more than its latency, and a
per-position impact cap would matter more than either.

On the curve the same measurement is +86.13% mean and +19.42% median at 2 seconds.
**The latency race exists on the bonding curve and not on the AMM** — which is
consistent with Phase B's finding that the population with the returns is the
population this apparatus cannot enter, and is a second independent reason not to
enter it.

---

## 5 — ROTATION OR DEATH

`tokens_solana.sol_transfers`, outbound native SOL from every vanished flagged
wallet between 2026-07-08 and the holdout end, classified by whether the recipient
subsequently traded pump tokens.

| cohort | vanished | rotation, fresh address | rotation, active address | moved to non-trader | no outflow | **rotation** |
|---|---|---|---|---|---|---|
| TOP_BOTH | 3,967 | 179 (4.5%) | 330 | 719 | 2,739 | **12.8%** |
| TOP_MEAN_ONLY | 3,793 | 197 (5.2%) | 396 | 830 | 2,370 | **15.6%** |
| TOP_MEDIAN_ONLY | 4,546 | 239 (5.3%) | 298 | 1,032 | 2,977 | **11.8%** |
| REST_NEITHER | 40,776 | 1,819 (4.5%) | 3,301 | 9,797 | 25,859 | **12.6%** |

By fit decile: 14.2% and 14.4% at deciles 1–2, 10.0–12.1% at deciles 7–9, 14.6% at
decile 10. Fresh-address rotation is 4.0–5.3% everywhere.

**The vanishing is mostly not rotation, and rotation is not concentrated at the
top.** Decile 1 vanishes at 36.7%; 14.2% of those vanishings have a trading
successor, so about **5% of decile 1 rotated and about 32% stopped or blew up**. The
top cohorts rotate at 11.8–15.6% against 12.6% for everyone else — a difference far
too small to be the mechanism behind a 36.7% versus 8.6% vanishing gradient.

Two consequences, in opposite directions:

- **For H1**, the survivor conditioning is not primarily a rotation artifact. The
  addresses that disappear mostly do not reappear, so "persistence of addresses"
  and "persistence of operators" are closer together than the vanishing rate
  suggested.
- **For any copy list**, the decay is real attrition rather than renaming. A
  watchlist loses roughly a third of its top decile per month to wallets that
  genuinely stop, and following the 5% that rotate would require the funding graph
  to be walked continuously, not once.

**The entity-level H1 re-run was NOT performed.** The transfers scan cost 218
credits, which put Phase C at 367 of the 400-credit ceiling the directive set as a
stop-and-report threshold. Stitching rotations to successors and recomputing the H1
difference is one more full-panel query and would have breached it. What can be said
without running it is arithmetic and not a measurement: the stitching would add
successors for about 5% of the top cohort's wallets, so the entity-level population
differs from the address-level one by that share of *wallets* — though not
necessarily by that share of *positions*, since a successor's activity level is
unmeasured. The direction and size of the correction to +36.74% are therefore
unknown, and the honest statement is that H1 stands as an address-level result.

**What this classification cannot see**, stated before the numbers existed: a
rotation funded from a third address, a rotation through a CEX or a mixer, an
operator running many addresses concurrently rather than sequentially, and a
successor trading on a venue outside `project IN (pumpdotfun, pumpswap)`. Every one
of those is a *missed* rotation, so 12–16% is a **floor** and the
stopped-or-blew-up share is a **ceiling**.

---

## 6 — CREDITS

| item | credits |
|---|---|
| Q5 lag sweep, first execution | 72 |
| Q5 lag sweep, with the matched pair and the wide window | 75 |
| schema probes (transfer tables, `sol_transfers` columns) | ~2 |
| Q6 rotation, `tokens_solana.sol_transfers` | 218 |
| **Phase C total** | **367** |
| cumulative, all phases | 956 of 2,500 |

The directive set 200 as the target and 400 as a stop-and-report ceiling. **Phase C
came in at 367, over the target.** The overage is one line item: the transfers scan
cost 218 credits against roughly 75 for every other query in the programme, because
`sol_transfers` is not partition-prunable by the wallet set and 45 days of it must
be read to answer the question. That was not foreseeable from the schema, and it is
recorded here rather than absorbed. It is also why §5's second half did not run.

---

## 7 — LEDGER

- **MT079** — the preregistered rule, written before the first execution. Result:
  no lag satisfies all four conditions; the two failing groups are disjoint.
- **MT080** — `top_fraction` 0.10 → {0.001, 0.01}, availability-driven, with its
  cost stated in advance: the power condition becomes binding. It did — the 0.001
  arms fail condition 4 by two orders of magnitude.
- **MT081** — the two columns added to query 5 **after** its first execution had
  been read: the wide exit window and the wallet's own fill price. Both are
  measurement repairs and neither changed the preregistered rule, and this row
  exists because the sequence matters and hiding it would be indistinguishable from
  a search.
- **MT082** — the rotation classification, its undercount direction, and the
  entity-level re-run that did not run.

**The superseded first execution of query 5 is committed** as
`ops/dune/results/q5-copier-lag-sweep-v1.json`, so MT081's disclosure — that its
returns had been read before the two columns were added — is checkable rather than
asserted.

Every cell examined: `docs/PHASE_C_CELL_LEDGER.csv`, 48 rows, each with its counts,
both treatments, all four conditions and its verdict. No cell was dropped, and the
comparison venue is in the same file as the primary rather than in a footnote.

---

## 8 — FINAL STATE

```
UNDECIDABLE_CENSORING
```

The copier's return at every lag on the enterable venue is positive under
`as-priced` and negative under `censored-at-−100%`, and the two defensible
treatments of an unobservable exit disagree in sign. MT079 refuses. No threshold
search follows, and none is proposed.

What survives as measurement rather than decision:

1. **MT072 is measured.** Entry slippage against the wallet's own fill on the AMM:
   +2.94% mean, +0.03% median at 2 seconds, rising to +12.79% mean and −0.94%
   median at 300 seconds. It has been UNKNOWN since inception and it is no longer.
2. **The selection share is not zero** — 0.725 to 0.779 at two seconds, conditional
   on an observable exit. `EDGE_IS_EXECUTION_ONLY` would have closed the branch, and
   it is *not* the state: the evidence points the other way, and the branch stays
   open with an instrument that cannot close it.
3. **The decay curve's knee is in minutes.** Whatever else is true, this is not a
   latency race on the AMM.
4. **The vanishing is attrition, not renaming**, at every decile.

What would make it decidable is a better exit, not a better threshold: an exit rule
whose price exists for every position. The apparatus already has one — the
collector's own executable quotes, which produce a mark for a position it holds
whether or not anyone else traded that minute. That is the same conclusion H1
reached from the other end, and it costs observation time rather than credits or
capital.

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
