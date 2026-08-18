# One trajectory collector, and how that is enforced

The 8f73cef runtime audit opened with **five `trajectory:collect` daemons — 15
processes — writing to one 7.3 GB database**, while `pnpm health` printed

```
OK engine.collector pid 24924 alive in observe
```

That row was about `apps/collector/src/main.ts`. A *different program*. It shared
the lock name `collector` with the trajectory collector, so a liveness report
about the screening collector read as a liveness report about the writer nobody
was tracking.

## What it cost, measured

```
15 mints exceeded the hard --max-per-mint cap of 3
the worst mint produced 58 trajectories — nineteen times the cap
one mint accounted for a fifth of the entire sample
three of those breaches happened inside 45 minutes
 6 simultaneously live collector sessions at peak
 7 sessions that never wrote ended_utc_ms — they were killed
```

`migrationCandidates()` enforces `COUNT(*) < maxPerMint` correctly. Per cycle, in
the process that asked. Five daemons evaluated it against the same instant and
all five admitted the same mint.

## Four defences, in the order they engage

### 1. An OS lock file, before the database is open

`data/trajectory-collector.pid`, created with `wx` so the create *is* the
exclusion. It covers the window between process start and the database being
open, and it survives a database that was moved or replaced.

It does **not** replace the database lock. A file lock says nothing about who
owns the candidate queue in a corpus reachable by another path.

### 2. A dedicated database lock

```
lock `collector`             apps/collector/src/main.ts             screening
lock `trajectory_collector`  apps/collector/src/trajectory-collect.ts
```

Two programs, two lock names. `pnpm collector:lock-status` reports on the second
only, and `pnpm collector:stop-all` stops the second only — stopping the
screening collector because it contains the word "collector" is the mistake
those commands exist to make impossible.

Acquisition runs entirely inside `BEGIN IMMEDIATE`. A read-then-write across two
statements is the same race that produced 58 trajectories on one mint.

**Takeover rules, and why each is what it is:**

| owner state | verdict |
| ----------- | ------- |
| live pid, live heartbeat | **refuse** — another collector owns this |
| live pid, stale heartbeat | **refuse** — a hung collector is not an abandoned lock. Stop it explicitly. |
| dead pid, fresh heartbeat | **refuse** — it may still be shutting down; do not race it |
| dead pid, stale heartbeat | **take over**, and record that you did |

`process.kill(pid, 0)` throwing `EPERM` means the process EXISTS. Treating EPERM
as dead would let a takeover steal the lock from a running collector owned by
another user.

### 3. Atomic candidate reservation

A process lock gives one WRITER. It does not give a per-mint sampling cap.

`trajectory_reservations` makes the cap a **schema fact**:

```sql
UNIQUE (window_id, mint, reservation_ordinal)
UNIQUE (window_id, mint) WHERE status = 'RESERVED'
CHECK  (reservation_ordinal <= max_per_mint)
```

inside one `BEGIN IMMEDIATE`. A ten-process race takes exactly `maxPerMint`
reservations; the eleventh through the hundredth get `ReservationRefused` naming
which rule refused. `pnpm evidence:graph-check` reports `CAP_NOT_BREACHED` over
the whole window.

A refused candidate **releases** its reservation, so a refusal does not consume
the mint's allowance. A refusal is a fact about the venue, not a sample.

### 4. Provenance, before anything is written

26 of 31 pre-repair sessions were opened from a **dirty tree**. A trajectory
opened from an uncommitted tree cannot be re-derived from its commit, which is
this repository's definition of not being evidence.

```
clean tree   -> DEVELOPMENT_EVIDENCE
dirty tree   -> REFUSE
dirty tree + --instrument-development -> INSTRUMENT_DEVELOPMENT_INVALID
```

The third is quarantine, not permission: that context is excluded from every
report and from readiness, permanently, and cannot be promoted.

## Task Scheduler

A reboot or a double click must not start a second writer. Register the daemon
with **`MultipleInstances = IgnoreNew`**:

```powershell
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "cd C:\Users\lyman\tradseee; pnpm trajectory:collect -- --interval=300 --max-per-mint=3"'
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName 'epitaxy-trajectory-collector' `
  -Action $action -Trigger $trigger -Settings $settings -Force
```

`IgnoreNew` is the load-bearing setting. `-ExecutionTimeLimit 0` means no
timeout, because a collector that is killed mid-cycle is one of the seven
sessions that never wrote `ended_utc_ms`.

**No such task is registered today.** The five daemons were started by hand;
there is no Run key, no Startup entry and no scheduled task capable of launching
the collector. The only registered task is `epitaxy-simulatord`, which is the
WSL simulation daemon and a different program.

## The commands

```
pnpm collector:list          every trajectory-collect process, with its pid tree
pnpm collector:stop-all      stop them, children first, then verify zero remain
pnpm collector:lock-status   who holds the lock, is that pid alive, and is it ONE
```

`collector:lock-status` exits non-zero when the single-owner property does not
hold, so it can gate a start script rather than being read by a human.
