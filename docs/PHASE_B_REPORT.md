# PHASE B — FEE TIER AND CONDITIONAL MEAN

**Directive:** `epitaxy_3f8f840b_phase_b_conditioning_directive.md` (delivered as
`3f8f840b-epitaxy_phase_b_conditioning_directive.pdf`, 2026-08-18)
**Predecessor:** `docs/D70B4A9A_FINAL_REPORT.md`, final state `MEASUREMENT_REPAIR_REQUIRED`
**Final state:** `NO_DECIDABLE_CELL`

No new collection. No network call — the fee config was decoded out of stored
account bytes, so not even the one call the directive permitted was made. No
purchases. Nothing signed, submitted or funded. No window opened.

---

## 0 — THE SHORT VERSION

Phase B asked whether a conditional mean exists that makes the experiment
decidable. It found one, and then found out who owns it.

**A market-cap crossing produces a conditional mean of +193% to +341% at the
60-minute mark — on a population this system cannot enter.** A fee tier is a
property of a PumpSwap *pool*. 276 of 158,085 snapshotted mints ever migrated. Of
the 4,580 mints that fire the 420-SOL trigger, **26 had a pool at the moment the
trigger fired**: 0.57%. Restricted to those, the same trigger's conditional mean
is **−73.2%**.

The sign flips on every trigger, at every tier, under both exit rules:

| population | T0 baseline | T1 (420 SOL) | T2 (1,470 SOL) | tier 0 | tier 1 | tier 2 |
|---|---|---|---|---|---|---|
| all snapshotted | +3.3% | +193.2% | +324.9% | −0.03% | +79.4% | +482.3% |
| **migrated at entry** | **−65.7%** | **−73.2%** | **−28.2%** | **−60.2%** | **−94.9%** | **−98.7%** |

And it is corroborated by the one measurement in the corpus that is not a mid
price: the collector's **own executable marks**, on 455 trajectories its risk
gates admitted, are −2.7% at the median and −17.4% at the mean 60 minutes after
entry, with a 10th percentile of −69.6%.

Three consequences.

1. **`NO_DECIDABLE_CELL`.** 720 cells examined, 549 evaluable, 360 of them in the
   tradable population. **81 of the 270 evaluable tradable cells carry a positive
   point estimate net of their own cost floor, and zero of them survive a
   day-clustered lower bound.** Nothing is decidable: 72 cells clear the 120-day
   calendar and none of those has a positive lower bound. A family this size should
   have thrown up ~13 accidental passes at α = 0.05; the lower bound killed all 81.
   That is D70B4A9A's pattern repeating exactly — four of 36 there, 81 of 270
   here.
2. **The tier thesis is confirmed on the cost side and it is not enough.** The
   floor falls monotonically — 2.669% at tier 0, 2.469% at tier 1, 2.350% at
   tier 2, 1.025% at tier 16 — and depth rises with it, which matters more: a
   tier-0 pool cannot take 0.50 SOL under the frozen bounds and a tier-8 pool can
   take 1.00. None of that helps when the conditional mean is negative.
3. **D70B4A9A's one surviving result is retro-qualified.** Its +3.04% cohort mean —
   the four-of-36 cells that cleared the cost floor there — is a property of
   pre-migration bonding-curve tokens. On the migrated population, over the same
   window, the same measurement is −65.7%.

---

## 1 — FEE TIER DECODE, FINGERPRINT, AND THE 2026-04-28 SHAPE CHANGE

`pnpm tier:decode` → `artifacts/fee-tier-schedule.json`

**413 of 413** stored fee-config accounts decoded, 0 missing, 0 undecodable.
**One schedule across the whole corpus** — hash `5464ad69e325282f`, account
discriminator `8f3492bbdb7b4c9b`, single-valued from 2026-08-17T12:49Z to
2026-08-18T23:58Z. That result is what licenses pooling the corpus at all: a
republished fee table is a regime change, and two hashes here would have
invalidated every surface below.

