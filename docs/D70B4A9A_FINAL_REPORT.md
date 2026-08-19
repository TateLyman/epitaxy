# D70B4A9A — MEASUREMENT POWER, COST FLOOR, AND COHORT SELECTION

**Directive:** `epitaxy_d70b4a9a_measurement_power_directive.md` (delivered as
`d70b4a9a-epitaxy_measurement_power_directive.pdf`, 2026-08-18)
**Repository:** `TateLyman/epitaxy` · branch `directive/d70b4a9a-measurement-power`
**Final state:** `MEASUREMENT_REPAIR_REQUIRED`

Nothing was signed, submitted or funded. No wallet exists. No window was opened.
`pnpm canary` and `pnpm live` were not run and the live acknowledgement file was
not created.

---

## 0 — THE SHORT VERSION

Three claims came out of Phase A, and two of them contradict the directive's own
premises.

1. **The cost floor is 2.69% of notional at 0.02 SOL, and 0.02 SOL is 2 bps
   above the cheapest notional available rather than at the maximum of the cost
   curve.** The directive's premise — ATA rent at 10.2% of notional, priority
   fees at ~5% — does not survive measurement. Rent is recovered in the same
   transaction as the exit (measured: 2,063,690 of 2,067,391 lamports, on 412
   sells) so it is locked capital and not a cost, and the router's median unit
   price against a two-pass frozen compute limit is 1,047 lamports a leg, which
   is 0.01% of notional. What is left rises monotonically with size: 2.69% at
   0.02 SOL, 4.02% at 0.20, 9.61% at 1.00.

2. **The strategy is not killed, and nothing is demonstrated.** Four of 36
   (cohort × notional) combinations clear the cost floor, all in the 2m–60m
   cohort at 0.05 SOL and below, by 16 to 38 basis points. At the mean's own 95%
   day-clustered lower bound, **zero of the 36 clear it.**

3. **The confirmatory window the corrected sample size demands cannot be
   collected.** The measured coefficient of variation is 21 to 127 depending on
   cohort, against the 15 the directive assumed, so required n is 3,441 to
   127,151 rather than 1,670. For the selected cohort that is 49,854 mints, and
   at the measured arrival rate of 79 settled mints a day it is **632 calendar
   days**. §3.1 forbids beginning a window that cannot finish, so none was begun.

The bottleneck is eligible signal arrival, exactly as the directive predicted,
and it is not close: the simulator could carry 8,174 positions a day and the
router budget 22,511.

---

## 1 — LOCAL STARTING AND ENDING SHA

```text
starting  d8ede90a70afaf6efe6d5e606700eb27fb8512c0   (master, clean)
ending    d4ecb68e03e8dcaed5303e73335483122202597b   (directive/d70b4a9a-measurement-power)

34c7d5d  Land the measurement-power directive, with the two blocks its PDF lost marked as lost
a162b10  0.02 SOL is 2 bps off the cheapest notional, not the maximum of the cost curve
36e6fb3  One cohort of four has a mean distinguishable from zero, and it needs 49,854 positions
4e2134c  632 days to the required sample, so 3.1 refuses the window before it starts
e5079e5  Four of thirty-six combinations clear the cost floor, and none of them clears it on a lower bound
d4ecb68  The blocking set gets one file and one verdict each, and section 19 gets its two corrections
```

Environment at the start: node v24.12.0, pnpm 11.21.0, `pnpm check` green at
129 files / 1,957 tests. No collector or engine process was running — the pid in
`data/trajectory-collector.pid` (31276) is dead. Nothing capital-bearing was
active at any point.

**Two blocks of the directive did not survive its own PDF.** The text layer
numbers ordered lists out of a symbol font, so item markers arrived as
punctuation and `—`, `§`, `×` and `²` arrived as mojibake; those are mechanical
and were restored in the transcription. What could not be restored:

