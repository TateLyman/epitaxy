# THE LOW-CAPITAL PROFIT PATH

**State: `NO_CAPITAL_SCALED_PATH: REVENUE_MUST_BE_DECOUPLED_FROM_CAPITAL`.**

**Request:** operator, 2026-08-19 — *"analyse everything and tell me how we get profiting from
here"*, followed by the binding constraint: **low capital, tooling available, speed matters.**
**Predecessor:** PR #67, `MECHANISM_FAILS_AT_ANY_FEE_SHARE`, SHA `3090827`.
**Dune credits: 0.** No query was created, run or paid for. Every corpus figure below is a read of
`data/runtime.db`; every external figure is a public source, cited in §9.
**Ledger: no row.** This document preregisters no decision rule and defines no gate. It is a
strategy note, not a phase, and §8 says what it would take to make any part of it one.
**`MEASUREMENT_ONLY`.** No mode changed, no gate moved, no wallet funded, nothing signed.

The state string is **mine, not a directive's**, in the same way `FEE_ON_FLOW_SURVEYED` was. It is
written in the programme's grammar so it can be quoted alongside the phases, and it claims nothing
beyond §7.

---

## 0 — THE ONE-LINE ANSWER

**At this capital level every strategy whose revenue is proportional to capital is dead by
arithmetic before any edge question is asked — so the only paths that pay are the four whose
revenue is *not* proportional to capital, and of those the fastest is to sell the capability this
programme has already demonstrated, not the trades it has failed to find.**

Three findings carry that sentence, and the first is new to this repository.

- **The memecoin branch has a ceiling, and nobody had computed it.** Every phase asked whether the
  edge exists. None asked how large the business is if it does. Measured from this corpus:
  **201 eligible admissions/day**, **~0.25–0.5 SOL** per position before a tier-0 pool refuses the
  size, and a best-anywhere candidate edge of **+16 to +38 bps** that never survived a lower bound.
  That is **$2,500–$12,000 per year at the ceiling, on roughly $400 of working capital**, needing
  **340–632 days** to confirm. The branch was not merely unprofitable. **It was never large enough
  to be worth confirming**, and that was knowable on day one from three numbers already in the
  corpus.

- **Nine phases died of the same three multiplicative penalties, all properties of the venue and
  none of the apparatus.** Against a major perpetual: **28–83× the round-trip cost floor**, **~35×
  the per-observation variance** (41.8% measured here against ~1.2%), and about **10⁵× less
  capacity per position**. Required gross edge scales with the first; required sample scales with
  (σ/edge)². `NO_DECIDABLE_CELL` was a design outcome, not a discovery.

- **Low capital forecloses the move a larger balance would have made.** Delta-neutral carry returns
  a *percentage*: at $1,000 and a historically representative 12–19%, that is **$120–190 per year**.
  It is not a bad strategy; it is an irrelevant one at this size. The constraint does not merely
  narrow the list — it removes the entire capital-scaled column of it.

---

## 1 — THE GOVERNING ARITHMETIC, STATED BEFORE ANY OPTION

```
income  =  capital  ×  turnover  ×  net edge per turn
```

With capital fixed and small, income can only be carried by the other two terms. Both are bounded,
and the bounds are measurable rather than rhetorical:

- **Turnover is bounded below by the cost floor.** Every turn must clear it. At PumpSwap tier 0 the
  floor is **250 bps round trip** (LP 2 + protocol 93 + creator 30, doubled — decoded from the
  on-chain `FeeConfig`, and 392 of 405 decoded trajectories sit in that tier). A strategy turning
  over 20 times a day at that floor must find **5,000 bps of gross edge per day** before it earns a
  cent. Nothing in this corpus finds 250.
- **Turnover is bounded above by signal arrival.** 201 eligible admissions/day, measured.
- **Net edge is bounded by what has been measured**, and every measurement in this programme is
  negative (§2).

So at low capital there are exactly four revenue lines that are **not** proportional to capital,
and the whole of §6 is a ranking of them:

| # | line | proportional to | capital needed |
|---|---|---|---|
| 1 | **labour** — bounties, audits, contracting | demonstrated skill | none |
| 2 | **information** — published research, data products | credibility | none |
| 3 | **fee on flow** — referral, affiliate | audience | none |
| 4 | **high-turnover edge** | edge × turnover, *not* capital | small, but the edge must be real |