25 tiers, matching the directive's description exactly:

| tier | market cap ≥ | one way | round trip | | tier | market cap ≥ | one way | round trip |
|---|---|---|---|---|---|---|---|---|
| 0 | 0 SOL | 125 bps | **250 bps** | | 8 | 19,650 | 85 | 170 |
| 1 | 420 | 120 | 240 | | 10 | 29,470 | 75 | 150 |
| 2 | 1,470 | 115 | 230 | | 13 | 44,210 | 60 | 120 |
| 3 | 2,460 | 110 | 220 | | 16 | 58,940 | 50 | 100 |
| 4 | 3,440 | 105 | 210 | | 20 | 78,590 | 40 | 80 |
| 5 | 4,420 | 100 | 200 | | 24 | 98,240 | 30 | **60** |

Flat (non-tiered) fallback: lp 25 / protocol 5 / creator 0 = 30 bps.

The corpus's own pools sit where the directive said: **393 of 413 snapshots in
tier 0**, 12 in tier 1, 2 in tier 2, and 6 scattered as high as tier 24. Median
market cap 29.6 SOL, range 17.8 to 192,854. So "the entire corpus is in the most
expensive bucket" is 95% right rather than 100%, and the exceptions matter because
they are the only empirical evidence about the other tiers.

### Fingerprint

```text
fee config account   5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx
schedule hash        5464ad69e325282f…  (tiers + flat, one value over 413 snapshots)
discriminator        8f3492bbdb7b4c9b   (one value over 413 snapshots)
SDK versions         @pump-fun/pump-swap-sdk 1.19.0, @pump-fun/pump-sdk 1.36.0
programs             5 per snapshot manifest, each with its ProgramData ELF hash
capability prints    5 distinct across the corpus
```

Every program's ELF hash is recorded per pubkey with its occurrence count, so a
program upgrade inside a future corpus is detectable rather than assumed away.

### The 2026-04-28 shape change: **no stored build predates it**

Verdict `CURRENT_INSTRUCTION_SHAPE`, on two independent grounds:

- **By date.** The earliest stored account plan is 2026-08-15T06:42Z and the latest
  2026-08-18T23:58Z. Builds predating the upgrade: **0**.
- **By rebuild.** The corpus holds six distinct swap shapes — buy with 25, 26 and
  27 accounts, sell with 23, 24 and 26 — and interleaved on the same days, so they
  are per-mint variation (cashback accumulator, creator vault) rather than a
  version boundary. **All six** were rebuilt through the pinned SDK against their
  own stored snapshots, and every one reproduced its stored account count.

Fingerprints differ between stored and rebuilt legs — on five of the six in the
first run and on **six of six** when the whole pipeline was re-run at a later
commit. That is expected rather than a failure, and the instability is the point:
the SDK picks a fee recipient out of a list at build time, so `fingerprintsMatch`
is a coin flip per leg and must never be a verdict input. The *shape* — the account
count and the position of every derived account — matched **6 of 6 in both runs**,
and the shape is what the upgrade changed. Nothing is marked
`STALE_INSTRUCTION_SHAPE`.

---

## 2 — TIER × AGE, WITH ARRIVALS PER DAY

`pnpm tier:assign` → `artifacts/tier-assignment.json`

627,876 of 837,875 snapshots assigned a tier. 209,999 carry no provider `mcap` at
all and are excluded rather than defaulted to the bottom tier.

### The cross-check that had to pass first

The tier is selected from `effectiveQuoteReserve × baseMintSupply / baseReserve`,
which needs pool reserves — available for 413 snapshots. The assignment across
112,584 mints is therefore made from the provider's USD market cap over the
derived SOL/USD series, and the two were compared on the 129-snapshot overlap:

```text
provider market cap / program market cap    p10 0.961   p50 1.000   p90 1.050
the same tier is selected on                98.4% of 129 pools
```

