# WALLET PERSISTENCE TEST — REVIEW OF THE DELIVERED SQL

**Delivered:** `7d17f4c7-epitaxy_wallet_persistence_dune.sql` (Dune / Trino, 4 queries)
**Corrected version:** `ops/dune/wallet-persistence.sql` (v2)
**Status of v2: UNRUN, and now blocked on credits rather than on access.** The
operator supplied a Dune API key on 2026-08-19. It authenticates, and the Query
CRUD API is available on the plan, so all four queries are composed and saved:

```text
Q1 reconstruction sanity          query 8379625
Q2 fit ranking and disappearance  query 8379626
Q3 holdout panel export           query 8379627
Q4 token forward return           query 8379628
```

Creating them cost nothing — verified against `POST /api/v1/usage` before and
after, unchanged at 2,499.348 credits used. **Execution is refused pre-flight:**

```text
"This api request would exceed your configured datapoint limit per billing cycle."

billing period 2026-08-10 -> 2026-08-24   credits_used 2499.348 of 2500
billing period 2026-08-24 -> 2099-01-01   credits_used     0.000 of 0
```

0.652 credits remain against ~10 per medium execution, so nothing has run and
nothing can until the allowance changes. Note the second period shows an
allowance of **0**, so this is not necessarily a wait-for-the-reset situation —
the plan may need a datapoint-limit raise or an upgrade before any of it executes.

Every claim below about what the queries *would* return is therefore a claim about
their logic, never about a result. Not one row of Dune data has been read.

The question the file asks is the right one, and it is the cheapest remaining
question in the project: **do wallets that traded well in a fit window trade well
in a disjoint holdout window?** If not, both the race version and the
screening-feature version close, for the price of a Dune query rather than a
bonding-curve builder.

Four defects in v1 change an answer rather than a style. One of them —
the cost double count — would have made a passing cell look like a failing one by
a factor of 40.

---

## 1 — DEFECTS THAT CHANGE AN ANSWER

### D1 · Positions are aggregated across both windows, so the fit ranking sees the future

**Severity: fatal to the persistence claim.**

`positions` in v1 groups every leg over the whole span:

```sql
FROM swaps s
GROUP BY 1, 2          -- trader_id, mint, across [fit_start, hold_end)
```

`fit_wallets` then filters on `first_buy` inside the fit window — but the return it
ranks on, `ret_carryfwd`, was computed from **all** of that position's sells,
including sells that happened in the holdout window, and from a carry-forward mark
(`last_price`) taken from the last trade anywhere in the span, i.e. up to
2026-08-15.

So the fit-window ranking is partly a function of holdout-window prices, and the
holdout is then used to test the ranking. The contamination is not uniform: it is
worst for positions opened near `fit_end`, and it applies to **every** unclosed fit
position, because all of their marks come from the holdout era.

The direction is not obviously flattering — memecoin decay means a holdout-era mark
usually pushes an unclosed position toward −100%, which *demotes* hold-the-loser
wallets using information the ranker could not have had. Either way the split is
not a split.

**v2:** legs carry a `window_tag`; positions are aggregated within a window; the
residual is marked at a price observed **inside that window's final hour**. The fit
return is now "the return as of `fit_end`", which is what a ranker standing at
`fit_end` could actually have computed.

### D2 · Subtracting the 2.69% cost floor from a wallet's realised return double counts it

**Severity: 40× error in the pass/fail threshold.**

The header says the 2.69% round-trip floor "must be subtracted before any cell is
called profitable". For queries 2 and 3 that is wrong, and it is wrong by most of
the floor.

Our own decomposition of the 2.69% floor at 0.02 SOL (D70B4A9A §1.1, and Phase B §3
per tier) is:

```text
2.63%   venue: the AMM fee tier (2.48%) plus price impact (0.15%)
0.07%   fixed: base signature fee plus priority fee, 12,094 lamports a round trip
```

A wallet's realised return reconstructed from on-chain swap amounts is
`(sol_out − sol_in) / sol_in`, and **the venue fee and the impact are already inside
those amounts**: `sol_in` is the gross SOL the wallet paid, fee included, and
`sol_out` is what it received after fee and impact. Subtracting 2.69% charges the
venue component twice.

What is genuinely missing from a Dune-reconstructed wallet return is the fixed
component — about **6 bps** on a 0.02 SOL position, and less on a larger one, since
it is a lamport amount and not a rate.

**v2:** `position_pnl` carries `fixed_cost_fraction = 12,094 lamports / sol_in`, and
queries 1–3 report the return net of *that*. The full floor is applied only in
query 4, where the trade being priced is ours.