Anything outside that table needs a balance this operator does not have. That is the finding, and
it is arithmetic rather than pessimism.

---

## 2 — WHAT THE PROGRAMME ACTUALLY ESTABLISHED

Recomputed from `data/runtime.db` for this note rather than quoted, and it reproduces the reports.

| result | figure | source |
|---|---|---|
| this system's own gated admissions, 60 min | **−17.44% mean**, −18.6% median, SD 41.8%, p10 −69.6%, n=455 | recomputed here; reproduces Phase B's −17.4% / −69.6% |
| copying the best wallets, at honest coverage | **−4.28%** [−5.61%, −2.91%], H\*=120s, 87.2% coverage | Phase G |
| liquidity provision on 377 own pools | fee 0.0077% vs **LVR 0.3612%** — 47×; break-even 93.7 bps against 22 available | LP decomposition |
| migrated-population conditional mean | −60.2% to −98.7% by tier | Phase B |
| tradable cells surviving a day-clustered lower bound | **0 of 270** | Phase B |
| cost floor, tier 0 to tier 16 | 2.669% to 1.025% | Phase B |

**And one confirmed positive, which is not ours.** H1 — wallet performance persists across disjoint
windows at **+36.74%** [+33.57%, +40.03%] per position on the preregistered cut and **+12.67%**
[+11.38%, +14.00%] on the robust cut, monotone across ten deciles, 211,225 wallets, 11.85M holdout
positions, positive on 30 of 30 days, surviving every adversarial re-cut and holding at entity level
as well as address level. Phase G then priced what it costs to follow those wallets and the interval
excludes zero on the wrong side.

**The apparatus is healthy.** `pnpm check` green at this SHA: **144 files, 2,203 tests, 14.87s**.
Nothing below is a recommendation to rebuild anything.

---

## 3 — THE CEILING, WHICH IS THE NEW NUMBER

Computed here for the first time. Every input is measured, not assumed.

```
eligible admissions      201 / day        1,427 of 837,876 screened over 7.1 days (0.17%)
size per position        0.25 - 0.5 SOL   tier-0 pools refuse 0.50; tier-8 accept 1.00 (Phase B)
best candidate edge      +16 to +38 bps   4 of 36 cells, D70B4A9A; zero survive a lower bound
SOL                      ~$85             August 2026
```

```
turnover ceiling   201 x 0.25-0.5 SOL   =   50 - 100 SOL / day   ~  $4,250 - $8,500 / day
revenue ceiling    x 16-38 bps          =   0.08 - 0.38 SOL/day  ~  $7 - $32 / day
                                        =   $2,500 - $12,000 / year
working capital    2 concurrent positions (live config) x 0.25-0.5 SOL   ~   $43
                   at 20 concurrent                                      ~   $425
```

**Read the last two lines together.** The upper bound of the entire branch is a five-figure salary
in its best year, and it takes 340–632 days of collection to establish whether it is that or zero.
Over the same period the fee layer above this market took **$111.4M in 30 days**.

This is not an argument that the phases were wrong. They were right, and they were rigorous, and
several of them are publishable (§6.2). It is an argument that the branch was never worth the
instrument pointed at it — and that this was computable from three corpus numbers without spending
a single Dune credit.

---

## 4 — WHY EVERY PHASE FAILED THE SAME WAY

Three penalties, multiplicative, all properties of the venue:

| penalty | PumpSwap tier 0 | a major perpetual | ratio |
|---|---|---|---|
| round-trip cost floor | **250 bps** | 9 bps taker, 3 bps maker (Hyperliquid 1.5 / 4.5) | **28–83×** |
| per-observation σ, 1 hour | **41.8%** (measured, n=455) | ~1.2% | **~35×** |
| capacity per position | ~$21–43 | institutional | **~10⁵×** |

Required gross edge scales with the cost floor. Required sample scales with (σ/edge)². The corpus
demonstrates the consequence exactly: to resolve a **0.5%** edge against the measured σ takes
**26,828 positions — 340 days** at the measured arrival rate; D70B4A9A's own figure for the selected
cohort is **49,854 positions, 632 days**.

**The inverse is the useful half.** In a market with a 9 bps floor and ~1.2% hourly σ, an edge of 25
bps is confirmable in **~84 observations**. The same discipline that could not close a question in
632 days closes it in an afternoon. **The standard of evidence was never the problem. The venue
was.**

---

## 5 — WHAT IS WORTH SOMETHING, AND WHAT IT IS WORTH

