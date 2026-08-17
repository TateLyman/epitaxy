# CLAUDE CODE DIRECTIVE — EPITAXY `29c7cc7`: TURN THE PROOF HARNESS INTO A RUNNING PROFIT EXPERIMENT

**Repository:** `TateLyman/epitaxy`  
**Audited remote head:** `29c7cc7f086b9be5c21445fabd84f47794251857`  
**Previous audited head:** `1c499cdf0d2b5381f31e1ffe842eb32d16101846`  
**Date:** 2026-08-14 America/Chicago  
**Honest starting state:** `MEASUREMENT_REPAIR_REQUIRED`

Execute this directive. Do not merely return a plan.

The last implementation added several valuable components:

- a persistent LiteSVM serve mode;
- a one-pass buy → observe → build sell → execute sell path;
- coherent snapshot scaffolding;
- a canonical trajectory settlement type;
- confirmed-migration tables;
- prospective sampling and policy modules;
- cashback and fee-tier decoders;
- vault-watch and risk-fact modules;
- confirmatory contract types.

The implementation then made the same mistake this project has made repeatedly:

```text
component exists
+ proof script completed
+ tests pass
≠
the running collector produces the claimed economic evidence
```

At `29c7cc7`, the actual command:

```bash
pnpm trajectory:collect
```

still ends by printing:

```text
NOT OPENING TRAJECTORIES: the one-pass sequential worker (P3) is not built.
```

The worker now exists, but the collector was never updated. The database still has zero settled development trajectories. The “20 completed trajectories” are immediate round trips in `scripts/live-one-pass-trajectory.ts` and `artifacts/live-one-pass-trajectory.json`, not collector-driven, later-marked, policy-evaluated database trajectories.

The independent audit also ran without the operator corpus, RPC, `.env`, collector or WSL runtime. It correctly returned `MEASUREMENT_REPAIR_REQUIRED`; eight of fourteen runtime sections were not testable. Fixing its pure-code findings did not independently validate the twenty proof rows.

This directive has one goal:

```text
confirmed candidate
→ exact coherent account plan
→ direct PumpSwap entry
→ one persistent runtime
→ canonical entry settlement
→ shared later market path
→ exact first-valid fills
→ paired policy outcomes
→ append-only database rows
→ current clean artifacts
```

Do not broaden the platform again until that loop runs.

---

# NON-NEGOTIABLE SCOPE AND SAFETY

During this directive:

- do not fund a wallet;
- do not add, read or print a private key;
- do not sign;
- do not submit a transaction;
- do not start canary or live;
- do not add wash trading, fake volume, self-trading or market manipulation;
- do not loosen portfolio risk or inflate virtual NAV to manufacture trades;
- do not call a proof artifact, JIT leg, dirty artifact or immediate mechanics run profitable;
- do not use an LLM in the trading loop;
- do not fit or retune a policy on the same outcomes used to evaluate it;
- do not buy infrastructure from code;
- do not delete the operator’s corpus.

Development may construct exact unsigned transactions and execute them only in the isolated local runtime.

The only permitted final states are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_TRAJECTORY_KERNEL_RUNNING
DEVELOPMENT_EDGE_CANDIDATE
PUMP_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`LIVE_READY` is forbidden.

The expected next state is `VALID_TRAJECTORY_KERNEL_RUNNING`, but only if the actual collector writes current complete trajectories. Otherwise remain `MEASUREMENT_REPAIR_REQUIRED`.

---

# THE FINDINGS TO REPRODUCE BEFORE FIXING

Do not trust this list. Check every item against the local tree and live database.

## F1 — the collector is not a collector

`apps/collector/src/trajectory-collect.ts` discovers and snapshots candidates, then refuses to open them.

## F2 — status substitutes an artifact for database evidence

`scripts/trajectory-status.ts` reads `artifacts/live-one-pass-trajectory.json`, calls its immediate round trips “completed trajectories”, and reports zero `development_trajectories` rows as an intentional distinction.

A proof file is not the database.

## F3 — the terminal state is over-promoted

`docs/STATUS.md` claims:

```text
VALID_TRAJECTORY_KERNEL_RUNNING
20/20 complete
```

while:

- the collector writes no complete trajectory;
- the independent audit could not access those runs;
- no later market path was collected;
- no treatment was evaluated;
- no confirmatory contract is stamped.

## F4 — the live one-pass proof is not the primary direct path

`scripts/live-one-pass-trajectory.ts`:

