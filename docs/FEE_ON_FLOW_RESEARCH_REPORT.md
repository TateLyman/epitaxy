# WHERE MONEY IS ACTUALLY MADE IN THE SOLANA LAUNCHPAD ECOSYSTEM

**State: `FEE_ON_FLOW_SURVEYED: ONE_ACCESSIBLE_MECHANISM, AND IT IS NOT A MEASUREMENT BUSINESS`.**

**Directive:** `docs/directives/DIRECTIVE_7A8D7564_RESEARCH_BRIEF_FEE_ON_FLOW.md`, transcribed and
committed before execution (`7e91afb`).
**Predecessor:** PR #65, `VENUE_LOCATED`, SHA `bff77bd`.
**Ledger:** MT099, written *after* the one corpus measurement this brief provoked, and recorded as
a deviation for that reason. §3.2 says why the measurement was run and §11 says what it cost the
programme's discipline.
**Dune credits: 0 of ~500.** No query was created, run, or paid for. Every quantitative claim below
is either a public primary source, an arithmetic operation on one, or a read of the local corpus.
**`MEASUREMENT_ONLY`.** No mode changed, no gate moved, no wallet funded, nothing signed.

The state string is **mine, not the directive's** — this brief defines no state, unlike Phases A–H.
It is written in the programme's grammar so it can be quoted alongside the others, and it claims
nothing beyond §10.

---

## 0 — THE ONE-LINE ANSWER

**Every durable revenue line in this ecosystem is a toll on flow, a toll requires that you own either
the flow or the infrastructure it crosses, and this operator owns neither — so the honest accessible
list is one item long, it is the referral share on somebody else's terminal, and its binding
constraint is distribution, which is not a measurement problem.**

Three findings carry that sentence, and two of them contradict the brief's own premises:

- **H1 is not merely unproven, it is falsified, and the brief's arithmetic for it is wrong by 10×.**
  On the pools this apparatus actually reaches, PumpSwap's on-chain `FeeConfig` splits 125 bps per
  leg as **LP 2 / protocol 93 / creator 30**. The LP receives **1.6% of the fee**, not the 0.20% the
  brief assumes. And measured on 377 of the operator's own stored pools, **LP minus hold is −0.278%
  in under an hour**, with the LP beating the hold basket in **8.0%** of pools. The premise that zero
  drift makes market-making profitable is wrong in theory as well: loss-versus-rebalancing runs at
  **σ²/8**, which depends on variance and never on drift.

- **The market-context figure the brief asks to verify is real but misdated by about a year.** No
  week in DefiLlama's Solana DEX series reaches $118.2B in 2026; the 2026 peak week is **$40.68B**.
  The $118B→$44.5B collapse matches **January–February 2025** ($107.85B → $47.82B, −55.7% in three
  weeks). The three-weeks-in-early-2026 framing does not survive contact with the series.

- **The ecosystem is not dying in the way the brief assumes.** Solana DEX volume kept falling through
  2026 — $10.69B in the week of 2026-08-10 — while the fee layer on top of it *rose*: pump.fun's
  protocol family took **$86.66M in July 2026** against $66.33M in June, GMGN went **$5.3M → $22.7M**,
  and a wallet that did not exist two years ago now clears **$7.4M/month**. The toll is capturing more
  per unit of volume, not less. That is the finding with the most consequence for anyone deciding what
  to build.

---

## 1 — WHAT WAS DONE, AND AT WHAT STANDARD

The brief asks for a literature-and-primary-source review at the standard the programme's own work
runs at. Three things were done to try to meet it.

**Primary sources were computed, not quoted.** Where a figure was checkable against a public API it
was pulled and aggregated locally rather than taken from the trade press that reported it. Every
DefiLlama number below comes from `api.llama.fi` and the aggregation is arithmetic I ran; the weekly
volume series in §2.1, the Q1-2026 revenue in §2.3, Axiom's referral outflow in §8, and every monthly
series in §9 are of this kind. This matters because in two cases the computed figure and the reported
figure disagree, and in both cases the reported one was wrong.

**One corpus measurement was run.** H1 turned out to be answerable from `data/runtime.db` at zero
cost, because `trajectory_marks` stores pool reserves at seven offsets and PumpSwap's fees accrue
*into* those reserves. That makes the stored reserve path a direct record of an LP's profit and loss,
net of fee income, with no modelling. It was run. §3.2 reports it and MT099 records that it was
post-hoc.

**Evidence is graded inline.** The directive's own taxonomy is used: on-chain data, protocol
documentation, academic papers and DefiLlama/Token Terminal figures are used as load-bearing; vendor
blogs, bot documentation and trade press are labelled **[weak]** wherever they appear and are never
the sole support for a ranked conclusion. Where the honest answer is that no reliable public data
exists, §12 says so rather than filling the gap.

**What was not done.** No Dune credit was spent. No hold-out was constructed, because nothing here is
a trading rule. The one corpus measurement has two day-clusters and therefore no usable interval, and
§3.2 states that rather than reporting a bootstrap that would be arithmetic dressed as inference.

---

## 2 — MARKET CONTEXT, VERIFIED AGAINST PRIMARY SOURCES

The brief flags these four as trade-press figures to be checked. Three survive in substance; one does
not survive as stated.

### 2.1 "Weekly Solana DEX volume fell ~62% in three weeks in early 2026 ($118.2B → $44.5B)" — **NOT REPRODUCIBLE AS DATED**

DefiLlama's Solana DEX volume series, aggregated into Monday-anchored weeks:

| week | volume | week | volume |
|---|---|---|---|
| 2025-10-06 | **$46.64B** (peak of the whole window) | 2026-06-01 | $18.90B |
| 2026-01-05 | $29.58B | 2026-07-06 | $12.82B |
| **2026-02-02** | **$40.68B** (2026 peak) | 2026-07-27 | $11.43B |
| 2026-02-23 | $20.77B | 2026-08-03 | $10.62B |
| 2026-03-02 | $18.91B | 2026-08-10 | **$10.69B** |

No week in 2026 comes within $77B of $118.2B. The largest three-week fall in early 2026 is
**2026-02-02 $40.68B → 2026-02-23 $20.77B, −49.0%**, and extending to four weeks gives −53.5%.

The claimed magnitudes match a different year. In the same series:

| 2025-01-13 | **$107.85B** |
|---|---|
| 2025-01-20 | $107.05B |
| 2025-01-27 | $59.79B |
| **2025-02-03** | **$47.82B** |