- **§2.1's list of blocking tests.** The heading "Blocking — lookahead and family
  coherence" is present; its items are absent.
- **The section numbers of §2.5's third deferral.** Its rationale text survived
  ("these are alpha and risk improvements … freeze the current deterministic
  score as baseline per §15 and do not tune"), so the subject is identifiable and
  the list is not.

Both are marked as absent in the transcription rather than filled in from
context, and §7 and §8 below state exactly what was done in their place.

---

## 2 — COST SURFACE ACROSS ALL SEVEN NOTIONALS

`pnpm cost:floor` → `artifacts/cost-surface.json`, `artifacts/cost-surface.svg`

Computed entirely from stored state: 142 stored coherent snapshots (latest per
pool, 142 distinct pools over 142 mints) priced offline through the pinned
PumpSwap SDK, with fixed costs from `leg_settlements`, `simulation_steps`,
`created_accounts` and 4,945 stored `/swap/v2/build` bodies. **No network call
and no new collection.**

| notional (SOL) | fixed % | venue % | of which impact | **total %** | admissible pools |
|---|---|---|---|---|---|
| 0.005 \* | 0.25 | 2.51 | 0.03 | **2.75** | 142 / 142 |
| 0.01 \* | 0.13 | 2.55 | 0.07 | **2.67** | 142 / 142 |
| 0.02 | 0.07 | 2.63 | 0.15 | **2.69** | 142 / 142 |
| 0.05 | 0.03 | 2.86 | 0.38 | **2.88** | 142 / 142 |
| 0.10 | 0.02 | 3.25 | 0.77 | **3.26** | 118 / 142 |
| 0.20 | 0.01 | 4.01 | 1.53 | **4.02** | 34 / 142 |
| 0.35 | 0.01 | 5.14 | 2.66 | **5.14** | 12 / 142 |
| 0.50 | 0.01 | 6.23 | 3.75 | **6.23** | 6 / 142 |
| 1.00 | 0.01 | 9.61 | 7.13 | **9.61** | 2 / 142 |

`*` below the directive's grid — a diagnostic, recorded in the ledger as MT057
because a monotone grid locates its minimum at or below its smallest point and
does not say where.

**Shape: `MONOTONE_INCREASING` over the directive's seven notionals, with the
true minimum at 0.01 SOL.** There is a U-curve; its left arm is inside the
smallest notional on the grid, because the fixed costs are two orders of
magnitude smaller than the directive assumed.

Per the directive's required breakdown, per notional:

- **base signature cost** — 10,000 lamports per round trip. Measured, not
  assumed: `leg_settlements` carries 5,000 on all 824 legs.
- **expected failed-attempt cost** — **UNKNOWN.** `execution_attempts` is empty
  because nothing has ever been submitted, and zero attempts is not a zero rate.
  The primary total carries `complete: false` for exactly this reason. Priced at
  a stressed 20% landed-failure rate it moves the total by 1 bp.
- **ATA rent locked** — 2,067,391 lamports per position, for the life of the
  position.
- **ATA rent recovered / not recovered** — recovered. `leg_settlements` measures
  2,063,690 lamports coming back on every sell, because the base ATA close rides
  the exit swap. Per-trade unrecoverable rent is **0**. What is not recoverable is
  one-time per wallet: 3,883,680 lamports for the PumpSwap user volume
  accumulator (1,844,400) and the WSOL ATA (2,039,280).
- **total round-trip cost as % of notional** — the table above.

Supporting measurements, each from its own source:

```text
router unit price      3,810 microlamports/CU, median over 4,945 of 4,945 stored builds
units consumed         p50 212,869   p90 228,985   max 247,002   over 826 legs
applied CU limit       603,000 derived when the router omits one; 274,782 requested
                       under the two-pass frozen 20% margin
priority fee per leg   2,298 lamports as currently built; 1,047 with the frozen limit
transfer fees          MEASURED on 824 of 824 legs; none applicable
fee floor              248 bps round trip (124 bps one way), from a 0.0002 SOL probe
```

The 248 bps fee floor is an independent match for the 241.5 bps median AMM drag
the P13 true-stateful surface measured through the simulator, on a different
instrument and a different sample.

**`notional_min_cost` = 0.02 SOL. `cost_floor_pct` = 2.6858%.**

### The one modelling choice that matters

The exit is priced against the **pre-buy** reserves, not against the state the
buy would leave. Against the post-buy state a constant-product round trip returns
the entry exactly, first-order impact cancels, and the drag is flat in size —
which is precisely why the P13 grid measured 241.5 bps at every size it tried.
Against the pre-buy state the entry pays above the mid and the exit sells below a
mid of the same depth, nothing cancels, and the `2·N/R` term appears. The strategy
holds for minutes to days, so its exit meets a pool of whatever depth the market
left rather than one still carrying its own entry: the cancellation is an artifact
of same-transaction accounting, and the non-cancelling form is the honest one. The
artifact states which was done, in a field named `exitPricedAgainst`.

### Admissibility is the harder constraint above 0.1 SOL

Under the **unchanged** `FROZEN_SIZE_BOUNDS` (reserve share ≤ 50 bps, entry
impact ≤ 50 bps, round-trip drag ≤ 400 bps), the large notionals are not merely
dear — they are mostly unenterable. 118 of 142 stored pools can take 0.10 SOL, 34
can take 0.20, and 2 can take 1.00. No bound was widened to improve that.

---

## 3 — `cost_floor_pct` AT `notional_min_cost`

**2.6858% of notional**, at 0.02 SOL, of which 2.63% is the venue (2.48% fee tier
+ 0.15% impact) and 0.07% is fees. It is a **lower bound**: the failed-attempt
term is unknown and charged at zero, and the surface's own accounting flag says so.

---

## 4 — PER-COHORT CV, SKEW, KURTOSIS AND REQUIRED N

`pnpm edge:distribution` → `artifacts/gross-edge-distribution.json`

Reconstructed from 489,628 in-band stored snapshots over 112,584 mints, labelled
`DEVELOPMENT_RECONSTRUCTED` with `isEvidence: false`. **This is not evidence.** It
is provider mid prices the system never traded at — no fill, no route, no depth,
no cost — and its only sanctioned use is estimating distribution shape.

Population: all screened mints with an observed exit, SOL-denominated. Entry is
the FIRST snapshot at or after the cohort's lower bound (within a quarter of the
band); exit is the snapshot NEAREST the upper bound (within ±25%); one
observation per mint.

