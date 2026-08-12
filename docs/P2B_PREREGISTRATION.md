# P2b preregistration

**Committed before any policy ranking was computed.** That is the only property
that makes this document worth anything: everything below was chosen from stated
principles, not from looking at which rule rescues the existing trades.

- Written: 2026-08-12
- Repository: `TateLyman/epitaxy`, branch `master`
- Frozen at: the commit that adds this file
- Mode: paper only. **No capital permission. Canary and live are not enabled.**

---

## Why this exists

P2b is a multiple-testing trap wearing a friendly hat. The corpus contains
thousands of marks and a handful of positions. Every convenient shortcut turns
the former into the sample size:

| shortcut | what it does to the result |
|---|---|
| pool five regimes into one average | describes an experiment nobody ran |
| resample at mark level | ~34 correlated rows per position become 34 draws |
| count a quote-only row | 2255 rows that never proved a trade was possible |
| fill at the trigger quote | a free look at a price that had already moved |
| pick the rule after seeing the outcomes | selects the noise, every time |

Each of those is refused in code, in `packages/research/src/confirmatory.ts`,
and each refusal has a test and a mutation. A rule that lives only in a document
is a rule that gets skipped at 2am.

---

## 8.1 What counts as confirmatory data

A row is admissible only when **every** condition holds. An unknown fails.

1. **Collected after P0–P7 were frozen.** The window opens at the commit that
   adds this file. Everything before it is development data, permanently.
2. **One code SHA.** `run_contexts.source_commit` must be identical across the
   window and must not end in `+dirty`. A working tree that does not match its
   commit cannot be replayed, so rows produced from one are excluded — this is
   enforced by tagging, not by intention.
3. **One `data_regime_id`.** Strategy version, mark cadence bucket,
   buildability regime, risk policy hash and schema version. `requireSingleRegime()`
   throws rather than averaging across two.
4. **Build-valid on BOTH legs.** A `build_attempts` row with
   `build_status = BUILD_SUCCEEDED` and a passing `policy_status` for the buy
   AND for the sell. `bothLegsBuildable === null` is excluded: not asked is not
   proven.
5. **Complete raw quote provenance.** `raw_payload_hash` present on the mark, so
   the row can be re-derived if the parser turns out to be wrong. Every row
   written before migration 7 fails this and always will.
6. **Cadence documented and ≤ 10.5s.** Measured at 10.54–10.56s.
7. **No unresolved gaps.** No mark sequence discontinuity inside a position, and
   no unresolved clock discontinuity spanning it.
8. **Diagnostic does not disqualify.** `PROVIDER_FAILURE`,
   `SCHEMA_OR_PARSER_ERROR`, `STALE_EXIT_QUOTE`, `UNBUILDABLE_EXIT` and
   `UNVERIFIABLE` are excluded — the first three because they describe us rather
   than the market.

**Any change to a decision-bearing file restarts the window.** `strategyConfigHash`
covers gates, exits, cost assumptions, cadence and the buildability flag;
`riskPolicyHash` covers the risk block. If either changes, the rows collected
before the change are development data for the new arm.

### Status at the time of writing

| quantity | value |
|---|---|
| admissible closed trades | **0** |
| historical closed positions (development data) | 20 |
| historical marks, all inadmissible | 603 |
| quotes carrying a transaction | 0 of 2419 |
| build attempts under the frozen code | 0 |

Zero. The window is open and empty, and it is supposed to be.

---

## 8.2 The frozen policy set

Four policies, mechanism-distinct, every threshold fixed here. Each one is a row
in `docs/MULTIPLE_TESTING_LEDGER.csv`.

Thresholds were chosen from the principles stated beside them, before any
confirmatory data existed. Where a number is inherited from the current
production config it is marked as such, and where it is new it is derived from a
cost argument rather than from a fit.

### Policy A — current production paper policy (the control)

Verbatim from `config/paper.json`. Not a candidate; the benchmark the others
must beat.

```
stopLossBps                 2500
trailingStopBps             3000
takeProfitBps               6000
maxHoldMs                1800000
minHoldMs                  60000
liquidityCollapseRatioBps   1000
```

### Policy B — corrected adverse impact

Policy A, plus an exit when **non-negative adverse impact** exceeds a cap. The
mechanism being tested is that exit cost, measured in the direction that can
actually hurt, predicts further deterioration.

```
everything in Policy A, plus:
adverseImpactExitBps        500     exit when adverseBps > 500
```

`500` is 5% of notional consumed by impact alone. It is one order of magnitude
above the 45–169bps round-trip loss measured across the size surface, so it
fires on a regime change rather than on ordinary cost. It is **not** the 911bps
or 9900bps figure from the old `Math.abs` label — those numbers were artefacts
of the defect and are deliberately not used to set this threshold.

Adverse impact is read from `position_marks.adverse_impact_bps`, which is
`max(0, -signedBps)`. Where `impact_schema_status != 'OK'` the rule **does not
fire**: an unknown impact never satisfies a cap.

