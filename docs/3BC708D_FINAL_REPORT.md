# Final report — 3bc708d true-stateful directive

## 1. SHAs

| | |
|---|---|
| starting (audited master) | `3bc708d8ef6083989087efeb3158b34ea51ac799` |
| ending | see `git log --oneline 3bc708d..HEAD` |

Local was **identical** to audited head at session start: clean tree, no
unpushed work, 0/0 against `origin/master`.

Commits: `b989b88` baseline · `450a812` invalidation + bounded pipeline ·
`c9d2e0b` sequential runtime · `07c7bb9` cohorts/exploration/version ·
`7d1fefc` settlement field contract · `95cb61c` real buys commit ·
`9c573fb` alarm + confirmatory v3 · `3d62acd` drawdown + provenance ·
`7c8e0cf` report · `f3c745e` the sell leg · `4269963` mint facts in every mode ·
`6a1e34a` size surface, parity matrix, reject panel, rate budget

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
the wrong half. Wallet inventory carried; pool reserves, virtual quote reserves,
creator and protocol accounts, the volume accumulator and the fee config were
re-fetched from mainnet, and the sell **route** was chosen against a pool with
its pre-buy depth.

The atom cliff is retired as non-portable — raw atoms move with decimals, supply
and price, so a threshold on one is a threshold on three unrelated things.

## 5. The sequential runtime — BUILT AND PROVEN

`packages/simulator/src/sequential-runtime.ts`, `offline-worker/`,
`artifacts/sequential-runtime-proof.json`, `docs/OFFLINE_LITESVM_PARITY.md`.

The worker takes a **list** of steps and commits each. It loads real ELF via
`add_program` — the previous version called `set_account(executable = true)` and
called that program loading, which populates no program cache — restores `Clock`
at the snapshot's slot, and stops the sequence when a step fails.

Proven on arithmetic nobody can dispute — a plain SOL transfer, no program, no
pool, no route:

| | B before | B after |
|---|---|---|
| step 1: A→B 1 SOL | 0 | 1,000,000,000 |
| step 2: A→B 2 SOL | **1,000,000,000** | 3,000,000,000 |

Two fresh states would have shown 0 → 2,000,000,000, which is precisely the
linked-leg defect.

LiteSVM stays at 0.6.1, verified rather than assumed: 0.15.2 and 0.14.0 both
fail to compile against their own resolved crate sets.

## 6. The sell is built from the buy-mutated pool — DONE

`packages/solana/src/pumpswap-offline.ts`,
`artifacts/true-stateful-roundtrip-proof.json`,
`docs/TRUE_STATEFUL_ROUNDTRIP_PROOF.md`.

The module makes the account source a **parameter**. Every field of the official
SDK's swap state comes from account bytes and nothing else, so the runtime's
committed post-buy bytes feed the official builder directly. Reads are
synchronous and total: a missing vault is an error naming the vault, never a
zero that would price a sell against an empty pool.

A Jupiter sell was refused on principle. A router prices against current mainnet
and cannot see a pool a hypothetical buy just moved, so its sell would be chosen
— route, size and minimum output — against depth that no longer exists.

**The classification is code.** `packages/domain/src/statefulness.ts` tracks two
provenances, because either alone breaks the claim: an exit that *executed* on
committed state but was *priced* on mainnet is still `LINKED_FRESH_STATE_LEGS`.

Three defects found by running it:

| symptom | cause |
|---|---|
| `AddressLookupTableNotFound` on every routed buy | the lookup **tables** were never captured, only the addresses inside them |
| `InstructionError(0, InvalidAccountData)` on the close | the official sell already appends its own `CloseAccount` on the wrapped-SOL side |
| a 41% round-trip loss | measured before that unwrap; the proceeds were one account over, still wrapped |

## 7. Proof that the sell uses buy-mutated state

Measured, not argued. For each completed trip the base vault's `dataSha256` is
compared pre- and post-buy, and the same atoms are quoted against both states:

