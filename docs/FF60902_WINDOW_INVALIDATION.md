# The post-`ff60902` window — development data, not confirmatory

Every observation written from `ff60902` through the final repair commit of this
session is **development data**. The rows are preserved, nothing is rewritten,
and the multiple-testing ledger is not reset. What changes is what they may be
used for.

## The window

| item | value |
|---|---|
| source commits | `ff60902` → this session's final commit |
| context hashes | `7952072ac025` (and its predecessors `373b8a1b`, `f0dbf592`, `957d21aa`) |
| opened | 2026-08-12T22:30Z |
| closed for confirmatory purposes | on the repair commit |
| data regime | `delayed-momentum-v0.4.0/10s/build/52d37d3bbcd3` |

## What it contained

| quantity | count |
|---|---|
| execution observations | 1,567 |
| — policy-valid (instruction AND transaction) | 1,338 (85%) |
| — **simulated** | **0** |
| shadow positions opened | 18 (9 `alpha_shadow`, 9 `canary_shadow`) |
| shadow positions closed | 4 |
| shadow marks | 236 |
| portfolio positions opened | **0** |
| portfolio marks | 0 |
| raw payloads retained | 256 (4.6 MB) |
| **PnL reported** | **none, anywhere** |

Unlike the previous invalidation, this window is not empty. It contains real,
useful, exact-size, same-family route observations — which is precisely why it
has to be labelled rather than deleted.

## Why these rows cannot be confirmatory

1. **Nothing was simulated.** Zero of 1,567 observations carry
   `SIMULATED_OK`. Structural buildability and byte-level policy are not
   execution, and the confirmatory contract requires execution.
2. **CI was red for the entire window.** The signer suite failed on Linux from
   the moment CI existed. A decision-bearing commit whose tests do not pass on
   a platform is not a commit anything can be attributed to.
3. **`master` was and remains unprotected.** Branch protection is unavailable
   on a private repository without GitHub Pro, so nothing prevented an unreviewed
   force-push to a commit these rows are attributed to.
4. **Portfolio marks and triggers came from `/order`** while exits were
   attempted through BUILD_CUSTOM. The shadow books are internally coherent —
   entry, marks and exits all BUILD_CUSTOM — but the realizable portfolio path
   is still a hybrid, and §8 is not yet complete.
5. **Shadow entries have no immediate same-family sell.** §7 requires the buy
   and the sell to be requested as a linked round-trip pair before a position
   opens. They are not, so a shadow position can exist whose exit was never
   shown to be constructible at entry time.
6. **Shadow exits omit material costs.** §9.5 requires the full cost set; the
   shadow close path does not yet charge every component the portfolio path
   does.
7. **No signal-episode identity.** §9.2 is not implemented, so a mint
   rescreened every discovery cycle can produce more than one shadow position
   for what is economically one signal. The 18 positions are not proven to be 18
   independent episodes.
8. **Oldest-first shadow scheduling.** §9.4's due-time scheduler does not exist,
   so an accumulating book starves newer positions of marks and the cadence is
   not uniform across the corpus.
9. **Provenance hashes omit new decision-bearing fields.** §3 lists at least
   eleven config fields that change decisions or economics and are absent from
   `strategyConfigHash()`. Two rows with the same hash are not necessarily the
   same experiment.
10. **The priority fee model is wrong by three orders of magnitude.** The config
    assumes 200,000 lamports; the live router price implies ~411 at a 200k
    compute limit. Every cost figure in the window carries that error.
11. **The failed-attempt cost is charged twice** — once on entry and once on
    exit — while being described as a round-trip expectation.
12. **The transaction policy is an estimate.** §5 requires assembling the exact
    v0 bytes and running the strict byte-level policy over them. The current
    check reasons about instructions and estimates a packet size.

## What was NOT done

No result, ranking, threshold or policy from this window was used to design
anything. No PnL was computed from it. `trials` is empty. The shadow books have
never been summed with each other or with the portfolio ledger.

## Status

The window stays open as a **development** instrument and keeps collecting,
because §9 explicitly permits `DEVELOPMENT_STRUCTURAL` shadows to begin before
simulation exists. It is not a confirmatory clock and no confirmatory clock has
been started.

`docs/AUDIT_HEAD_FF60902.md` records the state it began from.
