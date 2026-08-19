# PHASE G — CHOOSE A HORIZON WHERE PRICES EXIST

2026-08-19. Directive:
`docs/directives/DIRECTIVE_1AD70664_PHASE_G_COVERAGE_SELECTED_HORIZON.md`, committed
verbatim before execution. Predecessor: PR #62 (`34784ca`).

```
FINAL STATE: NO_COPYABLE_HORIZON
```

**The Phase C cell is now closed by measurement, and it closes negative.** It was open
when this phase began — Phase F established that the external interpolation which
described it as closed spans −18.1% to −2.5% depending on how one sentence is read,
that §2.4 never ran, and that the only direct evidence on uncovered positions pointed
the other way. This phase measured the quantity that interpolation guessed at.

**Measured at the highest honest coverage the Phase C estimand is −4.28% [−5.61%,
−2.91%]** on the largest arm, and −4.59% [−6.82%, −2.36%] on the second. Both intervals
exclude zero. The multiplicative reading of the interpolation overshot by a factor of
about four; the additive-points reading was optimistic by roughly 1.8 points; and both
understated how decisive the answer is, because it is not "inside the noise".

Three other things came out of it:

- **The fee-split diagnosis from Phase F is falsified.** Correcting for the fee changes
  nothing, because the PumpSwap fee is quote-denominated and the *base* side — which
  carries no fee under any rule — drifts exactly as badly as before. The route is closed
  for real.
- **The directive's own proposed fee formula is falsified too**, by measuring the
  program instead of assuming it. The pool keeps `quote_gross / (1 + f_total)` on a buy
  and releases `quote_net / (1 − f_total)` on a sell, with `f_total` the whole tier fee.
- **The collector fix shipped.** Death is now an observed terminal state with a recorded
  source, and a mint that stops being observed for any other reason is a counted
  collection failure.

204 credits of a 300 target. The query that closed the largest open question cost 149;
the falsification test cost 15.

---

## 1 — COVERAGE, AND `H*`, BEFORE ANY RETURN APPEARS

### 1.1 The coverage table

Query 8383195, execution `01M0DR7E5HG33PEABQHTQMJW9A`. It returns **counts only** — no
price, no sum, no mean, no ratio — and the analysis asserts the absence of return
fields rather than relying on discipline. Both-legs-priced as a fraction of followable,
at lag 2s:

| arm | H=120s | H=300s | H=600s | H=1200s | H=3600s |
|---|---|---|---|---|---|
| MEDIAN f=0.001 | **95.6%** | 94.2% | 88.3% | 77.4% | 56.2% |
| MEDIAN f=0.01 | 87.9% | 84.5% | 77.9% | 67.5% | 48.7% |
| MEAN f=0.01 | 87.2% | 83.8% | 76.9% | 66.4% | 49.0% |
| MEAN f=0.001 | 65.3% | 61.4% | 59.1% | 54.6% | 48.4% |

Lag 15s is within 0.6 points of lag 2s everywhere. **The 3600s column reproduces Phase
C's independently measured 46% gap** — 49.0% and 48.7% both-legs-priced on the primary
arms — which is the check that this coverage measurement and Phase C are talking about
the same quantity.

### 1.2 The selection, and the evidence that it came first

**`H* = 120s`**, the shortest horizon in the candidate set `{120, 300, 600, 1200}` whose
both-legs-priced fraction reaches 90%. It reaches it in **one arm only**: MEDIAN
f=0.001, at both lags.

The other three arms have **no qualifying horizon** — their best is 87.9% — and per the
directive the bar is not lowered to whatever the best horizon achieved. They are
reported as coverage-failed and their estimates are not presented as estimates.

`H*` was written to the ledger as **MT092** and committed to git as `2eaed91` **before
the query that computes returns existed**. That commit is the evidence for the
ordering; the paragraph is not.

Stated in MT092 in advance, because it is knowable from coverage alone: the qualifying
arm has 137 followable positions and about 131 priced at `H*`, so MT079's power
condition will almost certainly fail there. Recording it in advance means it cannot
later read as an outcome-driven excuse.

**The directive asked for this row as MT089 and MT089 was already spent** on Phase F's
carry-forward correction. A ledger row is never reassigned, so it is MT092 with the
content unchanged, and the collision is recorded in the committed directive's header.

---

## 2 — THE EVALUATION AT `H*`

