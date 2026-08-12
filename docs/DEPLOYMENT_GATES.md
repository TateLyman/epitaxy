# DEPLOYMENT GATES

What has to be true, and measurable, before this process is allowed to sign.

## The ladder

There are four operating modes with configuration files, and they form an
ordered ladder:

| Mode | Entry point | Signs? | Config |
| --- | --- | --- | --- |
| observe | `apps/collector/src/main.ts` | no | `config/observe.json` |
| paper | `apps/engine/src/paper.ts` | no | `config/paper.json` |
| canary | `apps/executor/src/main.ts --mode=canary` | yes | `config/canary.json` |
| live | `apps/executor/src/main.ts --mode=live` | yes | `config/live.json` |

`signerAllowed()` in `packages/domain/src/config.ts` returns true for exactly
`canary` and `live`. Observe and paper do not refuse to sign by convention; they
never construct a `Signer` at all, and `apps/engine/src/paper.ts` refuses to
start if `TRADING_KEYPAIR_PATH` is even set, on the grounds that its presence
means the operator believes that process can trade.

The mode is selected by the `MODE` environment variable, which chooses
`config/<mode>.json`. A missing config file is a hard error, never a fallback:
`loadConfig()` fails closed. The executor then asserts the mode twice — once
from `--mode=` and once from the loaded file — so running live against canary's
risk limits is a startup error rather than a discovery.

Note that `MODES` also contains `replay` and `backtest`, but no config file
exists for either. `MODE=replay` fails at `loadConfig`.

### A mode is entered by evidence, not by decision

Promotion is a claim that the system has earned a larger blast radius. The claim
is checked by `evaluateGates()` in `packages/execution/src/gates.ts` against the
SQLite database on every single start. There is no flag to flip, no
`--i-know-what-im-doing`, and no environment variable that skips the check.
Nothing is signed and no key is loaded until every gate passes — the keypair
file is not even read until after the gate loop returns.

The gates are also not a disabled feature. A disabled feature rots. This path is
executed in full every time someone runs `pnpm canary`, and what stops it is a
measurement that came back short.

## Operational gates

These apply to both canary and live. They are about the machine and the
operator, not the strategy. Source: `operationalGates()` in
`packages/execution/src/gates.ts`.

| Gate | Threshold | Configured in | How it is measured |
| --- | --- | --- | --- |
| `signer.keypair` | `TRADING_KEYPAIR_PATH` non-empty | environment (`loadSecrets`) | string presence; the file is not opened at gate time |
| `rpc.primary` | `SOLANA_RPC_HTTP` non-empty | environment (`loadSecrets`) | string presence; the endpoint is not called at gate time |
| `kill.switch` | neither `./data/KILL` nor `./KILL` exists | filesystem | `existsSync` on both paths, relative to the working directory |
| `execution.noUnresolved` | at most 0 | `LIVE_THRESHOLDS.maxUnresolvedAttempts` in `gates.ts` | `COUNT(*) FROM execution_attempts WHERE outcome IN ('SIGNED','SUBMITTED','UNKNOWN')` |
| `config.mode` | `canary` or `live` | `mode` field of `config/<mode>.json` | string comparison |

`rpc.primary` checks that a variable is set, not that the endpoint works. The
reason a dedicated endpoint is required is in `docs/EXECUTION_POLICY.md`: effect
verification is done by simulation, and a cluster that will not simulate
produces a refusal rather than a warning. A public endpoint converts into a
stream of refusals. `pnpm doctor` is the check that actually calls the endpoint,
including `getTokenLargestAccounts`, which public endpoints commonly deny.

## Canary evidence gates

Canary risks the smallest amount of real money that still proves the execution
path works end to end. What it must demonstrate first is that the *decision*
path has been exercised honestly. Source: `canaryEvidenceGates()`.

| Gate | Threshold | Configured in | How it is measured |
| --- | --- | --- | --- |
| `evidence.paperPositions` | at least 200 | `CANARY_THRESHOLDS.minClosedPaperPositions` | `COUNT(*) FROM positions WHERE simulated = 1 AND closed_utc_ms IS NOT NULL` |
| `evidence.observationWindow` | at least 72h | `CANARY_THRESHOLDS.minObservationHours` | `MAX(evaluated_utc_ms) - MIN(evaluated_utc_ms)` over `screenings` filtered to the **current** `strategyVersion` |
| `evidence.replayCorpus` | at least 1,000 | `CANARY_THRESHOLDS.minReplayedSnapshots` | `COUNT(*) FROM decision_snapshots` |

Two properties of these are worth stating plainly.

The observation window is scoped to the current strategy version. Bumping
`strategyVersion` in the config file resets this gate to zero hours. That is
intentional — 72 hours of evidence about a strategy you no longer run is not
evidence — but it means a one-character config edit throws away three days of
waiting.

`evidence.replayCorpus` prints `required: at least 1000 (replay must then show 0
divergences)`. The divergence count is **not** machine-checked by this gate. The
threshold `CANARY_THRESHOLDS.maxReplayDivergences = 0` exists and is quoted in
the message, but nothing reads the result of `pnpm replay`. Only the snapshot
count is enforced. Running replay and reading its output is an operator
responsibility that the gate advertises and does not verify.

