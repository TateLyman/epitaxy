# Audit at 2617bb7 — the profitability directive

## 1. SHAs

| | |
|---|---|
| audited GitHub HEAD | `2617bb7b8d3e16502cd5d4c4b08e9543dca6b887` |
| local starting SHA | `4fa28ea` (ahead of the audited commit) |
| local ending SHA | see `git log -1` at the bottom of this session |

## 2. Local differences from the audited commit

The local tree was **ahead**, not behind. `4fa28ea` carried `docs: STATUS.md
through P2a`, and before it `75e9e54` (concentration in the snapshot, drawdown
halt), `c330ace` (mark cadence decoupled from discovery), `fef420c` (exit
outcomes from executable value). Nothing newer on the remote was discarded and
nothing local was overwritten.

Untracked at session start: `all.json`, `vr.json`, and the directive itself.

## 3. Backup

```
path       C:\Users\lyman\tradseee\data\runtime.db.backup-2026-08-13T17-54-57-293Z
bytes      2,699,034,624
sha256     7edd0e0c52d9971cd9e454803e441e98aa45021ed6c6962d2f1a08e289bbc2d0
integrity  ok
witness    execution_observations: 26,515 rows in the backup,
           within [26,515, 26,515] on the source
fk         0 violations
elapsed    36,125 ms
```

Taken with `VACUUM INTO` against a read-only handle, then read back and checked.
Copying a live SQLite file without its `-wal` produces something that opens
cleanly and is missing every transaction since the last checkpoint — a backup
that looks fine, which is the worst failure mode available.

The witness bounds are tight because the writer was stopped first.

## 4. The 13/13 split — root cause

The committed status quoted 13 `SIMULATED_OK` and 13 `SIMULATION_FAILED`. The
engine had kept running, and the proportions held exactly as the sample grew:

| side | OK | FAILED | error |
|---|---|---|---|
| buy | 40 | 3 (7%) | `[5, Custom 6001]`, varying by venue |
| sell | **0** | **43 (100%)** | `[2, Custom 6025]`, identical on every one |

`simulateObservation()` built every request as `requestedAmount: '0'` with a
single `{ kind: 'sol' }` balance mutation — whatever the transaction spent.

A buy spends lamports, so it was funded correctly and executed. A sell spends
**tokens**, and was handed a taker who had never been given any.

The uniformity is the proof. A market-driven failure varies with route, size and
liquidity; the three genuine buy failures do vary. The 43 sells failed with the
same error at the same instruction index across every venue, mint, and three
orders of magnitude of position size, because they never reached the market.

`VERDICT: CONFIRMED — instrument artifact`
(`artifacts/simulation-failure-audit.json`)

## 5. Rows invalidated

All **108** simulation jobs are `INSTRUMENT_DEVELOPMENT` (migration 16). Rows
are preserved — they are the only proof the corpus was ever wrong — and are not
evidence about any token, route or threshold. The 40 buy "successes" are
included: a run whose bounds were vacuous did not pass an economic test, it
failed to violate one that was never stated.

All 26,515 observations carry `simulation_effect = 'NOT_VERIFIED'`, which says
nobody checked, not that a check failed.

Detail: `docs/2617BB7_SIMULATION_WINDOW_INVALIDATION.md`.

## 6. The balance-mutation fix

`SimulateOptions` now describes the economic leg — side, input mint, output
mint, exact input amount, input token program. `validateSetup()` refuses, before
anything is sent:

- an input amount of zero;
- a sell with no token program, which cannot be provisioned;
- a sell whose input is SOL, which is not a sell;
- a leg whose input and output are the same asset.

A sell is provisioned with **exactly** the hypothetical position — funding more
would let a sell succeed that the real balance could not cover. An invalid setup
produces a `critical` health event and **no simulation job at all**: running it
would record a caller defect as a simulation outcome.

`validity` is **derived from the request bytes**, not asserted by the caller. A
caller that could assert its own validity would have asserted it for all 43.

## 7. Effect-verification proof

`SIMULATED_EFFECT_OK` = `RUNTIME_OK` + `EFFECT_OK` + `FEE_DECOMPOSITION_OK` +
`ACCOUNT_COVERAGE_OK`. `legIsExecutable()` requires it.

Proven live, not asserted. `pnpm simulation:sell-proof` re-ran eight failed
sells through the repaired setup:

```
now SIMULATED_OK   1
still failed       7
```

The runtime logs show the taker's associated token account — derived
independently as `5WwuMzak…` and matched against the address the transaction
uses — holding exactly `1,653,146,653` atoms, the exact sell amount. The
provisioning works.

The one that executed was then **refused** by the effect verifier:

```
runtime succeeds but the input debit could not be measured
runtime succeeds but an unexpected writable receives value: GajFWsepxfwEqeWjo…
```

That is the P3 machinery doing precisely its job on a real run: the runtime did
not complain, and the trade still did not verify.

**What this does not show.** The seven that still fail cannot be attributed.
They are stale transactions replayed just-in-time against today's chain with
`context_slot` NULL, so there is no point in time to stand at. Jupiter rejects
them after 1,160 compute units, before any AMM is invoked. That is a different
confound and it does not restore the original conclusion.

## 8. Pump capability parity

`artifacts/capability-matrix.json`, 13 route shapes over 26,515 observations.
The two fingerprints carrying simulation history are the Pump buy shape
(`8e6dd14c`, 50 OK / 3 failed) and the Pump sell shape (`640d0958`, 0 OK / 54
failed) — the P1 finding expressed as capability.

Every fingerprint is `STRUCTURAL_ONLY`, for one stated reason: every simulation
of it predates the leg-shaped request.

