# STRATEGY SPEC

What this system decides to buy, what it refuses, and how much of that is
actually known to work.

Strategy version `delayed-momentum-v0.2.0`. Every threshold below is quoted from
`config/*.json` or from the source file named beside it. Nothing here is an
intention; if a number is in this document it is in the code.

## 1. The thesis, and the edge being claimed

The system deliberately concedes the first-block race. It will not look at a
token younger than 2 minutes and will not look at one older than 60 minutes
(`gates.minTokenAgeMs` / `gates.maxTokenAgeMs`). Inside that window it looks for
a token that has already survived its opening minutes, is still cheap to trade
in *and back out* at the same instant, and shows breadth of participation —
distinct net buyers rather than transaction count, which is the cheapest thing
on chain to fake. It sizes from the stop distance, exits on rules with no
discretion, and refuses any trade whose fixed costs would eat more than 5% of
its own notional.

The honest statement of edge: **there is no articulated, tested source of
alpha.** `packages/strategy/src/score.ts` calls the thesis "delayed momentum",
and the one supporting fact is measured rather than assumed — round-trip cost
roughly halves between a seconds-old token (298 bps) and a 52-minute-old one
(134–255 bps), per `docs/STATUS.md`. That is an argument about *cost*, not about
*return*. No measurement here shows that tokens passing these gates outperform
tokens failing them; the `reject_tracking` panel exists to answer exactly that
question and has not been used to. Until it is, this is a well-instrumented cost
model with a plausible-sounding filter attached.

## 2. The candidate funnel

Order matters: each stage exists to avoid spending the next stage's budget. The
keyless Jupiter allowance is ~30 requests/minute shared across all endpoints, so
a round-trip quote (2 requests) is the scarcest resource in the system.

| # | Stage | Rule | Configured in | Code |
| --- | --- | --- | --- | --- |
| 1 | Discovery | `/tokens/v2/recent` every cycle; one ranked feed per cycle, alternating `toptrending` / `toporganicscore` (50 each) | `discoveryIntervalMs` 30000 | `packages/pipeline/src/cycle.ts` |
| 2 | Maturation queue | Banked mints re-fetched once age ∈ [2min, 60min], 100 per `search` request, ordered least-recently-screened first | `gates.minTokenAgeMs`, `gates.maxTokenAgeMs` | `maturingMints`, `cycle.ts` |
| 3 | Cheap screen | All gates computable without a quote. Rejects here are final for the cycle | `config.gates` | `evaluateCheapGates` |
| 4 | Quote ranking | Survivors sorted by liquidity descending; top `maxQuotesPerCycle` only | `maxQuotesPerCycle` (paper 2, observe 4, canary 1, live 2) | `cycle.ts` |
| 5 | Round trip | Buy `quoteProbeLamports` of the token, then sell exactly what that buy would produce | `quoteProbeLamports` 0.05 SOL (canary 0.02) | `measureRoundTrip` |
| 6 | Quote gates | Route existence, price impact, round-trip cost | `config.gates` | `evaluateQuoteGates` |
| 7 | Concentration | On-chain top-10 wallet share, pool inventory excluded structurally | `gates.maxTopHolderPct` | `evaluateConcentrationGate`, `fetchConcentration` |
| 8 | Score threshold | `eligible = passedHardGates && score >= minOpportunityScore` | `minOpportunityScore` (paper/observe 0.35, canary 0.5, live 0.45) | `finalizeScreen` |
| 9 | Entry | Quote freshness, then portfolio sizing | `maxQuoteAgeMs` 8000 (canary/live 6000) | `apps/engine/src/paper.ts` |

Stage 4 is a heuristic and is labelled as one in the source: the true ranking
would require the quote we are trying to avoid spending. A candidate promoted
but not quoted this cycle is left undecided, not recorded as a rejection. Stages
6 and 7 run only when the cheap layer passed, so the absence of a quote we never
requested is not recorded as a quote failure — that would corrupt the rejection
tally the calibration work depends on.

## 3. Hard vetoes versus soft risk