## Live evidence gates

Live is permitted only once canary has produced real, signed, confirmed
transactions — the one thing paper mode structurally cannot demonstrate. Live
runs every gate above, plus these. Source: `liveEvidenceGates()` and the tail of
`evaluateGates()`.

| Gate | Threshold | Configured in | How it is measured |
| --- | --- | --- | --- |
| `evidence.onChainFills` | at least 30 | `LIVE_THRESHOLDS.minConfirmedOnChainFills` | `COUNT(*) FROM execution_attempts WHERE outcome = 'CONFIRMED'` |
| `evidence.attemptFailureRate` | at most 20%, over a non-empty sample | `LIVE_THRESHOLDS.maxFailedAttemptRate` | `(FAILED + EXPIRED) / COUNT(*)` over all of `execution_attempts` |
| `evidence.fillsVerifiable` | exactly 0 | hardcoded in `gates.ts` | `COUNT(*) FROM fills WHERE simulated = 0 AND (signature IS NULL OR signature = '')` |
| `live.acknowledgement` | file at `LIVE_ACK_PATH` exists | environment plus filesystem | `envOrNull('LIVE_ACK_PATH')` then `existsSync` on that path |

An empty sample fails `evidence.attemptFailureRate`. The rate is computed as `1`
when there are zero attempts, which is above the ceiling. A gate whose evidence
cannot be gathered fails; it does not pass with a warning.

`live.acknowledgement` is the only gate a human satisfies directly, and it is
deliberately the last one. It is a file the operator creates, so that the final
step to live is a physical act with a timestamp on it rather than a command-line
flag.

### Risk limits differ per mode

The gates decide whether the process may start. The config file decides what it
may do once started. Both matter.

| Parameter | canary | live |
| --- | --- | --- |
| `risk.maxEntryLamports` | 20,000,000 (0.02 SOL) | 100,000,000 (0.1 SOL) |
| `risk.maxTotalExposureLamports` | 40,000,000 (0.04 SOL) | 200,000,000 (0.2 SOL) |
| `risk.maxSimultaneousPositions` | 1 | 2 |
| `risk.dailyLossCapLamports` | 20,000,000 | 60,000,000 |
| `risk.minSolReserveLamports` | 50,000,000 | 100,000,000 |
| `risk.maxPriorityFeeLamports` | 500,000 | 1,000,000 |
| `risk.maxSlippageBps` | 200 | 200 |
| `maxFeeFractionBps` | 1500 | 500 |
| `minOpportunityScore` | 0.5 | 0.45 |

`maxFeeFractionBps` is looser in canary (15% of notional) than in live (5%).
That is not an oversight: canary's notional is 0.02 SOL, where fixed costs are
structurally a larger share, and canary exists to prove the path works rather
than to be profitable. Also note `assertNotLoosened()` in
`packages/domain/src/config.ts`: risk caps may be tightened at runtime but never
loosened past the committed file.

## The real gate evaluation, today

Run on **2026-08-11** (UTC timestamp on the log line: `2026-08-12T00:22Z`).
The `pnpm canary` script is `tsx apps/executor/src/main.ts --mode=canary`.
`MODE` must be set to match, or the executor refuses before reaching the gates:

```
{"level":"error","time":"2026-08-12T00:22:21.027Z","pid":31924,"app":"executor","err":"--mode=canary but the loaded config declares mode \"observe\"","msg":"executor failed to start"}
```

With `MODE=canary`:

```
deployment gates for canary
================================
HOLD signer.keypair               TRADING_KEYPAIR_PATH unset
                                  required: TRADING_KEYPAIR_PATH must be set
HOLD rpc.primary                  SOLANA_RPC_HTTP unset
                                  required: a dedicated RPC endpoint is required to sign
PASS kill.switch                  no KILL file
PASS execution.noUnresolved       0 attempt(s) of unknown fate
PASS config.mode                  config declares mode canary
HOLD evidence.paperPositions      6 closed paper positions
                                  required: at least 200
HOLD evidence.observationWindow   1.8h on delayed-momentum-v0.2.0
                                  required: at least 72h on the CURRENT strategy version
PASS evidence.replayCorpus        26450 decision snapshots

8 gates, 4 not met

canary is not permitted to start. The gates above are the reason, and each one is a
measurement rather than an opinion. Nothing was signed and no key was loaded.
```

With `MODE=live`:

```
deployment gates for live
==============================
HOLD signer.keypair               TRADING_KEYPAIR_PATH unset
                                  required: TRADING_KEYPAIR_PATH must be set
HOLD rpc.primary                  SOLANA_RPC_HTTP unset
                                  required: a dedicated RPC endpoint is required to sign
PASS kill.switch                  no KILL file
PASS execution.noUnresolved       0 attempt(s) of unknown fate
PASS config.mode                  config declares mode live
HOLD evidence.paperPositions      6 closed paper positions
                                  required: at least 200
HOLD evidence.observationWindow   1.8h on delayed-momentum-v0.2.0
                                  required: at least 72h on the CURRENT strategy version
PASS evidence.replayCorpus        26450 decision snapshots
HOLD evidence.onChainFills        0 confirmed on-chain transactions
                                  required: at least 30 from canary
HOLD evidence.attemptFailureRate  no attempts recorded
                                  required: at most 20% over a non-empty sample
PASS evidence.fillsVerifiable     0 unsigned on-chain fills
HOLD live.acknowledgement         LIVE_ACK_PATH unset
                                  required: an operator-created acknowledgement file must exist

12 gates, 7 not met

live is not permitted to start. The gates above are the reason, and each one is a
measurement rather than an opinion. Nothing was signed and no key was loaded.
```

### What is unmet today

Canary is short by four gates:

- **`signer.keypair`** and **`rpc.primary`** — no `.env` file exists on this
  machine, so neither variable is set. These are one-time setup, not evidence.
- **`evidence.paperPositions`** — 6 closed paper positions against a floor of
  200. This is 3% of the required sample.
- **`evidence.observationWindow`** — 1.8 hours on `delayed-momentum-v0.2.0`
  against a floor of 72. At the current rate this needs about three more days of
  continuous paper or observe running, and any bump to `strategyVersion` restarts
  the clock.

Live is short by those four plus three more, all of which are downstream of
canary having never run: zero confirmed on-chain transactions against a floor of
30, no attempt sample at all to compute a failure rate from, and no
acknowledgement file. `evidence.fillsVerifiable` passes vacuously — there are no
on-chain fills to be unsigned.

The honest summary is that the two evidence gates canary can satisfy on its own
are roughly 3% and 2.5% complete, and everything live needs is blocked behind
canary.

## The kill switch

There are two separate things, and confusing them is dangerous.

**The KILL file** is the gate. Creating an empty file at `./data/KILL` or
`./KILL` (either path, relative to the working directory) makes the
`kill.switch` gate fail, and the executor refuses to start. To disarm, delete
the file. There is no command that creates it — it is a file, on purpose,
because a file survives a reboot and a shell history does not.

Its limit, stated plainly: **the KILL file is evaluated only at executor
startup.** `existsSync` appears exactly once in the gate path and nowhere in a
running loop. Creating the file will not stop a process that is already running,
and it has no effect at all on the observe collector or the paper engine, which
never consult it.

**`pnpm kill`** is the stop command, and it does something different. It reads
`process_locks`, and for each lock it holds:

1. If the lock's `hostname` is not this host, it skips it — pid 4711 here is not
   pid 4711 there.
2. If the pid is not alive (`process.kill(pid, 0)`, treating `EPERM` as alive),
   it deletes the lock row as stale.
3. Otherwise it sends `SIGTERM` and waits up to 15 seconds for the process to
   exit, polling every 250ms. `--force` sets that wait to zero.
4. It removes the lock row only after observing the process exit. A lock whose
   owner is still alive is reported and left in place.

That last property is the point. A kill that force-clears a live lock would let
a second engine start alongside the first, and two engines sharing one ledger is
exactly the state the lock exists to prevent.

To stop everything and keep it stopped: create the KILL file first, then run
`pnpm kill`. In the other order there is a window where a supervisor could
restart the executor.

## Why gates are measurements

Every threshold in this file is a number in `gates.ts` compared against a `SELECT`
against the operational database. Not against a summary, not against an
operator's recollection of last week, and not against a judgement call made at
2am by someone who wants the system running.

The property that buys is narrow and real: **a gate cannot be satisfied by
arguing with it.** There is no conversation in which `evidence.paperPositions`
becomes true at 6 closed positions. The only ways forward are to accumulate 200
of them or to edit `CANARY_THRESHOLDS` in source, which is a diff, in version
control, with an author and a date, that `docs/DECISION_LOG.md` expects to see
justified. Lowering a threshold is not forbidden; it is made visible.

What it costs is worth being honest about:

- **The gates measure what is countable, not what is true.** 200 closed paper
  positions is a proxy for "the decision path has been exercised". A strategy
  that opened 200 identical positions on one token would pass. The gate cannot
  tell the difference.
- **They can be satisfied dishonestly by editing the database.** Nothing here is
  cryptographically attested. The gate reads a row count; anyone with write
  access to `data/runtime.db` can produce one. The defence is that the database
  is also the thing the P&L is computed from, so corrupting it to pass a gate
  corrupts the numbers you are gating on.
- **A correct trade can be refused indefinitely.** If Jupiter's feed goes quiet
  and paper positions stop closing, the observation window keeps advancing while
  the position count does not, and canary stays blocked for reasons that are
  about the market rather than about the system's readiness. There is no
  override, and that is the design working as intended even when it is
  frustrating.
- **Passing every gate does not mean the system trades.** As
  `docs/EXECUTION_POLICY.md` records, the entry/exit loop is absent from
  `apps/executor/src/main.ts` rather than stubbed. A canary that passed all eight
  gates today would resolve outstanding attempts, log that the loop is not wired,
  and exit zero.