```
buyMutatedSellPool    true on every completed trip
self-impact           -3 to -19 bps
```

**The sign is the finding and the naive expectation is backwards.** A buy leaves
the pool with less base and more quote, so selling the same atoms back fetches
*more*. A fresh-state sell under-reports here rather than flattering. Taking a
magnitude would have hidden the direction.

## 8. Round-trip results

```
attempted                     70
complete lifecycles            3
TRUE_SEQUENTIAL_ROUND_TRIP     3
```

Most candidates fail at `MARKET_NO_CANONICAL_POOL` — they never migrated off the
bonding curve. That is a fact about the market, not the apparatus.

At 0.02 SOL: AMM drag 246 bps, stable across runs; the sell's realised proceeds
equal the offline quote to within the 5,000-lamport base fee.

## 9. Dimensionless mechanics — the size surface

`artifacts/true-stateful-size-surface.json`, `docs/TRUE_STATEFUL_SIZE_SURFACE.md`.

| notional | AMM drag | repeat-trade drag | position/reserve | latency |
|---|---|---|---|---|
| 0.001 SOL | 241.5 bps | 791.5 bps | 0 bps | 0 bps |
| 0.0025 | 241.5 | 461.5 | 0 | −0.5 |
| 0.005 | 241.5 | 351.5 | 0.5 | −1 |
| 0.01 | 241.5 | **296.5** | 1 | −2.5 |
| 0.02 | 241.5 | 269 | 2.5 | −5.5 |
| 0.04 | 241.5 | 255 | 5.5 | −11 |

The AMM drag is **flat** — at these sizes it is fee, not impact. What falls with
size is fixed cost amortising; what rises is price impact and latency exposure.

Every point reconciles to **1 lamport** against its named components, and the
residual is a reported field rather than something folded into the trade's
economics.

**Development notional: 0.01 SOL**, chosen prospectively as the smallest grid
size clearing a 300 bps mechanics gate. No return was looked at; the grid and
the gate were fixed before the first point.

## 10. Settlement, ledger and rent

`execution_cost_lamports` held `entryCashOut().cashOut` — principal plus costs.
The first effect-verified production buy reported 24,087,331 lamports of
"execution cost" against 4,087,331 of actual cost, the difference being exactly
the 20,000,000 principal. A 2× cost stress then doubled the principal.

`transferFeeLamports` used `?? 0n`, turning "not measured" into "none". Zero is
now returned only when the asset **cannot** carry a fee.

`rentExemptLamports` derives the exemption from the chain's own constants —
`(128 + len) × 3480 × 2` — instead of assuming 2,039,280, so a Token-2022
account with extensions gets its own larger figure. Only the exemption is
credited back on a created account; the coin-creator fee vault is opened *and
paid* in the same transaction and the excess is reported separately.

ATA recovery is measured per lifecycle: `entryAtaRentRecovered` is read from
whether the close actually returned it, not assumed.

## 11. Parity matrix

`artifacts/pumpswap-parity-v2.json`, `docs/PUMP_PUMPSWAP_PARITY_V2.md`.

```
mints                     3
cells                    36     (6 sizes x 2 sides x 3 mints)
exact runtime/offline    36 / 36
```

**Zero basis points on both sides at every size.**

The defect a one-size matrix could not have caught: before the fix the sell arm
disagreed by 41,818 bps at 0.001 SOL and 1,045 bps at 0.04 — six numbers, one
constant four-million-lamport error, only the denominator moving.

Coverage still absent, stated rather than implied: USDC quote, legacy SPL base,
bonding curve, Mayhem vs non-Mayhem, fee-tier boundaries, and parity against a
*landed* mainnet transaction.

## 12. Direct mint facts — NOW COLLECTED IN PAPER

The read was gated on `capitalAtRisk(mode)`. Paper risks nothing and produces
the entire research corpus, so **no row anywhere recorded** whether a candidate
carried a freeze authority, a transfer hook or a permanent delegate. The gate
that would refuse one in a capital mode had never fired on any token, ever. Its
false-positive rate, its cost in missed winners and its protective value were
all unmeasured, and the first run with money on it would have been the first run
at all.

