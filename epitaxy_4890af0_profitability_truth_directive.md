# CLAUDE CODE DIRECTIVE — EPITAXY 4890AF0: PROSPECTIVE SWAP PARITY, COHERENT SHADOWS, AND THE FASTEST HONEST PROFIT TEST

**Repository:** `TateLyman/epitaxy`  
**Audited GitHub branch:** `master`  
**Audited GitHub HEAD:** `4890af0ea4686152d987ea62a3d41727d5476886`  
**Date:** 2026-08-12  
**Current honest state:** `MEASUREMENT_REPAIR_REQUIRED`  
**Permitted modes:** observe, development structural shadow, development simulated shadow  
**Forbidden:** canary, live, funding a trading wallet, signing, submitting, weakening capital gates, increasing virtual NAV merely to force entries, or claiming profitability

Execute this directive in the Epitaxy repository. Do not merely return a plan. Do not work in `memecoinstuff`, `memecointrader`, or any graduation-auction repository.

The objective is not to add more architecture for its own sake. The objective is the **fastest truthful path to positive capture-adjusted expected log growth**:

1. eliminate the remaining correctness defects that can fabricate or lose evidence;
2. use prospective current-state capture rather than waiting for historical archival state;
3. make every entry, mark, shadow and exit one coherent execution family;
4. measure the real cost floor instead of assuming it;
5. collect exact same-family development outcomes immediately;
6. build the Pump/PumpSwap facts most likely to prevent catastrophic entries;
7. compare age regimes before tuning scores or exits;
8. start one small confirmatory window only when the instrument has earned it.

No profit is guaranteed. A system that cannot prove positive expectancy remains paper-only.

The only permitted final states are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_SIMULATION_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`CANARY_READY`, `LIVE_READY`, and `PROFITABLE` are forbidden outputs.

---

# 0 — PRESERVE THE ACTUAL LOCAL STATE

GitHub HEAD is not proof of the local machine, runtime DB, WSL daemon, or active processes.

Before editing:

```bash
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -40
git diff
git diff --cached
node --version
pnpm --version
pnpm status
pnpm health
pnpm capability -- --mode=paper
wsl --status
wsl -l -v
```

Record:

- exact Windows repo path;
- local HEAD and whether it differs from audited HEAD;
- dirty/untracked files;
- active Windows engine PID, start time and command;
- active WSL simulator PID, start time, distro and command;
- Windows/WSL clock offset;
- current context, config, risk, schema, engine, adapter, accounting and simulator hashes;
- current halt state;
- DB, WAL and SHM paths;
- every portfolio position holding tokens;
- every `EXIT_BLOCKED`/`RECONCILING` position;
- every open alpha/canary shadow;
- latest build, observation, mark and simulation;
- simulator identity and health;
- rate-budget state;
- Windows and WSL free disk;
- latest GitHub CI conclusion;
- current ruleset;
- repository visibility.

If any position has nonzero tokens:

1. engage `HALT_NEW_ENTRIES`;
2. keep exit/blocked management active;
3. do not change its economic policy mid-position;
4. preserve it as development-only if it cannot become flat before semantic changes;
5. never hard-stop in a way that abandons exposure.

Use `VACUUM INTO` or the SQLite online backup API while WAL is active. Never copy only the main DB.

Run:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Save:

- backup path and SHA-256;
- read-back integrity;
- table counts;
- max IDs/timestamps;
- all nonterminal positions;
- all run contexts;
- observations by family/status;
- simulations by status;
- blobs and snapshot manifests.

Create:

```text
docs/AUDIT_HEAD_4890AF0.md
```

Commit the untouched baseline before semantic changes.

---

# 1 — CLOSE THE CURRENT WINDOW AS DEVELOPMENT DATA

The present tree has a working Surfpool daemon for simple transactions and exact historical **fee** parity, but it does not yet have:

- real-route execution parity;
- complete route account/program state;
- simulation wired into the Windows engine;
- same-family portfolio marks;
- complete fixed-notional shadow books;
- stable cost accounting;
- complete provenance;
- a current clean release manifest.

Everything written from the prior invalidation through the final repair commit remains development data.

Create:

```text
docs/4890AF0_WINDOW_INVALIDATION.md
```

