# DECOMPOSE THE LP RESULT

**State: `MECHANISM_FAILS_AT_ANY_FEE_SHARE`.**

**Directive:** `docs/directives/DIRECTIVE_40C005FF_DECOMPOSE_THE_LP_RESULT.md`, transcribed and
committed before execution (`327e340`).
**Predecessor:** PR #66, `FEE_ON_FLOW_SURVEYED`, SHA `2b9c1ca`.
**Ledger:** MT100. It also carries the correction to MT099 described in §0.
**Credits: 0**, as the directive requires. No Dune query was created, run, or paid for. §1.1 states
what the directive expected to exist, what actually exists, and why a query was still not needed.
**Reproducible:** `pnpm lp:decompose` → `scripts/lp-decomposition.ts` → `artifacts/lp-decomposition.json`.
**`MEASUREMENT_ONLY`.** No mode changed, no gate moved, no wallet funded, nothing signed.

---

## 0 — THE ONE-LINE ANSWER, AND A CORRECTION TO #66 THAT MAKES IT WORSE

**The fee term is 0.0077% and the LVR term is 0.3612%. LVR is 47× fee income. The LP would need
to be paid 93.7 bps of every trade to break even, against the 22 bps that Raydium AMM v4 actually
pays and the 125 bps that is the entire PumpSwap fee across all three recipients. No observed
venue's fee share closes the gap, and that is the state.**

The directive was right that −0.278% was a difference of two unseparated terms. It turns out not to
matter which venue pays, because the two terms are not the same order of magnitude — separating
them does not produce a close call that a better fee share could tip. **Rescaling the fee term by
10.5×, from PumpSwap's 2 bps to Raydium CPMM's 21 bps, moves the pooled figure from −0.353% to
−0.280%. It closes 21% of the gap.**

**And a correction, which runs against the hypothesis.** In auditing my own #66 numbers I found an
error in them. `observed_quote_reserve` is `quoteReserveRaw + virtualQuoteReserves`, and decoding
the stored pool bytes shows `virtualQuoteReserves` is **17.5845 SOL on every one of the 142 pools it
could be read for** — near-constant because every pump.fun token graduates at the same threshold.
The AMM prices on that combined quantity, but **an LP can only ever withdraw the real vault**. #66
took LP capital to be `2q`, which includes 17.58 SOL of liquidity nobody owns. The correct base is
`2q − v`, which is smaller, so every loss in #66 was divided by a denominator **1.27× too large**:

| stratum | #66 reported | corrected |
|---|---|---|
| all clean pools | −0.278% | **−0.353%** |
| pools that moved | −0.546% | **−0.694%** |
| pools moving >10% | −1.674% | **−2.123%** |

#66 understated the loss. The direction of the error flattered the hypothesis, and it is corrected
here rather than left standing.

---

## 1 — SEPARATING THE TWO TERMS

### 1.1 There is no trade tape, and a Dune query was still not needed

The directive says everything runs on `trajectory_marks` **and the stored trade tape**, and to stop
and report if a step appears to need a Dune query. Two facts about the corpus:

- **`targeted_flow_events` — the per-trade table with `quote_lamports` — is empty. 0 rows.**
  `targeted_flow_bars` is also empty.
- **`chain_events` (356,027 rows) covers 2026-08-14T04:00Z to 2026-08-14T10:04Z only.** These
  trajectories are 2026-08-17 and 2026-08-18. **Zero overlap**, and it carries no amount field
  anyway — only `kind`, so it is a trade counter, not a volume meter.

So the stored tape cannot supply `V`. **I did not stop, because the number really was already held,
in a form the directive did not anticipate: the invariant is itself a volume meter.**

On a constant-product pool the LP fee that stays in the vault makes `k = b·q` grow, at
`Δk/k = f·Δq/q` per trade. Summed over a window that gives `V/q = (κ−1)/f` with `κ = k₁/k₀`. Volume
is therefore recoverable from the reserve path alone.

**That the LP fee accrues at all is measured, not assumed.** Across the 623 steps where the price
moved, `k` **grew in 99.0% and shrank in 1.0%**. A pure constant-product pool with every fee routed
out would conserve `k`; this one does not, and the growth is the fee.

