# PHASE G ADDENDUM — PRICE THE CURVE, NOT THE TAPE

2026-08-19. Directive:
`docs/directives/DIRECTIVE_C5C33404_PHASE_G_ADDENDUM_PRICE_THE_CURVE.md`, transcribed
from PDF and committed before execution, with the three losses the PDF suffered marked
inline rather than reconstructed. Predecessor: PR #63 (`6e0de32`).

```
PRE_MIGRATION_CURVE_PRICED: RECONSTRUCTION_FAILED_VALIDATION
```

**§A.0's premise is mechanically true and operationally false, and the measurement says
so precisely.** A pump bonding curve does always quote a price. But that price is the
price at which trading *stopped*, and for the positions this branch is undecidable
over — the ones with no observed trade — it is wrong by a median factor of **17.2**.

Two findings, and the second does not depend on the first:

1. **Curve pricing adds coverage exactly where it adds error.** On the positions where
   the token was still trading, the curve price agrees with the observed price to
   within a few points. On the 17.3% with **zero curve trades between entry and exit**,
   the curve reports **+0.00%** while the observed return is **−94.50%**. Substituting
   "flat" for "unknown" on a dead token is the most favourable substitution available,
   and it is the failure mode this programme exists to refuse.

2. **The +234.2% to +394.2% figures are a property of the 82% of the branch that is not
   a bonding curve at all.** Of 5,598 T1–T7 holdout positions, **999 (17.8%)** are
   pump.fun curve mints. On that subset T1's as-reported mean is **−32.47%**, not
   +234%. The branch has been called "the pre-migration bonding-curve branch"
   throughout; for most of it there is no bonding curve.

§B, §C and §D were already delivered in PR #63 and are summarised in §5 below. The
addendum's reorder therefore left only §A to run, and §A cost **33 credits**.

---

## 1 — WHAT REPLACED §A.1 AND §A.2, AND WHY IT IS STRONGER

§A.2 names the initial Global parameters as the technical risk and says to read them at
each mint's creation slot, excluding and counting any mint whose creation-slot state
cannot be established.

**They did not need to be read, because the program publishes its own state.**
`pumpdotfun_solana.pump_evt_tradeevent` carries `virtualSolReserves` and
`virtualTokenReserves` as the pump program computed them, after every trade. So:

- the curve state is **observed**, not reconstructed, at every trade;
- `k` is never used, so a wrong `k` cannot silently propagate;
- no constant is assumed across the corpus, which is the failure mode §A.2 warned
  against — because no constant is used at all.

What the corpus itself holds was checked first, at zero credits, and it holds none of
this: all 413 coherent snapshots carry nine accounts each, every one a PumpSwap AMM
account or a sysvar. **There is no bonding-curve account and no Global account anywhere
in the corpus**, so §A.3's first validation as literally specified — "for every
pre-migration mint where the collector holds real curve account bytes" — has zero
eligible mints. The event stream is what made §A possible at all.

---

## 2 — §A.3 VALIDATION 1: THE ROLL-FORWARD. PASSES, FLAT.

Query 8383494, execution `01M0DV1RBAZQQ1A4WV9VR9TVVF`. 93.9M events over **892,607
mints** whose first event falls in the window. Roll `virtualTokenReserves` forward from
each mint's first event on **token amounts only** and compare with what the program
reported at each later event.

| trades since anchor | events | mints | token p50 | **token within 1%** | invariant SOL p50 | **SOL within 1%** |
|---|---|---|---|---|---|---|
| 1 | 892,607 | 892,607 | 1.00000 | **97.9%** | 1.00000 | 80.0% |
| 2–5 | 2,778,031 | 743,050 | 1.00000 | **97.9%** | 1.00000 | 70.3% |
| 6–20 | 7,566,993 | 616,294 | 1.00000 | **99.4%** | 1.00000 | 63.2% |
| 21–100 | 20,199,485 | 407,063 | 1.00000 | **99.5%** | 1.00000 | 58.5% |
| 101+ | 62,480,643 | 171,458 | 1.00000 | **98.1%** | 1.00000 | 79.7% |

**The token roll-forward is flat across all five buckets and passes the conjunction** —
p50 within 1% and agreement above 95% at every bucket. There is no drift with trade
count. That is the test of "curve reserves do not move without a trade", and it holds.

**The invariant cross-check FAILS and §A.1 required that be reported rather than
averaged away.** Deriving `virtualSolReserves` from `k` taken at the mint's own first
event agrees with the reported value for only **58.5% to 80.0%** of events. So `k` is
**not** constant over a curve's life. Nothing downstream derives SOL from it; the SOL
reserve is read.

### What this says about the §2 diagnosis