- builds the BUY through Jupiter;
- uses the old `captureSnapshot`, not coherent snapshot v2;
- checks that the canonical base vault changed but does not prove the canonical pool was the sole entry venue;
- executes buy → sell → separate close;
- manually derives wallet economics;
- writes no canonical settlement;
- writes no trajectory row;
- has no later mark path.

It is useful `TRUE_IMMEDIATE_SEQUENTIAL_INSTRUMENT` evidence and nothing more.

## F5 — the immediate losses expose unmeasured setup accounts

The proof artifact contains repeated clusters near:

```text
-0.000509 SOL
-0.002547 SOL
-0.004333 SOL
-0.006372 SOL
```

yet reports zero created-account rent on every row.

The size surface reports only one created account while total drag is roughly 0.010–0.012 SOL. Therefore its observe set misses accounts the transaction created.

The warm cluster near 0.000509 SOL on a 0.02 SOL trade is about 254 bps and is consistent with bottom-tier venue mechanics plus network fees. The much larger clusters are likely cold account initialization. This must be measured account by account, not inferred.

## F6 — the size recommendation is invalid

The current surface:

- resets from a cold snapshot for every size;
- loses 0.02/0.04 SOL to worker output overflow;
- uses an incomplete account list;
- does not distinguish one-time wallet, creator, pool and mint setup;
- labels the residual a recurring mechanics floor;
- recommends size partly by amortizing costs another trader may already have paid.

A larger notional is not the right response to avoidable first-trader rent.

## F7 — the worker still crosses u64 through JavaScript numbers

The TypeScript worker and Rust NDJSON protocol serialize account lamports/rent epochs as JSON numbers. `toAccountInfo()` also converts bigint lamports to `Number` and hardcodes `rentEpoch = 0`.

## F8 — worker state leaks across jobs and output does not scale

In serve mode:

- `known` is not reset on `Init`;
- host `bytesSeen` is process-lifetime, not job-lifetime;
- full pre/post base64 bytes are emitted for every observed account;
- 0.02 SOL surface runs have exceeded ~280 MB and killed the worker;
- a failed `stdin.write` can leave the response queue misaligned.

## F9 — exact sysvars/features are not restored

The snapshot may record Clock/Rent/EpochSchedule, but the worker request does not restore all of them. Rust derives an approximate Clock/epoch from slot and does not bind feature activation.

## F10 — sequential success can coexist with incompleteness

A transaction can be `ok` while required accounts/programs were omitted or unobserved. The state-survival assertion compares only data hashes, not a complete account hash.

## F11 — fee-config decoding silently degrades

`quoteBuyFrom`, `quoteSellFrom` and `swapStateFrom` catch fee-config decoding errors and substitute `null`. Present-but-undecodable must refuse. “No dynamic fee config exists” and “the config exists but this build cannot decode it” are opposite facts.

## F12 — direct builder account plans are not frozen

The SDK may select a fee recipient and append different account sets. Build the instruction once and use its exact bytes/account plan for capture, simulation, fingerprinting and replay. Never rebuild and assume the same random/selected recipient.

## F13 — cashback economics are materially wrong

Current official Pump documentation states:

- cashback is credited only when the proper remaining accounts are appended;
- PumpSwap BUY expects the accumulator WSOL ATA at remaining account index 0;
- PumpSwap SELL expects that ATA at index 0 and the UserVolumeAccumulator PDA at index 1;
- otherwise the creator fee goes to the creator;
- PumpSwap cashback is held in the accumulator’s WSOL ATA.

The repository says SELL has no accumulator and models only one leg’s creator-fee recovery. Re-verify current official docs/IDL/SDK at execution time, but the current implementation conflicts with the official integration document.

## F14 — cashback is not wired into the transaction builder or settlement

The repo can derive accumulator accounts and produce a theoretical surface, but the actual sequential buy/sell path neither guarantees the remaining accounts nor measures accumulator ATA deltas per leg.

## F15 — the official fee tier is not quote reserve

Pump’s current fee documentation defines canonical tier by:

```text
current token price in SOL/USDC × 1,000,000,000 tokens
```

Do not classify tier from raw quote reserve. Prefer the official SDK’s decoded/quoted tier and persist the fee-config hash and selected tier.

## F16 — canonical settlement double-counts and omits costs

`buildTrajectorySettlement()` currently:

- reports transfer fees but does not add them to `executionCostLamports`;
- adds leg execution cost, which already includes unrecovered rent, then adds `rentStillLockedLamports` again;
- can double-count failed attempts;
- hardcodes `unexplainedLamports = 0`;
- treats every unknown Token-2022 transfer fee as blocking rather than distinguishing `NOT_APPLICABLE`, `MEASURED` and `UNKNOWN`;
- does not require both legs to be complete, effect-valid and PnL-eligible.

