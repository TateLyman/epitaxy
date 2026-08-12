# P2b window — invalidated

The confirmatory window opened by `docs/P2B_PREREGISTRATION.md` is **not a valid
confirmatory window** and is reclassified as development data.

Its rows are preserved. Nothing is rewritten, nothing is deleted, and the
multiple-testing ledger is not reset. What changes is what the rows are allowed
to be used for.

## The window being invalidated

| item | value |
|---|---|
| preregistration commit | `4ef1079` |
| window opened at commit | `3155ea7` |
| context hash | `373b8a1bc609…` |
| data regime | `delayed-momentum-v0.3.0/10s/build/ab9681aec27a` |
| opened | 2026-08-12T20:33Z |
| closed | 2026-08-12T21:31Z |

## What it actually contained

| quantity | count |
|---|---|
| signals refused by portfolio caps | 5 |
| positions opened | **0** |
| marks written | **0** |
| build attempts | **0** |
| closed rows | **0** |
| raw payloads retained | **0** |

**The window is empty.** It ran for under an hour and never opened a position, so
invalidating it destroys no observation. This matters for honesty in both
directions: nothing of value is lost, and nothing about the invalidation should
be read as a costly sacrifice.

The 20 closed positions, 603 marks and 2545 quotes that exist in the database all
predate the window entirely and were already permanently development data — no
retained raw payload, no build-validated leg.

## Why it cannot compare its four policies fairly

Each of these was identified **after** the preregistration was frozen. They are
listed in the order they invalidate.

### 1. The route family is a hybrid

Entries were priced from `/swap/v2/order`, where all routers compete and the
Jupiter platform fee is included in the quote. Buildability was proved from
`/swap/v2/build`, which is Metis-only, has a different fee model, and may return
a different route at a different amount.

A price from one route and a build from another do not form an executable trade.
Every "build-validated" fill the window would have produced would have been a
claim about two different trades.

### 2. Entries were priced at probe size and scaled linearly

The 0.05 SOL probe quote's `otherAmountThreshold` was multiplied by
`lamportsIn / probe`. Impact is not linear in size, and the direction of the
error is the flattering one at any size below the probe. The exact-size route was
never requested.

### 3. The included platform fee was deducted a second time

`/order` states that its platform fee is included in the returned amounts and
deducted automatically. The engine then multiplied by `(1 - feeBps)` again. Entry
token amounts were therefore understated by the fee — conservative, but wrong,
and wrong in a way that makes the cost model unverifiable.

### 4. Alternative policies had no fills at their own trigger times

Exit builds were requested only when the **control** policy wanted out. Policies
B, C and D trigger at different marks, and at those marks no build-valid
observation exists. A counterfactual comparison in which three of four arms
cannot fill at their own decision points is not a comparison.

### 5. An unbuildable exit still closed the position and released capital

When the exit build failed the engine recorded the diagnostic, closed the
position, realized the PnL and returned the capital to the free balance. That is
not a wallet path that exists. The correct outcome is `EXIT_BLOCKED` with the
capital still committed.

### 6. `EXIT_BLOCKED` positions were never managed again

`openPositions()` filters on `state IN ('POSITION_OPEN','EXIT_INTENT')`. A position moved to
`EXIT_BLOCKED` therefore disappeared from marking, from exit management, from
exposure, and from every health surface — while still nominally holding tokens.

### 7. Resync could clear without a successful re-observation

After a clock discontinuity the gate cleared when `PRAGMA integrity_check`
returned `ok`. Integrity of the database says nothing about whether any open
position was successfully re-quoted. A provider outage during a resume would have
re-enabled entries without a single fresh observation.

### 8. Entry gating still applied `Math.abs` to the signed impact field

`packages/intelligence/src/gates.ts` — the defect that this project has removed
from exit accounting twice still sat in the entry path, so the gate could not
distinguish a favourable move from an adverse one of the same magnitude.

### 9. Instruction-set hashes ignored account privileges

The hash covered program ID, data and account pubkeys, but not `isSigner` or
`isWritable`. Two instruction sets differing only in who signs or what is
writable — a security-relevant difference — hashed identically.

### 10. Provider errors collapsed to `null`

`JupiterClient.build()` returned `null` for every `SourceFetchError`, so a 429, a
timeout, a schema drift and a genuine no-route were indistinguishable in the
stored record.

### 11. The multiple-testing surface was 112 cells

4 policies × 7 sizes × 4 ATA-recovery treatments, against a 50-trade selection
gate. That grid cannot be selected over reliably at that sample size, and the
preregistration should not have offered it.

### 12. Alpha shadow was a label, not a book

A refused signal wrote a row saying it was refused. No shadow position was opened
and none was tracked to an exit, so the loss-dependent censoring the shadow ledger
exists to remove was not removed.

## What was NOT done

**No threshold, ranking, or result from this window was used to design its
replacement.** The window produced zero positions and zero marks, so there was no
outcome to look at even if someone had wanted to. Policies A–D were never ranked;
`scripts/` contains no ranking output; `trials` is empty.

The four preregistered policies remain recorded in
`docs/MULTIPLE_TESTING_LEDGER.csv` as MT018–MT020 with status `preregistered`.
They are **not** carried forward automatically. Any policy in a future window is a
new ledger row, because a policy re-offered after a redesign of the measurement is
a new test.

## Status of the context

Closed. The engine was stopped with `TERMINATE_WHEN_FLAT` while flat, so no
position was orphaned by the closure.

A new context, schema/accounting version and preregistration may only be created
after the repairs in P2–P16 land, from a clean tree, with a start timestamp later
than the final repair commit and a clean process restart.
