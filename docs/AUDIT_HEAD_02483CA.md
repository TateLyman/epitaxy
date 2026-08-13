# Audit at 02483ca — the profit-acceleration directive

Baseline captured before any semantic change.

## 1. The machine

| | |
|---|---|
| local HEAD | `02483ca45b2c40a98637f88c01d8bbef5e1c5496` — **identical** to audited |
| branch | `master`, tracking `origin/master`, zero divergence |
| dirty | the directive file only |
| schema | `schema-v24` |
| regime | `delayed-momentum-v0.4.0/10s/build/3e312874938c` |
| database | 2.77 GB, WAL 4.0 MB |
| integrity | ok, 0 foreign-key violations |

WSL `Ubuntu-24.04` running; daemon on `127.0.0.1:8787`, `jitCapable: true`, and
synced to `02483ca` — verified by `git rev-parse`, not by assuming the sync
worked, because it silently had not on the previous attempt.

## 2. Backup

```
sha256     7059d80418cd1228d32afcebf3489f83f6190adcb5c62f50dc38dd976a060704
integrity  ok
witness    execution_observations: 30,912 rows, within [30,912, 30,912]
fk         0 violations
```

## 3. Exposure

**Zero portfolio positions hold tokens.** 161 open shadow positions, none
`EXIT_BLOCKED`.

## 4. The directive's §0.2 findings, verified against the code

Each was checked rather than accepted. **All four confirmed.**

| claim | verification |
|---|---|
| entry implemented separately from `paper-core.ts` | `grep admitPortfolioEntry apps/engine/src/paper.ts` → **no match**. The core's entry function has no production caller. |
| tokens derived from `netMinimumOutput(entry)` | `paper.ts:783` — `const tokensReceived = netMinimumOutput(entry);` |
| round-trip loss computed and only logged | `paper.ts:894–901` — computed, passed to `recordHealth` at `info`, and never compared against `maxRoundTripLossBps` |
| explicit PnL columns not written by runtime | `grep net_pnl_lamports packages/storage/src/repo.ts` → **no match**. Migration 22 added the columns; no writer populates them. |

The last two are the sharpest. The round-trip number is *calculated correctly
and then discarded* — the gate exists, the measurement exists, and nothing
connects them. And the PnL columns are the exact shape of the defect this
directive names: schema migrated, writers not.

## 5. Corpus

30,912 observations. 136 simulation jobs, **zero effect-verified**:

| validity | side | runtime | effect | n |
|---|---|---|---|---|
| `INSTRUMENT_DEVELOPMENT` | sell | `SIMULATION_FAILED` | not checked | 54 |
| `INSTRUMENT_DEVELOPMENT` | buy | `SIMULATED_OK` | not checked | 50 |
| `VALID_DEVELOPMENT` | sell | `SIMULATION_FAILED` | refused | 9 |
| `INSTRUMENT_DEVELOPMENT` | sell | `SIMULATION_UNKNOWN` | not checked | 8 |
| `VALID_DEVELOPMENT` | buy | `SIMULATED_OK` | refused | 6 |
| `VALID_DEVELOPMENT` | sell | `SIMULATED_OK` | refused | 5 |
| `INSTRUMENT_DEVELOPMENT` | buy | `SIMULATION_FAILED` | refused | 4 |

The 8-of-10 effect-verified result lives in the **proof harness**, not in these
rows. The production loop has produced no effect-verified leg, which is the gap
this directive exists to close.

## 6. What this baseline establishes

Nothing about the strategy. It fixes a point before the repair so a later claim
of improvement has something to be measured against, and so a repair that loses
data can be identified as one.