## F17 — the trajectory repository can rewrite evidence

`INSERT OR REPLACE` and loosely bound settlement calls allow an outcome to be replaced. Evidence must be append-only, with exact foreign keys from trajectory → observation → worker job → settlement.

## F18 — the kernel is still a pure helper

`packages/pipeline/src/trajectory-kernel.ts` is not the running orchestrator. Neither the collector nor the paper engine drives the full lifecycle through it.

## F19 — policy modules are not treatments in production

Three entry and two exit functions exist, but no running shared market trajectory evaluates them. Immediate round trips cannot evaluate 15-minute or deterioration exits.

## F20 — future counterfactual state is unresolved

A hypothetical entry did not happen on mainnet. A later mainnet quote is not automatically the trajectory’s exact exit state.

Every future outcome must be:

```text
BOUNDED_COUNTERFACTUAL_TRAJECTORY
or
FULL_EVENT_REPLAY_TRAJECTORY
```

with a measured/calibrated error contract.

## F21 — default readiness is still the old gate

`pnpm readiness` still reads the old position view, includes fallback costs and historical structures, and does not use the new exact trajectory contract.

## F22 — several required commands are placeholders or aliases

Examples to verify:

```text
rate:budget-v2       → trajectory-status placeholder
reject:panel-v2      → trajectory-status placeholder
landed:parity-v2     → non-landed parity script
wss:status           → direct-signal status
trajectory:status    → old development status
readiness            → old position readiness
```

Every named command must either run its named capability or explicitly say `NOT_IMPLEMENTED` and exit non-zero.

## F23 — checked-in artifacts are stale

The checked-in release manifest and production call graph still identify dirty intermediate/older commits and null context. The release-manifest generator itself references older audit documents and old blockers.

## F24 — migration discovery is too delayed for the primary lane

The collector derives pools from old screenings and pages pool history to find creation. That is useful recovery, not a fast migration lane. Live confirmed transaction decoding should be primary.

---

# P0 — PRESERVE THE ACTUAL MACHINE

Before editing, reconcile the operator machine against remote head `29c7cc7`.

Run and persist:

```powershell
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -100
git diff
git diff --cached

node --version
pnpm --version

pnpm status
pnpm health
pnpm audit:state
pnpm trajectory:collect -- --discover-only --once
pnpm trajectory:status
pnpm readiness
pnpm release:manifest

wsl --status
wsl -l -v
```

Record:

- Windows engine/collector PIDs, start times, commands and cwd;
- WSL worker PID, executable path and SHA-256;
- exact local versus remote commit relationship;
- runtime database, WAL and SHM paths/sizes;
- disk free space;
- current schema and every version;
- current RPC/Jupiter host labels without URL query strings;
- endpoint quota/429 state;
- open position/shadow/trajectory exposure;
- simulation jobs by context/side/purpose/validity/effect;
- rows in every new trajectory, settlement, migration, policy, reject and contract table;
- current CI run and uploaded release manifest.

Stop new entries before backup. Keep exposure management active if any real or paper position holds tokens.

Take a verified WAL-consistent backup. Run against the backup:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

Persist path, bytes, SHA-256, table counts, max IDs/timestamps, exposure witness and read-back verification.

Create:

```text
docs/AUDIT_HEAD_29C7CC7.md
artifacts/baseline-29c7cc7.json
```

Commit the untouched baseline before semantic changes.

---

# P1 — RESET THE TRUTH LAYER

Immediately correct the state claim.

Until the collector itself writes valid complete trajectories:

```text
MEASUREMENT_REPAIR_REQUIRED
```

Classify `artifacts/live-one-pass-trajectory.json` as:

```text
TRUE_IMMEDIATE_SEQUENTIAL_INSTRUMENT
NOT A DEVELOPMENT TRAJECTORY
NOT A STRATEGY OUTCOME
```

Do not count it in:

- trajectory status;
- policy sample size;
- readiness;
- rate throughput;
- profitability;
- confirmatory evidence.

Invalidate or archive stale artifacts without deleting them. Every current artifact must bind:

```text
sourceCommit
dirty
contextHash
strategyVersion
kernelVersion
schemaVersion
workerBinaryHash
databaseSnapshotHash
generatedUtcMs
sampleInclusionQuery
```

The default report must refuse stale/dirty/null-context artifacts.

---

# P2 — ONE EXACT ACCOUNT PLAN PER LEG

The primary SOL canonical PumpSwap experiment must use direct PumpSwap on both legs.

Jupiter may remain:

```text
discovery
benchmark
fallback research lane
```

