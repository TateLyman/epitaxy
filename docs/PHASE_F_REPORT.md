# PHASE F — MEASURE THE THREE THINGS THAT WERE SKIPPED

2026-08-19. Directive:
`docs/directives/DIRECTIVE_4923AA9D_PHASE_F_CONFIRM_THE_DEFERRED.md`, committed
verbatim before execution. Predecessor: PR #61 (`21bd485`).

```
PRE_MIGRATION:  UNDECIDABLE
PHASE_C_CELL:   RECONSTRUCTION_FAILED_VALIDATION
```

**All three deferred items were measured, and §3 was reached.** Total cost **174
credits** against a 400 target — the decisive query cost **3**.

| item | outcome |
|---|---|
| §1 carry-forward on the pre-migration means | Survives carry-forward, collapses under residual-at-zero, disagrees in sign in **every** cell → **UNDECIDABLE** |
| §2 reserve mark on Phase C's estimand | p50 passes, agreement is **52.8–55.7%** against a 95% bar → **FAILED VALIDATION**, §2.4 not run |
| §3 H1 at entity level | **H1 survives**: +36.47% [+33.38%, +39.84%] against +36.74% [+33.57%, +40.03%] address-level |

The §0 interpolation cannot be replaced by measurement through the route available:
the instrument that would price the uncovered positions cannot reproduce bytes the
corpus already holds. It remains an inference that was never entitled to the word,
and now that is measured rather than argued.

---

## 1 — CARRY-FORWARD ON THE PHASE B PRE-MIGRATION MEANS

Re-derived through the same script that produced the originals, with two exit
treatments added beside the reported one. **Every pre-existing field reproduced
bit-for-bit** before the new fields were read — the re-run is deterministic, and the
correction is an addition to that artifact rather than a restatement of it.

Pre-migration population (`all-snapshotted`), tier `any`, 0.02 SOL:

| trigger | fired | with exit | censored | as-reported | carry-forward | 95% CI | residual-at-0 | 95% CI |
|---|---|---|---|---|---|---|---|---|
| T0 | 38,802 | 5,486 | 85.9% | +0.7% | +0.7% | [−3.2%, +1.3%] | **−85.8%** | [−100.0%, −83.0%] |
| **T1** | 1,140 | 71 | 93.8% | **+234.2%** | **+247.6%** | [+134.5%, +266.5%] | **−79.2%** | [−94.5%, −75.5%] |
| **T2** | 522 | 39 | 92.5% | **+392.7%** | **+394.2%** | [+216.5%, +426.5%] | **−63.2%** | [−100.0%, −54.8%] |
| **T3** | 319 | 16 | 95.0% | **+362.5%** | **+349.3%** | [+293.1%, +361.3%] | **−76.8%** | [−100.0%, −72.3%] |
| T4 | 1,139 | 71 | 93.8% | +234.2% | +247.6% | [+134.5%, +266.5%] | −79.2% | [−94.5%, −75.5%] |
| T5 | 519 | 39 | 92.5% | +392.7% | +394.2% | [+216.5%, +426.5%] | −63.0% | [−100.0%, −54.5%] |
| T6 | 986 | 165 | 83.3% | +54.5% | +47.7% | [−5.9%, +55.3%] | −74.1% | [−100.0%, −72.5%] |
| T7 | 973 | 121 | 87.6% | +110.8% | +103.7% | [+40.0%, +112.5%] | −73.8% | [−100.0%, −72.5%] |

**The carry-forward correction does not overturn the means.** All **252** positive
cells stay positive, and **225 of them clear a 2.50% floor on a day-clustered lower
bound**. That is the measured answer to what §1 asked, stated plainly and first.

**And the branch is still undecidable, because the other treatment flips every one of
them.** Under residual-at-zero, 0 of 252 remain positive. The three treatments
**disagree in sign in every one of the 279 evaluable cells**.

### Why carry-forward cannot decide it

