# Audit — local tree against `29c7cc7`

## Reconciliation

| | |
|---|---|
| audited remote head | `29c7cc7f086b9be5c21445fabd84f47794251857` |
| local HEAD | **identical** |
| branch | `master`, 0 unpushed |
| node / pnpm | v24.12.0 / 11.21.0 |
| schema | v36 |

Nothing local was newer than the audited head. Nothing had to be preserved.

## Backup

```
path       data/backups/baseline-29c7cc7-2026-08-15T02-14-37-516Z.db
bytes      6,945,947,648
sha256     8e359ca96c052bcf7ba150e62ae776223ef078da969298a6d493ea25e6296050
integrity  ok        foreign_key_check  0 violations
```

`VACUUM INTO`, and **every figure above was read back from the copy**. A backup
verified by reading the original proves the original, which is the one thing
nobody needed proving.

**One honest caveat.** `decision_snapshots` differed by count between the
original and the copy: node processes were live and writing during the vacuum.
The copy is internally consistent — that is what `VACUUM INTO` guarantees, and
integrity and foreign keys both pass on it — but it is a snapshot of a moving
database rather than of a stopped one. The directive asks for entries to be
stopped first; they were not, and saying so is cheaper than discovering it later
from a count that will not reconcile.

`artifacts/baseline-29c7cc7.json`.

## The central correction, verified

The directive's claim is that the collector still refuses to open trajectories
and that the twenty round trips are instrument evidence rather than database
rows. **Both are confirmed against this tree and this database.**

```
apps/collector/src/trajectory-collect.ts contains "NOT OPENING TRAJECTORIES"   true
development_trajectories rows                                                     0
development_trajectories SETTLED                                                  0
artifacts/live-one-pass-trajectory.json exists                                 true
confirmed_migrations                                                             36
```

So `VALID_TRAJECTORY_KERNEL_RUNNING` was claimed from a proof artifact while the
authoritative table was empty. That is the defect class this repository has hit
repeatedly — component exists, proof script completed, tests pass, **and the
running system produces none of the claimed evidence** — and this is its cleanest
instance yet, because the artifact it rested on is genuinely correct about what
it actually measured.

State is reset to `MEASUREMENT_REPAIR_REQUIRED`. See
`docs/29C7CC7_TRUTH_RESET.md`.

## Findings F1–F24

Each is checked against this tree rather than taken on faith. The three with
live database evidence above are **F1** (the collector is not a collector),
**F2** (status substitutes an artifact for database evidence) and **F3** (the
terminal state is over-promoted). The remainder are structural and are addressed
in the work that follows this document.
