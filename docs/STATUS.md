# STATUS

> **2026-08-15 (latest) — independent adversarial audit at head `74f839e`.
> State: `MEASUREMENT_REPAIR_REQUIRED`.**
> Ten findings, six confirmed by executable probes
> (`tests/unit/adversarial-audit-74f839e.test.ts`, 19 tests).
> **The `VALID_TRAJECTORY_KERNEL_RUNNING` claim below is NOT withdrawn and NOT
> confirmed** — the audit ran in a container with no `data/runtime.db` at all,
> so the twenty trajectories were unreachable and eight of fourteen attack
> sections are `NOT TESTABLE`.
> Confirmed defects: the P3 quote-state proof **passes vacuously when `observe`
> returns nothing, and the sell is then priced from PRE-BUY state while
> reporting `quoteStateSurvived: true`** (F1); the coherent-snapshot economic
> drift check is unreachable on real RPC output (F3); sysvars are exempt from
> drift so a mixed-slot Clock is accepted (F4); a missing fee config falls back
> to the program default rather than refusing (F5); `requireDecodable` never
> decodes (F6). The sequential runtime is hardcoded to `wsl`, though the worker
> builds and runs natively on Linux — so no independent party can currently
> re-derive a trajectory (F9).
> Nothing was repaired: the probes record a failing baseline for separate
> commits. `docs/ADVERSARIAL_AUDIT_74F839E.md`.