Had that come out at 2× or 0.5×, every tier in this report would have been a
different quantity wearing the tier's name.

### Distinct mints per cell (snapshots in brackets)

| tier | <2m | 2m–60m | 1h–5h | 5h–24h | 24h–7d |
|---|---|---|---|---|---|
| 0 | 65 (81) | 114,537 (408,266) | 52,828 (67,599) | 45,543 (69,129) | 53,630 (70,439) |
| 1 | — | 3,017 (5,102) | 187 (497) | 145 (897) | 171 (203) |
| 2 | — | 960 (1,284) | 76 (176) | 41 (93) | 37 (40) |
| 3 | — | 298 (361) | 22 (29) | 11 (13) | 9 (11) |
| 4–6 | — | 1,603 (2,735) | 43 (82) | 30 (47) | 28 (30) |
| 7–24 | — | 293 (400) | 42 (146) | 29 (75) | 9 (9) |

### The question the directive asked, answered

Of **118,655** mints with a tier inside the 2m–60m window:

| reaches | mints | fraction | median per day |
|---|---|---|---|
| tier ≥ 1 (≥420 SOL) | 4,715 | **3.97%** | 646 |
| **tier ≥ 2 (≥1,470 SOL)** | **2,004** | **1.69%** | **273** |
| tier ≥ 3 | 1,438 | 1.21% | 193 |
| tier ≥ 6 (≥9,820 SOL) | 701 | 0.59% | 83 |

In the 1h–5h band the same figures collapse by an order of magnitude — tier ≥ 2 is
170 mints, 0.32% — so whatever the tier trigger selects, it selects it in the first
hour.

**The number that is not in that table, and matters more: of those 118,655 mints,
201 ever had a PumpSwap pool.** See §5.

---

## 3 — COST FLOOR PER TIER, AND THE CROSSOVER NOTIONAL

`pnpm cost:by-tier` → `artifacts/cost-surface-by-tier.json`

Same 142 stored pools, same offline SDK pricing, `exitPricedAgainst` unchanged at
`PRE_BUY_RESERVES`. The SDK selects each pool's own tier from its own market cap,
so nothing is modelled and no tier's fee is substituted into another tier's pool.

| tier | pools | schedule RT | reserve p50 | **cost floor** | at notional | admissible @0.20 | @1.00 |
|---|---|---|---|---|---|---|---|
| 0 | 134 | 250 bps | 24.3 SOL | **2.669%** | 0.01 SOL | 26 / 134 | 0 / 134 |
| 1 | 5 | 240 | 105.1 | **2.469%** | 0.02 | 5 / 5 | 0 / 5 |
| 2 | 1 | 230 | 185.1 | **2.350%** | 0.05 | 1 / 1 | 0 / 1 |
| 8 | 1 | 170 | 813.4 | **1.722%** | 0.10 | 1 / 1 | 1 / 1 |
| 16 | 1 | 100 | 1,110.4 | **1.025%** | 0.10 | 1 / 1 | 1 / 1 |

The floor falls monotonically with the tier and the depth rises with it. **The
larger half of the gain is not the fee.** At 0.02 SOL the whole impact term is
8 bps at tier 0, so the fee is nearly all of the cost and moving from tier 0 to
tier 2 saves 32 bps. What changes far more is *capacity*: the notional at which
a pool stops being admissible under the unchanged frozen bounds moves from below
0.50 SOL at tier 0 to above 1.00 SOL at tier 8. The 165 bps span from tier 0 to
tier 16 is consistent with the directive's "up to 188 bps addressable", and it is
available only in the far tail of market caps — 19 mints of 118,655 reach tier 24
inside the entry window.

### Crossover