| trigger | censored | of which **markable** | with no price after entry at all |
|---|---|---|---|
| T1 | 1,069 | **27 (2.5%)** | 1,042 (97.5%) |
| T2 | 483 | 13 (2.7%) | 470 (97.3%) |
| T3 | 303 | **1 (0.3%)** | 302 (99.7%) |

**There is nothing to carry forward for 97.5% of the censored population.** These are
not positions with a stale price; they are mints the collector stopped snapshotting
entirely. Censoring runs **75.4% to 98.1%** across the 279 evaluable cells, median
92.6%, and in **72 cells not one censored mint could be marked**. Carry-forward moves
T1's denominator from 71 to 98 out of 1,140 — from 6.2% of the fired population to
8.6%.

### One measurement that cuts against the §0 assumption

The interpolation §0 flagged assumed the uncovered positions are *worse* than the
marginal ones. On the only evidence that exists — the 2.5% of censored T1 mints that
have any post-entry price — they are **better**: the 27 marked mints average
**+282.9%** against **+234.2%** for the survivors. On T2, +398.5% against +392.7%.

That is weak evidence: 27 mints, selected on still being observed, and the reason
observation stopped may itself correlate with the mint's state. But it is evidence,
it is the only evidence available, and it points the opposite way from the
assumption. **The direction was not predicted in advance**, and the directive was
explicit that Phase E is an argument for measuring this rather than a forecast of its
result.

### The tradable population is unaffected

`migrated-at-entry`, tier `any`, 0.02 SOL: T0 −57.0% / −51.4% / −95.3% across the
three treatments, T1 −53.4% / −40.2% / −89.3%, T6 −63.4% / −50.8% / −85.4%. Negative
under all three. Phase B's verdict there stands untouched.

### Against the bonding-curve floor

Reported against **2.50%** per the directive — 1.25% per leg, no tier relief. Impact
and the ~6 bps fixed cost are **additional and unmeasured on the curve**, so every net
figure above is an **upper bound** on the net figure a curve entry would achieve.

### State: `UNDECIDABLE`

Both halves have to be said. Under carry-forward the means **survive**; under
residual-at-zero they **collapse**; the two disagree in every cell. Reporting only the
first would imply a live branch, and reporting only the second would be factually
wrong. The programme's own convention — established as condition 2 in MT079, MT083 and
MT087 — is that two defensible treatments disagreeing in sign means the data cannot
answer.

What would settle it is an exit price for mints the collector stopped snapshotting.
That is a data-collection problem, not an analysis one.

---

## 2 — THE RESERVE MARK ON PHASE C'S ESTIMAND

### 2.2 The anchor, ranked and reported before any credit was spent

`pnpm anchors`, free, reading the corpus:

| | |
|---|---|
| snapshots stored | **413** |
| distinct pools | **142** |
| snapshots with **readable** reserves | **413 of 413** |
| captured span | 2026-08-17T12:49Z .. 2026-08-18T23:58Z |
| migrations known | 413 of 413, spanning 2026-08-11 .. 2026-08-18 |
| **anchored pools whose migration precedes Phase C's window end** | **33 of 142** |

Option **A** — the collector's own stored bytes — is available for all 142 pools, and
33 of them existed during Phase C's window, though only its final four days. Option
**B**, the migration deposit as a protocol constant, was the route to the rest, and
these 142 pools are exactly the sample on which B could be validated rather than
assumed.

### 2.3 Validation — and it fails

`ops/dune/generated/q9-reserve-validation.sql`, query 8383081, execution
`01M0DPPY9STHV9CYGSSB3K3DHJ`, **3 credits**.

**The pair test assumes nothing.** 271 of the 413 snapshots are the second or later
snapshot of a pool that has more than one. For each consecutive pair, roll the
earlier stored reserves forward through the trades between the two **slots** and
compare with the later stored reserves. No anchor and no migration-deposit assumption
enters: it asks only whether the trade stream explains how reserves changed.