Record:

- source SHAs;
- context hashes;
- start/end;
- signal episodes;
- portfolio positions;
- shadow positions;
- observations by family/purpose;
- simulation jobs;
- marks;
- exits;
- every reason the rows cannot be confirmatory.

Do not delete or relabel rows. Close their contexts.

Do not open a confirmatory window until §17 passes.

---

# 2 — P0 DATA AND LIFECYCLE CORRECTNESS

## 2.1 Restore every exposure, including blocked exposure

`restoreLedger()` currently relies on a query that excludes some managed states.

At startup, reconstruct exposure directly from first principles:

```text
closed_utc_ms IS NULL
AND token_amount > 0
```

Include:

```text
POSITION_OPEN
EXIT_INTENT
EXIT_BLOCKED
RECONCILING
any unknown nonterminal state
```

Reconstruct:

- token amount;
- entry cash out;
- locked rent;
- total exposure;
- catastrophic planned loss;
- current executable mark if fresh;
- unknown/unpriceable exposure conservatively.

An unknown nonterminal state with tokens blocks entries and raises a critical health event.

Add an invariant:

```text
every nonzero nonclosed position
=> managed, marked, included in NAV, exposure and planned loss
```

Mutation-test omission of each state.

## 2.2 Replace the WAL-unsafe pre-migration copy

`openDb()` still copies the main DB file and ignores backup failure.

Replace it with a true online backup. A failed backup blocks writable migration.

Test:

- active WAL frames;
- backup includes latest committed row;
- read-back integrity;
- disk full;
- permission failure;
- interruption;
- no migration begins after backup failure.

## 2.3 Exact-money SQL

Audit every `CAST(... AS INTEGER)` and every SQL `SUM` over money/token TEXT.

Use:

- SQLite INTEGER + `setReadBigInts(true)` where signed 64-bit is guaranteed;
- canonical decimal TEXT + JavaScript `bigint` otherwise.

No decision, ledger or report may convert exact amounts through `Number`.

---

# 3 — FIX THE SIMULATOR DAEMON’S CONCURRENCY AND IDENTITY

The daemon says fresh instance per job, but currently allows multiple concurrent jobs and caches only completed jobs.

## 3.1 Serialize first

Initial production-development daemon:

```text
MAX_ACTIVE_SURFNETS = 1
bounded FIFO queue
fresh Surfnet per job
destroy before next job
```

Do not optimise this until correctness and measured throughput require it.

## 3.2 In-flight idempotency

Maintain:

```text
jobId -> { requestHash, Promise<SimulationResponse> }
```

Rules:

- same job ID + same hash while running attaches to the existing promise;
- same job ID + different hash returns 409 immediately;
- same completed job + same hash returns cached response;
- different hash always refuses;
- process restart reconciles through the Windows durable `simulation_jobs` table.

A client timeout must not launch a second simulation under the same job.

## 3.3 Queue semantics

Expose:

```text
active
queued
oldestQueueAgeMs
jobsCompleted
jobsFailed
jobsUnknown
medianStartupMs
medianSimulationMs
```

Bound:

- body size;
- queue size;
- request execution time;
- cache size;
- memory;
- log size.

A request timeout should mark the Windows job `SIMULATION_UNKNOWN`, then reconcile by job ID. It is not a retry invitation.

## 3.4 Bigint safety

Remove unsafe `Number()` conversion for:

- lamports;
- token atoms;
- rent epoch;
- supply;
- transfer fees;
- account balances.

Use Surfpool’s bigint-capable typed cheatcode transport. Where a native binding truly accepts only JS numbers, refuse values above `Number.MAX_SAFE_INTEGER`; never silently round.

Delete or consolidate duplicate Surfpool wrappers so only one audited implementation exists.

Add tests at:

```text
2^53 - 1
2^53
u64 maximum-shaped decimal
large fresh-token supplies
Token-2022 balances
```

## 3.5 Simulator identity

Identity must include:

- daemon source SHA;
- dirty flag;
- pnpm lock hash;
- `@solana/surfpool` version;
- native binary SHA-256;
- Solana runtime version;
- feature set;
- WSL distro/kernel;
- transaction encoder version;
- snapshot schema;
- program-capture schema.

