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

## 7a. JIT to frozen offline replay (P4)

`pnpm simulator:effect-parity` now compares the ECONOMIC effects of the two
runs, not only their bytes — the fifteen fields P4 requires, plus compute units
against a frozen 10 bps tolerance, plus the slot interval.

**On a stable pair (SOL→USDC):**

```
economic effect parity  AGREES
unitsConsumed           jit=40829 offline=40829   drift 0 bps
```

**On a live Pump.fun Amm route:**

```
JIT      SIMULATED_OK, 160,895 units, exact 20,000,000 debit,
         base fee 5,000, priority fee 9,500, rent created 6,222,240
offline  SIMULATION_UNKNOWN
         cheatcode failed: surfnet_writeProgram (38.5 MiB request)
```

A Pump route invokes six programs, and `net.deploy()` is a synchronous napi
call on the request path. The daemon already documents the measurement: during a
six-program restore `/v1/health` stopped answering and the restore did not
complete within five minutes.

So **Pump is capped at `JIT_EFFECT_VALID`**, `CONFIRMATORY` is unreachable for
it, and the readiness gate's 200 confirmatory positions cannot reach one until
this is fixed. Recorded as `S050`, OPEN. Not attempted this session: the JIT
path is the only thing producing evidence, and restructuring the daemon's
restore loop at the end of a long session risks it.

Full detail and the three candidate fixes: `docs/OFFLINE_REPLAY_BLOCKER.md`.

The slot interval is recorded, never fabricated. Jupiter omits `contextSlot` on
these builds; the JIT run reports the slot it executed at and the offline replay
stands there. That models decision latency and is **not** same-slot truth.

## 7b. Two runs of one transaction are two experiments

Same mint, same size, minutes apart:

```
run 1   SIMULATED_OK, 160,895 units, 20,000,000 debited
run 2   InstructionError [5, Custom 6001]   (slippage)
```

Not a figure of speech. This is the argument for offline replay, and why its
absence is a blocker rather than an inconvenience.

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

## 11a. Evidence class, stamped (P10)

The class was derived at report time by joining back to the simulation jobs.
That derivation runs under whatever the code believes now, so a shadow opened
when nothing was effect-verified would silently become `JIT_EFFECT_VALID` the
moment some later run of the same observation passed. It is stamped at open
(migration 20).

A pair takes the **minimum** of its two legs. A confirmatory entry with an
unverified exit is not a confirmatory round trip; it is a position that cannot
be shown to close, which is the more important of the two facts.

`tallyByClass()` returns a count per class and **no total**. Two structural
shadows and a confirmatory round trip are not three of anything.

## 12. Shadow evidence classes

`STRUCTURAL_ONLY` / `JIT_EFFECT_VALID` / `OFFLINE_REPRODUCIBLE` / `CONFIRMATORY`,
derived from the simulation jobs behind each position's own two legs and never
aggregated. `pnpm shadow:status`.

```
alpha_shadow    STRUCTURAL_ONLY   556 (474 closed)
canary_shadow   STRUCTURAL_ONLY   555 (474 closed)
shadow marks    25,085 total, 2,706 routed, 22,379 unpriced
```

**The realizable portfolio took nothing.** All 1,079 shadows record a portfolio
refusal, and both reasons are halts: 983 `weekly_loss_halt`, 96
`daily_loss_halt`. The portfolio has been halted for the entire window, so there
is no portfolio-versus-shadow comparison to make.

This is what the shadow books exist to reveal. Without them the corpus would
show no positions and no reason, and the absence would read as "no signals"
rather than "the engine was switched off".

**89% of shadow marks are unpriced.** With the mark backlog at 40x capacity, the
mark series is not dense enough to support an exit rule and must not be read as
one. See `docs/SHADOW_EVIDENCE_CLASSES.md`.

## 13. Corrected accounting and cost surface

P12. `packages/domain/src/accounting.ts` is now the sole implementation.
`totalEntryCost` and `netExitProceeds` in `execution.ts` — which are what the
runtime actually called, while `accounting.ts` was used by one script —
delegate to it. Two implementations of one calculation is two chances to forget
a term, and the way you find out is that a strategy is profitable in one report
and not another.

