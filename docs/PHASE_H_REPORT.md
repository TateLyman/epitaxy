# PHASE H — LOCATE THE 82%

**State: `VENUE_LOCATED`.**

**Directive:** `docs/directives/DIRECTIVE_9010E265_PHASE_H_LOCATE_THE_82.md`, transcribed and
committed before execution.
**Predecessor:** PR #64, `PRE_MIGRATION_CURVE_PRICED: RECONSTRUCTION_FAILED_VALIDATION`, SHA
`3fbd8b8`.
**Preregistered:** MT097 (the venue assignment rule and the sampling) and MT098 (the thin-data
bar and the state ordering), both written to `docs/MULTIPLE_TESTING_LEDGER.csv` before the first
query object was touched.
**Credits: 137.48 of a 150 target.** Per-query figures in §5.
**`MEASUREMENT_ONLY`.** No mode changed, no gate moved, no wallet funded, nothing signed.

---

## 0 — THE ONE-LINE ANSWER

**The +234.2% to +394.2% lives in tokens minted directly by the Token-2022 program — no
launchpad, never a bonding curve — trading in PumpSwap pools, and it is a venue-mix artifact of
the trigger rather than anything the trigger did inside a venue.**

Three numbers carry that sentence:

- **98.44%** of the summed return comes from positions whose token was minted by
  `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` — Token-2022 — at a mean of **+527.03%** over
  3,124 positions and 868 mints. The pump.fun bonding curve contributes **0.64%**; Meteora's
  Dynamic Bonding Curve contributes **−0.88%**.
- **58.72%** of the summed return is executed on PumpSwap (`pAMMBay6…`), **43.96%** on one
  program no source names, `FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X`. The pump.fun curve
  contributes **−2.80%**.
- T1's **+234.50%** advantage over the reweighted population baseline of **−0.33%** decomposes
  into **+193.10% venue mix** and **−4.29% within venue**. Mix is **97.8%** of the explained
  difference.

`VENUE_LOCATED` is the directive's own state and it is claimed exactly as the directive defines
it: *permission to decode one fee schedule and compute one cost floor*. It is not permission to
trade, not permission to build, and not an edge. Two qualifications travel with it everywhere in
this report: the located figure rests on **57 mints** with **54.69%** of its absolute return in
three of them, and it exists only under *as-reported* pricing, which conditions on the 6% of
positions that reached a price at all. At residual-at-zero every venue in the table is deeply
negative.

---

## 1 — THE ERROR THIS PHASE MADE FIRST, AND HOW IT WAS CAUGHT

The obvious source for "which venue" is `dex_solana.trades`: it carries `project`,
`version_name`, and a program ID. Run against the 2,056 mints that fired a conditional trigger,
it returned **no row at all for 933 of them** — and the split was spectacular:

| | positions | priced | mean | summed return |
|---|---|---|---|---|
| mint present in `dex_solana.trades` | 2,200 | 277 | +9.37% | 25.95 |
| mint **absent** | 3,398 | 245 | **+365.27%** | **894.92** |

97.2% of the summed return sat in the mints the table could not see. That is a complete,
publishable answer, and it is wrong.

The check that killed it cost nothing. The local corpus stores Jupiter's own per-snapshot
fields, and for those same 933 mints Jupiter reports **a completed trade for 98.5%** of them, at
a median of **106 distinct traders in a five-minute window**, median liquidity **$7,073**, and a
median **169 holders**. Those tokens were trading heavily. `dex_solana.trades` carries only the
venues Dune has curated, so an absence there is a fact about the curation — exactly the class of
error this repository's invariant names: *absence of a provider field is a fact about the
provider, not about the token*.

The classification was redone from `tokens_solana.transfers`, which curates nothing: every SPL
movement, with `outer_executing_account` naming the program that executed it. All 5,598
conditional positions resolve from that source. `dex_solana.trades` is kept for naming and as a
cross-check, and its coverage hole is now a measured quantity rather than a silent one:
**933 of 2,056 mints, 45.4%**.

Two smaller defects in the first query, both fixed before any number here was computed:
`project_program_id` is a **pool** address, not a program — its 1,319 distinct values over 2,056
mints gave it away — the program is `project_main_id`; and the per-mint summary rows cannot be
told from the detail rows by a null program, because 6,139 `pumpdotfun` rows carry a null
`project_program_id` of their own. An explicit `grouping()` bitmask replaced the null test.

