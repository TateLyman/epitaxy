# Local state audit

Taken at 2026-08-13T03:14:57.550Z in mode `paper`.

## Repository

```
path            C:\Users\lyman\tradseee
remote          https://github.com/TateLyman/epitaxy.git
branch          master
HEAD            4890af0ea4686152d987ea62a3d41727d5476886
dirty files     4
                M packages/storage/src/db.ts
                ?? epitaxy_4890af0_profitability_truth_directive.md
                ?? packages/storage/src/backup.ts
                ?? scripts/audit-state.ts
node            v24.12.0
```

## Runtime database

```
runtime.db  1634828288 bytes  mtime 2026-08-13T03:14:51.279Z
runtime.db-wal  9706752 bytes  mtime 2026-08-13T03:14:56.885Z
runtime.db-shm  32768 bytes  mtime 2026-08-13T00:52:03.270Z
```

### Verified online backup

```
path        C:\Users\lyman\tradseee\data\backups\audit-2026-08-13T03-14-57-615Z.db
bytes       1618313216
sha256      0403e9989b70d947fa3822b443374f34bb872007fb22f2314115b8ebaa8b20ea
integrity   ok
fk check    0 violation(s)
staleness   screenings 249495 <= 249495 <= 249495 (verified)
elapsed     11304 ms
```

### Schema

```
applied         11 (11 migrations)
in code         12
state           BEHIND by 1: the live engine predates migration(s) 12/simulation_jobs
```

### Exposure

```
portfolio positions holding tokens and not closed: NONE
  all portfolio positions  POSITION_CLOSED  20
  shadow alpha_shadow  POSITION_CLOSED  37
  shadow alpha_shadow  POSITION_OPEN  91
  shadow canary_shadow  POSITION_CLOSED  37
  shadow canary_shadow  POSITION_OPEN  90
```

### Corpus

```
execution_observations   6721
  simulated OK           0
signal_episodes          124
positions                20
shadow_positions         255
fills                    40
run_contexts             9
simulation_jobs          TABLE ABSENT
```

## Processes

```
engine    pid=28880 mode=paper heartbeat 2s ago
wsl       up distro=Ubuntu-24.04
  sha     a4375f50abaa0ae1506cade014b8506ff27ab868
  dirty   0 file(s)
  daemon  23099
  node    v24.16.0
  disk    /dev/sdd       1007G   40G  916G   5% /
```

## Clocks

```
windows   2026-08-13T03:15:09.561Z
wsl       2026-08-13T03:15:09.729Z
offset    168 ms (wsl - windows)
```

## Simulator

```
health    {"ok":true,"inFlight":0,"jobsRun":1,"queueLimit":16}
identity  {"protocolVersion":2,"sourceSha":"a4375f50abaa0ae1506cade014b8506ff27ab868","lockfileHash":"dbce864412beac7c52356f0a70c726aa4cd0f04ba4f381931bc8159f45300c8a","surfpoolPackageVersion":"1.5.0","surfpoolBinaryHash":"98977c262bd0eaaedd6bcc5063df2379e8999100bec0f1e5faa57c0a76026be2","nodeVersion":"v24.16.0","runtimeVersion":"4.1.2","featureSet":"3345198602","accountSnapshotSchemaVersion":2,"platform":"linux/x64"}
```

## Config

```
mode                        paper
strategyConfigHash          718670ab0478544bd79b78b26fb0bd57580579e9cc42be65f3a430972eb2a56d
riskPolicyHash              ffc23e18a594a61ab5cd2ee8ed970514830f70172a0e3b6afcd7508e94ea67e2
dataRegimeId                delayed-momentum-v0.4.0/10s/build/5774139c5490
sourceCommit                4890af0ea4686152d987ea62a3d41727d5476886+dirty
assumedPriorityFeeLamports  200000
requireLocalSimulation      true
paperStartLamports          10000000000
```