That is **−55.7% in three weeks**, from a level within ~10% of $118.2B to one within ~7% of $44.5B —
the residual gap being the sort of difference that separates aggregators who do and do not net out
aggregator routing. **The event is real. It is January–February 2025, not early 2026.** Anyone
reasoning from "the collapse happened three weeks ago" is reasoning from a twelve-month-old event.

Source: DefiLlama `/overview/dexs/solana`, retrieved 2026-08-19; aggregation mine.

### 2.2 "pump.fun's seven-day graduation rate fell to ~0.26% by June 2026" — **VERIFIED, WITH A BETTER SOURCE, AND NOW STALE**

There is an academic source that supersedes the trade press here. Kamat, *Pump.fun Graduation Regime
Windows: Survival Analysis of 832,941 Token Launches and the Social-Presence Effect* (arXiv
2607.02823, v2 revised 2026-08-13) reports a pooled graduation rate of **0.198% (Wilson 95% CI
[0.189%, 0.208%])** over 832,941 launches between 2026-05-08 and 2026-06-10.

Two qualifications the paper makes about itself, both of which matter:

- Its collector could reliably observe graduations only within **about six minutes** of launch, so the
  figure is a **fast-regime rate and an explicit lower bound** on the true 24-hour rate. It is not
  directly comparable to a seven-day rate.
- Against Marino et al.'s 0.63%, the 3.18× ratio is characterised by the author as **an upper bound on
  the decline**, not a point estimate.

The same paper supplies the single most actionable number in this section for anyone thinking about
H2: launches advertising a Telegram channel graduate at **1.485% versus 0.166% without — an 8.94×
lift, Cox hazard ratio 5.40 [4.73, 6.17]**. Distribution, again, is the variable that moves outcomes.

**The figure is also now out of date.** Following pump.fun's BOOST launch in late July 2026, reported
graduation rates rebounded to **4.7%–6.7%** [weak — The Block, trade press]. Whatever the exact level,
§2.5 shows the fee data moving in the same direction at the same time, so the rebound is not only a
press artifact.

### 2.3 "pump.fun: $124.7M in Q1 2026, ~36% of all Solana app revenue" — **VERIFIED**

Summing DefiLlama's daily revenue series for the `pump` protocol family over January–March 2026 gives
**$122.16M**, against fees of $294.47M. That is within 2% of the brief's $124.7M and the difference is
plausibly a definitional one about which child protocols are included.

The share claim holds and is if anything understated today. Over the trailing 30 days, Solana-wide app
revenue is **$111.40M**, of which the pump family takes:

| protocol | 30d revenue | share |
|---|---|---|
| pump.fun | $27.69M | 24.9% |
| PumpSwap | $11.88M | 10.7% |
| Terminal | $2.23M | 2.0% |
| pump.fun Mobile App | $1.51M | 1.4% |
| **pump family total** | **$43.31M** | **38.9%** |

### 2.4 "Solana daily network fees fell from ~33,000 SOL to ~5,300 SOL" — **DIRECTIONALLY VERIFIED, CURRENTLY HIGHER**

Solana Compass reports roughly **8,036 SOL/day** in total fee revenue in 2026, and a mid-January 2026
priority-fee peak above **122,000 SOL in a single day** [weak — statistics site, not a protocol
primary]. The direction and rough magnitude of the brief's claim survive; the current level is
~50% above the quoted trough, and the quoted peak is low against a single-day peak. I did not find a
primary, SOL-denominated daily fee series I would rely on, and §12 records that as an open unknown
rather than estimating around it.

### 2.5 "Speculative capital rotated toward perpetual-futures venues" — **UNVERIFIED HERE**, and partly contradicted

No primary check was made on the perps-rotation claim, so it stands unverified. But a related and
checkable claim runs the other way, and it is the most consequential thing in this section.

**Volume fell and the toll rose.** Monthly fees, DefiLlama, computed:

| protocol | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 (18 days) |
|---|---|---|---|---|---|
| pump family | $67.42M | $78.61M | $66.33M | **$86.66M** | $68.83M (≈$118M pace) |
| GMGN | $9.0M | $9.9M | $5.3M | **$22.7M** | $17.5M |
| DEX Screener | $0.7M | $1.3M | $2.9M | **$4.5M** | $2.4M |
| fomo Wallet | $1.9M | $2.9M | $2.3M | **$7.4M** | $7.3M |
| Jito MEV Tips | $3.4M | $3.8M | $2.7M | $3.3M | $2.2M |

Every interface line steps up sharply in July while weekly DEX volume goes sideways at a decade low
(§2.1). The exception is **Jito MEV tips, which keep falling** — the only line in the table that does
not participate in the recovery. §6 returns to that.

---

## 3 — H1: LIQUIDITY PROVISION ON POST-MIGRATION POOLS

**Verdict: NO. Falsified, and the hypothesis was worse than the brief believed on two independent
grounds.**

### 3.1 The fee premise is wrong by a factor of ten on the relevant pools

The brief states: *"PumpSwap's base fee is 0.25% with 0.20% to liquidity providers: the LP earns what
the taker currently pays."*

That is not what the program does at the tier where freshly-graduated tokens sit. PumpSwap's fee is a
**step function of the pool's market cap**, decoded from the on-chain `FeeConfig` by the pinned
`@pump-fun/pump-swap-sdk` in `packages/solana/src/fee-tiers.ts`. Grouping every trajectory this
apparatus has ever opened by its decoded split:

| tier (market-cap threshold) | LP bps | protocol bps | creator bps | total/leg | trajectories |
|---|---|---|---|---|---|
| **0** | **2** | **93** | **30** | **125** | **392** |
| 420 SOL | 20 | 5 | 95 | 120 | 12 |
| 1,470 SOL | 20 | 5 | 25 | 50 | 2 |
| higher tiers | 20 | 5 | 35–90 | 60–115 | 5 |
| *(undecoded)* | — | — | — | — | 292 |

**At tier 0, where 392 of 405 decoded trajectories sit, the LP receives 2 bps of a 125 bps fee — 1.6%
of it.** The protocol takes 93 and the creator takes 30. The taker emphatically does *not* pay what
the LP earns; the taker pays 62× what the LP earns.

This is not a new discovery so much as a fact already in this repository that the brief's premise
contradicts. `docs/MECHANICS_FLOOR_MEASURED.md` line 94 records the identical bottom-tier split, and
`docs/PHASE_G_REPORT.md` §4.1 measures tier 0 and tier 16 against the constant-product invariant to six
decimal places. The programme's own 250 bps round-trip floor **is** this tier doubled.