---

## 2 — §1 CLASSIFICATION

The rule is MT097, fixed before the query: **the venue is the program with the most transactions
in `[entry, exit_target]`**, ties broken by moves and then by program ID so row order never
decides; failing that, the last activity before entry, then the first after exit; failing that,
unresolved. Thirty programs appear. Nineteen are named by no source and are reported by ID with
their counts, per the directive.

Conditional triggers T1–T7, 5,598 positions, all resolved:

| venue / program | kind | n | share | priced | share of summed return | mean | cost floor |
|---|---|---|---|---|---|---|---|
| pumpswap `pAMMBay6…` | AMM | 2,630 | 46.98% | 160 | **58.72%** | +337.94% | 2.4052–2.6693% |
| `FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X` | **unrecognised** | 833 | 14.88% | 73 | **43.96%** | +554.58% | **UNKNOWN** |
| `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9` | unrecognised | 437 | 7.81% | 118 | 0.25% | +1.93% | UNKNOWN |
| jupiter aggregator v6 | router | 16 | 0.29% | 1 | 0.17% | +159.09% | UNKNOWN |
| `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` | unrecognised | 25 | 0.45% | 4 | 0.11% | +26.34% | UNKNOWN |
| meteora dbc `dbcij3L…` | launchpad | 337 | 6.02% | 8 | 0.03% | +3.55% | UNKNOWN |
| meteora cpamm `cpamdpZ…` | AMM | 731 | 13.06% | 14 | −0.04% | −2.87% | UNKNOWN |
| `6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB` | unrecognised | 59 | 1.05% | 11 | −0.13% | −10.81% | UNKNOWN |
| orca whirlpool `whirLbMi…` | AMM | 69 | 1.23% | 25 | −0.01% | −0.43% | UNKNOWN |
| **pump.fun bonding curve `6EF8rre…`** | **curve** | **181** | **3.23%** | **53** | **−2.80%** | **−48.67%** | 2.50% flat |

The remaining twenty programs hold 280 positions between them, 5.0%, and no material return; the
complete table with every program ID is `artifacts/phase-h-venue.json` and `docs/PHASE_H_CELL_LEDGER.csv`.

**The small venue that carries most of the return is named, as §1 requires:**
`FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X`. 14.88% of positions, 43.96% of the summed
return. No source in this corpus names it — not Dune's `project` column, not the Solana program
registry — so it is reported by its ID and its floor is `UNKNOWN`. It appears in
`dex_solana.trades` under no project at all, which is consistent with the coverage hole above.

Restricting the same rule to programs that *can hold a pool* (excluding routers and the two token
programs) moves almost nothing: pumpswap 58.72%, FLUX 43.96%. That refinement is labelled a
refinement in the code and is not the preregistered rule.

### 2b — the classification the phase was not asked for, and which turned out to matter

Grouping the identical positions by the program that **minted** the token:

| origin program | n | mints | share of summed return | mean |
|---|---|---|---|---|
| **token-2022 `TokenzQd…`** | **3,124** | **868** | **98.44%** | **+527.03%** |
| spl token `TokenkegQ…` | 397 | 116 | 1.93% | +19.76% |
| pump.fun bonding curve `6EF8rre…` | 958 | 617 | 0.64% | +2.49% |
| meteora dbc `dbcij3L…` | 1,085 | 439 | −0.88% | −40.63% |

The return-bearing population is not a launchpad population. It is tokens minted straight from a
token program, with a pool seeded afterwards. **All 3,124 Token-2022 positions are labelled
`migrated_at_entry = false` by Phase B** — pre-migration — and by Phase B's own definition that
label is correct: `confirmed_migrations` never saw a migration because there was never a curve to
migrate from. The branch this programme has been calling *the pre-migration bonding-curve branch*
is, in its return-bearing majority, direct Token-2022 mints on PumpSwap pools.

---

## 3 — §2 TRIGGER MEANS BY VENUE

Full table: `docs/PHASE_H_CELL_LEDGER.csv`, 23 columns per cell. The PumpSwap column, which is
where the return is:

| trigger | n | priced | as-reported | residual-at-zero | censoring | floor |
|---|---|---|---|---|---|---|
| T0 | 849 | 60 | +284.63% | −72.82% | 92.93% | 2.6693% (tier 0) |
| T1 | 524 | 27 | +256.24% | −81.64% | 94.85% | 2.5108% (tier 1) |
| T2 | 205 | 6 | +921.89% | −70.09% | 97.07% | 2.4052% (tier 2) |
| T3 | 141 | 6 | +921.89% | −56.52% | 95.74% | 2.4052% (tier 2, carried up from tier 5) |
| T4 | 523 | 27 | +256.24% | −81.61% | 94.84% | 2.5108% (tier 1) |
| T5 | 202 | 6 | +921.89% | −69.65% | 97.03% | 2.4052% (tier 2) |
| T6 | 562 | 42 | +278.38% | −71.72% | 92.53% | 2.5108% (tier 1) |
| T7 | 473 | 46 | +259.74% | −65.02% | 90.27% | 2.6693% (tier 0) |

Three things are visible and all three matter.

**Censoring is 90–97% in every cell.** The as-reported mean is computed on 6 to 27 positions out
of hundreds. At residual-at-zero — every censored position marked −100%, which is the harsh bound
rather than the estimate — **every cell is between −57% and −82%**. The positive number exists
only in the survivors.

**T1 does not beat T0 within PumpSwap.** +256.24% against +284.63%. The trigger, inside its own
venue, is slightly worse than entering unconditionally.

**Cost floors are venue-specific and mostly unknown.** Two venues have a decoded schedule: the
pump.fun curve at 2.50% flat and PumpSwap at 2.4052–2.6693% depending on tier, read from the
same `artifacts/cost-surface-by-tier.json` Phase B read, at the same 0.01 SOL notional, with the
same nearest-measured-tier fallback recorded per cell. **Every other venue is `UNKNOWN`,
including the one carrying 43.96% of the return.** No floor was invented by analogy and none was
omitted; where a figure is gross it says so.

Day-clustered 95% intervals are in the cell ledger for every cell. They are computed over **2 or
3 UTC days**, which is 2 or 3 clusters, and cells on fewer than 3 days are flagged with `!` in
the run output. An interval from two clusters is not inference and none of the conclusions here
rest on one.

### 3b — mix or effect

T0 restricted to a trigger's own mints reproduces the trigger's mean **to the last digit** —
T1 gives 234.18% and so does T0 on T1's mints. That is not a coincidence and it is a finding:
**Phase B's triggers select which mint to enter, not when.** The entry snapshot is the same one
either way, so the two are the same position and there is no within-mint contrast to be had.

Against the only real baseline — T0 over the read population, reweighted 6.0× for the sampled
T0-only mints, giving −0.33%:

| trigger | mean | total vs baseline | venue mix | within venue | residual | mix share |
|---|---|---|---|---|---|---|
| T1 | +234.18% | +234.50% | **+193.10%** | **−4.29%** | +45.69% | 97.83% |
| T2 | +392.72% | +393.04% | +279.41% | +262.69% | −149.06% | 51.54% |
| T3 | +362.54% | +362.87% | +266.59% | +244.70% | −148.43% | 52.14% |
| T4 | +234.18% | +234.50% | +193.08% | −4.32% | +45.74% | 97.81% |
| T5 | +392.72% | +393.04% | +279.78% | +260.16% | −146.90% | 51.82% |
| T6 | +54.53% | +54.86% | +121.54% | +24.58% | −91.27% | 83.18% |
| T7 | +110.77% | +111.10% | +111.67% | +35.21% | −35.78% | 76.03% |

For T1 and T4 the answer is unambiguous: the entire advantage is venue mix and the within-venue
term is negative. For T2/T3/T5 the within term is large and positive, but so is a residual of
−149% arising from venues present on only one side of the comparison, so those rows are reported
and not interpreted. T6 and T7 are mix-dominated.

A venue-mix effect is a relabelling of the same tokens. It carries no information the venue label
did not already carry, and it is not tradable on a venue whose fee schedule is `UNKNOWN`.

---

## 4 — §3 THE DISCOVERY-ARTIFACT CHECK