### 1.2 The retained rate is recovered from the path, not taken from the decoder

The volume identity needs `f`. Rather than assume the decoded 2 bps, it is recovered independently.
Since net quote flow between marks is a **lower** bound on gross volume, `φ_upper = (κ−1)·q/|Δq|` is
an **upper** bound on the retained rate, and it is tight exactly on steps holding one directional
trade. Over 617 steps:

| p10 | p25 | p50 | p90 |
|---|---|---|---|
| **1.9958 bps** | **2.0064 bps** | 2.2312 bps | 73.26 bps |

**The distribution floors hard at 2 bps and nothing lies below 1 bp.** That floor is the
single-trade steps, and it recovers the decoded `lpFeeBps = 2` from the reserve path alone. The
upper tail is steps containing round trips, where net flow understates gross. The decoder and the
chain agree.

A second check: per pool, volume implied by the invariant versus summed net flow has p10 **1.002**,
median 1.320, p90 11.14 — **always ≥ 1**, as physics requires, since gross volume cannot be below
net flow. And end-to-end `κ` matches the step-summed value to 1.0000 at every decile.

### 1.3 The decomposition, which is exact

With `r = p₁/p₀`, `κ = k₁/k₀`, `A₀ = 2q₀ − v`, and `q = √(k·p)`:

```
LP − HODL = q₀·[2√(κr) − r − 1] / A₀

2√(κr) − r − 1  =  2√r·(√κ − 1)   −   (√r − 1)²
                   └─── fee ───┘       └── LVR ──┘
```

so

```
fee_income  = q₀·2√r·(√κ − 1) / A₀
LVR_implied = q₀·(√r − 1)²    / A₀      ≥ 0 always, quadratic in the move, no drift term
```

`LVR_implied` is **backed out of the measured path**, as the directive requires — the σ²/8 formula
is not used to produce it. That the second expression *is* σ²/8 in discrete form is a consequence
of the algebra, not an input, and it is the cleanest possible statement of why drift was never the
relevant variable: the LVR term depends on `(√r − 1)²`, which is positive whichever way the price
went.

### 1.4 The turnover distribution — the finding, before any rescaled figure

The directive asks for this first and says it is the finding whichever way it runs. `V/L` over the
window, `L = A₀`:

| stratum | n | p10 | **p50** | p90 | mean |
|---|---|---|---|---|---|
| all clean pools | 377 | 0.000000 | **0.000038** | 0.389620 | 0.358548 |
| pools that moved | 192 | 0.000682 | **0.053634** | 0.849056 | 0.704025 |
| pools moving >10% | 61 | 0.078507 | **0.313092** | 1.566987 | 1.826732 |

**The median pool turns over 0.0038% of LP capital in the hour.** Half of these pools are inert;
the 90th percentile pool turns over 0.39× its capital.

Set against what break-even requires — `LVR / f`:

| stratum | needed @ 2 bps | needed @ 21 bps | needed @ 22 bps | **observed p90** |
|---|---|---|---|---|
| all clean pools | 18.06× | **1.72×** | 1.64× | **0.390×** |
| pools that moved | 35.46× | 3.38× | 3.22× | 0.849× |
| pools moving >10% | 108.15× | 10.30× | 9.83× | 1.567× |

**Even at Raydium's fee share, even at the 90th percentile of activity, turnover is 4.4× short.**
That ratio is the whole result, and §3 is the same statement in a different unit.

### 1.5 The two terms, separated

Pooled means, as a fraction of LP capital, over a window of at most 59 minutes:

