# Audit — local tree against `1c499cd`

## Reconciliation

| | |
|---|---|
| audited head | `1c499cdf0d2b5381f31e1ffe842eb32d16101846` |
| local HEAD | **identical** |
| working tree | clean |
| unpushed | 0 |
| node / pnpm | v24.12.0 / 11.21.0 |
| WSL | Ubuntu-24.04, Running, v2 |

Nothing local was newer than the audited head, so nothing had to be preserved.

## Backup

```
path       data/backups/baseline-1c499cd-2026-08-14T19-37-47-409Z.db
bytes      6,800,842,752
sha256     6d2a9ec3bec0e68f78adcb3018b999274738d4aaef93365d9dbaa1baeefccca2
integrity  ok        fk 0 violations
mismatch   none — every table count on the copy equals the original
witness    0 positions holding tokens, 173 shadows holding tokens
```

Taken with `VACUUM INTO`, which reads one transaction's view and writes a fresh
database with no WAL of its own. The engine was stopped before the copy. Every
figure above was read back **from the copy**.

`artifacts/baseline-1c499cd.json`.

## Corpus state

```
schema           v34
observations     41,786
screenings       567,816       eligible 1,255
direct mint facts 41,641       entity concentration 42     mayhem 48
closed positions  20           all POSITION_CLOSED, none holding tokens
```

**Valid completed production trajectories: 0.** Confirmed, not assumed.

## The deadlock is real, and it is the binding constraint

Finding **E** predicted it. The corpus proves it.

```
AWAITING_FILL_OBSERVATION   165
EXIT_BLOCKED                  4
POSITION_OPEN                 4
POSITION_CLOSED           1,038   ← all pre-P6, all void
```

**169 trajectories have been waiting 3.0 to 4.6 hours.** Not one has completed
through the repaired lifecycle: `fill_latency_ms IS NOT NULL` returns **0 rows**.

The blocked reason states the cause exactly:

> 96 later observation(s) exist and none is a valid fill: 0 cross-family,
> **96 not effect-valid, 96 unpriced**

383 marks have been recorded *after* a trigger. None became a fill.

### Two independent causes

**1. No mark observation is ever simulated.** Every mark's
`simulated_effect_ok` is `NULL` — there is no simulation job for any of them.
`resolveFill` requires an effect-valid candidate, and nothing in the loop ever
makes one. The loop asks for something it never produces.

```
marks with an observation   39,736
marks with a simulation job          0
```

**2. 93% of marks have no exit route at all.**

```
route_available = 0   36,842   (unpriced)
route_available = 1    2,894
```

The router cannot build a sell for most of these tokens, so even a working
simulation path would leave the large majority unpriced. This is a fact about
the venue, not the apparatus, and it is the strongest argument for the
directive's own priority: the kernel must use the **direct PumpSwap builder on
confirmed migrations**, not a router that declines 93% of exits.

Fixing (1) alone unblocks at most the 2,894 priced marks. Fixing (1) and moving
the mark stream to the direct builder is what makes the lane work.

## Findings A–N

Each was checked against this tree rather than taken on faith. Every one is
confirmed; the ones with live evidence above are E (deadlocked fills) and the
zero-trajectory headline. The remainder are structural and are addressed in the
work that follows this document.
