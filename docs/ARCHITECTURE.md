# ARCHITECTURE

How the pieces fit, and which of them are structurally incapable of spending money.

## What this is

A Solana memecoin trading system that discovers newly launched tokens through
Jupiter, screens them against a two-layer gate model, and — in the modes
permitted to do so — signs and sends swap transactions. Everything it observes,
decides, and executes is written to a single SQLite file, so any claim the
system makes about itself can be checked against a row.

The design premise is that the dangerous capability is *signing*, and that the
right way to withhold a dangerous capability is to make the symbol that provides
it unreachable rather than to guard it with a boolean.

## Safety is a property of the import graph

This is the load-bearing structural decision, and it is worth stating precisely.

`packages/solana/src/rpc.ts` exposes `getSlot`, `getHealth`,
`getBalanceLamports`, `getAccountRaw`, `getTokenLargestAccounts`,
`getTokenSupply`, `getTokenAccountOwners`, and `getMintFacts`. There is no
`sendTransaction`, no `simulateTransaction`, no `getLatestBlockhash`. Its header
says so and gives the reason: every dependency in this path is a dependency that
can be compromised into lying about mint authority.

Every write method lives in `packages/execution/src/rpc.ts` instead — `send`,
`simulate`, `getLatestBlockhash`, `getBlockHeight`, `getAccounts`,
`getSignatureStatus`, `getConfirmedTransaction`. That file's header states the
intent directly: `"cannot send" is a property of the import graph rather than of
anyone's discipline`.

A repository-wide grep of cross-directory imports confirms it. Nothing under
`packages/execution/` is imported by anything except `apps/executor/src/main.ts`
and `apps/executor/src/reconcile-cli.ts`. `apps/collector`, `apps/engine`, and
`packages/research` all import `packages/solana/src/rpc.js` and none of them
touch `packages/execution/*`.

Why this beats a runtime flag: a flag is a value that some code path reads and
some other code path could fail to read. `if (mode === 'paper') return;` is one
missing branch away from being wrong, and the failure surfaces at the worst
possible moment — with a real transaction on the wire. Under the import-graph
approach there is no branch. The paper engine could contain a deliberate attempt
to broadcast a signed transaction and it would fail to typecheck, because the
object it holds has no method by that name. A refusal that `pnpm typecheck`
catches is categorically stronger than one that depends on a reviewer noticing.

The cost is real and worth naming: the two clients duplicate the JSON-RPC
plumbing. `packages/execution/src/rpc.ts` reimplements request framing and
retry rather than importing a shared base, because a shared base would be an
import edge from the read-only package to the writing one and would dissolve
the guarantee. Duplication is the price of the boundary.

## The package graph

| Package | Owns | Must not import |
| --- | --- | --- |
| `domain` | Types, `Mode`, config schemas, `loadConfig`/`loadSecrets`, bigint helpers | anything (leaf) |
| `storage` | `openDb`, migrations, `ProcessLock`, all SQL in `repo.ts` | strategy, execution, adapters |
| `solana` | Read-only RPC, base58, mint decoding, transaction decoding, `txpolicy` | execution, adapters, strategy |
| `adapters` | `fetchJson`/`SourceFetchError`, `RateLimiter`, Jupiter client and Zod schemas | execution, strategy |
| `intelligence` | `evaluateCheapGates`, `evaluateQuoteGates`, `evaluateConcentrationGate`, `summarize` | execution, storage |
| `strategy` | `screenCheap`/`finalizeScreen`, `opportunityScore`, `sizePosition`, `decideExit` | execution |
| `pipeline` | `runCycle` — the one discovery→screening loop | execution |
| `execution` | Signer, three-layer policy, `ExecutionRpc`, `machine.ts`, deployment gates | pipeline, research |
| `research` | `replay-cli`, `backtest-cli`, `report-cli` | execution |
| `observability` | pino `logger`, `scrubSecrets`, `sanitizeExternal` | everything (leaf) |

```
                          domain
                            |
        +-------------------+-------------------+
        |          |        |        |          |
     storage    solana   adapters  intelligence |
        |          |        |        |          |
        +----+-----+--------+--------+          |
             |                                  |
          strategy --------------------------- observability
             |
          pipeline
             |
      +------+------+
      |             |
 apps/collector  apps/engine        packages/research
   (observe)      (paper)          (replay, backtest, report)

        - - - - - - - - - - - - - - - - - - - - - -   no edge crosses this line
                                                       in the upward direction

                        packages/execution
                     (signer, ExecutionRpc, gates)
                                |
                        apps/executor
                   (canary, live, reconcile)
```