### Policy C — executable-value-collapse emergency rule

Policy A, plus an immediate exit on a single-interval fall in executable value,
regardless of minimum hold.

```
everything in Policy A, plus:
collapseDropBps            5000     exit when executable value falls >50% since the previous mark
collapseFloorBps           2000     exit when executable value is below 20% of all-in cost
```

Mechanism: P7 found that all eight measured collapses fell from above the 10%
floor to near zero **inside a single mark interval**. Policy A's floor is 1000bps
and is therefore only reached after the fall has already happened. Policy C tests
whether a rate-of-change trigger fires early enough to matter at a 10.5s cadence.

`5000` and `2000` are chosen as the round numbers either side of Policy A's
existing 1000bps floor — deliberately coarse, because a fine threshold fitted to
eight observations is a fit to eight observations.

### Policy D — simple time and trailing policy

Chosen without inspecting confirmatory outcomes, and deliberately the dullest
thing that could work: get out early, and give back less.

```
stopLossBps                 2500    (unchanged)
trailingStopBps             1500    tighter: half of Policy A
takeProfitBps               3000    half of Policy A
maxHoldMs                 300000    5 minutes, not 30
minHoldMs                  60000    (unchanged)
liquidityCollapseRatioBps   1000    (unchanged)
```

Mechanism: the memecoin holding-period argument. If edge decays inside minutes,
a policy that halves the hold and halves both the profit target and the trailing
distance should dominate; if it does not, the "get out early" thesis is wrong and
that is worth knowing.

### Tie-breaks, frozen

1. Higher expected log growth wins.
2. If within 5% of each other, fewer `EXIT_BLOCKED` outcomes wins.
3. If still tied, the **simpler** policy wins, ordered A < D < B < C.
4. No policy may be selected at all unless it beats Policy A on both expected log
   growth and CVaR 5%.

---

## 8.3 Counterfactual execution rules

Implemented in `replayPolicy()`. Each rule is here because the natural
implementation gets it wrong in the flattering direction.

- **Only marks known at that time.** The trigger function receives the mark and
  its index, never the array. It cannot look forward because it is not given the
  future.
- **Trigger at the FIRST qualifying mark**, not the best one.
- **Apply latency before filling.** Frozen at **2000 ms**: measured sell-quote
  latency is 192 ms mean and 994 ms maximum over 1511 quotes; a build call is
  added on top and is not yet measured under the frozen code, so the figure is
  rounded up rather than estimated down. It will be revised only by a versioned
  change with a ledger row.
- **Fill at the first LATER build-valid quote.** Never the trigger quote —
  `TriggerQuoteReused` throws.
- **No build-valid exit afterwards → `EXIT_BLOCKED`.** Not the last price we
  happened to see.
- **All costs charged**: platform fee at the rate the response actually
  reported, priority fee, signature fee, ATA rent under the recovery scenario
  being reported, failed attempts, and quote expiry.
- **Never forward-fill through a missing mark.**
- **The unit of resampling is position/mint and UTC day, never mark.**
  `requireBlockUnit('mark')` throws.

---

## 8.4 Required output, per policy and per size

Sizes: 0.005, 0.010, 0.020, 0.030, 0.050, 0.075, 0.100 SOL — the P6 surface.

Completed trades · censored/unverifiable · route/build failures · net SOL · net
return · median · win rate · payoff ratio · profit factor · expected log growth ·
maximum drawdown · CVaR 5% · collapse incidence · time under water ·
top-1/3/5/10 deletion · top mint and top day contribution · mint-block and
day-block intervals · results split by API and market regime · comparison against
no trade, SOL hold, Policy A, and random contemporaneous eligible tokens.

Every figure is reported at **four ATA-rent recovery assumptions**: 100%,
observed, 50%, 0%. Observed is currently 0% and says why
(`withheld_transfer_fee_lamports` is unobserved). **If profitability requires
perfect rent recovery, that is a headline deployment blocker, not a footnote.**

### Sample-size gates, enforced in code

| gate | threshold | function |
|---|---|---|
| may rank policies at all | 50 valid trades | `mayRankPolicies()` |
| may call it deployment evidence | 200 trades AND 21 days | `mayCallDeploymentEvidence()` |

A policy chosen on development data gets **one** untouched forward test.

PBO and deflated-performance diagnostics are reported once the sample supports
them, and their absence is reported as absence rather than omitted.

---

## What this document does not do

It does not predict that any policy will work. Three of the four are candidate
mechanisms and the fourth is a control. The most likely outcome, given that the
size surface shows 714bps of non-recoverable fixed cost at the canary cap and
1019bps of ATA rent burden that P5 shows is currently unrecoverable, is that
**no policy clears its own overhead at deployable size**. That result would be
worth having, and it is the reason the thresholds were frozen before anyone
looked.