`packages/intelligence/src/gates.ts` keeps these as two separate mechanisms and
never collapses them into one "rug score", because a single number destroys the
ability to measure which specific filter earned its keep.

- A **hard veto** contributes `riskContribution: 1` when it fails and puts its
  reason code in `hardVetoes`. Any non-empty `hardVetoes` sets
  `passedHardGates = false`. There is no override.
- A **soft risk** contributes a clamped 0..1 value. `summarize()` takes the
  **mean** of soft contributions — not the sum — so adding a new soft feature
  does not silently inflate every token's risk. Soft risk never blocks; it
  multiplies the score by `(1 - softRisk)` and therefore shrinks position size.

### Hard vetoes (cheap layer)

| Reason code | Condition | Threshold |
| --- | --- | --- |
| `stale_source` | source age > `maxSourceAgeMs` | 60,000 ms (canary/live 45,000) |
| `unknown_token_program` | program not in `allowedTokenPrograms` | SPL Token, Token-2022 |
| `mint_authority_live` | `audit.mintAuthorityDisabled !== true` | required |
| `freeze_authority_live` | `audit.freezeAuthorityDisabled !== true` | required |
| `too_young` | age < `minTokenAgeMs`, **or age unknown** | 120,000 ms |
| `too_old` | age > `maxTokenAgeMs`, **or age unknown** | 3,600,000 ms |
| `insufficient_liquidity` | liquidity < `minLiquidityUsd`, **or null** | $8,000 (canary/live $15,000) |
| `too_few_holders` | holders < `minHolderCount`, **or null** | 60 (canary/live 100) |
| `dev_holds_too_much` | `devBalancePercentage > maxDevBalancePct`, **only when present** | 5% (canary/live 3%) |
| `insufficient_flow` | 5m buys < `minBuyCount5m` | 15 (canary/live 20) |
| `insufficient_net_buyers` | 5m net buyers < `minNetBuyers5m`; falls back to buy count when net buyers is null | 8 (canary/live 12) |
| `low_organic_score` | `organicScore < minOrganicScore`, **only when a score exists** | 20 (canary/live 30) |
| `provider_flagged_suspicious` | `audit.isSus === true` | — |

### Hard vetoes (quote layer)

| Reason code | Condition | Threshold |
| --- | --- | --- |
| `no_quote` | promoted but no round trip obtained | — |
| `no_buy_route` | buy `outAmount == 0` | — |
| `no_exit_route` | no sell route for the acquired amount | — |
| `excessive_impact` | buy impact > `maxPriceImpactBps` | 150 bps (canary/live 100) |
| `round_trip_too_expensive` | round-trip loss > `maxRoundTripLossBps`, or unknown | 400 bps (canary/live 300) |
| `concentrated_ownership` | on-chain top-10 wallet share > `maxTopHolderPct` | 25% (canary/live 20%) |
| `concentration_unknown` | measurement unavailable **and** `mode ∈ {canary, live}` | — |

### Soft risks

| Gate | Contribution | Trigger |
| --- | --- | --- |
| `dev_balance_unavailable` | 0.20 | `devBalancePercentage` is null |
| `organic_score_unavailable` | 0.25 | `organicScore` null or 0 |
| `top_holders_unavailable` | 0.15 | provider top-holder share null |
| `provider_top_holders` | 0.30 / 0 | present and above `maxTopHolderPct` |
| `holder_concentration_unavailable` | 0.30 | on-chain measurement failed, observe/paper only |
| `single_wallet_dominance` | `normalize(topWalletPct, maxTop/2, maxTop)` | largest wallet share |
| `wash_tx_per_trader` | `normalize(tx/traders, 3, 12)` | 5m transactions per distinct trader |
| `no_sells_observed` | 0.80 | buy volume > 0, sell volume = 0, > 10 buys |
| `volume_to_liquidity` | `normalize(vol/liq, 2, 10)` | 5m churn relative to depth |
| `price_exhaustion` | `normalize(priceChange5m, 40, 200)` | vertical move |
| `liquidity_diverging` | 0.70 | 5m price > +20% while liquidity fell |
| `price_without_holders` | 0.75 | 5m price > +30% while holders did not grow |
| `round_trip_drag` | `normalize(rtBps, 150, 400)` | measured round-trip cost |

