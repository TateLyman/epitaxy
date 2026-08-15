# Truth reset at `29c7cc7`

**State: `MEASUREMENT_REPAIR_REQUIRED`.**

The previous entry claimed `VALID_TRAJECTORY_KERNEL_RUNNING` on the strength of
twenty completed round trips. That claim is **withdrawn**, and this document
records why, so the withdrawal is auditable rather than a quiet edit.

## What was claimed, and what is actually true

| claimed | actual |
|---|---|
| `VALID_TRAJECTORY_KERNEL_RUNNING` | `MEASUREMENT_REPAIR_REQUIRED` |
| "20/20 complete trajectories" | 20 immediate round trips in a **proof script** |
| the kernel is running | `pnpm trajectory:collect` still prints `NOT OPENING TRAJECTORIES` |

Measured on the live database at this head:

```
development_trajectories rows      0
development_trajectories SETTLED   0
confirmed_migrations              36
schema version                    36
collector refuses to open       true
```

`artifacts/baseline-29c7cc7.json`.

## Why the twenty runs do not qualify

They are real, and they are useful. They are not what the state claimed.

`scripts/live-one-pass-trajectory.ts` produces **immediate** buy → sell → close
round trips. It:

- builds the BUY through Jupiter, not direct PumpSwap;
- uses legacy `captureSnapshot`, not `captureCoherentSnapshotV2`;
- proves the canonical base vault changed, but not that the canonical pool was
  the **sole** entry venue — a split or routed entry would also move it;
- derives wallet economics by hand rather than writing a canonical settlement;
- writes **no trajectory row**;
- collects **no later market path**, so no 15-minute or deterioration exit can
  be evaluated;
- evaluates **no policy**.

Their correct classification is:

```
TRUE_IMMEDIATE_SEQUENTIAL_INSTRUMENT
NOT A DEVELOPMENT TRAJECTORY
NOT A STRATEGY OUTCOME
```

## Where they must not be counted

- trajectory status
- policy sample size
- readiness
- rate throughput
- profitability
- confirmatory evidence

A proof file is not the database. The distinction matters precisely because the
proof file says something true — it is easier to launder a real number into the
wrong column than an invented one.

## What the independent audit did and did not establish

The adversarial audit at this head found ten real defects and all ten are fixed.
But it ran **without the operator corpus** — no `runtime.db`, no RPC, no `.env`,
no collector, no WSL runtime — so eight of its fourteen runtime sections were
`NOT TESTABLE`.

Fixing its pure-code findings **did not** independently validate the twenty proof
rows. Nobody outside this machine has verified them, and the audit's own closing
rule is that promotion requires current clean production rows.

## The one thing that changes this state

The actual collector must write and settle a database trajectory through the full
path: confirmed candidate → coherent snapshot → direct PumpSwap entry →
persistent runtime → canonical entry settlement → later shared mark path → exact
first-valid policy fill → canonical exit settlement → append-only row.

Until then, `MEASUREMENT_REPAIR_REQUIRED` is the honest answer, and a proof
script does not qualify however green it is.
