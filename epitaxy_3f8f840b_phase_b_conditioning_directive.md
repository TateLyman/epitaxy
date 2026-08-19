# CLAUDE CODE DIRECTIVE — EPITAXY PHASE B: FEE TIER AND CONDITIONAL MEAN

**Repository:** `TateLyman/epitaxy`
**Predecessor:** `D70B4A9A_FINAL_REPORT.md`, final state `MEASUREMENT_REPAIR_REQUIRED`
**Date:** 2026-08-18
**Received as:** `3f8f840b-epitaxy_phase_b_conditioning_directive.pdf`

> **TRANSCRIPTION NOTE.** The delivered PDF is the authoritative text. Its text
> layer numbers ordered lists out of a symbol font, so item markers arrive as
> `!`, `"`, `$`, `%`, `&`, `*` and `—`, `§`, `×`, `²`, `≈` arrive as mojibake.
> Those are mechanical and are restored here.
>
> **Two things did not survive the text layer** and are marked in place rather
> than reconstructed:
>
> 1. **§3's bulleted list of per-cell outputs.** Only two fragments remain —
>    `required n = 7.84 × CV_net²` and a bare `79 ×` — so the formula
>    `days = required_n / (79 × s)` is legible and the full list of what each cell
>    must report is not.
> 2. **§6's item numbering**, which runs 1–5 and then loses two markers before the
>    final state. The eight items are recoverable from the text; their numbering
>    is not.
>
> Separately, §3's printed reference table does not reproduce from §3's own stated
> formula, and two of its rows are mutually inconsistent under any scaling in σ.
> The report recomputes it and says so.

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting,
weakening any capital gate, weakening §19 after seeing results, claiming
profitability. `CANARY_READY`, `LIVE_READY`, `PROFITABLE` remain forbidden outputs.

**No new collection. No network calls beyond fee-config decode. No purchases.**
Everything below runs against the 489,628 stored in-band snapshots over 112,584
mints and the 4,945 stored `/swap/v2/build` bodies.

---

# 0 — WHY

D70B4A9A established two facts that together reframe the problem.

1. **The cost floor is a fee-tier artifact, not a market constant.** The measured
   floor is 124 bps one way. PumpSwap fees are tiered by SOL market cap: 1.25% at
   0–420 SOL, stepping down through 1.20 / 1.15 / 1.10 to 0.30% at 98k+ SOL.
   124 bps is the bottom tier. The entire 142-pool corpus sits in the most
   expensive bucket available. Up to 188 bps of round-trip cost is addressable by
   *where* entries are taken, with no change to screening quality.
2. **No selective screen has ever been tested.** 2m–60m admits 59,197 of 90,321
   mints with an entry — roughly 66%. The +3.04% mean is therefore close to the
   unconditional population mean of migrated Pump launches. The 0.35% net figure
   measures the absence of a screen, not the failure of one.

Phase B tests whether a conditional mean exists that makes the experiment
decidable. It is a discovery phase run entirely on stored data, and **nothing it
produces is evidence.** Every artifact carries `isEvidence: false` and
`DEVELOPMENT_RECONSTRUCTED`.

---

# 1 — DECODE THE FEE TIER AND RE-CUT THE COST SURFACE ALONG IT

## 1.1 Fee config

Decode the PumpSwap `FeeConfig` account: `flatFees`, `feeTiers[]`, each tier's
`marketCapLamportsThreshold` and its `lpFeeBps` / `protocolFeeBps` /
`creatorFeeBps`. Use official program/IDL sources. Record the program ID,
programdata hash and discriminators as a fingerprint per §13 of 4890af0 — a
fee-schedule change is a regime change and must invalidate downstream surfaces.

Note the 2026-04-28 program upgrade added a trailing "breaking" fee recipient
account to every buy/sell instruction. Verify whether stored builds predate it. If
they do, the stored instruction shape is stale and every affected build is marked
`STALE_INSTRUCTION_SHAPE`, not silently reused.

## 1.2 Tier at entry for every stored mint

For every mint in the corpus, compute SOL-denominated market cap at every stored
snapshot and assign the fee tier that would have applied. Emit
`artifacts/tier-assignment.json`:

```text
mint, snapshot_ts, market_cap_sol, tier_index, total_fee_bps, age_seconds
```

Report the joint distribution of `tier_index × age_band`. **This is the table that
does not currently exist.** The specific question: what fraction of mints reach
tier 2 or better while still inside the 2m–60m age window, and what is their
arrival rate per day.

## 1.3 Cost surface, re-cut

Re-run `pnpm cost:floor` stratified by tier. Same method, same stored pools, same
`exitPricedAgainst` convention (pre-buy reserves — that choice was correct and is
unchanged).