Entry cash out: exact input + base fee + measured priority fee + route tip +
rent created + transfer fee + platform fee + expected failure cost. Exit cash
in: the same, subtracted, with rent credited only in the amount actually
recoverable and **no second signature** when the close rides the exit
transaction.

An unobserved transfer or platform fee makes the quote `complete: false` rather
than zero. A Token-2022 transfer fee read as zero understates every cost it
touches, and it is exactly the extension a memecoin is most likely to carry.

**The failure model is now a bound, not a flat charge.** `failureUpperBound()`
distinguishes 3-in-10 from 300-in-1000, which share a point estimate and are
very different evidence. With no attempts the bound is 1, so an unproven leg is
charged a full failure — the honest answer, and it makes collecting the history
worth something.

Round-trip loss is measured against the **all-in** cost, not the input alone. On
the test fixture that is 1,219 bps versus 1,000 bps; the 219 bps difference is
exactly what makes a break-even strategy a losing one.

**The risk contradiction is fixed.** A proposed trade was charged
`plannedLossFractionBps()` — the max of the stop, the observed severe loss and
the catastrophic floor, currently 100% — while existing positions in the same
aggregate cap were charged the nominal 2,500 bps stop. A new trade was charged
four times what an identical existing one was, and the cap read the book as four
times safer than the model said. Both now use the same function.

## 14. Corrected bankroll requirement

Not computable. It requires a measured edge distribution, and there are zero
effect-verified positions.

## 15-16. On-chain facts and WSS alarms — implemented and INERT

Checked rather than assumed, and the answer is worse than "carried forward".

```
packages/intelligence/src/mintfacts.ts    0 non-test importers
packages/intelligence/src/entity.ts       0 non-test importers
packages/adapters/src/accountwatch.ts     0 non-test importers
```

All three are complete and tested. Nothing calls them.

This is the repository's recurring defect — a field declared, stored, listed in
a schema, and read by no decision — at module scale, and at module scale it is
worse: a dead module has passing tests, so it counts as working capability in
every report that counts files or tests. Three phases looked delivered and
decide nothing.

What IS wired: holder concentration reaches the screening decision through
`evaluateConcentrationGate` in `packages/strategy/src/screen.ts`, called from
`runCycle`. So P13 is partly live — the concentration half — and the decoded
mint/freeze authority and entity clustering halves are not.

`tests/unit/no-dead-modules.test.ts` now counts live importers for every
decision-bearing module. The `KNOWN_INERT` list holds exactly these three, each
naming the phase that would wire it, and it can only shrink: a module that gains
a caller fails the test until its entry is deleted, and a NEW dead module fails
on the day it is written rather than a directive later.

Recorded as `S051`, OPEN.

## 16a. Signal episodes (P11)

Wired. `claimSignalEpisode` and `bindEpisode` are called on the live shadow
path, and `idx_shadow_episode` makes a duplicate book/episode pair a database
refusal rather than a thing the engine has to remember not to do.

## 17. Age cohorts

`pnpm cohort:status`. 965 of 1,079 shadow positions carry no cohort, and the
118 that do are all in one arm.

**The gap is historical, not a broken feature.** NULL cohorts stop at 15:42 and
assigned ones begin at 15:45; every shadow opened since the feature landed has
one. They are now marked `cohort_source = 'PREDATES_FEATURE'`.

They are deliberately **not** backfilled. Nothing links a shadow position to the
snapshot that produced it, so deriving an age by matching mint and time would be
a guess about which screening was probably the one — indistinguishable from a
measurement and not one.

The real limitation is that the usable sample is 118 positions in a single arm,
which is no comparison at all. See `docs/COHORT_EXPERIMENT.md`.

## 18. Reject panel

`pnpm reject:status`. 811,977 rows.

```
(unclassified)   785,037   96.6%
UNKNOWN           20,831    2.6%
PROVIDER_MISSING   6,409    0.8%
```

`EXECUTABLE_VALUE` is **zero across every rejection reason**, and that is not
evidence the gates are right.

The 96.6% unclassified are historical: classification began at 15:44 on
2026-08-13 and has run continuously since, covering 29,337 rows. The older
785,037 were recorded before the classifier existed and are correctly NULL —
nobody looked, which is a different fact from looking and being unable to tell.