| cohort | n | days | mean | SD | **CV** | skew | excess kurtosis | **required n** |
|---|---|---|---|---|---|---|---|---|
| 2m–60m | 59,197 | 6 | +3.04% | 2.427 | **79.7** | 71.9 | 6,723 | **49,854** |
| 1h–5h | 1,334 | 4 | +0.31% | 0.390 | **127.4** | 22.3 | 619 | **127,151** |
| 5h–24h | 4,860 | 2 | −1.22% | 0.612 | **50.2** | 64.5 | 4,369 | **19,780** |
| 24h–7d | 16,790 | 1 | −0.43% | 0.090 | **21.0** | 41.1 | 3,227 | **3,441** |

**Every cohort is above the CV of 15 the directive assumed**, so the 200-position
gate was underpowered by more than the directive itself claimed. The premise that
2m–60m carries the highest CV is not confirmed — 1h–5h does — but 2m–60m does
carry by far the highest **dispersion**: SD 2.427 against 0.090 for 24h–7d, a
factor of 27.

### Tail concentration

Share of the summed return, and share of all the gain in the sample, carried by
the top k mints:

| cohort | top 1 | top 3 | top 5 | top 10 | share of GAIN, top 10 | positive | median |
|---|---|---|---|---|---|---|---|
| 2m–60m | 16.0% | 40.7% | 58.3% | **83.6%** | 22.7% | 32.6% | −0.22% |
| 1h–5h | — | — | — | — | 61.2% | 69.9% | +0.06% |
| 5h–24h | — | — | — | — | 70.9% | 25.3% | −1.76% |
| 24h–7d | — | — | — | — | 16.3% | 40.8% | −0.15% |