Emit cost floor per tier at the 0.005–1.00 SOL grid. Report `cost_floor_pct` per
tier and the notional at which each tier's cost crosses that tier's observed gross
mean.

---

# 2 — CANDIDATE ENTRY TRIGGERS

Replace age-banded entry with event-triggered entry. For each trigger below, the
entry snapshot is the first snapshot at or after the trigger fires; exit rules are
unchanged and frozen.

```text
T1  market cap crosses 420 SOL
T2  market cap crosses 1,470 SOL
T3  market cap crosses 2,460 SOL
T4  market cap crosses 420 SOL within 600s of first observation
T5  market cap crosses 1,470 SOL within 1800s of first observation
T6  net SOL inflow over trailing 300s exceeds a frozen threshold
T7  holder count growth rate over trailing 300s exceeds a frozen threshold
```

T1–T5 are tier-and-momentum joint triggers. T6–T7 are momentum without the tier
benefit and exist as controls: if T6 matches T5 on conditional mean, the lift is
momentum and not tier, and that changes what to build next.

Freeze all thresholds before fitting. Every threshold examined goes in the ledger
whether or not it is used.

---

# 3 — THE DECIDABILITY TARGET

For each (trigger × tier × notional) cell report:

> **[The PDF's text layer carries only two fragments of this list:
> `required n = 7.84 × CV_net²` and a bare `79 ×`. The formula
> `days = required_n / (79 × s)` is legible from them; the rest of the list is
> not. See the transcription note.]**

**A cell is decidable if `days <= 120`.** Report every cell; do not report only
the passing ones.

Reference targets, at 79 settled mints/day:

| s | σ | m needed for 120 days |
|---|---|---|
| 0.66 | 2.43 | 8.4% |
| 0.30 | 2.43 | 13.6% |
| 0.15 | 2.43 | 20.2% |
| 0.15 | 1.20 | 11.3% |

Note the shape: **less selective triggers are easier to validate**, because
throughput enters linearly while the mean enters quadratically. Do not optimise for
the highest conditional mean. Optimise for the lowest `days`.

---

# 4 — HONEST FITTING

The corpus has 112,584 mints and this phase searches over triggers, tiers,
thresholds and notionals. That is a large family and it will manufacture a winner
from noise if fit naively.

Required:

1. **Chronological split.** Fit on the earlier half of the corpus by UTC entry
   day. Report on the later half. No parameter chosen on the later half.
2. **Day-clustered bootstrap** for every interval, clustering on UTC entry day, as
   D70B4A9A did.
3. **Report the holdout interval, not the point estimate.** A cell where the
   holdout 95% lower bound does not exceed its tier cost floor is **not
   decidable**, whatever the point estimate.
4. **Ledger every cell examined.** Not every cell reported — every cell examined.
   Expect 40+ rows.
5. **State the expected false-positive count** given the number of cells and the α
   used.

D70B4A9A's own precedent applies: four of 36 cells cleared on point estimates and
zero cleared on lower bounds. Expect the same pattern and do not treat
point-estimate winners as findings.

---

# 5 — THE TWO COSTS NOT IN THE MODEL

Both bite hardest exactly where Phase B is looking, and neither can be measured
from stored data. Record them as `UNKNOWN`, do not price them at zero, and state
that the floor excludes them.

1. **Quote-to-land slippage.** The surface prices against stored pool state. Real
   fills land into a pool that moved. On a momentum trigger the pool is moving fast
   and against you, and the correlation between "the trigger fired" and "the price
   ran before you landed" is the adverse selection this strategy is most exposed
   to.
2. **Crowding.** Momentum entry on Solana memecoins is the most contested strategy
   on the chain. Stored snapshots cannot see the bots that would have been ahead of
   you.

Neither is a reason not to run Phase B. Both are reasons the Phase B result is an
**upper bound** on what a live version would earn, and the final report must say so
in those words.

---

# 6 — FINAL REPORT

1. fee tier decode, fingerprint, and whether stored builds predate the 2026-04-28
   shape change
2. tier × age joint distribution, with arrivals/day per cell
3. cost floor per tier, and each tier's cost/mean crossover notional
4. trigger × tier × notional table with `days` for every cell
5. holdout intervals for every cell that passed on point estimates
6. ledger diff, with expected false-positive count
7. the two unmodelled costs, stated as unknown
8. one final state:

```text
NO_DECIDABLE_CELL             — no cell reaches 120 days on a holdout lower bound
DECIDABLE_CELL_IDENTIFIED     — at least one does; name it, and it owes a preregistration
MEASUREMENT_REPAIR_REQUIRED   — the tier decode or the re-cut surface failed
```

`NO_DECIDABLE_CELL` is a real result and closes the venue honestly. It is not a
failure of the phase.

Do not open a window. Do not run canary or live. Do not fund a wallet.