There is a real cost the copier pays that neither figure captures: entering *after*
seeing the wallet's buy. That is quote-to-land slippage and crowding, both recorded
as `UNKNOWN` in Phase B §7, and it is the reason a wallet's realised return is an
upper bound on a copier's — not the 2.69%.

### D3 · Query 4's decision rule requires the *difference* to beat the cost floor

**Severity: makes the primary test unpassable.**

```sql
-- v1: The flagged group must beat the unflagged group by more than 2.69%
```

Both cohorts are the same kind of trade in the same kind of pool. **The floor
cancels in the difference.** Requiring `flagged − unflagged > 2.69%` asks the signal
to be worth a whole round trip *more* than a coin flip, which is not the question,
and on a heavy-tailed distribution with a 30-day holdout it is a test nothing could
pass.

**v2 splits it into the two tests that were being conflated:**

- **TEST A, the difference.** `TOP_PRESENT − NO_RANKED_WALLET > 0` on a
  day-clustered 95% lower bound. Zero, not 2.69%.
- **TEST B, the level.** `TOP_PRESENT`'s own mean exceeds the round-trip floor for
  the tier those pools are in, on a day-clustered 95% lower bound. A signal that
  separates cohorts but leaves the better one under water has nothing to trade
  behind it.

Both required. Neither sufficient.

### D4 · Nothing records which venue the entry happened on

**Severity: decides whether the answer is actionable.**

Phase B established that this apparatus can only enter the **post-migration AMM**:
the collector's production path is a direct PumpSwap buy against a canonical pool,
there is no bonding-curve builder, and 99.4% of the mints that fired Phase B's
market-cap triggers had no pool at the time. A persistence result pooled across
`pumpdotfun` and `pumpswap` therefore answers a question about a venue mix that
cannot be acted on.

Keying positions *by* project would be worse, not better: a wallet that buys on the
curve and sells on the AMM is **one economic position**, and splitting it by venue
would manufacture a −100% buy-only fragment and a proceeds-only fragment.

**v2:** positions stay keyed on `(window, trader, mint)`, and every output carries
`entry_project` (the venue of the *first buy*) plus `projects_touched`, so the
AMM-entry slice can be read on its own without breaking the economics. Query 4
additionally carries `amm_at_entry`.

---

## 2 — DEFECTS THAT CHANGE A NUMBER WITHOUT CHANGING THE ANSWER

| # | defect | fix in v2 |
|---|---|---|
| L1 | `last_price` picks one trade with `ORDER BY block_time DESC` and no tiebreak, so two trades in the same block give a nondeterministic mark; and a single trade is a poor price for a large one. | VWAP over the window's final hour, falling back to the last trade tie-broken on `tx_id`. |
| L2 | `tok_bought − tok_sold` can be **negative** — the wallet sold tokens it acquired by transfer, airdrop, or a route outside the WSOL filter. Its `sol_out` then includes proceeds from tokens never paid for, which overstates the return for exactly the wallets most likely to be insiders. | `external_inflow` flag when `tok_sold > 1.01 × tok_bought`, residual clamped at ≥ 0, flagged rows excluded from the primary and counted in the output. |
| L3 | `top_fraction = 0.10` is declared "FROZEN. Do not tune." and then never used; `NTILE(10)` hardcodes the decile. A frozen parameter the code ignores is a parameter that can drift silently. | `top_fraction` drives a rank-based `top_by_mean` flag; the decile table is kept beside it. |
| L4 | Ranking on the **mean** of a heavy-tailed distribution selects wallets with one huge winner. That is variance, not skill — the same failure mode `medianOfMeans` exists in `packages/research/src/robust-stats.ts` to catch. | `rank_by_median` computed alongside `rank_by_mean`, and `top_on_mean_only` reported per decile so a disagreement between the two rankings is visible rather than inferred. |
| L5 | The holdout mean is a mean of wallet means, so a 1-position wallet outvotes a 200-position one. | `sol_weighted_ret_hold` reported beside it. |
| L6 | `mint_first_seen` computes `t0` over the sample span, so a mint that traded before `fit_start` looks new in the holdout. | a `lookback_start` parameter, used **only** for first-seen, 30 days before `fit_start`. |
| L7 | Query 4's `top_wallet_present` conflates "a ranked wallet bought and was not top decile" with "no ranked wallet bought at all", making the control group a mixture of two populations. | three-way cohort: `TOP_PRESENT` / `RANKED_NOT_TOP` / `NO_RANKED_WALLET`. |
| L8 | No visibility into whether `NTILE(10)` had ten wallets to work with. | `wallets_qualifying` carried through `ranked`. |
| L9 | "Prepend the SHARED BASE block" is a manual assembly step performed four times, and v1's query 2 comment and query 4 comment ask for different subsets of it. | **superseded by code.** The file now carries one base in `--#BASE`/`--#RANK`/`--#Q1..Q4` sections and `pnpm dune:assemble` composes four self-contained statements into `ops/dune/generated/`, refusing any that composes to more than one statement. A query assembled by hand is a query where the thing that ran and the thing in version control are different artifacts. `--push` also creates or updates them in Dune, reading the key from `DUNE_API_KEY` and writing it nowhere. |
| L10 | Mints whose `t0` falls in the final 72 minutes of the holdout have no exit mark inside the window and are counted as censored for a reason about the boundary rather than the token. | documented in the decision-rule block; ~0.17% of a 30-day span, unevenly spread because launch rates are not uniform across the day. |

