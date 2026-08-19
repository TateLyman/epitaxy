# PHASE D — COPY THE EXIT

2026-08-19. Directive: `docs/directives/DIRECTIVE_B726240C_PHASE_D_COPY_THE_EXIT.md`,
committed verbatim before execution. Predecessor: PR #59 (`30b7f1b`),
`UNDECIDABLE_CENSORING`.

**Final state: `UNDECIDABLE_CENSORING`.**

**TWO OF THE DIRECTIVE'S OWN STOP CONDITIONS FIRED, and the phase stopped on both.**

1. **Query 7 cost 230 credits** against a 150-per-query threshold: *"If any single
   query exceeds 150, stop and report before continuing."* So the rolling re-rank
   (§5) did not run.
2. **Coverage came back under 70% on 12 of 24 primary cells**: *"If it is below 70%,
   stop and go to §2 rather than reporting an estimate that carries the same defect
   under a new name."* Those cells' estimates are recorded but are **not** reported
   as estimates, and §2's reserve reconstruction did not run either — it needs
   credits this phase no longer has room for.

What the one query bought is still substantial, and it changes the picture more than
Phase C did:

**Copying the exit is where most of the edge goes.** Phase C shared one fixed exit
between wallet and copier and found the copier kept 0.725–0.779 of the move. Here the
copier must also *follow the wallet out*, and it keeps **0.19–0.33** — on an estimation
set that is not identical, so an order of magnitude rather than an exact
decomposition. Within this phase the mechanism is exact: the copier buys higher AND
sells lower, and only the second of those is new. The directive's title names the
binding problem.

**The sizing hypothesis is not supported.** MT084 predicted the cost tail lived in
positions where the wallet moved the pool hard. Declining those does not help: on the
largest arm the return falls from **+6.22% to +1.68%** while declining 51.3% of
positions. The wallet's high-impact trades are among its better ones.

---

## 1 — COVERAGE, BEFORE ANY RETURN FIGURE (§1.2)

Both legs priced, as a fraction of followable positions, primary venue:

| arm | L=2s | L=60s | L=300s | verdict |
|---|---|---|---|---|
| MEAN f=0.001 | 30.8% | 28.7% | 26.5% | below 70% |
| MEAN f=0.01 | 62.1% | 60.2% | 51.8% | below 70% |
| MEDIAN f=0.001 | 79.3% | 78.6% | 73.6% | below 90% |
| MEDIAN f=0.01 | 76.6% | 75.4% | 70.4% | below 90% |

**No cell reaches 90% on the primary venue at any lag.** Stated first, as required,
before a single return figure below.

### The headline number mixes two different things, and the decomposition matters

Coverage as the directive defines it counts a position as uncovered when the wallet
never sold. But §1.3 says those positions are *"genuinely open rather than missing"* —
a copier following the wallet would also still be holding. Separating the two:

| arm | followable | never sold | both legs priced, of those that DID sell | coverage as defined |
|---|---|---|---|---|
| MEAN f=0.001 | 2,053 | 38.8% | **50.4%** | 30.8% |
| MEAN f=0.01 | 12,847 | 26.9% | **85.0%** | 62.1% |
| MEDIAN f=0.001 | 140 | 16.4% | **94.9%** | 79.3% |
| MEDIAN f=0.01 | 4,253 | 10.9% | **85.9%** | 76.6% |

**Conditional on the wallet actually selling, the pricing works: 85–95% of positions
have both legs priced** on three of the four arms. The shortfall against the 90%
threshold is dominated by positions the wallet never closed, not by an inability to
price a trade.

That does not rescue the phase, and it does not make §2 the wrong remedy — the
reserve mark §1.3 names as the third treatment is exactly what an open position
needs. But it locates the problem: **Phase C's gap was a pricing gap; Phase D's is a
holding-period gap.** Anchoring on the wallet's own sell did what it was supposed to
do, and then ran into a different wall.

The remaining pricing gap moved from the exit leg to the **entry** leg. For MEAN
f=0.01 at L=2s, 89.6% of positions have a priced entry and 62.9% a priced exit; but
of the 73.1% that sold, 86.1% have a priced exit. The exit leg is now the *better*
covered of the two.

---

## 2 — THE ROUND-TRIP TABLE

Primary venue, net of the tier-0 floor (2.669%), UNGATED, closed-only and
open-at-−100%. Cells whose coverage failed are omitted here and recorded in
`docs/PHASE_D_CELL_LEDGER.csv` — all 192 of them, with every count and condition.

