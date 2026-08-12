# RUNBOOK

How to start this system, how to read it, and what to do when it breaks.

Everything here is grounded in the source and in commands actually run against
this machine on 2026-08-11. Where a command's output is shown, it was run.

## First-run setup

### What must exist

| Requirement | Source of truth | Notes |
| --- | --- | --- |
| Node >= 24 | `engines.node` in `package.json` | `scripts/doctor.ts` only fails below 22, because that is where `node:sqlite` appears. The stricter 24 is the declared floor. |
| pnpm 11.13.0 | `packageManager` in `package.json` | |
| `node:sqlite` available | `doctor.ts` imports it dynamically | Absent means the runtime cannot open the database at all. |
| `config/<mode>.json` | `loadConfig()` | Missing file is a hard error, never a fallback to a permissive mode. |
| `.env`, git-ignored | `loadSecrets()`, `doctor.ts` | Optional in observe/paper. Mandatory for canary/live. |
| A dedicated RPC endpoint | `SOLANA_RPC_HTTP` | Required to sign; see below. |

### Environment variables

Read by `loadSecrets()` in `packages/domain/src/config.ts`. All are optional
except where a gate demands them.

| Variable | Used for |
| --- | --- |
| `MODE` | Selects `config/<mode>.json`. Defaults to `observe`. |
| `DATABASE_PATH` | Defaults to `./data/runtime.db`. |
| `DATA_DIR` | Defaults to `./data`. |
| `JUPITER_API_KEY` | Higher rate limits. Absent means unkeyed buckets. |
| `SOLANA_RPC_HTTP` | Primary endpoint. Gate `rpc.primary` requires it. |
| `SOLANA_RPC_HTTP_FALLBACK` | Read-only failover. Never used for `sendTransaction`. |
| `SOLANA_RPC_WS`, `HELIUS_API_KEY`, `GOPLUS_ACCESS_TOKEN` | Optional sources. |
| `TRADING_KEYPAIR_PATH` | Gate `signer.keypair` requires it. Paper mode **refuses to start** if it is set. |
| `LIVE_ACK_PATH` | Live-only acknowledgement file. |

### Why the RPC endpoint is not optional for signing

`docs/EXECUTION_POLICY.md` explains it: the third signing layer establishes the
amount bound by simulating the transaction and diffing balances. A cluster that
will not simulate produces `simulation_unavailable`, which is a refusal, not a
warning — the trade does not happen. A public endpoint's method-level rate
limiting turns into a stream of refusals. `doctor` probes
`getTokenLargestAccounts` specifically because public endpoints commonly deny it,
and finding that out during setup is much cheaper than finding it out with
capital at stake.

### What `pnpm doctor` checks

From `scripts/doctor.ts`, in order:

| Check | Fails when |
| --- | --- |
| `node.version` | major version < 22 |
| `node.sqlite` | `import('node:sqlite')` throws |
| `config.load` | the mode's config file is missing or invalid |
| `config.ageWindow` | `minTokenAgeMs >= maxTokenAgeMs` — no token could ever qualify |
| `config.risk` | a single entry may exceed the total exposure cap |
| `config.viableCapital` | the largest permitted position is below the fee-viability floor, meaning no trade can ever open |
| `config.signer` | never fails; warns when the mode permits signing |
| `storage.wal` | warns when `journal_mode` is not WAL |
| `storage.migrations` | reports applied migration count |
| `secrets.jupiter` | warns when `JUPITER_API_KEY` is unset |
| `secrets.rpc` | warns when `SOLANA_RPC_HTTP` is unset |
| `secrets.gitignore` | **fails** when `.env` exists but is not git-ignored |
| `source.jupiter` | the recent-tokens feed call fails |
| `source.rpc` | `getSlot` fails (skipped with a warning when unconfigured) |
| `source.rpc.largestAccounts` | warns when the endpoint refuses the method |

Doctor exits 1 if any check failed. Real output from this machine, with
`MODE=paper`:

```
OK   node.version                   node 24.12.0
OK   node.sqlite                    node:sqlite is available
OK   config.load                    mode=paper strategy=delayed-momentum-v0.2.0
OK   config.ageWindow               120000ms .. 3600000ms
OK   config.risk                    maxEntry=100000000 totalCap=300000000
OK   config.viableCapital           largest position 100000000 vs floor 28592800 (headroom 3.5x)
OK   config.signer                  mode paper cannot sign
OK   storage.wal                    journal_mode=wal at ./data/runtime.db
OK   storage.migrations             4 migration(s) applied, latest id 4
WARN secrets.jupiter                no JUPITER_API_KEY; using unkeyed rate limits
WARN secrets.rpc                    no SOLANA_RPC_HTTP; on-chain concentration cannot be measured (required for canary/live)
WARN secrets.env                    no .env file; all secrets come from the ambient environment
OK   source.jupiter                 recent feed returned 30 tokens in 154ms
WARN source.rpc                     no endpoint configured; skipped

14 checks, 0 failed, 4 warning
```

**Doctor fails by default.** With no `MODE` set it loads `config/observe.json`,
where `maxEntryLamports` is `0`, and `config.viableCapital` fails:

```
FAIL config.viableCapital           largest permitted position 0 < fee-viability floor 28592800; no trade can ever open. Raise capital to about 2.85928 SOL or lower fixed costs
```

That is correct — observe genuinely cannot open a position — but it means a bare
`pnpm doctor` exits 1 on a healthy machine. Always run doctor with the `MODE`
you intend to run.

> **`MODE=<mode>` works only in a POSIX shell.** Every `MODE=<mode> pnpm doctor`
> in this runbook assumes bash. Under `cmd.exe` the inline assignment is
> **silently dropped** — doctor runs as observe and you get the failure above
> with no indication why. This is the trap that D9 removed from the engine entry
> points by parsing `--mode=` from `process.argv`; `doctor.ts:48` still calls
> `loadConfig()` bare and has not been converted. Recorded as O023. Until it is,
> run doctor from bash or set `MODE` as a real environment variable first.

### A packaging trap on this machine