One important caveat about the word "package": `pnpm-workspace.yaml` declares no
`packages:` key, and no directory under `packages/` has its own
`package.json`. This is a single npm project with directories, not a pnpm
workspace. The boundaries above are therefore conventions enforced by review and
by the `tsc` type graph, not by a package manager that would refuse a
dependency. The one boundary that *is* mechanically enforced is the signing one,
and it is enforced by the absence of the method rather than by tooling.

Relatedly, `tsconfig.json` declares nine path aliases (`@domain/*`,
`@execution/*`, and so on). None of them is used. Every import in the repository
is a deep relative path such as
`'../../../packages/domain/src/config.js'`.

## The four run modes

`MODES` in `packages/domain/src/types.ts` lists six values —
`observe`, `paper`, `replay`, `backtest`, `canary`, `live`. `config/` contains
four mode files: `observe.json`, `paper.json`, `canary.json`, `live.json`.

| Mode | Entry point | Reaches | Can sign |
| --- | --- | --- | --- |
| observe | `apps/collector/src/main.ts` | `runCycle`, read-only RPC, Jupiter | no |
| paper | `apps/engine/src/paper.ts` | `runCycle`, `sizePosition`, `decideExit`, simulated fills | no |
| replay | `packages/research/src/replay-cli.ts` | DB opened `readonly: true`, re-scores snapshots | no |
| backtest | `packages/research/src/backtest-cli.ts` | recorded forward observations | no |
| canary | `apps/executor/src/main.ts --mode=canary` | gates, `Signer`, `ExecutionRpc` | yes |
| live | `apps/executor/src/main.ts --mode=live` | as canary, plus live evidence gates | yes |

`signerAllowed(mode)` returns true only for `canary` and `live`, and the
executor asserts it as an internal invariant after already checking it — but
that assertion is a backstop, not the mechanism. The mechanism is that the other
four entry points never import a module that can sign.

Two consequences of `loadConfig` that a reader is unlikely to guess:

`loadConfig(modeInput?)` falls back to `process.env['MODE']` and then to
`'observe'`, so an entry point that calls it bare runs under whatever the
environment says. The three entry points that can act on a config —
`apps/collector`, `apps/engine/src/paper.ts`, `apps/executor/src/main.ts` — all
pass the mode explicitly, and `loadConfig` then refuses a config file whose
declared `mode` differs from the one requested (`config.ts:199`). The command
line and `config/<mode>.json` therefore cannot disagree silently. See D9.

Four call sites still call `loadConfig()` bare: `reconcile-cli.ts:55`,
`report-cli.ts:108`, `backtest-cli.ts:163`, and `scripts/doctor.ts:48`. For the
three research and reporting CLIs this is harmless — they read thresholds, they
do not act. For `doctor.ts` it is a real gap, recorded as O023: doctor can pass
against the default config while the config that will actually run is broken.

`replay` and `backtest` are valid `Mode` values with no config file, and
`loadConfig` fails closed on a missing file. There is therefore no way to load a
config that declares mode `replay`. `replay-cli.ts` calls
`loadConfig(modeFromArgv())` and uses that config only for `strategyVersion` and
the gate thresholds it re-scores against, which is the point: replay must use
the same numbers observe used.

Paper mode has a refusal of its own. `apps/engine/src/paper.ts` exits if
`TRADING_KEYPAIR_PATH` is set at all — not if it is loaded, if it is merely
present in the environment. The reasoning in the header is that its presence
means the operator believes this process can trade, and that belief is the
dangerous part.

## One candidate, end to end

`packages/pipeline/src/cycle.ts` is shared verbatim by observe and paper. Its
header states why: if paper screened differently from observe, the observe
dataset would not describe the thing paper is doing.

1. **Discovery.** `jupiter.recent()` returns newly created pools; each becomes a
   row in `candidates` via `bankCandidate`. A ranked feed is polled on
   alternating cycles — `cycleIndex % 2 === 0 ? 'toptrending' : 'toporganicscore'`
   — because one call per cycle is what the rate budget allows.