`unknown`, dirty or mismatch is not confirmatory.

---

# 4 — PROVE THE V0 TRANSACTION ENCODER AGAINST THE OFFICIAL COMPILER

The custom encoder has good single-ALT tests, but multi-table ordering is load-bearing.

## 4.1 Multi-ALT runtime ordering

Create adversarial cases with:

```text
table A: A1, A2
table B: B1, B2
instruction meta order: A1, B1, A2, B2
mixed writable/readonly
same address appearing in multiple tables
program IDs present in tables
signers offered by tables
```

The index space must exactly match Solana’s runtime:

```text
static
then writable addresses in message lookup-table order
then readonly addresses in message lookup-table order
```

Do not build the global ALT order from arbitrary meta insertion order.

## 4.2 Differential compiler

Pin a current official Solana transaction library and compile the same instruction/ALT corpus through:

- Epitaxy encoder;
- official compiler.

Require exact equality of:

- message bytes;
- static keys;
- header;
- compiled instruction indexes;
- lookup entries and indexes;
- packet bytes.

Use real current Jupiter `/build` responses with:

- zero, one and multiple ALTs;
- split routes;
- setup and cleanup;
- Token-2022;
- PumpSwap, Raydium and Meteora where observed.

## 4.3 Full account policy

Resolve every ALT and inspect every loaded account.

No transaction may pass full policy with:

- unresolved lookup table;
- unresolved address;
- duplicate/ambiguous resolution;
- unexpected writable;
- unexpected signer;
- program loaded incorrectly;
- packet >1232 bytes.

Persist lookup-table account bytes and resolved contents, not only a hash.

---

# 5 — PERSIST THE EXACT TRANSACTION, NOT ONLY ITS HASH

A simulation must be tied to exact bytes.

For every BUILD_CUSTOM observation persist, content-addressed and compressed:

```text
raw /build response
ordered raw instructions
lookup-table accounts and contents
serialized unsigned transaction bytes/base64
message bytes
message hash
transaction hash
blockhash
last-valid block height
packet size
full static/loaded account list
writable set
readonly set
required signatures
fee payer
```

The SQL row stores the blob hash and immutable metadata. The blob store is outside SQLite under `data/blobs/`, with manifests and read-back verification.

No PnL-eligible leg may be reconstructed later from fields that “should” produce the same transaction. It references the exact bytes policy-checked and simulated.

Archival/rotation may move blobs to Parquet/segments only after hashes and references verify.

---

# 6 — FAIL CLOSED ON MISSING BUILD FIELDS

Do not convert missing fields into zero or empty values.

Required BUILD_CUSTOM fields:

```text
inputMint
outputMint
inAmount
outAmount
otherAmountThreshold
slippageBps
routePlan
swapInstruction
ordered setup/other/cleanup instructions
lookup tables
blockhash
lastValidBlockHeight
contextSlot
```

Typed failures:

```text
MISSING_MINIMUM_OUTPUT
MISSING_BLOCKHASH
MISSING_EXPIRY
MISSING_ROUTE_PLAN
MISSING_SWAP_INSTRUCTION
MISSING_LOOKUP_TABLE
MISSING_CONTEXT_SLOT
AMOUNT_MISMATCH
MINT_MISMATCH
```

`legIsExecutable()` and confirmatory admissibility require every load-bearing field, exact bytes, complete account coverage and an unexpired observation.

---

# 7 — USE PROSPECTIVE STATE; DO NOT WAIT FOR AN ARCHIVAL NODE

Historical settled-transaction execution parity needs historical account state. That does **not** block prospective current-route parity.

## 7.1 Current JIT simulation

For a current exact BUILD_CUSTOM observation:

1. preserve exact transaction and build context;
2. start a fresh Surfnet with remote JIT enabled;
3. apply hypothetical wallet balances;
4. simulate the exact transaction copy with recorded blockhash replacement;
5. export the **pre-transaction** account snapshot;
6. collect every JIT-fetched account;
7. collect every loaded program and programdata account;
8. stop the instance.

The result is `DEVELOPMENT_JIT`, never confirmatory.

## 7.2 Freeze program code correctly

Upgradeable program state is not merely an executable account.

For every invoked current program:

- capture program account;
- parse loader;
- capture ProgramData account;
- extract/preserve ELF or use Surfpool’s program clone/export mechanism;
- capture upgrade authority;
- record slot and hashes.

Include:

- Jupiter;
- Pump/PumpSwap;
- SPL Token;
- Token-2022;
- ATA;
- System/Compute Budget;
- every routed AMM;
- every CPI-discovered executable program.

Verify whether Surfpool’s snapshot export already carries program code. Do not assume.

## 7.3 Offline replay

Start a new Surfnet with:

```text
offline = true
frozen account snapshot
frozen program code
same hypothetical balances
same exact transaction
same blockhash-replacement rule
```

Require JIT and offline replay to agree on:

- success/failure;
- logs/error;
- units consumed;
- SOL/token deltas;
- fees;
- rent;
- created/closed accounts;
- mutated-account hashes;
- bounds.

Only the offline replay may become reproducible evidence.

## 7.4 Mainnet current-state cross-check

For current unsigned transactions, use mainnet `simulateTransaction` where possible with:

```text
sigVerify=false
replaceRecentBlockhash=true
accounts returned
```

Capture source slots and account hashes.

Compare mainnet simulation and Surfpool offline replay. Refuse parity if load-bearing account state changed between the two measurements.

Historical execution parity remains a separate diagnostic. Do not buy archival access yet.

---

# 8 — COMPLETE ACCOUNT COVERAGE IS A REQUIREMENT

The daemon currently watches a bounded subset and cannot determine ALT-loaded writability completely.

For every simulation:

- resolve every static and ALT-loaded account;
- identify every writable account;
- request post-state for every writable and every economic account;
- capture input/output ATAs, payer, fee/tip recipients, pool vaults and cleanup accounts;
- record account coverage count and omissions.

No silent truncation.

If the RPC account-return limit prevents full coverage:

- split the effect measurement through Surfpool cheatcodes/profile APIs;
- or refuse as `ACCOUNT_COVERAGE_INCOMPLETE`.

Add explicit response fields:

```text
completeAccountCoverage
unresolvedAccounts
unobservedWritableAccounts
watchedAccountCount
expectedWritableCount
```

`responseIsConfirmatory()` must require complete coverage, no bounds violations and known transfer-fee treatment.

---

# 9 — WIRE THE SIMULATOR INTO THE WINDOWS ENGINE

The daemon and client exist; the paper engine still does not consume them.

For every exact observation:

1. record `SIMULATION_REQUESTED` durably before network call;
2. submit one immutable job;
3. verify daemon identity;
4. store response;
5. update observation simulation status only if job ID, hash, bytes, snapshot and identity all match;
6. mark timeout/connection loss `SIMULATION_UNKNOWN`;
7. reconcile unknown jobs before re-running;
8. never convert unavailable simulator into a token failure.

The engine may continue:

- observe;
- structural development shadows

during daemon outage, but must refuse:

- simulated shadow fill;
- portfolio paper fill;
- confirmatory evidence.

Add a health surface:

```text
simulator_reachable
identity_match
queue_depth
last_success
parity_status
snapshot_freeze_status
```

---

# 10 — REBUILD THE COST MODEL FROM MEASURED TRANSACTIONS

## 10.1 Priority fee

The current 200,000-lamport assumption is not a measurement.

Two-pass process:

1. build with a generous bounded limit;
2. simulate and read `unitsConsumed`;
3. rebuild with a frozen safety multiplier;
4. simulate again;
5. compute exact priority fee with **ceiling**:

```text
ceil(unit_price_micro_lamports × chosen_CU_limit / 1,000,000)
```

Store:

```text
router unit price
router limit if present
default limit if none
first-pass units
safety multiplier
chosen limit
chosen priority fee
second-pass units
```

Use the current official Jupiter recommendation unless preregistered evidence supports another buffer.

## 10.2 Default CU limit

When no explicit limit exists, compute Solana’s default from actual instructions:

```text
3,000 per applicable non-migrated builtin
200,000 per non-builtin or migrated builtin
clamped at 1,400,000
```

Do not pretend the absent router limit is zero.

## 10.3 Failed attempts

Replace one flat `assumedFailedAttemptLamports` charged on every leg with:

```text
entry attempt count
entry landed-failure count/cost
exit attempt count
exit landed-failure count/cost
P(entry failure) × conditional fee
P(exit failure) × conditional fee
```

Actual failed attempts are charged directly.

Sensitivity:

```text
0 observed failures
observed rate
upper confidence bound
2× rate
```

## 10.4 ATA/rent

Track:

```text
ATA existed before
ATA created
rent locked
full sell leaves zero
withheld fees
close in same transaction
close separate transaction
close simulated
rent recovered
```

A close instruction in the same exit transaction does not pay another signature.

Rent is locked capital until recovery and an economic loss only when not recovered.

## 10.5 Transfer fees

Decode current/future-epoch Token-2022 transfer fees and withheld amounts.

Unknown transfer economics cannot be confirmatory.

## 10.6 One accounting module

One module calculates:

```text
entry cash out
exit cash in
locked capital
expected failure cost
realized cost
```

It is the sole source for:

- portfolio;
- shadows;
- replay;
- viability;
- sizing;
- reports;
- future canary.

No cost may appear in one path and disappear in another.

Regenerate the complete size/cost surface after these repairs. Do not cite the old 0.0286-SOL floor or 11.4-SOL bankroll as current facts.

---

# 11 — ONE FAMILY FROM ENTRY THROUGH EVERY MARK

## 11.1 Final entry round trip

The cheap `/order` probe may screen.

Before opening any BUILD_CUSTOM development position:

1. choose exact notional;
2. exact BUILD_CUSTOM buy;
3. exact bytes/policy/simulation;
4. derive exact acquired token amount from frozen primary valuation;
5. immediate exact BUILD_CUSTOM sell for that amount;
6. exact bytes/policy/simulation;
7. calculate same-family round-trip cost;
8. rerun all entry tradability/viability gates.

A buy without its immediate sell is not an entry.

## 11.2 Decision-bearing marks

Every portfolio and shadow mark that can trigger an exit must be:

```text
exact full-balance BUILD_CUSTOM sell
same accounting
same policy
same simulation regime
```

`/order` remains a separately stored economic benchmark and may not drive stops, trails, take profit, collapse, NAV or policy comparison.

## 11.3 Fair counterfactual policies

At every frozen mark:

- collect one same-family observation;
- apply each policy only to information available then;
- apply measured decision/build/submission latency;
- fill at the first later valid observation;
- never use the trigger observation as its fill;
- record `EXIT_BLOCKED` if no valid later observation exists.

Do not rank policies until this stream exists.

---

# 12 — BUILD COMPLETE FIXED-NOTIONAL SHADOW BOOKS

## 12.1 Every signal enters both books

Every structurally eligible `signal_episode_id` opens:

```text
alpha_shadow
canary_shadow
```

regardless of whether portfolio paper:

- accepts;
- refuses;
- is full;
- is halted;
- lacks capital.

Accepted portfolio trades do not substitute for fixed shadows.

## 12.2 Episode identity

Replace coarse wall-clock bucketing with a stateful episode:

```text
candidate first becomes eligible
episode remains active while continuously eligible
episode ends after frozen ineligibility/cooldown
new episode begins only after the frozen reset condition
```

Provider failure does not consume the opportunity.

Database constraints prevent duplicate book/episode pairs.

## 12.3 Share identical calls

When alpha and canary use the same mint, notional, family and context, use one observation and reference it from both books.

Do not spend two API calls for one fact.

## 12.4 Due-time scheduler

Maintain:

```text
last_mark
next_due
lag
misses
priority
near-trigger state
```

Schedule:

1. blocked/near-trigger;
2. most overdue;
3. newer positions.

No oldest-first starvation.

Dynamically limit new shadows so the documented Jupiter budget can maintain the mark SLA. If backlog exceeds capacity, stop opening new shadows and record skipped episodes.

## 12.5 Complete economics and lifecycle

Shadow entry and exit use the unified cost module.

An unbuildable exit becomes a managed blocked shadow with rent/exposure still locked.

Report separately:

```text
structural development
simulated development
confirmatory
```

Never sum shadow and portfolio PnL.

---

# 13 — PUMP/PUMPSWAP IS THE HIGHEST-VALUE ALPHA WORK