but not the primary direct mechanics lane.

For each leg:

1. Build the exact SDK instruction once.
2. Persist its raw instruction bytes and ordered account metas.
3. Persist selected fee recipient and quote ATA.
4. Persist cashback remaining accounts.
5. Resolve every ALT if present.
6. Derive every CPI program/programdata dependency.
7. Capture the exact account set that built bytes touch.
8. Execute those same bytes.
9. Fingerprint those exact bytes/accounts/program/config hashes.

No “rebuild later” path is permitted.

For the entry, prove the direct canonical pool is the sole venue:

```text
pool base-vault delta
pool quote-vault delta
taker token credit
fee-account deltas
```

must reconcile. Merely showing that the base vault changed is not enough for a split/routed Jupiter entry.

Present-but-undecodable pool, mint, fee config, recipient, cashback account, token extension or program must refuse.

---

# P3 — MAKE THE PERSISTENT WORKER EXACT AND SCALABLE

Change the NDJSON protocol so every u64/i64 value is a decimal string:

```text
lamports
rentEpoch
slot
unixTimestamp
token amounts
fees
CU values where relevant
```

No economic integer crosses JavaScript `Number`.

On every `Init`:

- replace the runtime;
- clear `known`;
- reset job output accounting;
- reset job identity;
- return a unique runtime-instance ID;
- fail if initialization has incompleteness on a required account/program/sysvar.

Restore exact captured:

```text
Clock
Rent
EpochSchedule
slot
unix timestamp
epoch
feature set / feature hash
programdata hashes
ALT bytes
```

Do not synthesize epoch from slot when exact state was captured.

State hashes must include:

```text
pubkey
present/absent
owner
lamports
executable
rent epoch
data
```

The sell quote state and sell pre-execution state must compare the exact same ordered required account set and the same runtime-instance ID.

Output scaling:

- return complete data only for explicitly requested economic accounts;
- return hashes, lamports and decoded deltas for the rest;
- store large blobs in the content-addressed blob store;
- impose per-command and per-job output budgets, not one process-lifetime total;
- allow on-demand fetch by account/hash;
- run 0.04 SOL surfaces without exceeding output limits.

Fix response-queue behavior on write error/timeout so one failed command cannot shift the next response onto the wrong promise.

---

# P4 — WIRE THE ACTUAL COLLECTOR

`pnpm trajectory:collect` must become the only authoritative development trajectory process.

Its real path:

```text
confirmed migration/current verified canonical pool
→ complete risk facts
→ exact direct buy build
→ coherent snapshot
→ one persistent runtime
→ direct buy
→ build direct sell from committed post-buy state
→ immediate mechanics settlement
→ append trajectory OPEN row
→ collect later common market path
→ evaluate every frozen policy
→ simulate/settle exact selected fills
→ append policy outcomes
→ close trajectory
```

Use `captureCoherentSnapshotV2`, not legacy `captureSnapshot`.

Use `SequentialWorker`, not the proof script.

Use `buildTrajectorySettlement`, after fixing it.

Use `TrajectoryKernel` as the production orchestrator, or remove the name and create one orchestrator that actually owns the lifecycle. A pure state helper is not a kernel.

The collector:

- owns no NAV;
- opens no capital-bearing `positions`;
- writes no live ledger;
- imports no signer/execution network sender;
- cannot run in canary/live;
- can run continuously and resume after restart;
- persists scheduler state and outstanding trajectories.

Add an end-to-end test that starts the actual collector dependencies on fixtures and proves a settled database trajectory. No source grep.

---

# P5 — FIX CANONICAL SETTLEMENT BEFORE COLLECTING OUTCOMES

Define explicit cost applicability:

```text
MEASURED
NOT_APPLICABLE
UNKNOWN
```

for:

```text
transfer fees
withheld fees
tips
cashback
rent
failed attempts
residuals
```

A Token-2022 mint with no transfer-fee extension is `NOT_APPLICABLE`, not unknown.

Canonical identities:

```text
entryCashOut
= actual payer cash decrease attributable to entry

exitCashIn
= actual payer cash increase attributable to exit
  + recoverable wallet-owned WSOL/token value

netPnl
= exitCashIn
  + cashbackClaimed
  - entryCashOut
  - cashbackClaimCost

executionCost
= base fees
  + priority fees
  + tips
  + measured transfer fees
  + actual failed-attempt fees
  + rent permanently unrecoverable
  + cashback claim cost
```

Do not add rent twice.

Do not count locked-but-wallet-owned value as spent.

Do not hardcode unexplained movement to zero. Derive and require:

```text
payer delta
= named trade flows
+ named fees
+ named rent
+ named cashback
+ unexplained
```

Both legs must be:

```text
runtime successful
effect valid
complete account coverage
PnL eligible
same frozen fingerprint
```

before net PnL exists.

One immutable settlement is written once and referenced by trajectory/policy/report/readiness. No fallback reconstruction.

---

# P6 — THE FASTEST MECHANICS WIN: DO NOT BE THE ACCOUNT-SETUP PAYER

This is the highest-priority empirical hypothesis.

The current artifacts suggest a warm 0.02 SOL round trip costs roughly 0.000509 SOL (~254 bps), while cold runs lose multiple millisol because they create protocol/recipient/creator/accumulator accounts.

Do not “solve” that by increasing notional.

For every exact built leg, compare all account metas against the pre-state. After execution, identify every account that changed from absent to present.

Persist for each created account:

```text
pubkey
owner
space
rent-exempt minimum
creating instruction
payer
close authority
recoverability
economic scope
```

Economic scope:

```text
WALLET_GLOBAL
WALLET_QUOTE_MINT
WALLET_TOKEN_MINT
CREATOR_GLOBAL
CREATOR_QUOTE_MINT
POOL_GLOBAL
POOL_QUOTE_MINT
MINT_SPECIFIC
TRANSACTION_ONLY
UNKNOWN
```

Produce three surfaces from the same original price state:

```text
COLD
PREWARMED_NON_PRICE_ACCOUNTS
REPEAT
```

The prewarmed surface may locally transplant only non-price-bearing accounts into the original coherent snapshot. It must not carry the first trade’s reserve changes.

Primary development sampling should require:

```text
no new non-user/non-recoverable account creation
```

or place the candidate in a separate cold-setup stratum.

This lets another organic transaction warm shared protocol accounts rather than the strategy paying their rent. Measure the opportunity cost of waiting.

Append the base token-account close to the sell transaction where valid. Do not spend a third signature/landing interval merely to recover its rent.

Measure actual compute and set CU limit to measured use plus a frozen margin. Solana charges priority fee against the requested CU limit.

---

# P7 — REPAIR AND EXPLOIT CASHBACK CORRECTLY

At execution time, re-read current primary sources:

```text
pump-fun/pump-public-docs/docs/PUMP_CASHBACK_README.md
pump-fun/pump-public-docs/docs/BREAKING_FEE_RECIPIENT.md
pump.fun/docs/fees
the installed @pump-fun/pump-swap-sdk IDL/source
```

Version-pin what was read.

For current official semantics, implement both legs:

```text
BUY remaining[0]
= UserVolumeAccumulator WSOL ATA

SELL remaining[0]
= UserVolumeAccumulator WSOL ATA

SELL remaining[1]
= UserVolumeAccumulator PDA
```

Fail closed if the pool is cashback-enabled and exact required accounts are absent or misplaced.

For each leg measure:

```text
accumulator WSOL ATA pre/post
UserVolumeAccumulator pre/post
creator vault pre/post
fee recipient pre/post
user wallet pre/post
```

Persist:

```text
cashback accrued on buy
cashback accrued on sell
cashback claimable
cashback claimed
claim transaction cost
one-time accumulator setup cost
```

Only claimed cashback enters realized PnL. Accrued/claimable may enter a separate economic-value view, never cash PnL.

Fix `claimIsWorthwhile`: amortization must change the allocated cost, not merely its explanation string.

## Highest-value strata

Current official SOL canonical fees imply these warm hypotheses:

```text
BOTTOM-TIER NONCASHBACK
~250 bps raw venue round trip before network/impact

BOTTOM-TIER CASHBACK
~190 bps retained venue round trip if both creator-fee legs are measured and claimable

>=420 SOL CANONICAL CASHBACK
~50 bps retained venue round trip because protocol + LP = 25 bps/leg
```

These are hypotheses to measure, not PnL claims.

Create two primary lanes:

```text
EARLY_WARM_BOTTOM_TIER_CASHBACK
HIGHER_TIER_WARM_CASHBACK_SURVIVOR
```

Keep separate:

```text
Mayhem/non-Mayhem
SOL/USDC quote
canonical/noncanonical
legacy/Token-2022
```

Do not expand to USDC or noncanonical execution until the SOL canonical collector works. Fingerprint the present scope.

---

# P8 — LIVE CONFIRMED MIGRATIONS, NOT HISTORY SCANS

The primary candidate path must react to current chain events:

```text
processed notification
→ transaction fetch
→ official discriminator/account-index/event decode
→ signature + event index identity
→ confirmed/finalized reconciliation
→ canonical pool verification
→ candidate queue
```

