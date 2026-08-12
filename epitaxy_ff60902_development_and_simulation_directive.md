# CLAUDE CODE DIRECTIVE — EPITAXY FF60902: VALID DEVELOPMENT DATA NOW, REPRODUCIBLE SIMULATION NEXT

**Repository:** `TateLyman/epitaxy`  
**Audited GitHub branch:** `master`  
**Audited GitHub HEAD:** `ff60902e407fc15339bc7c03e33308da5c0aebe7`  
**Date frozen for this directive:** 2026-08-12  
**Current honest state:** `MEASUREMENT_REPAIR_REQUIRED`  
**Capital permission:** none  
**Allowed modes:** observe, development-shadow, paper-with-no-booked-fills  
**Forbidden:** canary, live, funding a trading wallet, signing, sending, weakening capital gates, or claiming profitability

Execute this directive in the Epitaxy repository. Do not merely return a plan. Do not work in `memecoinstuff`, `memecointrader`, or any graduation-auction repository.

The objective is the fastest honest path to positive expected log growth. That requires two tracks to proceed in parallel:

1. **Immediately repair and run a coherent BUILD_CUSTOM development-shadow instrument**, so useful exact-size, same-family outcomes begin accumulating now.
2. **Build a reproducible local simulator under Linux/WSL with Surfpool**, so a later clean window can become confirmatory rather than merely structural.

Do not wait for every optional feature before collecting useful development data. Do not continue collecting the current malformed shadow data either.

The only permitted final states for this session are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_COLLECTION_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`CANARY_READY`, `LIVE_READY`, and `PROFITABLE` are forbidden outputs.

---

# 0 — START FROM THE ACTUAL LOCAL MACHINE, NOT FROM GITHUB ASSUMPTIONS

Before editing, print and preserve:

```bash
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -30
git diff
git diff --cached
node --version
pnpm --version
pnpm status
pnpm health
pnpm capability -- --mode=paper
```

Determine whether the local tree is:

- exactly `ff60902e407fc15339bc7c03e33308da5c0aebe7`;
- ahead of it;
- behind it;
- or dirty.

Never reset or overwrite newer local work.

Record:

- engine PID and mode;
- start time;
- current context hash;
- current strategy/config/risk/schema hashes;
- current halt state;
- current database and WAL paths;
- open positions;
- `EXIT_BLOCKED` positions;
- shadow positions by book and state;
- latest observation/mark/build;
- disk free space;
- WSL status;
- GitHub Actions state;
- branch-protection state.

If any real or paper position carries a nonzero token balance:

1. engage `HALT_NEW_ENTRIES`;
2. leave exit management running;
3. preserve the current policy for that position;
4. do not change lifecycle semantics under it;
5. do not stop until flat or explicitly preserved as development-only unresolved exposure.

Take a consistent backup with SQLite’s online backup mechanism or `VACUUM INTO`. Do **not** copy only the main `.db` file while WAL is active.

Run:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Save:

- database SHA-256;
- WAL/SHM status;
- per-table counts;
- maximum IDs/timestamps;
- all nonterminal positions;
- all run contexts;
- all observation families;
- a read-back integrity result.

Create:

```text
docs/AUDIT_HEAD_FF60902.md
```

Commit the untouched baseline before semantic changes.

---

# 1 — STOP CALLING THE CURRENT POST-FF60902 WINDOW CONFIRMATORY

The current tree correctly refuses to book portfolio fills without simulation. However, the current implementation still cannot collect a scientifically coherent P2b corpus:

- portfolio marks and triggers come from `/order`;
- actual exits are attempted through BUILD_CUSTOM;
- fixed-notional shadows do not open on every eligible signal;
- shadow exits omit material costs;
- shadow scheduling can starve newer positions;
- provenance hashes omit new decision-bearing fields;
- no local simulation exists;
- CI is red.

Therefore every observation written from `ff60902` through the final repair commit is **development data**.

Create:

```text
docs/FF60902_WINDOW_INVALIDATION.md
```

Record:

- start and end timestamps;
- source commits;
- context hashes;
- positions;
- shadow positions;
- observations by family/purpose;
- marks;
- build/policy outcomes;
- whether any PnL was reported;
- every reason the rows cannot be confirmatory.

Do not delete or rewrite those rows.

Do not restart a confirmatory clock until all requirements under §16 are satisfied.

---

# 2 — MAKE CI GREEN BEFORE TRUSTING ANY LOCAL “438 TESTS PASS” CLAIM

GitHub Actions on current `master` is red.

The current Linux failure is legitimate test portability:

- the signer correctly refuses group/world-readable keypair files;
- `tests/unit/signer.test.ts` creates temporary files as mode `0644`;
- tests that pass on Windows fail before reaching their intended assertions on Linux.

Fix the test helper, not the signer:

```text
POSIX temporary keypair fixture mode = 0600
Windows = existing behavior
```

Ensure every generated key fixture, including malformed/tampered fixtures, has safe permissions before calling `Signer.fromFile`.

Add a dedicated test that confirms a `0644` key is refused on POSIX.