> **2026-08-14 — trajectory-kernel directive from `1c499cd`, COMPLETE.
> State: `VALID_TRAJECTORY_KERNEL_RUNNING`.**
> All 22 sections done. **Twenty trajectories completed** — buy → sell → close
> inside ONE runtime, the sell priced from the state the buy committed and
> executed against that same state; 20/20 `quoteStateSurvived` per account by
> content hash.
>
> **The round-trip drag is a FIXED ~10,100,000 lamport account SETUP cost (five
> rent-exempt minimums), not price impact.** Across a 4x size range the median
> drag moves 1.8% in lamports and 293% in bps. This overturned an earlier
> "median -12.7%" reading, which would have implied a proportional drag no
> strategy could clear — it is a first-trade cost that amortises with size, and
> the proportional floor underneath is 250 bps.
>
> `DEVELOPMENT_EDGE_CANDIDATE` is NOT claimed: no edge has been measured, only a
> cost structure. `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is NOT claimed
> either — killing it on the first reading would have been killing it on a units
> error. `docs/1C499CD_FINAL_REPORT.md`.
>
> Not done: `true-stateful-proof.ts` still contains the pass-1/pass-2 structure
> P3 replaces. Nothing signed, submitted or funded on chain.

> **2026-08-14 — trajectory-kernel directive from `1c499cd`, second
> pass. State: `MEASUREMENT_REPAIR_REQUIRED`.**
> The candidate stream was the binding constraint and it is now measured: only
> **6 of 185** screened mints have a canonical PumpSwap pool (~3%), against
> **6 of 6** for migration-sourced candidates. The stored migration corpus is
> noise — 256,880 rows of which **256,235 are errored transactions** and **zero
> of 300** sampled identities survive `canonicalPool(mint) == pool`.
> Coherent snapshots, verified migration identity, Pump cashback mechanics, the
> trajectory kernel and real entry/exit treatments are built and proven against
> the live chain. **`pnpm trajectory:collect` deliberately refuses to open a
> trajectory**: doing so without the one-pass sequential worker (P3) would price
> the exit from a state that never contained the entry.
> **Zero trajectories have completed.** `docs/1C499CD_TRAJECTORY_KERNEL_REPORT.md`.

> **2026-08-14 (later) — trajectory-kernel directive from `1c499cd`. State:
> `MEASUREMENT_REPAIR_REQUIRED`.**
> The later-fill deadlock is repaired: 169 trajectories had been waiting up to
> 4.6 hours because `resolveFill` required an effect-valid candidate and nothing
> ever simulated one. **Zero trajectories have still completed** — 93% of marks
> have no exit route, because the exit still runs through a router that declines
> tokens with no canonical pool. `docs/1C499CD_PROGRESS_REPORT.md`.

---

> **2026-08-14 — true-stateful directive from `3bc708d`. State:
> `MEASUREMENT_REPAIR_REQUIRED`.**
> The sequential runtime produces complete, correctly classified
> buy → sell → close lifecycles whose economics reconcile to **one lamport**.
> The shadow lifecycle now triggers and awaits a later fill, which voided all
> **1,038** shadow results that existed before it
> (`docs/SHADOW_TRIGGER_FILL_INVALIDATION.md`). **No trajectory has completed
> through the repaired lifecycle.** `docs/3BC708D_FINAL_REPORT.md`.

Last updated: 2026-08-14T00:10Z

## Operational right now

| | |
|---|---|
| mode | `paper`, engine LIVE |
| schema | v36 |
| strategy version | `delayed-momentum-v0.6.0` |
| positions with executable PnL | **0** |
| direct mint facts collected | yes, in every mode (was capital-only) |

## What is proven, and on what sample

| claim | evidence | sample |
|---|---|---|
| a sequence commits: step 2 starts from what step 1 left | `artifacts/sequential-runtime-proof.json` | one SOL transfer, no program |
| the sell is priced AND built from the buy-mutated pool | `artifacts/true-stateful-roundtrip-proof.json` | 3 complete lifecycles of 70 attempted |
| the offline model equals the runtime's executed output | `artifacts/pumpswap-parity-v2.json` | 36 of 36 cells, 0 bps, both sides, 6 sizes |
| the mechanics floor is 241.5 bps of AMM drag, flat in size | `artifacts/true-stateful-size-surface.json` | 4 mints, 24 points |
| 20 of 24 gates refuse tokens with no canonical pool | `artifacts/reject-panel.json` | 68 mints, 24 strata, seeded |
| the Jupiter upgrade is not justified | `artifacts/rate-budget.json` | bottleneck is the scheduler at 0.30/s of a 1 RPS ceiling |
| every required production call edge holds | `artifacts/production-call-graph.json` | 15 edges, resolved through the TypeScript checker |
| a shadow trigger no longer closes a position | live database | 40 positions `AWAITING_FILL_OBSERVATION` |
| the model matches transactions that LANDED | `artifacts/landed-parity.json` | 13 of 13 measured-quote swaps exact |
| the model matches on a LEGACY SPL base pool | `artifacts/pumpswap-parity-v2.json` | 12/12 cells exact |
| holders cluster into far fewer actors | `entity_concentration` | 20 addresses → 13 entities, top-10 5,242 → 8,574 bps |
| the mechanics floor is a step function of market cap | `artifacts/fee-tier-surface.json` | 25 tiers, 250 → 60 bps |

## What is disabled

- **Canary and live.** Both are blocked by `.claude/hooks/guard.mjs` and by the
  acknowledgement file requirement. Neither has been run.
- **The direct event stream as a decision input.** It is bounded and stored as
  per-mint flow bars; `feedsProductionDecisions: false` is stated in its own
  artifact. It is telemetry.
- **Mayhem facts.** `mayhem_facts` exists as of migration 31 and nothing
  populates it.

## What is unproven

- Production has never opened a position. The lifecycle machinery is proven in
  the runtime, not in the engine.
- The parity and size samples are small and possibly selected: two of six mints
  attempted failed entirely in the runtime, so the sample is "the mints the
  apparatus can simulate".
- No parity against a **landed** mainnet transaction. Parity is against the
  runtime.
- The mark scheduler runs behind at a third of the rate ceiling and the cause is
  unidentified.
- Dust cannot be exited: one atom of these tokens prices at zero lamports.

## Not done from this directive

- **The live write of `mayhem_facts` and `entity_concentration`** — wired and
  decoding correctly against real pool bytes, but both run only on eligible
  candidates (~0.25%), and the direct probe hit the RPC **daily** cap. Run
  `pnpm enrichment:probe` once it resets.
- **The Mayhem program's account layout** — no published IDL, so agent
  inventory, buys, sells and the burn transition are refused rather than
  guessed. The Mayhem *flag* itself is read from the pool and the bonding curve.
- **`P19` execution** — preregistered and allocating arms; zero completed
  trajectories against a first checkpoint of ten per arm.
- **`P22`** — gated on an arm being selected by P19.
- **`P14`** remaining matrix cells: USDC quote, legacy SPL base, bonding curve,
  fee-tier boundaries, parity against a landed mainnet transaction.

## Voided by this directive

All **1,038** closed shadow positions and the −18,338,967,174 lamports summed
across them. Each was closed at its triggering mark's own value.
`fill_latency_ms IS NULL` marks a pre-P6 row.

---

## Current state

**Observe mode is built and has been run against live mainnet data.** No position
has ever been opened, no key exists, no transaction has ever been signed or sent.

| Phase | State |
| --- | --- |
| 0 — environment audit | done |
| 1 — current-source verification | done |
| 2 — observe-mode vertical slice | **done, run against mainnet** |
| 3 — paper mode | **done, running** (strategy `v0.3.0`) |
| 3b — solana package (base58, mint/Token-2022, tx policy) | done, 32 unit tests on real mainnet fixtures |
| 3c — operational commands (`doctor`/`status`/`health`/`kill`/`secretscan`/`check`) | done |
| 4 — replay / backtest / report | **done**; replay verified 2,200 snapshots, 0 divergence |
| 5 — executor (signer, binding, effect, state machine, gates) | **built**, gated off by measurement |

## What actually ran

Live run 2026-08-11T21:59–22:02Z, keyless Jupiter, mainnet:

```
candidates discovered   717
screenings persisted   1861
round-trip quotes         4  (2 full round trips)
eligible candidates       1
```

Nothing about that run was simulated. Numbers below are measured, not modelled.

## Measured economics

The single most important number in this system is what a full in-and-out costs
before any thesis is applied.

| Token | Age at quote | Liquidity | Probe | Round-trip loss |
| --- | --- | --- | --- | --- |
| `6rme4sMM…pump` | seconds | ~$3k | 0.05 SOL | **298 bps** |
| `5ziigNJ8…pump` (POIPOI) | 52 min | $16k | 0.05 SOL | **134 bps / 255 bps** (two samples, 3 min apart) |

Both were routed `metis` → `Pump.fun Amm`. This is the empirical case for the
delayed-momentum thesis: waiting costs optionality but roughly halves the cost
floor. Neither figure includes priority fees, ATA rent, or failed transactions.

## Findings that changed the design

**1. The discovery feed and the strategy do not intersect.**
`/tokens/v2/recent` contains only tokens whose first pool was just created. The
strategy refuses anything under 2 minutes old. Screening the recent feed
directly produced 90/90 `too_young` rejections — a filter that can never pass.
Fixed by adding a maturation queue (`maturingMints`) that re-fetches banked
mints once they age into the window, via `search` (100 mints per request).

**2. `organicScore` is 0 for every token under ~1 hour old.**
n=461, zero exceptions. Jupiter has not computed reputation that early. As a
hard veto this silently rejected 100% of the strategy's own window. Absence of a
provider's score is a data-availability fact, not evidence about the token, so
it is now a **soft risk (0.25)**; a score that *has* been computed and is low
remains a hard veto.

**3. The maturation queue must round-robin, not sort by age.**
Ordering by age pinned the queue to the youngest 100 in-window mints, so nothing
older than ~5 minutes was ever re-examined. Reordered to least-recently-screened
first. The first eligible candidate appeared one cycle later.

**4. Jupiter's new-token fee does not match its documentation.**
Docs state 50 bps for tokens under 24h. Every live quote measured returned
`feeBps: 10`. Unresolved — see RESEARCH.md. Config models **50 bps** anyway
(`assumedNewTokenFeeBps`), because being wrong in the expensive direction is
survivable and being wrong in the cheap direction is not.

**5. Missing provider data was hard-vetoing 100% of the target population.**
This is the same bug class as finding #2, found twice more. Measured over 3,561
screenings: `devBalancePercentage` was **null for 81%** of tokens and
`topHoldersPercentage` null for 21% — yet both were wired as hard vetoes, so a
field the provider simply had not computed was recorded as evidence against the
token. Of the 33 candidates that cleared liquidity, 31 died on
`dev_holds_too_much` while `devBalancePct` was null.

The rule now applied uniformly across all three cases: **absence of a provider
field is a fact about the provider, not about the token.** Present-and-bad is a
hard veto; absent is graded soft risk (`dev_balance_unavailable` 0.2,
`top_holders_unavailable` 0.15).

Provider `topHoldersPercentage` was additionally demoted to soft risk outright,
because it counts the liquidity pool as a holder. A bonding curve holding most
of supply is the counterparty we trade against, not a whale waiting to dump.

Measured effect after the fix (strategy `v0.2.0`, n=200): `dev_holds_too_much`
fell from **83% of screenings to 4%**, and the cheap layer began promoting
candidates to the quote stage again (`cheapPassed` 0 → 1 per cycle).

A hypothesis I held here was wrong and the measurement killed it: I expected
`topHoldersPercentage` to be uniformly ~89% because of pool inventory. The
distribution is actually median 3.55% / p75 22.7%, with only 41/3,561 in the
85–95% band. The ~89% figure applies only to the liquidity-passing subset.

**6. Authoritative holder concentration replaced the provider figure — and needs a keyed RPC.**
`fetchConcentration` (packages/solana/src/rpc.ts) measures concentration on-chain
and excludes program-controlled inventory *structurally*: a real wallet's token
account is owned by the System Program, whereas a pool authority is a PDA owned
by its AMM. This is a shape test, not a venue allowlist, so a new launchpad does
not silently defeat it. Accounts whose ownership cannot be resolved are counted
as program-controlled for the pool figure and excluded from the wallet figures,
so an unresolved account can never make concentration look *better* than it is.

`getTokenLargestAccounts` returns **HTTP 429 on `api.mainnet-beta.solana.com`
even on a first isolated call**, while `getTokenSupply`, `getMultipleAccounts`
and `getAccountInfo` all return 200. This is a per-method block, not our rate
budget. Consequence: the check reports *unavailable* on the public endpoint,
which is graded as soft risk (0.3) in observe/paper but is a **hard veto in
canary/live** — a mode that commits capital refuses an unmeasurable holder
distribution. A keyed RPC is therefore a hard prerequisite for canary/live, and
`pnpm doctor` probes this method explicitly so the limitation surfaces before
capital is at stake, not during.

**7. The account was too small to ever open a position — silently.**
Paper ran for hours opening nothing. That reads as "the strategy found nothing",
which is why it went unnoticed. The real cause was arithmetic: with a 2 SOL NAV
the largest position the risk caps could *ever* authorise was 0.02 SOL, while
the fee-viability floor was 0.0448 SOL. Every candidate, at every score up to
1.0, was refused with `size_below_viable`. The strategy was not selective; it
was disabled.

Two separate defects were tangled together here:

- *The cost model was wrong.* The floor charged full ATA rent (2,039,280
  lamports) as a sunk fee. Rent is **refunded when the token account is closed**,
  so on a successful exit it is a temporary lockup, not a cost. It is only truly
  lost when the position cannot be sold at all, because an account holding a
  nonzero balance cannot be closed. Now modelled as
  `2×(signature + priority) + rent×(1 − recoveryRate)` with `recoveryRate` an
  explicit, measurable assumption (currently 0.5) rather than an implicit 0.
  Non-recoverable round-trip cost: **0.00143 SOL**. Floor at 5% of notional:
  **0.0286 SOL**, down from 0.0448.
- *The capital was genuinely insufficient.* Even corrected, 2 SOL cannot clear
  the floor. Minimum viable NAV is ~2.9 SOL at a perfect score and ~5.7 SOL at a
  typical one. Paper NAV raised to 10 SOL, which is the honest statement that
  **this strategy has a minimum capital requirement**, not a preference.

`pnpm doctor` now fails on `config.viableCapital` when the largest permitted
position sits below the floor, so this cannot recur silently. A unit test pins
both directions: 10 SOL trades, 2 SOL is refused at every score.

Screening logic was untouched, so `strategyVersion` stays at `v0.2.0` and the
replay dataset remains valid. The change is to sizing policy only, and no
position had ever been opened under the old sizing.

**8. `reject_tracking` was recording rejections but no outcomes.**
Every row had a horizon of ~2 ms: the table stored the instant of rejection and
nothing after it. The question it exists to answer — what did the tokens we
refused go on to do — was unanswerable, so no gate could be justified or
challenged with evidence.

The cycle now runs a fourth phase that re-observes rejected mints on a
10-minute cadence, anchored on each mint's *first* rejection so a horizon means
the same thing for every row. One batched `search` request covers 100 mints, so
the whole panel costs one request per cycle.

Two things this deliberately does not do: it does not drop mints the provider
stopped quoting (that is the most common outcome in this population, and
dropping them would leave a panel made entirely of survivors — they are recorded
with a null price and counted as −100%), and it does not infer route existence
from liquidity, which is a different claim than the one being made.

`pnpm backtest` reports gate counterfactuals off this panel. It explicitly
**refuses to print a strategy equity curve**, because too few positions exist for
one to mean anything, and prints the reason instead.

## Rejection breakdown (n=1861 screenings)

```
insufficient_liquidity       1838
too_few_holders              1748
dev_holds_too_much           1559
insufficient_net_buyers      1522
insufficient_flow            1351
concentrated_ownership        733
low_organic_score             461   (pre-fix; no longer a hard veto)
too_young                      90
stale_source                   69
provider_flagged_suspicious    31
excessive_impact                1
```

Base rate of eligibility is roughly **1 in 1800 screenings**. That is the
headline result of observe mode so far and it is deliberately not "fixed" by
loosening gates: every reject is stored with its state at reject time
(`reject_tracking`) so a later pass can measure what each filter cost us.

## Safety posture

- `MODE` defaults to `observe`. `config/observe.json` is the only committed config.
- No keypair file exists; `TRADING_KEYPAIR_PATH` is unset.
- Quotes are requested **without `taker`**, so Jupiter cannot return a signable
  transaction to a process running in observe or paper mode.
- Cross-process lock (`process_locks`) prevents a second collector from running.
- All external strings (token name, symbol, launchpad) are stripped of control
  characters and bidi overrides before they touch a log line or the database.

## Open calibration question (not yet answered)

After fixing finding #5, the binding constraint is `insufficient_liquidity` at
**98.5%** of rejects. Liquidity in the strategy's age window is pinned at the
pump.fun bonding-curve floor: p10 $2,282 / p50 $2,285 / p95 $2,862, with only
**1.1%** clearing the configured $8,000 floor.

That floor is 400x our maximum position (0.1 SOL, ~$20). It may well be far
stricter than exit economics require — but **we have never quoted anything below
it**, so the claim "small pools are unexecutable" is currently unsupported by
any measurement. This is a selection effect, not evidence.

It will be resolved by measuring round-trip cost against a stratified sample of
sub-threshold tokens, not by lowering the threshold until trades appear. Until
that measurement exists the floor stays where it is.

## Safety posture (additions)

- No `sendTransaction` method exists on the RPC client *at all*, so no
  observe/paper/replay/backtest path can reach the network with a signature.
- The RPC client falls back to a secondary endpoint on transport failure but
  **rethrows immediately on schema drift**: asking a different host until one
  agrees with us is how a bug becomes a silent policy change.
- `pnpm kill` clears a lock only after confirming the owning pid is dead, and
  refuses to touch locks written by another host. Force-clearing a live lock
  would let two engines share one ledger.
- `pnpm secretscan` is verified against a planted 64-byte keypair array rather
  than assumed to work. It never prints matched text.
- Token-2022 extension decoding fails closed: an unknown discriminant is refused,
  not skipped.

## Post-fix funnel (strategy v0.2.0, 10 SOL NAV)

Measured over a 0.4h window after findings #7 and #8 were fixed:

```
screenings           4398
eligible                8   (0.18%, ~22/hour)
paper positions         3   (simulated fills, real quotes)
```

The `sole cause` column in `pnpm report` is the actionable one: a gate that only
ever fires alongside others can be loosened without admitting a single extra
candidate. Currently `insufficient_liquidity` is the sole blocker **47** times
and `excessive_impact` **8** times; every other gate is almost always
co-occurring. So the liquidity floor is the only calibration that would change
the funnel, which is exactly the open question below.

## Replay determinism

`pnpm replay` re-decides stored snapshots and compares against what was recorded:

```
snapshots examined   3000
replayed             2200   (current strategy version)
skipped (other ver)   800
divergent               0
```

The harness earned its place immediately by finding a real defect: `route_labels`
is written as a `>`-joined path but replay was parsing it as JSON, so 10 rows
threw. That is a storage/deserialization mismatch that no test asserted on and
no runtime path exercised, because nothing else reads quotes back out.

## Verified-unverified

One claim this system cannot yet make: **that a signable transaction can be
produced at all.** All 53 quotes report `transaction_buildable = 0`. That is
correct and intended — quote-only requests omit `taker`, so Jupiter never
returns a transaction to a keyless process — but it means the build-and-sign
path has never been exercised end to end. `pnpm report` prints this as
UNVERIFIED rather than letting an empty column read as success. Canary must
demonstrate it before live.

## The executor exists and refuses to run

`pnpm canary` and `pnpm live` are wired to real code today. Both exit 1 before a
key is loaded, and they say why in measurements rather than in a refusal:

```
$ pnpm canary                          $ pnpm live
8 gates, 4 not met                     12 gates, 7 not met
  signer.keypair          unset          + evidence.onChainFills      0 (need 30)
  rpc.primary             unset          + evidence.attemptFailureRate  no attempts
  evidence.paperPositions 5 (need 200)   + live.acknowledgement       LIVE_ACK_PATH unset
  evidence.observationWindow 0.7h (72h)