Store:

```text
mint
pool
base/quote vaults
creator
quote mint
cashback
Mayhem
slot
block time
commitment
programdata hash
fee-config hash
event index
```

A failed transaction is not a migration.

Two events in one transaction remain two rows.

Keep the history-paging scan only as recovery/backfill.

Do not parse identities from arbitrary base58-looking log strings.

---

# P9 — COLLECT ONE SHARED MARKET PATH, THEN EVALUATE POLICIES

Every sampled candidate generates one common path of direct executable marks at:

```text
1m
5m
15m
30m
60m
```

Primary entry policies:

```text
HARD_GATES_RANDOM
CORRECTED_CURRENT_QUALITY_SCORE
MIGRATION_LIQUIDITY_FLOW_CONTINUATION_V1
```

Primary exit policies:

```text
FIXED_15M_CONTROL
FLOW_LIQUIDITY_DETERIORATION_V1
```

No take-profit/stop/trail grid.

Every policy sees the same candidate and mark path. Store paired outcomes.

The flow challenger may use only pre-entry or contemporaneous facts:

```text
independent buyer persistence
non-Mayhem net quote inflow
effective quote reserve
executable exit capacity
creator/entity net selling
warm account state
fee/cashback tier
```

Do not count raw log volume as independent flow.

## Counterfactual future state

A paper entry was not on mainnet.

Support:

### `BOUNDED_COUNTERFACTUAL_TRAJECTORY`

Only when entry reserve ratios and a calibrated replay comparison keep approximation error below a frozen bound. Apply a conservative adverse haircut.

### `FULL_EVENT_REPLAY_TRAJECTORY`

Replay intervening settled pool events onto the local post-entry state in order.

Build full replay for a calibration subset. Do not call bounded mode confirmatory until its error is established against replay.

---

# P10 — RISK FACTS MUST REACH THE DECISION

Before policy evaluation, collect and persist:

```text
direct mint facts
Token-2022 extension applicability
current/future transfer fee
Mayhem mode/state/age
cashback mode/accounts
address concentration
entity-adjusted concentration
creator/entity flow
pool ownership/canonicality
warm-account completeness
```

Current Pump documentation publicly names a Mayhem agent wallet, program ID, 24-hour lifecycle and fee behavior. Version-pin these facts and exclude known agent flow from independent breadth.

When Mayhem flow cannot be isolated:

```text
breadth = CONTAMINATED_UNQUANTIFIED
```

not organic and not zero.

Wire entity-adjusted concentration into the actual entry policy. Paginate holder history far enough to justify “initial funder”; the oldest item in a capped newest page is not the first transaction.

---

# P11 — WATCH THE VAULTS IN THE RUNNING COLLECTOR

Subscribe to exact decoded:

```text
base vault token account
quote vault token account
pool state
fee config
cashback accumulator/ATA when relevant
```

Persist subscription addresses per trajectory.

A pool PDA must never enter the SPL-token balance decoder.

On material vault/reserve change:

```text
urgent queue
→ consumed before normal marks
→ exact direct observation
→ settlement if a policy triggers
```

On socket gap/reconnect:

```text
RPC resync
→ compare state hashes/reserves
→ restore coverage
```

`pnpm wss:status` must report actual session coverage, reconnects, gaps, subscriptions and urgent-queue consumption. It must not alias another status script.

---

# P12 — COMMANDS, ARTIFACTS AND READINESS MUST MEAN THEIR NAMES

Give every command one owner and one output.

Required:

```bash
pnpm audit:state
pnpm snapshot:coherent-proof
pnpm worker:sequential-proof
pnpm trajectory:collect
pnpm trajectory:status
pnpm trajectory:kernel-proof
pnpm settlement:check
pnpm ledger:identity
pnpm cashback:surface
pnpm size:trajectory-surface
pnpm pumpswap:parity-v3
pnpm landed:parity-v2
pnpm direct-signal:status
pnpm wss:status
pnpm cohort:status
pnpm exploration:status
pnpm reject:panel-v2
pnpm rate:budget-v2
pnpm replay
pnpm report
pnpm readiness
pnpm release:manifest
```

No placeholder aliases.

A not-yet-built command prints its exact missing prerequisite and exits non-zero.

`pnpm trajectory:status` reads only database trajectory rows from the current context.

`pnpm rate:budget-v2` reads actual active process intervals and actual resource counters.

`pnpm reject:panel-v2` reads prospective samples collected at rejection time.

`pnpm landed:parity-v2` compares actual landed direct swaps.