`pnpm <script>` currently fails before the script runs:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5, esbuild@0.28.2
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
[ERROR] Command failed with exit code 1: ... "pnpm.mjs" install
```

`pnpm-workspace.yaml` contains the literal placeholder
`allowBuilds: esbuild: set this to true or false`, so pnpm's pre-run dependency
check fails on every invocation. Until that is resolved with
`pnpm approve-builds`, invoke entry points directly — for example
`./node_modules/.bin/tsx scripts/status.ts` — which is exactly what the scripts
in `package.json` expand to. Every output in this document was captured that way.

## Command surface

"Spends money" means the process can construct a signer and broadcast a
transaction. "Lock" is the `process_locks` row name it takes, from `ProcessLock`.

| Command | What it does | Spends money | Holds lock | DB access |
| --- | --- | --- | --- | --- |
| `pnpm doctor` | Preflight; 14 checks | no | none | read-write (backs up, migrates) |
| `pnpm observe` | Discovery + screening loop; records every candidate and reject | no | `collector` | read-write |
| `pnpm paper` | Screening plus simulated positions against real quotes | no | `engine` | read-write |
| `pnpm replay` | Re-decides stored snapshots, reports divergences. `--limit=N` | no | none | read-only |
| `pnpm backtest` | Counterfactual analysis of each gate. `--days=N` | no | none | read-only |
| `pnpm report` | Performance report, simulated and on-chain kept separate | no | none | read-only |
| `pnpm status` | Recorded facts: locks, funnel, vetoes, positions, source health | no | none | read-only |
| `pnpm health` | Liveness and integrity. Exit 2 critical, 1 warning | no | none | read-only |
| `pnpm reconcile` | Compares attempts to the chain, writes on-chain fills. `--wallet=<pubkey>` | no | **none** | read-write |
| `pnpm canary` | Evaluates gates, then trades at 0.02 SOL entries | **yes** | `executor` | read-write |
| `pnpm live` | Evaluates gates, then trades at 0.1 SOL entries | **yes** | `executor` | read-write |
| `pnpm kill` | SIGTERMs lock holders, clears confirmed-dead locks. `--force` | no | none | read-write |
| `pnpm check` | `typecheck` then `secretscan` then `test` | no | none | none |
| `pnpm secretscan` | Refuses credentials in the tree; reports location and rule only | no | none | none |
| `pnpm typecheck` / `pnpm test` | `tsc --noEmit` / `vitest run` | no | none | none |
| `pnpm dashboard` | **Broken.** `apps/dashboard/src/main.ts` does not exist | no | none | none |

Notes on that table that are easy to get wrong:

- `pnpm reconcile` **writes** — it is the only path permitted to create fills for
  on-chain trades — and it takes no process lock. Do not run it concurrently with
  an executor.
- Every read-write open copies the whole database to `<path>.bak` before
  migrating (`openDb` in `packages/storage/src/db.ts`). `data/runtime.db` is
  currently 165 MB, so `doctor`, `canary`, and `reconcile` each pay a 165 MB file
  copy at startup. `kill` passes `skipBackup: true` and does not.
- `pnpm canary` and `pnpm live` are safe to run for inspection. They print the
  gate table and exit non-zero long before a key is read.
- `pnpm dashboard` resolves to a directory with no files in it and dies with
  `ERR_MODULE_NOT_FOUND`.

## Normal daily operation

1. `MODE=<mode> pnpm doctor`. Expect zero failures. Warnings about absent
   optional keys are normal in observe and paper.
2. Start one engine. Observe and paper take different lock names (`collector` and
   `engine`), so the lock will not stop you running both at once against one
   database — but they run the same discovery pipeline and share one Jupiter rate
   budget, so doing so halves the effective cadence of each.
3. `pnpm status` for the funnel: candidates banked, screenings, eligibility rate,
   which hard vetoes are firing, positions, source health, recent health events.
4. `pnpm health` for liveness. It exits 1 on any warning and 2 on any critical,
   so it can drive an alert directly. A stale lock heartbeat (>30s) shows up here
   as a warning naming the pid.
5. `pnpm report` when you want the funnel with sample sizes attached and paper
   results kept strictly separate from on-chain results.
6. `pnpm check` before any commit. `secretscan` is biased toward false positives
   by design; a spurious failure costs seconds and a leaked signer key costs the
   wallet.

Current state of this machine, for calibration — `pnpm status`, abridged:

```
processes
---------
  engine     LIVE   pid=19816 mode=paper heartbeat 2s ago

discovery and screening
-----------------------
  candidates banked   6581
  screenings          26350 (last 31s ago)
  eligible            50
  eligibility rate    0.190%