2. **Maturation.** `maturingMints(db, config, 100)` selects banked mints now
   inside the age window, ordered `COALESCE(s.last_eval, 0) ASC` so the
   least-recently-screened is looked at first. `jupiter.search` fetches current
   `MintInformation` for the batch.
3. **Cheap gates.** `screenCheap` calls `evaluateCheapGates`. Hard vetoes cover
   data freshness, token program allowlist, mint and freeze authority,
   age bounds, liquidity, holder count, dev balance, 5-minute buys and net
   buyers, organic score, and the provider's own suspicious flag. Soft risks are
   scored separately and never allowed to overturn a veto. Every evaluation is
   written to `screenings`, and the inputs are written to `decision_snapshots`.
4. **Quoting.** Survivors are sorted by liquidity and truncated to
   `config.maxQuotesPerCycle`. `measureRoundTrip` prices a buy and the matching
   sell; `fetchConcentration` reads the top holders from chain and classifies
   program-owned accounts structurally (owner === System Program means a real
   wallet) rather than against a venue list. Results land in `quotes`.
5. **Finalize.** `finalizeScreen` adds the quote gates — quote availability,
   both route legs, price impact, round-trip cost — and the concentration gate.
   `capitalAtRisk` is `mode === 'canary' || mode === 'live'`, and it converts an
   *unmeasurable* holder distribution from a soft risk into a hard veto. Under
   observe, not knowing is a discount; with money on the line, not knowing is a
   refusal.
6. **Eligibility.** `eligible = summary.passedHardGates && score >= config.minOpportunityScore`.
   In observe the collector logs `ELIGIBLE (observe only — no position taken)`
   and stops. In paper, `sizePosition` runs and may still refuse for
   `position_slots_full`, `daily_loss_cap`, `score_below_threshold`,
   `exposure_cap`, `reserve_floor`, or `size_below_viable`.
7. **Counterfactual.** Rejected mints are not discarded. `followUpRejects`
   re-observes them forward — up to 6 observations, at least 10 minutes apart,
   within a 24-hour lookback — and writes them to `reject_tracking`. This is
   what makes it possible to price a gate rather than to believe in it.

Only Jupiter is actually wired. `packages/adapters/src/helius/` and
`packages/adapters/src/dexscreener/` are empty directories, and
`HELIUS_API_KEY` and `GOPLUS_ACCESS_TOKEN` are read by `loadSecrets` and listed
in the log redaction rules but consumed by no adapter.

## Where state lives

One SQLite file, opened through `packages/storage/src/db.ts` using Node 24's
built-in `node:sqlite`. Three choices in that header are worth repeating:

- **`node:sqlite` rather than a native addon.** On Windows a native build is a
  real fragility source — toolchain plus antivirus. A dependency that fails to
  install is a dependency that fails at the worst time.