The CI log also identifies `pnpm 11.13.0` as a broken release. Verify the current supported pnpm 11 release from the package registry and official release metadata, pin an exact non-broken version in:

```text
package.json
packageManager
.github/workflows/ci.yml
```

Update the lockfile in a separate dependency-review commit.

Run CI on:

```text
ubuntu-latest / Node 24
windows-latest / Node 24
```

At minimum, both platforms run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm secretscan
pnpm test
pnpm replay
pnpm check
```

Linux additionally runs the Surfpool simulator tests once that dependency lands.

Do not run mutation scripts concurrently against the same checkout. Give mutation testing its own job or serialize it.

Current `master` is unprotected. After CI is green:

- require the CI check;
- disallow force pushes;
- disallow branch deletion;
- require a reviewed PR for signer, execution, risk, config, migration, and gate changes;
- require manual promotion for any release that can sign.

If branch protection cannot be changed from Claude Code, generate exact operator instructions and report this as a blocker.

No new confirmatory data may come from a red or unprotected decision-bearing commit.

---

# 3 — REPAIR PROVENANCE BEFORE WRITING ANOTHER EXPERIMENTAL ROW

`strategyConfigHash()` currently omits many fields that change decisions or economics.

At minimum include:

```text
primaryRouteFamily
requireLocalSimulation
requireExactSizeBuild
assumedBroadcasterTipLamports
assumedFailedAttemptLamports or its replacement model
latencyStressBps
catastrophicLossFloorPct
alphaShadowNotionalLamports
canaryShadowNotionalLamports
maxShadowMarksPerCycle
maxQuotesPerCycle
enrichIntervalMs when it affects opportunity coverage
every primary valuation rule
every simulator requirement
every route/broadcaster rule
every transfer-fee/ATA rule
every cohort definition
```

`dataRegimeId()` must include:

```text
route family
simulation regime
exact-size regime
primary notional
primary valuation
mark source/family
cost-accounting version
simulator version
account-snapshot regime
```

Bump:

```text
PROVENANCE_VERSION
PAPER_ENGINE_VERSION
QUOTE_ADAPTER_VERSION
ACCOUNTING_VERSION
SIMULATOR_VERSION
```

to versions that reflect the repaired semantics.

`sourceCommit = unknown` is not clean and may not pass admissibility.

Add schema-enumeration tests that fail when a new decision-bearing config field appears in neither:

- strategy hash;
- risk hash;
- explicitly non-decision metadata list.

Prove with tests that changing each field above changes the appropriate hash.

Regenerate `artifacts/release-manifest.json` from a clean final commit. The existing manifest is stale, names an older dirty commit, and hardcodes `tests.run = false`.

The new manifest must read machine-generated results and contain:

- current clean SHA;
- branch;
- toolchain;
- lockfile hash;
- every config/risk/context hash;
- simulator package/version/native binary hash;
- account-snapshot manifest hash;
- test results;
- replay result;
- CI run URL/ID and conclusion;
- known blockers.

No manifest generated from a dirty tree may be called a release manifest.

---

# 4 — FIX THE COST MODEL BEFORE USING “NEEDS 11.4 SOL” AS A CONCLUSION

The current bankroll conclusion is not established.

## 4.1 Priority fee

The committed config assumes:

```text
200,000 lamports priority fee per transaction
```

Claude’s live `/build` probe observed:

```text
2,054 micro-lamports per CU
```

At a 200,000-CU limit, the Solana fee is approximately 411 lamports, not 200,000.

Do not replace 200,000 with 411 as another static guess.

Build the actual transaction, simulate it, measure `unitsConsumed`, and choose a frozen margin:

```text
chosen_limit = ceil(unitsConsumed × safety_multiplier)
```

The multiplier must be preregistered, e.g. 1.10–1.20, and capped at the chain maximum and the intent’s fee budget.

Priority fee must use the chain formula:

```text
ceil(unit_price_micro_lamports × chosen_limit / 1,000,000)
```

The current implementation floors that division. Fix it and mutation-test the one-lamport boundary.

Store separately:

```text
router_provided_unit_price
router_provided_unit_limit
simulated_units_consumed
chosen_unit_limit
chosen_priority_fee_lamports
fee_source
```

## 4.2 Failed-attempt cost

The config describes `assumedFailedAttemptLamports` as a round-trip expectation, while the code charges the full value on entry and again on exit.

Replace this with an explicit model:

```text
entry_failure_probability
exit_failure_probability
landed_failure_fee_entry
landed_failure_fee_exit
expected_entry_failure_cost
expected_exit_failure_cost
```

For development reports, show:

- actual failed-attempt costs;
- observed expected cost;
- zero-failure sensitivity;
- conservative upper-bound sensitivity.

Do not charge one whole failed transaction on every successful leg unless that is explicitly the stress scenario.

## 4.3 ATA close cost

If token-account close is included as a post-swap instruction in the same exit transaction, it does not pay a second 5,000-lamport signature fee.

Track:

```text
close_in_same_transaction
close_requires_separate_transaction
close_instruction_buildable
close_simulated
close_confirmed
residual_balance
withheld_transfer_fee
rent_recovered
```

Charge a separate signature only when a separate transaction is genuinely required.

## 4.4 Rent recovery

The viability floor assumes 50% rent recovery, while current paper settlement often credits 0%.

Use one consistent primary treatment, frozen before collection.

Report all sensitivity cases but select one primary:

```text
observed
0%
50%
100%
```

The primary cannot be “50% because it makes the floor workable.”

## 4.5 Transfer fees and venue fees

Decode the mint’s current and future-epoch transfer-fee schedules and withheld fees.

BUILD_CUSTOM’s returned amount already incorporates AMM economics. Do not subtract embedded DEX fees again.

Persist Pump/PumpSwap fee state at the observation slot, because current canonical-pool fees depend on market cap.

## 4.6 One accounting equation

Create a single audited accounting module used by:

- portfolio paper;
- alpha shadow;
- canary shadow;
- replay;
- report;
- future canary.

For entry:

```text
cash_out =
  exact_input