Dashes are where the summed return is a cancellation rather than a total, so a
share of it means nothing; the artifact reports `topShareInterpretable` and the
share-of-gain column, which is always well defined. The largest single observation
in 2m–60m is **+28,890%**.

This is Correction 2's premise, measured: the top 10 mints of 59,197 carry 83.6%
of the summed return while the median mint loses 0.22%. A strategy that survived
top-10 removal at n=300 would not be this strategy.

### Censoring, which is the largest available bias here

| cohort | mints with an entry | no exit price | censored | carry-forward mean |
|---|---|---|---|---|
| 2m–60m | 90,321 | 31,124 | 34.5% | +2.85% (n=74,182) |
| 1h–5h | 3,538 | 2,204 | 62.3% | +105.5% (n=2,089, one +1,160% outlier) |
| 5h–24h | 8,351 | 3,491 | 41.8% | −0.04% (n=4,870) |
| 24h–7d | 27,211 | 10,421 | 38.3% | −0.32% (n=16,790) |

The carry-forward variant prices a censored mint at its last observed value. **No
disappearance is priced as −100%** — absence of a provider row is a fact about
the provider. For 2m–60m, carrying the censored mints forward pulls the mean from
+3.04% to +2.85%, which is 16 bps above the cost floor rather than 36.

### The required n is identified for exactly one cohort

`7.84 × CV²` divides by the observed mean, so when the mean's interval contains
zero, an infinite CV is inside the same interval and required n is unbounded.

```text
2m-60m   mean 95% interval [+1.72%, +4.78%]   excludes zero   IDENTIFIED
1h-5h                      [-7.37%, +0.51%]   contains zero   not identified
5h-24h                     [-2.16%, +6.98%]   contains zero   not identified
24h-7d                     no estimable interval: 16,790 mints on ONE UTC entry day
```

The 24h–7d exclusion is a fact about the **corpus**, not the market: a 7-day
horizon inside a 10-day corpus can only be satisfied by mints that were already
old when collection started, so every entry falls on one day, the day-clustered
bootstrap has one cluster, and dispersion is measured under one market condition.

---

## 5 — SELECTED CONFIRMATORY COHORT AND THE BASIS FOR SELECTION

**2m–60m**, at required n **49,854**.

The rule is the directive's: lowest required n at 80% power, never highest mean
return. It is applied only to cohorts whose required n is identified, plus two
floors — n ≥ 1,000 and ≥ 2 distinct UTC entry days. 2m–60m is the only cohort
that clears all three.

**The restriction was added after seeing that three of four intervals contain
zero, and it is the single choice that changes the answer.** That is recorded as
MT060 and stated here rather than left to be discovered. All three rules and
their answers:

| rule | selects | required n |
|---|---|---|
| directive's rule, restricted to identified estimates | **2m–60m** | 49,854 |
| directive's rule on point estimates alone | 5h–24h | 19,780 |
| sized against a TARGET edge the size of the cost floor | 24h–7d | 89 |

The third is not the directive's rule and did not select. It is reported because
it is the one that makes a window fit the calendar, and because `7.84 × CV²` is
not outcome-blind: the observed mean sits in its denominator, so "lowest required
n" is "highest observed |mean|/SD", and at 5h–24h that ratio is achieved by a
**negative** mean. Sizing a confirmatory window to detect a negative edge at 80%
power is a well-defined experiment and not the one this project wants.

The selection was made on development data and **owes an untouched future test**
per §16 of 4890af0. Recorded as MT059, marked `outcome_data_used: YES`.

---

