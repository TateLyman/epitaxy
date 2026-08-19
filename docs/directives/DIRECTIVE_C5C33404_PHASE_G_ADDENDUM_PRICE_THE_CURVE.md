<!--
  RECEIVED 2026-08-19 as c5c33404-epitaxy_phase_g_addendum_price_the_curve.pdf, after PR #63 was
  opened.

  THIS IS A TRANSCRIPTION, NOT THE ORIGINAL BYTES. The source is a PDF and this repository's
  convention for PDF directives is to transcribe faithfully and mark what the PDF lost rather
  than to reconstruct it. Three specific losses are marked inline with [PDF LOST: ...]. Nothing
  outside those markers has been reworded, reordered or summarised; the glyph substitutions the
  extractor produced for em-dashes, section signs, apostrophes and minus signs have been restored
  to their evident intent, and nothing else.

  The original PDF is at
  C:\Users\lyman\.claude\uploads\894f4318-dc1d-438d-8486-f41554eb8276\c5c33404-epitaxy_phase_g_addendum_price_the_curve.pdf

  Execution record: docs/PHASE_G_ADDENDUM_REPORT.md. Curve reconstruction and its validation
  bar: MT095. Global-account anchor inventory: MT096.
-->

# ADDENDUM TO PHASE G — PRICE THE CURVE, NOT THE TAPE

**Repository:** `TateLyman/epitaxy`
**Amends:** `DIRECTIVE_..._PHASE_G_COVERAGE_SELECTED_HORIZON.md`
**Predecessor:** PR #62
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `MEASUREMENT_ONLY`.

This addendum reorders Phase G. **§A below becomes the primary section and runs first.**
Phase G's §1 coverage-selected horizon drops to second priority; Phase G's §2 AMM fee-split
reconstruction drops to third. Phase G's §3 collector fix, zero credits, is unchanged and
still ships regardless of everything else.

Reason for the reorder, stated before running: Phase G's §1 attacks a branch whose best
[PDF LOST: the remainder of this sentence, roughly one line, did not survive extraction. What
follows it in the source is the clause below, which begins mid-sentence.]
produced — +234.2% to +394.2%, with 225 cells clearing a 2.50% floor on a day-clustered
lower bound — which are currently undecidable for a reason §A may remove entirely.

## §A — CURVE-STATE PRICING FOR THE PRE-MIGRATION BRANCH

### A.0 The claim being tested

Phase F could not decide the pre-migration branch because 97.5% of censored mints have no
post-entry price and the collector stopped snapshotting them. That is a limitation of
sourcing price from **observed trades**.

A Pump bonding curve is liquid by construction. Its dual-reserve design keeps a sellable
price available even when real tokens are depleted, and its state is a deterministic function
of initial parameters plus the trade sequence. If the state can be reconstructed, an exit
price exists for **every** position at **every** timestamp, and the censoring that blocks
this branch disappears.

This is not a retry of Phase G §2. That failed because `dex_solana.trades` records the
trader's SOL and the protocol/creator fee portions leave the pool unaccounted. On the curve
the fee applies to the SOL leg

```
net_sol = sol_cost - protocol_fee - creator_fee
```

and the **token leg is untouched**, so the token-side roll-forward carries no fee term at
all.

### A.1 Reconstruction

Roll `virtual_token_reserves` forward on token amounts only:

```
buy   virtual_token_reserves -= tokens_out_to_trader
      real_token_reserves    -= tokens_out_to_trader
sell  virtual_token_reserves += tokens_in_from_trader
      real_token_reserves    += tokens_in_from_trader
k     = initial_virtual_token_reserves x initial_virtual_sol_reserves
```

Derive `virtual_sol_reserves` from the invariant rather than from observed SOL. Cross-check
it against the fee-adjusted SOL roll-forward and **report the divergence** — if the two
disagree, one of the two assumptions is wrong and that must surface rather than be averaged
away.

### A.2 The initial parameters are the technical risk — read them, do not assume them