| tier | observed gross mean, all snapshotted (n) | crossover notional | observed gross mean, **migrated at entry** (n) |
|---|---|---|---|
| 0 | −0.03% (58,435) | 0.005 SOL — cost exceeds the mean everywhere | **−60.15%** (16) |
| 1 | +79.41% (386) | none on the grid | **−94.89%** (4) |
| 2 | +482.30% (270) | none on the grid | **−98.73%** (2) |
| 8 | −0.60% (4) | 0.005 SOL | none (0) |
| 16 | −0.60% (1) | 0.005 SOL | none (0) |

The all-snapshotted column is what §1.3 literally asks for and it is not a
tradable quantity. The migrated-at-entry column is, and it inverts the answer at
every tier where it exists. **Note also what the tier-0 column says about
D70B4A9A:** removing 661 mints of 59,096 — the 1.1% that reach tier 1 or better —
moves the 2m–60m cohort mean from +2.7% to −0.03%. The entire unconditional mean
of that cohort was carried by 1.1% of it, and 270 tier-2 mints alone carried 82%
of the summed return.

---

## 4 — TRIGGER × TIER × NOTIONAL, WITH `days` FOR EVERY CELL

`pnpm trigger:cells` → `artifacts/trigger-cells.json`, `docs/PHASE_B_CELL_LEDGER.csv`

**720 cells examined** (8 triggers × 2 populations × 5 tier buckets × 9 notionals),
549 evaluable, every one of them a row in `docs/PHASE_B_CELL_LEDGER.csv`. Not only
the passing ones — no cell passes both tests. In the tradable half, 81 of 270
evaluable cells have a positive point estimate net of cost, 72 clear the 120-day
calendar, and **zero** have a positive day-clustered lower bound.

### Frozen before fitting

```text
T0  no condition: the first snapshot in the window — the age-banded baseline,
    and not optional: without it a negative conditional mean cannot be told
    apart from a population that is negative anyway
T1  market cap ≥ 420 SOL                       (the decoded tier-1 threshold)
T2  market cap ≥ 1,470 SOL                     (tier 2)
T3  market cap ≥ 2,460 SOL                     (tier 3)
T4  ≥ 420 SOL within 600,000 ms of first observation
T5  ≥ 1,470 SOL within 1,800,000 ms of first observation
T6  net SOL inflow over trailing 300s ≥ 18.931 SOL     — control
T7  holder growth over trailing 300s ≥ 440 holders     — control

entry   the FIRST snapshot at or after the trigger fires, inside [2m, 45m]
exit    UNCHANGED: the snapshot NEAREST 60m of age, within ±25%
        (plus a fixed one-hour hold from entry, reported as a robustness column)
split   fit 2026-08-11..14 | holdout 2026-08-17..19, by each mint's first
        in-window snapshot; no day on both sides
```

T6 and T7 are controls, so their thresholds were set to match **T1's selectivity
in the fit half** (4.90%) rather than to maximise anything. That is the only
construction under which "is the lift momentum or tier?" is a question about the
lift rather than about throughput, and selectivity is computed without looking at
a single return. Field coverage in the fit half: T6 86.6% of mints, T7 70.0%.

### The answer to the control question

On the all-snapshotted population, **the lift is the tier crossing, not generic
momentum**: T1 gives +193.2% where T6 — same throughput, momentum only — gives
+16.3%, and T7 gives +133.0%. On the tradable population all three are between
−73% and −75%. So the control answers the directive's question twice: the tier
crossing is the discriminating signal, and it discriminates in the wrong direction
where it can be traded.

### Days, on both populations

| trigger | fired (fit / holdout) | censored (fit / holdout) | days @ fit rate | days @ holdout rate |
|---|---|---|---|---|
| T0 | 70,200 / 38,802 | 23% / 86% | 4 | 4 |
| T1 | 3,440 / 1,140 | 72% / 94% | **78** | **130** |
| T2 | 1,396 / 522 | 68% / 93% | 191 | 283 |
| T3 | 1,033 / 319 | 65% / 95% | 259 | 462 |
| T4 | 3,185 / 1,139 | 76% / 94% | 84 | 130 |
| T5 | 1,364 / 519 | 69% / 93% | 196 | 284 |
| T6 | 3,440 / 986 | 45% / 83% | 78 | 150 |
| T7 | 3,440 / 973 | 71% / 88% | 78 | 152 |

