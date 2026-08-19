# CLAUDE CODE DIRECTIVE — EPITAXY: MEASUREMENT POWER, COST FLOOR, AND COHORT SELECTION

**Repository:** `TateLyman/epitaxy`
**Branch:** `master`
**Date:** 2026-08-18
**Received as:** `d70b4a9a-epitaxy_measurement_power_directive.pdf`

> **TRANSCRIPTION NOTE.** This file is a transcription of the delivered PDF, which
> is the authoritative text. The PDF's text layer numbers its ordered lists out of
> a symbol font, so item markers arrive as `!`, `#`, `$`, `%`, `&`, `'`, `*`, `!+`,
> `!!`, `!#`; `—` arrives as `Ñ`, `–` as `Ð`, `§` as `¤`, and `×`/`≈`/`²` as `!`
> and `"`. Those are mechanical and are restored here.
>
> **Two blocks are missing from the PDF's text layer entirely** and are NOT
> reconstructed below, because guessing the contents of a blocking test list is
> exactly the kind of quiet substitution this project treats as a defect:
>
> 1. **§2.1's list of blocking tests.** The heading "Blocking — lookahead and
>    family coherence" is present and its item list is absent.
> 2. **The third rationale block in §2.5**, whose deferred section numbers are
>    absent. Its rationale text ("these are alpha and risk improvements … freeze
>    the current deterministic score as baseline per §15 and do not tune")
>    survived, so the *subject* is identifiable and the *section list* is not.
>
> Both gaps are reported in the final report, and the inference used in their
> place is stated there explicitly rather than silently adopted here.

**Relationship to prior directives:** This directive **reprioritizes and partially
defers** `epitaxy_4890af0_profitability_truth_directive.md`. It does not replace its
correctness standards. Where this directive defers a section of 4890af0, the section
remains required before canary — it is removed from the critical path to
*development simulation*, not from the project.

**Current honest state:** `MEASUREMENT_REPAIR_REQUIRED`
**Permitted modes:** observe, development structural shadow, development simulated shadow
**Forbidden:** canary, live, funding a trading wallet, signing, submitting, weakening any
capital gate, weakening any §19 admissibility criterion after seeing results, or claiming
profitability.

`CANARY_READY`, `LIVE_READY`, and `PROFITABLE` remain forbidden outputs.

---

# 0 — WHY THIS DIRECTIVE EXISTS

The instrument is being built to a standard higher than the decision requires, on a
critical path that does not terminate. 172 commits, six directives, zero positions
establishing executable PnL.

Three specific defects in the current plan, in order of cost:

1. **The confirmatory gate is underpowered.** §19 of 4890af0 requires 200 valid
   positions. For a screened memecoin return distribution the coefficient of variation
   is ~15. Required n at 80% power is `7.84 × CV² ≈ 1,670`. At n=200 the power to
   detect a genuinely profitable strategy is approximately **16%**. The gate as written
   will reject a working strategy roughly five times out of six.
2. **The primary cohort is the least measurable one.** The 2m–60m cohort has the highest
   CV and the lowest signal throughput. It is the slowest possible route to any
   conclusion.
3. **The development notional sits at the maximum of the cost curve.** At 0.02 SOL, ATA
   rent (0.00203928 SOL) is 10.2% of notional and priority fees are ~5% of notional.
   Neither a null nor a positive result at 0.02 SOL transfers to a deployable size.

The objective of this directive is the **fastest path to a truthful decision**, where
`STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is an equally acceptable outcome to a positive
one.

---

# 1 — PHASE A: THE KILLER EXPERIMENT (TARGET: ONE WEEK, NO NEW COLLECTION)

Phase A runs entirely against the 2000 stored decision snapshots and stored BUILD
observations. Do not collect new data for Phase A. Do not fix anything not listed in
Phase A.

## 1.1 Corrected cost surface

Implement §10.1–§10.6 of 4890af0 (priority fee two-pass with ceiling, default CU limit
from actual instructions, failed-attempt expectation, ATA/rent tracking, transfer fees,
one accounting module). This is the only section of 4890af0 promoted, not deferred.

Compute round-trip cost as a fraction of notional at each of:

```text
0.02  0.05  0.10  0.20  0.35  0.50  1.00 SOL
```

For each notional report, separately:

- base signature cost
- expected failed-attempt cost
- ATA rent locked
- ATA rent recovered / not recovered
- total round-trip cost as % of notional

Emit `artifacts/cost-surface.json` and a plot of cost% versus notional.

**Expected shape:** a U-curve. Fixed costs dominate below ~0.1 SOL; impact dominates
above. Identify `notional_min_cost` and `cost_floor_pct` at that point.

## 1.2 Gross edge distribution from stored data

From the 2000 stored snapshots, reconstruct forward returns at each cohort horizon using
stored quote data only. This is **not** evidence and must be labelled
`DEVELOPMENT_RECONSTRUCTED`. Its sole purpose is estimating distribution shape.

For each cohort in `{2m–60m, 1h–5h, 5h–24h, 24h–7d}` report:

- n available
- mean gross return
- SD
- CV
- skew
- kurtosis
- required n at 80% power = `7.84 × CV²`
- fraction of total gross return contributed by top 1 / 3 / 5 / 10 outcomes

## 1.3 The decision

Compare `cost_floor_pct` against the mean gross return per cohort.

```text
if cost_floor_pct >= mean_gross_return for every cohort at every notional:
    final state = STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
    write docs/KILL_REPORT.md and stop
```

This is a legitimate and valuable terminal state. Write it up properly if reached. Do not
search for a notional or cohort that rescues it — that is a garden of forking paths and
the multiple-testing ledger must record every combination examined in this step
regardless of outcome.

## 1.4 Cohort selection

If not killed, select the confirmatory cohort by **lowest required n**, not highest mean
return.

Record the choice, the CV estimates it was based on, and the fact that it was selected on
development data, in `docs/MULTIPLE_TESTING_LEDGER.csv`. The selected cohort receives an
untouched future test per §16 of 4890af0.

## 1.5 Confirmatory notional

Set the development and confirmatory notional to `notional_min_cost`, not 0.02 SOL,
unless `notional_min_cost` exceeds what the intended bankroll can support at the §19
position count. If it does, use the largest supportable size and record the cost penalty
explicitly.

Development and confirmatory notional must be identical. Freeze both.

---

# 2 — PHASE B: MINIMUM HONEST INSTRUMENT (BLOCKING SET ONLY)

Of the 54 regression tests in §22 of 4890af0, the following can **fabricate or destroy
edge** and are blocking. Implement only these before collection starts.

## 2.1 Blocking — lookahead and family coherence

> **[The PDF's text layer contains this heading and no items. See the transcription
> note at the head of this file.]**

## 2.2 Blocking — cost fabrication

```text
16  missing minimum output fails
17  missing blockhash/expiry/context fails
26  priority fee uses ceiling
27  default CU limit matches official rules
28  two-pass CU rebuild uses frozen margin
29  failed-attempt expectation is not double-charged
30  same-transaction ATA close has no extra signature
31  rent treatment matches viability and PnL
32  transfer fee unknown fails confirmatory
43  shadow exit includes all costs
48  provider disappearance is not -100%
```

## 2.3 Blocking — silent numeric corruption

```text
9   u64/token amount above 2^53 is exact or refused
```

A 1e9-supply token at 6 decimals is 1e15 atoms; 2^53 ≈ 9.0e15. Large positions in
high-supply mints will cross this. Silent [rounding-mode word missing from the PDF]
rounding here corrupts PnL invisibly.

## 2.4 Blocking — evidence integrity

```text
33  portfolio entry requires immediate same-family sell
34  portfolio mark cannot use /order
35  counterfactual gets later same-family fill    <-- highest risk, classic lookahead bias
36  accepted signal opens fixed alpha and canary shadows
37  refused signal opens fixed alpha and canary shadows    <-- survivorship
53  zero simulator observations cannot be presented as valid PnL
15  exact transaction blob round-trips
21  incomplete account coverage refuses confirmatory
22  ALT-loaded writable post-state is observed
```

## 2.5 DEFERRED to pre-canary — do not work on these now

```text
4.1 / 4.2 / 10 / 11 / 12 / 13   multi-ALT ordering and differential compiler proof
```

Rationale: an incorrect encoder causes simulation to **fail loudly**, not to silently
inflate PnL. It is an execution-correctness requirement, not a measurement-integrity
requirement. The executor is blocked. Defer.

```text
3.2 / 3.3 / 5 / 6 / 7 / 8       daemon idempotency and queue semantics
```

Rationale: with `MAX_ACTIVE_SURFNETS = 1` and serialized FIFO, throughput is not the
bottleneck — see §3.1. Keep serialization; defer the idempotency machinery.

```text
[section list missing from the PDF's text layer]
```

Rationale: these are **alpha and risk improvements**. They change what the strategy is.
Changing the strategy before measuring the current one restarts the clock and consumes
multiple-testing budget. Freeze the current deterministic score as baseline per §15 and do
not tune.

---

# 3 — PHASE C: COLLECTION

## 3.1 Throughput budget — compute before collecting

Report, before starting:

- marks per position per hour under the SLA
- Jupiter `/build` calls per day required at target concurrency
- Jupiter rate budget available
- Surfnet median startup ms and median simulation ms
- simulations per day required = positions × [marks]
- simulations per day achievable at `MAX_ACTIVE_SURFNETS = 1`
- projected calendar days to `required_n` for the selected cohort

If projected days to `required_n` exceeds 120, stop and report before collecting. Do not
begin a window that cannot finish.

**Expected bottleneck:** eligible signal arrival rate, not simulation. At 3s serialized per
simulation, 33,000 simulations is ~27 machine-hours spread across months. Do not optimise
the simulator until this report proves it is the constraint.

If it **is** the constraint, the remedy is a two-tier simulation path: LiteSVM in-process
for routine marks, Surfpool for the parity-anchored subset, with a proven agreement sample
between them. Do not build this speculatively.

## 3.2 Development window

Per §18 of 4890af0, with these amendments:

- notional = `notional_min_cost` from §1.5, not 0.02 SOL
- one cohort only (the selected one) as the primary arm
- other cohorts run as **structural shadows only** — no simulated fills, no policy
  comparison
- report at 25 / 50 / 100 valid completed simulated positions
- do not select a policy before 50
- fifty is not deployment evidence

## 3.3 Confirmatory window — amended admissibility

§19 of 4890af0 stands, with three corrections:

**Correction 1 — sample size.** Replace "at least 200 valid completed positions" with:

```text
max(300, 7.84 × CV_observed²)
```

where `CV_observed` is measured on the development window, not assumed. Recompute and
report the implied n at the 50 and 100 checkpoints. If implied n exceeds what the calendar
allows, say so and stop rather than proceeding underpowered.

**Correction 2 — primary metric and the tail contradiction.**

§19 currently requires **both** positive expected log growth **and** positive expectancy
after removal of the top 1/3/5/10 trades and the best day and best five mints. For a
tail-driven asset class these are contradictory: the edge, if it exists, **is** the tail. A
memecoin strategy that survives top-10 removal at n=300 is not a memecoin strategy.

Resolve as follows, and record the resolution in the ledger **before** collecting:

*Primary:*

- expected log growth per position at frozen fractional sizing f,
- lower bound of the 95% bootstrap CI must exceed zero

*Diagnostics (recorded, not gating):*

- expectancy after top 1/3/5/10 removal
- expectancy after best day removed
- expectancy after best five mints removed
- profit factor

A diagnostic failing does not fail the gate. It is recorded and interpreted. Concentration
in the tail is an expected property of this strategy, not a defect — but it must be
**disclosed** alongside any positive result, because it determines the drawdown a live
operator would actually experience.

**Correction 3 — retain all other gates unchanged.** Do not weaken any of these after
seeing results:

```text
21 calendar days minimum
multiple market conditions
positive chronological untouched-holdout net expectancy
acceptable drawdown / CVaR
positive under 2× costs
positive under latency / failure / rent stress
zero replay divergence
zero unresolved reconciliation
stable protocol and simulator fingerprints
comparison against: no trade, hold SOL, random contemporaneous eligible entry,
                    hard-gates-only, current deterministic score, previous frozen policy
```

---

# 4 — REPOSITORY VISIBILITY

The repository is public. Six directives describing the screening logic, the cost model,
the gate structure and the intended strategy are readable unauthenticated.

There is currently no edge to protect, which is precisely why this is free to fix now.

Recommend to the operator, and do not act without explicit approval:

- **Option A:** make the entire repository private
- **Option B:** public research/core, private ops/strategy/runtime

Report the exact action required. Do not change visibility unilaterally.

---

# 5 — WHAT NOT TO BUY

No paid archival node, shreds stream, co-located VPS, Jito relationship, or premium RPC
tier until:

```text
positive corrected strategy edge
+ measured profit lost to infrastructure
> upgrade cost
```

The only defensible spend before that point is **calendar time**: a cheap always-on box so
the collection window runs unattended 24/7. Calendar time is the scarcest resource in this
project; latency is not, because the executor is blocked.

Specifically do **not** purchase anything intended to improve execution speed. Nothing in
the current critical path is latency-bound.

---

# 6 — REQUIRED FINAL REPORT

1. local starting and ending SHA
2. cost surface across all seven notionals, with the U-curve minimum identified
3. `cost_floor_pct` at `notional_min_cost`
4. per-cohort CV, skew, kurtosis, and required n
5. selected confirmatory cohort and the basis for selection
6. selected confirmatory notional
7. blocking-set test results (§2.1–§2.4), each passing or explicitly failing
8. explicit list of every 4890af0 section deferred, with the deferral reason
9. throughput budget and projected calendar days to required n
10. multiple-testing ledger diff — every threshold, cohort and notional examined in Phase A
11. repository visibility action required
12. one final state only:

```text
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_SIMULATION_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
```

The expected honest next milestone is `VALID_DEVELOPMENT_SIMULATION_RUNNING` or
`STRATEGY_KILLED_BY_CORRECTED_ECONOMICS`. Both are successes. Only one of them is slow.

Do not run canary or live. Do not fund a wallet. Do not claim profitability.