The 0.20% LP share the brief assumes appears only *above* the first threshold — at ~420 SOL of market
cap, which is roughly the $88k the brief itself names as the bottom of the high-creator-fee band. So
the brief's arithmetic describes a real tier; it is simply not the tier the apparatus reaches.

### 3.2 Measured on the operator's own pools, LP loses to holding

`trajectory_marks` stores `observed_base_reserve` and `observed_quote_reserve` at offsets of 60s,
180s, 300s, 600s, 900s, 1,800s and 3,600s. Because PumpSwap fees accrue into the reserves, that path
records what an LP actually earned, fees included, with nothing modelled. For a constant-product pool,
an LP holding fraction *s* at t₀ has value 2·s·q₀ and at t₁ has 2·s·q₁, against a hold-the-basket
benchmark of s·(b₀·p₁ + q₀). So:

```
LP return    =  q1/q0 - 1
HODL return  =  (b0*p1 + q0) / (2*q0) - 1
realised LVR =  LP - HODL          (net of every fee the pool earned)
```

Run over 383 trajectories carrying two or more reserve marks, dropping 6 with a detected mint or burn
(|Δk| > 2%), leaving **377 pools, all `PUMPSWAP_DIRECT`, opened 2026-08-17 and 2026-08-18**:

| population | n | LP | HODL | **LP − HODL** | LP beat HODL |
|---|---|---|---|---|---|
| all clean pools (≤59 min) | 377 | +0.010% | +0.288% | **−0.278%** | **8.0%** |
| full 59-minute horizon only | 224 | +0.169% | +0.558% | **−0.389%** | **9.4%** |
| pools whose reserves moved at all | 192 | +0.020% | +0.566% | **−0.546%** | — |
| pools moving >10% in the hour | 61 | — | — | **−1.674%** | — |

The five worst pools are the tell: **−21.30%** at a −87.9% price change, **−14.18%** at a **+135.0%**
change, −13.12% at +128.8%, −5.19% at +75.1%, −4.62% at −51.7%. **The loss is indifferent to the
direction of the move and grows with its size.** That is loss-versus-rebalancing, not directional bad
luck.

Three properties of this measurement decide how much weight it can carry:

- **The interval is not an interval.** The 377 trajectories fall on **two** distinct days. A
  day-clustered bootstrap over two clusters produced [−0.283%, −0.251%], and that is arithmetic, not
  inference. **The point estimate is what stands.**
- **Every discretionary choice flatters the hypothesis.** Fees are counted in full; liquidity events
  are dropped; the dead-pool denominator is reported alongside an active-only figure that is *worse*.
  The measurement is an **upper bound** on LP performance and it is still negative.
- **The horizon is one hour, and the tail the brief correctly identifies is not in it.** The brief is
  right that the real risk is total loss rather than IL. A one-hour window on two days observes none
  of it. §12 records this as the open unknown it is.

MT099 records that this was run before it was preregistered, which inverts the programme's own order.

### 3.3 The theory says the premise was never sound

The brief's reasoning is: *impermanent loss requires drift; measured median drift is nil; therefore
market-making should work.* The first clause is false as stated.

Milionis, Moallemi, Roughgarden and Zhang, *Automated Market Making and Loss-Versus-Rebalancing*
(arXiv 2208.06046), derive the adverse-selection cost an LP pays to better-informed arbitrageurs
against a stale pool price. For a constant-product AMM the instantaneous rate, normalised by pool
value, is:

```
LVR = σ² / 8      per unit time
```

**There is no drift term.** LVR scales quadratically with volatility and is unaffected by expected
return. A token whose price reliably ends the hour where it started, having travelled a long way in
between, bleeds its LPs at a rate set entirely by how far it travelled. The a16z exposition works the
example: an ETH-USDC pool at 5% daily volatility loses 3.125 bps/day, ~11%/year, and needs ~10.4% of
pool value in daily volume to break even at a 30 bps fee — with the required volume **quadrupling**
when volatility doubles.

Apply the same break-even to tier 0. Required turnover is `V/L = σ²/(8·f)`, and `f` is **0.0002**, not
0.003. At the p90 realised volatility in the corpus (σ ≈ 28.6%/hour), the pool must turn over
**5.1× its own value every hour** for the LP to break even. That is the arithmetic behind the
measurement in §3.2, and it is why the measured sign is not a small-sample accident.

Melnikov et al., *From Impermanent Loss to Sustainable Gain* (arXiv 2604.28014, 2026-05-01), formalise
the region where fees do beat IL: an **impermanent-gain zone that exists only for small price
discrepancies**, bounded above by a threshold that widens with the fee. Large moves sit outside it by
construction. Their controlled on-chain experiment — two Algebra V3 pools, USDT/WMATIC, $3,000 each,
Polygon, 1–26 December 2025 — found 76% of arbitrage transactions in win-win zones **at a 0.03% fee on
a stable-ish pair**. A 0.02% fee on a memecoin is the opposite corner of that parameter space.

### 3.4 What the wider empirical literature says, and what it does not

- Roughly **50% of Uniswap v3 LPs underperform holding**, across 17 pools (arXiv 2111.09192);
  Bancor/IntoTheBlock put it above 51%. **[medium — real studies, but ETH-pair, not memecoin.]**
- Meteora's FY2025: DLMM produced **$907.3M of fees on $168.3B volume** (0.54% fee-to-volume) and
  DAMM **$254.4M on $11.5B** (2.21%); **LPs keep 95% on DLMM and 80% on DAMM/DBC**
  **[medium — secondary, The Token Dispatch].**

That last line is the practically useful one. **If this operator ever provides liquidity, PumpSwap
graduated pools are close to the worst available venue for it** — 1.6% of the fee at tier 0, against
95% of the fee on Meteora DLMM. Nothing in this report recommends doing so; the point is that the
hypothesis as posed picked the venue where the LP is paid least.

### 3.5 The standing fields

| field | answer |
|---|---|
| **works?** | **No.** |
| **who runs it** | Nobody documented as running it systematically on graduated memecoin pools. Meteora's "LP Army" is a retail programme on DLMM, a different venue and fee split. |
| **realistic revenue** | Negative. −0.278% versus holding in under an hour, measured (2026-08-19). |
| **capital to start** | Two-sided, in SOL and the token. The corpus median pool is ~50 SOL. |
| **infrastructure** | None beyond what exists. This is the hypothesis's only attraction. |
| **capacity** | Irrelevant — the sign is wrong before size binds. |
| **what kills it** | The 2 bps tier-0 LP share, and σ²/8 being indifferent to drift. |
| **accessible to this operator?** | Yes, and it should not be. |
| **confidence** | **High** on the fee split (on-chain, corroborated twice in-repo) and on the theory. **Medium** on the −0.278%: two day-clusters, one-hour horizon. |
| **what would change it** | A multi-day, multi-week LP panel with the total-loss tail included; or a venue whose LP share is 95% rather than 1.6%. Neither is proposed here. |