## 6 — SELECTED CONFIRMATORY NOTIONAL

**0.02 SOL — 20,000,000 lamports — frozen identically for the development and
confirmatory windows.** It is `notional_min_cost` on the directive's grid, and
within 2 bps of the unconstrained minimum at 0.01 SOL.

The bankroll test (§1.5) is not `n × notional`, because positions are not
simultaneous. At 79 mints settling per day and a one-hour hold, concurrent
exposure is 4 positions:

```text
4 × (20,000,000 notional + 2,067,391 rent locked) + 3,883,680 one-time per wallet
= 92,153,244 lamports = 0.0922 SOL
```

The bankroll does not force a smaller size, so **no cost penalty is recorded**.
The retired 11.4-SOL bankroll figure is not cited and is not current.

What makes 0.02 SOL cheap is not that it is small: it is that the rent comes
back. An unrecovered 2,039,280-lamport rent at this notional would be 1,020 bps —
four times the entire measured cost of the round trip — which makes the
same-transaction ATA close the most valuable single mechanic in the cost model.

---

## 7 — BLOCKING-SET TEST RESULTS (§2.1–§2.4)

`tests/unit/blocking-set-d70b4a9a.test.ts` — 47 tests, all passing. Each item
carries its §22 number so one run answers the directive's question.

### §2.2 — cost fabrication

| item | verdict | where |
|---|---|---|
| 16 missing minimum output fails | **PASS** | blocking-set §22.16; also `failclosed.test.ts` |
| 17 missing blockhash/expiry/context fails | **PASS** | blocking-set §22.17 |
| 26 priority fee uses ceiling | **PASS** | blocking-set §22.26; also `accounting.test.ts` §10.1 |
| 27 default CU limit matches official rules | **PASS** | blocking-set §22.27; also `accounting.test.ts` §10.2 |
| 28 two-pass CU rebuild uses frozen margin | **PASS** | blocking-set §22.28; also `prewarm-cu-p6.test.ts` |
| 29 failed-attempt expectation not double-charged | **PASS** | blocking-set §22.29; also `accounting-unified.test.ts` |
| 30 same-transaction ATA close, no extra signature | **PASS** | blocking-set §22.30 |
| 31 rent treatment matches viability and PnL | **PASS** | blocking-set §22.31 |
| 32 transfer fee unknown fails confirmatory | **PASS** | blocking-set §22.32 |
| 43 shadow exit includes all costs | **PASS** | blocking-set §22.43 |
| 48 provider disappearance is not −100% | **PASS** | blocking-set §22.48; also `rejectoutcome.test.ts` |

### §2.3 — silent numeric corruption

| item | verdict | where |
|---|---|---|
| 9 u64 above 2^53 is exact or refused | **PASS** | blocking-set §22.9; also `daemon-contract.test.ts` §22.9 |

### §2.4 — evidence integrity

| item | verdict | where |
|---|---|---|
| 15 exact transaction blob round-trips | **PASS** | blocking-set §22.15; also `directive-5d24e39-p17.test.ts` |
| 21 incomplete account coverage refuses confirmatory | **PASS** | blocking-set §22.21; also `daemon-contract.test.ts` §22.21 |
| 22 ALT-loaded writable post-state is observed | **PASS** | blocking-set §22.22, through the same coverage flag |
| 33 portfolio entry requires immediate same-family sell | **PASS** | `paper-core.test.ts` — refuses an unobservable exit, refuses a cross-family round trip, simulates both legs |
| 34 portfolio mark cannot use `/order` | **PASS** | blocking-set §22.34; also `paper-core.test.ts`, `directive-coverage.test.ts` §22.34 |
| 35 counterfactual gets later same-family fill | **PASS** | blocking-set §2.1 block — bounded, refuses above the frozen cap, haircut can only worsen the exit |
| 36 accepted signal opens both shadow books | **IMPLEMENTED, NOT INDEPENDENTLY ASSERTED** | see below |
| 37 refused signal opens both shadow books | **IMPLEMENTED, NOT INDEPENDENTLY ASSERTED** | see below |
| 53 zero simulator observations cannot be valid PnL | **PASS** | blocking-set §22.53; also `directive-coverage.test.ts` §22.53 |

