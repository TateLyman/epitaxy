# Epitaxy

Solana memecoin trading research. **Paper only. No capital has ever been at
risk, and no result in this repository is evidence that the strategy works.**

## Status

| | |
|---|---|
| mode | `paper` (and `observe`) |
| positions establishing executable PnL | **0** |
| closed positions in the database | 20, all **development data** |
| decision snapshots | 2000 |
| canary / live | **disabled**, and blocked by gates that read real evidence |
| current blocker | no local SVM simulation — see below |

The number that matters is the first one. There are 20 closed paper positions
and a realized figure attached to them, and **none of it is evidence**: those
rows have no retained raw payload, no build-validated exit leg, and were priced
from a different route than the one whose buildability was checked. `pnpm report`
now says so in its first ten lines rather than in a footnote.

### Why nothing is being collected right now

`requireLocalSimulation` is `true` for paper, and no local SVM fixture exists,
so the engine books no fills. That is deliberate rather than broken.

A mainnet `simulateTransaction` cannot validate either leg here. The taker holds
no SOL, so a buy fails on funding; it holds none of the hypothetical tokens, so
a sell fails on balance. Both failures would describe the wallet rather than the
route, and reporting either as evidence would be worse than reporting nothing.
The instrument that would work is a local SVM fork with captured mainnet
accounts and a synthetic balance. Until that is wired, the honest state is a
refusal recorded every cycle.

## Commands

```bash
pnpm doctor            # preflight: node, sqlite, config, storage, secrets, providers
pnpm observe           # discover, screen, store decisions. Cannot take a position.
pnpm paper             # the engine. Simulated fills against real routes. Never signs.
pnpm status            # what the engine is doing right now
pnpm health            # liveness and freshness, with conditions separated from history
pnpm capability        # can it actually trade, and if not, why
pnpm report            # evidence first, then everything that is not evidence
pnpm replay            # re-derive every stored decision and record the result
pnpm check             # typecheck + secretscan + test
pnpm mutate            # the mutation suites. A test that survives a mutation is not a test.
pnpm audit-baseline    # VACUUM INTO backup + verified manifest
pnpm release-manifest  # exactly what this build is, including its blockers
```

Mode comes from `--mode=`, never a `MODE=` prefix — an inline assignment in a
package.json script silently does nothing under cmd.exe.

### Recovery

```bash
pnpm health                      # is anything holding the lock, and is the DB intact
pnpm capability -- --mode=paper  # is there an unresolved discontinuity or blocked exit
pnpm audit-baseline              # snapshot before touching anything
pnpm replay                      # do stored decisions still reproduce
```

To stop the engine, write a halt file rather than killing the process:

```bash
echo TERMINATE_WHEN_FLAT > data/KILL
```

`HALT_NEW_ENTRIES`, `EXIT_ONLY`, `TERMINATE_WHEN_FLAT` and `EMERGENCY_RECONCILE`
are the four modes. A bare file means `TERMINATE_WHEN_FLAT`, which cannot orphan
a position. Only `EMERGENCY_RECONCILE` stops with exposure outstanding, and it
has to be typed out.

Delete the file to restart. The lock goes stale after 30 seconds.

## What this repository is careful about

Every one of these exists because it was wrong at some point, and the wrongness
was invisible:

- **A price is not a trade.** Entry and exit both require an exact-size
  `/swap/v2/build` observation whose instructions pass the same policy the
  executor applies. One response supplies the amount, both outputs, the route,
  the fees and the expiry — mixing an `/order` price with a `/build` instruction
  set describes a trade that existed on neither.
- **Absence is not zero.** A missing impact field, a missing provider
  timestamp, an unresolved token-account owner and an unobserved transfer fee
  are all `null`, and null never satisfies a cap.
- **Unknown is not safe.** An unresolved holder counts as wallet concentration.
  A creator-controlled PDA is program-owned and is not a market.
- **A stop is not a promise.** Sizing assumes the whole principal is at risk
  until measurement says otherwise, because all eight observed collapses went
  from healthy to near-zero inside one mark interval.
- **An event is not a condition.** `pnpm health` reads the halt file, not the
  history of halts.
- **A count is not a result.** The canary gate reads a recorded replay run, not
  the number of rows that exist.

## Layout

```
packages/domain        config, types, bigint math, impact, execution observations, clocks
packages/adapters      HTTP, rate limiting with priority classes, Jupiter client
packages/solana        base58, mint decoding, tx + build policy, entity registry, RPC
packages/intelligence  risk gates
packages/strategy      screening, scoring, sizing, exits
packages/pipeline      discovery to stored decision
packages/execution     signer, policy, effect, state machine, deployment gates
packages/storage       schema, repositories, process lock
packages/research      replay, backtest, report, admissibility
apps/collector         observe
apps/engine            paper
apps/executor          canary and live — refuses to start; the loop is not wired
```

## Reading order

1. `docs/AUDIT_HEAD_3155EA.md` — the exact state this repair started from
2. `docs/P2B_INVALIDATION.md` — why the previous confirmatory window was voided
3. `docs/STATUS.md` — what is operational, what is disabled, what is unproven
4. `docs/MULTIPLE_TESTING_LEDGER.csv` — every threshold ever chosen, and on what

## Not claimed

Profitability. Canary readiness. Live readiness. An edge of any size.