**A nine-day corpus does not pin an arrival rate.** T1 fires on 4.90% of the fit
half and 2.94% of the holdout — 78 days against 130, either side of the 120-day
limit. Any verdict resting on throughput alone would have been a coin flip with a
decimal point. This verdict does not rest on it.

On the **tradable** population the calendar is not the obstacle at all: T1 needs
25 days and T2 80. The obstacle is the sign of the mean.

### The cells at the frozen 0.02 SOL notional, tradable population

| trigger | bucket | n | days in holdout | gross | net of floor | required n | arrivals/day | **days** | decidable |
|---|---|---|---|---|---|---|---|---|---|
| T1 | any | 3 | 2 | −53.4% | −55.9% | 300 | 12.2 | 25 | no |
| T2 | any | 2 | 2 | −32.9% | −35.3% | 300 | 3.8 | 80 | no |
| T3 | any | 1 | 1 | +33.0% | +31.9% | — | 0.9 | — | no |
| T6 | any | 4 | 2 | −63.4% | −66.1% | 300 | 9.4 | 32 | no |
| T7 | any | 3 | 2 | −53.0% | −55.7% | 300 | 2.8 | 107 | no |

The one positive cell is a single observation on a single day: no SD, no interval,
no required n. It is reported and it is not a finding.

### The reference table

The directive prints four (s, σ) rows and the mean each needs for 120 days: 8.4%,
13.6%, 20.2%, 11.3%. Recomputed from its own stated formula —
`m = σ·√(7.84 / (120 · 79 · s))` — those become **8.6%, 12.8%, 18.0%, 8.9%**. Rows 3
and 4 of the printed table are also mutually inconsistent under any pure scaling
in σ, so the disagreement is most likely the same PDF text-layer corruption that
lost two blocks of the previous directive; §3's own bulleted list of per-cell
outputs is missing from the text layer for the same reason. **The formula was used
and the printed numbers were not.**

---

## 5 — HOLDOUT INTERVALS FOR EVERY CELL THAT PASSED ON POINT ESTIMATES

**81 of the 270 evaluable tradable cells carry a positive point estimate net of
their own cost floor. Zero survive a day-clustered lower bound**, and none of the
81 is a cell any reader should look at twice: the largest holds 3 observations and
most hold 1, which is why they have no interval at all. `net_mean_holdout > 0` and
`net_lower_bound > 0` are the two columns to read against each other in
`docs/PHASE_B_CELL_LEDGER.csv`.

For contrast, in the untradable population 243 of 279 evaluable cells have a
positive point estimate and **197 clear their cost floor on a lower bound** — and
only 13 of those clear the calendar, none of them the same cells. So the untradable
population produces intervals that survive and a calendar that refuses, while the
tradable population produces point estimates that do not survive an interval at
all.

The rest of this section is the population split that explains why, and the
intervals of the cells that would have been reported had the population not been
checked.

### A fee tier belongs to a pool

| trigger | fired, all | fired, **migrated at entry** | share | mean, all | **mean, migrated** | fixed-hold, migrated |
|---|---|---|---|---|---|---|
| T0 | 109,002 | 99 | 0.09% | +3.3% | **−65.7%** | −64.2% |
| T1 | 4,580 | 26 | 0.57% | +193.2% | **−73.2%** | −58.9% |
| T2 | 1,918 | 6 | 0.31% | +324.9% | **−28.2%** | −28.2% |
| T3 | 1,352 | 2 | 0.15% | +168.8% | +19.7% | +33.0% |
| T4 | 4,324 | 20 | 0.46% | +218.5% | **−79.4%** | −74.7% |
| T5 | 1,883 | 6 | 0.32% | +341.3% | **−28.2%** | −28.2% |
| T6 | 4,426 | 22 | 0.50% | +16.3% | **−73.2%** | −70.4% |
| T7 | 4,413 | 8 | 0.18% | +133.0% | **−74.6%** | −76.3% |

