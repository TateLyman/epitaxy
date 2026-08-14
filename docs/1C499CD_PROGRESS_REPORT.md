# Progress report — `1c499cd` trajectory kernel directive

**This is a partial execution.** The directive has 22 sections; three are done.
What was done is the critical path — the audit, the defect that was preventing
*every* trajectory from completing, and the exploration state — and the rest is
named below rather than implied.

## 1. SHAs

| | |
|---|---|
| audited head | `1c499cdf0d2b5381f31e1ffe842eb32d16101846` |
| local at start | **identical**, clean tree, 0 unpushed |
| commits added | `d2b3fbf` baseline · `3847744` P9 deadlock · `2c4e009` finding G |

Nothing local was newer than the audited head, so nothing needed preserving.

## 2. Backup (P0) — DONE

```
path       data/backups/baseline-1c499cd-2026-08-14T19-37-47-409Z.db
bytes      6,800,842,752
sha256     6d2a9ec3bec0e68f78adcb3018b999274738d4aaef93365d9dbaa1baeefccca2
integrity  ok        fk 0 violations
mismatch   none — every table count on the copy equals the original
witness    0 positions holding tokens, 173 shadows holding tokens
```

`VACUUM INTO`, engine stopped first, every figure read back **from the copy**.
`docs/AUDIT_HEAD_1C499CD.md`, `artifacts/baseline-1c499cd.json`.

## 3. The binding constraint, measured (P0)

Finding **E** was not merely present — it was stopping everything.

```
AWAITING_FILL_OBSERVATION   165        waiting 3.0 – 4.6 hours
EXIT_BLOCKED                  4
POSITION_CLOSED           1,038        all pre-P6, all void
completed post-P6             0        fill_latency_ms IS NOT NULL → zero rows
```

Two independent causes, both counted rather than inferred:

**Nothing ever simulated a mark.** 39,736 marks had an observation; **zero** had
a simulation job. `resolveFill` requires an effect-valid candidate, and the loop
never produced one — it asked for a thing it never made.

**93% of marks have no exit route.** 36,842 of 39,736 have
`route_available = 0`. The router declines the sell for tokens with no canonical
pool.

## 4. P9 — the deadlock, repaired

The mark observation is now simulated and settled **before** anything is asked
about fills, and only when it is priced — an unroutable mark cannot become a fill
however it is verified.

The second half was an identity bug the directive names exactly: `resolveFill`
returns the *first* valid later candidate, which on a blocked trajectory may be
from an earlier cycle, and the old code then simulated the **current** mark and
booked the **older** one. Everything downstream now reads the selected
observation's own identity — `observationById` loads it, `legIsExecutable` judges
its stored verdicts, and the realized value comes from its measured settlement
rather than a router's quote. No measured settlement means blocked, never a
fallback number.

Six tests, including the directive's own A-fails / B-valid / C-better scenario.

**Necessary but not sufficient, and the corpus says why.** In ten minutes of the
repaired loop, 12 marks were taken and **zero** had a route. The exit path still
runs through a router that declines these tokens. That is the directive's own
argument for the migration lane, and it is the next thing to build.

## 5. Finding G — exploration entitlement is now state

`allocate()` has accepted a carried remainder and returned the next one since it
was written. `runCycle()` passed neither, so every cycle recomputed from zero and
`floor(2 × 0.25) = 0`. The 25% exploration arm ran **exactly never**. Migration
35 keys the debt by strategy version and stratum.

Writing the test found a second defect: with a large carried remainder,
`allocate` returned **twelve** selections against a budget of two — the explore
budget had no `budget` term, so a debt of 10 produced a negative exploit budget.
In normal operation the debt tops out near 1, so it never showed.

## 6. Not done

Named individually because an unnamed gap is the thing this project keeps
finding:

- **P1** evidence taxonomy and stale-artifact archival
- **P2** `captureCoherentSnapshotV2` — batched reads, one context slot, drift bound
- **P3** one-pass persistent sequential worker (the proof is still two-pass)
- **P4** the `TrajectoryKernel` interface and its identity
- **P5** one canonical `TrajectorySettlement` (findings C and D remain)
- **P6** Pump cashback — remaining accounts, accrued/claimable/claimed, claim cost
- **P7** confirmed migrations as the primary candidate source, and the event parser identity fix
- **P8** `pnpm trajectory:collect` and the counterfactual evidence modes
- **P10** real entry/exit treatments over shared trajectories (still labels)
- **P11–P18** cohort comparability, risk-fact ordering, vault alarms, size surface, prospective reject panel, fingerprint allowlist, bottleneck measurement, confirmatory v4
- **P19** the 40 required tests — 11 added, 29 outstanding
- **P20** the remaining commands and artifacts

## 7. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

Not `VALID_TRAJECTORY_KERNEL_RUNNING`. That requires the running collector to
produce a coherent snapshot, true immediate sequential mechanics, a canonical
entry settlement, a shared later mark path, a first valid later fill, a canonical
exit settlement and identical database economics.

**Zero trajectories have completed.** The deadlock that made completion
impossible is fixed and tested; the route availability that makes it *unlikely*
is not, and the kernel that would replace the router is not built.
