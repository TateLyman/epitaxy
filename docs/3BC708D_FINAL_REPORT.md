# Final report — 3bc708d true-stateful directive

## 1. SHAs

| | |
|---|---|
| starting (audited master) | `3bc708d8ef6083989087efeb3158b34ea51ac799` |
| ending | `3d62acd` |
| commits | `b989b88` baseline · `450a812` invalidation + bounded pipeline · `c9d2e0b` sequential runtime · `07c7bb9` cohorts/exploration/version · `7d1fefc` settlement field contract · `95cb61c` real buys commit · `9c573fb` alarm + confirmatory v3 · `3d62acd` drawdown + provenance |

Local was **identical** to audited head at session start: clean tree, no
unpushed work, 0/0 against `origin/master`.

## 2. Backup

```
path       data/backups/baseline-3bc708d-2026-08-14T03-43-23-247Z.db
bytes      5,960,482,816
sha256     2c3f2d099d13d43fd42aeb550f877569e5928c47056047229478faf79bebd6ed
integrity  ok        fk 0 violations
mismatch   none — every table count on the copy equals the original
witness    0 positions holding tokens
```

Every figure read back **from the copy**. `artifacts/baseline-3bc708d.json`.

## 3. The audit stopped the engine before the backup

The direct event stream added in the previous directive was destroying the
corpus it was meant to inform:

```
1,055 events/second      6,981,407 rows in 111 minutes
91,000,000 rows/day      2.97 GB -> 6.15 GB in one session
68% UNKNOWN              43 migration events of decision-useful yield
```

## 4. Invalidated: the "stateful" proof — DONE

`docs/3BC708D_PROOF_INVALIDATION.md`. Reclassified
`LINKED_LEG_INSTRUMENT_DEVELOPMENT`.

The directive's claim is correct and my own code comment was the tell. It said
*"THE STATEFUL CARRY — the sell starts from the SOL the buy LEFT"*: true, and
the wrong half. Wallet inventory carried; pool reserves, virtual quote
reserves, creator and protocol accounts, volume accumulator and fee config were
re-fetched from mainnet, and the sell **route** was chosen against a pool with
its pre-buy depth. The error flatters and its magnitude is unmeasured.

Also recorded: the doc said attempted 25 / unknown 20 / market 3 while its own
artifact said 22 / 12 / 5. Nothing bound them.

The atom cliff is retired as non-portable — raw atoms move with decimals,
supply and price, so a threshold on it is a threshold on three unrelated
things.

## 5. The sequential runtime — BUILT AND PROVEN

`packages/simulator/src/sequential-runtime.ts`, `offline-worker/`,
`artifacts/sequential-runtime-proof.json`.

The worker now takes a **list** of steps and commits each, so step N+1 sees
exactly what step N produced. It loads real ELF via `add_program` — the
previous version called `set_account(executable = true)` and called that
program loading, which populates no program cache — restores `Clock` at the
snapshot's slot, and stops the sequence when a step fails rather than running
later steps against a state no trade produced.

Proven on arithmetic nobody can dispute — a plain SOL transfer, no program, no
pool, no route:

| | B before | B after |
|---|---|---|
| step 1: A→B 1 SOL | 0 | 1,000,000,000 |
| step 2: A→B 2 SOL | **1,000,000,000** | 3,000,000,000 |

Step 2's *pre*-state already holds step 1's transfer. Two fresh states would
have shown 0 → 2,000,000,000, which is precisely the linked-leg defect.

Three refusals on the way, each a real property answering a question nobody
asked here: `SignatureFailure` (nothing in this system ever signs), the
blockhash check (these bytes carry a mainnet blockhash the runtime has never
seen), and `AlreadyProcessed` (the runtime dedups on `signature()`, and an
unsigned transaction carries the **zero** signature, so the second step of any
sequence was refused however different its content).

LiteSVM stays at 0.6.1, verified rather than assumed: 0.15.2 and 0.14.0 both
fail to compile against their own resolved crate sets.

## 6. Real Pump buys COMMIT in the runtime — sell not yet built

`artifacts/true-stateful-roundtrip-proof.json`.

```
attempted        28
buys committed   19
programs loaded  7 per case, from actual ELF
apparatus fails  0
```

Snapshot capture reads every account the swap touches — 107 after resolving
the lookup tables, against 14 before — and the executable code of every program
it invokes, taken from **ProgramData** rather than the program account.

Three defects on the way, each found by the error MOVING rather than by reading:

| symptom | cause |
|---|---|
| `IncorrectProgramId` at instruction 1 | only Jupiter's ELF loaded. A Jupiter route names **only Jupiter** as its instruction's program; PumpSwap and Whirlpool arrive by CPI and appear nowhere in the instruction list |
| 14 accounts for a swap touching dozens | v0 transactions keep most accounts in lookup tables; only static keys were read |
| `Instruction(MissingAccount)` on venue programs | an ELF-loaded account must not ALSO be restored as data — `set_account` replaces the program cache with loader bytes |

**The sell is not built.** It must come from THIS runtime's post-buy pool state
through the official builder. Substituting a Jupiter sell would rebuild the
linked-leg defect inside the runtime that exists to prevent it, so the cases
stop at `BUY_COMMITTED_SELL_NOT_BUILT` and say so.