### Not defects

- **The 10-minute flag window and the `t0+10m` entry mark do not overlap.** That was
  right in v1 and is kept: the cohort assignment cannot see the price it is later
  measured against.
- **`ret_zero` as a sensitivity beside `ret_carryfwd`.** Correct, and the reasoning
  in v1's comment — marking at zero is harsh, excluding lets hold-the-loser wallets
  look skilled — is exactly right.
- **Ranking on mean return per position rather than total PnL.** Correct, for the
  stated reason.
- **Treating disappearance as an outcome rather than an exclusion.** Correct, and it
  is the one design choice in v1 that most improves on how this kind of test is
  usually done.
- **"Phase B had 81 tradable cells with positive point estimates and zero that
  survived a lower bound."** This is **accurate** and more precise than the Phase B
  report's own summary was. 81 of the 270 evaluable tradable cells carry a positive
  point estimate net of cost and zero survive a day-clustered lower bound. The
  report and `docs/STATUS.md` have been corrected to state 81/0 rather than the
  weaker "zero pass on a point estimate", which invited the misreading that no cell
  had a positive point estimate at all.

### One attribution to correct

The v1 comment says censoring "killed the Phase B bonding-curve thesis at 94%".
The 94% is ours — T1's holdout censoring was 93.8% — but it is not what killed
anything. What closed that thesis was the **population split**: 99.4% of trigger
firings had no PumpSwap pool, and on the mints that did the conditional mean was
−73.2%. Censoring is a caveat on that estimate, not the cause of the verdict. The
distinction matters here because it changes what `censored_share` in query 4 is
evidence *of*.

---

## 3 — THE THREAT NO SQL FIXES

`vanish_rate` is three different things wearing one number:

1. the wallet stopped trading;
2. the wallet **rotated to a fresh address**;
3. the wallet blew up.

Pump snipers rotate constantly. Rotation reads in query 2 exactly like a blow-up,
and it biases the persistence test toward *no persistence* whether or not skill
exists — a skilled operator who changes address every week has, in this data, a
100% vanish rate and no holdout positions.

Separating (2) from (1) and (3) needs the funding graph, which this repository
already walks for holders in `packages/intelligence/src/entity-links.ts`
(`measureEntityTier`, chunked at the endpoint's measured five-account bound per
MT056). Applying it to `trader_id`s rather than holders is a bounded piece of work
and it is a **prerequisite for believing a negative result**, not only a positive
one.

Until it is done, the honest reading of a flat decile table is "no persistence *of
addresses*", which is a weaker claim than "no persistence of skill" and is the only
one this data supports.

And the asymmetry that applies if the test passes: a signal whose entire content is
*informed money is already buying* is a signal you are racing. Quote-to-land
slippage and crowding are `UNKNOWN` (Phase B §7) and are worst precisely here.

---

## 4 — WHY THIS COULD NOT BE RUN OR PRE-ANSWERED LOCALLY

The local corpus has no wallet-level trade data:

| table | rows | why it does not help |
|---|---|---|
| `targeted_flow_events` | **0** | the one table with an `actor` column, and it is empty |
| `chain_events` | 356,027 | signature, program, mint, pool — no actor, no amounts |
| `direct_chain_events` | 7,023,666 | same shape, no actor, no amounts |
| `entity_concentration` | 506 | per-mint holder concentration, not per-wallet trades |
| `chain_flow_bars_v2` | 156,329 | trade counts per bucket, no identities |

