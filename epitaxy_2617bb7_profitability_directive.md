# CLAUDE CODE DIRECTIVE — EPITAXY 2617BB7: TURN THE LAB INTO A VALID PROFIT TEST

**Repository:** `TateLyman/epitaxy`  
**Audited GitHub branch:** `master`  
**Audited GitHub HEAD:** `2617bb7b8d3e16502cd5d4c4b08e9543dca6b887`  
**Date:** 2026-08-13  
**Operator eligibility:** the operator is 18 and legally able to trade. Age is not a blocker.  
**Current honest evidence state:** no demonstrated positive executable expectancy  
**Permitted during this directive:** observe, structural development, simulated development, confirmatory collection only after every gate below passes  
**Forbidden during this directive:** funding a wallet, signing or submitting trades, running canary/live before the machine-generated readiness gate passes, weakening gates to manufacture trades, or describing development returns as profit

Execute the work. Do not merely return a plan.

The goal is the fastest truthful route to maximum net profitability. The fastest route is not more scaffolding. It is:

1. determine whether the current 13/13 simulation split is an instrument artifact;
2. repair simulation so a buy and a sell are funded with the assets they actually spend;
3. verify economic effects, not merely `err == null`;
4. make entry, every decision-bearing mark and exit one execution family;
5. make every cost and risk calculation use one implementation;
6. establish Pump/PumpSwap capability first instead of solving every Jupiter venue;
7. collect fixed-size, same-family, simulated outcomes in parallel age cohorts;
8. select one strategy on development data;
9. give it one untouched confirmatory window;
10. permit a microscopic canary only if profitability and engineering gates both pass.

The only permitted final states are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_LABELS_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`LIVE_READY` is not a permitted result from this session. Live promotion requires completed real canary round trips.

---

# P0 — PRESERVE THE ACTUAL LOCAL STATE

The connected audit sees committed GitHub. It does not see uncommitted Windows changes, the live SQLite/WAL files, or the current WSL process.

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
pnpm dev:status -- --mode=paper
wsl --status
wsl -l -v
```

Record:

- Windows repo path;
- starting SHA;
- whether local work is ahead/behind/dirty relative to `2617bb7`;
- current engine PID/start command;
- current WSL daemon PID/start command;
- current simulator identity;
- database, WAL and SHM paths;
- current context/config/risk/schema/engine/adapter/accounting/simulator hashes;
- every nonclosed position with nonzero token balance;
- every open or blocked shadow;
- current simulation jobs by side, purpose, status and error;
- latest observation/mark/simulation;
- current API rate budgets;
- free disk on Windows and WSL;
- latest CI result;
- ruleset state;
- repository visibility.

If any portfolio position has tokens:

```text
HALT_NEW_ENTRIES
keep exit management active
do not change that position's economic policy
preserve it as development-only
```

Take a WAL-consistent backup using `VACUUM INTO` or the online backup API.

Run:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Save SHA-256, sizes, table counts, max IDs/timestamps and read-back verification.

Create:

```text
docs/AUDIT_HEAD_2617BB7.md
```

Commit the untouched baseline before semantic changes.

---

# P1 — EXPLAIN THE 13 PASS / 13 FAIL SPLIT FIRST

Current committed status reports:

```text
26 simulation jobs
13 SIMULATED_OK
13 SIMULATION_FAILED
0 unknown
```

Before changing anything, produce the exact table:

```sql
SELECT
  o.side,
  o.purpose,
  s.mode,
  s.status,
  s.transaction_error,
  COUNT(*) AS n
FROM simulation_jobs s
LEFT JOIN execution_observations o
  ON o.observation_id = s.execution_observation_id