---

## 4 — H2: CREATOR-SIDE ECONOMICS

**Verdict: CONDITIONALLY, and the condition is an audience, not a apparatus.**

### 4.1 The fee ladder, from the chain rather than the announcement

The brief's "0.95% of every trade for tokens under ~$300k market cap" is confirmed by the same decode
as §3.1, and refined by it. Creator bps by tier, from the on-chain `FeeConfig`: **30 bps at tier 0**,
rising to **95 bps at the ~420 SOL threshold**, then declining across higher tiers (90, 65, 60, 35,
25 bps observed). So the 0.95% band is real and sits *above* the bottom tier — a token below roughly
$88k of market cap pays its creator 30 bps, not 95.

Note what §3.1 and this paragraph say together: **at tier 0 the creator earns 15× what the LP earns
on the same trade, and above it, 4.75×.** Of the two supply-side roles the ecosystem offers, the
brief's H1 picked the one that is paid least.

### 4.2 The distribution, which is the thing the headline hides

The brief asks for the distribution rather than the totals, and it is right to. The best public
figures, from a Flipside-sourced analysis published by SolanaFloor:

| bucket | share of creators |
|---|---|
| under $100 | **34.9%** |
| $100 – $1,000 | 48.5% |
| **under $1,000 (cumulative)** | **83.4%** |
| $1,000 – $5,000 | 13.7% |
| $5,000 – $10,000 | 1.8% |

$3.07M distributed across 3,566 creators; top earner above **$104,000**, tenth-highest around
**$25,000**. A second independent snapshot gives $2,138,357 across 5,640 creators with the top 25
between **$19,483 and $78,482**. **[medium — Dune/Flipside-derived, published via trade press; the
underlying queries were not inspected.]**

### 4.3 Launch spike versus steady state

The brief is right to suspect the $2.1M/day headline. It was a step change from **$198,000 the
previous day**, and the first week reached $15.5M **[medium]**.

The steady state is checkable and is roughly the same size. DefiLlama's supply-side revenue for the
pump family — the portion of fees leaving the protocol to creators and LPs — is **$63.27M over 30
days, or $2.11M/day**. So the headline number is close to the *current daily run-rate for the whole
supply side*, not a one-off. The caution is that this pool is creators **and** LPs together and
DefiLlama does not split them; given §3.1's 30-vs-2 bps at tier 0 the creator share dominates, but the
exact split is an **unknown** and is recorded in §12.

### 4.4 The two activities, kept separate as the brief requires

The data distinguishes them cleanly, in one statistic. **Among the top 100 creators, the mean number
of tokens launched is 1,626 and the median is 10.**

- **The audience branch (median 10 launches).** A creator with genuine distribution launches rarely and
  earns from real trading interest. This is the durable and legitimate structure, and §2.2's Telegram
  finding — 1.485% versus 0.166% graduation, 8.94× — is the same fact from the other side. The input
  is an audience.
- **The volume branch (mean 1,626 launches).** Spraying launches monetises the arithmetic of the fee
  ladder rather than any one token. Where the deployer also holds the supply, the earnings come from
  retail buyers who lose, and §9.2 shows this shading into conduct with names and numbers attached.

**The brief asks which is durable and legitimate: the first, and only the first.** It is accessible to
this operator in the sense that anyone may launch a token — and it is bottlenecked on exactly the
asset the operator does not have, which is why it ranks where it does in §10.

| field | answer |
|---|---|
| **works?** | **Conditionally** — for the ~1.8% of creators above $5,000, driven by distribution. |
| **who runs it** | 3,566–5,640 creators per measured window; a documented top-100 with median 10 launches. |
| **realistic revenue** | Median creator: **under $1,000**. Top decile: low thousands. Top 1: ~$104,000. |
| **capital to start** | Negligible — a launch is cheap. |
| **infrastructure** | None. |
| **capacity** | The 0.95% band caps at ~$300k market cap; earnings decay as the token grows. |
| **what kills it** | No audience. Also a one-change-per-token cap on creator fee edits **[weak]**. |
| **accessible to this operator?** | Mechanically yes. Economically only with distribution the operator does not have. |
| **confidence** | **High** on the fee ladder (on-chain). **Medium** on the distribution (single analysis, one window). |
| **what would change it** | A creator-level panel over 6+ months separating launch-count strata; nothing public does this. |

---

## 5 — H3: CROSS-VENUE ARBITRAGE

**Verdict: NO, on this operator's own cost floor, before latency is even reached.**

The mechanism is real and enormous: arbitrage accounted for roughly **50% of Solana's average DEX
volume** in 2025, and cyclic arbitrage on aggregators grew from 2.5% of volume in mid-2024 to over 40%
by late 2025 **[weak–medium — secondary aggregations of Jito data]**. Over 90 million successful
arbitrage transactions cleared through Jito's detection in 2025 for **$142.8M** in combined profit
**[weak]**.

It is also decisively closed to this operator, and the reason is arithmetic rather than speed.

**The round trip is 250 bps at tier 0** (§3.1). A cross-venue arbitrage that touches a PumpSwap pool
pays 125 bps on that leg and whatever the other venue charges on the other. For the trade to clear it
must find a spread wider than roughly 250 bps *and* outbid competitors for inclusion — and searchers
are documented to pay **50–60% of expected profit in Jito tips** **[weak — vendor]**. A spread that
survives 250 bps of venue fee and then surrenders half the remainder is not a spread that persists
long enough for a participant who has ruled out latency infrastructure.

**What no reliable public data exists for:** I could not find a credible measurement of spread size or
persistence half-life across same-token Solana pools. Several vendor posts assert opportunities "for
seconds, minutes, or longer" with no method behind it. The academic work I located on arbitrage
persistence concerns Ethereum ZK rollups and Uniswap fee tiers, not Solana memecoin pairs. **This is
a stated unknown** (§12), not an estimate.