**Items 36 and 37, stated plainly.** `openShadowBooks` is called unconditionally
at `apps/engine/src/paper.ts:914`, with `'accepted_by_portfolio'` or the
portfolio's refusal reason as its cause — which is the required behaviour, and
the comment there records that this once ran only in the refusal branch and
reintroduced the censoring it was written to remove. It is **not** executed by any
test, because the function is private to a module that calls `main()` at import
time and cannot be imported. The adjacent facts are tested — the schema refuses a
duplicate `(book, signal_episode_id)` pair in `shadow-completeness.test.ts`, and
`claimSignalEpisode` is per-book in `episode.test.ts` — but neither proves the
call is unconditional. Making it provable means moving the function into
`paper-core.ts`, which is engine surgery this directive does not authorise and
which nothing is currently waiting on, since §3.1 refuses the window. **It is the
first thing to do before any window opens.**

### §2.1 — lookahead and family coherence

The PDF carries the heading and no item list. Rather than invent numbers, the
final block of the blocking-set file asserts the property the heading names, and
says so:

- the counterfactual is bounded, refuses one basis point above the frozen
  10 bps impact cap rather than haircutting harder, and its haircut can only make
  the exit worse;
- one family per round trip: the family contracts genuinely differ in what they
  may claim, so mixing them is not cosmetic;
- the mark schedule is seven frozen offsets, so a horizon cannot be chosen once
  the price is known.

`pnpm check` green: **134 files, 2,041 tests, 4 skipped** (from 129 / 1,957).

---

## 8 — EVERY 4890af0 SECTION DEFERRED, WITH ITS REASON

Deferred **to pre-canary, not removed from the project**:

| 4890af0 section | §22 items | reason |
|---|---|---|
| §4.1, §4.2 — multi-ALT runtime ordering, differential compiler | 10, 11, 12, 13 | an incorrect encoder makes simulation FAIL LOUDLY rather than silently inflate PnL. Execution correctness, not measurement integrity, and the executor is blocked. The directive's own words. |
| §3.2, §3.3 — in-flight idempotency, queue semantics | 5, 6, 7, 8 | with `MAX_ACTIVE_SURFNETS = 1` and serialized FIFO, throughput is not the bottleneck. §9 below proves it: the simulator could carry 8,174 positions a day against an arrival rate of 79. |
| §5, §6, §7, §8 — exact transaction persistence, fail-closed build fields, prospective state, account coverage | — | named in the same §2.5 line as the daemon work. Note that the blocking set separately requires and gets items 15, 16, 17, 21 and 22 out of these sections, so what is deferred is the remainder. |
| §13, §14, §15, §17 — Pump/PumpSwap alpha, WSS risk triggers, entity and fraud features, reject tracking | 45, 46, 47, 49 | **INFERRED.** The PDF lost this deferral's section numbers; its rationale survived — "these are alpha and risk improvements … freeze the current deterministic score as baseline per §15 and do not tune" — and these are the sections that change what the strategy IS. Changing the strategy before measuring the current one restarts the clock and spends multiple-testing budget. |
| everything else in §22 outside the blocking set | 1–4, 14, 18–20, 23–25, 38–42, 44, 50–52, 54 | §2 says "implement only these before collection starts". Several already pass (50, 51, 53, 54 carry §22 labels today); the rest remain required before canary. |

**Promoted, not deferred:** §10.1–§10.6, the cost model. That is the only section
of 4890af0 the directive promotes, and §2 above is its output.

---

## 9 — THROUGHPUT BUDGET AND PROJECTED CALENDAR DAYS

`pnpm throughput:budget` → `artifacts/throughput-budget.json`