The mode still decides what a hostile fact *does*. It no longer decides whether
the fact is looked at.

`solana/src/token2022.ts` is deleted. It graded the TLV area; `solana/src/mint.ts`
does that and also decodes both transfer-fee schedules, selects between them by
epoch, reports the worst case when the epoch is unknown, and refuses an
extension newer than itself. The directive's required-capability list is exactly
the second one's, and the pipeline called the first.

Live corpus after the restart: 73 mints, 69 Token-2022, 3 legacy, 1 unreadable
and recorded as UNKNOWN rather than dropped.

## 13. Four cohorts, exploration, strategy version

Three of four arms could not produce a single screening: the global 2m–60m age
gate was applied to every cohort, so a token that matured into `AGE_1H_5H` was
vetoed `too_old` by a window that only ever described `AGE_2M_60M`.

`floor(maxQuotesPerCycle × 0.25)` is 0 whenever the budget is under four, and
the configured budget is 2 — the stated 25% exploration arm had **never run a
quote**. The entitlement now carries across cycles.

The exploited arm's inclusion probability was 1. Reweighting on a 1 treats a
selected survivor as representing only itself, which is the bias the exploration
arm exists to measure. It is now `budget / eligible`.

The score computed v0.5 semantics while all four config files stamped rows
`delayed-momentum-v0.4.0`. Both are now `v0.6.0` and a test fails if they
diverge.

## 14. WSS alarms and the urgent queue

The reserve account was "the first writable account that is not the taker's and
not an ATA" — a position in a list, not an identity. It now watches the
canonical PumpSwap pool through the SDK's own PDA. `unwatch` passed an empty
string, so every closed position leaked its subscription. And `urgentMarks` was
written by the alarm callback and read by **nothing**.

## 15. Direct event pipeline

`artifacts/direct-signal-status.json`.

```
received/s   1,098        parsed 16.6%
dropped      0            queue high water 3,251 of 5,000
rows/day     1,309,738    against the firehose's 91,155,852
compression  20.3 trades per bar
```

The drain ran **synchronously inside** `offer()`, so the queue never held more
than one event and `maxQueue` was unreachable. `feedsProductionDecisions: false`
is stated in the artifact. It is telemetry.

## 16. Confirmatory view and readiness

One position could produce **nine** rows: v1 and v2 JOIN `simulation_jobs` on
the observation id, and the live corpus has observations with three jobs. v3
uses `EXISTS`. Measured in test: v2 emits 9, v3 emits 1.

Drawdown started at **zero cumulative PnL**. The first losing trade has
`peak = 0` so the branch is skipped entirely, and a 0.01 SOL give-back against
0.02 SOL of profit reads as a 50% drawdown. Both errors point the same way early
in a sample. Equity now starts at the frozen starting NAV.

Every artifact carries its commit, dirty flag, strategy version, schema version
and sample query, and freshness **refuses** rather than warns.

## 17. Reject panel

`artifacts/reject-panel.json`, `docs/REJECT_PANEL_V2.md`. 68 mints, 24 strata,
seeded and versioned, inverse-probability weighted.

```
NO_ROUTE_CONFIRMED       55
EXECUTABLE_VALUE          9
UNBUILDABLE               3
SIMULATION_UNAVAILABLE    1
```

**Twenty of twenty-four gates are refusing tokens the direct family could not
have traded anyway** — no canonical pool. Their measured cost in foregone
entries is approximately zero, and so is their measured benefit.

`excessive_impact` and `insufficient_flow` are the two that bite: every sampled
reject under `excessive_impact` had a pool and filled in the runtime.

Caveat stated in the artifact: `NO_ROUTE_CONFIRMED` means no *canonical PumpSwap
pool*, not that no venue exists anywhere.

## 18. Infrastructure decision — NOT JUSTIFIED