§A.3 offered the flat table as confirmation of Phase G §2's fee diagnosis. It is
consistent with it, but PR #63 had already falsified that diagnosis on the AMM by the
same logic: there the **base** side carries no fee either, and it drifted to p50 1.925
at 101+ trades. Both results together say something sharper than either alone:

**The difference between the venues is not fees, it is data completeness.** Pump's own
event stream accounts for every curve trade — 97.9% to 99.5% exact. `dex_solana.trades`
does not account for every AMM base flow. A fee model was never going to fix the second,
and this is the corroboration that it was not the fee.

---

## 3 — §A.3 VALIDATION 2: THE CURVE PRICE AGAINST THE TRADED PRICE. FAILS.

The addendum asks to compare the curve price against the traded price on the positions
that *do* have an observed post-entry price. 225 such positions on the curve
subpopulation:

| | p10 | p50 | p90 | **within 1%** |
|---|---|---|---|---|
| (1 + curve return) / (1 + observed return) | 0.76036 | **1.00189** | **18.18549** | **23.6%** |

**p50 passes and agreement fails, so the conjunction fails.** Mean curve-priced return
−9.02% against +4.38% observed.

### The mechanism, isolated

| how far the curve price is from observed | n | median exit read lag | median curve trades between legs | median curve return | median observed |
|---|---|---|---|---|---|
| within 1% | 53 | 1,451s | **217** | −62.34% | −62.18% |
| 1–10% off | 85 | 450s | **361** | −65.37% | −64.79% |
| 10–100% off | 46 | 1,820s | 721 | +0.00% | +32.97% |
| **more than 2× off** | **41** | 3,548s | **0** | **+0.00%** | **−94.50%** |

**39 of 225 positions had zero curve trades between entry and exit. Their median
|ratio − 1| is 17.185, against 0.032 for the rest.**

That is the whole story. A curve with no trades between the two instants returns
*exactly* the same price at both, so the curve-priced return is +0.00% — while the
token itself did −94.50%, or migrated and traded on the AMM at 18× the frozen curve
price. 14 of the 41 worst positions are in `confirmed_migrations`; the other 27 simply
stopped trading.

**Where the token was still trading, the method works** — 53 positions within 1% and
85 within 10%, medians matching to half a point. But where the token was still trading,
Phase B already had a price. **The coverage curve pricing adds is exactly the coverage
where it is wrong.**

§A.0 said the dual-reserve design "keeps a sellable price available even when real
tokens are depleted". Mechanically yes: the curve will always quote. The quote is the
price at which trading stopped, and treating it as an exit price assumes a buyer at a
price whose absence is the reason there is no trade.

---

## 4 — §A.4, RUN ANYWAY ON THE SUBPOPULATION, AND THE NUMBER THE BRANCH TURNED ON

§A.4 is gated on A.3 passing and A.3 does not pass, so **these figures are not offered
as the re-priced cells.** They are reported because §A.4's last line — the realised
value of the previously-unmarkable positions — is the quantity the branch has been
undecidable over, and the addendum says to report it whatever it says.

Curve-priced, pump-curve subpopulation only, net of the 2.50% flat floor:

| trigger | fired | as-reported n | curve-priced n | as-reported | curve-priced | 95% CI |
|---|---|---|---|---|---|---|
| T1 | 141 | 14 | 95 | **−32.47%** | −0.32% | [−1.00%, +1.80%] |
| T2 | 26 | 4 | 20 | −16.37% | +0.96% | [−0.00%, +1.48%] |
| T3 | 6 | 1 | 5 | +32.97% | +0.00% | [+0.00%, +0.00%] |
| T6 | 444 | 128 | 412 | +4.96% | **−18.87%** | [−25.41%, −11.75%] |
| T7 | 215 | 66 | 189 | +21.74% | **−15.98%** | [−24.99%, +8.18%] |

T4 and T5 reproduce T1 and T2, as they do in Phase B.

**The zero-width interval on T3 is the tell.** Five positions, every one a frozen curve,
every return exactly +0.00%. The T1–T3 curve-priced means near zero are not a finding
about those tokens; they are the frozen-curve artifact from §3 showing up in an
aggregate.

### The previously unmarkable positions, stated explicitly

| trigger | n newly priced | their mean | the survivors' mean | difference |
|---|---|---|---|---|
| T1 | 83 | −0.26% | −32.47% | +32.20% |
| T2 | 16 | +1.21% | −16.37% | +17.58% |
| T6 | 284 | **−20.31%** | +4.96% | **−25.27%** |
| T7 | 125 | **−24.13%** | +21.74% | **−45.87%** |

**Pooled across T1–T7: 611 previously unmarkable positions average −14.35%, against
+4.60% for the 231 survivors.**

