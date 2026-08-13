# Local state audit

Taken at 2026-08-13T15:39:11.594Z in mode `paper`.

## Repository

```
path            C:\Users\lyman\tradseee
remote          https://github.com/TateLyman/epitaxy.git
branch          master
HEAD            27601b410359929968fcdfed888b6e719c8a3b75
dirty files     4
                M docs/AUDIT_HEAD_4890AF0.md
                 M packages/storage/src/backup.ts
                 M tests/unit/truth-repair.test.ts
                ?? epitaxy_4890af0_profitability_truth_directive.md
node            v24.12.0
```

## Runtime database

```
runtime.db  2536185856 bytes  mtime 2026-08-13T15:39:04.029Z
runtime.db-wal  9706752 bytes  mtime 2026-08-13T15:39:08.993Z
runtime.db-shm  32768 bytes  mtime 2026-08-13T00:52:03.270Z
```

### Verified online backup

```
path        C:\Users\lyman\tradseee\data\backups\audit-2026-08-13T15-39-11-660Z.db
bytes       2509283328
sha256      9b519461035f3a953a308b23321b278a3689f59ff11e6b68f693bfa4c5a923ba
integrity   ok
fk check    0 violation(s)
staleness   screenings 382556 <= 382556 <= 382556 (verified)
elapsed     18253 ms
```

### Schema

```
applied         11 (11 migrations)
in code         15
state           BEHIND by 4: the live engine predates migration(s) 12/simulation_jobs, 13/exact_transaction_blob, 14/age_cohorts, 15/reject_outcome_classification
```

### Exposure

```
portfolio positions holding tokens and not closed: NONE
  all portfolio positions  POSITION_CLOSED  20
  shadow alpha_shadow  POSITION_CLOSED  37
  shadow alpha_shadow  POSITION_OPEN  442
  shadow canary_shadow  POSITION_CLOSED  37
  shadow canary_shadow  POSITION_OPEN  441
```

### Corpus

```
execution_observations   23637
  simulated OK           0
signal_episodes          826
positions                20
shadow_positions         957
fills                    40
run_contexts             9
simulation_jobs          TABLE ABSENT
  BUILD_CUSTOM           NOT_SIMULATED    23637
  purpose alpha_shadow_mark                10932
  purpose canary_shadow_mark               10917
  purpose canary_shadow_entry              479
  purpose alpha_shadow_entry               479
  purpose canary_shadow_entry_roundtrip    413
  purpose alpha_shadow_entry_roundtrip     413
  purpose verification                     4
```

## Processes

```
engine    pid=28880 mode=paper heartbeat 6s ago
wsl       up distro=Ubuntu-24.04
  sha     27601b410359929968fcdfed888b6e719c8a3b75
  dirty   0 file(s)
  daemon  3888
  node    v24.16.0
  disk    /dev/sdd       1007G   40G  916G   5% /
```

## Clocks

```
windows   2026-08-13T15:39:30.635Z
wsl       2026-08-13T15:39:30.803Z
offset    168 ms (wsl - windows)
```

## Simulator

```
health    {"ok":true,"active":0,"queued":0,"inFlightJobs":0,"oldestQueueAgeMs":0,"jobsCompleted":3,"jobsFailed":2,"jobsUnknown":0,"medianStartupMs":157,"medianSimulationMs":94,"maxActiveSurfnets":1,"queueLimit":16,"jitCapable":true}
identity  {"error":"unauthorized"}
```

## Config

```
mode                        paper
strategyConfigHash          47fff3ee9289a79f0e4e4a0d62ca411e784227af54c1666ee26587bac85500d1
riskPolicyHash              ffc23e18a594a61ab5cd2ee8ed970514830f70172a0e3b6afcd7508e94ea67e2
dataRegimeId                delayed-momentum-v0.4.0/10s/build/95b789a5f3d3
sourceCommit                27601b410359929968fcdfed888b6e719c8a3b75+dirty
assumedPriorityFeeLamports  8000
requireLocalSimulation      true
paperStartLamports          10000000000
```