MT098's bar, fixed before the query: thin if median trades per mint over the holding period ≤ 3,
**or** median distinct traders per mint ≤ 3, **or** ≥50% of positions take both legs from one
trade.

| venue | mints | median trades/mint | median traders/mint | same-trade | verdict |
|---|---|---|---|---|---|
| pumpswap | 807 | 3,307 | 1,222 | 3.19% | not thin |
| `FLUXubRm…` | 183 | 283 | 21 | 0.60% | not thin |
| `FLASHX8Dr…` | 299 | 1,202 | 444 | 3.89% | not thin |
| meteora cpamm | 284 | 1,571 | 235 | 0.00% | not thin |
| meteora dbc | 152 | 1,327 | 227 | 2.67% | not thin |
| pump.fun bonding curve | 154 | 296 | 155 | 0.00% | not thin |

**The 82% is not thin data.** Six programs *are* thin and are named with the clauses each fired —
`proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u`, `2UUgGySTVXmKFatH7pGQo84ZrzdSYF5zw9iqrGwBMuuj`,
`6NmUzsPWY9f8u2ZEke6xS7uBcup7TCuxQzJGS3GxE3w3`, `BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW`,
`TroYL71c8P2XNtDxHs98VtVLuiASJ7Ao5FvUoKyp3Bk` — and they hold 16 positions between them and no
material return. `DISCOVERY_ARTIFACT` does not fire.

Two notes on how those numbers are computed, both chosen so the surviving verdict is the robust
one. Trades per position window are counted **generously**, over every 5-minute activity bucket
that touches the window: a thin verdict against an over-count would be the fragile direction, and
none of these fired anyway. Distinct traders per mint is an **upper bound** — distinct signers
over the whole holdout rather than inside each window — because distinct counts are not summable
and were not summed. The same-trade fraction is exact in the direction claimed: asserted only
when not one bucket intersects the window after entry.

### 4b — not thin is not the same as about something

| venue | priced | mints priced | signed sum | top mint | top 3 | top 10 |
|---|---|---|---|---|---|---|
| pumpswap | 160 | 57 | 540.70 | 34.27% | **54.69%** | 81.25% |
| `FLUXubRm…` | 73 | 18 | 404.84 | 6.21% | 18.41% | 57.75% |
| `FLASHX8Dr…` | 118 | 92 | 2.28 | 27.00% | 36.72% | 57.10% |

Shares are of the venue's **absolute** summed return; a share of a signed sum near zero is a
meaningless number over 100%, which the first version of this table duly printed.

PumpSwap's 58.72% of the summed return is **57 mints**, and three of them are more than half of
it. FLUX's 43.96% is **18 mints**. The single largest position in the whole conditional
population, +3,446%, appears in six triggers at once because the triggers overlap. So the venue
is located, and what is located is a few dozen tokens.

---

## 5 — CREDITS PER QUERY

| query | what | credits |
|---|---|---|
| 8383480 exec `01M0DY40V6J1P2W2PQYQEQSF5K` | Q16 curated dex, conditional mints — **defective**, wrong program column | 0.78 |
| 8383475 exec `01M0DYDM9AFHHDRMYEX7H80W1E` | probe: `tokens_solana.transfers` columns | 0.00 |
| 8383480 exec `01M0DY9KEBA0VKQGXFNFWER1VJ` | Q16 corrected, 15-day read, 45,671 rows | 6.15 |
| 8383472 exec `01M0DYGKW1PAWR2BM6YGMG3VDW` | Q17 transfers, all 2,056 conditional mints, 221,341 rows | 30.96 |
| 8383472 exec `01M0DYYTJMPWTAPWC288JZ5NAZ` | Q17 transfers, T0-only baseline chunk 1 of 6, 93,423 rows | 99.60 |
| | **total** | **137.48** |

Target 150, ceiling 300, per-query 250. The phase stopped at 137.48 with the baseline at one
chunk of six rather than running the other five for ~500 credits, which is why the T0 baseline is
a 16.7% sample of the T0-only mints and exact on the conditional mints. That is labelled at every
appearance, and it is the only place in this phase where a number is a sample.