`artifacts/rate-budget.json`.

```
measured bottleneck   mark_scheduler_below_rate_ceiling
call rate             0.30/s against a 1 RPS ceiling
Developer plan        NOT JUSTIFIED
```

The binding test previously read `rateLimited > 0 || backlog > 0`, so a backlog
alone made the upgrade come out **JUSTIFIED** on a window whose call rate was a
third of the ceiling. It would have recommended paying to raise a bound that was
never reached. A backlog is evidence only while the call rate is near the
ceiling; below it, the bottleneck is the scheduler and no plan buys that.

Nothing else is purchased. The artifact says no to archival RPC, premium gRPC,
shreds, colocation, a large VPS and a dedicated validator by name.

## 19. Required tests

`tests/unit/p24-required-3bc708d.test.ts` is the index, and it is **asserted**:
every named home must exist and contain tests, the uncovered items must be
exactly the ones named with reasons, and the count is checked.

```
46 of 48 covered
```

The two that are not, and why:

- **14** the paper shell calls core shadow lifecycle — P6 is not built, so there
  is no core shadow lifecycle to call
- **32** Mayhem flow is excluded from organic breadth — the table exists and
  nothing populates it, so there is nothing to exclude from

The index found two of its own errors on first run: two homes it named did not
exist. Both were then written.

Suite: **84 files, 1,157 tests, 4 skipped.**

## 20. Not done, and why

- **P5** production core refactor. `paper-core.ts` exists and owns entry
  admission; the full split (mark selection, trigger, later fill, blocked retry,
  portfolio close, ledger settlement) and the machine-generated call graph are
  not done.
- **P6** shadow trajectories. The shared trajectory table and the
  `POSITION_OPEN → EXIT_TRIGGERED → AWAITING_FILL_OBSERVATION → EXIT_BLOCKED →
  POSITION_CLOSED` lifecycle are not built.
- **P11 Mayhem and entity facts.** The `mayhem_facts` table landed with
  migration 31; no source populates it.
- **P19** development tournament. The directive gates it on P2–P15 passing.
  P5 and P6 do not.
- **P22** confirmatory window. Gated on an arm being selected by P19.
- **P14** remaining matrix cells (§11).

## 21. Commands

```bash
pnpm paper
```

```bash
pnpm simulator:true-stateful-proof
```

```bash
pnpm size:true-stateful-surface
```

```bash
pnpm pumpswap:parity-v2
```

```bash
pnpm reject:panel
```

```bash
pnpm rate:budget
```

## 22. Every unresolved blocker

1. **Production still cannot open a position** at the current risk budget
   against the measured mechanics floor. The lifecycle machinery is proven in
   the runtime; the paper engine has not produced a complete trajectory through
   it.
2. **The sample is small and possibly selected.** Three mints in the parity
   matrix, four in the size surface, three complete round trips. Two of six
   mints attempted failed entirely in the runtime, so the sample is "the mints
   the apparatus can simulate".
3. **No sell parity against a landed mainnet transaction.** Parity is against
   the runtime, which is the same model the quote came from in one of the four
   arms.
4. **The mark scheduler is behind at a third of the rate ceiling** and the cause
   is unidentified.
5. **Dust cannot be exited.** One atom of these tokens prices at zero lamports.
6. **P5, P6, P19 and P22** as above.

## 23. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

Not `VALID_STATEFUL_TRAJECTORIES_RUNNING`. That requires

```
the running paper engine
→ true sequential state
→ complete settlement
→ identical ledger
→ later fill
→ balanced cohort trajectory
→ clean current context
```

The sequential runtime now exists and produces complete, correctly classified
buy→sell→close lifecycles with reconciled economics. **The running paper engine
does not yet drive it**, and no balanced cohort trajectory exists. The
measurement apparatus is repaired; the generator that would use it is not
finished.

Not `DEVELOPMENT_ARM_SELECTED` either: P19 is gated on P5 and P6, and both are
open.
