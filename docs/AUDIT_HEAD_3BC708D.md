# Audit at 3bc708d

Taken before any semantic change.

## 1. The machine

| | |
|---|---|
| local HEAD | `3bc708d8ef6083989087efeb3158b34ea51ac799` — **identical** to audited |
| branch | `master`, 0/0 against `origin/master` |
| dirty | none |
| unpushed | none |
| schema | `schema-v27` |
| paper engine | pid 15008, started 19:39:05, **stopped during this audit** (see §3) |
| Surfpool daemon | `127.0.0.1:8787`, responding |
| WSL clone | `/home/lyman/epitaxy` at `3bc708d` |
| Rust worker | `offline-worker/target/release/epitaxy-offline-worker`, 18,126,152 bytes |
| disk | 862 GB free of 1.9 TB |

## 2. Backup

`VACUUM INTO`, then every number below read back **from the copy**.

```
path       data/backups/baseline-3bc708d-2026-08-14T03-43-23-247Z.db
bytes      5,960,482,816
sha256     2c3f2d099d13d43fd42aeb550f877569e5928c47056047229478faf79bebd6ed
integrity  ok
fk         0 violations
wal        checkpointed 1000/1000, busy 0
mismatch   none — every table count on the copy equals the original
witness    0 positions holding tokens
```

`artifacts/baseline-3bc708d.json`.

## 3. The finding that stopped the engine

The direct event stream added in the previous directive is **destroying the
corpus it was meant to inform**.

```
direct_chain_events      6,981,407 rows
window                   110.9 minutes
rate                     1,055 events/second
projected                91,000,000 rows/day
database                 2.97 GB -> 6.15 GB during this session
```

By kind:

| kind | rows | share |
|---|---|---|
| UNKNOWN | 4,749,409 | 68% |
| OTHER | 1,225,557 | 18% |
| TRADE | 1,047,319 | 15% |
| MIGRATION | 43 | 0.0006% |

Two thirds of what it writes is a log block whose instruction it could not
name, persisted synchronously to the authoritative research database. The
engine was stopped at this point in the audit, before the backup, because the
database is the research corpus and it is not reproducible.

P8 of this directive names exactly this. It is not a capacity problem to be
solved with a bigger disk: 43 migration events out of seven million rows is the
whole decision-useful yield.

## 4. Exposure

**None.** 20 portfolio positions, all closed, zero holding tokens. 165 open
shadow positions, which bear no capital. `HALT_NEW_ENTRIES` therefore not
required.

## 5. Corpus

```
execution_observations   35,110
simulation_jobs             174
  effect-verified            23
positions                    20
  holding tokens               0
  net_pnl written              0
shadow_positions (open)     165
confirmatory_positions_v2     0
```

23 effect-verified legs, up from 0 at the start of the previous directive.
**Zero** rows carry the explicit PnL fields, because no position has opened
under the repaired code — the mechanics floor blocks entry (see
`docs/STATEFUL_SIZE_SURFACE.md`).

## 6. A report that disagrees with its own artifact

| | attempted | complete | unknown cost | market failures |
|---|---|---|---|---|
| `docs/STATEFUL_ROUNDTRIP_PROOF.md` | 25 | 5 | 20 | 3 |
| `artifacts/stateful-roundtrip-proof.json` | 22 | 5 | 12 | 5 |

Both describe "the" run. The proof was executed several times while the
candidate ordering was being changed; the artifact was overwritten each time
and the prose was not. Nothing bound them.

This is a provenance defect of the same family as the rest of this directive:
two representations of one fact, with no mechanism forcing them to agree. The
repair is not to retype the numbers — it is to generate the prose figures from
the artifact, and to stamp every artifact with the commit that produced it.

## 7. What this baseline establishes

Nothing about the strategy. It fixes a point before the repair so that a later
claim of improvement has something to be measured against, and so a repair that
loses data can be identified as one.