Three assets, priced honestly.

1. **The apparatus.** ~63,000 lines of source, ~35,000 of tests, 2,203 tests green in 15 seconds:
   preregistration ledger, day-clustered bootstrap, censoring treatments that must agree in sign,
   replay determinism, fail-closed refusal, a signer that cannot be handed an arbitrary transaction.
   About half the files are venue-coupled (82 of 165 in `packages/*/src` reference Solana, Pump or
   Jupiter). **The discipline is portable; the venue adapter is not.**

2. **The corpus.** 837,876 screenings each with a snapshot, 1.67M tracked rejections, 7.02M chain
   events, 704 development trajectories with full mark paths. Its distinguishing property is that
   **the rejects are stored**, which is the state most trading research is permanently unable to
   reach.

3. **The negative results — which are the most saleable item and are currently unsold.** The
   `FEE_ON_FLOW` brief lists as its own unknown #1: *"no public dataset, dashboard or study
   decomposing memecoin LP returns into fees / IL / total loss was found."* **You hold the only one
   that exists.** LVR backed out of the measured reserve path rather than assumed from sigma-squared
   over eight, on 377 real pools, with the fee term recovered independently from the
   constant-product invariant (the retained-rate bound floors at **1.9958 bps** at p10 against a
   decoded `lpFeeBps` of 2). That is a paper. So is Phase H's venue-mix decomposition, and so is
   "wallet skill persists at +36.74% out of sample and does not transfer to a copier at −4.28%".

---

## 6 — THE FOUR PATHS, RANKED FOR THIS OPERATOR AT THIS CAPITAL

Ranked by **time to first dollar**, with the honest objection to each stated rather than omitted.

### 6.1 Sell the demonstrated capability — bounties, audits, contracting

**Fastest real money, zero capital, weeks not months.**

Immunefi has paid **$134M cumulative** to researchers by end-Q1 2026, **$7.87M in Q1 2026 alone
across 1,104 reports** — a mean of about $7.1k per accepted report, with a median far below that.
Solana-specific standing programmes include **Orca Whirlpools ($500k max)** and **Light Protocol
($50k max)**.

**Why this operator specifically, rather than as generic advice.** The repository is a record of
finding real defects in other people's systems, repeatedly, by refusing to accept a plausible
reading:

- diagnosed a **Helius batch-size bound of five accounts** that was being reported with an
  exhausted-quota error message, after the whole corpus and the error text pointed at credits — and
  retracted a purchase recommendation rather than buy capacity that would have fixed nothing;
- **falsified the PumpSwap fee formula** by probing the program instead of reading the schedule, and
  showed the proposed rule agreed at tier 0 by coincidence and separated at tier 16;
- found the **cashback accumulator on the `sell` leg** that the repository itself had asserted did
  not exist, halving every modelled round-trip refund;
- caught its own **`virtualQuoteReserves` denominator error** — 17.5845 SOL of liquidity nobody
  owns — in the direction that *flattered* its own hypothesis, and published the correction.

That is protocol forensics, and it is the same act that bug bounties pay for.

**The objection, stated plainly:** this is labour, not a trading business. It does not compound and
it stops when you stop. It is on this list first because it is the only line that produces money at
zero capital inside a month, and it funds everything below it.

### 6.2 Publish the corpus — the cheapest route to the one input you lack

Every accessible mechanism in the `FEE_ON_FLOW` ranking bottlenecks on **distribution**, and the
brief was right that fifteen months of measurement infrastructure does not produce an audience.
**But it produced something that does:** a body of rigorous, adversarial, preregistered negative
results in a field where almost nothing published is either.

Cost: zero. Time to first dollar: months, indirectly. What it produces: the credibility that makes
§6.1 inbound rather than outbound, that makes §6.3 fundable, and that is the sole input to §6.4.

**The objection:** publishing is not income, the conversion rate from "respected" to "paid" is
unreliable, and it competes for the same hours as §6.1.

### 6.3 Trade where the research loop actually closes — prediction markets

**This is the one *trading* answer that survives every constraint simultaneously:** low capital, no
latency infrastructure, US-legal, and an edge that is a research problem rather than a
microstructure one.