So on the only population where the question can be asked at all, the uncovered
positions are **worse** than the survivors by about 19 points. That contradicts the
weak signal from Phase F's 27 markable mints, which pointed the other way (+282.9%
against +234.2%), and it is the direction the censoring literature would predict. It is
also not a clean measurement, because it rests on prices that failed validation §3 —
and the two facts pull in opposite directions on T1/T2 (frozen curves bias *toward*
zero, which flatters the newly-priced set) and the same direction on T6/T7.

**The honest summary: the sign of the correction is not established, and the reason is
that the instrument fails precisely on the positions being corrected.**

---

## 5 — §B, §C AND §D: ALREADY DELIVERED IN PR #63

The addendum reordered Phase G and moved these to second, third and "regardless"
priority. All three had already run and merged before it arrived.

- **§B — the coverage-selected horizon.** `H* = 120s`, selected from a counts-only
  query and committed to git as `2eaed91` before the returns query existed. No cell
  satisfies the four conditions at `H*`. `NO_COPYABLE_HORIZON`. It also closed the
  Phase C cell by measurement: **−4.28% [−5.61%, −2.91%]** at 87.2% coverage against
  the +24.66% Phase C reported at 49.1%.
- **§C — the AMM fee-split correction.** Ran, and **falsified its own premise**: the
  corrected roll-forward is bit-identical to the raw one because the AMM fee is
  quote-denominated and the drift is on the base side.
- **§D — the collector fix.** Shipped. Terminal states are observed and attributed,
  and anything else is a counted `COLLECTION_FAILURE`.

§A.3's flat table raises the value of §C in the addendum's framing. §C had already run
and failed, and §2 above explains why the two results are consistent: completeness,
not fees.

---

## 6 — §A.5, IN THE TERMS THE ADDENDUM REQUIRED

**Every curve figure is gross of impact.** A bonding curve's impact is mechanical on
both legs and is not in the trade stream. Every figure in §4 is an upper bound, not an
edge.

**No curve builder exists.** Phase B established the apparatus cannot enter this
population. Nothing here is permission to consider building one — the numbers did not
come back positive, and the instrument that produced them failed its own validation.

**A decidable branch is not a tradable branch.** The branch is not decidable either.

---

## 7 — CREDITS

| item | credits |
|---|---|
| local anchor inventory: corpus holds no curve or Global account | **0** |
| schema probes (pump tables, TradeEvent shape) | ~4 |
| **Q14 §A.3 validation 1**, 93.9M events | **27** |
| Q15 curve exit prices, 3 chunks × 1,866 positions | ~2 |
| re-pricing and analysis (local) | **0** |
| **addendum total** | **33** |
| Phase G including this addendum | 237 |
| cumulative, all phases | 1,836 of 2,500 |

Two failed executions cost nothing: one for a `realTokenReserves` column that does not
exist, and one where the first Q15 matched 0.1% of targets because I had scoped it to
the **wallet-persistence** window instead of Phase B's own chronological split
(2026-08-17 to 08-19). The second is recorded because it was my error, it was caught by
a coverage figure that looked impossible rather than by luck, and the corrected window
is read from `artifacts/trigger-cells.json` rather than typed in again.

A 496 KB query was refused outright with "HTTP method not allowed" — a size limit
reported as a method error — which is why the re-pricing runs in three chunks.

---

## 8 — LEDGER

- **MT095** — curve-state pricing, its two validations, and the frozen-curve mechanism.
  Result: validation 1 passes flat, validation 2 fails at 23.6%, and the failures are
  the positions with no curve trades between the legs.
- **MT096** — the anchor inventory: the corpus holds no bonding-curve or Global account,
  so the Global-parameter route was unavailable and the event stream replaced it.

---

## 9 — FINAL STATE

```
PRE_MIGRATION_CURVE_PRICED: RECONSTRUCTION_FAILED_VALIDATION
```

The reconstruction that matters — that curve reserves move only when trades move them —
**passes decisively**, at p50 1.00000 and 97.9–99.5% within 1% over 93.9M events. What
fails is the step from curve state to an exit price: a curve quotes its last traded
price forever, so on the censored positions it reports flat when the token went to
−94.5%, and it is wrong there by a median factor of 17.2.

**The censoring did not disappear. It changed clothes.** Phase F had no price for those
positions; curve pricing has a price that is confidently wrong in the favourable
direction.

And the framing the branch inherited does not survive either: **82% of it is not a
bonding curve**, and on the 18% that is, T1's as-reported mean is −32.47% rather than
+234.2%. The positive figures belong to a population of mixed launchpads, not to pump
curves.

What would actually decide this branch is unchanged from Phase G §3's shipping note: an
exit price for mints the collector stopped snapshotting, collected **at the time**, from
the collector's own executable quotes. That is what §D now makes possible for the next
corpus, and it is the only route that prices a position at what someone would actually
pay for it.

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