## 9. Unsupported route fingerprints

None are structurally unsupported. All are unproven for the same reason, which
is a fact about when the repair landed rather than about any venue.

## 10-11. Portfolio same-family and immediate-sell proof

Portfolio entry now requires an exact same-family sell of the exact acquired
amount, policy-checked and effect-verified, before the position opens. A
cross-family pair is refused as `critical`: two families are two markets and
their difference is not a round trip.

Executed in `tests/unit/paper-core.test.ts` — the observer double records that
the sell is requested at `1_000_000n`, the exact amount the buy acquires, and
that no sell is requested at all when the buy acquires nothing.

## 12. Shadow evidence classes

`STRUCTURAL_ONLY` / `JIT_EFFECT_VALID` / `OFFLINE_REPRODUCIBLE` / `CONFIRMATORY`,
never aggregated. Current counts: everything structural.

## 13. Corrected accounting and cost surface

Round-trip loss is measured against the **all-in** cost — input, signature fee,
priority fee, broadcaster tip, ATA rent — not against the input alone. On the
test fixture that is 1,219 bps versus 1,000 bps; the 219 bps difference is
exactly what makes a break-even strategy a losing one.

## 14. Corrected bankroll requirement

Not computable. It requires a measured edge distribution, and there are zero
effect-verified positions.

## 15-17. On-chain facts, WSS alarms, age cohorts

Carried forward from the previous directive rounds; unchanged this session.

## 18. Reject panel

`reject_tracking.outcome` classifies rather than inferring from a NULL price. A
NULL price read as zero makes every rejected token look like it went to nothing,
which always flatters the gates and is largest where the data is thinnest.

## 19. Corrected canary profitability gate

`packages/research/src/readiness.ts`, folded into `evaluateGates()` as
`canaryProfitabilityGates()`. The previous gate could pass after 200 losing
trades; `tests/unit/readiness.test.ts` builds that exact corpus and asserts
refusal.

Current: `NOT_READY`, 0 confirmatory positions, every economic gate failing.

## 20. CI and ruleset

`pnpm check` = typecheck + secretscan + test. **772 tests pass**, 4 skipped,
48 files, in ~5 s.

## 21. Repository visibility

Operator action, not taken. The user directed that the repository need not be
private.

## 22. Distinct-signal and mark-budget metrics

Measured after the repaired restart:

```
shadow_mark_backlog  169-172 positions due against a capacity of 4
                     worst lag 1,017-1,030 s
observation 4XX      92 failed sell observations in 15 minutes
```

A seventeen-minute-old mark, against a 2,500 bps stop and a 30-minute maximum
hold, is not a mark. The scheduler reports the backlog rather than silently
degrading cadence, which is the required behaviour.

## 23. Is the Jupiter Developer plan justified?

**No — and not because of the price.** There are currently zero effect-verified
legs. Buying throughput now buys a higher rate of measurements not yet known to
measure anything. `docs/JUPITER_UPGRADE_ROI.md` states the two conditions that
would change the answer.

## 23a. First measurement from the repaired instrument

Ten `VALID_DEVELOPMENT` jobs, on clean commit `c11d76d`. **Zero passed effect
verification.** Both runs the runtime accepted delivered a token delta of
**zero** — the daemon's bounds check and the effect verifier agreeing
independently. A swap that executes, charges the fee and delivers nothing was
previously recorded as `SIMULATED_OK` and read everywhere as a working leg.

One defect was found in the P3 implementation itself and fixed: the
unexpected-movement check refused whenever any account gained lamports, which
every AMM swap does, making it unpassable. It now refuses only against a stated
model of who was expected to receive value; the movement is measured and
persisted regardless. See `docs/SIMULATION_EFFECTS.md`.

## 24-27. Valid trades and days

| class | trades | days |
|---|---|---|
| structural development | 0 completed positions | — |
| JIT-effect valid | 0 | 0 |
| offline reproducible | 0 | 0 |
| confirmatory | 0 | 0 |

Eight jobs carry `VALID_DEVELOPMENT` — the first jobs in this repository's
history whose labels were derived from a request that described a leg. None
passed effect verification.

## 28. Unresolved blockers

1. **No effect-verified leg yet.** The repair is landed and proven on the wire;
   the window is minutes old.
2. **Mark backlog 40× capacity**, made heavier by the P9 requirement that marks
   be executable. Resolution is a book-size or SLA decision, not a silent
   widening.
3. **`context_slot` NULL on most observations**, so offline replay has no point
   in time to stand at. Blocks `OFFLINE_REPRODUCIBLE` for those rows.
4. **92 `HTTP_4XX` sell observations in 15 minutes.** Routes that do not exist
   cost budget and return nothing.
5. **`dirty_tree`**: the engine restarted from a tree with uncommitted changes,
   so its rows are `+dirty` and cannot be confirmatory. Commit, then restart.

## 29. Commands to keep collection running

```powershell
# start / stop the paper engine
pnpm paper
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*paper.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# start / stop the WSL simulator
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/simulatord && ./start.sh"
wsl -d Ubuntu-24.04 -- bash -lc "pkill -f simulatord"

# halt new entries; terminate when flat
pnpm kill

# backup (WAL-consistent) and migrate
pnpm db:migrate

# inspect
pnpm health
pnpm status
pnpm simulation:audit
pnpm capability:matrix
pnpm readiness
pnpm simulator:doctor
curl http://127.0.0.1:8787/v1/health
```

Nothing above starts canary or live.

## 30. State

```
VALID_DEVELOPMENT_LABELS_RUNNING
```