Every rate measured from the corpus. **The sampling unit is the MINT**: 704
trajectories cover 174 distinct mints, 4.05 rows each, because one mint carries
several treatments and entry clocks. The required n from §4 is in mints, so
counting rows would have turned 632 days into 156 and the gate would have passed
on a unit error.

```text
marks
  scheduled offsets           60s 180s 300s 600s 900s 1800s 3600s  (7 per position,
                              all 7 inside the first hour)
  realised per position       5.58
  SLA 10,000 ms               2,033 on time, 363 MISSED_HORIZON — 84.8% on time over
                              2,396 judged; 1,460 marks predate the verdict
  marks/hour within the SLA   5.94

jupiter
  router calls per mint       3.07 in the collector era; the legs are DIRECT_VENUE,
                              built from stored pool bytes, so the router is not on
                              the critical path
  rate available              0.8 req/s with a key = 69,120 calls/day
  calls/day required          243   (19,942 if marks went back through the router)

simulator
  median simulation           1,894 ms over the 258 jobs with measurable elapsed time
                              (417 more completed inside the same millisecond, which is
                              an idempotent attach and not a run, counted separately)
  Surfnet startup             NOT MEASURED — these jobs ran in the offline LiteSVM
                              worker, and an unmeasured quantity is not a zero
  simulations/day achievable  45,617 at MAX_ACTIVE_SURFNETS = 1
  simulations/day required    441

arrivals, in MINTS per day
  confirmed migrations        median 25, best 109, worst 6, over 8 days
  distinct mints opened       median 52.5, best 138, over 4 days
  distinct mints settled      median 79, best 138, over 3 days      <- the rate used
```

**Bottleneck: eligible signal arrival, at 79 positions a day.** The Jupiter budget
could carry 22,511 and the simulator 8,174. The directive's expectation is
confirmed, and its instruction not to optimise the simulator stands.

Projected calendar days to `required_n`, at the median rate, with §19's amended
floor of 300 applied:

| cohort | required n | days @ median | days @ best day | required n @ cost-floor target | days @ target |
|---|---|---|---|---|---|
| **2m–60m (selected)** | **49,854** | **632** | 362 | 64,025 | 811 |
| 5h–24h | 19,780 | 251 | 144 | 4,074 | 52 |
| 1h–5h | 127,151 | 1,610 | 922 | 1,649 | 21 |
| 24h–7d | 3,441 | 44 | 25 | 300 | 4 |

**VERDICT: `REFUSED_CANNOT_FINISH`.** 632 days exceeds the 120-day limit, so §3.1
forbids beginning the window and none was begun. The projection uses the median
day, not the best; the best-day figure is reported and is not what the gate is
decided on. Note that 24h–7d would fit the calendar and is not selectable, for
the corpus reason in §4.

---

## 10 — MULTIPLE-TESTING LEDGER DIFF

Eight rows, `MT057`–`MT064`, in `docs/MULTIPLE_TESTING_LEDGER.csv`. Every
notional and cohort examined in Phase A is in them, whatever the outcome.

| id | family | what it records | spends alpha |
|---|---|---|---|
| MT057 | cost_model | all nine notionals examined — the seven on the grid and the two below it — and the two directive premises the measurement contradicts | no |
| MT058 | study_design | the frozen entry and exit rules, the mint as sampling unit, and both denominations | no |
| MT059 | study_design | the four cohort CVs and required n, the selection of 2m–60m, and all three rules that could have selected | **YES** |
| MT060 | study_design | the identification restriction, added after seeing three of four intervals contain zero, and the fact that it is what moved the selection off 5h–24h | **YES** (stated) |
| MT061 | sizing | notional frozen at 0.02 SOL for both windows, with the concurrency and bankroll arithmetic | no |
| MT062 | gate_calibration | Correction 2 — the tail-removal criteria demoted to diagnostics, disclosure made a gate. **A weakening of §19 as literally written, recorded as one, before collecting.** | **YES** |
| MT063 | gate_calibration | Correction 1 — `max(300, 7.84 × CV_observed²)` replaces "at least 200" | yes (raises a requirement) |
| MT064 | study_design | the §3.1 refusal, the arrival rates behind it, and the unit error it would have taken to pass | no |