| field | answer |
|---|---|
| **works?** | **Yes for others, no for this operator.** |
| **who runs it** | Capitalised searcher firms; per §5, ~50% of DEX volume. |
| **realistic revenue** | $142.8M/yr across all searchers **[weak]**; per-participant distribution unknown. |
| **capital to start** | Inventory plus tip float. Not the binding constraint. |
| **infrastructure** | The binding constraint: co-located sending, Jito bundle submission, sub-100ms loops. |
| **capacity** | Compresses with competition — cited at 60% since 2023 **[weak]**. |
| **what kills it** | For this operator, the 250 bps floor. For everyone, tips at 50–60% of profit. |
| **accessible to this operator?** | **No** — excluded by a constraint the brief lists as fixed. |
| **confidence** | **High** that it is inaccessible; **low** on the revenue figures, which are all weak-sourced. |
| **what would change it** | A measured distribution of same-token spreads showing a persistent >250 bps band capturable at multi-second latency. No such measurement is public. |

---

## 6 — H4: SOLANA MEV

**Verdict: NO — accessible in principle, shrinking in practice, and the best-measured component is
smaller than its reputation.**

### 6.1 The size, and the direction

**Jito MEV Tips is the largest all-time application fee line on Solana after the chain itself:
$1,424M cumulative** (DefiLlama). That is the honest headline and it is why the hypothesis deserved
examination.

The direction is the problem. Monthly Jito MEV tips, computed:

| 2026-01 | 2026-02 | 2026-03 | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 (18d) |
|---|---|---|---|---|---|---|---|
| $10.1M | $5.9M | $4.0M | $3.4M | $3.8M | $2.7M | $3.3M | $2.2M |

**Down roughly 65% within 2026**, and — uniquely among the lines in §2.5 — it did **not** participate
in the July recovery. Aggregate searcher profits through Jito bundles are cited at **>$480M cumulative
by Q2 2026 with $30–50M monthly run-rates** **[weak — secondary]**, which is hard to reconcile with the
tip series above and is reported here only because the brief asks for the figures that circulate.

### 6.2 Sandwiching is better measured than it is understood, and it is smaller

The strongest source in this section is academic and it deflates the story. Gerzon, Weintraub, In,
Mislove and Nita-Rotaru, *Quantifying the Threat of Sandwiching MEV on Jito: A Measurement of Solana's
Leading Validator Client* (ACM IMC 2025), covering four months of early 2025, find:

- **over 500,000 sandwich instances** producing **over $7.7M in victim losses**;
- users spent **over $2.4M on defensive behaviour** that provided little benefit beyond preventing
  sandwiching;
- their conclusion: sandwiching is **relatively rare overall** relative to how widely it is
  anticipated, and the perceived threat exceeds the measured one.

$7.7M of victim loss over four months is a real harm and a small business. It sits against widely
circulated claims of $370M–$500M extracted over 16 months **[weak]** and a single bot, `arsc`, earning
$30M in two months **[weak, and dated June 2024]**. The measured figure and the circulated figures
differ by two orders of magnitude and the measured one has a method attached.

### 6.3 Access, and the reason access is not the point

**Jito's block engine is reachable without a validator relationship.** Searchers submit bundles by
gRPC to the `SearcherService`, which forwards to the validator service; bundles are up to five
transactions, atomic, ordered by tip (Jito documentation and `jito-labs/block_engine_simple`). So the
brief's specific question — *does Jito's architecture make any of this accessible without a validator
relationship* — has the answer **yes**.

It does not help. The competition is a latency auction settled in tips, which is the exact contest the
brief lists as permanently out of scope. Jito itself discontinued its mempool stream in 2024 precisely
to suppress sandwiching, which removes the informational substrate the strategy needs.

### 6.4 The ethical and reputational picture, as the brief requires

Backrunning and liquidation are ordinary market functions; JIT liquidity is contested but defensible.
**Sandwiching is different in kind: it extracts directly from an identifiable counterparty who is
worse off by exactly the amount extracted.** The IMC paper quantifies both the extraction and the
$2.4M users spend defending against it. Venues actively fight it, Jito has removed infrastructure to
suppress it, and pump.fun is currently a defendant in litigation alleging an "insider-rigged casino"
that names Solana Labs, the Solana Foundation, Jito Labs and the Jito Foundation **[medium — reported
litigation]**. **For a US-jurisdiction solo operator this is a bad trade on reputation and legal
exposure independent of whether it clears a hurdle rate, and it is not recommended at any expected
value.**

| field | answer |
|---|---|
| **works?** | **Yes for capitalised low-latency firms. No here.** |
| **who runs it** | Searcher firms via Jito bundles; ~95% of stake runs Jito-Solana **[medium]**. |
| **realistic revenue** | Tips: $1,424M all-time, **but $2.2M in the last 18 days**. Sandwiching: $7.7M victim loss / 4 months, measured. |
| **capital to start** | Inventory plus tip float; the honest floor is unpublished. |
| **infrastructure** | Co-located sending, gRPC streams, sub-100ms loops. Permissionless but not cheap. |
| **capacity** | Falling. See the 2026 series. |
| **what kills it** | Tips at 50–60% of profit; falling volume; protocol-level suppression. |
| **accessible to this operator?** | **No** — latency, and for sandwiching specifically, ethics. |
| **confidence** | **High** on the tip series (DefiLlama) and on the IMC measurement. **Low** on all searcher-profit figures. |
| **what would change it** | A non-latency-sensitive MEV niche with a measured margin after tips. None found. |

---

## 7 — H5: SELLING DETECTION RATHER THAN TRADING ON IT

**Verdict: NO as posed. The detection product is given away; the money next to it is in visibility
and infrastructure, which are different businesses.**

This is the hypothesis I most expected to survive, because the operator's stated assets map onto it
directly. It does not survive, and the reason is a market structure fact rather than a quality one.

**Rug and honeypot detection is free at the point of use, from multiple funded incumbents.** RugCheck
scans Solana tokens with no account and no wallet, and exposes a public REST API at
`api.rugcheck.xyz` with a per-developer key. TokenChecker covers Solana, Ethereum, BSC and Base free
and without signup. Sharpe offers rug-risk scoring free with REST, MCP and CLI access. A solo entrant
would be pricing against zero, held by parties with distribution.

**The adjacent businesses that do make money are not detection businesses:**

- **Selling visibility to token teams.** DEX Screener has taken **$139.1M in all-time fees, $4.04M in
  the last 30 days**, and is reported to make up to $250,000/day charging teams to update their token's
  branding and information **[medium]**. The customer is the token issuer, not the trader, and the
  product is placement.
- **Selling infrastructure to builders.** Helius prices at $49 / $499 / $999 per month with dedicated
  nodes from $2,900 **[protocol pricing page]**; Birdeye streaming starts around $250/month **[weak]**.
  This is a competent, crowded infra business with no relationship to a rug signal.

