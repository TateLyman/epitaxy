
---

# P12 — the commands mean their names, or they refuse

Five commands were **aliases for other scripts**: `rate:budget-v2` and `reject:panel-v2` both ran the trajectory status, `wss:status` ran the direct-signal status, `landed:parity-v2` ran a *non*-landed parity script, `exploration:status` ran the cohort status.

An alias is worse than a missing command. A missing command is noticed the first time somebody runs it. An alias produces well-formatted output about something else, exits zero, gets pasted into a status document, and becomes evidence for a capability that was never built.

Each now names its exact missing prerequisite and exits non-zero — and not vaguely:

- **`landed:parity-v2`** — no direct PumpSwap swap has ever been landed by this system, because nothing here has signed or submitted. It cannot mean its name before a canary.
- **`reject:panel-v2`** — `reject_tracking` records *that* a token was rejected, not the state it was rejected on, and a panel scored from state fetched later is a different experiment.

An unknown command name is itself refused with exit 2, so the stub cannot quietly absorb a typo.

## `trajectory:status` reads the database and nothing else

No `readFileSync`, no `existsSync`, no `JSON.parse` — the assertion is that the script *cannot* read a file, not that it currently reports zero. Proof artifacts are counted as zero **explicitly**, because silence is indistinguishable from having forgotten them. The old position-oriented status keeps its own name as `development:status`.

Two scripts were writing `artifacts/trajectory-status.json`, which breaks P12's own one-command-one-output rule: the last to run decided what the file meant and neither said so. The database status owns that name; the wider generator writes `artifacts/evidence-status.json`.

## The corpus, as the database has it

```
database trajectories : 43 (15 settled)
frozen account plans  : 5
marks by horizon        1m  40  backfilled 27
                        5m  38  backfilled 11
                       15m  32  backfilled  8
                       30m  27  backfilled  4
                       60m  15  backfilled  4
timely complete paths : 8
```

The daemon running continuously is visible here: 60-minute marks are now **11 of 15 timely**, against 0 of 4 when every horizon was fetched in one burst.

```
tests  1,557 passed, 4 skipped, 109 files
```