| arm | L | n | closed-only | 95% CI | open-at-−100% | conditions |
|---|---|---|---|---|---|---|
| MEDIAN f=0.01 | 2s | 3,257 | **+6.22%** | [−1.19%, +14.58%] | **−5.17%** | ‑‑34 |
| MEDIAN f=0.01 | 5s | 3,253 | +6.57% | [−1.12%, +15.14%] | −4.89% | ‑‑34 |
| MEDIAN f=0.01 | 15s | 3,250 | +5.87% | [−1.37%, +13.81%] | −5.55% | ‑‑34 |
| MEDIAN f=0.01 | 30s | 3,234 | +6.10% | [−1.23%, +14.52%] | −5.37% | ‑‑34 |
| MEDIAN f=0.01 | 60s | 3,205 | +6.07% | [−0.66%, +14.16%] | −5.25% | ‑‑34 |
| MEDIAN f=0.01 | 300s | 2,994 | +0.71% | [−5.35%, +8.04%] | −9.37% | ‑‑3‑ |
| MEDIAN f=0.001 | 2s | 111 | +14.53% | [−2.83%, +35.57%] | −2.96% | ‑‑3‑ |
| MEDIAN f=0.001 | 60s | 110 | +11.60% | [−8.61%, +38.00%] | −4.84% | ‑‑3‑ |
| MEDIAN f=0.001 | 300s | 103 | −11.09% | [−28.52%, +10.93%] | −23.69% | ‑23‑ |

The third treatment the directive names — open positions priced at a reconstructed
reserve mark — **is absent because §2 did not run**, and a treatment that silently
fell back to one of the other two would make the sign-agreement condition compare a
thing to itself.

---

## 3 — THE RATIO, NOW INTERPRETABLE

Same two legs, same timing, only the price differs. This is what Phase C could not
compute and what §1.1 was designed to deliver.

| arm | L | wallet, same legs | copier, net of floor | **ratio** | 95% CI |
|---|---|---|---|---|---|
| MEDIAN f=0.01 | 2s | +23.05% | +6.22% | **0.270** | [−0.077, +0.447] |
| MEDIAN f=0.01 | 60s | +23.70% | +6.07% | 0.256 | [−0.042, +0.436] |
| MEDIAN f=0.01 | 300s | +24.66% | +0.71% | 0.029 | [−0.304, +0.255] |
| MEAN f=0.01 | 2s | +21.92% | +5.56% | 0.254 | not estimable |
| MEDIAN f=0.001 | 2s | +45.26% | +14.53% | 0.321 | not estimable |
| MEAN f=0.001 | 2s | +82.80% | +18.93% | 0.229 | [+0.084, +0.364] |

Paired difference, day-clustered on the same drawn days — the wallet's advantage over
its own copier, which unlike a ratio always carries an interval:

```
MEDIAN f=0.01   L=  2s   +16.83%  [+12.87%, +21.86%]   30/30 days
MEDIAN f=0.01   L= 60s   +17.63%  [+13.01%, +23.03%]
MEAN   f=0.01   L=  2s   +16.35%  [+12.87%, +21.10%]
MEAN   f=0.01   L= 60s   +19.13%  [+14.62%, +24.40%]
MEDIAN f=0.001  L=  2s   +30.73%  [+6.39%, +82.49%]
```

**Set beside Phase C, this is the phase's main result.** With one shared exit the
copier kept 0.725–0.779. Following the wallet out as well, it keeps 0.19–0.33. The
gap is about **0.45 of the wallet's return** in share terms. That subtraction spans two
phases whose estimation sets differ — Phase C's positions needed a price at t+3600s,
Phase D's need a priced sell — so it is the right order of magnitude and not an exact
decomposition. What is exact *within* this phase is the per-leg slippage below: the
copier buys higher and sells lower, and only the second of those is new.

Slippage per leg makes the mechanism explicit (pooled across arms, primary venue):

| L | entry mean | entry median | exit mean | exit median |
|---|---|---|---|---|
| 2s | +7.32% | −0.00% | **−6.24%** | **−0.75%** |
| 60s | +9.54% | −0.26% | −8.12% | −1.59% |
| 300s | +12.17% | −0.94% | −7.10% | −4.61% |

The copier buys higher *and sells lower*, and the two costs compound. The exit
slippage is negative by construction of the situation, not by accident: the wallet
sells into whatever bid exists, and a copier arriving seconds later sells into what
is left of it.

### What the copier also forgoes: the wallet's later sells

The exit signal a copier can act on is the *first* sell. The wallet keeps selling
after it:

| arm | wallet, first sell only | wallet, fully realised |
|---|---|---|
| MEAN f=0.001 | +82.80% | **+515.14%** |
| MEAN f=0.01 | +21.92% | **+86.23%** |
| MEDIAN f=0.01 | +23.05% | **+80.72%** |
| MEDIAN f=0.001 | +45.26% | +18.84% |