GROUP BY 1,2,3,4,5
ORDER BY 1,2,4,5;
```

Also print, for every failed job:

- mint;
- side;
- purpose;
- requested amount;
- route labels/programs;
- exact transaction hash;
- transaction error;
- first failing instruction;
- relevant logs;
- balance mutations supplied;
- asserted bounds;
- account/snapshot coverage;
- token program;
- token amount;
- whether the taker was given the input asset.

## The hypothesis to test

`simulateObservation()` currently constructs every job with:

```text
requestedAmount = 0
one SOL balance mutation
no token balance mutation
no output-token or output-SOL economic bound
```

`openShadowBooks()` submits a buy and then a sell for every episode.

Therefore the exact 13/13 split may simply be:

```text
13 buys succeed because the taker was funded with SOL
13 sells fail because the taker was never given the hypothetical token
```

This is a hypothesis, not a conclusion. Prove or falsify it from the database.

Classify every failure:

```text
SELL_INPUT_NOT_PROVISIONED
BUY_INPUT_NOT_PROVISIONED
UNSAFE_AMOUNT_REJECTED
MISSING_ACCOUNT
MISSING_PROGRAM_OR_ELF
LOOKUP_TABLE_FAILURE
SLOT_OR_CLOCK_FAILURE
TRANSACTION_ASSEMBLY_DEFECT
POLICY_REFUSAL
ECONOMIC_BOUNDS_VIOLATION
ACTUAL_PROGRAM_REJECTION
SIMULATOR_RUNTIME_DEFECT
UNKNOWN
```

If the split is caused by missing sell inventory or another instrument defect:

- close the current simulation context;
- preserve all rows;
- mark them `INSTRUMENT_DEVELOPMENT`;
- do not count the 13 failures as route failures or token outcomes;
- write `docs/2617BB7_SIMULATION_WINDOW_INVALIDATION.md`.

No threshold may be tuned from that window.

---

# P2 — SIMULATE THE LEG THAT ACTUALLY EXISTS

Refactor `SimulateOptions` and `simulateObservation()` so the request describes the economic leg.

Every request must carry:

```text
side
input mint
output mint
exact input amount
input token program
output token program
fee payer
input account
output account
expected output
minimum output
maximum input debit
maximum total SOL spend
expected account creation/cleanup
route family
observation ID
exact transaction hash
```

Never set `requestedAmount` to zero.

## Buy setup

For a SOL-input buy:

- fund the taker with enough SOL for exact input, fee, tip and rent;
- preserve whether each ATA existed before the transaction;
- do not pre-create an ATA that the transaction is supposed to create;
- use the correct legacy Token or Token-2022 program;
- verify exact SOL debit and base-token credit.

Required bounds:

```text
input SOL debit <= exact configured maximum
base-token credit >= minimumOutput
base-token credit <= a frozen upper tolerance around expectedOutput
no unexpected token debit
no unexpected recipient
no unexpected lamport transfer
```

## Sell setup

For a token-input sell:

- fund the taker's correct input token account with exactly the hypothetical position balance;
- fund enough SOL for transaction fees;
- preserve Token versus Token-2022;
- preserve transfer-fee and withheld-fee state;
- verify exact token debit and SOL credit.

Required bounds:

```text
token debit == intended full-balance sell, subject only to documented transfer-fee semantics
SOL credit >= minimumOutput minus separately identified transaction costs
no unexpected token retained unless explained
no unexpected token recipient
no unexpected lamport transfer
```

## Bigint path

Fresh memecoin balances can exceed JavaScript's safe integer range.

Do not use the Surfpool convenience methods that accept `number` for token atoms.

Use Surfpool's typed cheatcode RPC/transport for bigint-safe:

```text
surfnet_setTokenAccount
surfnet_setAccount
```

or an equivalently exact route.

If any required mutation cannot be represented exactly:

```text
SIMULATOR_UNAVAILABLE_UNSAFE_AMOUNT
```

Never round.

Test:

```text
2^53 - 1
2^53
10^18 token atoms
u64 boundary-shaped values
legacy Token
Token-2022
```

---

# P3 — `SIMULATED_OK` MUST MEAN ECONOMIC EFFECT OK

A Solana runtime returning no transaction error does not prove the intended trade happened.

Create an effect-verification result separate from runtime execution:

```text
RUNTIME_OK
EFFECT_OK
FEE_DECOMPOSITION_OK
ACCOUNT_COVERAGE_OK
```

Only all four yield:

```text
SIMULATED_EFFECT_OK
```

Persist:

- pre/post SOL balances;
- pre/post token balances;
- exact input debit;
- exact output credit;
- base fee;
- priority fee;
- broadcaster tip;
- rent created;
- rent recovered;
- transfer fee;
- withheld fee;
- created accounts;
- closed accounts;
- every mutated writable account;
- unexpected movement;
- bounds violations;
- complete-account-coverage flag.

Required refusal:

```text
runtime succeeds but output delta is missing
runtime succeeds but output is below minimum
runtime succeeds but input debit exceeds maximum
runtime succeeds but an unexpected writable receives value
runtime succeeds but any writable account was unobserved
```

`legIsExecutable()` must require `SIMULATED_EFFECT_OK`, not merely `SIMULATED_OK`.

Keep development JIT separate from reproducible offline simulation.

---

# P4 — CURRENT-ROUTE JIT → FROZEN OFFLINE REPLAY

Do not wait for historical archival state to begin validating current routes.

For each current exact route:

1. assemble and persist exact bytes;
2. JIT-simulate;
3. export the pre-transaction state from the same Surfnet;
4. capture every static and ALT-loaded account;
5. capture each invoked program, ProgramData account, ELF and upgrade authority;
6. persist source-slot information or a bounded source-slot interval;
7. stop the JIT instance;
8. create a fresh offline Surfnet;
9. restore the frozen state and program code;
10. apply the same hypothetical balances;
11. replay the same exact transaction;
12. compare JIT and offline economic effects.

Required parity:

```text
same success/failure
same intended token/SOL deltas
same error and failing instruction when failed
same created/closed accounts
same fees
same rent
same bounds outcome
units consumed within frozen tolerance
no omitted writable account
```

Jupiter often omits `contextSlot`. Do not fabricate one.

When exact same-slot truth is unavailable, record:

```text
build requested slot interval
account capture slot interval
simulation target slot
maximum observed drift
```

A later-state simulation can model decision latency, but must not be called same-slot truth.

---

# P5 — CAPABILITY STRATA, PUMP FIRST

Do not hold the entire project hostage to arbitrary AMMs.

Create a capability fingerprint for each observation:

```text
route labels
top-level programs
CPI programs found in logs
lookup tables
token programs
programdata hashes
simulator runtime/feature set
```

A route is eligible for a given evidence class only if its fingerprint has passed parity.

Prioritise:

```text
1. Pump bonding curve
2. PumpSwap canonical pool
3. only then the next venue by observed opportunity share
```

The existing failed offline parity route on a stable pair through Byreal does not decide whether Pump routes can be simulated.

Create:

```text
artifacts/capability-matrix.json
```

with:

```text
fingerprint
observations
JIT results
offline results
effect parity
supported evidence class
failure reason
```

A Pump-only valid development window may begin while unsupported venues remain structural-only.

---

# P6 — FIX PUMP AND PUMPSWAP MATH AGAINST OFFICIAL SOURCES

Use only current official Pump sources as the primary oracle:

```text
pump-fun/pump-public-docs
official IDLs:
  idl/pump.json
  idl/pump_amm.json
  idl/pump_fees.json