| dimension | PumpSwap tier 0 | prediction markets |
|---|---|---|
| cost | **250 bps of notional**, round trip | **zero** on most Polymarket markets (politics, econ, entertainment, most sports); fee-enabled 4–7% and Kalshi 0.07 — both applied to `p(1-p)`, not to notional |
| capacity | 0.25–0.5 SOL, and low capital is a handicap | thin markets, where **low capital is an advantage** — you can take the whole mispricing without moving it |
| edge source | predicting a memecoin | being right about the world, against a deterministic written resolution |
| loop time | **340–632 days** | days |

The three documented retail edges are **cross-platform spreads on identical resolution language**,
**mispriced thin-market quotes**, and **underpriced rule asymmetry**. The third is precisely the
skill this repository has demonstrated over and over: reading what the rules actually say instead of
what everyone assumes they say — the same act as decoding `FeeConfig` off the chain rather than
trusting the published schedule.

Legal status, current: Polymarket has operated as a **CFTC-regulated Designated Contract Market
since November 2025** and reopened to US users in December 2025 under KYC; Kalshi is CFTC-regulated.
**At least 11 states had raised concerns or taken action as of April 2026** — a real gray zone that
must be checked for your state before funding anything.

**The objection, and it is the important one:** *no edge here has been measured by this operator, and
nothing above claims one exists.* This is a hypothesis. Its entire virtue is that it is a hypothesis
whose test **completes in days instead of 632 of them**, on a venue that does not charge 250 bps for
the privilege of asking. It should enter through `paper` with a preregistered rule and a ledger row,
exactly like everything else here, before one dollar is risked.

### 6.4 Referral, seeded by 6.2

The #1 mechanism in the `FEE_ON_FLOW` ranking. **Axiom alone has paid out $280.5M** — 37.8% of gross
fees, computed from DefiLlama's own accounting — and is currently paying $8–10M/month. Zero capital,
zero latency, legal, pays promptly. Rates cluster at 20–40% of a referred user's fees, so roughly
**30 bps of referred volume**.

Honest sizing at realistic audience levels: casual sharing 0.1–0.5 SOL/month; active creators 2–20
SOL/month (about $170–$1,700); high-traffic 20–200+ SOL/month. **Its input is §6.2's output and
nothing else.**

### 6.5 What I would not do, and why

- **Raise size to escape the rent floor.** The 0.02 SOL notional makes the setup cost the entire
  result — but capacity forbids the fix. A tier-0 pool will not take 0.50 SOL.
- **Liquidity provision at a better venue.** Break-even needs **93.7 bps** against the 22 bps
  Raydium AMM v4 actually pays; turnover is 4.4× short even at the 90th percentile of activity. The
  hypothesis has now been wrong on the fee split, on the theory, and on the magnitude.
- **Latency, MEV, cross-venue arbitrage.** Permanently ruled out by the operator, and correctly:
  tips take 50–60% of profit and Jito MEV tips are down about 65% within 2026.
- **Delta-neutral carry.** Correct strategy, wrong balance sheet: **$120–190/year at $1,000.** It
  becomes the right answer the moment capital exists, and not before.
- **The mechanisms that demonstrably do pay.** Deployer-funded same-block sniping runs at 87%
  profitability across 15,000+ launches. It is trading on your own undisclosed launch against buyers
  who do not know. It stays out of bounds.

---

## 7 — WHAT THIS DOES AND DOES NOT CLAIM

**It claims:** the ceiling arithmetic in §3, the penalty ratios in §4, and the recomputation in §2
are correct, and that they jointly imply the memecoin branch should be closed with a terminal state
rather than probed further.

**It does not claim** that any path in §6 is profitable. §6.1 has a market rate but no engagement.
§6.3 has a cost structure and a documented edge *for other people* and **no measurement by this
apparatus at all**. §6.4 has a pool size and no audience. Nothing here has been preregistered,
nothing has a hold-out, and no gate has moved.

**The honest summary of the whole note:** the programme's own standard of evidence was never the
problem, and the apparatus was never the problem. The venue was, in three measurable ways at once,
and low capital removes the one move — a larger balance in a cheaper market — that would have fixed
it directly. What is left is to sell the capability rather than the trades, publish the results
rather than sit on them, and if trading continues, to do it where a question can be answered in days.

---

## 8 — WHAT WOULD MAKE ANY OF THIS A PHASE

In the order it would have to happen, and none of it has:

1. **A terminal state for the memecoin branch**, written to `docs/STATUS.md` with the ceiling in §3
   as its reason, so the corpus stops being a thing that might still be traded.