| stratum | n | **fee_income** | **LVR_implied** | net (corrected) | net (#66 convention) | σ_hour p50 | closed-form LVR | cf / backed-out |
|---|---|---|---|---|---|---|---|---|
| all clean pools | 377 | **0.0077%** | **0.3612%** | −0.3534% | −0.2779% | 0.0001 | 0.3447% | 0.954 |
| pools that moved | 192 | **0.0151%** | **0.7091%** | −0.6940% | −0.5457% | 0.0926 | 0.6769% | 0.954 |
| pools moving >10% | 61 | **0.0397%** | **2.1630%** | −2.1233% | −1.6739% | 0.2926 | 1.9170% | 0.886 |

**LVR is 47× fee income on all clean pools, 47× on pools that moved, and 54× on the pools that
moved most.** The ratio is stable across strata because dead pools contribute exactly zero to both
terms and therefore cannot move it.

**Closed-form consistency check, reported as the directive requires.** The σ²/8 value sits at 95.4%
of the backed-out LVR on the first two strata and 88.6% on the third — the closed form
**understates**, by 4.6% and 11.4%. The discrepancy has an expected sign and cause: realised
variance computed from seven marks undersamples the true quadratic variation of the path, and it
undersamples worse where the path moved more. The model and the measurement agree to within the
resolution of the mark grid, and the measurement is the one used.

---

## 2 — RESCALING THE FEE TERM ONLY

`LP_HODL(f) = (f / 0.0002) × fee_income − LVR_implied`, pooled means, share of pools clearing zero
in brackets:

| f | venue | all clean pools | pools that moved | pools moving >10% |
|---|---|---|---|---|
| **0.0002** | PumpSwap tier 0 *(measured)* | **−0.353%** (8.0%) | −0.694% (15.6%) | −2.123% (1.6%) |
| **0.0021** | Raydium CPMM / CLMM, 84% of 0.25% | **−0.280%** (17.0%) | −0.550% (33.3%) | −1.746% (4.9%) |
| **0.0022** | Raydium AMM v4, 0.22% of 0.25% | **−0.276%** (17.5%) | −0.543% (34.4%) | −1.726% (4.9%) |

**A 10.5× increase in the LP's fee share closes 21% of the gap.** The share of pools that clear
zero roughly doubles, from 8.0% to 17.5%, and it is still fewer than one pool in five.

### 2.1 The tier-0 reproduction check

The directive makes this the correctness check on the whole decomposition, and it needs care to
report honestly, because two different things could be meant by it.

**It passes, in the form that matters.** Evaluated under #66's own convention — the `2q`
denominator — the decomposition returns **−0.2779%, −0.5457% and −1.6739%** across the three
strata, against #66's reported **−0.278%, −0.546% and −1.674%**. All three reproduce to the digit.
That is a real check: the decomposition was built from the invariant and the price ratio, and it
lands on numbers computed in #66 by a completely different route.

**It does not reproduce −0.278% under the corrected convention, and should not.** It returns
−0.353%, because −0.278% was wrong (§0). The directive could not have known that, and the check it
specified is what surfaced it.

**What the check is not.** `fee_income − LVR_implied = LP − HODL` holds to **2.985e−16** across all
377 pools, but that is an algebraic identity, not corroboration — the two terms were derived by
splitting that exact expression. The identity confirms the arithmetic is right; the #66
reproduction above is what confirms the decomposition is right.

`DECOMPOSITION_FAILED` is therefore **not** the state.

### 2.2 The break-even fee share

The single number this all reduces to. `f* = 0.0002 × LVR_implied / fee_income`:

| stratum | pooled f* | per-pool median f* |
|---|---|---|
| all clean pools | **93.7 bps** | 82.3 bps |
| pools that moved | **93.7 bps** | 82.3 bps |
| pools moving >10% | **108.8 bps** | 325.9 bps |

For scale: **Raydium AMM v4 pays the LP 22 bps. Raydium CPMM/CLMM pays 21 bps. The entire PumpSwap
fee, across LP and protocol and creator together, is 125 bps.**

An LP in this population would need roughly **four and a quarter times the best fee share any of
these venues offers**, or about **three quarters of the whole PumpSwap fee routed to the LP alone**,
merely to stop losing to a passive holder. That is not a fee schedule that exists, and it is why the
state is `MECHANISM_FAILS_AT_ANY_FEE_SHARE` rather than a call for a better venue.

---

## 3 — THE INTERVAL PROBLEM, RESTATED IN FULL

The directive requires this be restated in the same words. It is quoted rather than paraphrased:

> MT099 recorded that #66's 377 trajectories fall on two days, so a day-clustered resample has two
> clusters and only the point estimate stands. That limitation carries forward in full. This
> directive changes the fee coefficient, not the sample. Every figure produced here inherits the
> same defect and the report must say so in the same words.
>
> **A rescaled point estimate on two clusters is a hypothesis worth testing, not a result. Label it
> that way.**

It is labelled that way. The days are **2026-08-17 and 2026-08-18** — the same two, unchanged. No
figure in §1.4, §1.5, §2 or §2.2 is a result. **Every one of them is a point estimate on two
clusters.**

One asymmetry is worth naming, and it is the only reason a state is claimed at all. The two-cluster
defect bounds how precisely the gap is known; it does not plausibly account for a **47× ratio**
between the two terms, or for a break-even fee share **4.25× above the best on offer**. A sampling
defect that could reverse a 47× ratio would have to be a different order of problem than two
clusters. The state is claimed on the size of the gap, not on the precision of it.

---

## 4 — WHAT THIS CANNOT SETTLE

The directive lists four limits and requires they be said. All four stand, and none is weakened by
the result:

- **The population is wrong.** These are PumpSwap pools. Raydium CPMM pools are LaunchLab and
  Bonk.fun graduations — a different population with different volatility and turnover. The
  rescaling asks whether the mechanism *could* clear at a normal fee share, not whether it *does* on
  the venue that pays it. **This cuts both ways and the negative result does not escape it**: a
  venue whose pools turn over 20× faster would produce a different answer, and nothing here observed
  such a venue.
- **Two days.** See §3.
- **Entry and exit are unpriced.** Becoming and ceasing to be an LP has its own cost, unmeasured.
  It can only make the figures worse.
- **Total loss is not IL.** A pool whose token dies leaves the LP holding it. #66's worst case was
  −21.30% at a −87.9% move; the tail is the risk, and rescaling a fee term does not touch it. This
  report measures one hour and observes no deaths.

**One limit the directive did not list, which this phase found.** The `v` correction in §0 depends
on `virtualQuoteReserves` being constant across each window. It is read once per pool from stored
bytes, and the manifests show the pool account unchanged across the six captures they hold, but it
is not observed at every mark. If `v` moved during a window the correction is approximate. The
invariant test in §1.2 — conservation to 6.6e−6 on `raw + virtual` against 9.1e−3 on `raw` alone,
three orders of magnitude — is strong indirect evidence that it did not.

The directive says that if §2 comes back positive the honest next step is a new measurement on
actual Raydium CPMM memecoin pools over more than two days, not a conclusion. **§2 did not come back
positive**, so that measurement is not owed. What would be owed, if anyone wanted to reopen this, is
a population with 20× the turnover — and the burden is on finding one, not on assuming it exists.

---

## 5 — THE STATE

**`MECHANISM_FAILS_AT_ANY_FEE_SHARE`** — *fee income is too small relative to LVR for any observed
split to close it; LP closes for good.*

The three candidate states and why the other two are not claimed:

- **`MECHANISM_CLEARS_AT_NORMAL_FEE_SHARE`** — not claimed. At the best observed LP share, 22 bps,
  the pooled figure is −0.276% and 82.5% of pools still fail to clear zero.
- **`DECOMPOSITION_FAILED`** — not claimed. §2.1: the decomposition reproduces #66's −0.278%,
  −0.546% and −1.674% to the digit under #66's own convention.
- **`MECHANISM_FAILS_AT_ANY_FEE_SHARE`** — claimed, on a break-even fee share of 93.7 bps against a
  best available share of 22 bps, and on a turnover distribution whose 90th percentile is 4.4× short
  of what break-even needs at that share.

**What the state does not mean.** It does not mean liquidity provision loses money everywhere. It
means that **on this population, at this turnover, no fee share any of these venues offers is within
a factor of four of covering the LVR**, and that the gap is a turnover problem rather than a fee
problem. A venue that paid the LP the entire 125 bps of PumpSwap's fee would still not clear it.

`LP closes for good` is the directive's own phrase and it is adopted. The hypothesis has now been
wrong on the fee split, wrong on the theory, and wrong on the magnitude, and the magnitude is the
one that cannot be repaired by choosing a better venue.

No mode changed, no gate moved, no wallet funded, nothing signed. `MEASUREMENT_ONLY`.