---

## 11 — REPOSITORY VISIBILITY ACTION REQUIRED

**Verified, not assumed:** `gh repo view TateLyman/epitaxy` reports
`"visibility": "PUBLIC"`, `"isPrivate": false`. Seven directives, the screening
logic, the cost model, the gate structure and the intended strategy are readable
unauthenticated, and this report adds the measured cost floor and the reconstructed
return distribution to that.

**Recommendation: Option A — make the entire repository private.**

The reasoning is the directive's own inverted: there is currently no edge to
protect, which makes this free to do now, and the split in Option B is not free.
`packages/` and `apps/` are one workspace with relative imports across every
boundary; separating research/core from ops/strategy/runtime means two repositories,
two lockfiles, a published-package or submodule boundary in the middle of the
import graph, and a second CI. That is real work whose only benefit is publishing
code nobody has asked for. If the operator wants a public artifact later, a curated
export of `packages/domain` and `packages/solana` is a smaller and safer thing to
build than a split of the live tree.

**The exact action, for the operator to take or decline:**

```bash
gh repo edit TateLyman/epitaxy --visibility private --accept-visibility-change-consequences
```

Consequences to weigh first: forks become detached, GitHub Pages (if any) stops
serving, and Actions minutes start billing against the private-repo allowance
rather than the free public one. **Nothing was changed. Visibility was read, not
written.**

---

## 12 — FINAL STATE

```text
MEASUREMENT_REPAIR_REQUIRED
```

Not `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS`: four of 36 (cohort × notional)
combinations clear the corrected cost floor, so the kill rule's conjunction does
not hold.

Not `VALID_DEVELOPMENT_SIMULATION_RUNNING`: no window was opened. The blocking
set has one item pair not independently asserted (36/37), the last measured RPC
state is an exhausted daily quota, and starting an unattended 24/7 collection
window is an operator decision about a machine and a budget rather than a code
change.

Not `VALID_CONFIRMATORY_COLLECTION_STARTED`: §3.1 refuses it at 632 projected
days against a 120-day limit.

`CANARY_READY`, `LIVE_READY` and `PROFITABLE` remain forbidden and are not
claimed.

### What the honest next step is

The directive expected `VALID_DEVELOPMENT_SIMULATION_RUNNING` or a kill, and
neither is what the measurement supports. What it supports is a choice, and it is
the operator's:

1. **Accept a target-sized confirmatory test.** Replace "detect the effect this
   development sample happened to show" with "detect an edge as large as the
   measured cost floor". That is `7.84 × (SD / 0.0269)²`, it puts 1h–5h at 21 days
   and 5h–24h at 52, and it is a change to the confirmatory metric that belongs in
   the ledger before it is used.
2. **Extend the corpus so 24h–7d becomes selectable.** It has the lowest
   dispersion of the four by a factor of 27 and needs 89 positions against a
   cost-floor-sized target. What it lacks is calendar: 21 days of collection makes
   its entries span more than one day, and the §19 minimum is 21 days anyway. This
   is the cheapest path to a decidable experiment and it needs no new code.
3. **Accept 632 days on the current rule**, which is not a plan.

Options 1 and 2 compose, and together they are a ~21–28 day experiment on a
cohort whose dispersion the corpus can already measure. The one purchase that
serves either is the one §5 of the directive permits: a cheap always-on box, so
the window runs unattended. Nothing else should be bought — the executor is
blocked, nothing in the critical path is latency-bound, and the bottleneck is a
launch rate no subscription changes.

Before any window opens: assert items 36 and 37.