```

An eligibility rate under a fifth of one percent is the expected shape of this
strategy, not a malfunction. `insufficient_liquidity` alone vetoes 99.6% of
rejects.

## Incident procedures

### (a) Process died mid-trade, or unresolved attempts block startup

Symptom: the executor logs `refusing to trade with attempts of unknown fate; run
pnpm reconcile`, or the `execution.noUnresolved` gate reports a nonzero count.

An attempt row is written to SQLite **before** the transaction is sent, carrying
its signature. So a process that dies mid-flight leaves behind the signature of a
transaction that may have landed. `outcome IN ('SIGNED','SUBMITTED','UNKNOWN')`
is the set of attempts whose fate nobody knows.

1. Do not restart the executor. It will refuse anyway — `resolveOutstanding()`
   runs before any new decision, and a nonzero return is a hard stop.
2. Confirm nothing else holds the lock: `pnpm status`.
3. Run `pnpm reconcile`. It fetches each attempt's signature with
   `getTransaction` and writes fills from the actual balance deltas.
4. Read the `DISCREPANCIES` section. `landed on chain but recorded as UNKNOWN` is
   the ordinary recovery case and reconcile corrects the row. `recorded CONFIRMED
   but getTransaction returns nothing` means either a wrong signature or a reorg,
   and needs a human.
5. Re-run the executor. `resolveOutstanding()` calls `getSignatureStatus` for
   each remaining attempt. A confirmed status resolves to `CONFIRMED` or
   `FAILED`; no status resolves to `EXPIRED` **only** if the observed block
   height exceeds the attempt's recorded `lastValidBlockHeight`. Before that,
   absence means "not yet", and the attempt stays unresolved.
6. If it still refuses, the chain is telling you it does not know either. Wait
   for block height to pass `last_valid_height` and re-run. Do not edit the
   outcome column by hand; expiry is a proof, not a timeout.

### (b) RPC endpoint failing

Symptom: `pnpm health` reports `source.<name>` critical, or reconcile and
resolution fail with network errors.

1. `MODE=<mode> pnpm doctor`. This calls `getSlot` and
   `getTokenLargestAccounts` against the configured endpoint and reports what it
   observed.
2. If `getSlot` fails, the endpoint is down or the URL is wrong. If only
   `getTokenLargestAccounts` is refused, the endpoint works but concentration
   measurement will report unavailable, and a signing mode will produce refusals.
3. If an executor is running, stop it — see (d). A resolution pass that cannot
   read block height marks nothing as expired, which is correct behaviour but
   means unresolved attempts accumulate while the endpoint is down.
4. Set `SOLANA_RPC_HTTP` to a working dedicated endpoint and re-run doctor.
5. `SOLANA_RPC_HTTP_FALLBACK` exists but is read-only failover.
   `sendTransaction` is deliberately never failed over: asking a second host to
   send the same bytes under a network partition is how one transaction becomes
   two.

### (c) Suspected double-spend or duplicate signature

The database is designed so this is a refusal rather than a discovery.
`execution_attempts.signature` carries a UNIQUE index and
`fills.signature` a UNIQUE partial index, so two rows can never claim one
transaction. Intents are claimed with `INSERT OR IGNORE` against a UNIQUE
idempotency key, not read-then-write.

1. `pnpm health`. `fills.integrity` flags on-chain fills with no signature;
   `fills.provenance` flags positions that mix simulated and real fills, which
   would make realized P&L meaningless.
2. `pnpm reconcile`. Every landed transaction is matched to its intent, and a
   confirmed transaction with no matching intent row is reported as a problem
   rather than absorbed. Migration 4 added the foreign key that makes an orphan
   attempt impossible going forward, and it is deliberately unguarded: if an
   orphan already existed, the migration fails and startup stops.
3. Reconcile prints `simulated X vs actual Y (N bps)` per attempt. A large
   negative divergence is slippage; two attempts against the same intent with
   different signatures is the real double-spend signature to look for.
4. If reconcile reports discrepancies, it records a `critical` health event and
   exits 1. Do not restart trading. Compare the wallet balance it prints against
   the sum of recorded fills by hand before doing anything else.

### (d) Stop everything immediately

1. `touch data/KILL`. This makes the `kill.switch` gate fail, so no executor can
   start. Note that it does **not** stop a process that is already running — the
   file is checked only at startup, and observe and paper never check it at all.
2. `pnpm kill`. This SIGTERMs each lock holder on this host and waits up to 15
   seconds for it to exit, polling every 250ms.
3. Read the output. `OK` means the process exited and its lock was cleared.
   `CLEAR` means the pid was already gone and a stale lock was removed. `WARN
   ... still alive` means the process ignored SIGTERM and the lock was left in
   place on purpose.
4. If any lock is still held, `pnpm kill` exits 1 and names the pid. Investigate
   that process. Do not clear the row manually: a second engine starting
   alongside the first is exactly what the lock prevents.
5. `--force` sets the wait to zero. It still refuses to clear a lock whose owner
   is alive; it only stops waiting.
6. A lock written by another host is skipped with `SKIP`, because pid 4711 here
   is not the pid 4711 that took the lock there.

### (e) Corrupted or locked database

1. `pnpm status` opens the database read-only, so it is always safe to try first.
2. **"database is locked":** `openDb` sets `busy_timeout = 5000`, so transient
   contention resolves itself. Persistent locking means a writer is stuck —
   `pnpm status` will show which process holds which lock.
3. **A `process_locks` row with no live process:** `ProcessLock` treats a lock as
   stale after 30 seconds without a heartbeat (heartbeat interval is
   `staleAfterMs / 3`, so 10 seconds) and will simply overwrite it on the next
   `acquire()`. Be aware that `acquire()` checks only heartbeat age, not whether
   the pid is alive — a process stalled for more than 30 seconds by a GC pause or
   a suspended laptop can have its lock stolen while still running. `pnpm kill`
   is the careful path: it verifies pid liveness before clearing anything.
4. **Corruption:** every read-write open copies the database to
   `<path>.bak` before running migrations. `data/runtime.db.bak` is that copy.
   Stop all engines, move the damaged file aside, restore from `.bak`, and re-run
   `pnpm doctor` — `storage.migrations` will report how far the restored copy got.
   The `.bak` is one generation deep and is overwritten on the next read-write
   open, so copy it somewhere else before doing anything.
5. **A failed migration:** migrations run inside `BEGIN`/`COMMIT` and roll back on
   error, then throw `migration N (name) failed`. Startup stops. Do not retry
   blindly; the migration-4 comment documents the one condition that is designed
   to halt permanently, an unattributable signature.

## Before believing any P&L number

The database currently holds 6 closed paper positions, 12 simulated fills, zero
on-chain fills, and zero execution attempts. Every P&L number available today is
an assumption about what would have happened.

1. **Check whether the fills are simulated.** `pnpm status` prints
   `fills recorded N (M simulated, K on-chain)`. Simulated and real are never
   summed in `report`, and they must not be summed by you.
2. **Check the sample size.** A win rate over four trades is a sentence about
   four trades. `pnpm report` attaches the sample size to every aggregate for
   this reason.
3. **Know what a paper fill assumes.** `apps/engine/src/paper.ts` uses the
   quote's `otherAmountThreshold` — the worst amount the router guarantees —
   never the optimistic `outAmount`; it charges priority fee and ATA rent on
   entry even though nothing was sent; and it models the documented 50 bps
   new-token fee rather than the 10 bps actually measured. It does not model
   partial fills, failed transactions, or price movement between quote and
   landing.
4. **Know that no signable transaction has ever been produced.** The `quotes`
   table holds 273 rows and `SUM(transaction_buildable)` is 0, which is what
   `pnpm report` surfaces as `signable returned 0`. Quote-only requests omit
   `taker`, so this is expected — but it means the claim "we could have
   transacted at that price" is untested.
5. **For on-chain numbers, reconcile first.** Fills for real trades are written
   only by `pnpm reconcile`, from `getTransaction` balance deltas. The quote is
   what we hoped for; the balances are what happened. A P&L computed before
   reconciling is computed from intents, not outcomes.
6. **`priorityFeeLamports` is recorded as 0 for on-chain fills.**
   `getTransaction` does not separate the priority component from the base fee,
   and a fabricated split would corrupt the cost model. The total in
   `feeLamports` is correct; the breakdown is not available.
7. **Do not trust `realized pnl` in `pnpm status`.** Its query is
   `SELECT SUM(...) FROM positions WHERE state != 'open'`, but no position ever
   has the state `open` — the literals are `POSITION_OPEN`, `EXIT_INTENT`,
   `INTENT_CREATED`, and `POSITION_CLOSED`. So that filter matches every row,
   open positions included, and the neighbouring `open positions` line reads 0
   unconditionally. Today all 6 positions are `POSITION_CLOSED` so the number
   happens to be right (-0.139276842 SOL). It will silently stop being right the
   moment a position is open. Use `pnpm report`, which partitions on `simulated`
   and reports states explicitly.