official @pump-fun/pump-sdk
official @pump-fun/pump-swap-sdk
```

Fingerprint their source commit/version into provenance.

## Bonding curve

The current Epitaxy quoter is constant-product only and omits current fees.

Implement:

- legacy and V2 account layouts;
- SOL and USDC quote mints;
- Token and Token-2022;
- real and virtual reserves;
- real-token capacity;
- current protocol/creator/buyback fees;
- Mayhem fee-recipient rules;
- `buy_v2`, `sell_v2`, and current account set;
- exact rounding.

Do not hard-code a historical fee field when current fee configuration is on-chain.

## PumpSwap

Implement current canonical-pool:

- pool and vault decoding;
- base/quote orientation;
- SOL and USDC variants;
- market-cap-dependent fee tier;
- creator/protocol/LP fee components;
- exact full-position sell quote;
- pool authority/canonical identity;
- migration state.

## Parity

For each program:

- compare Epitaxy math with official SDK;
- compare with current Jupiter BUILD_CUSTOM response;
- compare with settled on-chain swaps;
- compare exact transaction account/instruction layout with official IDL.

The existing 123–257 bps residual is not parity.

Do not declare direct Pump execution enabled until quoter and transaction builder both pass.

---

# P7 — FIX JUPITER BUILD COMPOSITION

Audit current `/build` transaction composition against current official docs.

Current code assembles roughly:

```text
compute
setup
swap
cleanup
other
```

and ignores `tipInstruction`.

Required work:

- determine the documented semantics of `otherInstructions`;
- preserve the API's intended ordering;
- ensure custom post-swap instructions precede cleanup;
- include cleanup last when required;
- include `tipInstruction` only for the route that requested it;
- never send a Jupiter `/submit` tip to another broadcaster;
- preserve exact instructions in the blob.

Differentially compile current real `/build` responses against the official Solana compiler and Jupiter example.

Test:

- setup;
- cleanup;
- other instructions;
- custom pre/post;
- tip instruction;
- zero/one/multiple ALTs;
- Token-2022;
- split route;
- Pump route.

---

# P8 — REFACTOR PAPER RUNTIME INTO TESTABLE CORE FUNCTIONS

The latest “system-level” tests read source strings and make false claims:

- the portfolio-entry test finds `shadow_entry_roundtrip` somewhere in `paper.ts`, but portfolio entry still does not require a sell;
- the mark test slices from `manageShadowBooks`, so it never tests `manageOpenPositions`, which still marks from `/order`.

Refactor:

```text
apps/engine/src/paper.ts        process shell only
apps/engine/src/paper-core.ts   importable behavior
```

Inject:

- route observer;
- simulator;
- clock;
- storage/repository;
- scheduler;
- accounting.

Behavioral tests must execute:

```text
portfolio entry
portfolio mark
portfolio exit
shadow entry
shadow mark
shadow exit
```

Delete source-substring tests for behavior.

A test must fail against the actual old implementation, not merely find a reassuring phrase.

---

# P9 — ONE FAMILY FOR PORTFOLIO ENTRY, MARK AND EXIT

## Portfolio entry

Before opening a portfolio position:

```text
exact BUILD_CUSTOM buy
→ policy
→ simulated economic effect
→ exact acquired token amount
→ immediate exact same-family sell
→ policy
→ simulated economic effect
→ complete round-trip economics
→ all entry/risk gates rerun
```

A buy without a verified sell is not a portfolio entry.

## Portfolio marks

`manageOpenPositions()` may not use `/order` as the decision-bearing mark.

Every mark that drives:

- stop;
- trail;
- take-profit;
- collapse;
- peak;
- NAV;
- counterfactual policy

must be:

```text
exact full-balance BUILD_CUSTOM sell
```

or an independently parity-proven direct Pump family.

`/order` remains a separately stored benchmark.

## Portfolio exit

Current exit BUILD_CUSTOM observation is tested for simulation without first being simulated.

Required:

```text
exit decision
→ exact BUILD_CUSTOM observation
→ simulate/effect verify
→ first later valid observation after frozen latency
→ close
```

If the exit cannot execute:

```text
EXIT_BLOCKED
token remains held
rent remains locked
exposure remains in NAV/risk
bounded retries continue
```

---

# P10 — SHADOW BOOKS THAT ACTUALLY MEASURE THE SIGNAL

Maintain:

```text
alpha_shadow
canary_shadow
portfolio_paper
```

Every eligible episode opens fixed alpha and canary shadows whether the portfolio accepts or refuses.

## Evidence classes

Each shadow carries:

```text
STRUCTURAL_ONLY
JIT_EFFECT_VALID
OFFLINE_REPRODUCIBLE
CONFIRMATORY
```

Never aggregate classes.

## Entry

A shadow may open structurally after exact buildable buy+sell.

A simulated-development shadow additionally requires:

```text
buy SIMULATED_EFFECT_OK
sell SIMULATED_EFFECT_OK
```

## Marks

Share one mark observation between books when:

```text
mint
token amount
family
context/time bucket
```

are identical.

Do not spend two API requests for one fact.

Every decision-bearing mark must be same-family.

Simulation policy:

- simulate every entry pair;
- simulate every potential exit trigger;
- simulate the first later fill observation;
- simulate WSS emergency alarms;
- simulate route/program/account-set changes;
- simulate a frozen random calibration subset of non-trigger marks.

## Exit

A shadow closes only on a later same-family, effect-valid observation for its evidence class.

If no executable observation exists:

```text
EXIT_BLOCKED
```

## Scheduling

Fix `nearTrigger()` to use the latest executable mark, not only peak value.

Implement:

```text
most urgent blocked
near-trigger by current value
most overdue
newer positions
```

If backlog exceeds the ability to maintain the frozen SLA:

- stop opening new shadows;
- report skipped episodes;
- do not silently degrade cadence.

---

# P11 — STATEFUL SIGNAL EPISODES

Current episode identity uses 15-minute wall-clock buckets. A continuously eligible token crossing a bucket boundary can become a fake second trade.

Create one global signal episode:

```text
starts when token transitions into eligibility
continues while eligibility remains continuous
provider outage does not end it
ends after frozen ineligibility duration/cooldown
new episode starts only after the reset condition
```

One episode may reference both books.

Database constraints:

```text
UNIQUE(book, signal_episode_id)
```

Persist:

- eligible transition;
- ineligible transition;
- reason;
- provider gap;
- cooldown completion.

---

# P12 — ONE ACCOUNTING IMPLEMENTATION

`packages/domain/src/accounting.ts` exists, but runtime portfolio and shadows still use legacy functions and ad hoc arithmetic.

Make one accounting module the sole source for:

```text
entry cash out
exit cash in
locked rent
realized cost
expected failed-attempt cost
actual failed-attempt cost
viability floor
portfolio PnL
shadow PnL
replay
report
canary reconciliation
```

Delete/deprecate the old alternatives.

## Required semantics

Entry:

```text
exact input
+ base fee
+ measured priority fee
+ route-specific tip
+ rent created
+ transfer fee not already embedded
+ explicit platform fee not already embedded
+ actual/expected failed-attempt cost
```

Exit:

```text
exact output
- base fee
- measured priority fee
- route-specific tip
- transfer fee not already embedded
- separate close fee only if separate transaction required
- actual/expected failed-attempt cost
+ rent actually recoverable
```

ATA rent is locked capital while open.

A close in the same exit transaction pays no second signature.

Unknown transfer/withheld fees cannot be zero in confirmatory data.

## Failure model

Replace one flat failed-attempt cost charged on every leg with:

```text
entry attempt count
entry landed failures and fees
exit attempt count
exit landed failures and fees
observed failure probability
upper-bound sensitivity
```

## Risk

Existing positions and proposed positions must use the same catastrophic-loss model.

Current code sizes the proposed trade at a 100% catastrophic floor but counts existing positions at the nominal stop distance. Fix that contradiction.

---

# P13 — DIRECT ON-CHAIN FACTS MUST ENTER THE DECISION

The repository now contains mint, entity, Pump and WSS modules. They are mostly not wired into `runCycle`.

Wire, in order:

1. direct mint/Token-2022 facts;
2. Pump/PumpSwap state;
3. Mayhem;
4. creator/Mayhem-agent inventory and net selling;
5. verified entity-adjusted concentration;
6. reserve/liquidity changes;
7. WSS risk alarms.

Before a simulated-development entry persist:

```text
mint/freeze authority
permanent delegate
default frozen
transfer hook
non-transferable
pausable
confidential extensions
current/future transfer fee
withheld fee authority/amount
unknown extensions
quote mint
Mayhem
```

Unknown money-critical behavior is a separate development cohort and a hard veto for canary/live.

## Holder/entity classification

Use:

```text
WALLET
VERIFIED_PROGRAM_CONTROLLED
UNKNOWN
```

Only exclude inventory after venue-specific semantic verification.

Build:

- creator holdings/history;
- first 10/20 buyers;
- common initial funder;
- same-transaction co-purchase;
- synchronized buyers;
- shared fee payer;
- transfer graph;
- entity-adjusted top 1/5/10/20;
- creator/cluster net selling;
- real SOL inflow;
- holder/maker persistence;
- wash-like round trips.

---

# P14 — FIX WSS BEFORE USING IT AS AN ALARM

Current account watcher issues to fix:

- slot gaps between account changes are not automatically missed updates;
- hash must include account data, owner, lamports and context—not only length;
- `error` and `close` must not start two reconnect loops;
- `unwatch` must send unsubscribe;
- source gaps must be reconciled;
- vault reserve is the token account's token amount, not its lamports.

Implement a reconnect state machine with subscription IDs and epochs.

Decode venue-specific reserve changes.

On a material state change:

```text
enqueue an emergency same-family exact sell observation
```

Raw account state is an alarm, not a fill price, until direct quoter parity passes.

---

# P15 — AGE COHORTS MUST ACTUALLY BE COLLECTED

Defining cohort names is not enough.

Retain and mature candidates for seven days.

Run separate fixed-shadow cohorts:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

Same:

- notional;
- route family;
- accounting;
- features;
- exit policies;
- evidence class.

Do not pool.

Mayhem status is essential inside 24 hours.

A cohort selected on development data gets one untouched future window.

The question is empirical:

```text
Does early momentum survive manipulation and fees,
or does survivor momentum produce higher expected log growth?
```

---

# P16 — REJECT TRACKING WITH EXECUTABLE OUTCOMES

Provider disappearance is not a total loss.

For a stratified sample of rejected episodes, collect:

```text
same-family exact-size build
simulation/effect status
direct pool state
executable value
provider health
source gap
```

Persist inclusion probability.

Classify:

```text
EXECUTABLE_VALUE
NO_ROUTE_CONFIRMED
POOL_DRAIN_CONFIRMED
PROVIDER_MISSING
SOURCE_GAP
UNBUILDABLE
SIMULATION_UNAVAILABLE
UNKNOWN
```

This panel answers whether each gate removes losers or accidentally removes winners.

---

# P17 — FREEZE THE SCORE; FIX ONLY MATHEMATICAL DEFECTS

Do not tune the current hand-weighted score before valid labels exist.

Fix:

- missing unique/net buyers must remain unknown, not become gross buys;
- adding a zero-risk feature must not dilute existing soft risk;
- missing provider score must not be both a zero component and a second penalty;
- unknown must not silently satisfy a gate.

Use a non-dilutable risk aggregation such as:

```text
maximum primary risk + bounded secondary contribution
```

After valid labels exist, separate:

```text
catastrophic-loss probability
conditional expected log return
```

Start with calibrated logistic regression and simple tabular models.

A model must beat:

```text
hard gates only
current deterministic score
random contemporaneous eligible entries
```

on chronological untouched data.

No LLM in the trading loop.

---

# P18 — CANARY GATES MUST REQUIRE PROFITABILITY

Current `canaryEvidenceGates()` can pass after 200 losing trades and accepts development JIT rows because it checks only `simulation='SIMULATED_OK'`.

Replace it with a machine-generated readiness artifact.

A confirmatory trade requires:

```text
exact preregistered context
clean source SHA
supported capability fingerprint
entry and exit same family
entry and exit SIMULATED_EFFECT_OK
simulation_jobs.confirmatory = 1
complete account coverage
reproducible offline snapshot
all costs
no lifecycle defect
```

Canary eligibility requires all:

```text
>= 200 valid completed positions
>= 21 calendar days
positive net PnL
positive expected log growth
lower confidence boundary for expected log growth > 0
profit factor >= 1.25
maximum drawdown <= frozen threshold
CVaR/catastrophic-loss incidence <= frozen threshold
most recent 50 trades net positive
positive after top 1/3/5/10 trade removal
positive after best day removal
positive after best five mints removal
no trade > 10% of positive PnL
no day > 25% of positive PnL
positive under 2x costs
positive under latency/failure/rent stress
realizable portfolio positive
canary-size shadow positive
zero replay divergence
zero unresolved reconciliation
stable program/simulator fingerprints
```

Compare against:

```text
no trade
hold SOL
random eligible entries at same times
hard-gates-only baseline
current deterministic score
```

Track all tried cohorts, thresholds, policies, feature sets and models.

Report probability of backtest overfitting and deflated-performance diagnostics when sample size permits.

Do not weaken a failed gate.

---

# P19 — MICRO-CANARY DESIGN, BUT DO NOT FUND IT YET

The operator is 18 and legally eligible. Age is no longer a blocker.

Create the canary implementation and runbook only after `CANARY_READY`.

Canary:

```text
separate wallet
one open position
frozen exact notional
first 5 entries manual approval
maximum 1 attempted entry/day initially
no averaging down
no leverage
no martingale
daily loss cap
stop after one unexplained execution/effect mismatch
stop after one reconciliation uncertainty
stop after one unexpected partial/sliver outcome
```

Fund only enough for:

```text
one maximum canary position
+ rent
+ entry/exit fees
+ one failure
+ safety reserve
```

Do not fund during this directive.

At least 20 completed real canary round trips are implementation-fidelity evidence, not proof of profitability.

Live promotion requires:

- positive real net canary economics;
- modeled versus realized slippage agreement;
- no safety incidents;
- no unexplained failed attempt;
- a separate explicit promotion review.

---

# P20 — BROADCASTER BENCHMARK AFTER EDGE EXISTS

Do not buy infrastructure or optimise landing before positive corrected edge exists.

Later compare:

```text
ordinary dedicated RPC
Helius SWQOS-only
Helius Sender Max/default
Jupiter /submit
direct Jito
audited direct venue
```

For each:

- actual tip floor;
- priority fee;
- landing rate;
- latency;
- failed fees;
- complete wallet-to-wallet output;
- route survival;
- operational/security complexity.

Treat Helius SWQOS-only and Sender Max as separate products.

At a small canary size, high fixed tips can erase the edge.

No paid RPC, shreds, archival node or VPS until:

```text
profit lost to the measured bottleneck
>
cost of the upgrade
```

---

# P21 — RATE-BUDGET ROI

First remove duplicate observations and fix backlog admission.

Then measure:

```text
distinct positions due per second
p50/p95/max mark lag
eligible episodes skipped
build calls by purpose
429s
emergency-exit wait
```

The free Jupiter key is 1 RPS. The Developer plan is 10 RPS and changes rate only, not freshness or latency.

Create:

```text
docs/JUPITER_UPGRADE_ROI.md
```

Upgrade is justified only when the corrected system has:

```text
valid development labels
and
the 1 RPS limit is causing missed/freshness-invalid outcomes
and
the time/value gained exceeds $25/month
```

Do not create multiple accounts or keys to evade limits.

The current free Helius tier is sufficient for selective RPC/WSS until measured otherwise.

---

# P22 — PROVENANCE AND ARTIFACTS

Current provenance still misclassifies decision-bearing fields and carries stale semantic versions.

Include in an experiment/path hash:

```text
paperStart NAV
rate budgets that affect opportunity coverage
shadow mark budget
enrichment cadence
execution family
simulation/effect version
capability fingerprint
cohort
primary valuation
cost model
failure model
episode definition
WSS trigger definition
feature set
exit policies
```

Bump:

```text
PROVENANCE_VERSION
PAPER_ENGINE_VERSION
QUOTE_ADAPTER_VERSION
COST_ACCOUNTING_VERSION
SIMULATOR_VERSION
EFFECT_VERIFICATION_VERSION
```

`COST_ACCOUNTING_VERSION` must describe the code actually used at runtime.

Replace stale outputs:

```text
README.md
scripts/development-status.ts
scripts/capability.ts
scripts/release-manifest.ts
artifacts/development-status.json
artifacts/release-manifest.json
```

No hard-coded old blockers.

Reports must require `simulation_jobs.confirmatory=1` for confirmatory counts.

Never convert exact return/PnL sums through JavaScript `Number`.

---

# P23 — REPOSITORY SECURITY

The repository is currently public.

Do not commit:

```text
runtime DB
raw operational payload corpus
account snapshots/program ELFs
API endpoints
API keys
wallet paths
future private strategy parameters
signer material
```

Prepare exact operator instructions to:

```text
make the repo private
or
split public generic core from private strategy/runtime/ops
```

Do not change visibility without explicit operator approval.

Add CODEOWNERS and require one independent approving review for:

```text
signer
executor
risk
config
migrations
readiness gates
```

Current required approval count of zero is insufficient for capital code.

---

# P24 — TESTS THAT MUST FAIL AGAINST CURRENT HEAD

Add behavioral/mutation tests for at least:

1. all historical simulation jobs grouped by side/purpose/error;
2. sell simulation without token mutation fails setup validation before runtime;
3. sell simulation with exact token inventory succeeds on a fixture;
4. buy bounds verify token credit;
5. sell bounds verify SOL credit;
6. `requestedAmount=0` is refused;
7. runtime success with wrong output fails effect verification;
8. token amount over 2^53 is handled exactly through bigint RPC;
9. current 13/13 rows are not route-failure evidence if setup was invalid;
10. JIT → frozen offline parity on a supported Pump route;
11. unsupported route fingerprint stays structural-only;
12. current Pump fee-aware quote matches official SDK;
13. current PumpSwap tier quote matches official SDK;
14. Jupiter instruction order matches official composition;
15. tip instruction is route-specific;
16. portfolio entry cannot open without immediate sell;
17. portfolio entry buy and sell both require effect-valid simulation;
18. portfolio mark cannot call `/order`;
19. portfolio exit is simulated before executable check;
20. blocked exit stays in exposure/NAV/risk after restart;
21. accepted signal opens independent fixed alpha and canary shadows;
22. refused signal opens both shadows;
23. identical shadow books share entry and mark observations;
24. shadow trigger uses latest value, not peak;
25. overcapacity blocks new shadow admission;
26. episode crossing a 15-minute boundary does not duplicate;
27. provider outage does not end an episode;
28. unified accounting matches ledger deltas;
29. existing and proposed positions use same catastrophic loss model;
30. unknown transfer fee cannot become zero;
31. same-transaction ATA close has no second signature fee;
32. WSS compares decoded token reserve, not account lamports;
33. duplicate reconnect is impossible;
34. unwatch sends unsubscribe;
35. missing net buyers is unknown;
36. zero-risk feature cannot dilute risk;
37. cohort candidates mature for seven days;
38. rejected-provider disappearance is not -100%;
39. development JIT cannot pass canary gate;
40. 200 losing trades cannot pass canary gate;
41. positive PnL but top-winner-fragile corpus cannot pass;
42. stale artifact cannot pass readiness;
43. executor cannot start before machine-generated CANARY_READY;
44. live cannot start before completed positive canary evidence.

Replace source-substring assertions with executed behavior.

Run mutation tests against every repaired defect.

---

# P25 — REQUIRED OUTPUTS

Create/update:

```text
docs/AUDIT_HEAD_2617BB7.md
docs/2617BB7_SIMULATION_WINDOW_INVALIDATION.md
docs/SIMULATION_EFFECTS.md
docs/CAPABILITY_MATRIX.md
docs/PUMP_PUMPSWAP_PARITY.md
docs/SHADOW_EVIDENCE_CLASSES.md
docs/COHORT_EXPERIMENT.md
docs/JUPITER_UPGRADE_ROI.md
docs/CANARY_READINESS.md
docs/MULTIPLE_TESTING_LEDGER.csv
docs/FAILURE_REGISTER.csv

