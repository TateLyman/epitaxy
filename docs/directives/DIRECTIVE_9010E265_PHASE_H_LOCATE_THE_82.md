<!--
  RECEIVED 2026-08-19 as 9010e265-epitaxy_phase_h_locate_the_82.pdf, immediately after PR #64
  merged.

  THIS IS A TRANSCRIPTION, NOT THE ORIGINAL BYTES. The source is a PDF and this repository's
  convention for PDF directives is to transcribe faithfully and mark what the PDF lost rather
  than to reconstruct it. Two losses are marked inline with [PDF LOST: ...]; both are glyph
  damage in a single sentence and a single bullet, and in each case the surviving fragments
  are quoted rather than smoothed over. Nothing outside those markers has been reworded,
  reordered or summarised. The extractor's glyph substitutions for em-dashes, section signs,
  apostrophes, minus signs and list bullets have been restored to their evident intent, and
  nothing else. One ordering artifact is noted where it occurs: the extractor emitted §3's
  third bullet and §5's state block interleaved, and they are restored to the only reading
  the surrounding text admits.

  The original PDF is at
  C:\Users\lyman\.claude\uploads\894f4318-dc1d-438d-8486-f41554eb8276\9010e265-epitaxy_phase_h_locate_the_82.pdf

  Execution record: docs/PHASE_H_REPORT.md.
-->

# CLAUDE CODE DIRECTIVE — EPITAXY PHASE H: LOCATE THE 82%

**Repository:** `TateLyman/epitaxy`
**Predecessor:** PR #64, `PRE_MIGRATION_CURVE_PRICED: RECONSTRUCTION_FAILED_VALIDATION`
**Date:** 2026-08-19

**Forbidden, unchanged:** canary, live, funding a wallet, signing, submitting, weakening any
capital gate, weakening §19 after seeing results, claiming profitability. `CANARY_READY`,
`LIVE_READY`, `PROFITABLE` remain forbidden outputs. `MEASUREMENT_ONLY`.

**Credits: 664 remain of 2,500.** Target 150, stop-and-report ceiling 300, per-query 250.
This is a small phase. Do not let it grow.

## 0 — WHY

PR #64 established two things that hold regardless of whether curve pricing works:

- 999 of 5,598 T1–T7 holdout positions [PDF LOST: a fragment of roughly four characters
  between "positions" and "17.8%" did not survive extraction; the surviving text reads
  "positions17.8%\e on a pump.fun bonding curve", whose evident intent is "— 17.8% — are on
  a pump.fun bonding curve"] The other 82% are other launchpads and unaffiliated tokens
  admitted by Jupiter discovery.
- On the curve subset, T1's as-reported mean is −32.47%, against the +234.2% the branch is
  named for.

The positive figures therefore belong to a population that has never been identified. Every
prior description of them — "the pre-migration bonding-curve means", "the only positive
number in the programme" — attached a venue label that is wrong for four fifths of the data.

This phase does not try to rescue the number. It finds out what it is a number *about*. A
discovery artifact and a real venue-specific effect are both possible and they are
distinguished by the same query.

## 1 — CLASSIFY

For every T0–T7 holdout position, resolve the venue of the **entry** leg:

- pump.fun bonding curve
- pumpswap
- each other launchpad present, named individually — do not bucket as "other"
- raydium / meteora / orca / any established AMM
- unresolved

Resolve by program ID from the entry instruction, not by heuristic on the mint address
suffix. Report the program ID and its count even where the program is unrecognised — an
unrecognised program with meaningful volume is a finding, not a residual.

Report, per venue:

```
n positions | share of positions | share of the summed return
```

That third column is the one that matters. If a small venue carries most of the summed
return, name it.

## 2 — RE-CUT THE TRIGGER MEANS BY VENUE

Re-run the Phase B / Phase F §1 trigger table stratified by the §1 classification. For each
trigger × venue:

```
n | as-reported mean | carry-forward mean | residual-at-zero mean
day-clustered 95% interval
censoring fraction
applicable cost floor for THAT venue, or UNKNOWN
```

**Cost floors are venue-specific and mostly unknown.** The 2.50% flat curve figure and the
2.669%/tier PumpSwap schedule apply to two venues. For every other venue the floor is
`UNKNOWN` and must be reported as such — never defaulted to a neighbour's number, and never
omitted so that a gross figure reads as net.

## 3 — THE DISCOVERY-ARTIFACT CHECK

If the positive return concentrates in the **unaffiliated** or **unresolved** classes, test
whether it is an artifact of thin data rather than a property of the market:

```
per venue class:
  median trades per mint over the holding period
  median distinct traders per mint
  fraction whose entry and exit price come from the same trade
```

A population whose returns are computed from two or three trades per mint does not have a
mean in any useful sense. If that is what the 82% is, say so plainly and the branch closes
on `DISCOVERY_ARTIFACT` — which is a real result and closes it for a better reason than
censoring ever could.

## 4 — WHAT THIS PHASE MAY NOT DO

- No curve re-pricing. §A failed validation in #64 and is closed.
- No new triggers, cohorts, thresholds, or size definitions.
- No cost floor invented for a venue whose fee schedule has not been decoded. `UNKNOWN` is
  the correct output and is not a gap to be filled by analogy.
- No claim that a venue is tradable. Identifying a venue says nothing about whether the
  apparatus can enter it, and Phase B's builder constraint is unchanged.

## 5 — FINAL REPORT

1. §1 classification table, program IDs included, unrecognised programs named
2. §2 trigger means by venue, with venue-specific floors or `UNKNOWN`
3. §3 thin-data diagnostics per venue class
4. a one-line statement of where the +234.2% to +394.2% actually lives
5. credits per query
6. ledger diff
7. one final state:

```
VENUE_LOCATED            a named venue carries the positive return with non-thin data;
                         owes a fee-schedule decode and a cost floor before anything else
DISCOVERY_ARTIFACT       the positive return is concentrated in thin-data or unresolved
                         mints and does not survive the §3 checks
DIFFUSE_NO_VENUE         spread across venues with no concentration; the figure is not
                         about anything nameable
```

`VENUE_LOCATED` is not permission to trade, not permission to build, and not an edge. It is
permission to decode one fee schedule and compute one cost floor.

Do not open a window. Do not run canary or live. Do not fund a wallet.