**No lifecycle is complete and no number in this report is a strategy
estimate.**

## 7. The firehose — BOUNDED, 70×

`artifacts/direct-signal-status.json`.

```
received/s   1,098        parsed 16.6%
dropped      0            queue high water 3,251 of 5,000
rows/day     1,309,738    against the firehose's 91,155,852
compression  20.3 trades per bar
```

Two defects found by tests rather than review:

- the drain ran **synchronously inside** `offer()`, so the queue never held
  more than one event and `maxQueue` was unreachable — the old design with
  extra steps
- trades were still stored as rows; they outnumber every other kind by two
  orders of magnitude and no decision reads an individual one

`feedsProductionDecisions: false` is stated in the artifact. It is telemetry.

## 8. Four cohorts — NOW ELIGIBLE

Three of four arms could not produce a single screening. The queues were real,
the maturity buckets were real, and the global 2m–60m age gate was applied to
every one of them: a token that matured into `AGE_1H_5H` was immediately vetoed
`too_old` by a window that only ever described `AGE_2M_60M`.

Screening now takes the cohort's own bounds, and the rejection detail names
which window refused.

## 9. Exploration — NOW NON-ZERO

`floor(maxQuotesPerCycle × 0.25)` is 0 whenever the budget is under four, and
the configured budget is 2. The stated 25% arm had **never run a quote**. The
entitlement now carries across cycles; the realised share converges on 25% from
below.

The exploited arm's inclusion probability was 1, which says "certain to be
chosen" — true of the ranking, false of the population it competed in.
Reweighting on a 1 treats a selected survivor as representing only itself,
which is the bias the exploration arm exists to measure. It is now
`budget / eligible`.

## 10. Strategy version — a hard provenance defect, FIXED

The score computed v0.5 semantics while all four config files stamped rows
`delayed-momentum-v0.4.0`. Every row written since claims a scorer that no
longer existed. Both are now `v0.6.0`, and a test fails if they diverge again.

## 11. Settlement field contract — FIXED

`execution_cost_lamports` held `entryCashOut().cashOut` — principal plus costs.
On the first effect-verified production buy that reports 24,087,331 lamports of
"execution cost" against 4,087,331 of actual cost, the difference being exactly
the 20,000,000 principal. A 2× cost stress then doubles the principal.

`transferFeeLamports` used `?? 0n`, turning "not measured" into "none". Zero is
now returned only when the asset **cannot** carry a fee.

## 11b. WSS alarm and the urgent queue (P7) — DONE

The reserve account was "the first writable account that is not the taker's and
not an ATA" — a position in a list, not an identity. On a routed swap that lands
on whatever the compiler ordered first, and an alarm on the wrong account is
worse than no alarm because it reports coverage. It now watches the canonical
PumpSwap pool derived through the SDK's own PDA.

`unwatch` passed an empty string, so every closed position leaked its
subscription.

And `urgentMarks` was written by the alarm callback and read by **nothing** —
scoped inside `main()` where the mark loop could not see it. The whole
websocket path ended in a `Set.add`. Urgent mints are now marked ahead of the
scheduled order.

## 11c. Confirmatory v3 (P16) — DONE

One position could produce **nine** rows: v1 and v2 JOIN `simulation_jobs` on
the observation id, and the live corpus has observations with three jobs. Every
count, mean and bootstrap over that view was inflated by an invisible factor.

v3 uses `EXISTS` — a qualifying job is a condition on the position, not a row
multiplied into it. Measured in test: v2 emits 9, v3 emits 1.

## 11d. Readiness and provenance (P17, P18) — DONE

Drawdown started at **zero cumulative PnL**. The first losing trade has
`peak = 0` so the branch is skipped entirely, and a 0.01 SOL give-back against
0.02 SOL of accumulated profit reads as a 50% drawdown. Both errors point the
same way early in a sample. Equity now starts at the frozen starting NAV.

Every artifact carries its commit, dirty flag, strategy version, schema version
and sample query, and freshness **refuses** rather than warns — a different
commit, a dirty tree, a different version, no provenance, a missing file, or
too old.

## 12. Not done

- **P2's ten Pump lifecycles** (§6) and **P13's true size surface**, which
  depends on them
- **the sell leg** of the sequential lifecycle (§6), and **P13**'s size
  surface, which depends on it
- **P5** production core refactor; **P6** shadow trajectories
- **P11** Mayhem and entity facts into screening
- **P14** parity expansion (sell, sizes, Token-2022, USDC, fee tiers)
- **P19–P23** tournament, reject panel, infrastructure, confirmatory window
- **P24**'s 48 tests: 24 of them landed with this work

## 13. Commands

```bash
pnpm paper
```

```bash
pnpm simulator:sequential-proof
```

```bash
pnpm direct-signal:status
```

## 14. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

Not `VALID_STATEFUL_TRAJECTORIES_RUNNING`. That requires the running paper
engine to produce complete sequential buy→sell→close trajectories, and it has
produced none: the sequential runtime exists and is proven on a transfer, but
no Pump lifecycle has run through it and production still cannot open a
position at the current risk budget against the mechanics floor.