### Null providers — the rule this system had to learn twice

**Absence of a provider field is a fact about the provider, not about the
token.** Present-and-bad is a hard veto; absent is graded soft risk. That rule
is applied uniformly to `organicScore`, `devBalancePercentage` and
`topHoldersPercentage`, and it exists because the opposite behaviour silently
rejected 100% of the population the strategy is defined over — `organicScore` is
0 for every token under ~1h old (n=461, zero exceptions), `devBalancePercentage`
was null for 81% of tokens and `topHoldersPercentage` for 21% (n=3,561). See
findings #2 and #5 in `docs/STATUS.md`.

The rule is **not** universal, and the exceptions are deliberate:

- **Age, liquidity, holder count**: null fails the veto — `ageMs !== null && ...`
  and `liq !== null && ...` are explicit in the source. A token whose age or
  depth cannot be established cannot be sized against, so unknown disqualifies.
- **Net buyers**: null falls back to the raw buy count against the same
  threshold, rather than failing or being graded.
- **On-chain concentration**: mode-dependent. Unavailable is soft risk 0.30 in
  observe/paper and a hard veto in canary/live (`capitalAtRisk` in
  `finalizeScreen`). Observing an unknown costs nothing; buying into one costs
  everything committed. `getTokenLargestAccounts` returns HTTP 429 on the public
  RPC even on a first isolated call, so **a keyed RPC is a hard prerequisite for
  any mode that commits capital.**

## 4. The opportunity score

`packages/strategy/src/score.ts`. Five bounded components, a fixed weighted sum,
then a risk multiplier. `normalize(v, lo, hi)` maps into 0..1 clipped at both
ends.

| Component | Weight | Formula |
| --- | --- | --- |
| `breadth` | 0.30 | `0.6 × normalize(netBuyers5m, 0, 60) + 0.4 × normalize(traders5m, 0, 150)` |
| `liquidity` | 0.20 | `normalize(log10(max(liq,1)), log10(5_000), log10(150_000))` |
| `organic` | 0.20 | `normalize(organicScore, 0, 80)` |
| `tradability` | 0.20 | `1 - normalize(roundTripLossBps, 100, 600)`; **0 when no round trip exists** |
| `freshness` | 0.10 | `ageMin ≤ 10 ? normalize(ageMin, 2, 10) : 1 - normalize(ageMin, 10, 60)` |

```
raw   = 0.30·breadth + 0.20·liquidity + 0.20·organic + 0.20·tradability + 0.10·freshness
score = raw × (1 - clamp(softRisk, 0, 1))
```

Every component is stored in `scoreComponents` alongside `raw` and `softRisk`,
so observe mode can later measure which component predicted anything. None has
yet been measured against an outcome.

Two structural facts about this score, both load-bearing:

1. **The `organic` term is dead across the entire eligible window.** The age
   window tops out at 60 minutes and `organicScore` is 0 for every token under
   ~1 hour old. So 20% of the weight contributes 0 to essentially every
   candidate, the achievable ceiling on `raw` is 0.80, and the same missing field
   simultaneously adds 0.25 to soft risk. The highest score observed on any
   eligible candidate to date is 0.62.
2. **The weights were chosen, not fitted.** There is no derivation, no
   optimisation, and no out-of-sample check behind 30/20/20/20/10.

## 5. Position sizing

`packages/strategy/src/portfolio.ts`. Sizing is derived from the loss we plan
for, not the gain we hope for: the stop distance is known before entry, so the
notional putting exactly `riskBudgetPctPerTrade` of NAV at risk is arithmetic.

### The refusal order — this order is the specification

