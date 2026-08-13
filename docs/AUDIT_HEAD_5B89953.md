# Audit at 5b89953 — the effect-labels directive

Baseline captured before any semantic change. `pnpm baseline` →
`artifacts/baseline-5b89953.json`.

## 1. The machine

| | |
|---|---|
| repo path | `C:\Users\lyman\tradseee` |
| local HEAD | `5b89953e48f26c1f6eef35c990ae70100a0b68a7` |
| audited HEAD | identical — no divergence, nothing to preserve or discard |
| branch | `master`, tracking `origin/master` |
| dirty at capture | the directive file and the baseline script only |
| node / pnpm | v24.12.0 / 11.21.0 |
| schema | `schema-v20` |
| data regime | `delayed-momentum-v0.4.0/10s/build/8cf201701d83` |

Windows paper engine: three `node` PIDs, started 11:59 local, stopped for the
backup. WSL `Ubuntu-24.04` running, daemon alive on `127.0.0.1:8787`,
`jitCapable: true`, 208 jobs completed / 75 failed / 2 unknown.

Disk: 894 GB free on Windows.

## 2. Provenance versions in force

```
PROVENANCE_VERSION          provenance-v3
PAPER_ENGINE_VERSION        paper-engine-v4
QUOTE_ADAPTER_VERSION       quote-adapter-v3
COST_ACCOUNTING_VERSION     cost-accounting-v3-unified-cashflow
SIMULATOR_VERSION           simulator-v2-leg-shaped-request
EFFECT_VERIFICATION_VERSION effect-verification-v2-stated-recipients
```

## 3. Backup

```
path       data\runtime.db.backup-2026-08-13T20-51-06-308Z
bytes      2,885,574,656
sha256     275266cbdcc0b23577df4cb0fda01828bee0c080f5a58ed92d9de2c5662f81b5
integrity  ok
witness    execution_observations: 29,844 rows in the backup,
           within [29,844, 29,844] on the source
fk         0 violations
elapsed    34,502 ms
```

`VACUUM INTO` against a read-only handle, read back and checked. The witness
bounds are tight because the writer was stopped first. A live SQLite file copied
without its `-wal` opens cleanly and is missing every transaction since the last
checkpoint — a backup that looks fine, which is the worst failure mode there is.

## 4. Exposure

**Zero portfolio positions hold tokens.** No `HALT_NEW_ENTRIES` is required, and
no position's economic policy needs preserving.

Open shadow positions: 81 `alpha_shadow`, 80 `canary_shadow`. None
`EXIT_BLOCKED`.

## 5. The corpus

29,844 observations. 136 simulation jobs:

| validity | side | runtime | effect | n |
|---|---|---|---|---|
| `INSTRUMENT_DEVELOPMENT` | sell | `SIMULATION_FAILED` | not checked | 54 |
| `INSTRUMENT_DEVELOPMENT` | buy | `SIMULATED_OK` | not checked | 50 |
| `VALID_DEVELOPMENT` | sell | `SIMULATION_FAILED` | **refused** | 9 |
| `INSTRUMENT_DEVELOPMENT` | sell | `SIMULATION_UNKNOWN` | not checked | 8 |
| `VALID_DEVELOPMENT` | buy | `SIMULATED_OK` | **refused** | 6 |
| `VALID_DEVELOPMENT` | sell | `SIMULATED_OK` | **refused** | 5 |
| `INSTRUMENT_DEVELOPMENT` | buy | `SIMULATION_FAILED` | not checked | 4 |

**Zero effect-verified jobs. Zero confirmatory trades.**

The line that matters is the fifth: eleven jobs whose runtime succeeded and
whose economic effect was refused anyway. That is either eleven real trades that
delivered nothing, or an effect verifier that cannot see what the daemon
reported. P2 decides which, and until it does, neither reading may be used.

Shadows: 1,083+, all `STRUCTURAL_ONLY`. Marks: 603, all
`ORDER_QUOTE_BENCHMARK` with `decision_bearing = 0`.

## 6. Integrity

```
PRAGMA integrity_check   ok
PRAGMA foreign_key_check 0 violations
```

## 7. What this baseline establishes

Nothing about the strategy. It establishes what existed before the repair, so
that any later claim about improvement has a fixed point to be measured
against, and so that a repair which loses data can be identified as one.