All historical collapse observations routed through Pump-related liquidity. Build this before sentiment or ML.

Use official Pump program/SDK/IDL sources and on-chain parity.

Implement current decoders for:

```text
Pump bonding curve
PumpSwap canonical pool
fee config and market-cap tier
creator vault
migration state
Mayhem state/program
SOL and USDC quote variants
```

At decision and every mark capture:

```text
real and virtual reserves
base/quote vault balances
current total fee and components
market-cap tier
pool authority
canonical pool identity
migration state
creator token balance
creator net selling
large-holder/cluster net selling
liquidity changes
full-position executable capacity
Mayhem status and agent wallets
```

Protocol fingerprints:

```text
program ID
programdata hash
upgrade authority
account discriminators/layout
fee config
instruction discriminators
```

A fingerprint change begins a new regime and blocks capital modes.

## Exact direct quoter

Build an exact Pump/PumpSwap read-only quoter and prove parity against:

- official SDK/math;
- current `/build` Pump route;
- actual settled swaps.

Use it for:

- high-frequency risk alarm;
- reserve/capacity features;
- route benchmark.

Do not call it an executable family until its transaction builder, policy and simulation also pass.

---

# 14 — WSS RISK TRIGGERS

Wire the existing Helius standard WebSocket allowance.

Subscribe with explicit commitment to:

- primary pool;
- base/quote vaults;
- mint/config;
- creator/Mayhem/authority accounts where load-bearing.

Persist:

```text
context slot
receive monotonic time
receive UTC
account hash
subscription/reconnect epoch
source gap
```

Material changes enqueue an immediate same-family BUILD_CUSTOM observation.

Raw reserve state is an alarm, not a fill price, until direct quoter parity passes.

---

# 15 — ENTITY/FRAUD FEATURES BEFORE SCORE TUNING

Wire authoritative direct mint facts into eligibility:

```text
mint/freeze authority
permanent delegate
default frozen
transfer hook
non-transferable
pausable
confidential extensions
current/future transfer fee
withheld authority/amount
unknown extensions
Mayhem
```

Build:

- creator history;
- first 10/20 buyers;
- common initial funder;
- same-transaction co-purchase;
- synchronized purchases;
- shared fee payer;
- direct transfer graph;
- entity-adjusted top 1/5/10/20;
- creator/cluster net selling;
- genuine net SOL inflow;
- holder/maker persistence;
- wash-like round trips.

Unknown is separate from safe and malicious.

Keep the current deterministic score frozen as a baseline. Do not tune weights or train ML until same-family simulated labels exist.

Then compare:

```text
hard gates only
current score
simple severe-loss logistic model
simple continuation/return model
tree model only if chronologically superior
```

No LLM in the decision loop.

---

# 16 — TEST AGE REGIMES IN PARALLEL

Create separate fixed-shadow cohorts:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

Same:

- route family;
- notional;
- costs;
- features;
- exit policies;
- evidence class.

Do not pool.

The 24h–7d cohort conditions on survival and permits more entity/liquidity history. `/order` fee categories are measured only as benchmarks; BUILD_CUSTOM keeps its own economics.

A cohort selected from development data receives an untouched future test.

---

# 17 — REPAIR REJECT TRACKING

At rejection and each horizon record same-family exact-size outcome where budget allows:

```text
BUILD_CUSTOM executable value
direct pool state
provider health
route/policy/simulation status
pool drain
source gap
unknown
```

Provider disappearance is not -100%.

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

Use stratified sampling when all rejects cannot be followed. Preserve inclusion probabilities.

---

# 18 — START VALID DEVELOPMENT SIMULATION

A valid development-simulation window requires:

- green Linux/Windows CI;
- protected branch;
- clean SHA;
- repaired provenance;
- exact transaction blobs;
- complete ALT policy;
- serialized daemon/idempotency;
- prospective JIT snapshot export;
- offline replay;
- complete account coverage;
- simulator wired into engine;
- same-family entry and marks;
- complete shadows;
- unified cost accounting;
- no lifecycle/ledger blocker.

It may start before full Pump/entity features are complete, but every missing feature must be recorded as missing and cannot be silently safe.

Initial primary development arm:

```text
BUILD_CUSTOM
0.02 SOL or the corrected canary-valid notional
one primary valuation
one age cohort
control exit policy
one mechanism-distinct challenger
```

Other cohorts are parallel development arms.

Report at 10/25/50/100 valid completed simulated positions. Do not select a policy before 50. Fifty is not deployment evidence.

---

# 19 — CONFIRMATORY GATE

Only after the instrument and development choice are frozen:

```text
one route family
one exact deployable notional
one age cohort
one primary valuation
one ATA treatment
one control policy
one challenger
```

Require at least:

- 200 valid completed positions;
- 21 calendar days;
- multiple market conditions;
- positive chronological untouched-holdout net expectancy;
- positive expected log growth;
- positive after top 1/3/5/10 removal;
- positive after best day and best five mints removed;
- acceptable mint/day block lower bounds;
- acceptable drawdown/CVaR;
- profit factor above frozen threshold;
- positive under 2× costs;
- positive under latency/failure/rent stress;
- no single trade/day domination;
- positive realizable portfolio;
- positive canary-size shadow;
- zero replay divergence;
- zero unresolved reconciliation;
- stable protocol/simulator fingerprints.

Compare against:

```text
no trade
hold SOL
random contemporaneous eligible entry
hard-gates-only
current deterministic score
previous frozen policy
```

Do not weaken a gate after seeing results.

---

# 20 — EXECUTION/BROADCASTER WORK REMAINS BLOCKED

Do not wire capital now.

Eventually the chosen BUILD_CUSTOM bytes must be benchmarked through:

```text
ordinary dedicated RPC
Helius SWQOS-only
Helius default/Max
Jupiter /submit
audited direct venue
```

Measure complete economics:

- landing rate;
- latency;
- tip;
- priority fee;
- failed fees;
- route survival;
- wallet-to-wallet output.

At small canary size, high fixed-tip routes may be uneconomic. Do not choose “fastest” without net expected value.

No paid RPC, archival node, stream, VPS or shreds until:

```text
positive corrected strategy edge
+
measured profit lost to infrastructure
>
upgrade cost
```

The future executor must use the same family, encoder, policy, simulation and cost model as paper, plus:

- actual signing;
- exact expiry;
- submission;
- reconciliation;
- entry/exit loop;
- ATA close;
- no new intent with unknown prior fate.

Canary/live remain disabled.

---

# 21 — PROVENANCE, MANIFESTS AND REPOSITORY SECURITY

## 21.1 Complete hashes

`strategyConfigHash` and `dataRegimeId` must include every decision/economic field:

```text
route family
simulation/exact-build flags
broadcaster
tips
failure model
latency stress
catastrophic floor
shadow notionals/budget
primary valuation
cohort
simulator/snapshot/program regime
cost-accounting version
mark source
```

Bump semantic versions.

Add enumeration tests that fail when a new decision-bearing field is unclassified.

## 21.2 Fresh artifacts

Regenerate from the final clean SHA:

```text
artifacts/current-context.json
artifacts/cost-surface.json
artifacts/simulator-parity.json
artifacts/development-status.json
artifacts/release-manifest.json
```

A manifest must read actual test/replay/CI results. Do not hardcode `tests.run=false`.

Committed stale artifacts must be replaced or clearly moved to historical artifacts.

## 21.3 Repository visibility

The repository is currently public.

Do not commit:

- runtime DB;
- raw production payload corpus;
- operational endpoint details;
- tokens/secrets;
- future live strategy config;
- signer material;
- private account snapshots.

Recommend either:

```text
make the entire repo private
```

or:

```text
public research/core
private ops/strategy/runtime
```

Do not change visibility without explicit operator approval. Report the exact action needed.

## 21.4 Reviews

Current rules require PR/checks but no approving reviewer.

For signer, execution, risk, config, migration and gate changes, add CODEOWNERS and require one independent review when a trusted reviewer is available.

Do not weaken CI for speed.

---

# 22 — REQUIRED REGRESSION TESTS

Add tests that fail against current HEAD for at least:

1. blocked position restored into exposure/NAV;
2. unknown nonterminal token position blocks entries;
3. WAL main-file copy is rejected;
4. backup failure blocks migration;
5. duplicate in-flight simulation attaches once;
6. same job/different hash races refuse;
7. only one Surfnet active initially;
8. queued job metrics are accurate;
9. u64/token amount above 2^53 is exact or refused;
10. multi-ALT interleaved writable ordering;
11. multi-ALT readonly ordering;
12. differential bytes versus official compiler;
13. program IDs remain static;
14. every loaded writable is policy-checked;
15. exact transaction blob round-trips;
16. missing minimum output fails;
17. missing blockhash/expiry/context fails;
18. JIT export captures pre-transaction snapshot;
19. current program/programdata ELF is frozen;
20. offline replay matches JIT;
21. incomplete account coverage refuses confirmatory;
22. ALT-loaded writable post-state is observed;
23. Windows records request before send;
24. unknown simulation reconciles idempotently;
25. simulator identity mismatch fails;
26. priority fee uses ceiling;
27. default CU limit matches official rules;
28. two-pass CU rebuild uses frozen margin;
29. failed-attempt expectation is not double-charged;
30. same-transaction ATA close has no extra signature;
31. rent treatment matches viability and PnL;
32. transfer fee unknown fails confirmatory;
33. portfolio entry requires immediate same-family sell;
34. portfolio mark cannot use `/order`;
35. counterfactual gets later same-family fill;
36. accepted signal opens fixed alpha and canary shadows;
37. refused signal opens fixed alpha and canary shadows;
38. identical shadow size shares observation;
39. episode cannot duplicate at a wall-clock bucket boundary;
40. provider failure does not consume episode;
41. due scheduler prevents starvation;
42. backlog stops new positions;
43. shadow exit includes all costs;
44. blocked shadow stays managed;
45. Pump fee tier decoder matches fixture;
46. Mayhem detected;
47. WSS change triggers BUILD_CUSTOM observation;
48. provider disappearance is not -100%;
49. provenance changes for every decision field;
50. stale artifact cannot satisfy readiness;
51. confirmatory gate rejects development JIT;
52. current route offline parity required;
53. zero simulator observations cannot be presented as valid PnL;
54. executor remains unavailable.

Run mutation testing against every corrected defect.

---

# 23 — REQUIRED COMMANDS

Provide working commands:

```bash
pnpm audit:state
pnpm ci:local
pnpm simulator:doctor
pnpm simulator:prospective-parity
pnpm simulator:offline-replay
pnpm simulator:status
pnpm cost:surface
pnpm shadow:development
pnpm shadow:status
pnpm pump:parity
pnpm cohort:status
pnpm reject:status
pnpm replay
pnpm report
pnpm readiness
pnpm release:manifest
```

Provide Windows commands for:

- starting/stopping paper;
- starting/stopping the WSL daemon;
- Task Scheduler;
- health;
- backup;
- halt-new-entries;
- graceful flat shutdown.

Nothing automatically starts canary/live.

---

# 24 — REQUIRED FINAL REPORT

At the end report:

1. local starting and ending SHA;
2. differences from audited GitHub;
3. DB backup/integrity;
4. current positions/shadows;
5. window invalidated;
6. CI and ruleset;
7. visibility and operator action;
8. ledger/backup fixes;
9. simulator concurrency/idempotency proof;
10. bigint proof;
11. multi-ALT differential proof;
12. exact transaction blob proof;
13. current-route JIT result;
14. snapshot/program capture;
15. offline replay parity;
16. mainnet current-state parity;
17. complete account coverage;
18. simulator-engine integration;
19. corrected priority-fee distribution;
20. corrected cost/viability surface;
21. same-family entry/mark proof;
22. shadow completeness and lag;
23. Pump/PumpSwap facts;
24. WSS trigger result;
25. cohort counts;
26. valid structural development count;
27. valid simulated development count;
28. valid confirmatory count;
29. every unresolved blocker;
30. exact operator actions;
31. exact run/monitor/stop commands;
32. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_SIMULATION_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

The expected honest next milestone is usually:

```text
VALID_DEVELOPMENT_SIMULATION_RUNNING
```

Do not call one successful transfer, exact fee parity, one successful swap simulation, or a fresh development window profitability evidence.

Do not run canary or live. Do not fund a wallet.