Query 8383229, execution `01M0DRFDDPXGHG9XG9K3DNFHYX`, a separate execution. Net of the
tier-0 floor (2.669%), with both censoring treatments over the shared enterable
denominator.

| arm | L | coverage | as-priced | 95% CI | censored | n | need | conditions |
|---|---|---|---|---|---|---|---|---|
| MEDIAN f=0.001 | 2s | **95.6% qualifies** | −0.56% | [−5.74%, +3.71%] | −2.79% | 131 | 20,301 | ‑23‑ |
| MEDIAN f=0.001 | 15s | **95.6% qualifies** | +0.68% | [−4.14%, +5.15%] | −1.57% | 131 | 12,003 | ‑‑3‑ |
| MEDIAN f=0.01 | 2s | 87.9% below bar | −4.59% | [−6.82%, −2.36%] | −8.76% | 3,677 | 703 | ‑234 |
| MEAN f=0.01 | 2s | 87.2% below bar | −4.28% | [−5.61%, −2.91%] | −8.75% | 10,975 | 1,064 | ‑234 |
| MEAN f=0.001 | 2s | 65.3% below bar | −2.76% | [−4.52%, −1.20%] | −15.87% | 1,265 | 1,365 | ‑23‑ |

**No cell satisfies all four conditions.** In the qualifying arm, condition 1 fails at
both lags and condition 4 fails by two orders of magnitude, exactly as MT092 predicted
from coverage alone. Condition 2 **holds** at lag 2s — where both treatments are
negative — and fails at lag 15s where they straddle zero.

**Condition 2 holding at all is new.** At 95.6% coverage the two treatments nearly must
converge, and that convergence is precisely what the horizon was selected for. Phases
C, D and E all died on condition 2 with coverage between 46% and 88%; this is the first
cell in the programme where the censoring treatment is not the binding constraint.

### The second question the phase answered

> *"Note the expected tension and do not resolve it by choosing: shorter horizons buy
> coverage and may cost return… Whether the same holds for holding period is
> unmeasured and is the second question this phase answers."*

**It holds.** Shortening the holding period costs return the same way shortening the lag
did. On MEAN f=0.01, as-priced net of the floor against coverage:

| H | coverage | as-priced net | n |
|---|---|---|---|
| 3600s | 49.1% | **+24.66%** | 6,169 |
| 1200s | 66.4% | +5.24% | 8,358 |
| 600s | 76.9% | −3.45% | 9,685 |
| 300s | 83.8% | −5.44% | 10,548 |
| **120s** | **87.2%** | **−4.28% [−5.61%, −2.91%]** | 10,975 |

MEDIAN f=0.01 runs +30.41% → +9.77% → +1.14% → −4.63% → **−4.59% [−6.82%, −2.36%]**
over the same range. The relationship is monotone in coverage and it crosses zero
between 76.9% and 66.4%.

**This is the §0 measurement.** The return Phase C reported lived in the horizon, and
the horizon was the thing that destroyed coverage. At every horizon where more than
three quarters of positions can be priced, the estimand is negative, and on the two
large arms the interval excludes zero.

Note what the coverage bar does and does not govern. It governs the **decision** — which
is why the formal verdict rests on 131 positions in one arm. It does not govern the
**measurement** above, which rests on 14,652 positions across the two large arms and
does not depend on the 90% threshold at all. Those two arms miss the bar by 2.1 and 2.8
points; the bar was not lowered to admit them.

### 3 — Sensitivity, labelled as such

Every horizon other than `H*` is sensitivity and never a candidate. **A cell that fails
at `H*` and passes at some other `H` is a failure**, and the place that would be visible
is the table above: MEAN f=0.01 clears condition 1 at no horizon, and MEDIAN f=0.001
clears it at none either. The +24.66% at 3600s clears nothing — its coverage is 49.1%
and its censored treatment is −33.09%.

---

## 4 — THE FALSIFICATION TEST FOR PHASE F's DIAGNOSIS

Phase F diagnosed the monotone roll-forward drift as the PumpSwap fee split leaving the
pool. §2.2 is the test of that claim, on the identical 271 pairs and 117,324 legs.

### 4.1 The fee direction, measured from the program rather than assumed

`pnpm fee:direction` probes the pinned SDK — the program's own client, whose instruction
shapes Phase B reproduced against six distinct stored on-chain shapes — on real stored
pool state, and reads the decomposition from the constant-product invariant.