| | p10 | **p50** | p90 | **within 1%** |
|---|---|---|---|---|
| base ratio | 1.000000 | **1.000011** | 1.530610 | **55.7%** |
| quote ratio | −0.570580 | **1.000000** | 1.000203 | **52.8%** |

**The p50 passes and agreement does not.** The directive requires both — *"p50 is
within 1% **and** agreement exceeds 95%"* — so the reconstruction is not used, §2.4
does not run, and no reserve-marked figure exists.

And the headline agreement flatters it. **87 of 271 pairs had no trades between the
two snapshots** and are exact for free. Among the 184 pairs that actually traded,
agreement is **34.8%** base and **30.4%** quote.

### The failure is diagnosed, not just observed

| trades between snapshots | pairs | base p50 | quote p50 | within 1% |
|---|---|---|---|---|
| 1 | 26 | **1.00000** | 1.00005 | **100.0%** |
| 2–5 | 30 | 1.00000 | 1.00005 | 80.0% |
| 6–20 | 38 | 1.02736 | 0.94054 | 34.2% |
| 21–100 | 48 | 1.18247 | 0.64201 | **0.0%** |
| 101+ | 42 | **1.92526** | **−0.96720** | 2.4% |

**Exact at one trade, drifting monotonically with trade count.** That is the signature
of a **per-trade bias**, not of sporadic liquidity events — a liquidity event would
show as a jump in a few pools, not as a smooth function of how many trades happened.
**42 of 271 pairs imply a negative reserve**, which is impossible.

The mechanism was stated in the query header *before* it ran: `dex_solana.trades`
records the **trader's** amounts, and a PumpSwap swap splits its fee between the pool,
the protocol and the creator. The portion that leaves the pool is not in the trader's
amounts, so every trade leaves an unexplained residue that compounds. At 125 bps a leg
that drift was never obviously below a 1% bar, and it is not.

**Option B fails for the same reason.** Rolling each pool's earliest snapshot back to
its first observed trade gives an implied migration deposit that is **negative for 103
of 133 pools** — impossible — with a quote spread of **420×** between p10 and p90. The
deposit is not recoverable as a constant from this data.

### What this means

A working reconstruction needs the **per-trade fee split**, which is not in this
table. The requirement is therefore a different data source, not a better estimator —
and that is a more useful finding than a number would have been.

It also retroactively supports the decision in Phases C, D and E not to reach for
this, and it settles §0: the interpolation cannot be replaced by measurement through
this route.

### State: `RECONSTRUCTION_FAILED_VALIDATION`

Phase C's four conditions were **not** re-evaluated. Its 12 cells at +17.22% to
+30.56% net with lower bounds +1.24% to +11.94% remain exactly where Phase C left
them: clearing condition 1, failing condition 2, and unevaluated at honest coverage.

---

## 3 — H1 AT ENTITY LEVEL

Reached, because §2 consumed 3 credits against the 450 that would have forbidden it.
Query 8383095, execution `01M0DPVNHVGNV5H61ZDETRG82Q`, **169 credits** — one query, so
`sol_transfers` is scanned once.

Vanished flagged wallets are stitched to the addresses they funded which then began
trading, and the successor's holdout positions are attributed to the **predecessor's**
cohort. Successors have no fit history, so today their positions are in neither H1
cohort — invisible to the estimate rather than pulling it either way.