`pnpm readiness` becomes the one exact confirmatory trajectory gate. Retire the old position gate from the default command.

Store the confirmatory contract in the database before outcomes. Bind:

```text
source commit
kernel/worker versions
builder and exact fingerprint
notional
cohort/migration band
cashback policy
Mayhem policy
entry/exit policies
cost/rent treatment
counterfactual class
risk facts
```

No fallback costs. No unrelated simulation job can qualify a trajectory. Financial ratios remain exact decimal/rational until display.

A real canary is required for `CANARY_READY`; a positive development shadow is not a canary.

Regenerate current clean:

```text
production call graph
trajectory status
settlement identity
cashback surface
cold/warm size surface
parity
WSS status
cohort/exploration status
prospective reject panel
rate budget
readiness
release manifest
```

after the final clean commit and against a verified database snapshot.

---

# P13 — MEASURE THE REAL BOTTLENECK

Instrument active collector intervals, not wall time including downtime.

Count:

```text
confirmed migrations
candidate decode
coherent snapshots
direct builds
worker init/steps/bytes
complete immediate mechanics
opened trajectories
marks
policy fills
settled trajectories
RPC by method
Jupiter by endpoint
WSS events/bytes
DB writes
429/quota failures
```

Report P50/P95:

```text
migration notice lag
confirmation lag
snapshot lag
worker lag
mark lag
trigger→fill lag
queue lag
```

A label is one complete trajectory/policy outcome, not one successful leg.

Do not recommend Jupiter Developer until 1 RPS is shown to reduce complete trajectory throughput. Higher Jupiter plans use the same data freshness; they primarily increase rate.

A Helius Developer plan may be justified if the operator’s current RPC quota is actually exhausted after batching and caching. It currently offers substantially more credits/RPS than Free and directly helps coherent snapshots, transaction history and entity reads. The code may report the recommendation but may not purchase or expose credentials.

Do not recommend Shreds, dedicated nodes, colocation, archival infrastructure or Business-tier streaming before an untouched positive edge.

---

# P14 — START THE FIRST CLEAN DEVELOPMENT WINDOW

After all apparatus and wiring tests pass:

1. Commit a clean collector build.
2. Stamp the exact context and database snapshot.
3. Start the actual development collector.
4. Do not change policy, size, features or thresholds inside the window.
5. Persist every refusal and apparatus failure.
6. Run long enough to close paths at 60 minutes.

Initial allocation should prioritize the least complete cells among:

```text
migration age
cashback
Mayhem
fee tier
warm/cold state
entry policy
exit policy
```

but all policies are evaluated on shared paths, so do not split one path unnecessarily.

Checkpoint:

```text
10 paths/cell  apparatus sanity
25 paths/cell  cost/fillability sanity
50 paths/cell  early elimination
100 paths/policy-cohort  development selection permitted
```

Do not fit a model before at least 100 complete valid paths and an untouched validation split.

---

# REQUIRED TESTS AND MUTATIONS

Add behavioral integration tests that fail against `29c7cc7` for at least:

1. `trajectory:collect` writes a database trajectory.
2. The collector reaches the persistent worker.
3. The collector reaches canonical settlement.
4. A proof artifact cannot increase DB trajectory count.
5. State promotion requires current DB rows.
6. BUY is direct PumpSwap in the primary lane.
7. Pool vault deltas reconcile to taker credit.
8. A split/routed entry is rejected from direct evidence.
9. Built transaction bytes are reused exactly.
10. Fee recipient/account selection cannot change between capture and execution.
11. Every u64 is a decimal string across NDJSON.
12. `known` resets on worker `Init`.
13. job output accounting resets on `Init`.
14. write error cannot shift responses.
15. exact Clock/Rent/EpochSchedule are restored.
16. required initialization incompleteness refuses.
17. sell quote state equals sell pre-execution full account hash.
18. owner/lamports/data mutation breaks state equality.
19. worker 0.04 SOL run stays below output bound.
20. fee config present-but-undecodable refuses.
21. transfer fee `NOT_APPLICABLE` is not unknown.
22. transfer fee appears once in execution cost.
23. rent appears once in execution cost.
24. failed-attempt cost appears once.
25. unexplained movement is derived.
26. incomplete/effect-invalid leg blocks PnL.
27. evidence rows cannot be replaced.
28. settlement IDs are exact foreign keys.
29. every created account is observed.
30. created accounts are classified by scope/recoverability.
31. warm surface removes only non-price state.
32. primary warm gate refuses shared account creation.
33. base ATA close is in the sell when valid.
34. cashback BUY account placement is exact.
35. cashback SELL account placement is exact.
36. omitted cashback accounts receive zero attribution.
37. buy and sell accumulator deltas are measured separately.
38. claimable is not claimed cash.
39. claim amortization changes allocated economics.
40. fee tier matches official SDK selection, not quote reserve.
41. failed migration transaction is excluded.
42. two events in one transaction remain distinct.
43. current live migration enters queue without history paging.
44. every policy sees the same path.
45. the three entry policies differ on counterexamples.
46. the two exit policies differ on a shared path.
47. later selected observation equals simulated/settled/booked observation.
48. bounded counterfactual has an error bound/haircut.
49. full replay applies intervening events in order.
50. Mayhem agent flow is excluded from independent breadth.
51. entity-adjusted concentration reaches entry policy.
52. vault WSS watches vaults, not the pool PDA.
53. urgent queue is consumed.
54. restart resumes open trajectories.
55. exploration entitlement survives restart.
56. active-time rate is not wall-time rate.
57. placeholder command aliases fail.
58. stale/dirty/null-context artifact cannot authorize readiness.
59. default readiness reads the exact trajectory contract.
60. 200 losing trajectories cannot pass.
61. no private-key/signer/network-send path is reachable from collector.
62. canary/live remain blocked.