| pool tier | lp | total bps | kept, MEASURED | `1−(p+c)/10⁴` | `1/(1+f_total)` |
|---|---|---|---|---|---|
| 0 | 2 | 125 | **0.987654** | 0.987700 | **0.987654** |
| 16 | 20 | 50 | **0.995025** | 0.997000 ✗ | **0.995025** ✓ |

**The directive's proposed formula is falsified.** It agrees at tier 0 to 0.5 bps by
coincidence and separates at tier 16, where `lpFeeBps` is 20. The measured relation is:

```
BUY   the pool keeps    quote_gross / (1 + f_total)
SELL  the trader gets   quote_pool  x (1 - f_total)
```

Both sides measured to six decimal places across five pools, and **they differ from each
other** — exactly the asymmetry the directive said to decode rather than infer.

No iteration was needed for the tier, and that is a finding rather than a shortcut: the
program reads the reserves the previous trade left, so the sequence resolves it and no
simultaneous fixed point arises. 77 tier changes occurred across all pairs.

### 4.2 The stratified revalidation — the diagnosis does not survive

| trades between snapshots | pairs | RAW base p50 | **MEASURED base p50** | RAW within 1% | **MEASURED within 1%** |
|---|---|---|---|---|---|
| 1 | 26 | 1.00000 | **1.00000** | 100.0% | **100.0%** |
| 2–5 | 30 | 1.00000 | **1.00000** | 80.0% | **80.0%** |
| 6–20 | 38 | 1.02736 | **1.02736** | 34.2% | **34.2%** |
| 21–100 | 48 | 1.18247 | **1.18247** | 0.0% | **0.0%** |
| 101+ | 42 | 1.92526 | **1.92526** | 2.4% | **2.4%** |

**Identical. The drift does not collapse; it does not move at all.**

Overall agreement within 1%: 55.7% base / 52.8% quote raw, 55.7% / 52.0% under the
directive's rule, 55.7% / 53.1% under the measured rule. The bar is a conjunction — p50
within 1% **and** agreement above 95% — and it fails on every rule.

**The reason is structural and it is the useful part.** The PumpSwap fee is
quote-denominated, so the base side carries **no fee under any rule** — and the base side
is where the drift is. No fee model can repair a base-flow discrepancy. Phase F's
diagnosis was wrong, and the route is closed for real.

### 4.3 Where the residual actually lives

- Drift correlates with sell-heaviness: pairs whose reconstructed base is more than 1%
  too **high** have a **71.8%** sell share of legs, against **53.9%** for pairs that
  agree. 42 of 271 pairs imply a negative reserve.
- **Ruled out:** the fee split (the base carries none); double counting (0 of 117,324
  legs share a slot, transaction and instruction index); multi-pool routing (9 of
  115,994 transactions touch more than one of these pools).
- **Not ruled out:** a misalignment between the slot a snapshot records and the account
  state it captured; base outflows that are not WSOL-paired pumpswap swaps; an
  incomplete leg set for some other reason.

**No third estimator was tried**, per the directive. `PHASE_C_CELL` stays
`RECONSTRUCTION_FAILED_VALIDATION`, §2.3 did not run, and §1's coverage route is the
only evaluation of that cell this programme will produce — which, as it turns out, is
enough, because §1 answered the question the reconstruction was going to be used for.

---

## 5 — THE COLLECTOR FIX (§3), SHIPPED

Phase F could not decide the pre-migration branch because **97.5% of censored mints had
no post-entry price at all**. The mechanism is now identified exactly:
`maturingByCohort` selects mints whose **age** falls inside a cohort band, so once a
mint is older than the widest band **it can never be selected again**. Observation
stopped at an age that was a property of the queue rather than of the mint, and a dead
mint became indistinguishable from an unobserved one.

**What shipped:**

- `packages/pipeline/src/observation-watch.ts` — the schedule, the terminal-state
  taxonomy, the frozen thresholds, and the classifier that separates a fact about the
  market from a fact about the collector.
- Migration 55, `observation_watch` — one row per mint under observation, with a `CHECK`
  constraint enumerating the taxonomy so a fourth reason cannot be inserted without a
  migration that says what it means, and the closing reading stored so a `POOL_DRAINED`
  closed on a reserve nobody can see is not accepted as a measurement.