| | address level (PR #58) | **entity level** | correction |
|---|---|---|---|
| fit-**mean** cut | +36.74% [+33.57%, +40.03%] | **+36.47% [+33.38%, +39.84%]** | **−0.27 pts** |
| fit-**median** cut | +12.67% [+11.38%, +14.00%] | **+12.49% [+11.28%, +13.85%]** | **−0.18 pts** |

**H1 survives.** Positive on 30 of 30 days on both cuts, and every adversarial re-cut
moves by at most 0.1 points: closed-positions-only +17.85% (was +17.94%), unmarkable
back at −100% +31.87% (was +32.12%), SOL-weighted +25.51% (was +25.59%).

### The quantity MT082 said was missing

Successors contribute **1.07% of kept positions** and 1.10% of all positions, against
roughly **5% of wallets**. They are far less active than the addresses they replaced,
and that is why the correction is bounded.

They also **underperform** the cohorts they join:

| cohort | cohort mean | successor mean | successor share of positions |
|---|---|---|---|
| TOP_BOTH | +26.43% | **+12.35%** | 0.98% |
| TOP_MEAN_ONLY | +38.79% | **+1.31%** | 0.61% |
| TOP_MEDIAN_ONLY | +2.40% | **−0.95%** | 1.62% |
| REST_NEITHER | −4.60% | **+5.05%** | 1.05% |

Both directions shrink the difference — worse successors in the top cohorts, better
ones in the rest — which is why the correction is downward rather than upward. **This
was the one deferred item that could have moved a number up, and it moved it down by a
quarter of a point.**

### What it is not

**A correction, not a second test of H1.** It re-uses H1's own window and own ranking,
so it cannot confirm H1; it can only say how much the estimate moves when the
population is defined by operator instead of by address. The address-level figure
remains the headline because it is the preregistered one.

**It undercounts rotation by construction**, unchanged from MT082: a rotation funded
from a third address, one through a CEX or a mixer, an operator running addresses
concurrently rather than sequentially, and a successor trading outside the two
projects are all missed stitches. The measured correction is a **floor** on the
correction available.

---

## 4 — CREDITS, PER QUERY

| query | credits |
|---|---|
| §1 carry-forward (local corpus, `pnpm trigger:cells`) | **0** |
| §2.2 anchor inventory (local corpus, `pnpm anchors`) | **0** |
| schema probe, `dex_solana.trades` columns | ~2 |
| **§2.3 Q9 reserve validation** | **3** |
| **§3 Q10 H1 at entity level** | **169** |
| **Phase F total** | **174** |
| cumulative, all phases | 1,603 of 2,500 |

Target 400, ceiling 700, per-query 250. Inside all three. **The query that closed the
largest open question in the programme cost three credits**, because it compared
reserves against reserves on a four-day partition range rather than scanning a month
of tape.

§3 was permitted because §2 came in at 3 credits against the 450 that would have
forbidden it — the directive's ordering worked exactly as intended.

---

## 5 — LEDGER

- **MT089** — the carry-forward correction. Result: survives carry-forward, collapses
  under residual-at-zero, disagrees in sign in all 279 evaluable cells → undecidable.
  Includes the finding that the markable subsample is *better* than the survivors.
- **MT090** — the reserve reconstruction and its validation bar. Result: failed
  validation, with the per-trade fee-split bias diagnosed and the requirement restated
  as a different data source.
- **MT091** — H1 at entity level. Result: confirmed, correction −0.27 / −0.18 points,
  successors 1.07% of positions.

Every cell examined: `docs/PHASE_B_CELL_LEDGER.csv`, now 720 rows × the original
columns **plus** the sixteen correction columns. Artifacts:
`artifacts/trigger-cells.json`, `artifacts/phase-f-anchors.json`, and the two Dune
result sets under `ops/dune/results/`.

---

## 6 — WHAT IS LEFT

Three items were deferred; all three are now measured. What remains is what the
Phase E closing account already named, minus the one item this phase closed:

1. **Our own market impact.** Every copy price in Phases C–E is a VWAP of *other*
   traders' fills. Only the collector's own executable quotes can measure ours.
2. **An exit rule that is not the wallet's.** Every copy failure since Phase C has
   been an exit failure, and every exit tested has been the wallet's own. A copier
   that enters on the wallet's buy and exits on a stop, a target or a time limit has
   never been tested. Separate hypothesis, separate directive, separate hold-out.
3. **An exit price for mints the collector stopped snapshotting** — §1's blocker, and
   a collection problem rather than an analysis one.
4. **The per-trade fee split**, without which no reserve reconstruction can price an
   arbitrary timestamp on this venue.

~~Entity-level persistence~~ — measured. **H1 holds at entity level as well as address
level.**

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