So the persistence question is genuinely external to this corpus, which is what
makes the Dune route worth taking. The nearest local corroboration is the one Phase
B already used: the collector's own executable marks, which put the median
hour-old position at −2.7% of notional — exactly the cost floor — with a mean of
−17.4% on 455 admitted trajectories. Query 1's `median` column should land near
−0.03 if the reconstruction is measuring the same quantity; a median near +0.5 or
−0.9 means it is not, and nothing downstream should be read.

---

## 5 — PREREGISTRATION

Recorded in `docs/MULTIPLE_TESTING_LEDGER.csv` as **MT073–MT075**, before the query
runs, because the decision rule is what makes this one test rather than a search:

```text
frozen   fit 2026-06-01 .. 2026-07-15, holdout 2026-07-16 .. 2026-08-15
         min_positions_fit = 20        top_fraction = 0.10
         fixed_cost_sol = 0.000012094  round_trip_floor = 0.0269 (query 4 only)
         entry mark t0+10m..t0+12m VWAP, exit mark t0+70m..t0+72m VWAP

H1  the top decile by fit rank beats the rest in the holdout window, on a
    day-clustered 95% lower bound, net of our fixed cost          (queries 2, 3)
H2  a top-decile wallet's presence among the first-10-minute buyers predicts the
    TOKEN's forward return: TEST A difference > 0 AND TEST B level > floor,
    both on day-clustered 95% lower bounds                        (query 4)

Two hypotheses. Not one per wallet, not one per decile, and not one per notional.
```

Whichever way it comes out, the result is `DEVELOPMENT_RECONSTRUCTED` and is an
**upper bound** on what a live version would earn, for the reasons in §3.

---

## 6 — WHAT TO RUN, IN ORDER

> **EXECUTED 2026-08-19, in this order, for 589.26 of 2,500 monthly credits.**
> Results and both verdicts: `docs/WALLET_PERSISTENCE_RESULTS.md`. Raw exports:
> `ops/dune/results/`. Analyses: `pnpm wallet:interval` and `pnpm token:h2`.
>
> Step 0 confirmed the schema, so the base block's column names are measured
> rather than assumed. Step 1 took four iterations and found two instrument
> defects — dust denominators (mean +36.26, SD 22,566) and per-mint residual marks
> wrong by 6–7 orders of magnitude — both fixed before any decile was cut, with
> `min_sol_in`, `mark_min_trades` and `mark_min_sol` frozen in MT078.
>
> Step 2's decile table is **not flat**, so the stop condition below did not fire.
> Its two warnings both landed anyway and are the reason step 3 was run on two
> cuts: the top decile's vanish rate is the *highest* in the table (36.7–46.6%),
> and the two rankings disagree about 10,859 of 21,123 wallets.
>
> Step 3 was restructured to return per-(day, cohort) **sufficient statistics**
> rather than the raw panel — 1,680 datapoints instead of ~166M — after
> establishing that a cluster bootstrap of a mean is a function of (n, sum) alone.
> `clusterBootstrapAggregated` reproduces `clusterBootstrap(…, 'UTC_DAY')` exactly,
> asserted by unit test, so the intervals are comparable across phases as intended.
> H1 **passes on both cuts** and on every adversarial re-cut.
>
> Step 4's two tests were applied separately as required. H2 is **undecidable**:
> the flag is set on 82.6% of mints and the two defensible censoring treatments
> disagree in sign.

0. **Verify the schema first**, for about one credit:
   `SELECT column_name, data_type FROM information_schema.columns WHERE
   table_schema = 'dex_solana' AND table_name = 'trades'`. This was attempted on
   2026-08-19 and refused for want of credits, so the column names in the base
   block are still **assumed**. The file's own header names this as the top risk
   and it is the cheapest thing on the list to settle.
1. **Query 1** (8379625), and stop if `closed_share`, `external_inflow_share` or
   `median` look wrong (thresholds in the query's own footer). A wrong schema
   assumption here invalidates everything after it.
2. **Query 2**, and read `vanish_rate` and `top_on_mean_only` *before*
   `avg_holdout_return`. If the top decile's vanish rate is high or the two
   rankings disagree, the decile is a variance artifact and the holdout column is
   not measuring what it appears to.
3. **Query 3**, export, and bootstrap offline with `clusterBootstrap(…, 'UTC_DAY')`
   from `packages/research/src/robust-stats.ts` — the same function Phase B used, so
   the intervals are comparable across phases.
4. **Query 4**, and apply TEST A and TEST B separately.

If query 2's decile table is flat, stop. That is the cheapest close available and
it closes both branches at once.
