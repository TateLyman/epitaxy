# Handoff — P6 in progress, shell wrapper broken by the power loss

**Repo head:** `4ec715f` on `master` (PR #53 merged, clean).
**Uncommitted, on disk, intact:**

```
packages/solana/src/created-accounts.ts     new, untracked
packages/pipeline/src/open-trajectory.ts    modified (P6 wiring)
```

Both typechecked clean immediately before the machine went down.

## Why this file exists rather than a commit

After the reboot, Claude Code's Bash wrapper composes a prefix that is being
**truncated mid-redirect**. The visible tail of the failing line:

```
: && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \
  \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'npx tsc' < '
```

It should end `< '/dev/null'`. The unterminated quote makes bash refuse to parse,
so every command that receives the stdin redirect fails before it runs:

```
FAILS   npx, node, bash, pnpm, pwd, git add, git diff, anything piped
WORKS   echo, ls -la, git status, git log -1
```

This is an apparatus failure, not a repository one — but **restarting does NOT
fix it**. Three hypotheses were tested and all three are dead:

1. *Corrupt shell snapshot* — the snapshot file is intact and well-formed.
2. *Command line too long* — PATH was cut from ~4,300 to ~950 characters and the
   failure did not move. `true`, a four-character command, fails identically.
3. *Stale build* — `claude.exe` was replaced at 1786903185654, between two
   session snapshots. The current build is fresh and still fails.

The failure is at a stable line number, for every command, independent of PATH
size and binary version. That is a defect in how Claude Code composes its bash
wrapper on this machine, and it needs reporting upstream rather than more
configuration changes. Reproduction detail worth quoting: the wrapper emits
`eval '<cmd>' < '` — a truncated `/dev/null` redirect — at line 83.

## The collector is STOPPED

The daemon was running when the machine lost power. It has not been restarted —
nothing collects while it is down, and a gap in the corpus is a gap in the
marks, not a market fact. Restart it with:

```
pnpm trajectory:collect --interval=300 --max-candidates=8 --max-open=3
```

Its state is entirely in the database, so it resumes open trajectories and takes
whatever marks are due. Marks that came due during the outage will be recorded
with a large `lateness_ms` and are therefore backfilled, not timely — which the
schema already distinguishes and `pnpm trajectory:status` already reports.

## Written since, still UNVERIFIED (no shell to run tsc or vitest)

```
packages/storage/src/db.ts               migration 40, created_accounts
packages/storage/src/trajectory-repo.ts  insertCreatedAccounts, createdAccountsFor,
                                         setupEconomicsTotals
apps/collector/src/trajectory-collect.ts persists them, prints the setup line
tests/unit/created-accounts-p6.test.ts   tests 29, 30, 32 + persistence
docs/COLD_WARM_SETUP_ECONOMICS.md        required output
docs/PUMPSWAP_CASHBACK_V2.md             required output, F13 corrected
```

**None of this has been typechecked or run.** Treat it as a draft until
`npx tsc --noEmit -p tsconfig.json` and `npx vitest run` both pass.

## F13 is confirmed, and the repository was wrong

Re-read from primary sources on 2026-08-16. The codebase asserts "sell carries
no volume accumulator in the pump_amm IDL". It does — as an optional positional
remaining account, exactly like buy:

```
BUY   remaining[0] = UserVolumeAccumulator WSOL ATA
SELL  remaining[0] = UserVolumeAccumulator WSOL ATA
SELL  remaining[1] = UserVolumeAccumulator PDA
```

Confirmed by the official cashback README, and independently by the installed
SDK: `offlinePumpAmm.ts:652` pushes ONE account on buy, `:859` pushes TWO on
sell. Omitting them is silent — the creator fee simply goes to the creator.

Our `buildBuyFrom`/`buildSellFrom` call `sdk.buyInstructions`/`sellInstructions`,
so the accounts are probably already appended. Nothing checks that they are,
which is the defect shape this project keeps rediscovering. The P2 frozen
account plan makes placement checkable by position — see
`docs/PUMPSWAP_CASHBACK_V2.md` for the exact tail comparison to implement.

## Where P6 got to

`packages/solana/src/created-accounts.ts` classifies every account a leg brought
into existence:

- **economic scope** — `WALLET_TOKEN_MINT`, `CREATOR_QUOTE_MINT`, `POOL_GLOBAL`,
  `MINT_SPECIFIC`, … — i.e. how many future trades opening it serves
- **recoverability** — `RECOVERABLE_BY_US` (a float, we hold close authority),
  `RECOVERABLE_BY_OTHER` (we paid, they can close it), `NOT_RECOVERABLE`
- **`sharedWithOtherTraders`** — would another trader's organic transaction have
  opened this anyway

`summariseSetup` keeps recoverable and spent apart, which is the correction:
collapsing them into one "rent" number is what made a first trade look like a
recurring mechanics floor. `requiresSharedAccountCreation` treats `UNKNOWN` as
shared, so an unclassified account is never assumed free.

`open-trajectory.ts` now reads created accounts from the buy step's own pre/post
observation and attaches `createdAccounts`, `setup` and `requiresSharedSetup` to
the opened trajectory.

## What P6 still needs

1. Migration 40: a `created_accounts` table, append-only, keyed to the trajectory.
2. The collector writing those rows.
3. Tests 29–33 (every created account observed; classified by scope and
   recoverability; warm surface removes only non-price state; the warm gate
   refuses shared account creation; the base ATA close is in the sell).
4. `docs/COLD_WARM_SETUP_ECONOMICS.md` and
   `artifacts/cold-warm-size-surface.json`.

## Directive sections still open after P6

P7 (cashback on both legs), P8 (live confirmed migrations rather than history
scans), P10 (risk facts reaching the decision), P11 (WSS vault watching — the
prerequisite `pnpm wss:status` now names), P13 (active-time bottleneck — the
prerequisite `pnpm rate:budget-v2` now names).

## Terminal state

`MEASUREMENT_REPAIR_REQUIRED`, unchanged. The collector settles paths and the
first genuinely timely horizons exist, but no cell has the 100 valid complete
paths a development claim would need, and nothing here has been funded, signed
or submitted.