Mutation tests must kill the wiring, not merely pure functions.

---

# REQUIRED OUTPUTS

Create/update:

```text
docs/AUDIT_HEAD_29C7CC7.md
docs/29C7CC7_TRUTH_RESET.md
docs/RUNNING_TRAJECTORY_COLLECTOR.md
docs/EXACT_PUMPSWAP_ACCOUNT_PLAN.md
docs/COLD_WARM_SETUP_ECONOMICS.md
docs/PUMPSWAP_CASHBACK_V2.md
docs/FUTURE_COUNTERFACTUAL_CALIBRATION.md
docs/DEVELOPMENT_WINDOW_V1.md
docs/CONFIRMATORY_TRAJECTORIES_V2.md
docs/MULTIPLE_TESTING_LEDGER.csv
docs/FAILURE_REGISTER.csv

artifacts/baseline-29c7cc7.json
artifacts/collector-call-graph.json
artifacts/worker-exactness.json
artifacts/account-plan-proof.json
artifacts/cold-warm-size-surface.json
artifacts/cashback-both-legs.json
artifacts/trajectory-status.json
artifacts/settlement-identity.json
artifacts/pumpswap-parity-v3.json
artifacts/landed-parity-v2.json
artifacts/wss-status.json
artifacts/cohort-status.json
artifacts/exploration-status.json
artifacts/reject-panel-v2.json
artifacts/rate-budget-v2.json
artifacts/readiness.json
artifacts/release-manifest.json
```

---

# FINAL REPORT AND STATE GATE

Report:

1. starting/ending SHA;
2. local/remote difference;
3. backup proof;
4. corrected invalid claims;
5. exact collector production call path;
6. direct entry attribution;
7. coherent snapshot proof;
8. exact worker/sysvar/u64 proof;
9. output scaling;
10. cold/warm/repeat account economics;
11. every created account and owner;
12. cashback on buy and sell;
13. fee tier and retained floor;
14. canonical settlement identity;
15. database trajectory trace;
16. later shared market path;
17. paired policy outcomes;
18. counterfactual evidence class/error;
19. WSS/risk-fact coverage;
20. actual completed trajectories by cell;
21. active throughput and bottleneck;
22. infrastructure recommendation;
23. every unresolved blocker;
24. exact collection commands;
25. one terminal state only.

`VALID_TRAJECTORY_KERNEL_RUNNING` requires all of:

```text
actual pnpm trajectory:collect process
→ current confirmed candidate
→ coherent snapshot
→ exact direct entry
→ persistent runtime mechanics
→ canonical entry settlement
→ later common mark path
→ exact first-valid policy fill
→ canonical exit settlement
→ append-only database trajectory
→ current clean report reads that row
```

A proof script does not qualify.

`DEVELOPMENT_EDGE_CANDIDATE` requires at least:

```text
100 valid complete paths in a preregistered policy/cohort
positive all-cost net and expected log growth
positive without top 3
positive under prescribed stress
untouched validation subset
```

`PUMP_CONFIRMATORY_COLLECTION_STARTED` requires a selected development arm and a database-stamped untouched contract before its first outcome.

`CANARY_READY` requires an untouched passing confirmatory window and an actual safe canary execution path. It cannot be awarded by development shadows.

If the collector still does not settle current rows, finish at:

```text
MEASUREMENT_REPAIR_REQUIRED
```