So the panel is running; its classified sample is three hours old. Zero
`EXECUTABLE_VALUE` across 29,337 classified rows is a real observation about a
short window and not yet a statement about the gates.

`reject_tracking.outcome` classifies rather than inferring from a NULL price. A
NULL price read as zero makes every rejected token look like it went to nothing,
which always flatters the gates and is largest exactly where the data is
thinnest. NULL is not `UNKNOWN`: one says nobody has looked, the other says
somebody looked and could not tell.

## 18a. Score defects (P17)

The weights are frozen. These are arithmetic errors that were wrong regardless
of what anyone wanted the score to say.

1. **Soft risk was the MEAN of its components.** One gate at 0.9 gave 0.9; add a
   gate reporting *no* risk and the same token scored 0.45. The risk halved
   because we wrote more code, and the dilution was largest where the evidence
   was thinnest. Replaced with `max(primary) + bounded secondary`: the worst
   single risk is a floor nothing can lower, and a zero-risk feature contributes
   zero.
2. **A missing net-buyer count was replaced with gross buys.** Those are
   different quantities — a wash trader running a hundred round trips through
   two wallets produces an enormous gross buy count and a net buyer count near
   zero. The substitution handed the anti-wash gate the one number wash trading
   inflates, precisely when the honest number was unavailable.
3. **A missing organic score was charged twice**: a zero component at full
   weight *and* a 0.25 soft risk. It is now priced once.
4. **Unknown components no longer score zero.** They drop out and the score is
   renormalised over what was observed, with `observedWeight` reported so a
   reader can see how much of the number is actually supported.

## 18b. Jupiter build composition (P7)

Two defects in the assembled instruction array, which *is* the transaction the
policy decoder validates and the simulator executes.

1. **`cleanupInstruction` came before `otherInstructions`.** Cleanup closes the
   wrapped-SOL account and returns its rent, so anything in `otherInstructions`
   touching that account executed against an account that had just been closed.
   Order is now compute → setup → swap → other → cleanup → tip.
2. **`tipInstruction` was parsed by the schema and then dropped.** A route that
   asked for a tip produced a transaction without one, so the tip was invisible
   to the policy decoder, absent from the byte-level hash, and missing from
   every cost model. It is now assembled last and its amount is decoded from the
   System transfer itself — `tipLamportsOf()` reads the u64 as a `bigint`,
   because a tip read through `Number` silently loses precision above 2^53.

An undecodable tip is `null`, not zero: `hasTip` says one was requested and a
null amount says we could not read it.

## 19. Corrected canary profitability gate

`packages/research/src/readiness.ts`, folded into `evaluateGates()` as
`canaryProfitabilityGates()`. The previous gate could pass after 200 losing
trades; `tests/unit/readiness.test.ts` builds that exact corpus and asserts
refusal.

Current: `NOT_READY`, 0 confirmatory positions, every economic gate failing.

## 20. CI, ruleset and the required tests

`pnpm check` = typecheck + secretscan + test. **846 tests pass**, 4 skipped,
54 files, in ~5 s.

P24's 44 required items are indexed in `tests/unit/p24-coverage.test.ts`, which
asserts every named file exists rather than listing them in prose — a coverage
claim nobody checks is the same class of thing as the source-substring tests
this session deleted.

Two of the 44 are honest gaps rather than passing tests, and the index asserts
they still say so:

- **item 10** (JIT→offline parity on a Pump route) is blocked by `S050`;
- **item 13** (PumpSwap canonical-pool quote against the official SDK) is not
  established. The observed corpus is 4,545 `Pump.fun Amm` against 22
  `Pump.fun` proper, so the canonical-pool path has almost no live traffic to
  check against. `docs/PUMP_PUMPSWAP_PARITY.md` states this.

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
5. **`dirty_tree`**: the engine must be restarted after each commit, or its
   rows are `+dirty` and cannot be confirmatory.
6. **`S050` — offline replay cannot restore a six-program Pump route.** This is
   the binding constraint on `CONFIRMATORY`, and therefore on canary. Nothing
   else on this list blocks a gate that the corpus is otherwise close to
   reaching.
7. **PumpSwap canonical-pool parity is unestablished** and has almost no live
   traffic to establish it against.

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