```

This is deliberately not a feature flag. A disabled path rots; this one is
executed on every invocation and what stops it is evidence. Thresholds live in
`packages/execution/src/gates.ts` as written-down numbers reported next to the
observation, so a reader can disagree with the choice instead of reverse-
engineering it. **A gate whose evidence cannot be gathered fails** — never
"passes with a warning", because an unmeasurable precondition is exactly where a
system is most likely to be wrong about itself.

### Three layers, none optional

`Signer.sign()` runs policy → binding → effect and stops at the first refusal.

- **Policy** — structural sanity: are we the fee payer, is every program on the
  allowlist, is the priority fee under the ceiling.
- **Binding** — does this transaction match the intent that asked for it? Bounds
  the deadline, the priority fee, and lamport outflow from account 0.
- **Effect** — what will these bytes actually *do*? Answered by simulating and
  diffing token-account balances, not by parsing.

That last split is an admitted limitation made structural. Jupiter's swap amounts
sit inside Anchor instruction data whose discriminator and field order I could
not verify against a current official source at signing time. Hardcoding a
remembered layout would produce a check that *appears* to bound the trade and
silently does not, which is worse than no check. So `binding.ts` bounds only what
the bytes prove unambiguously, and `effect.ts` establishes the amount bound by
measurement. A System Transfer of unexpected length is counted as
`undecodable_system_transfer` and refused: an amount we cannot read is not an
amount we can bound.

### A failed send is not a transaction that did not happen

It is a transaction whose fate is unknown, and the three possible truths (never
broadcast / broadcast and landed / broadcast and failed) call for different
actions. So the `execution_attempts` row carrying the signature is written to
SQLite **before** the send, a send that throws is recorded `UNKNOWN` rather than
`FAILED`, and expiry is only declared once block height provably exceeds
`lastValidBlockHeight`. Absence of a status is evidence of absence only after the
blockhash is dead. `resolveOutstanding()` blocks all execution while any attempt
is unresolved, and `apps/executor/src/main.ts` refuses to trade if it returns
nonzero — trading on top of an unknown balance is how one bad transaction becomes
a bad afternoon.

Idempotency is a UNIQUE constraint, not a read-then-write, because read-then-write
is not atomic across a crash and a crash is precisely what interrupts this.

### What is deliberately absent

The entry/exit loop is a visible gap in `main.ts`, not a stub. A stub that
appears to trade and does not is worse than a hole you can see.

`pnpm reconcile` is the only path allowed to write fills for on-chain trades, and
it writes them from `getTransaction` balance deltas rather than from the quote
that preceded them — the quote is what we hoped for, the balances are what
happened. It records `priorityFeeLamports: 0` because `getTransaction` does not
separate the priority component from the base fee; a fabricated split would
corrupt the very cost model that depends on it.

### Signer test suite

18 tests, all passing, against real ed25519 keys and genuinely wire-format-correct
v0 transactions. They exist because the signer is the only component whose failure
is unbounded: every other defect costs a trade, a signer defect costs the wallet.
Covered: keypair loading refuses a stored public half that disagrees with its
secret half; refusals for wrong fee payer, unauthorised program, priority fee
above the intent, expired intent, outflow above the intent, and unverified effect;
signature placement at slot zero leaves the message byte-identical; the emitted
signature verifies against the message it claims to sign.

Writing them found one real defect in the tests themselves rather than the code —
a case named "refuses a priority fee above the intent" was asserting the opposite,
because the policy ceiling is derived from the intent and raising one raises both.
Split into two tests that each assert what their name says.

## 2026-08-11 — test suites, register, ledger, agent controls

**180 tests across 12 files, all passing in 3.65s. Typecheck clean.** Property,
replay, chaos and e2e suites are now in place, so items 2 and 3 of the previous
"Next" list are done.

`docs/FAILURE_REGISTER.csv` holds **181 rows** in 13 columns — 119 `implemented`,
37 `partial`, 22 `designed_not_implemented`, 3 `not_applicable_current_architecture`.
Every referenced fixture and owner module was confirmed to exist before commit.
`docs/MULTIPLE_TESTING_LEDGER.csv` holds 11 rows. `.claude/` carries six subagents,
a `permissions.deny` path policy, and one PreToolUse command-content hook with 44
subprocess tests behind it.

New documents: `ASSUMPTIONS.md` (A1–A17, each with its falsifier), `DECISION_LOG.md`
(D1–D12 with the rejected alternative), `UPGRADE_ROI.md`.

### The first paper outcomes exist, and they are not a result

**10 closed positions, all simulated. 1 winner. Net −0.248 SOL on 0.487 SOL
deployed.** This is n=10 from a single session. It cannot support any statement
about expectancy and must not be quoted as performance. Several documents
previously said "zero closed positions exist"; that is now corrected in A8, MT008
and MT009.

What the ten do carry is a **diagnostic**: 8 of 10 exited via `exit_cost_exploded`
— `exits.ts:51` forcing a sale because exit price impact breached
`maxExitImpactBps`. `stop_loss` and `trailing_stop` fired once each, so the
directional exit rules are almost untested.

### The exit reason is lying, and that was the actual finding

The first reading of those eight was that entries are sized beyond what exit
liquidity supports. **That was wrong.** Entry size was 0.05 SOL against a
`quoteProbeLamports` of exactly 0.05 SOL — the gate probes at the size actually
traded, and buy-side impact at entry was under 8 bps in every case. The
size-mismatch hypothesis is falsified.

Reading the sell-quote series instead showed the eight are **two populations**:

| | n | final sell impact | SOL returned | what happened |
| --- | --- | --- | --- | --- |
| Liquidity collapse | 4 | −9,900 to −10,000 bps | ~0 | the pool went away; ~100% loss |
| Cost drift | 4 | +519 to +911 bps | ≈ entry | the rule worked as intended |

Both record `exit_cost_exploded`, because `apps/engine/src/paper.ts:360` builds
the input as `Math.round(Math.abs(sell.priceImpactPct) * 10_000)`. The `Math.abs`
discards the only thing that separates "this sale costs more than we allow" from
"the pool this position lived in no longer exists".

Two consequences, registered as **Q029** and **Q030**:

1. Post-hoc analysis reading the `exit_reason` column would attribute four total
   losses to a miscalibrated cost cap and tune `maxExitImpactBps` — the wrong
   parameter, against rugs that no exit rule could have salvaged.
2. A large *favourable* impact reading also exceeds the cap and forces a sale.
   Not yet observed in the corpus; recorded as latent.

**No production code was changed.** Removing the `Math.abs` moves four of ten
observed exits onto a different rule, which is a deliberate change to exit
semantics and needs a decision, not a cleanup commit. `tests/unit/exits.test.ts`
pins the current behaviour so that change is visible when it happens.

**MT011 is corrected rather than rewritten** — the original framing trusted the
`exit_reason` column, and roughly 4 of 10, not 8, are actually evidence about
entry sizing or the liquidity floor. MT005's evidence is correspondingly weaker
than it first appeared.

### Two corrections found by reading back what was written

`db.ts:335` **does** back up the database on every non-readonly open, and
`data/runtime.db.bak` exists. The register claimed no backup existed. Corrected
O017 to `partial` rather than `implemented`, because the copy does not checkpoint
the WAL or copy `runtime.db-wal` (live file 299 MB against a 181 MB `.bak`), it
overwrites the previous copy every run, and its failure path is an empty `catch`
whose comment claims it surfaces the error. It does not.

`tests/replay/determinism.test.ts:148` accepted an `over` parameter and never
spread it, so the "sell" leg of the round-trip fixture was byte-identical to the
buy leg. Fixed; the suite still passes, now for the reason it claims.

Also corrected: `ARCHITECTURE.md` said `apps/executor/src/main.ts` calls
`loadConfig()` bare — it passes the mode explicitly (D9). Four callers still call
it bare; only `doctor.ts:48` matters, and that is O023.

## 2026-08-12 — provider keys wired, and what verifying them turned up

A Jupiter Portal key and a Helius key became available. Wiring them was expected
to be a five-minute change; re-verifying the providers against current official
documentation turned up three defects instead, all of which had been latent
because **no key had ever existed to exercise the keyed paths**.

**O028 — a secret that was loaded and consumed by nothing.** `HELIUS_API_KEY`
was read by `loadSecrets()` and used by zero callers. `pnpm doctor` reported it
as present. So an operator could set the key, see it confirmed, and get no
on-chain capability whatsoever — A5's top-holder measurement would silently
never run. `loadSecrets()` now derives `rpcHttp` from the key when
`SOLANA_RPC_HTTP` is unset, and records in `rpcHttpDerivedFromHeliusKey` which
source won, so doctor reports `endpoint derived from HELIUS_API_KEY` rather than
implying the operator configured an endpoint they never configured.

**O029 — a bucket configured at exactly the documented ceiling.** Jupiter
publishes a **free** Portal-keyed tier at 1 rps / 60 rpm. `SOURCE_MATRIX.csv`
did not record that this tier existed; it recorded the keyless 0.5 rps as though
it were the only limit. Meanwhile `config/source-limits.json` already carried
`withKeyRequestsPerSecond: 1.0` — exactly the ceiling, in breach of the
"strictly UNDER" rule stated in that file's own `_meta`. Lowered to 0.8,
preserving the 0.8x headroom ratio the keyless bucket already used.

The interesting part is how the matrix came to be wrong. The 0.5 rps figure was
verified correctly, against the right page, on the right date. What was never
asked was whether that number was *one of several tiers*. A verified number can
still be the wrong number, and a `checked_at_utc` stamp does not detect it.

**O030 — a live credential that has to live in a URL.** Helius authenticates by
query parameter, so consuming the key means building a string that contains it.
That is the provider's design, not a choice. `heliusRpcUrl()` assembles it in
one place; `scrubSecrets()` redacts it; `secretscan`'s `helius_url_with_key`
rule fails the build if the assembled form is ever committed.

Seven tests in `tests/unit/secrets.test.ts` pin this, including redaction of the
URL when interpolated into an ordinary error message — the realistic leak path,
since pino's key-path redaction does not apply to a URL sitting inside a string.
Confirmed against three deliberate mutations: dropping `encodeURIComponent`
fails 1 of 7, reversing the endpoint precedence fails 1 of 7, removing the
`api-key=` branch from `scrubSecrets` fails 2 of 7. All three files restored.

Suite: **194 tests / 14 files**, ~4s. Typecheck clean, secretscan clean over 103
files. Register now 186 rows: 122 implemented, 38 partial, 23
designed_not_implemented, 3 not_applicable.

**What this does not change.** The keyless path is still the default and still
works, so no subscription is load-bearing and the master constraint holds. And
2x throughput multiplies an expectancy that is still unmeasured at n=10. The
free key was worth taking because it costs nothing, not because it improves the
odds of anything. `UPGRADE_ROI.md` has been amended on both points — including
the discovery that most of the paid-RPC section's premise is probably wrong,
since 1M free Helius credits at 1 credit per RPC call likely covers the
on-chain checks that page assumed had to be bought.

**Not done, deliberately:** the keys themselves are not in this repository and
were not written by me. They belong in `.env`, which is git-ignored and which
`.claude/settings.json` denies reading.

## 2026-08-12 — P1: exit accounting rebuilt on executable value

Strategy version `delayed-momentum-v0.2.0` -> `delayed-momentum-v0.3.0`.
Accounting version `exit-accounting-v1`. Schema migration 5.
Baseline before this work: commit `f7826a5`, backup
`data/backups/runtime-baseline-20260812T0328Z.db` (383,127,552 bytes).

### The label was doing two jobs and could do neither

Eight of the first ten closed paper positions carried exit reason
`exit_cost_exploded`, which fired on `Math.abs(priceImpactPct) > maxExitImpactBps`.
Reading the stored quotes showed that one label covered a token that had
evaporated to 13 lamports and a position that was worth **105.7% of its cost**
when it was ejected, twenty-one seconds after opening.

The fix was not to delete the `Math.abs`. Jupiter documents **no sign convention
for `priceImpactPct` at all** — verified 2026-08-12 against both the v2 OpenAPI
spec and the v1 swagger, recorded in `docs/RESEARCH.md` as O032. A threshold over
a field whose direction the vendor never specified cannot be given a stable
meaning in either direction. The knob was removed rather than corrected, and
replaced with `liquidityCollapseRatioBps`, stated over the SOL a full-position
sell was quoted to return. Leaving `maxExitImpactBps` in the config unused would
have been the third instance of the O028/O031 dead-config defect class.

Outcome and trigger are now two columns. `ExitOutcome` answers "what happened to
the money"; `TriggerRule` answers "which rule noticed". Conflating them is what
produced a single label spanning a 20x difference in severity.

### All ten positions reclassified (`scripts/backfill-exit-accounting.ts`)

| position | mint | cost SOL | final executable | ratio | OLD reason | NEW outcome |
| --- | --- | --- | --- | --- | --- | --- |
| e8276fb2 | Do3oMFHg | 0.050839280 | 0.047538284 | 0.9351 | exit_cost_exploded | cost_drift |
| d68a5fc5 | 5bjC6rcN | 0.052139280 | 0.000481520 | 0.0092 | exit_cost_exploded | **liquidity_collapse** |
| acd33808 | DE6svnZL | 0.042939280 | 0.045388189 | **1.0570** | exit_cost_exploded | cost_drift |
| eff38f80 | 414LMZzC | 0.049343458 | 0.044628326 | 0.9044 | exit_cost_exploded | cost_drift |
| c8069ef2 | 3XiaH5DA | 0.049320251 | 0.000000013 | 0.0000 | exit_cost_exploded | **liquidity_collapse** |
| 5599b5d8 | DWAtCiyw | 0.050368663 | 0.023688794 | 0.4703 | stop_loss | severe_exit_degradation |
| 39bb459b | 8vPXzkoy | 0.048880498 | 0.043306010 | 0.8860 | trailing_stop | ordinary_stop_loss |
| cb9b5c75 | HTaEUsni | 0.045527853 | 0.000000008 | 0.0000 | exit_cost_exploded | **liquidity_collapse** |
| 6f8b1e79 | 23n8oNsU | 0.052233144 | 0.000491353 | 0.0094 | exit_cost_exploded | **liquidity_collapse** |
| b348a030 | 8vPXzkoy | 0.045884531 | 0.043027745 | 0.9377 | exit_cost_exploded | cost_drift |

150 marks and 10 exits persisted, all flagged `backfilled=1`.

### Where the money actually went

| outcome | n | net SOL | share of losses |
| --- | --- | --- | --- |
| liquidity_collapse | 4 | -0.199076823 | **80.1%** |
| severe_exit_degradation | 1 | -0.027590533 | 11.1% |
| cost_drift | 4 | -0.014641483 | 5.9% |
| ordinary_stop_loss | 1 | -0.007073668 | 2.8% |

This is the number the old label made unobtainable. Four positions out of ten
account for four fifths of all losses, and they are not a stop-loss problem.
Tuning `stopLossBps` or `maxExitImpactBps` against this corpus would have been
tuning against 2.8% of the damage.

### Were the collapses survivable? All four were abrupt; none was doomed at entry

| position | entry mark | peak | final | worst single step | healthy for | fatal step over |
| --- | --- | --- | --- | --- | --- | --- |
| d68a5fc5 | 0.990 | 1.115 | 0.0092 | 105.4pp = 95% of drawdown | 17/18 marks (515s) | 30.9s |
| c8069ef2 | 0.952 | 1.072 | 0.0000 | 86.3pp = 81% of drawdown | 37/38 marks (1131s) | 30.8s |
| cb9b5c75 | 0.891 | 0.981 | 0.0000 | 98.1pp = 100% of drawdown | 6/7 marks (176s) | 30.9s |
| 6f8b1e79 | 0.942 | 1.074 | 0.0094 | 106.2pp = 100% of drawdown | 17/18 marks (514s) | 31.2s |

Three of the four **peaked above cost**. Every fatal step measures ~31s, which
is exactly the mark cadence. **At this resolution we cannot distinguish a
one-block rug from a 25-second drain**, and that is a limitation of the
instrument, not a finding about the market. It is the direct justification for
the P2 10s cadence and WebSocket pool monitoring.

### Two further defects found while doing this

**`take_profit` had never been able to fire.** Gain was measured with
`lossBps(mark, cost)`, which is *positive* when the position is winning, and
then tested as `-up >= takeProfitBps` — false for every possible input. Zero
take-profits across ten positions was not evidence that none qualified.
Replaying the corrected rule over the stored marks with no look-ahead,
`39bb459b` crosses 6000bps at mark 13 of 19 and closes at **+0.033411329 SOL**
instead of trailing-stopping six marks later at -0.007073668 SOL. `takeProfitBps`
itself is unchanged at 6000. (O033, MT013.)

**Positions were marked against the slippage floor.** `paper.ts` used
`otherAmountThreshold`, which is derived from our own `slippageBps` and is not an
observation of anything. Every mark was understated by exactly the slippage
setting, biasing both the stop loss and the trailing stop toward early exits.
Marks now record `outAmount` as the value and keep `otherAmountThreshold`
beside it. (O036.)

### Counterfactual, stated with its limits

`scripts/counterfactual-exits.ts` replays the corrected rules over the stored
marks. 6 of 10 positions could be priced; the other 4 ran out of marks, because
the old exit is what ended the series and inventing a price past that point
would be fabricating a fill. Of the 6, **5 fire on the same mark as the real
exit — zero saving by construction.** The entire +0.041224850 SOL delta is the
one `take_profit` position. **The corrected collapse rule rescues none of the
four collapses.** That is the honest result, and it is why P2 is next rather
than any threshold tuning.

### Verification

- `pnpm check` — 246 tests, 16 files, all pass; typecheck clean; secretscan clean.
- Exit rules mutation-tested five ways, all caught: collapse `<=` to `<` (3 fail),
  collapse gated behind `minHoldMs` (1), take-profit arguments swapped back to
  the original bug (2), route check demoted below collapse (1),
  stop-loss `>=` to `>` (1).
- **Replay: 2000 of 2000 snapshots reproduced exactly** across the version bump,
  via the new `--as-version=` flag. Zero divergence, so v0.3.0 is attributable
  entirely to the exit changes and the entry path is byte-identical.
- `pnpm doctor` — 15 checks, 0 failed, 0 warnings.

A version bump previously made `pnpm replay` skip every stored snapshot and
report zero divergences while verifying nothing; the exit code was the only
thing separating that from a real pass. (O035.)

Unit tests were also reading the operator's real `.env` — a consequence of
closing O031 — so `tests/unit/secrets.test.ts` passed on a clean checkout and
failed on any configured machine, printing a live key in its diff. Suppressed at
the loader in `tests/setup.ts`. (O034.)

### Still open from P1

The same `Math.abs(priceImpactPct)` construction exists on the **entry** side at
`packages/intelligence/src/gates.ts:313`. It is not fixed here because entry
gating is P5/P6, and changing it now would confound the exit measurement.


## 2026-08-12 — P2a: the instrument, and three things it was not measuring

P2 asks whether any prospective signal could have escaped the four liquidity
collapses. P1 established that the corpus **cannot answer that**: every collapse
did all its damage inside a single mark interval, and the mark interval was ~31s
because open positions were only re-quoted when discovery ran. The resolution of
the entire exit corpus was set by the discovery budget. That is a property of the
instrument, not of the market (**O039**).

Commits: `c330ace`, `75e9e54`.

### What changed

| Change | Was | Is |
| --- | --- | --- |
| mark cadence | tied to `discoveryIntervalMs` (~31s observed) | `markIntervalMs`, its own field, 10s |
| loop tick | discovery cadence | mark cadence; discovery gates itself |
| paper `maxSimultaneousPositions` | 3 | 1 for the measurement phase (a tightening) |

Measured after restart, from `position_marks` rather than from the log: spacing
min 10540ms, median 10555ms. The blind spot is 3x narrower. It is not gone — a
sub-10s collapse is still one interval — and that limit stays stated rather than
forgotten.

### Three defects found while verifying it

The engine was live with 145 eligible candidates and **zero open positions**, and
had been for ~16h while reporting itself healthy.

**O037 — the daily loss cap was permanent, not daily.** `dayStartUtcMs` was
assigned once in `restoreLedger` and read by nothing, so `realizedTodayLamports`
accumulated from process start and never released at midnight UTC. The engine was
refusing every entry against losses realised on a previous calendar day. A cap
that never releases is indistinguishable from a hang. Same dead-field class as
O028, O031 and the old `maxExitImpactBps` knob — every mechanism except the one
that uses it.

**O038 — realised P&L summed through a double.** `SUM(CAST(realized_lamports AS
INTEGER))` read back as a JS number, which is precisely what storing the column
as TEXT exists to prevent. Latent, not yet wrong: paper NAV is far below 2^53.

**O040 / O041 — risk guarantees with no enforcement.** Four risk halts
(`drawdownHaltPct`, `dailyLossHaltPct`, `weeklyLossHaltPct`,
`maxAggregatePlannedLossPct`) were declared in the schema and listed in
`SAFER_WHEN_LOWER` — the tree would refuse to *loosen* four caps that nothing
enforced. Separately, the config header claimed `assertNotLoosened` enforced that
rule at load time; it is exported and never called, and `loadConfig` merges no env
or CLI values at all. `drawdownHaltPct` is now implemented as the `drawdown_halt`
refusal against peak NAV. The other three are a **named canary blocker**, not a
silent gap.

Neither `paper.ts` defect was reachable by a test, because `paper.ts` calls
`main()` at import. The ledger helpers now live in `apps/engine/src/ledger.ts`
for that reason alone.

### O042 — decisions were not re-derivable from their snapshots

This is the serious one, and it was only visible because O035 had just been fixed.

`finalizeScreen` evaluated the concentration gate against an authoritative
on-chain holder distribution and **stored none of it**. `replayOne` passed `null`
and carried a comment saying the caller excluded rows that had a measurement;
`replayAll` filtered on `strategy_version` and nothing else. The comment described
a filter that did not exist.

Once the running engine had written enough v0.3.0 rows for replay to actually
execute, **28 of 1012 snapshots diverged**: `softRiskScore` on all 28, and 4 that
lost a stored `concentrated_ownership` **hard veto** entirely.

Fixed at the snapshot, not at the filter. Fixing the filter would have been O035
again — verifying less while reporting success.

| replay | replayed | divergent | unverifiable |
| --- | --- | --- | --- |
| v0.3.0 (current) | 1476 | **0** | 34 |
| v0.2.0 (`--as-version=`) | 488 | **0** | 0 |

The 34 cannot be repaired — the data was never collected. They are counted and
printed as `unverifiable`, never as passes. `replayable()` fails closed on an
unparseable row so corruption is still reported as a divergence rather than
relabelled as an explanation it has not earned.

### Risk changes — PAPER ONLY (MT014, MT015)

`canary` and `live` were **not touched**.

| paper | was | is |
| --- | --- | --- |
| `dailyLossCapLamports` | 0.06 SOL | 0.5 SOL |
| `drawdownHaltPct` | 6 (enforced by nothing) | 50 (enforced) |

The daily cap is a loosening of an enforced cap and is recorded as one. Two
reasons, neither of them "returns improved":

1. **It censored the sample precisely after losses.** Trades were missing not at
   random — they were missing exactly following losing sequences, so the surviving
   sample over-represents days that started with wins. For a phase whose entire
   purpose is unbiased estimation of expectancy, that is a defect in the
   instrument, the same class as O039.
2. At ~2 entries/day it made P8's own preregistered 200-closed-trade gate a
   100-day run.

Paper mode holds no capital, so the cap protects nothing there; the newly enforced
drawdown halt bounds total paper loss at 50% of NAV. **No entry gate, liquidity
floor, position size, or exit threshold was changed.** In particular the liquidity
floor was not lowered to manufacture trades.

### Verification

- 277 tests pass across 17 files; typecheck and secretscan clean; `doctor` 15/15.
- Mutation testing: **5/5** caught on the ledger helpers, **6/6** on the drawdown
  halt and peak NAV, **7/7** on concentration capture and the unverifiable
  accounting. Each set includes the original defect as a mutation.
- One mutation set caught a regression in this very change: `replayable()` ran
  outside the caller's `try`, so a corrupt row crashed the whole replay instead of
  being reported. Now fails closed.

### State after restart

Engine live, one open position, marks at 10s, concentration captured and
round-tripping. **This does not yet answer P2's question** — that needs collapses
observed at the new cadence, and there are none yet.

## Next

1. ~~**MT011 and MT005** — why 8 of 10 exits were forced by cost.~~ **Answered
   2026-08-12.** They were not forced by cost. One label was covering four
   liquidity collapses, four ordinary cost drifts, and one position that was up
   5.7%. See the P1 section above.
2. ~~**P2a — resolve the 31s blind spot.**~~ **Instrument fixed 2026-08-12.**
   Marks now land at 10.5s median, one open position at a time. The *question*
   is still open: no collapse has been observed at the new cadence yet, so
   whether a prospective signal exists remains unanswered. No exit threshold
   should move before it is.
3. **P2b — counterfactual exits at every mark** (fixed, trailing, time,
   executable-output decay, reserve decay, dev/cluster selling), no look-ahead.
   The existing `scripts/counterfactual-exits.ts` prices only whole positions
   against the current rules; P2b needs a policy sweep recorded per mark.
4. **P2c — Helius WebSocket pool monitoring and alert-mode re-quoting**, so a
   material reserve/authority/LP change triggers a mark instead of waiting for
   the next tick.
5. **The three unenforced risk halts (O040)** — `dailyLossHaltPct`,
   `weeklyLossHaltPct`, `maxAggregatePlannedLossPct`. A canary blocker: they are
   declared in `config/live.json` and an operator would reasonably believe they
   are active.
6. `pnpm reconcile` must take the process lock (O024) — a live hazard today.
7. A backup that survives the WAL (O017).
8. Clock-skew and sleep/resume detection (A17, D015, O012) — the last wholly
   unguarded environmental assumptions.
9. `pnpm doctor --mode=` (O023); `evidence.replayCorpus` counting divergences
   rather than snapshots (S022).
10. Measure actual Helius credit burn over a week of observe mode, then decide
   whether P005/P006/P012/P013 are blocked by money or only by implementation.
   The free tier is 1M credits/month at 1 credit per standard RPC call, so the
   answer is probably "implementation" — but that is a measurement, not a guess.


---

## 2026-08-12 — P2a.1: validity repair, and the P2b preregistration

Full audit: `docs/P2A1_AUDIT.md`. Preregistration: `docs/P2B_PREREGISTRATION.md`.

### Final state

```
P2B_PREREGISTERED_AND_COLLECTING
```

That state means the confirmatory window is **open and empty**. It does not mean
the strategy works, and nothing in this session produced evidence that it does.

**0 trades in this corpus establish executable PnL.** The 20 closed positions and
603 marks that exist are development data, permanently — they have no retained
raw payload and no build-validated exit leg, so they fail admissibility on two
independent counts and re-labelling them does not change that.

### What was actually wrong

Everything below was found by looking, and every one of them is the same defect
class: a mechanism that was written, stored, listed in a schema, and read by no
decision.

| # | defect | consequence |
|---|---|---|
| O043 | the exit leg was never build-checked | a position could close against a price nobody had shown could be traded |
| O044 | absent `priceImpact` was parsed as `0` | indistinguishable from a perfect fill |
| O045 | one label spanned outage, collapse, and a winning position | any average over it describes nothing |
| O046 | no row recorded which experiment produced it | five regimes pooled into one average |
| O047 | cadence, timeouts and stale locks all ran on wall time | a resumed laptop bursts against a 0.5 RPS budget |
| O048 | ATA rent was credited back automatically | the credit is largest exactly where it is least deserved |
| O049 | `SAFER_WHEN_HIGHER` did not exist as a list | one hand-written `if`, and no mechanism to add a second field to |
| O050 | raw provider payloads were discarded | a parser bug was permanently unrecoverable |

### What now holds

- **Both legs build, or nothing is booked.** Entry and exit both go through
  `checkLeg()`, which runs the instruction-level policy decoder — same program
  allowlist, instruction cap, signer rule and priority-fee cap as the executor —
  and persists the attempt whether it passed or failed. `policy_status` carries
  its own coverage string so a research check can never read as the signer check.
- **Impact is parsed once, from measurement.** The directive's rule that a
  negative Jupiter impact indicates corruption is **refuted by the live API** and
  is not implemented; the evidence is in `packages/domain/src/impact.ts` and
  ledger row MT016. Absence is `ABSENT`, never `0`.
- **Eight mutually exclusive diagnostics**, ordered so a provider outage outranks
  a value collapse.
- **Every observation is tagged** with a run context, and `requireSingleRegime()`
  throws rather than pooling two.
- **Two ledgers.** `portfolio_paper` is the deployable wallet; `alpha_shadow`
  records what the signal said before the portfolio refused it, so losses stop
  silently censoring the sample.
- **Monotonic clocks** for cadence, timeouts and stale-lock detection; wall time
  only for logging and day boundaries. A divergence blocks entries until every
  open position is re-marked from a fresh route and the database checks out, and
  the block survives a restart.
- **The UTC day is derived from immutable rows** under a persisted date key, so a
  clock rollback has no counter to zero.
- **Rate budget is ordered.** An exit quote never queues behind discovery.
- **ATA rent is locked capital** and its recovery is zero, with the reason
  attached: withheld transfer fees are unobserved, and unobserved is not zero.
- **Raw payloads are retained**, deduplicated by content hash, so a future parser
  bug is recoverable.

### The two measurements that matter most

**At the canary cap of 0.02 SOL, ATA rent alone is 10.2% of the trade and total
non-recoverable fixed cost is 7.1%.** Both legs build at every size from 0.005 to
0.100 SOL, so buildability is not the binding constraint — cost is. Combined with
zero proven rent recovery, a strategy has to clear roughly a tenth of its stake
before it does anything, at the only size we are permitted to deploy at.

**There are eight liquidity collapses, not four, every one on `Pump.fun Amm`, and
every one fell from above the 10% floor to near zero inside a single mark
interval.** All eight are classified `UNKNOWN`. The columns that would separate a
pool drain from a creator dump exist in the schema and are NULL on every row.

### Verification

387 tests across 21 files in 2.6s. 66 mutations across five scripts, all caught —
including four that survived the first run and were real coverage gaps rather
than excuses. A destructive recovery test SIGKILLs a child mid-write with WAL
un-checkpointed and proves exactly-once accounting on restart.

`pnpm capability` reports 18 flags independently. `pnl_eligible_trades` is 0 and
says so.

### Not done, and named

- No local SVM simulation. `simulation_status` is an explicit
  `NOT_SIMULATED(reason)` on every row, never a pass.
- No pool/vault reserve, transfer-graph or Token-2022 extension feed. This is
  what makes P7 unanswerable and P5 rent recovery zero, and it is the highest-
  value next piece of work.
- No P7 mechanism identified.
- No canary, no live, no acknowledgement file, no capital at risk.

### Blockers to the 21-day / 200-trade gate

1. Zero admissible trades today. The window opens at the preregistration commit.
2. `maxSimultaneousPositions` is 1 in paper, so the trade rate is bounded by
   holding period; at ~2 entries/day, 200 trades is a 100-day run.
3. Any change to a decision-bearing file restarts the window.
4. The engine must run from a clean tree — a `+dirty` source commit excludes
   every row it writes.


---

## 2026-08-12 — executable-truth repair from HEAD `3155ea7`

Baseline: `docs/AUDIT_HEAD_3155EA.md`. Invalidation: `docs/P2B_INVALIDATION.md`.

### Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

The measurement is now honest and the instrument is now unable to produce a
reading. Both halves of that sentence are the result.

### The previous window is void

The P2b window opened at `3155ea7` is reclassified as development data. It
contained **0 positions, 0 marks, 0 build attempts and 0 closed rows** — it ran
under an hour and never entered — so invalidating it destroys nothing. Twelve
defects, each identified after the preregistration was frozen, are listed in
`docs/P2B_INVALIDATION.md`. The one that matters most:

**The engine priced entries from `/swap/v2/order` and proved buildability from
`/swap/v2/build`.** Probed live at 0.02 SOL → USDC, same instant: `/order`
returned 1,509,732 with `feeBps 2`; `/build` returned 1,510,066 with no fee
fields at all. Different routes, different fee models, 22 bps apart. Every
"build-validated" fill described a trade available on neither.

### What one observation now means

`/build` turns out to carry its own `outAmount`, `otherAmountThreshold`,
`routePlan`, `slippageBps` and blockhash metadata, so a leg can come from a
single response. `observeRoute()` is the only way to obtain one, and
`assertCoherent()` throws on any attempt to blend two.

### The replay divergence

Exactly **1 snapshot of 2000** changed verdict against the repaired gates:
`TOMORROW`, vetoed `excessive_impact` at 293 bps against a 150 bps cap — on a
price move of **+293 bps, in our favour**. `Math.abs` in the entry gate. The
same expression had already been removed from exit accounting twice. It is the
last instance in the tree, and a test now fails if it returns to any of five
files.

### Defects repaired

| what | why it mattered |
|---|---|
| route hybrid | a fill described a trade available on neither route |
| probe scaling | impact is not linear; the error flatters below the probe |
| double-charged platform fee | `/order` includes it; the engine deducted it again |
| omitted signature fee, tip, close fee, failed attempts | 2.5 bps at canary size, against a question measured in hundreds of bps |
| `EXIT_BLOCKED` outside the managed set | the state needing most attention was the one nothing watched |
| unbuildable exit closed and released capital | not a wallet path that exists |
| resync cleared on `integrity_check` alone | a provider outage re-enabled entries with no fresh observation |
| unresolved holder = program-controlled | a holder we failed to look up made a token look *safer* |
| missing `updatedAt` = age 0 | perfect freshness derived from absence of information |
| `alpha_shadow` was a label | censoring it exists to remove was not removed |
| canary looser than live in 7 of 13 dimensions | a small absolute cap made a permissive policy look safe |
| stop-based sizing | all 8 collapses beat the stop inside one mark interval |
| `admissible()` checked 4 of 17 clauses | the preregistration claimed all of them |
| canary gate counted closed simulated positions | 200 quote-only fills would have opened canary |
| canary gate inferred replay success from row count | existing is not reproducing |
| instruction hash ignored `isSigner`/`isWritable` | a read and a drain hashed identically |
| provider errors collapsed to `null` | a 429 and a dead token were indistinguishable |
| `requireLocalSimulation` read by nothing | the same dead-field defect, introduced *this session* and caught before commit |

### Why nothing is being collected

`requireLocalSimulation` is `true` for paper and no local SVM fixture exists, so
the engine books no fills and records the refusal every cycle.

This is not a workaround. A mainnet `simulateTransaction` cannot validate either
leg: the taker holds no SOL, so a buy fails on funding; it holds none of the
hypothetical tokens, so a sell fails on balance. Both failures describe the
wallet, not the route. **No observation in this system has ever been simulated**,
and a refusal repeated every ten seconds states that better than a document.

### The other blocker, which is economic

Under honest catastrophic-loss sizing the strategy **cannot size a viable trade
at the committed paper NAV**: 0.025 SOL of permitted notional against a 0.0286
SOL viability floor. Roughly 11.4 SOL of bankroll would be needed. Combined with
the earlier P6 finding — ATA rent is 10.2% of notional at the 0.02 SOL canary
cap, with rent recovery unproven and therefore zero — the honest reading is that
**canary viability at the committed cap is unresolved and looks unlikely**, and
`STRATEGY_NOT_CANARY_VIABLE_AT_CURRENT_SIZE` is the outcome to expect unless a
cheaper route family changes the arithmetic.

Neither number was answered by editing a config.

### Verification

432 tests across 24 files. Typecheck and secretscan clean. Doctor 15/15. Replay
recorded to `replay_runs` and read by the promotion gate — currently `replayed:
0` at v0.4.0, which correctly fails it.

## Local SVM simulation: the daemon executes, the evidence gate stays shut

The WSL simulation daemon now runs transactions. `/v1/simulate` returns a
complete, decomposed result; the transport, identity, idempotency and refusal
paths were already proven and still are.

Measured across the Windows/WSL boundary, on a SOL transfer whose economics are
unambiguous:

```
status SIMULATED_OK   unitsConsumed 150   startup 24ms   simulate 1ms   total 29ms
payer  5000000000 -> 4998995000     recipient 0 -> 1000000
1005000 spent = 1000000 transfer + 5000 base fee + 0 priority fee   (exact)
```

Four defects were found and fixed getting there, three of which were fabricating
numbers rather than failing:

| defect | what it produced |
|---|---|
| `setAccount` called with an options object | every job threw; the daemon reported `SIMULATION_UNKNOWN` with no reason printed. The real signature is positional: `(address, lamports, data, owner)` |
| post-state read with `getBalance` after simulating | a simulation does not commit, so every run reported that nothing changed |
| `null` in the post-account array read as "closed" | the System Program was booked as a **closed account** and its lamport counted as **rent recovered** — a fabricated event in the cost model. Fixed with `writableStaticKeys()`: an account the transaction cannot write to cannot have changed |
| `bounds` carried and never checked | the dead-field defect again. The daemon now checks them and `boundsViolations` refuses the row |

### Fee parity against settled mainnet transactions

Three confirmed Jupiter v6 swaps, reproduced **to the lamport** from their own
bytes — including a two-signature transaction, which is what stops the corpus
passing with the per-signature multiplier deleted:

| signature | observed | model | |
|---|---|---|---|
| `3YPyHXebC1pN…` | 41,044 | 5,000 + 36,044 | agrees |
| `5dNx5ihYH5i7…` | 80,001 | 5,000 + 75,001 | agrees |
| `4QZCutKyvuVq…` | 10,271 | 10,000 + 271 | agrees |

Independently, a live Surfnet charged **411 lamports** for
`SetComputeUnitPrice(2054)` at a limit of 200,000 while consuming 450 units:
the runtime prices the **requested limit**, not consumption. Both measurements
agree with `priorityFeeLamports()`, the function the engine costs every leg with.

### And yet `SIMULATED_OK` is still not evidence

`/v1/parity` returns `NOT_ESTABLISHABLE_WITHOUT_ARCHIVAL_STATE` for execution
parity, which is the honest verdict rather than a placeholder. Replaying a
settled transaction needs the accounts as they stood at its slot, and that needs
an archival node this project does not have.

Behind that sits a second blocker. Measured against `@solana/surfpool` 1.5.0,
`setAccount` has **no executable parameter** — a program account cannot be
restored from a snapshot at all. It comes back non-executable and every route
through it fails with an invalid-program error that reads as a fact about the
token. The protocol carries `programElfBase64`, the daemon **refuses** a snapshot
naming an executable account without one, and no ELF capture pipeline exists.

So: offline confirmatory simulation of a real route is blocked on archival
account state and program ELFs. The gate is closed in code —
`responseIsConfirmatory()` and `identityIsConfirmatoryGrade()` — not in prose.
**No observation in this system has been simulated as confirmatory evidence.**
What is proven is the cost model, against outcomes this project did not produce
and cannot influence. See `docs/SIMULATOR_PARITY.md`.

502 tests across 28 files. Typecheck and secretscan clean across 187 files.

### The assumed priority fee is wrong, and I have not replaced it

`assumedPriorityFeeLamports` is **200,000** in all four configs, and every paper
leg is costed with it: entry, exit, marks, and the exit-cost trigger. It is
reached from ten call sites in `apps/engine/src/paper.ts` and from
`packages/strategy/src/portfolio.ts`.

Measured against reality, three independent ways, it is wrong by one to three
orders of magnitude:

| source | priority fee |
|---|---|
| config assumption | 200,000 |
| settled mainnet swap `5dNx5ihYH5i7…` | 75,001 |
| settled mainnet swap `3YPyHXebC1pN…` | 36,044 |
| settled mainnet swap `4QZCutKyvuVq…` | 271 |
| live Surfnet, 2054 µL/CU at a 200,000 limit | 411 |

The direction matters and it is the opposite of most findings in this file. An
overstated cost makes the strategy look **worse** than it is: at the 0.02 SOL
cap, 200,000 lamports is 100 bps per leg and 200 bps round trip, against roughly
20 bps for the largest fee actually observed. Roughly 180 bps of round-trip cost
has been charged against every paper trade and does not exist.

**It has not been changed, and that is deliberate.** The correct number is not
derivable from the bytes for the routes this system actually builds. Jupiter's
`/build` returns `SetComputeUnitPrice` (measured: 2054 µL/unit) and **never**
`SetComputeUnitLimit` — `computeUnitLimit` is null on every observed route. The
fee formula `ceil(price × limit / 1e6)` needs both, so with no limit in the
transaction the runtime applies a default this project has not measured. The
three settled swaps above reproduce exactly *because* they carry explicit
limits; a limit-less build is a different case.

Replacing a guessed 200,000 with a guessed 2,465 is the same defect wearing a
better number. The instrument that answers it properly now exists: send a real
`/build` transaction through the daemon and read the fee decomposition, which
measures the priority fee from the payer's own lamport delta rather than
assuming it. That is what §4 asked for, and it is the next piece of work.

Until then, every paper economic number in this file is **conservative by an
unmeasured margin**, and no threshold should be tuned against them.

### Still not done

- **No confirmatory simulation.** The daemon executes transactions and the cost
  model is anchored to settled mainnet fees, but execution parity needs archival
  account state and program ELFs. Until both exist, `SIMULATED_OK` is a
  development fact, and the gate refuses it as evidence.
- **No pool/vault reserve, transfer-graph or Token-2022 extension feed** (§7.3,
  §7.4). This is why all eight collapses remain `UNKNOWN`.
- **No WSS risk trigger** (§7.5).
- **No route/broadcaster benchmark** (§11) — it needs a funded canary to measure
  landing probability, and funding is forbidden.
- **No executor loop** (§13). `apps/executor` still refuses to start, correctly.
- **No reject-tracking repair** (§8) — provider disappearance is still treated
  as total loss in the reject backtest.
- **No age-cohort collection** (§10).


# 4890af0 truth directive: thirteen merged repairs

Local HEAD matched the audited `4890af0` exactly at the start. Verified WAL-safe
backup taken before any semantic change: 1.6 GB, sha256 `11c7e00e4c54…`,
`integrity ok`, staleness bounded `249295 ≤ 249295 ≤ 249395`. The window is
closed as development data in `docs/4890AF0_WINDOW_INVALIDATION.md`.

## The one that changes the economics

`assumedPriorityFeeLamports` was **200,000**. Measured from four live routes'
own bytes it is **2,651–3,837** — a phantom **99 bps per leg and 198 bps per
round trip** at the 0.02 SOL size, charged against every paper trade this
project has ever booked.

The cause: `priorityFeeLamports()` computes `ceil(price × limit / 1e6)`, and
Jupiter's `/build` returns `SetComputeUnitPrice` but **never**
`SetComputeUnitLimit`. The limit was null, the product was zero, and the
function reported that every leg pays no priority fee at all. The config
compensated with a flat number nothing had measured.

The rule, measured against a live SVM by reading the fee off the payer's balance
at exactly one lamport per unit:

| transaction | charged | model |
|---|---|---|
| 2 builtins | 6,000 | 6,000 |
| 3 builtins | 9,000 | 9,000 |
| explicit 50,000 | 50,000 | 50,000 |
| explicit 2,000,000 | 1,400,000 | 1,400,000 |

Every real Jupiter route derives to exactly **1,006,000** units — 7 instructions,
2 builtin at 3,000 and 5 BPF at 200,000 — and a live route logged `consumed 183
of 1000499 compute units`, which is 1,006,000 less the early instructions.
Recorded as MT025 before the change landed.

**Consequence.** `feeBps` on the size surface falls from ~714 to 10. The minimum
viable NAV at 0.02 SOL falls to about 2.05 SOL. The earlier claim that the
strategy **could not size a viable trade** at the committed NAV, needing ~11.4
SOL, was computed with the phantom and is **withdrawn**. Being able to size a
trade is not evidence that sizing one is a good idea.

## Silent defects repaired

| defect | what it produced |
|---|---|
| multi-table ALT ordering built from meta arrival | every instruction index past the static keys named a **different account**, in a transaction that encoded, passed the packet check, and looked like a swap |
| shadows opened only on portfolio refusal | both books held exactly the signals the portfolio **rejected** |
| `EXIT_BLOCKED` / `RECONCILING` omitted from exposure | capital behind a position that could not be sold was reported as **free** |
| `copyFileSync` of a WAL database, failure swallowed | migrations ran with **nothing behind them** |
| missing `otherAmountThreshold` → minimum output 0 | a transaction accepting **any** fill, indistinguishable from generous slippage |
| failed simulation read as post-state | the fee payer booked as **closed**, its whole balance as rent recovered |
| `null` post-account read as "closed" | a read-only program booked as closed, its lamport as rent recovered |
| `strategyConfigHash` covering 16 of 31 fields | two windows under different policies reporting **identical provenance** |
| provider disappearance in reject tracking | a NULL price read as zero, so every gate looked brilliant |

## The simulator

A real three-hop Jupiter route executes in the local SVM: `SIMULATED_OK`,
172,268 CU, 46 accounts exported with 6 program ELFs and zero omissions.

**One route replayed with exact execution parity** — JIT and offline both
returning `SIMULATION_FAILED`, the identical error `[5, Custom 14]`, and the
identical **40,829** compute units. A second route did not reproduce. The
mechanism is real; the restore is not yet faithful for every route.

Three assumptions had to be corrected to get there. An offline replay must
reproduce the **clock** — a table extended at slot 438,000,000 is unresolvable at
slot 33. Account coverage is not the static keys — the pools live in the lookup
tables. And `deploy()` panics when the program already exists, because a fresh
Surfnet preloads System, ComputeBudget, SPL Token, Token-2022 and ATA.

`EXECUTION_PARITY_ESTABLISHED` remains **false**, and `responseIsConfirmatory()`
reads it. One route reproducing is not a corpus.

## Independently verified

- The encoder matches `@solana/kit` **byte for byte** on five cases including
  both multi-table ones. Checked out the pre-fix encoder: both multi-table cases
  fail, the other four pass.
- PDA derivation produces `HoQ6taGg5d5iwDip7Fs8fVUMmV1XyjS9BCDjuWwwu6ZV`, the
  exact account the Solana runtime created inside surfpool during every parity
  run this session.
- Pump bonding curves decoded from bytes read off mainnet, which corrected the
  account from a remembered 81 bytes to a real 115 **and** 151 behind one
  discriminator. Two invariants held exactly on every live curve: virtual minus
  real SOL is 30 SOL, virtual minus real token is 279,900,000,000,000.
- Three settled mainnet transactions still reproduce their fees to the lamport.

## Still not done

- **§7.4** mainnet current-state cross-check; **§10.5** Token-2022 transfer fees;
  **§12.4** the due-time scheduler; **§14** WSS triggers; **§15** entity and
  fraud features; **§13**'s exact quoter proved against the official SDK.
- **§17**'s classifier exists and is not yet wired into collection; the 467,993
  existing rows are not backfilled.
- **§18** development simulation has **not** been started. 0 of ~6,700
  observations are simulated.
- Roughly 30 of §22's 54 required tests exist.

663 tests across 40 files. Typecheck and secretscan clean. No wallet funded, no
canary, no live, no acknowledgement file.


## Continuation: the simulation loop closes

Nineteen merged repairs from `4890af0` to the current HEAD. The four items below
were the ones that mattered after the first thirteen.

### The loop runs end to end

`pnpm simulator:observation-smoke` builds a real route, stores its exact bytes,
simulates them, and watches the observation become an executable leg:

```
observation   PASS/PASS policies
exact tx blob 731 packet bytes, 14 static keys, 1 lookup table
before        executable=false   (only reason: simulation NOT_SIMULATED)
simulate      SIMULATED_OK, confirmatory=false
after         executable=true
durable jobs  1, confirmatory=0
```

The order was the bug. `legIsExecutable` requires `SIMULATED_OK` when
`requireLocalSimulation` is set, so running it **before** attempting a
simulation refused every entry for a simulation nobody had tried. That is why
zero positions were ever opened.

### An end-to-end test caught what unit tests could not

**MT026.** The §6 work made `contextSlot` an unconditional refusal, because the
directive lists it among the load-bearing fields. The first live build came back
`MISSING_CONTEXT_SLOT`, and the corpus then showed `context_slot` is null on
**all 22,177** observations — Jupiter's `/build` has never once returned it.

As written it would have refused **100% of builds** and silently halted all
collection, while every unit test stayed green: the fixtures supplied a
`contextSlot` on the strength of the directive saying the field existed. **A test
written from a specification cannot catch a specification that is wrong about the
world.**

Same defect class as MT001 and MT002, and the invariant is explicit — absence of
a provider field is a fact about the provider and never hard-vetoes. It now
blocks the row counting as *evidence* rather than blocking the row existing.

### The newest half of the book was never marked

The mark loop was `openShadowPositions(db).slice(0, cap)` over a query ordered by
`opened_utc_ms`. With 179 open shadows and a per-cycle cap, the same oldest
positions were marked every cycle and the newest were never marked at all — and
a position with no marks looks exactly like a position whose value did not move.

Ordered by urgency now: blocked, then near-trigger, then most overdue against
when the mark was *due*. Age is the tiebreak and prefers the **newer** position.
A never-marked position is due since it opened, which makes it maximally overdue
rather than least.

### A transfer fee promised for next epoch is not the fee charged today

The mint decoder read the **newer** Token-2022 transfer fee config
unconditionally. Token-2022 keeps an older and a newer schedule, each with the
epoch it takes effect from, and the newer applies only from its own epoch. A
mint can advertise 0 bps effective next epoch while charging 1,000 bps today —
and the decoder reported a free transfer. Both schedules are decoded now, and
the legacy field carries the **worst** case.

### Cross-checks that report what they can and cannot establish

`pnpm simulator:crosscheck` runs the same transaction through mainnet's
simulator and the local SVM. Mainnet returns `AccountNotFound`: our taker has
never been funded, so it cannot load the fee payer. That is an **inability**, not
a disagreement, and it is exactly why the local SVM exists. The script reports
`NOT ESTABLISHABLE`.

The first version scored it as three failures — one of which, "compute units
agree within 5%", *passed* by dividing 0 by 0. A broken check showing green next
to two red ones is how a suite stops meaning anything.

### Still not done, and these are new subsystems rather than repairs

- **§14** WSS risk triggers. Needs a Helius WebSocket subscriber wired into the
  cycle; nothing exists yet.
- **§15** entity and fraud features — creator history, first buyers, common
  funder, transfer graph, entity-adjusted concentration. The largest remaining
  piece, and it needs data sources that do not exist in this repository.
- **§13** the exact Pump quoter proved against the official SDK. The decoders,
  PDA derivation and fingerprints are in; the parity proof is not.
- **§22** roughly 40 of the 54 required tests exist.
- **§18** a development simulation window has **not** been started. The loop is
  proven on demand; it has not been left running.

685 tests across 41 files. Typecheck and secretscan clean. No wallet funded, no
canary, no live, no acknowledgement file.


# The development simulation window is running

Started 2026-08-13, on `4dc810e`, after a verified backup of the 2.5 GB corpus.

```
schema applied                 15 of 15
simulation_jobs                 8   (4 SIMULATED_OK, 4 SIMULATION_FAILED, 0 unknown)
observations simulated          8
observations with exact bytes 211
observations with blockhash    64
shadows with a cohort          10
rejects classified           2295
daemon                         13 jobs, median 430ms startup + 309ms simulate
```

`dataRegimeId` moved from `.../5774139c5490` to `.../ee9d6f11c1e6`. That is the
pooling guard working: this window cannot be averaged with the invalidated one,
because the cost model, the simulation requirement and the route family are all
part of the regime now.

## What starting it found

Three defects that no amount of reading the code would have surfaced.

**The backup was broken at the size the corpus had reached.** `onlineBackup`
hashed with `createHash().update(readFileSync(path))`, and a Node Buffer cannot
exceed 2 GiB:

```
File size (2506678272) is greater than 2 GiB
```

Because a failed backup correctly *blocks* migration, the engine would have
refused to start at all — the safeguard working exactly as designed, against a
defect in the safeguard. Hashed in 8 MiB chunks now, and verified against the
real 2,509,283,328-byte database.

**A duplicate column made a fix a silent no-op.** `blockhash` was NULL on all
22,177 rows. I added it to the INSERT column list and the arguments, and it was
*still* NULL. The column had existed since migration 8, in the middle of the
list, with a hardcoded `null`; my addition made it appear twice, SQLite accepted
the duplicate without error and kept the first binding. The code read as though
it worked.

**Nothing was simulating the shadow entries.** Simulation was wired only into
`tryEnter`, the portfolio path — and the portfolio opens almost nothing (128
shadow entries against 0 portfolio entries over the same period). The window
would have run at zero simulations indefinitely. The shadow entry and its
round-trip sell are the pair that constitutes a fill, and both are simulated
now.

Marks are deliberately not simulated: a mark values a position already held, it
runs every cycle for every open shadow, and simulating all of them would spend
the whole budget answering a question nobody asked.

## What the window is and is not

It is **development** data. Every run is `DEVELOPMENT_JIT`, which fetches live
mainnet state and is therefore not reproducible, and
`EXECUTION_PARITY_ESTABLISHED` is still `false`. `responseIsConfirmatory()`
refuses every one of these rows as evidence, for four separate reasons, and the
`confirmatory` column records `0`.

Four of the first eight simulations FAILED. That is not a defect — these are
real routes against real pools, and a route that cannot execute is exactly the
fact the simulation exists to establish. It is also why the number matters: an
engine booking fills on unsimulated routes would have counted all eight.

---

# 2026-08-13 — the 2617bb7 profitability directive

## What changed

**The simulator was measuring itself.** Every simulation job this repository had
ever produced described no economic leg: `requestedAmount` was the string `'0'`
and the only balance mutation was SOL, whatever the transaction spent. Buys were
funded correctly and executed; sells were asked to spend a token the simulator
had never been given, and 43 of 43 failed with the identical error at the
identical instruction index across every venue, mint and size.

That uniformity is the signature of an apparatus, not a market.

## Operational

| | |
|---|---|
| mode | paper (observe + paper only; neither imports `packages/execution/`) |
| tests | **862 pass**, 4 skipped, 55 files, ~5 s |
| schema | v18 |
| corpus | 26,515 observations, 108 simulation jobs, 603 marks |
| backup | `runtime.db.backup-2026-08-13T17-54-57-293Z`, sha256 `7edd0e0c…`, integrity ok, witness bounds `[26515, 26515]` |
| canary readiness | **NOT_READY** — 0 confirmatory positions, every economic gate failing |

## Now enforced

- **`SIMULATED_EFFECT_OK`** — runtime success is not economic success.
  `RUNTIME_OK` + `EFFECT_OK` + `FEE_DECOMPOSITION_OK` + `ACCOUNT_COVERAGE_OK`,
  required by `legIsExecutable()`. See `docs/SIMULATION_EFFECTS.md`.
- **Leg-shaped simulation setup** — `validateSetup()` refuses a zero amount, a
  sell with no token program, a sell whose input is SOL, and a leg whose input
  and output are the same asset, *before* anything is sent.
- **Derived validity** — `simulationValidity()` reads the request bytes rather
  than trusting the caller. A caller that could assert its own validity would
  have asserted it for all 43.
- **Portfolio entry requires a verified same-family sell** at the exact acquired
  amount. A buy alone is not an entry.
- **Marks are executable** — an exact full-balance `BUILD_CUSTOM` sell. `/order`
  is stored as a benchmark and moves no stop, trail, peak or NAV.
- **Exits are simulated before they are judged.** The previous code tested the
  exit observation for simulation without ever simulating it.
- **Profitability is a canary gate.** The previous gate passed after 200 losing
  trades; `tests/unit/readiness.test.ts` builds that corpus and asserts refusal.

## Invalidated

All 108 simulation jobs are `INSTRUMENT_DEVELOPMENT`. All 26,515 observations
are `NOT_VERIFIED`. All 603 marks are `ORDER_QUOTE_BENCHMARK` and
`decision_bearing = 0`.

Rows are preserved. **No threshold, weight or model may be fitted on any of
them.**

## Unproven

- No leg has passed effect verification. Zero valid development, offline
  reproducible, or confirmatory positions.
- Every route fingerprint is `STRUCTURAL_ONLY`.
- Offline reproducibility is blocked for most rows by a NULL `context_slot`.
- The mark backlog is ~40x capacity (169 due against 4), worst lag ~1,020 s.
- 92 `HTTP_4XX` sell observations in 15 minutes: routes that do not exist.

This is not production ready and no part of it is. The measurement apparatus was
repaired today and the first window that could mean anything is minutes old.

Full report: `docs/AUDIT_HEAD_2617BB7.md`.

## Also landed this session (P7, P12, P17)

**One accounting implementation.** `accounting.ts` gained `entryCashOut()` and
`exitCashIn()`; `totalEntryCost` and `netExitProceeds` — which are what the
runtime actually called — now delegate to them. An unobserved transfer or
platform fee makes a quote incomplete rather than zero. The failure model is an
upper bound from the attempt record, not one flat charge: 3-in-10 and
300-in-1000 share a point estimate and are very different evidence.

**The risk contradiction.** A proposed trade was charged the catastrophic floor
(100%) while existing positions in the same aggregate cap were charged the
nominal 2,500 bps stop. The cap read the book as four times safer than the model
said. Both now use `plannedLossFractionBps()`.

**Soft risk cannot be diluted.** It was the mean of its components, so adding a
gate that reported *no* risk halved every existing risk. Now
`max(primary) + bounded secondary`.

**Net buyers are never replaced with gross buys.** A wash trader running a
hundred round trips through two wallets produces an enormous gross buy count and
a net buyer count near zero, so the old fallback handed the anti-wash gate the
one number wash trading inflates.

**Jupiter build composition.** `otherInstructions` ran *after* cleanup closed the
wrapped-SOL account; `tipInstruction` was parsed and dropped. Order is now
compute → setup → swap → other → cleanup → tip, and the tip amount is decoded
from the System transfer as a `bigint`.

## What the evidence scripts now report

| | |
|---|---|
| shadows | 1,079, all `STRUCTURAL_ONLY`; **every one refused by a portfolio halt** (983 weekly, 96 daily) |
| shadow marks | 25,085, of which 22,379 unpriced |
| cohorts | 118 assigned (all one arm); 965 predate the feature and are marked as such, not backfilled |
| rejects | 811,977 rows; 29,337 classified since the classifier landed, `EXECUTABLE_VALUE` zero in all of them |

The portfolio has been halted for the entire window. That is what the shadow
books exist to reveal: without them the corpus would show no positions and no
reason, and the absence would read as "no signals".

None of these numbers vindicates a gate. The classified reject sample is three
hours old, and the cohort experiment has one arm.

Correction: an earlier version of this file said cohort assignment and reject
classification "were not running". Both run. The gaps are rows that predate the
features, and they are marked rather than filled.

## Three modules that decide nothing

Checked, not assumed:

```
packages/intelligence/src/mintfacts.ts    0 non-test importers
packages/intelligence/src/entity.ts       0 non-test importers
packages/adapters/src/accountwatch.ts     0 non-test importers
```

Complete, tested, and called by nothing. This is the dead-field defect at module
scale, and at that scale it is worse: a dead module has passing tests, so it
counts as working capability in every report that counts files.

`tests/unit/no-dead-modules.test.ts` counts live importers per decision-bearing
module. The list can only shrink.

## The binding constraint

`S050` — offline replay cannot restore a six-program Pump route, because
`net.deploy()` is a synchronous napi call on the request path. Pump is therefore
capped at `JIT_EFFECT_VALID`, `CONFIRMATORY` is unreachable for it, and the
readiness gate's 200 confirmatory positions cannot reach one.

Everything else on the blocker list is downstream of collecting more data.
This one is not.

## What a working day looks like from here

1. `pnpm db:migrate` — backup, then apply pending migrations
2. `pnpm paper` — collect on a clean commit
3. `pnpm window:status` — what the repaired instrument has measured
4. `pnpm capability:matrix` — which route shapes have advanced
5. `pnpm readiness` — the gate, which will say NOT_READY for a long time

Nothing above starts canary or live.

---

# 2026-08-13 — the 5b89953 effect-labels directive

## P6 is satisfied

```
buys 5, effect-ok 4 · sells 5, effect-ok 4 · 8/10 effect-verified
INSTRUMENT failures 0   (required: 0)
```

The bar was never ten passes. It is 10/10 either `SIMULATED_EFFECT_OK` or a
route-specific failure with a complete explanation, and zero instrument
failures. **Met.**

At the start of this session there were **zero** effect-verified legs in this
repository's history.

## Nine defects, every one found by running it

| id | what |
|---|---|
| `S052` | Token balances keyed by account pubkey at one end, `owner:mint` at the other |
| `S053` | A mint decoded as a token account (`>= 72` bytes; a mint is 82) |
| `S054` | The taker's own ATA truncated out of the 64-account watch window |
| `S055` | The sell credit had two values — closed by writing the account rent-exempt |
| P3 | A token→SOL sell checked through `minTokenDelta` |
| P4 | Amounts above 2^53 unsimulable |
| P5 | Priority fee suppressed on **every** run by a balance identity that does not hold for sells |
| P13 | Readiness subtracted the principal twice, and its cost stress subtracted it again |
| P17 | `mintfacts.ts` decided nothing |

`S052` was the directive's own hypothesis, proven against the corpus before
anything was changed: every stored token map key is a base58 account pubkey and
no `owner:mint` key has ever existed.

## The readiness gate was describing a strategy that does not exist

`realized_lamports` already holds the net result, and the gate computed
`realized - cost`. A position that cost 20,000,000 and made 1,000,000 scored as
a **19,000,000 loss**, and every gate downstream — profit factor, log growth,
drawdown, every robustness check — inherited it.

Its 2× cost stress subtracted the whole 20,000,000 basis rather than the 13,000
of execution cost. No strategy could pass it. A stress that always fails carries
no information about robustness, so a test now asserts a robust edge **survives**
it — the half the old version could never show.

## What the working instrument then measured

**A route spent 278,400 lamports more than it was given** — 139 bps, net of
every modelled cost. An unmodelled cost of that size is what turns a positive
backtest into a negative account.

**A dust position's exit returns −277,839 lamports.** The effect verifier and
the daemon's bounds check agree on the figure independently.

## Corrections to earlier claims in this file's history

- The **80.7% round-trip loss** was double-counted rent. Do not quote it.
- "Output delta is missing" was firing for both *unobserved* and
  *observed-but-negative*, filing the market's answer as our failure.

## Open

- **`S050`** — Pump offline replay. `soPath` landed and the failure is
  unchanged, which rules out N-API marshalling and the 38.5 MiB body. It is
  `surfnet_writeProgram` dropping its RPC on a 10.5 MB program, one layer below
  this daemon. Needs a Rust Surfpool or LiteSVM worker.
- **`S051`** — `entity.ts` and `accountwatch.ts` still decide nothing.
  `mintfacts.ts` left the list.

## State

```
MEASUREMENT_REPAIR_REQUIRED
```

Not because the repair failed — it succeeded and P6 is met — but because no
evidence window has started and no confirmatory trade exists. `CONFIRMATORY` is
unreachable for Pump while `S050` is open, so canary cannot be approached.

1,005 tests, 64 files, secretscan clean.

## Also landed (P7, P9, P10, P11, P14, P16, P17, P18, P19)

- **P7** JIT snapshots persisted and read back; a run whose snapshot could not
  be stored is `JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE`, a column rather than an
  inference from an absence.
- **P9** `paper.ts` calls `paper-core.ts`. The tested code and the running code
  were two implementations with nothing to report the divergence.
- **P10** the trigger observation is never its own fill.
- **P11** a shadow cannot close at its trigger; evidence is appended, never
  edited; `nearTrigger` uses distance to every boundary rather than peak alone.
- **P14** `confirmatory_positions_v1` — one definition, nineteen mutation tests.
- **P16** Token-2022 extensions decoded; an unknown extension is money-critical.
- **P17** all three dead modules wired; `KNOWN_INERT` is empty.
- **P18** retained candidate queues, so the other three cohort arms can exist.
- **P19** an unquoted token is no longer automatically −100%.