2. **A preregistered rule for §6.3** in `docs/MULTIPLE_TESTING_LEDGER.csv` *before* any market is
   read — the resolution-language comparison, the mispricing threshold, the exit, and the hold-out —
   with the same censoring discipline every phase here has used, because "the market never resolved"
   is the same defect as "the token never traded again".
3. **A venue adapter and a cost model** for whichever venue §6.3 selects, entering through `paper`.
   The storage, ledger, bootstrap, replay and refusal layers transfer unchanged; only the adapter
   and the cost model are new.
4. **Only then** capital, and it would still start from `paper` with a frozen rule.

The two cheap items the programme already named and never ran are unaffected by any of this and can
still close the copy branch for about 120 Dune credits: the **sharper wallet flag** (top-0.1%,
flagged-buyer confluence, flagged size) and **this system's own executable quote against a flagged
token at the moment the flag fires**, which costs nothing but observation time. My estimate is that
neither reverses Phase G's −4.28% [−5.61%, −2.91%]. They are worth running to *close* the branch,
not to save it.

---

## 9 — SOURCES

**Local corpus** (`data/runtime.db`, recomputed 2026-08-20): `screenings` (837,876 rows, 1,427
eligible, 7.1-day window), `development_trajectories` (704, all FIRST_HOUR, all 20,000,000 lamports,
all `SIMULATED_EXECUTION`), `trajectory_marks` (3,856), `process_locks`. `pnpm check` at SHA
`3090827`: 144 files, 2,203 tests.

**In-repo:** `docs/PHASE_B_REPORT.md` · `docs/PHASE_G_REPORT.md` · `docs/LP_DECOMPOSITION_REPORT.md`
· `docs/FEE_ON_FLOW_RESEARCH_REPORT.md` · `docs/D70B4A9A_FINAL_REPORT.md` ·
`docs/WALLET_PERSISTENCE_RESULTS.md` · `docs/MECHANICS_FLOOR_MEASURED.md` ·
`docs/PUMPSWAP_CASHBACK_V2.md` · `docs/MULTIPLE_TESTING_LEDGER.csv`.

**External, retrieved 2026-08-19/20.**

Bug bounties: [Immunefi Q1 2026 payout statistics](https://sqmagazine.co.uk/smart-contract-bug-bounties-statistics/) · [Immunefi Solana programmes](https://www.bydfi.com/en/cointalk/immunefi-solana-bug-bounty-2026) · [Sherlock, highest-paying programmes 2026](https://sherlock.xyz/post/best-web3-bug-bounties-in-2026-the-highest-paying-programs-on-every-platform)

Prediction markets: [Kalshi vs Polymarket fee comparison](https://www.alphascope.app/blog/kalshi-vs-polymarket-fees) · [cross-platform arbitrage, fees and liquidity](https://news.dropstab.com/research/kalshi-vs-polymarket) · [retail edge and Kelly sizing](https://tech-insider.org/prediction-markets/prediction-market-strategy/) · [Polymarket US legal status, CFTC DCM](https://www.polymarket101.com/en/docs/countries/is-polymarket-legal-in-united-states/) · [state-by-state position](https://www.newspoly.net/blog/is-polymarket-legal-in-the-us)

Perp cost floors and carry: [Hyperliquid fee schedule](https://hyperliquidguide.com/guides/fees/fees-explained) · [Hyperliquid vs Drift](https://perpfinder.com/compare/hyperliquid-vs-drift) · [funding-rate arbitrage returns](https://arbitragescanner.io/blog/crypto-funding-rate-arbitrage-guide) · [delta-neutral strategy survey](https://coinmarketcap.com/academy/article/crypto-delta-neutral-strategy-2026)

US access: [CFTC opens the perp door with the first approval at a regulated firm, 2026-05-29](https://www.coindesk.com/policy/2026/05/28/u-s-cftc-opens-crypto-perp-door-with-approval-of-first-regulated-firm) · [Coinbase announcement](https://www.coinbase.com/blog/perpetual-futures-have-arrived-in-the-us)

Referral and ecosystem: [Solana referral programme sizing](https://madeonsol.com/blog/solana-referral-affiliate-programs) · [Solana Foundation Frontier Traders](https://solana.com/news/introducing-frontier-traders) · DefiLlama figures as computed in `docs/FEE_ON_FLOW_RESEARCH_REPORT.md`

SOL price context: [August 2026 range](https://changelly.com/blog/solana-price-prediction/)
