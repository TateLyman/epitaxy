# Operator commands

P28. Exact commands for this machine. **Nothing here starts canary or live**,
and `.claude/hooks/guard.mjs` blocks the assistant from either.

## Paper engine (Windows)

```powershell
pnpm paper
```

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*paper.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Restart it after every commit. The engine stamps its source commit at start, and
a run begun from a dirty tree produces `+dirty` rows that can never be
confirmatory.

## WSL simulator

The daemon runs from a **separate clone** at `/home/lyman/epitaxy`, not the
Windows tree. Edits on Windows do not reach it until it is synced — this cost
one debugging cycle, and the symptom was a repair that appeared to do nothing.

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'cd /home/lyman/epitaxy && git fetch -q /mnt/c/Users/lyman/tradseee master && git merge -q --ff-only FETCH_HEAD && echo synced $(git rev-parse --short HEAD) && (pkill -f "apps/simulatord/src/main.ts" || true)'
```

The supervisor restarts it. Confirm before relying on it:

```powershell
curl http://127.0.0.1:8787/v1/health
```

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'ps -eo pid,lstart,args | grep simulatord | grep -v grep'
```

A daemon whose start time predates your sync is running the old code, and a
proof run against it proves nothing.

## Halt new entries; terminate when flat

```powershell
pnpm kill
```

Blocks new entries and attempts policy-compliant exits. A position that cannot
be closed stays `EXIT_BLOCKED` — tokens held, rent locked, exposure retained.
That is correct: releasing capital there books a wallet path that does not
exist.

## Backup

```powershell
pnpm db:migrate
```

`VACUUM INTO` against a read-only handle, read back, integrity-checked, witness
bounds verified, then pending migrations applied. **Stop the engine first** or
the witness bounds widen and the backup is a snapshot of a moving target.

## Inspect effect failures

```powershell
pnpm simulation:audit
```

```powershell
pnpm window:status
```

```powershell
pnpm simulator:pump-effect-proof
```

The proof harness builds fresh routes and simulates them. Its verdict is
`INSTRUMENT failures 0` or it is telling you the apparatus is broken again.

## Inspect mark backlog

```powershell
pnpm rate:budget
```

```powershell
pnpm shadow:status
```

## Monitor cohorts

```powershell
pnpm cohort:status
```

Four arms, never pooled. An arm with no data is not a comparison.

## The gate

```powershell
pnpm readiness
```

`CANARY_READY` or `NOT_READY`, machine-generated. **Do not weaken a failed
gate.** A threshold moved to make a run possible is not evidence about the
strategy; it is evidence about whoever moved it.

## Full check before committing

```powershell
pnpm check
```

typecheck + secretscan + 1,013 tests, in about five seconds. If it hangs, that
is the bug.
