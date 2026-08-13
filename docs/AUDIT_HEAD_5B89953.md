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

---

# Final report

## What was repaired

Seventeen defects. Every one was found by running the system, not by reading it.

| id | defect |
|---|---|
| `S052` | Token balances keyed by account pubkey at one end, `owner:mint` at the other |
| `S053` | A mint decoded as a token account (`>= 72` bytes; a legacy mint is 82) |
| `S054` | The taker's own ATA truncated out of the 64-account watch window |
| `S055` | The sell credit had two values |
| P3 | A token→SOL sell checked through `minTokenDelta` |
| P4 | Amounts above 2^53 could not be simulated at all |
| P5 | The priority fee suppressed on **every** run |
| P7 | JIT snapshots exported and never persisted |
| P9 | `paper.ts` and `paper-core.ts` were two implementations |
| P13 | Readiness subtracted the principal twice; its cost stress subtracted it again |
| P14 | One definition of confirmatory living in five places |
| P16 | Token-2022 extensions treated as though they did not exist |
| P17 | Three decision-bearing modules with no caller |
| P18 | Three of four cohort arms could never receive data |
| P10 | The trigger observation was its own fill |
| P11 | A shadow could close at its trigger; evidence could be rewritten |
| P19 | Every unquoted token counted as −100% |

## P6 is satisfied

```
buys 5, effect-ok 4 · sells 5, effect-ok 4 · 8/10
INSTRUMENT failures 0   (required: 0)
```

Eight verify; two refuse with complete, specific explanations. At the start of
this session there were **zero** effect-verified legs in this repository's
history.

## The two that would have mattered most

**Readiness was describing a strategy that does not exist.** `realized_lamports`
already holds the net result and the gate computed `realized - cost`. A position
that cost 20,000,000 and made 1,000,000 scored as a **19,000,000 loss** — and
profit factor, log growth, drawdown and every robustness check inherited it. Its
2× cost stress removed the whole basis rather than the 13,000 of execution cost,
so no strategy could ever have passed it.

**`paper.ts` never imported `paper-core.ts`.** The behavioural tests executed one
implementation and the engine executed another, with nothing to report the
divergence. That is the source-substring failure arriving from the other
direction.

## Corrections made to my own earlier claims

- The **80.7% immediate round-trip loss** was double-counted rent. It was
  arithmetic of mine, not a measurement, and must not be quoted.
- "Output delta is missing" fired for both *unobserved* and
  *observed-but-negative*, filing the market's answer as our failure.
- One commit landed with a recycled message about "preregistering P2b"; amended.

## Open

**`S050`** — Pump offline replay. `soPath` landed and the failure was unchanged,
which **rules out** N-API marshalling and the 38.5 MiB body. It is
`surfnet_writeProgram` dropping its RPC on a 10.5 MB program, one layer below
this daemon. Needs a pinned Rust Surfpool worker or LiteSVM. Until then Pump is
capped at `JIT_EFFECT_VALID` and `CONFIRMATORY` is unreachable for it.

**Not done:** P15 (PumpSwap canonical-pool parity), P20–P24.

## Numbers

| | |
|---|---|
| tests | 1,005 pass, 4 skipped, 64 files |
| secretscan | clean |
| schema | v24 |
| backup | `275266cb…`, integrity ok, witness bounds tight |
| confirmatory positions | 0 |
| effect-verified legs | 8 (proof harness) |

## State

```
MEASUREMENT_REPAIR_REQUIRED
```

The repair succeeded and P6 is met. The state is not `VALID_EFFECT_LABELS_RUNNING`
because no evidence window has been started on the repaired instrument, and not
`PUMP_CONFIRMATORY_COLLECTION_STARTED` because `S050` makes confirmatory
collection impossible for Pump today.

Nothing was funded, signed, submitted, or run as canary or live. No threshold was
tuned on invalid labels. No NAV was raised and no risk cap loosened.

## Three more, added after the report above was first written

**P10 — the trigger observation was its own fill.** A stop that triggers at T
and fills at T's price is a backtest that reacts instantly and at no cost. The
bias runs one way: the faster the price falls, the larger the gap, so filling at
the trigger made every stop look like it worked and every collapse look
survivable. Fills now take the first later observation past a frozen 1,200 ms
latency that is same-family, effect-valid in its own right, and priced.
`lookAheadBiasLamports` reports what the instant fill would have been worth, so
the bias has a size rather than a reputation.

**P11 — a shadow could close at its trigger, and evidence could be rewritten.**
The state machine now makes the first unrepresentable. The second mattered more:
a shadow opened when nothing was effect-verified would silently become valid the
moment a later run of the same observation passed, and the corpus would improve
its own past. Evidence is appended; a demotion is refused outright, because an
earlier claim being wrong is a correction and must be made deliberately.

`nearTrigger` was peak alone — which made the position *least* likely to need
attention look the most urgent. It now takes the minimum distance to stop,
trail, take-profit and maximum hold, with an unpriced position sorting first: one
nobody can value is one nobody can exit.

**P19 — every unquoted token counted as −100%.** The reasoning was survivor
bias and the concern is real, but it fixed one bias by installing its mirror
image. A pool that drained and a provider that went quiet are different events;
only the first three outcomes are losses. `PROVIDER_MISSING` and `SOURCE_GAP` are
now excluded and reported beside the distribution. Reading an outage as a total
loss makes every gate look brilliant — the things it rejected all "went to
zero" — and the error is largest exactly where the data is thinnest, which is
where a rejected token is most likely to be.