The overall API market is projected at $1.07B (2025) growing to $7.98B (2035) at 22.2% CAGR **[weak —
market-research vendor; such projections are routinely unfalsifiable and are quoted only because the
brief asks for market size]**.

**Is it saturated?** For detection sold to traders: effectively yes, at a price of zero. For
infrastructure: no, but the entrant competes on reliability and support, which is an operations
business, not a measurement one.

| field | answer |
|---|---|
| **works?** | **No** as "sell detection to traders". **Yes** as "sell visibility to issuers" or "sell infra to builders" — different products. |
| **who runs it** | RugCheck, TokenChecker, Sharpe (free); DEX Screener (visibility); Helius, Birdeye (infra). |
| **realistic revenue** | DEX Screener $4.04M/30d, $139.1M all-time. Detection tools: no public revenue; several appear unmonetised. |
| **capital to start** | Low — this is software. |
| **infrastructure** | Indexing and RPC, which is the actual cost and the actual moat. |
| **capacity** | Unknown for detection; the free tier suggests it is not a standalone market. |
| **what kills it** | Free incumbents with distribution. |
| **accessible to this operator?** | Buildable, yes. Sellable, no evidence. |
| **confidence** | **High** that detection is free at point of use (checked directly). **Low** on market size. |
| **what would change it** | One documented company selling rug/bundle detection as a paid product with disclosed revenue. I found none. |

---

## 8 — H6: REFERRAL, AFFILIATE, AND REBATE STRUCTURES

**Verdict: YES — and this is the only mechanism in the brief that clears every fixed constraint.**

### 8.1 The pool is large, and its size is computable rather than claimed

DefiLlama states that Axiom's revenue is calculated **after deducting referral and cashback payouts**.
Fees minus revenue therefore measures the payout directly:

| month | fees | revenue | **paid out to referrers + cashback** | payout share |
|---|---|---|---|---|
| 2026-01 | $42.51M | $24.34M | **$18.17M** | 42.7% |
| 2026-02 | $26.50M | $14.63M | $11.86M | 44.8% |
| 2026-03 | $25.32M | $13.56M | $11.76M | 46.5% |
| 2026-04 | $21.20M | $11.54M | $9.65M | 45.5% |
| 2026-05 | $22.69M | $12.26M | $10.43M | 46.0% |
| 2026-06 | $14.10M | $6.60M | $7.49M | **53.2%** |
| 2026-07 | $23.07M | $14.17M | $8.90M | 38.6% |
| 2026-08 (18d) | $19.61M | $11.95M | $7.65M | 39.0% |
| **all-time** | **$742.2M** | **$461.6M** | **$280.5M** | **37.8%** |

**One terminal has paid out $280.5M, and is currently paying $8–10M/month, to referrers and
cashback.** This is a single venue; GMGN, Trojan/Terminal, BullX, Photon and others run comparable
programmes.

The brief's Axiom claim checks out alongside it: cumulative revenue crossed **$200M on 2025-07-28,
190 days after the first revenue day of 2025-01-20** — against "in 202 days". Cumulative *fees*
crossed $200M in 147 days. Directionally verified.

### 8.2 The rates, and what volume is needed

Published rates cluster tightly: **20–40% of a referred user's fees**, typically with a 10–20% fee
discount to the referred user. Solana Tracker 25% for one year; OdinBot 40% lifetime; Bloom 25% direct
plus 3% second-tier; GMGN 25%. **[weak — bot and vendor documentation, exactly the category the brief
says to distrust; the rate range is nonetheless consistent across many independent operators and is
corroborated in aggregate by the 37.8% all-time payout share computed above, which is a primary
figure.]**

**The arithmetic that matters.** At a 1% platform fee and a 30% referral share, referred volume earns
you **30 bps**. To clear $3,000/month you must route **$1M/month** of somebody else's trading volume.
To clear $30,000/month, $10M/month.

**That is the whole hypothesis.** The mechanism is real, legal, capital-free, latency-free, and pays
promptly. What it requires is users, and users are acquired by distribution, not by measurement.

| field | answer |
|---|---|
| **works?** | **Yes.** $280.5M paid out by one venue, computed from DefiLlama's own accounting. |
| **who runs it** | Every major Solana terminal and bot; the recipients are content creators and community operators. |
| **realistic revenue** | 20–40% of referred fees. 30 bps of referred volume at typical terms. |
| **capital to start** | **Zero.** |
| **infrastructure** | **None.** A link. |
| **capacity** | Very high at the mechanism level; per-participant capacity is set by audience size, not by the venue. |
| **what kills it** | Rate cuts, programme termination, or the volume decline in §2.1 continuing. Payout share already swings 38.6%–53.2% month to month. |
| **accessible to this operator?** | **Yes, mechanically and legally — and the operator has no distribution, which is the entire input.** |
| **confidence** | **High** on the pool size (computed from a primary). **Medium** on individual rates (vendor-sourced). |
| **what would change it** | Nothing about the mechanism. The question is whether this operator can acquire an audience, which is outside what any of this evidence speaks to. |

---

## 9 — H7: WHAT THE LIST MISSES

### 9.1 Legitimate mechanisms not on the brief's list

**Being the interface.** This is the largest omission. The §2.5 table shows **fomo Wallet going from
$1.9M to $7.4M per month inside 2026**, and GMGN from $5.3M to $22.7M. The interface layer — wallets,
terminals, screeners, mobile apps — is where the toll is actually collected, and **it is still
admitting entrants**. It is a software business with no capital requirement and no latency
requirement. It is bottlenecked on the same input as H6 and H2.

**Payment for order flow.** DFlow runs PFOF auctions in which wallets route swap orders to a private
auction, market makers bid, and **the wallet receives a rebate**. Titan runs a solver-based RFQ model
with $30–50M/day of volume **[weak — secondary]**. This is the mechanism by which an interface with
users monetises them *twice*, and it is the strongest reason the interface layer is where the money
sits.

**The Solana Foundation's Frontier Traders programme**, launched 2026-06-17, bundles cross-venue
rebates, priority RPC and account support for qualified desks, explicitly targeting market makers and
HFT firms **[medium — reported, not read from a protocol page]**. Whether a solo operator can qualify
is an **unknown** (§12); the stated target is institutional.

**Liquid staking and validator operations.** Sanctum ($5.13M/30d) and Jito Liquid Staking ($3.03M/30d)
are fee-on-flow businesses with durable revenue. Both require capital or operations the brief's
constraints exclude.

### 9.2 Mechanisms that are profitable and are not legitimate, reported as the brief requires