+ base_signature_fee
+ priority_fee
+ broadcaster_tip
+ created_account_rent
+ transfer_fee_not_embedded
+ explicit_platform_fee_not_embedded
+ actual_or_expected_failure_cost
```

For exit:

```text
cash_in =
  exact_executable_output
- base_signature_fee
- priority_fee
- broadcaster_tip
- transfer_fee_not_embedded
- separate_close_transaction_fee_if_any
- actual_or_expected_failure_cost
+ confirmed_or_simulated_rent_recovery
```

`roundTripCostLamports()`, `viableFloorLamports()`, `totalEntryCost()`, `netExitProceeds()`, sizing, and reports must all derive from this module.

Add a test that fails if any cost appears in one function but not the others.

Do not modify risk caps or virtual NAV to force a trade after the corrected floor is calculated.

---

# 5 — ASSEMBLE THE EXACT BUILD_CUSTOM TRANSACTION

`evaluateBuildTransactionPolicy()` currently estimates a v0 transaction from instructions. That is not a full transaction policy.

Construct the actual versioned transaction bytes from the `/build` response.

Require from the response:

```text
inputMint
outputMint
inAmount
outAmount
otherAmountThreshold
slippageBps
routePlan
swapInstruction
setup/cleanup/other instructions
address lookup tables and their exact resolved contents
blockhash
lastValidBlockHeight
contextSlot
requestId
```

A missing decision-bearing field is an explicit failure, not zero:

```text
MISSING_MINIMUM_OUTPUT
MISSING_BLOCKHASH
MISSING_ROUTE_PLAN
MISSING_LOOKUP_TABLE
MISSING_CONTEXT_SLOT
```

Preserve instruction order exactly as documented:

1. compute budget;
2. setup;
3. pre-swap custom instructions;
4. swap;
5. post-swap custom instructions;
6. cleanup.

Resolve every address lookup table and construct the exact v0 message.

Use a current official Solana transaction library or a rigorously tested exact encoder. Pin the dependency and document why it is permitted.

Persist:

```text
serialized_unsigned_transaction_hash
message_hash
actual_packet_bytes
fee_payer
required_signature_count
static_account_keys
lookup_table_addresses
lookup_table_contents_hash
loaded_writable_accounts
loaded_readonly_accounts
recent_blockhash
last_valid_block_height
all instruction hashes
```

Run the existing strict byte-level policy over the assembled bytes:

- fee payer;
- signature count;
- full program allowlist;
- all static and ALT-loaded accounts;
- packet size;
- compute budget;
- priority fee;
- blockhash;
- unexpected writable accounts.

`instructionPolicy = PASS` and estimated `transactionPolicy = PASS` do not substitute for this.

Store the exact response blockhash. Do not fetch a different blockhash and call its last-valid height the transaction’s expiry.

---

# 6 — BUILD THE LOCAL SIMULATOR UNDER WSL/LINUX

The Windows-native JS Surfpool package is unsupported; its prebuilt binaries cover macOS and Linux x86-64.

## 6.1 Environment

Detect:

```powershell
wsl --status
wsl -l -v
```

Preferred environment:

```text
WSL2
Ubuntu 24.04
Node 24
pnpm pinned to the repository version
@solana/surfpool pinned to an audited exact version
```

Do not pipe an installer into a shell blindly. Use an official, reviewed installation path and record versions and hashes.

If WSL is absent or requires a reboot/admin action, stop that setup cleanly and emit the exact operator command. Continue implementing simulator interfaces and Linux CI fixtures.

## 6.2 Simulator interface

Create an interface independent of Surfpool:

```text
Simulator
  start(snapshot)
  fundSol(wallet, lamports)
  setTokenBalance(wallet, mint, amount)
  setAccount(pubkey, bytes, owner, lamports)
  simulate(serializedTransaction)
  capturePostState()
  stop()