**The 30 private-query cap was reached**, so Phase H reused three query objects created for
throwaway probes (8383480, 8383475, 8383472) rather than making the queries public. No query
cited as evidence by an earlier phase was overwritten; the SQL of each is committed under
`ops/dune/generated/` and the execution IDs above are the immutable record.

The two Dune results are **89 MB and 37 MB** and are **not committed**. They regenerate from the
committed SQL at the costs above. What a later reader needs is committed:
`artifacts/phase-h-mint-venues.csv`, 8,181 rows, one per mint, with origin program, venue
program, and its own holdout activity.

---

## 6 — LEDGER DIFF

| row | family | status | what it fixed before the query, and what it says now |
|---|---|---|---|
| **MT097** | measurement | landed | the venue assignment rule and the T0 sampling. Result: the rule held without amendment; PumpSwap 58.72%, FLUX 43.96%, curve −2.80%; the `dex_solana.trades` route was caught and replaced |
| **MT098** | measurement | landed | the thin-data bar and the ordering of the three states. Result: not thin on the venue that matters, so `VENUE_LOCATED` rather than `DISCOVERY_ARTIFACT`; concentration and survivorship recorded next to it |

97 rows, MT001–MT098. No row was reassigned and no threshold moved after seeing a result.

---

## 7 — CROSS-CHECKS

**Against PR #64, by an unrelated route.** PR #64 found 999 of 5,598 conditional positions on a
pump.fun curve, by membership in `pumpdotfun_solana.pump_evt_tradeevent`. This phase finds **958**
by the program that executed the mint action in `tokens_solana.transfers` — a different table, a
different program, a different definition. **95.9% agreement.** The 41-position gap is the size
one would expect from mints whose creation falls outside the read window.

**Against Jupiter's own fields.** The check that caught this phase's first error is itself the
cross-check on the transfers route: Jupiter reports trading for 98.5% of the mints
`dex_solana.trades` could not see, and the transfers read finds a median 3,118 transactions for
them over the five-day read. Two independent sources agree those tokens were trading, and the curated table is the
outlier.

---

## 8 — WHAT THIS PHASE DID NOT DO

- **No curve re-pricing.** §A of the Phase G addendum failed validation in PR #64 and is closed.
- **No new triggers, cohorts, thresholds, or size definitions.** The trigger set, the holdout
  split, and the exit window are Phase B's, untouched.
- **No cost floor invented.** Two venues have one. Every other venue reads `UNKNOWN`, including
  the one carrying 43.96% of the return.
- **No claim that any venue is tradable.** Identifying PumpSwap says nothing about whether this
  apparatus can enter a PumpSwap pool at 0.01 SOL inside a 45-minute window, and Phase B's
  builder constraint is unchanged.
- **No window opened, no canary, no live, no wallet funded.** `CANARY_READY`, `LIVE_READY` and
  `PROFITABLE` remain forbidden outputs and are not claimed.

---

## 9 — WHAT VENUE_LOCATED ACTUALLY BUYS

The directive is explicit that this state is permission to decode one fee schedule and compute
one cost floor. The candidate is `FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X`: 43.96% of the
summed return, 833 positions, 18 priced mints, no name from any source, no fee schedule, no floor.

Before that decode is worth doing, three things established here should be weighed, because two
of them argue against it:

1. **The trigger contributes nothing within a venue.** T1's within-venue term is −4.29%. Whatever
   the venue's fee schedule turns out to be, it prices a mix effect.
2. **The figure is 57 mints on PumpSwap and 18 on FLUX**, with over half of PumpSwap's absolute
   return in three of them, and it survives only under as-reported pricing at 90–97% censoring.
3. **The population is Token-2022 direct mints.** Token-2022 supports transfer fees and transfer
   hooks. A cost floor for that population is not the venue's fee schedule alone — it is the
   venue's schedule plus a per-mint extension that this corpus has never decoded and that Phase G
   established the collector never stored. That is a second unknown sitting underneath the first.

The honest summary of Phase H is that it did what it was asked: it named the population. The name
is *Token-2022 tokens on PumpSwap pools, priced by Jupiter, surviving 6% of the time*, and every
prior description of these positions — "the pre-migration bonding-curve branch", "the only
positive number in the programme" — attached a venue label that was wrong for four fifths of the
data. That label is now correct.