artifacts/simulation-failure-audit.json
artifacts/capability-matrix.json
artifacts/pump-parity.json
artifacts/cost-surface.json
artifacts/shadow-status.json
artifacts/cohort-status.json
artifacts/readiness.json
artifacts/release-manifest.json
```

Commands:

```bash
pnpm audit:state
pnpm simulation:audit
pnpm simulator:doctor
pnpm simulator:effect-parity
pnpm capability:matrix
pnpm pump:parity
pnpm shadow:development
pnpm shadow:status
pnpm cohort:status
pnpm reject:status
pnpm cost:surface
pnpm replay
pnpm report
pnpm readiness
pnpm release:manifest
```

Provide exact Windows commands to:

- start/stop Windows paper engine;
- start/stop WSL simulator;
- halt new entries;
- terminate when flat;
- run backup;
- inspect health;
- inspect simulation failures;
- monitor backlog.

Nothing automatically starts canary or live.

---

# P26 — FINAL REPORT

Report:

1. local starting and ending SHA;
2. local differences from audited GitHub;
3. backup path/hash/integrity;
4. exact 13/13 root cause;
5. rows invalidated and why;
6. simulation balance-mutation fix;
7. effect-verification proof;
8. Pump capability parity;
9. unsupported route fingerprints;
10. portfolio same-family proof;
11. portfolio immediate-sell proof;
12. shadow evidence classes/counts;
13. corrected accounting and cost surface;
14. corrected bankroll requirement by score/notional;
15. Pump/PumpSwap facts now used by eligibility;
16. WSS alarm proof;
17. age-cohort counts;
18. reject-panel counts;
19. corrected canary profitability gate;
20. CI and ruleset;
21. repository-visibility operator action;
22. current distinct-signal and mark-budget metrics;
23. whether the Jupiter Developer plan is now justified;
24. valid structural development trades/days;
25. valid JIT-effect trades/days;
26. valid offline-reproducible trades/days;
27. valid confirmatory trades/days;
28. every unresolved blocker;
29. exact commands to keep collection running;
30. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_DEVELOPMENT_LABELS_RUNNING
VALID_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

The likely honest next milestone is:

```text
VALID_DEVELOPMENT_LABELS_RUNNING
```

Do not output `CANARY_READY` because tests pass, 200 rows exist, or simulation says no runtime error. It means the strategy has positive, robust, all-cost, untouched confirmatory expected log growth and the complete canary loop is safe.