On three of four arms the wallet realises three to six times its first-sell return.
A copier that exits on the first sell captures a quarter of what the wallet makes,
*before* paying the exit slippage above. Using the wallet's last sell instead would
credit the copier with information it does not have at the decision point, which is
why MT083 froze the first sell as the signal.

---

## 4 — THE LARGEST L SATISFYING ALL FOUR CONDITIONS

**None.** 0 of 192 cells; 0 of the 12 reportable primary UNGATED cells.

| condition | passing (of 12 reportable primary UNGATED) |
|---|---|
| 1. day-clustered 95% lower bound above zero | **0** |
| 2. closed-only and open-at-−100% agree in sign | 1 |
| 3. entry_project = pumpswap | 12 |
| 4. n ≥ 7.84 × CV² on the round-trip return | 5 |
| **all four** | **0** |

**Condition 1 now fails outright**, which it did not in Phase C. Every reportable
primary lower bound includes zero or is negative: the best is MEDIAN f=0.01 at 60s,
+6.07% [−0.66%, +14.16%]. The single cell satisfying condition 2 does so because both
treatments are negative (MEDIAN f=0.001 at 300s, −11.09% and −23.69%).

Condition 4 got **easier**, exactly as the directive anticipated, and honestly rather
than by assumption: the round-trip estimand's CV is lower than the fixed-horizon
one's, so required n falls to 2,503–2,932 for MEDIAN f=0.01 at lags 2–60s against
actual n of 3,205–3,257. **Five cells are now adequately powered** — the sixth, at
L=300s, needs 237,194, because its mean is nearly zero and a CV blows up as its
denominator vanishes. The five are powered to detect something whose lower bound is
still below zero.

---

## 5 — RESERVE RECONSTRUCTION (§2): DID NOT RUN

Coverage under 70% on 12 of 24 primary cells triggers §2, and §2 did not run.

The reason is the credit rule, not a judgement about the method: query 7 alone cost
230 credits against a 150-per-query stop threshold, so continuing to a reconstruction
plus its validation would have compounded an overage the directive told me to stop and
report instead. **No validation figures exist, and none are estimated here.** The
directive's own bar for using the reconstruction at all — p50 ratio within 1% of the
stored bytes and agreement above 95%, both recorded in the ledger before use — remains
untested.

What §2 would fix, precisely: the 10.9%–38.8% of positions the wallet never closed. It
would price those at a reconstructed mark and turn the third censoring treatment from
absent into real. It would *not* improve the entry-leg pricing gap, which is the other
half of the shortfall.

---

## 6 — THE SIZING ARM (§4, MT084)

Primary venue, L=2s. The gate keeps positions whose own measured impact is at or below
2X, the constant-product mapping of X% of reserves frozen in MT084.

| arm | gate | kept | declined | return | 95% CI |
|---|---|---|---|---|---|
| MEDIAN f=0.01 | UNGATED | 3,257 | — | **+6.22%** | [−1.19%, +14.58%] |
| MEDIAN f=0.01 | ≤1% | 1,585 | 51.3% | **+1.68%** | [−4.11%, +7.50%] |
| MEDIAN f=0.01 | ≤3% | 2,060 | 36.8% | +2.08% | [−3.81%, +7.97%] |
| MEDIAN f=0.01 | ≤10% | 2,744 | 15.8% | +6.27% | [−0.89%, +14.51%] |
| MEAN f=0.01 | UNGATED | 7,975 | — | +5.56% | [−6.41%, +18.67%] |
| MEAN f=0.01 | ≤1% | 3,329 | 58.3% | +6.98% | [−5.65%, +20.13%] |
| MEAN f=0.01 | ≤10% | 6,237 | 21.8% | +7.03% | [−5.89%, +20.61%] |
| MEAN f=0.001 | UNGATED | 633 | — | +18.93% | [+5.28%, +37.14%] |
| MEAN f=0.001 | ≤1% | 379 | 40.1% | +13.81% | [+2.68%, +26.43%] |
| MEDIAN f=0.001 | UNGATED | 111 | — | +14.53% | [−2.83%, +35.57%] |
| MEDIAN f=0.001 | ≤1% | 60 | 45.9% | +23.72% | [+4.05%, +50.82%] |

**MT084 is not supported.** On the largest arm the tightest gate more than halves the
return while declining half the positions. On MEAN f=0.01 it is flat within intervals
that overlap almost entirely. It helps only on MEDIAN f=0.001, where n falls to 60 and
the interval is ±25 points.