```

Implement:

```text
SurfpoolSimulator
DeterministicFixtureSimulator
```

The fixture implementation exists so CI and replay do not depend on mainnet availability.

## 6.3 Mainnet state capture

Surfpool may fetch mainnet accounts just in time. JIT state is useful for development but is not reproducible by itself.

For each observation:

1. record `/build` context slot;
2. assemble the exact transaction;
3. identify every static and ALT-loaded account;
4. capture every account used by simulation;
5. capture program executable/programdata accounts and upgrade authorities;
6. capture relevant sysvars/features;
7. record the actual slot returned for each read;
8. store content-addressed raw account blobs;
9. create an account-snapshot manifest and hash;
10. simulate against that frozen snapshot.

If state is obtained at a later slot than the build, record the delta explicitly. That later-state simulation may model realistic decision latency; it must not be called same-slot truth.

## 6.4 Hypothetical balances

For a buy:

- fund the paper taker with sufficient SOL;
- ensure ATA setup state matches the observation;
- simulate exact bytes.

For a sell:

- create/fund the exact token account with the hypothetical token amount;
- set relevant withheld fees and extensions;
- simulate exact bytes.

Never treat a mainnet balance failure from an unfunded paper address as a route failure.

## 6.5 Two-pass compute calibration

First simulation:

- use a generous bounded CU limit;
- obtain `unitsConsumed`;
- refuse on any error or unsupported program.

Second simulation:

- rebuild with `ceil(unitsConsumed × frozen_margin)`;
- compute exact priority fee with ceiling;
- simulate again;
- require identical intended economic effect.

## 6.6 Effect verification

For every leg, record and verify:

```text
input token delta
output token delta
SOL delta
base fee
priority fee
tip
rent created/recovered
transfer fee
withheld fee
unexpected mint movement
unexpected lamport transfer
created accounts
closed accounts
logs
units consumed
error
```

`SIMULATED_OK` requires all economic bounds to agree with the intent.

## 6.7 Simulator parity

Before any confirmatory window:

- replay a corpus of successful historical Jupiter/PumpSwap transactions;
- compare success/failure;
- compare token and SOL deltas;
- compare created/closed accounts;
- compare logs where meaningful;
- compare units consumed within a documented tolerance;
- include Token and Token-2022 cases;
- include ALT transactions;
- include setup/cleanup;
- include a known failed transaction.

A simulator that cannot reproduce current mainnet behavior is development tooling, not evidence.

Pin:

```text
simulator package
native binary hash
feature set
account snapshot hash
program hashes
```

into every confirmatory observation.

---

# 7 — REPAIR ENTRY COHERENCE COMPLETELY

The current entry flow still uses `/order` for cheap screening and BUILD_CUSTOM only for the buy leg.

That is acceptable only if `/order` remains a benchmark feature and never becomes the final economic gate.

For every signal admitted to a development shadow or portfolio candidate:

1. choose the exact notional;
2. request exact-size BUILD_CUSTOM buy;
3. assemble;
4. policy-check;
5. simulate when available;
6. calculate the exact token amount under each frozen valuation;
7. immediately request BUILD_CUSTOM sell for that exact token amount;
8. assemble;
9. policy-check;
10. simulate when available;
11. calculate complete round-trip cost;
12. rerun all final tradability and viability gates;
13. only then open the position.

Persist the buy and sell as a linked entry-round-trip pair.

A BUILD_CUSTOM buy without a BUILD_CUSTOM sell is not a valid entry.

`/order` round-trip data remains:

```text
QUOTE_ONLY_BENCHMARK
```

and may be used to measure route opportunity cost, never as the BUILD_CUSTOM fill or trigger.

---

# 8 — MAKE EVERY MARK AND EXIT USE THE SAME FAMILY

The realizable portfolio currently marks against `/order` and exits through BUILD_CUSTOM. Remove that hybrid.

For every managed portfolio or shadow position, every decision-bearing mark is:

```text
exact full-balance BUILD_CUSTOM sell observation
same family
same accounting
same policy
same simulator regime
```

Store `/order` benchmarks separately.

At each scheduled mark:

1. BUILD_CUSTOM exact full-balance sell;
2. assemble exact bytes;
3. policy;
4. simulate when available;
5. calculate expected/minimum/latency-stressed net proceeds;
6. persist all three;
7. apply policy to the frozen primary valuation;
8. if policy triggers, apply measured decision/build/submission delay;
9. execute counterfactually at the first later valid same-family observation.

Do not request builds only when the control policy exits. Every candidate policy needs valid observations at its own potential trigger time.

No P2b ranking may begin until this mark stream exists.

---

# 9 — BUILD A REAL, COMPLETE, FAIR SHADOW CORPUS NOW

Portfolio paper must remain blocked until simulation works.

Development shadows may begin earlier, explicitly labeled:

```text
DEVELOPMENT_STRUCTURAL
```

A structural shadow requires:

- exact-size BUILD_CUSTOM buy;
- exact-size BUILD_CUSTOM immediate sell;
- retained raw payloads;
- instruction policy PASS;
- exact byte-level transaction policy PASS;
- complete cost accounting;
- no simulation claim.

It is never confirmatory.

## 9.1 Every eligible signal

Every eligible signal opens, when structurally valid:

```text
alpha_shadow
canary_shadow
```

regardless of whether the realizable portfolio:

- accepts;
- is halted;
- is full;
- lacks capital;
- fails its risk budget.

Accepted portfolio signals must also have independent fixed-notional shadow positions. Do not reuse the variable-size portfolio position as alpha shadow.

## 9.2 Signal episode identity

Create immutable `signal_episode_id`.

Prevent duplicate positions with a database constraint such as:

```text
UNIQUE(book, signal_episode_id)
```

Define how repeated screenings of the same mint become:

- one continuing episode;
- or a new episode after a frozen cooldown/state transition.

Do not let every 30-second rescreen become an independent trade.

## 9.3 Share identical observations

If alpha and canary shadow use the same:

- mint;
- amount;
- family;
- timestamp bucket;
- context;

reuse one execution observation rather than spending two API calls and pretending they are independent.

## 9.4 Fair scheduler

Replace oldest-first selection with due-time scheduling.

Track:

```text
last_mark_utc_ms
next_mark_due_utc_ms
mark_lag_ms
consecutive_misses
priority
```

Schedule most-overdue first, with emergency/near-trigger positions prioritized.

Guarantee that no position can starve indefinitely.

Report:

```text
open shadows
due shadows
marked this cycle
skipped for rate budget
maximum lag
median lag
p95 lag
```

If the backlog exceeds the budget, stop opening new shadows rather than silently degrading every existing position’s cadence.

## 9.5 Shadow economics

Shadow PnL must include exactly the same costs as portfolio paper:

- entry base fee;
- entry priority fee;
- tip;
- ATA rent;
- transfer fee;
- expected/actual failure cost;
- exit base fee;
- exit priority fee;
- tip;
- transfer fee;
- close cost;
- rent recovery.

A shadow cannot close on a hash/output alone. It requires the frozen structural or confirmatory leg requirements for its evidence class.

An unbuildable exit remains `EXIT_BLOCKED` and keeps being managed.

## 9.6 Three books

Maintain separately:

```text
alpha_shadow
canary_shadow
portfolio_paper
```

Never aggregate them.

Report:

```text
signal-conditional structural outcome
canary-size structural outcome
realizable portfolio outcome
```

---

# 10 — KEEP THE 100% CATASTROPHIC FLOOR UNTIL A COHORT EARNS A LOWER ONE

The development corpus showed near-total loss inside one mark interval. A nominal stop did not bound those outcomes.

Keep:

```text
catastrophicLossFloorPct = 100
```

for the 2–60-minute cohort until valid same-family observations justify a lower severe-loss quantile.

Fix existing-book planned loss so it uses the same catastrophic model as the proposed trade.

Aggregate planned loss must include:

```text
existing planned loss + proposed planned loss
```

Mark NAV using:

- executable value;
- locked rent;
- blocked positions;
- unresolved exits;
- failure costs.

Do not increase paper NAV, canary cap, risk budget, max notional, fee tolerance, or loss halts merely because the corrected model refuses entries.

Recalculate bankroll requirements only after §4–§9 produce internally consistent costs.

Report required bankroll by:

```text
opportunity score
notional
cohort
route
catastrophic-loss assumption
```

Do not publish one “minimum bankroll” number without those conditions.

---

# 11 — WIRE DIRECT ON-CHAIN SAFETY INTO THE DECISION PATH

`getMintFacts()` exists but is not a capital-eligibility fact.

Before a structurally valid shadow entry, persist direct mint facts:

```text
token program
decimals
mint authority
freeze authority
supply
permanent delegate
default account state
non-transferable
transfer hook
pausable
confidential transfer
current transfer fee
future-epoch transfer fee
withheld fee authority
unknown extensions
Mayhem state
```

Unknown money-critical behavior:

```text
observe: separate unknown cohort
development shadow: separate unknown cohort
canary/live: hard veto
```

Do not fall back from missing unique/net buyers to gross buy count. Missing entity breadth is unknown, not evidence of breadth.

Do not average soft-risk features in a way that allows adding a zero-risk feature to dilute an existing severe risk. Use a frozen aggregation such as:

- maximum plus bounded secondary contribution;
- probabilistic union;
- or an empirically calibrated model later.

Keep the current deterministic score frozen as a benchmark. Do not tune weights before executable labels exist.

---

# 12 — IMPLEMENT PUMP/PUMPSWAP STATE FIRST

All eight historical executable-value collapses routed through Pump.fun AMM. This makes Pump/PumpSwap the highest-value venue to decode first.

Implement current, versioned decoders for:

```text
Pump bonding curve
PumpSwap canonical pool
Pump fee config
creator vault/accounts
migration state
Mayhem state
SOL and USDC quote variants
```

At every entry and mark persist:

```text
real reserves
virtual reserves
base/quote vault balances
fee tier and components
market-cap tier
pool authority
LP/protocol ownership
migration status
canonical-pool identity
creator balance
creator net selling
large-holder net selling
liquidity additions/removals
executable full-position capacity
```

Current Pump documentation states:

- bonding-curve total fee is 1.25%;
- canonical PumpSwap fees vary by market-cap tier;
- graduation is automatic and irreversible;
- Mayhem can add one billion tokens and an automated trader for the first 24 hours.

Do not infer these facts from labels. Read current on-chain state and program configuration.

Fingerprint at startup:

```text
program ID
programdata hash
upgrade authority
account discriminator/layout
fee config
migration accounts
known instruction discriminators
```

A change starts a new protocol regime and blocks capital modes.

---

# 13 — USE WSS AS A RISK TRIGGER, NOT AS A PRICE

Wire `SOLANA_RPC_WS`.

For every managed position subscribe, with explicit commitment, to:

- verified pool account;
- base and quote vaults;
- relevant creator/authority accounts;
- token mint/config where required.

Persist:

```text
subscription source
context slot
write version if available
received monotonic time
received UTC time
account hash
```

On material state change:

1. enqueue an immediate exact BUILD_CUSTOM sell observation;
2. preserve the regular mark cadence as fallback;
3. do not derive an executable price from raw reserve state unless a venue-specific exact quoter has been parity-tested.

Direct account state is an alarm. BUILD_CUSTOM or a parity-tested direct quoter is the executable value.

---

# 14 — REPAIR HOLDER/ENTITY CLASSIFICATION

Use three categories:

```text
WALLET
VERIFIED_PROGRAM_CONTROLLED
UNKNOWN
```

Do not classify a missing owner account as a verified wallet or verified program-controlled entity merely from account existence.

A PDA may not exist as a standalone account, and “program-owned” does not prove “safe liquidity.” A creator-controlled vault is program-controlled and still dangerous.

Only exclude inventory from wallet concentration when venue-specific semantics verify it as:

- canonical pool vault;
- protocol escrow;
- burn sink;
- another audited non-discretionary account.

Build:

- creator history;
- first-buyer distribution;
- common-funder graph;
- same-transaction co-purchase clusters;
- synchronized purchase clusters;
- entity-adjusted top 1/5/10/20;
- creator/cluster net selling;
- real SOL inflow.

Prioritize features demonstrated in public Solana research:

- state changes;
- liquidity activity;
- entity/bundle linkage;
- concentration;
- time-series behavior.

Do not add sentiment or an LLM score before these.

---

# 15 — RESEARCH AGE COHORTS IN PARALLEL

The current 2–60-minute population carries:

- the highest manipulation risk;
- sparse holder/entity history;
- the observed collapse class;
- potentially higher route fees.

Create separate development-shadow cohorts:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

Use identical:

- BUILD_CUSTOM accounting;
- exact-size route checks;
- risk features;
- shadow notional;
- exit policies;
- evidence classes.

Do not pool cohorts.

The 24h–7d cohort is important because it conditions on survival and crosses Jupiter’s documented new-token `/order` fee boundary, though BUILD_CUSTOM economics remain their own family.

A cohort selected on development data receives one untouched future test.

The question is:

```text
Can the 2–60m strategy be made safe enough,
or is survivor momentum structurally more profitable after all costs?
```

Do not assume the answer.

---

# 16 — REPAIR REJECT TRACKING

Provider disappearance is not automatically -100%.

At rejection and every horizon persist:

```text
provider present/missing
provider health
direct pool state
BUILD_CUSTOM route status
same-size executable value
no-route confirmed
pool-drain confirmed
unbuildable
source gap
unknown
```

Classify:

```text
EXECUTABLE_VALUE
NO_ROUTE_CONFIRMED
POOL_DRAIN_CONFIRMED
PROVIDER_MISSING
SOURCE_GAP
UNBUILDABLE
UNKNOWN
```

Only a chain-supported economically worthless state becomes a total loss.

Do not use the first future priced observation as the anchor when reject-time price is missing.

Track rejected outcomes with the same execution family and notional as accepted shadows whenever rate budget permits. Use stratified sampling if it does not.

---

# 17 — DO NOT PREREGISTER P2B AGAIN UNTIL THE INSTRUMENT PASSES

A replacement confirmatory window requires all of:

```text
green Linux and Windows CI
protected master
clean source SHA
complete decision hashes
exact BUILD_CUSTOM transaction bytes
full byte-level policy
reproducible local simulation
same-family entry buy and immediate sell
same-family decision marks
complete accounting
complete fixed-notional shadows
no starvation
no duplicate signal episodes
direct mint safety
Pump/PumpSwap state for the primary cohort
valid raw-payload/account-snapshot provenance
zero replay divergence
zero unresolved lifecycle defect
```

Then freeze a deliberately small primary experiment:

```text
one route family
one exact deployable notional
one age cohort
one primary valuation
one ATA treatment
one control exit policy
one mechanism-distinct challenger
```

All other sizes/routes/cohorts/policies are labeled sensitivity or development arms.

The confirmatory gate must require at least:

- 200 valid completed positions;
- 21 calendar days;
- multiple market conditions;
- positive net expectancy on untouched chronological holdout;
- positive expected log growth;
- positive after deleting top 1/3/5/10 trades;
- positive after deleting the best day and best five mints;
- acceptable mint-block and day-block lower bounds;
- profit factor above the frozen threshold;
- drawdown below the frozen threshold;
- positive under doubled cost;
- positive under latency, failure, and rent stress;
- no single trade/day dominating;
- realizable portfolio positive, not only alpha shadow;
- canary-size shadow positive.

Compare against:

```text
no trade
holding SOL
random contemporaneous eligible entries
hard-gates-only baseline
current deterministic score
previous frozen policy
```

Record every attempted arm in the multiple-testing ledger.

No policy selection from fewer than 50 valid development trades. Fifty is not deployment evidence.

---

# 18 — KEEP THE EXECUTOR BLOCKED AND ALIGN IT WITH THE CHOSEN FAMILY

The current executor still:

- obtains `/order`;
- uses an `/order` transaction;
- submits through ordinary RPC;
- reads a fresh unrelated blockhash expiry;
- has no complete strategy loop.

That is incompatible with `primaryRouteFamily = BUILD_CUSTOM`.

Do not wire capital now.

Later BUILD_CUSTOM execution must use the exact assembled transaction validated in paper and compare broadcasters:

```text
ordinary dedicated RPC
Helius SWQOS-only
Helius default dual routing
Jupiter /submit
audited direct venue submission
```

Measure total wallet-to-wallet economics.

Current official constraints include:

- Jupiter `/submit`: minimum 0.001 SOL tip;
- Helius default dual routing: minimum 0.0002 SOL tip;
- Helius SWQOS-only: minimum 0.000005 SOL tip;
- both Helius routes require native priority fees.

At a 0.02-SOL canary, `/submit`’s minimum tip alone is 5% of notional and is unlikely to be viable. Do not use it merely because it is fast.

Treat each Helius tier as a distinct route. Never write one generic “Helius tip.”

Do not buy a paid RPC, stream, VPS, or colocated server until:

```text
positive corrected strategy edge
+
measured missed profit caused by infrastructure
>
upgrade cost
```

The future executor needs:

- exact expiry from the built transaction;
- full ALT account inspection;
- policy/effect parity with paper;
- one open canary position;
- actual fee reconciliation;
- actual failed-attempt fees;
- startup reconciliation;
- entry and exit loop;
- ATA close;
- no new intent while any outcome is unknown.

Canary/live remain disabled.

---

# 19 — DATABASE, RATE-LIMIT, AND OPERATIONS REPAIRS

## 19.1 WAL-safe migration backup

`openDb()` currently uses `copyFileSync(main.db)` before migration, even though the project’s own audit proved that copying the main file while WAL is active differs from a consistent `VACUUM INTO` snapshot.

Replace it with a real online backup.

A failed backup blocks a writable migration. It may not be silently ignored.

Mutation-test this.

## 19.2 Critical durability

For future capital modes, use a durability level appropriate for an execution ledger. Do not assume `synchronous=NORMAL` is sufficient for pre-send intent/attempt writes.

Measure and document the trade-off. Keep paper throughput separate from signer durability if needed.

## 19.3 Raw-payload storage

BUILD responses and account snapshots can make the current 1GB database grow rapidly.

Use:

- content-addressed compression;
- bounded raw-body retention;
- immutable segment manifests;
- external blob storage under `data/`;
- SQLite metadata/indexes;
- periodic Parquet archival;
- disk-space alerts.

Never discard the blob before all referenced rows are archived and verified.

## 19.4 Monotonic rate limiter

The token bucket still uses `Date.now()`.

Use monotonic time for refill and waiting. A wall-clock step must not create free API tokens, starve exits, or burst requests.

## 19.5 Service operation

Document and test a paper/development-shadow startup service:

- correct working directory;
- no signer;
- bounded restart;
- lock detection;
- reconciliation before discovery;
- logs;
- disk alert;
- WSL simulator health.

It must never start canary/live automatically.

---

# 20 — REQUIRED REGRESSION AND MUTATION TESTS

Add tests that fail against current HEAD for at least:

1. Linux key fixture mode 0644 causes expected refusal.
2. Safe fixture mode 0600 passes.
3. CI runs on Linux and Windows.
4. Every new decision field changes provenance.
5. `sourceCommit=unknown` fails admissibility.
6. `/order` mark cannot trigger BUILD_CUSTOM exit policy.
7. BUILD_CUSTOM entry without same-family sell is refused.
8. Probe quote cannot price exact entry.
9. Missing `otherAmountThreshold` fails rather than becoming zero.
10. Missing blockhash fails.
11. Exact blockhash is persisted.
12. ALT contents are resolved and hashed.
13. Signer/writable flag changes instruction hash.
14. Serialized bytes pass full policy.
15. Estimated policy cannot count as full policy.
16. Priority fee uses ceiling.
17. Priority fee derives from chosen limit, not static config.
18. Failed-attempt expectation is not charged twice.
19. Same-transaction ATA close pays no second base fee.
20. Rent treatment is identical in viability and PnL.
21. Transfer-fee unknown fails capital eligibility.
22. Exact entry accounting equals ledger delta.
23. Exact exit accounting equals ledger delta.
24. Cost-module field set is identical across portfolio/shadows/replay.
25. Existing open risk uses catastrophic floor.
26. Aggregate risk includes proposed trade.
27. Accepted signal opens independent alpha shadow.
28. Refused signal opens independent alpha shadow.
29. Every eligible signal opens canary shadow when structurally valid.
30. Same-sized shadow books share one observation.
31. Repeated screening does not duplicate one signal episode.
32. Shadow exit includes every cost.
33. Unbuildable shadow exit stays blocked.
34. Oldest shadow cannot starve newer due shadows.
35. Backlog stops new shadow entries.
36. Portfolio marks use BUILD_CUSTOM.
37. Counterfactual policies receive later same-family observations.
38. Trigger observation is not illegally reused.
39. Resync remains blocked after failed re-mark.
40. Later successful re-mark can clear a transient source failure.
41. `EXIT_BLOCKED` remains managed.
42. Missing source timestamp is unknown.
43. Missing net buyers is not replaced by gross buys.
44. Unknown owner is not verified-safe.
45. Verified pool exclusion requires venue semantics.
46. Mayhem token is separately classified.
47. Provider disappearance is not automatically -100%.
48. Main-file WAL copy is rejected as backup.
49. Raw-payload references survive archive.
50. Rate limiter survives wall-clock rollback.
51. Simulator snapshot replay is deterministic.
52. Simulator buy matches intended deltas.
53. Simulator sell matches intended deltas.
54. Simulator unsupported program fails closed.
55. Mainnet parity fixture passes.
56. Confirmatory row requires simulator snapshot hash.
57. All-null contexts fail.
58. Pre-preregistration row fails.
59. Mark gap fails.
60. Current deployment gate counts only fully admissible positions.

Run mutation tests against every repaired defect, not only unit coverage.

---

# 21 — REQUIRED COMMANDS AND ARTIFACTS

Provide working commands:

```bash
pnpm audit:state
pnpm ci:local
pnpm simulator:doctor
pnpm simulator:parity
pnpm observe:route
pnpm shadow:development
pnpm shadow:status
pnpm cost:surface
pnpm pool:parity
pnpm cohort:status
pnpm replay
pnpm report
pnpm readiness
pnpm release:manifest
```

Create or update:

```text
docs/AUDIT_HEAD_FF60902.md
docs/FF60902_WINDOW_INVALIDATION.md
docs/SIMULATOR.md
docs/SIMULATOR_PARITY.md
docs/EXECUTION_OBSERVATION.md
docs/COST_ACCOUNTING.md
docs/SHADOW_BOOKS.md
docs/PUMP_PUMPSWAP.md
docs/COHORTS.md
docs/DEVELOPMENT_STATUS.md
docs/READINESS.md
docs/UPGRADE_ROI.md
docs/FAILURE_REGISTER.csv
docs/MULTIPLE_TESTING_LEDGER.csv
artifacts/current-context.json
artifacts/cost-surface.json
artifacts/simulator-parity.json
artifacts/development-status.json
artifacts/release-manifest.json
```

`artifacts/development-status.json` must be machine-generated and include:

```text
source SHA
dirty flag
CI status
branch protection status
strategy/config/risk/context hashes
execution family
simulator version
simulator parity
account snapshot regime
eligible signal episodes
structural shadow positions
simulated shadow positions
blocked positions
mark cadence and lag
cost model
priority fee distribution
failed-attempt model
ATA recovery treatment
cohort counts
every current blocker
```

---

# 22 — FINAL REPORT

At the end, report:

1. local starting and ending SHA;
2. whether local work differed from GitHub;
3. backup path/hash/integrity;
4. active process and position state;
5. GitHub CI result on Linux and Windows;
6. branch-protection result;
7. exact provenance changes;
8. cost-model corrections;
9. old versus corrected priority-fee distribution;
10. old versus corrected viability floor by notional;
11. exact transaction assembly proof;
12. exact blockhash/ALT/packet proof;
13. simulator environment/version/hash;
14. simulator parity results;
15. structural versus simulated observation counts;
16. proof every eligible signal enters both shadow books;
17. shadow scheduling/backlog metrics;
18. same-family entry and mark proof;
19. Pump/PumpSwap fields now captured;
20. WSS trigger result;
21. cohort counts;
22. current valid development trades/days;
23. current valid confirmatory trades/days;
24. unresolved blockers;
25. exact operator actions still required;
26. exact command to run/monitor/stop development collection;
27. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_COLLECTION_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

Expected honest outcome of this session is usually:

```text
VALID_DEVELOPMENT_COLLECTION_RUNNING
```

A simulator may allow `VALID_CONFIRMATORY_COLLECTION_STARTED` only if every gate above genuinely passes. Do not promote merely because Surfpool starts, one transaction simulates, or one shadow closes.

Do not run canary or live. Do not fund a wallet. Do not call any development-shadow return profitable.