**Deployer-funded same-block sniping.** Pine Analytics documents deployers funding their own sniper
wallets and giving them advance notice of launches: **over 15,000 launches affected, 1.75% of all
launch activity, over 4,600 sniper wallets and 10,400 deployers, 87% sniper profitability, 85% exiting
within five minutes, and over 15,000 SOL of realised profit in a single month** **[medium — on-chain
analysis by a named research shop, method described but queries not inspected]**. This is the single
most clearly documented *repeatable* profit mechanism found anywhere in this review. It is also
trading on your own undisclosed launch against buyers who do not know, and it is not proposed.

**Concentrated rug operations.** Twelve wallet clusters are reported to have engineered nearly a fifth
of all token creations while orchestrating **82% of liquidity drains, for ~$4.2M in exit-scam profits**
**[weak — secondary]**.

**Wash trading sold as a service.** "Volume bots" and "market maker bots" are openly marketed to token
teams at published prices — around **0.1 SOL per 100 makers plus gas**, with vendors advertising that
0.25 SOL per 1,000 makers produces ~$10K of volume — explicitly to push tokens into DexScreener
trending **[weak — vendor sites, which is the appropriate source for the fact that the service is
openly sold at a price]**. This is manufactured volume sold to issuers, it is the demand side of the
visibility revenue in §7, and in a US jurisdiction it is market manipulation.

**The prevalence backdrop.** Solidus Labs found **98.6% of more than seven million pump.fun tokens
fell below $1,000 in liquidity** — a **collapse threshold, not a finding of fraud**, and pump.fun
publicly disputed the characterisation. The distinction matters and the figure is frequently quoted
without it. A peer-reviewed treatment (Chen et al., *From Hype to Collapse: Investigating Rug Pull
Scams on Solana*, arXiv 2603.24625, June 2026) manually verified 117 rug pulls and identified 76,469
candidates among 100,063 tokens issued across three exchanges in H1 2025, separating hard rugs
(liquidity withdrawal and abandonment) from soft ones.

**Enforcement and litigation, current.** SDNY indicted Taj Tarsha of Few and Far Limited on 2026-08-05
for securities and wire fraud, alleging over **$10M raised from at least 67 investors** via SAFTs
covering ~95M FAR tokens, misappropriated for personal use. The TRUMP token is associated with
approximately **988,905 investors and over $3.81B in losses** to end-June 2026, down ~98% from peak,
with US senators calling for an SEC investigation. Meteora has been sued over an alleged pump-and-dump
launch, and pump.fun faces the "insider-rigged casino" action noted in §6.4. **[medium — law-firm
briefings and reported litigation.]**

**The useful conclusion from all of §9.2:** the most reliably profitable structures in this ecosystem
are the ones where the counterparty does not know what you know. That is a coherent explanation for
why nine phases of honest measurement found nothing — the edge that exists is largely an information
asymmetry that is manufactured rather than discovered, and manufacturing it is the part this operator
will not do.

---

## 10 — THE RANKED LIST

Ranked by expected value **for this operator specifically**: solo, US, no deployed capital, no latency
infrastructure, strong measurement and research capability, willing to build software.

| # | mechanism | accessible? | what specifically blocks it |
|---|---|---|---|
| **1** | **H6 — referral / affiliate on an existing terminal** | **Yes** | Nothing structural. **Distribution.** $280.5M has been paid out by one venue; capturing any of it requires an audience, and no amount of measurement capability produces one. |
| **2** | **H7 — be the interface (wallet / terminal / screener), monetised by fee + PFOF rebate** | **Yes, buildable** | Same block as #1, larger prize and much larger effort. fomo Wallet reached $7.4M/month, so entry is possible; but the input is users, not software. |
| **3** | **H2 — creator economics, audience branch only** | **Yes** | 83.4% of creators earn under $1,000. The 1.8% above $5,000 are distribution-led. Same bottleneck a third time. |
| **4** | **H5 — selling detection** | Buildable, not sellable | Priced at **zero** by funded incumbents with distribution. The revenue nearby is visibility-to-issuers and infra-to-builders, neither of which is this operator's stated asset. |
| **5** | **H7 — selling tooling / visibility to token teams** | Yes | Real revenue ($4.04M/30d at DEX Screener), but the customer base substantially overlaps §9.2. Excluded on conduct, not on economics. |
| **6** | **H3 — cross-venue arbitrage** | **No** | The **250 bps tier-0 round trip**, before latency. Then tips at 50–60% of profit. Excluded by a constraint the brief lists as fixed. |
| **7** | **H4 — MEV** | **No** | Latency auction settled in tips; revenue down ~65% within 2026; the best-measured component (sandwiching, $7.7M/4mo) is small and ethically excluded. |
| **8** | **H1 — liquidity provision** | Yes, and should not be | **Falsified.** LP takes 2 bps of a 125 bps fee at tier 0; LP−HODL is −0.278% in under an hour on the operator's own 377 pools; LVR runs at σ²/8 and does not care that drift is zero. |

### The shape of that list, stated plainly

**The list is short, the top three entries are the same entry, and none of them is a measurement
business.**

Every mechanism that pays durably in this ecosystem is a toll on flow. Collecting a toll requires
owning one of exactly two things: **the flow** (an audience, users, distribution) or **the
infrastructure it must cross** (latency, a validator relationship, an indexing stack). The operator
has explicitly and permanently ruled out the second. The first is not something the apparatus
produces, and — this is the uncomfortable part — **fifteen months of measurement infrastructure does
not advance the operator one step toward it.**

That is the honest ranked answer and it is a null of the informative kind. It does not say no
accessible mechanism exists. It says **exactly one does, it is legal and capital-free, and its input
is the one asset this programme has not been building.**

The brief asked to be told plainly if the top entries are all inaccessible. They are not
inaccessible — #1 through #3 are all mechanically available today, at zero capital, from a US
jurisdiction. They are **unbuilt**, which is a different and more tractable problem than blocked. What
they are not is a use for the measurement apparatus.

---

## 11 — WHAT THIS PHASE COST, AND WHAT IT SPENT THAT WAS NOT CREDITS

**Dune credits: 0.** The ~500 remaining are untouched. Nothing in the brief required a query that the
public APIs or the local corpus could not answer.

**It spent a small amount of the programme's discipline instead, and that is recorded.** The H1
measurement in §3.2 was run *before* its rule was written to the ledger, inverting the order every
prior phase has kept. MT099 carries it as `exploratory` with the direction of bias stated: every
discretionary choice in it flatters the hypothesis, so the negative result is an upper bound rather
than a point in a range. It is not decision-bearing and no gate is calibrated on it.