A mint counts as tradable only when a **confirmed migration precedes the entry
snapshot** — migrated at entry, not migrated eventually. 276 of 158,085
snapshotted mints ever migrated. 60% of those migrations happen inside the 2m–60m
token-age window at a median of 6.1 minutes, so the window is not the problem;
the graduation rate is. This apparatus builds a direct PumpSwap buy against a
canonical pool and has no bonding-curve builder, so a trigger firing on a
pre-migration token is a counterfactual twice over: the tier assigned to it is the
tier a pool *would* have been in, and the entry is one the collector could not
have made.

### Where the untradable cells' intervals sat

Had the population not been checked, these are the cells that would have been
reported as passing at 0.02 SOL, with their day-clustered 95% lower bounds **net
of their own tier cost floor**:

```text
T1 any     n=71   net lower bound +153.0%      days 130   (fails only on calendar)
T1 tier2   n=24   +208.4%                      days 692
T2 any     n=39   +266.8%                      days 283
T2 tier3+  n=15   +358.9%                      days 482
T3 any     n=16   +358.9%                      days 462
T6 any     n=165  +5.8%                        days 215
T7 any     n=121  +57.4%                       days 152
```

Fourteen of the 26 untradable cells at 0.02 SOL clear their cost floor on a
day-clustered lower bound. Every one of them fails the calendar, and all of them
are on mints this system cannot enter. **This is the shape D70B4A9A predicted and
worse than it feared:** there, cells cleared on point estimates and died on lower
bounds; here they clear both and die on the population.

### The cross-check that uses no mid price

Every return above is one provider `usdPrice` over another. The collector's own
marks are different in kind — `executable_lamports` is what the position could
realise, computed by the pool's own arithmetic on the position's own size with the
exit fee and impact already inside it:

| offset | n | mean | median | p10 | p90 |
|---|---|---|---|---|---|
| 60s | 685 | −13.4% | −2.6% | −59.3% | −2.5% |
| 300s | 652 | −14.0% | −2.7% | −63.7% | −2.2% |
| 900s | 617 | −15.2% | −2.7% | −65.5% | −1.5% |
| 1,800s | 559 | −16.2% | −2.7% | −69.6% | −1.4% |
| **3,600s** | **455** | **−17.4%** | **−2.7%** | **−69.6%** | −1.7% |

The median position, an hour in, is worth exactly its cost floor below par — the
mid price has not moved and the fee is the whole story — and the mean is dragged
to −17.4% by a left tail. On trajectories the risk gates *admitted*, at the frozen
notional, with no mid price anywhere in the calculation. It corroborates the
direction of the reconstruction and disagrees on the magnitude, which is what
should happen: −17.4% is a filtered population and −65.7% is not.

### What the n is, said plainly

The tradable cells rest on 2 to 16 observations each, over 1 to 3 UTC days. That
is enough to refuse a cell and **not** enough to establish a negative edge. What
makes the refusal safe is that the sign is unanimous across eight triggers, two
exit rules, three tiers, both halves of the split, and an independent executable
measurement on 455 trajectories.

---

## 6 — LEDGER DIFF, WITH THE EXPECTED FALSE-POSITIVE COUNT

Eight narrative rows, `MT065`–`MT072`, in `docs/MULTIPLE_TESTING_LEDGER.csv`,
plus **720 cell rows** in `docs/PHASE_B_CELL_LEDGER.csv` — one per cell examined,
which is what §4.4 asks for and more than the 40 it expects.