`sizePosition` runs these in exactly this sequence and returns at the first
failure. The order determines which refusal reason is reported, and reasons
drive calibration, so reordering them would change what the operator believes is
binding.

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | `openPositions >= risk.maxSimultaneousPositions` | `position_slots_full` |
| 2 | `-realizedTodayLamports >= risk.dailyLossCapLamports` (and cap > 0) | `daily_loss_cap` |
| 3 | `opportunityScore < config.minOpportunityScore` | `score_below_threshold` |
| 4 | Compute `size = min(scaled, notionalCap, risk.maxEntryLamports)` | — (cap, not refusal) |
| 5 | `exposureHeadroom <= 0`, then `size = min(size, headroom)` | `exposure_cap` |
| 6 | `spendable = free - minSolReserve <= 0`, then `size = min(size, spendable)` | `reserve_floor` |
| 7 | `size < viableFloorLamports(config)` | `size_below_viable` |

Consequences of that order, stated because they are choices:

- The daily loss cap is checked **before** sizing, so a bad day cannot be traded
  back.
- The score threshold is checked **after** the portfolio caps, so a full book
  reports `position_slots_full` rather than blaming the signal.
- The viability floor is checked **last**, after every cap has been applied, so
  it is judged on the size we would actually send — not on the size we wanted.

Step 4 in full:

```
budget      = nav × riskBudgetPctPerTrade / 100
riskSized   = budget × 10_000 / exits.stopLossBps        (= budget if stop is 0)
notionalCap = nav × maxNotionalPctPerPosition / 100
scaled      = riskSized × clamp(score, 0, 1)             (millis precision)
size        = min(scaled, notionalCap, maxEntryLamports)
```

Score scales size *within* the allowed band, never beyond it.

### Round-trip cost and the viability floor

```
roundTripCostLamports = 2 × (assumedSignatureFeeLamports + assumedPriorityFeeLamports)
                      + assumedAtaRentLamports × (1 - assumedRentRecoveryRate)

viableFloorLamports   = roundTripCostLamports × 10_000 / maxFeeFractionBps
```

With paper/observe/live values (5,000 + 200,000 lamports per transaction,
2,039,280 lamports ATA rent, `assumedRentRecoveryRate` 0.5,
`maxFeeFractionBps` 500):

| Quantity | Value |
| --- | --- |
| Non-recoverable round-trip cost | 1,429,640 lamports (0.00143 SOL) |
| Viability floor (5% of notional) | 28,592,800 lamports (0.0286 SOL) |
| Canary floor (`maxFeeFractionBps` 1500) | 9,530,933 lamports (0.0095 SOL) |

ATA rent is deliberately not charged in full. Rent is returned when the token
account is closed, so on a successful exit it is a temporary lockup rather than
a cost. It is only truly lost when the position cannot be sold at all, because
an account holding a nonzero balance cannot be closed. `assumedRentRecoveryRate`
makes that an explicit, measurable assumption instead of an implicit 0.