**No `pnpm check` regression is claimed here** because no source file was changed. The report, the
transcribed directive, the ledger row and one artifact are the whole diff.

---

## 12 — STATED UNKNOWNS

The brief asks that gaps be named rather than filled with plausible reasoning. These are the gaps.

1. **Memecoin LP returns beyond one hour.** §3.2 covers ≤59 minutes on two days. The total-loss tail
   the brief correctly identifies as the real risk is **not observed at all**. No public dataset,
   dashboard or study decomposing memecoin LP returns into fees / IL / total loss was found. The
   nearest academic work is on ETH pairs and a $3,000 Polygon stable pair.
2. **The creator/LP split inside DefiLlama's supply-side revenue.** §4.3's $2.11M/day is creators and
   LPs pooled. The split is inferable from the fee ladder but is not published.
3. **Spread size and persistence across same-token Solana pools.** No credible measurement found
   (§5). Vendor claims exist and are not usable.
4. **Per-participant MEV profit distribution.** Aggregate figures circulate; the distribution across
   searchers does not, and the $480M cumulative searcher-profit figure does not reconcile with the
   Jito tip series in §6.1.
5. **A SOL-denominated daily Solana fee series from a primary source** (§2.4). Only a statistics site
   was found.
6. **Whether a solo operator can qualify for Frontier Traders** (§9.1). The stated target is
   institutional desks; eligibility criteria were not read from a protocol page.
7. **Detection-product revenue.** No company was found publishing revenue for rug/bundle detection
   sold as a paid product. Its absence is suggestive but is not proof that none exists.
8. **The perps-rotation claim** (§2.5) was not independently verified and is not relied on anywhere.

---

## SOURCES

**Computed from primary APIs (retrieved 2026-08-19).** DefiLlama: [Solana DEX overview](https://api.llama.fi/overview/dexs/solana) · [Solana fees & revenue overview](https://api.llama.fi/overview/fees/solana) · [pump fees](https://api.llama.fi/summary/fees/pump) · [Axiom fees](https://api.llama.fi/summary/fees/axiom) · [Jito MEV Tips](https://api.llama.fi/summary/fees/jito-mev-tips) · [GMGN](https://api.llama.fi/summary/fees/gmgn) · [fomo Wallet](https://api.llama.fi/summary/fees/fomo-wallet) · [DEX Screener](https://api.llama.fi/summary/fees/dex-screener). Weekly and monthly aggregations are mine.

**Local corpus.** `data/runtime.db` — `trajectory_marks` × `development_trajectories`. Artifact: `artifacts/lp-vs-hodl-pumpswap.json`. In-repo corroboration: `docs/MECHANICS_FLOOR_MEASURED.md`, `docs/PHASE_G_REPORT.md` §4.1, `packages/solana/src/fee-tiers.ts`.

**Academic.** [Milionis, Moallemi, Roughgarden & Zhang, *Automated Market Making and Loss-Versus-Rebalancing* (arXiv 2208.06046)](https://arxiv.org/abs/2208.06046) · [a16z, *LVR: Quantifying the Cost of Providing Liquidity*](https://a16zcrypto.com/posts/article/lvr-quantifying-the-cost-of-providing-liquidity-to-automated-market-makers/) · [Melnikov et al., *From Impermanent Loss to Sustainable Gain* (arXiv 2604.28014)](https://arxiv.org/pdf/2604.28014) · [*Impermanent Loss in Uniswap v3* (arXiv 2111.09192)](https://arxiv.org/abs/2111.09192) · [*Risks and Returns of Uniswap V3 Liquidity Providers* (arXiv 2205.08904)](https://arxiv.org/pdf/2205.08904) · [Kamat, *Pump.fun Graduation Regime Windows* (arXiv 2607.02823)](https://arxiv.org/html/2607.02823) · [Gerzon, Weintraub, In, Mislove & Nita-Rotaru, *Quantifying the Threat of Sandwiching MEV on Jito* (ACM IMC 2025)](https://dl.acm.org/doi/10.1145/3730567.3764493) · [Chen et al., *From Hype to Collapse: Investigating Rug Pull Scams on Solana* (arXiv 2603.24625)](https://arxiv.org/pdf/2603.24625)

**Protocol documentation.** [Liquidity on PumpSwap](https://intercom.help/pumpfun-web/en/articles/11002417-liquidity-on-pumpswap) · [Jito low-latency transaction send](https://docs.jito.wtf/lowlatencytxnsend/) · [jito-labs/block_engine_simple](https://github.com/jito-labs/block_engine_simple) · [RugCheck](https://rugcheck.xyz/) · [Helius pricing](https://www.helius.dev/pricing) · [Meteora docs](https://docs.meteora.ag/)

**Analysis and trade press (graded inline).** [Pine Analytics, *Exit Liquidity Machines*](https://pineanalytics.substack.com/p/exit-liquidity-machines) · [SolanaFloor, *Pump.fun's Creator Revenue Sharing: Reality vs. Hype*](https://solanafloor.com/news/pump-fun-s-creator-revenue-sharing-reality-vs-hype) · [The Token Dispatch, *Meteora's Margin Story*](https://www.thetokendispatch.com/p/meteoras-margin-story) · [The Block, *Pump.fun graduation rate jumps after BOOST*](https://www.theblock.co/amp/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives) · [CoinDesk, *98% of tokens on Pump.fun...*](https://www.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says) · [Lowenstein Sandler, *Crypto Brief, August 6, 2026*](https://www.lowenstein.com/news-insights/newsletters/crypto-brief-august-6-2026) · [CCN, *Senators call on SEC to investigate Trump memecoin*](https://www.ccn.com/news/crypto/senators-sec-probe-trump-memecoin-investor-losses/) · [Decrypt, *Meteora sued over alleged pump-and-dump*](https://decrypt.co/315860/solana-dex-meteora-sued-alleged-pump-dump-meme-coin-launch) · [Benedict Brady, *Payment for Order Flow on Solana*](https://www.benedict.dev/pfof-on-solana) · [CryptoSlate, *Solana is subsidizing high-volume traders*](https://cryptoslate.com/solana-is-subsidizing-pro-trading-flow-before-on-chain-markets-prove-it-will-stay-there/) · [Solana Compass fee statistics](https://solanacompass.com/statistics/fees) · [CoinCodeCap, *Telegram trading bot referral programmes*](https://coincodecap.com/all-telegram-trading-bot-referral-programs-listed) · [Smithii volume bot pricing](https://smithii.io/en/solana-volume-bot/)