- `packages/storage/src/observation-watch-repo.ts` — open, advance, close, audit.
- `packages/pipeline/src/cycle.ts` — the watch supplements the cohort queue, so a mint
  under observation is screened whatever the queue thinks; most-overdue-first and capped
  at 25 so neither starves the other. Terminal states are recorded at the same site the
  snapshot is written.

**The taxonomy, with its frozen thresholds:**

| terminal state | fires when | source recorded |
|---|---|---|
| `POOL_DRAINED` | quote reserve < 0.1 SOL, or provider liquidity < 50 USD when no reserve was read | `ON_CHAIN_RESERVE` / `PROVIDER_LIQUIDITY` |
| `NO_TRADE_INTERVAL` | 2 hours since trading was **observed** — twice the longest mark offset | `OBSERVED_TRADES` |
| `HORIZON_REACHED` | 24 hours since first observation | `CLOCK` |
| *(not terminal)* `COLLECTION_FAILURE` | observation lapsed with no terminal state | counted, never called death |

Observation continues on the mark offsets and then at a **30-minute cadence** — Phase F's
gap was everywhere *after* the queue lost interest, not at any particular horizon, so
the schedule cannot simply end.

**Fail closed on absence, and it is asserted by test.** A reading the cycle could not
take is `null`, and a null reading never fires a terminal state. The old behaviour turned
an unobserved mint into an implicit death; a fix that let a missing reading close a watch
would reintroduce exactly the defect it repairs. A closed watch is never reopened,
because a terminal state is a finding. The no-trade clock advances only on **observed**
trading, so a collector outage cannot masquerade as a dead pool.

**One assertion caught an error in my own reasoning.** The module first claimed the
two-hour interval was *four times* the longest mark offset when it is *twice*. The test
pins the ratio, so the claim was corrected before it shipped rather than after.

19 tests, and `pnpm check` green at **143 files / 2,175 tests**. Nothing about the
existing corpus changes; everything about the next one does.

---

## 6 — CREDITS, PER QUERY

| query | credits |
|---|---|
| §2.1 fee direction (local corpus, `pnpm fee:direction`) | **0** |
| §1.1 Q11 coverage by horizon | 149 (with Q12) |
| §1.3 Q12 returns by horizon | ↑ |
| §2.2 Q13 validation legs | 12 |
| §2.2 revalidation (local, `pnpm revalidate`) | **0** |
| §3 collector fix | **0** |
| **Phase G total** | **204** |
| cumulative, all phases | 1,808 of 2,500 |

Target 300, ceiling 500, per-query 250. Inside all three.

---

## 7 — LEDGER

- **MT092** — `H*` preregistered from a counts-only query and committed to git before
  the returns query existed. Result: no cell satisfies the four conditions at `H*`; the
  coverage-to-return relationship measured across all horizons.
- **MT093** — the fee-split correction and its falsification test. Result: not
  supported; the base side carries no fee and drifts identically; the residual located
  and three causes ruled out.
- **MT094** — the collector's terminal-state taxonomy and its frozen thresholds,
  recorded before the collector ships them.

The ID collision the directive introduced (it asked for MT089, which Phase F had spent)
is recorded in the committed directive's header rather than resolved silently.

---

## 8 — FINAL STATE

```
NO_COPYABLE_HORIZON
```

A horizon does reach 90% coverage, so the venue **can** be priced honestly at a holding
period this data supports — `NO_HORIZON_REACHES_COVERAGE` is not the answer. At that
horizon the conditions fail, with the two treatments agreeing in sign at lag 2s.

**And the Phase C cell is closed by measurement.** Not by interpolation, not by
reconstruction, and not by an inference that was never entitled to the word: by
measuring the same estimand at every horizon and reading off the value where prices
exist. It is **−4.28% [−5.61%, −2.91%]**, and it is negative because the +24.66% Phase C
reported was a property of a horizon at which half the positions had no price.

What remains unmeasured, unchanged except for the one item this phase removed:

1. **Our own market impact.** Every price in Phases C–G is a VWAP of *other* traders'
   fills. Only the collector's own executable quotes can measure ours.
2. **An exit rule that is not the wallet's.** Every copy failure since Phase C has been
   an exit failure and every exit tested has been the wallet's own or a fixed clock. A
   stop, a target or a trailing rule has never been tested.
3. **The base-flow discrepancy** in the reserve reconstruction, now located to the base
   side with three candidate causes and three ruled out.

~~An exit price for mints the collector stopped snapshotting~~ — **the collection defect
is fixed**, from the next corpus onward.

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