| id | records | spends alpha |
|---|---|---|
| MT065 | the decoded schedule, its fingerprint, the single-schedule result, and the shape verdict | no |
| MT066 | the provider-versus-program market-cap cross-check, and the tier × age answer | no |
| MT067 | the per-tier cost floors, and that the capacity gain exceeds the fee gain | no |
| MT068 | all eight triggers, every frozen threshold, and the pointer to the 720-row cell ledger | **yes** |
| MT069 | the population split, the sign flip, and that the verdict comes from the tradable half | **yes** |
| MT070 | that throughput is not what refuses the tradable cells, and the fit/holdout arrival sensitivity | no |
| MT071 | the expected false-positive count | no |
| MT072 | both unmodelled costs, as UNKNOWN | no |

**Expected false positives: 27.5 across all 549 evaluable cells at α = 0.05, and
13.5 across the 270 evaluable tradable cells. Zero cells passed.** A family this
size should have produced roughly a dozen accidental passes in the tradable half
alone; it produced none, which is the strongest available form of a null result.

---

## 7 — THE TWO COSTS NOT IN THE MODEL

Both are recorded as `UNKNOWN` in every Phase B artifact. Neither is priced at
zero. **The floor excludes both.**

1. **Quote-to-land slippage.** The surface prices against stored pool state. A real
   fill lands into a pool that moved, and on a momentum trigger it is moving fast
   and against you. The correlation between "the trigger fired" and "the price ran
   before you landed" is the adverse selection this strategy is most exposed to,
   and it is strictly worse for the more selective triggers, which fire further
   into a move.
2. **Crowding.** Momentum entry on Solana memecoins is the most contested strategy
   on the chain. Stored snapshots cannot see the bots that would have been ahead of
   you.

Neither was a reason not to run Phase B. Both are reasons that **every figure in
this phase is an upper bound on what a live version would earn.** That applies to
the negative results too: the tradable conditional means of −28% to −79% are
*ceilings*, and the live figure would be lower.

---

## 8 — FINAL STATE

```text
NO_DECIDABLE_CELL
```

No cell reaches 120 days on a holdout lower bound in the population this apparatus
can trade — and none reaches it on a point estimate either. The directive's own
words apply: this is a real result and it closes the venue honestly. It is not a
failure of the phase.

`CANARY_READY`, `LIVE_READY` and `PROFITABLE` remain forbidden and are not
claimed. No window was opened, no wallet funded, nothing signed or submitted.

### What Phase B actually established

- **The fee schedule is decoded, fingerprinted and stable** across the corpus, and
  the stored instruction shape is current. That part of the instrument is done.
- **The tier gain on the cost side is real and quantified**: 165 bps of round trip
  between tier 0 and tier 16, and — more valuably — the notional ceiling moving
  from under 0.50 SOL to over 1.00 SOL as depth rises with the tier.
- **The conditional mean the phase was looking for exists and is not ours.** It
  lives in pre-migration bonding-curve tokens, where this system has no builder,
  no pool, and no fee tier to improve.
- **The tradable post-migration hour is negative-mean** on every trigger examined,
  on both exit rules, and independently on the collector's own executable marks.

### What that leaves, and what it costs

Two doors, and the honest reading is that neither is cheap:

1. **Build a bonding-curve entry.** The conditional mean lives there, and reaching
   it means a pump-program builder, a curve quoter, curve-specific risk gates and a
   new parity proof — a phase of work at least as large as the PumpSwap path was,
   spent on the most contested strategy on the chain, against an upper bound that
   excludes quote-to-land slippage and crowding precisely where both are worst.
2. **Accept that the post-migration hour is not a venue for this strategy.** The
   measurement is now specific: it is not that the edge is unproven, it is that on
   the population the apparatus can enter, the mean at every trigger examined is
   negative and the median position ends the hour exactly one cost floor below par.

The one thing that is now cheap is saying which of those is true, because the
instrument that would answer it — the cost model, the tier schedule, the mark
path, the settlement identity — is built and measured. What is not established,
and what no amount of stored data can establish, is either unmodelled cost in §7.

Do not open a window on the strength of the untradable +193%. That is the single
error this report exists to prevent.