**What the floor protects against:** a trade too small to clear its own
overhead. Fixed costs do not scale with position size, so below the floor the
thesis is irrelevant — the token must appreciate by more than 5% before the
position is flat. This is also a hard statement about minimum capital. At the
paper risk settings the largest position ever authorised is
`nav × 0.25/100 × 10_000/2500 = nav/100`, so clearing a 0.0286 SOL floor needs
~2.9 SOL of NAV at a perfect score and ~5.7 SOL at a typical one. A 2 SOL
account is refused at *every* score, which is how paper mode spent hours opening
nothing and looking selective (finding #7). `pnpm doctor` now fails
`config.viableCapital` when the largest permitted position sits below the floor.

## 6. Exit rules

`packages/strategy/src/exits.ts`, driven each cycle by
`manageOpenPositions` in `apps/engine/src/paper.ts`. Exits run **first**, before
any entry may compete for the quote budget: getting out is always more urgent
than getting in.

The mark is `sell.otherAmountThreshold - assumedPriorityFeeLamports` — the
router's guaranteed worst-case output at the requested slippage, never the
optimistic `outAmount`. The peak is a peak *mark*, not a peak price, so the
trailing stop accounts for exit liquidity actually available at the peak.

Evaluation order, first match wins:

| # | Reason | Condition | Threshold (all modes) |
| --- | --- | --- | --- |
| 1 | `exit_route_lost` | no sell route at mark time | — |
| 2 | `exit_cost_exploded` | exit impact > `maxExitImpactBps` | 500 bps (canary/live 400) |
| — | *no decision* | mark is null (provider gave no quote) | — |
| — | *no decision* | held < `minHoldMs` | 60,000 ms |
| 3 | `stop_loss` | loss from cost ≥ `stopLossBps` | 2,500 bps |
| 4 | `take_profit` | gain over cost ≥ `takeProfitBps` | 6,000 bps |
| 5 | `trailing_stop` | give-back from peak mark ≥ `trailingStopBps`, and peak > cost | 3,000 bps |
| 6 | `max_hold` | held ≥ `maxHoldMs` | 1,800,000 ms |

Rules 1 and 2 are checked **before** the minimum hold. The minimum hold is a
churn-control device — so a single noisy mark cannot round-trip us through two
sets of fees — and it must never trap the system in an asset it cannot sell. A
provider outage is not a signal about the position: `manageOpenPositions` records
source health and holds, rather than treating an unreachable API as a vanished
route.

### EXIT_BLOCKED

When an exit rule fires but there is no sell quote to execute against, the
position is written to the terminal state `EXIT_BLOCKED` and a `critical` health
event is recorded. It exists because "wanted out, cannot get out" is a real
outcome in this population and must be recorded as such rather than quietly
retried forever. A position stuck in an infinite retry loop reads as an open
position, and an open position reads as a decision we are still making.

Two honest consequences, both currently unhandled. `EXIT_BLOCKED` is not in
`TERMINAL_STATES` (`packages/domain/src/types.ts`, which lists only
`POSITION_CLOSED`, `FAILED`, `EXPIRED`); and `openPositions()` selects only
`POSITION_OPEN` and `EXIT_INTENT`, so a blocked position leaves the marked set,
stops being re-quoted, and its cost is never returned to `ledger.freeLamports`
nor booked as a realized loss. Paper NAV would therefore *overstate* the account
after a blocked exit. No position has reached this state, so it has not bitten.

## 7. Costs

The cost model matters more than the entry signal, and the reason is arithmetic.
A measured round trip in this population costs 134–298 bps before priority fees,
ATA rent or failed transactions (`docs/STATUS.md`), and the gates admit anything
up to 400 bps. A signal right 55% of the time is worth nothing against a 3%
entry-and-exit toll; an accurate cost model refuses the trade regardless of how
good the signal looks. Every component below is modelled conservatively in the
expensive direction.

| Cost | Modelled as | Value | Note |
| --- | --- | --- | --- |
| Router/platform fee | `max(assumedNewTokenFeeBps, quote.platformFeeBps)` | 50 bps floor | Jupiter documents 50 bps under 24h; every live quote measured returned 10 bps. Unresolved. Config models 50 anyway — being wrong in the expensive direction is survivable. |
| Slippage | Router's `otherAmountThreshold` at `maxSlippageBps` | 300 bps (canary/live 200) | The guaranteed worst case, never `outAmount`. |
| Price impact | Vetoed above `maxPriceImpactBps` on entry, `maxExitImpactBps` on exit | 150 / 500 bps | Measured from the quote, both directions. |
| Priority fee | `assumedPriorityFeeLamports`, charged on entry and on exit | 200,000 lamports | Capped by `risk.maxPriorityFeeLamports` = 1,000,000. |
| Signature fee | `assumedSignatureFeeLamports` × 2 | 5,000 lamports each | In the sizing model only. |
| ATA rent | `assumedAtaRentLamports × (1 - assumedRentRecoveryRate)` | 2,039,280 × 0.5 | Recovery rate is an assumption to be measured, not a constant. |

Round-trip cost is measured, not modelled, wherever possible: `measureRoundTrip`
quotes SOL → token at the probe notional and then quotes the resulting token
amount straight back to SOL, and `roundTripLossBps = lossBps(lamportsIn,
sell.outAmount)`. That is a real quoted in-and-out at one instant, not an
estimate.

Two known inconsistencies in the paper ledger, stated rather than smoothed over:

- Entry charges the **full** ATA rent (2,039,280) as sunk cost and the exit
  credits none of it back, i.e. the ledger runs at an implied recovery rate of
  0, while the sizing floor assumes 0.5. Paper P&L is therefore pessimistic and
  sizing is permissive relative to it.
- The paper ledger charges priority fee on both legs but never the per-signature
  fee, which the sizing model does charge.

Paper entry additionally caps the filled notional at `quoteProbeLamports` and
scales the quote's worst-case output linearly, because linear extrapolation
understates impact at larger size. Capping keeps the extrapolation honest at the
cost of never testing a size larger than the probe.

## 8. How the strategy is evaluated

**Replay** (`packages/research/src/replay-cli.ts`) re-decides stored snapshots
and compares against what was recorded. The claim under test is that a decision
is a pure function of its captured inputs — if replay disagrees, either the
snapshot does not capture everything the decision depended on, or the strategy
changed. Rows at a different `strategy_version` are counted separately rather
than compared, and concentration is passed as `null` because it was never
captured in the snapshot; replay must not invent an input. A mismatch exits
nonzero. So does an empty corpus: verifying nothing is not success. Last run:
3,000 examined, 2,200 replayed, 0 divergent.

**Backtest** (`packages/research/src/backtest-cli.ts`) is explicitly *not* a
strategy equity curve, and refuses to print one. It measures gate
counterfactuals: for each hard veto, what the tokens it removed went on to do,
at 15m / 1h / 4h / 24h horizons anchored on each mint's first rejection. A mint
the provider stopped quoting is counted as −100% rather than dropped, because
dropping it would leave a panel made entirely of survivors.

Guards against overfitting that exist in code:

| Guard | Mechanism |
| --- | --- |
| One screening path | Observe, paper and replay all call `finalizeScreen`; a decision cannot differ between modes |
| Version pinning | Decisions are stamped `strategyVersion`; replay refuses cross-version comparison |
| Frozen inputs | `DecisionSnapshot.features` is the only thing replay may read |
| No equity curve | Backtest prints the reason it will not produce one |
| Sample-size honesty | `pnpm report` prints a Wilson 95% interval on win rate and a warning below 30 closed positions |
| Trial ledger | `trials` table, surfaced in the report's "multiple testing" section |

**The multiple-testing problem is real and currently unguarded in practice.**
The `trials` table exists and is reported, but it currently holds **0 rows**
while the strategy has already been revised through v0.1.0 → v0.2.0 and several
thresholds have been changed in response to looking at this same data. Those
were changes to fix filters that rejected 100% of the target population, which
is a defect fix rather than a fit — but nothing in the tooling distinguishes the
two, and nothing forces a trial to be recorded. Every parameter set evaluated
against this dataset is a trial; with enough of them, some configuration will
look profitable by chance. The ledger only helps if it is written to.

The open calibration question is also a selection effect. `insufficient_liquidity`
is the sole binding constraint on 257 of the 307 single-veto rejections measured
below, and the $8,000 floor is 400× the maximum position — but **nothing below
that floor has ever been quoted**, so "small pools are unexecutable" is
unsupported by any measurement. It will be resolved by measuring round-trip cost
on a stratified sample of sub-threshold tokens, not by lowering the threshold
until trades appear.

## 9. Simulated paper results

Measured from `data/runtime.db` on 2026-08-12, covering the window
2026-08-11T21:49Z – 2026-08-12T00:21Z (2.5h) at strategy `v0.2.0`.

**These are simulated paper results. No real money has ever been traded by this
system. No key exists and no transaction has ever been signed or sent.**

| Measurement | Value |
| --- | --- |
| Screenings | 26,350 |
| Eligible | 50 (0.19%, ~19.8/hour) |
| Round-trip quotes recorded | 269 (0 signable) |
| Paper positions opened | 6, all closed, all simulated |
| Deployed cost basis | 0.29495 SOL |
| Realized | **−0.13928 SOL, −47.2% on cost** |
| Wins | 1 of 6 (95% Wilson interval 3.0% – 56.4%) |
| Median hold | 546 s |
| Exits by reason | `exit_cost_exploded` 5, `stop_loss` 1 |
| `EXIT_BLOCKED` | 0 |

Six positions is far too few to say anything about an edge, and the win-rate
interval spans nearly the whole unit interval. What the sample does show is that
**five of six exits fired on the exit *cost* gate rather than on the thesis** —
the position became too expensive to sell before it became right or wrong. Two
realized approximately −100% of cost. That is the population behaving as
expected and the exit rules working; it is not evidence about profitability in
either direction.

Sole-cause veto tally over the same database (rejections with exactly one hard
veto): `insufficient_liquidity` 257, `dev_holds_too_much` 23,
`excessive_impact` 22, `provider_flagged_suspicious` 4,
`round_trip_too_expensive` 1 — a larger sample than the figures in
`docs/STATUS.md` (47 and 8), pointing the same way.

## 10. What is NOT validated

Unsparingly, and in rough order of how much it should worry a reader.

1. **No edge has been demonstrated.** Zero measurements connect passing the
   gates to any forward return. `reject_tracking` holds 44,529 rows with 18,129
   forward observations, and no gate counterfactual has yet been used to justify
   or challenge a single threshold.
2. **No real money has ever been traded.** Every position is `simulated = 1`.
3. **A signable transaction has never been produced.** All 269 quotes report
   `transaction_buildable = 0` — correct and intended, since quote-only requests
   omit `taker`, but the build-and-sign path is therefore unexercised.
4. **Simulated fills are optimistic in ways the model does not capture.** They
   assume the router's worst-case output was achieved, and model no partial
   fills, no failed transactions, no MEV, and no price movement between quote
   and landing.
5. **The score weights are unfitted, and 20% of them are dead.** The `organic`
   term is structurally 0 across the whole eligible age window, capping `raw` at
   0.80 while the same missing field adds 0.25 soft risk.
6. **`minOpportunityScore` is arbitrary.** 0.35 in paper, 0.45 live, 0.5 canary.
   No analysis supports any of those, and no measurement relates score to
   outcome.
7. **`assumedRentRecoveryRate = 0.5` is a guess**, and it directly scales the
   viability floor, which is the constraint that decides minimum viable capital.
8. **The 50 bps new-token fee does not match observation.** Every measured quote
   returned 10 bps. Unresolved; the conservative number is used deliberately,
   but "we do not understand the provider's fee schedule" is the actual state.
9. **On-chain concentration has never run in production.** It requires a keyed
   RPC; the public endpoint 429s on `getTokenLargestAccounts`. Every screening to
   date graded it as soft risk 0.30 rather than measuring it.
10. **`EXIT_BLOCKED` accounting is incomplete.** It is absent from
    `TERMINAL_STATES` and excluded from `openPositions()`, so its capital is
    neither marked nor written off. Untested because it has never occurred.
11. **Four risk-config fields are declared and never read**:
    `maxAggregatePlannedLossPct`, `dailyLossHaltPct`, `weeklyLossHaltPct`,
    `drawdownHaltPct`. They validate, they appear in every config file, and no
    code consumes them. `maxClockSkewMs` and `enrichIntervalMs` are likewise
    unread. A limit that is configured but not enforced is worse than an absent
    one, because it reads as protection.
12. **Linear extrapolation of the quote to entry size is unverified** above the
    0.05 SOL probe; entry never exceeds the probe to avoid relying on it.
13. **The liquidity floor is unmeasured** — 98.5% of rejections cite it and
    nothing below it has ever been quoted — and **the trial ledger is empty**, so
    the multiple-testing exposure of every revision so far is undocumented.
14. **Entry and exit for real execution do not exist.** The entry/exit loop is a
    visible gap in `apps/executor/src/main.ts` rather than a stub, and the
    promotion gates report 200 closed paper positions and 72 hours of
    observation as prerequisites for canary; the current figures are 6 and 2.5.