- **WAL, one logical writer.** `PRAGMA journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. Readers such as
  `pnpm status` and `pnpm replay` open the file read-only so they can never
  disturb a running engine. Exclusivity between writers is enforced by
  `ProcessLock`, which records pid, hostname, and mode, heartbeats on every
  third cycle, and treats a lock as stale after 30 seconds. `hostnameSafe()` is
  exported precisely so the holder and the reaper derive host identity the same
  way.
- **Every bigint amount is stored as TEXT.** SQLite's INTEGER is 64-bit
  *signed*, so a u64 token amount near the top of its range would be silently
  truncated. TEXT costs a conversion at every boundary and buys exactness.

Four migrations have run: `initial` (candidates, decision_snapshots, screenings,
quotes, reject_tracking, intents, fills, positions, health_events,
process_locks, trials), `source_health_and_regime`, `execution_attempts`
(attempts and sign_refusals), and `attempts_reference_intents`, which rebuilds
`execution_attempts` to add a foreign key to `intents`. That rebuild's INSERT is
deliberately unguarded: if an orphan attempt already exists the migration fails
and startup stops rather than quietly dropping a row that describes money.

Three constraints do work that application code would otherwise have to
remember: `idx_fills_signature` is UNIQUE where the signature is non-null,
`idx_attempts_signature` is UNIQUE, and `idx_positions_open_mint` is UNIQUE on
`(mint, strategy_version)` for states `POSITION_OPEN`, `EXIT_INTENT`, and
`INTENT_CREATED` — so the same mint cannot be open twice under one strategy
version. `openDb` takes a `.bak` copy before running migrations.

The bigint-as-TEXT discipline is broken in exactly one place, and it is visible:
`restoreLedger` in `apps/engine/src/paper.ts` sums with
`CAST(realized_lamports AS INTEGER)` and reconstructs a bigint from the result.
It is confined to paper P&L, where the magnitudes are lamports rather than token
amounts.

## Execution

Documented in full in [EXECUTION_POLICY.md](./EXECUTION_POLICY.md); the shape
only, here.

`Signer.sign()` runs three independent checks and stops at the first refusal:
policy (`packages/solana/src/txpolicy.ts`, structural — fee payer, allowlisted
programs, instruction count, priority fee, signer count), binding
(`packages/execution/src/binding.ts`, against the intent we formed), and effect
(`packages/execution/src/effect.ts`, by simulation and balance diff). The amount
bound is *measured* rather than parsed, because Jupiter's swap amounts live in
Anchor instruction data whose layout could not be verified against a current
official source — and a remembered layout produces a check that appears to bound
the trade and does not.

The unknown-fate ordering is fixed: sign, write the attempt row carrying the
signature to SQLite, then send. A send that throws yields `UNKNOWN`, never
`FAILED`, and `resolveOutstanding()` returning nonzero stops the process before
any new decision.

Fills for on-chain trades are written only by `pnpm reconcile`, from
`getTransaction` balance deltas. The quote is what we hoped for.

Promotion is gated by `packages/execution/src/gates.ts`, which measures the
database rather than asking the operator. Canary requires 200 closed paper
positions, 1,000 decision snapshots, 0 replay divergences, and 72 hours of
observation on the *current* strategy version. Live additionally requires 30
confirmed on-chain transactions, at most a 20% failed-or-expired attempt rate
over a non-empty sample, zero unsigned on-chain fills, and an operator-created
acknowledgement file. A gate whose evidence cannot be gathered fails. Note that
`evaluateGates` applies the canary evidence gates to live as well — live is a
superset, not an alternative.

## What is absent, and why

**The entry/exit loop in `apps/executor/src/main.ts`.** The process performs
gate evaluation, lock acquisition, key load, and `resolveOutstanding`, then logs
that the execution loop is not yet wired to the strategy and exits 0. A stub
that appears to trade and does not is worse than a gap you can see.

**Any caller of `executeIntent`.** The full sign→send→confirm pipeline in
`packages/execution/src/machine.ts` exists and is exercised, but the only call
site in the repository is `tests/chaos/recovery.test.ts`. The code is proven
against injected failures; it has never been reached by an application.

**`apps/dashboard/src/`.** The directory exists and is empty. `package.json`
declares `"dashboard": "tsx apps/dashboard/src/main.ts"`, which points at a file
that does not exist. The script will fail immediately if run.

**`tests/e2e/`, `tests/integration/`, `tests/replay/`.** All three are empty
directories. `vitest.config.ts` explicitly excludes `tests/integration/**` on
the grounds that integration tests reach the network and are opt-in — the
exclusion is written for a suite that has not been written yet. What does exist
is `tests/unit/` (base58, mint decode, portfolio, signer, txpolicy),
`tests/property/` (amounts, base58, sizing, via fast-check), and
`tests/chaos/recovery.test.ts`.

**Risk capacity in observe.** `config/observe.json` sets `maxEntryLamports`,
`maxTotalExposureLamports`, and `dailyLossCapLamports` all to `"0"`. The
sizing code runs, and it refuses at `size_below_viable` every time. That is
deliberate: the code path is exercised on every cycle rather than skipped, so it
cannot rot while unused.

**An equity curve in `pnpm backtest`.** The CLI states plainly that it is not
one. It reports forward outcomes at 15m/1h/4h/24h horizons for accepted and
rejected candidates, with sample sizes attached to every aggregate, and
`pnpm report` never sums simulated and on-chain P&L into a single number.

The pattern across all of these is the same. Where a capability does not yet
have evidence behind it, the code that would exercise it is missing rather than
present-and-disabled, and running the command tells you which measurement is
absent instead of refusing without content.