`initial_virtual_token_reserves`, `initial_virtual_sol_reserves`,
`initial_real_token_reserves` and `token_total_supply` live in the **mutable Global account**,
not in the program binary. They have changed and can change again.

Read the Global account state as of **each mint's creation slot**. Record the values used and
the slot they were read at, per mint, in the artifact. A mint whose creation-slot Global state
cannot be established is **excluded and counted**, not defaulted.

Assuming a single constant across the corpus is the exact failure mode that made §2's
roll-forward silently wrong. Do not repeat it in a new place.

Also record the program ID and programdata hash as a fingerprint, as Phase B did for the fee
config. A curve program upgrade is a regime change and invalidates the surface downstream of
it.

### A.3 Validation — same conjunctive bar, no exceptions

Before any use at scale:

1. **Against stored snapshots.** For every pre-migration mint where the collector holds real
   curve account bytes, reconstruct state at that slot from the trade tape and compare.
2. **Against the markable 2.5%.** For the 27 T1 mints that **do** have an observed post-entry
   price, compare the reconstructed curve price at the same timestamp against the traded
   price.

Report, in the Phase F format:

```
                        p10 | p50 | p90 | within 1%
virtual_token_reserves
implied price
```

Stratified by trade count between anchor and target: `1 / 2-5 / 6-20 / 21-100 / 101+`.

**The bar is p50 within 1% AND agreement above 95%.** It is a conjunction. Phase F's tests
already guard against reading it as a disjunction; keep that guard and extend it here.

**This stratified table is also the falsification test.** §2's failure was diagnosed as a
per-trade fee bias. If that diagnosis is right, the token-side roll-forward — which has no fee
term — should show **no drift with trade count**. Flat across all five buckets confirms the
mechanism. Drift appearing anyway means the diagnosis was wrong and something else is
unaccounted, and the report says so rather than reaching for a third estimator.

### A.4 Re-evaluate the pre-migration cells

Only if A.3 passes. Re-run Phase B / Phase F §1 with every position priced from curve state:

```
per trigger T0-T7, per tier, per notional:
  n fired | n now priced | coverage before and after
  as-reported mean | carry-forward mean | curve-priced mean
  day-clustered 95% interval on the curve-priced mean
  net of the 2.50% flat curve floor
  the realised value of the previously-unmarkable positions, stated explicitly
```

That last line is the quantity the whole branch has been undecidable over. Report it whatever
it says, including if it is above the survivors' mean as the 27-mint sample weakly suggested,
and including if it is far below.

### A.5 What A.4 does not establish

State this in the report in these terms:

**Every curve figure is gross of impact.** A bonding curve's impact is mechanical on both legs
and is not in `dex_solana.trades`. A positive result here is an upper bound, not an edge.

**No curve builder exists.** Phase B established the apparatus cannot enter this population. A
positive result is permission to **consider** building one, and nothing more.

**A decidable branch is not a tradable branch**, and the state names must keep them apart.

## §B — PHASE G §1 UNCHANGED, SECOND PRIORITY

Run the coverage-selected horizon exactly as written, including the requirement that `H*` is
committed in a separate execution from the returns.

## §C — PHASE G §2 UNCHANGED, THIRD PRIORITY

Run the AMM fee-split correction only if credits remain after §A and §B. If §A.3's stratified
table comes back flat, that independently corroborates the §2 diagnosis and raises the value
of running §C; if it comes back drifting, §C's premise is already in doubt.

## §D — PHASE G §3 UNCHANGED, SHIPS REGARDLESS

The collector fix. Zero credits, highest ratio of value to cost available, and it repairs the
defect that made §A necessary in the first place.

## FINAL STATE

```
PRE_MIGRATION_CURVE_PRICED:  DECIDABLE_AND_POSITIVE | DECIDABLE_AND_NEGATIVE |
                             RECONSTRUCTION_FAILED_VALIDATION
```

`DECIDABLE_AND_POSITIVE` owes a preregistered confirmatory design and an impact measurement
before any build is considered. It is not permission to trade, not permission to fund, and not
permission to build.

Do not open a window. Do not run canary or live. Do not fund a wallet.