The reason is visible in the impact distribution the gate is cutting: the **median own
impact is +0.92% to +2.71%**, so the wallets are not routinely moving these pools
hard, and a gate at 2% impact is slicing into the body of the distribution rather than
trimming a tail. MT084 flagged this risk in advance — the proxy can decline positions
for reasons unrelated to size — and the decline rates (15.8%–58.3%) confirm the gate
is doing far more than trimming.

The honest reading is stronger than "no effect": on the one arm with both adequate n
and a real change, **gating made it worse**, which says the wallet's higher-impact
entries are among its better ones. That is consistent with size being a signal of the
wallet's own conviction rather than a source of copier cost.

**Condition 2 is not evaluable on any gated arm.** Query 7 returns open positions as
one count per cell rather than broken out by gate, and charging the full open count
against an arm that kept half the closed positions would report a sign disagreement
that is an artifact of the export. Those arms are marked not-evaluable, which fails
the condition rather than passing it, and the state is decided on the UNGATED arm.

---

## 7 — ROLLING RE-RANK (§5): DID NOT RUN

The 150-credit-per-query stop condition fired on query 7 before the rolling arm was
executed. MT085 is preregistered and frozen — re-rank every 7 days on a trailing 45
days, positions attributed to the cohort current at their first buy, and the rolling
figure governs if the two differ materially — and it is unrun.

The fixed-cohort figure is therefore the only one reported, and it carries the
survivorship it inherits from H1: about 32% of decile 1 stopped or blew up inside this
window, and the fixed cohort keeps following them.

**The entity-level H1 re-run also remains deferred, per the directive. H1 remains an
address-level result.**

---

## 8 — CREDITS, PER QUERY

| query | credits |
|---|---|
| Q7 paired round trip | **230** |
| **Phase D total** | **230** |
| cumulative, all phases | 1,186 of 2,500 |

The directive's target was 400 with a 700 stop-and-report ceiling, and a 150 limit on
any single query. Phase D is inside the phase target and **over the per-query limit**,
which is the condition that stopped it. The scan is over `dex_solana.trades` and does
prune by `block_time` as the directive expected; the cost is the two-sided join —
every followable position is joined to the tape twice, once around its buy and once
around its sell, and the exit side cannot be bounded to a narrow calendar range
because a position may be held for weeks.

---

## 9 — LEDGER

- **MT083** — the preregistered rule, written before the first execution. Result: 0 of
  192 cells copyable; condition 1 fails on every reportable primary cell; the ratio is
  0.19–0.33.
- **MT084** — the sizing arm, thresholds and the 2X impact mapping frozen in advance.
  Result: not supported, and adverse on the largest arm.
- **MT085** — the rolling re-rank, frozen and **unrun**.

Every cell examined: `docs/PHASE_D_CELL_LEDGER.csv`, 192 rows — 48 cells × 4 gates —
each with its coverage, its verdict, both treatments where evaluable, all four
conditions and its reportability. Coverage-failed cells are in the same file as the
rest rather than dropped, with `reportable = False`.

---

## 10 — FINAL STATE

```
UNDECIDABLE_CENSORING
```

The treatments still disagree: closed-only is positive on the reportable primary
cells, open-at-−100% is negative on all of them. Per §6 that means report coverage and
stop, and coverage is reported in §1 above.

But the reason the state is unchanged from Phase C is not the reason Phase C gave, and
that is the useful part:

1. **Phase C's censoring was a pricing gap. Phase D's is a holding-period gap.**
   Anchoring on the wallet's own sell fixed the pricing — 85–95% of positions that
   sold have both legs priced — and exposed that 11–39% of positions are never sold at
   all. That is a fact about the wallets, not about the instrument, and no query
   resolves it: it needs a mark for an open position, which is §2.
2. **Condition 1 now fails outright**, where in Phase C twelve cells cleared it. The
   round-trip estimand is *worse* than the fixed-horizon one, because the copier pays
   on both legs. This is a finding, not a regression.
3. **Most of the edge goes on the exit.** 0.725–0.779 kept with a shared exit against
   0.19–0.33 kept when following the wallet out, across estimation sets that differ —
   an order of magnitude rather than a decomposition. Any future version of this idea
   has to solve the exit, and following the wallet's own sell is not a solution to it.
4. **The wallet's own realised return is 3–6× its first-sell return.** The copier
   forgoes that entirely, before slippage.

What would move this forward, in order of cost: the reserve reconstruction of §2, both
because it prices the open positions and because it is the only way to evaluate
condition 2 honestly on the gated arms; then the rolling re-rank; and separately, the
collector's own executable quotes, which price *our* fill rather than a VWAP of other
people's fills and are the only instrument here that could ever measure our own
impact.

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
