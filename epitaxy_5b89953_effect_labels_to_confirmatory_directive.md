# CLAUDE CODE DIRECTIVE — EPITAXY 5B89953: EFFECT-CORRECT PUMP LABELS TO ONE UNTOUCHED PROFIT TEST

**Repository:** `TateLyman/epitaxy`  
**Audited committed `master`:** `5b89953e48f26c1f6eef35c990ae70100a0b68a7`  
**Date:** 2026-08-13  
**Operator:** 18 and legally able to trade  
**Current honest state:** measurement repair still required; no positive executable expectancy demonstrated  
**Current valid evidence:** zero effect-verified round trips; zero confirmatory trades  
**Allowed during this directive:** observe, structural development, JIT-effect development, offline-reproducible development, and confirmatory collection only after every required gate is machine-verified  
**Forbidden during this directive:** funding a wallet, signing or submitting a mainnet trade, running canary/live before `artifacts/readiness.json` says `CANARY_READY`, loosening risk or increasing virtual NAV to force trades, fitting thresholds to invalid data, or calling any development result profitable

Execute this work. Do not merely return a plan.

The objective is the shortest truthful path from the current laboratory to a strategy with positive, robust, all-cost expected log growth. The order matters:

1. make one Pump buy and one Pump sell produce correct economic effects;
2. make those same exact transactions replay reproducibly offline;
3. make the production paper process use the tested core rather than duplicated logic;
4. make entry, every decision-bearing mark, and every fill one coherent route family;
5. make one accounting and one evidence definition govern runtime, reports, research, and readiness;
6. wire only the on-chain facts most likely to prevent catastrophic Pump entries;
7. run four age cohorts under identical economics;
8. select one arm once on development data;
9. run one untouched confirmatory window;
10. permit a microscopic canary only if both profitability and engineering gates pass.

Do not spend this session building social sentiment, an LLM trader, first-block sniping, broad arbitrary-DEX support, expensive infrastructure, or machine-learning models. Those are downstream of trustworthy labels.

The only permitted final states are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_EFFECT_LABELS_RUNNING
PUMP_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`LIVE_READY` is forbidden. Live promotion requires completed real canary round trips in a later review.

---

# P0 — PRESERVE THE ACTUAL LOCAL MACHINE

GitHub shows committed `master`. It does not show the live Windows tree, SQLite/WAL files, current WSL daemon, current API state, or uncommitted repairs.

Before editing, print and save:

```powershell
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
pnpm window:status
pnpm simulation:audit
pnpm readiness
wsl --status
wsl -l -v
```

Record:

- exact Windows repo path;
- local HEAD and whether it differs from `5b89953e48f26c1f6eef35c990ae70100a0b68a7`;
- dirty/untracked files;
- Windows engine PID, start time, command and working directory;
- WSL simulator PID, distro, kernel, start time and command;
- current simulator identity;
- database/WAL/SHM paths;
- all context/config/risk/schema/engine/adapter/accounting/simulator/effect hashes;
- every nonclosed portfolio position with nonzero tokens;
- every open or blocked shadow position;
- simulation jobs grouped by validity, side, purpose, runtime status and effect status;
- the latest build, observation, mark, simulation and health event;
- Jupiter and RPC rate-budget state;
- disk space on Windows and WSL;
- latest CI result;
- GitHub ruleset;
- repository visibility.

If any portfolio position carries tokens:

```text
HALT_NEW_ENTRIES
keep exit management active
do not change the position’s economic policy
preserve it as development-only
```

Take a true WAL-consistent backup with `VACUUM INTO` or the SQLite online-backup API.

Run and save:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Persist backup SHA-256, size, table counts, maximum IDs/timestamps, nonterminal exposure and read-back integrity.

Create:

```text
docs/AUDIT_HEAD_5B89953.md
```

Commit the untouched baseline before semantic changes.

---

# P1 — CLOSE THE CURRENT EFFECT WINDOW

The current committed artifact contains:

```text
116 INSTRUMENT_DEVELOPMENT jobs
16 VALID_DEVELOPMENT jobs
0 effect-verified jobs
0 confirmatory trades
```

The current effect layer has newly identified semantic defects below. Therefore close every current context through the final repair commit as development of the instrument.

Create:

```text
docs/5B89953_EFFECT_WINDOW_INVALIDATION.md
```

Record:

- source commits and context hashes;
- exact start/end timestamps;
- simulations by side/purpose/runtime/effect;
- positions and shadows opened;
- marks and exits;
- each reason the window cannot estimate strategy expectancy;
- that no threshold, score weight, policy or cohort was selected from it.

Do not delete or rewrite rows.

Do not start a new evidence window until P2–P9 pass.

---

# P2 — FIX THE TOKEN-BALANCE IDENTITY MISMATCH

The current effect verifier looks up token balances by:

```text
owner:mint
```

The daemon currently serialises token balances by:

```text
token-account pubkey
```

That means a token account can change correctly while the effect verifier reports a missing or zero output.

Replace the ambiguous maps with a structured, canonical type:

```ts
interface ObservedTokenBalance {
  tokenAccount: string;
  owner: string;
  mint: string;
  tokenProgram: string;
  amount: string;
}
```

Simulation response must carry:

```text
preTokenAccounts[]
postTokenAccounts[]
```

Preserve token-account identity. Aggregate by `(owner, mint, tokenProgram)` only in one audited helper.

Required invariants:

- an absent token account is different from a zero-balance token account;
- a created ATA has no pre row and one post row;
- a closed ATA has one pre row and no post row;
- two token accounts for one owner/mint are summed only after both are observed;
- legacy Token and Token-2022 never collapse into one unidentified balance;
- a mint/program mismatch fails closed;
- raw token atoms remain decimal strings or bigint throughout.

Add a database migration if stored maps need replacement.

Mutation-test:

1. output ATA changes but map key is token-account pubkey;
2. owner/mint aggregation;
3. two accounts for one mint;
4. created ATA;
5. closed ATA;
6. legacy Token;
7. Token-2022;
8. absent versus zero.

No new development window may start until a known token transfer produces the correct structured delta.

---

# P3 — MAKE ECONOMIC BOUNDS ASSET-AWARE

The current request sends one generic:

```text
mint + minTokenDelta
```

for both token output and native-SOL output.

That is invalid for a token→SOL sell. The output is native lamports, not a WSOL ATA delta.

Replace `EconomicBounds` with explicit fields:

```ts
interface EconomicBounds {
  feePayer: string;

  inputAsset:
    | { kind: 'native_sol'; exactDebitLamports: string; maxTotalDebitLamports: string }
    | {
        kind: 'token';
        mint: string;
        tokenProgram: string;
        sourceTokenAccount: string;
        exactDebitAtoms: string;
      };

  outputAsset:
    | { kind: 'native_sol'; minCreditLamports: string; expectedCreditLamports: string | null }
    | {
        kind: 'token';
        mint: string;
        tokenProgram: string;
        destinationTokenAccount: string;
        minCreditAtoms: string;
        expectedCreditAtoms: string | null;
      };

  expectedRecipients: readonly string[];
  declaredTipLamports: string;
  allowedCreatedAccounts: readonly string[];
  allowedClosedAccounts: readonly string[];
}
```

The simulation request and request hash must additionally bind:

```text
side
input mint
output mint
input token program
output token program
exact source account
exact destination account
exact input
minimum output
expected output
route family
capability fingerprint
```

Never use `requestedAmount = 0`.

## Buy semantics

For SOL→token:

- fund exact sufficient SOL;
- preserve whether output ATA existed;
- measure native SOL debit separately from base/priority/tip/rent;
- verify token credit against minimum;
- verify token program and account owner;
- refuse unexpected output account or mint.

## Sell semantics

For token→SOL:

- create/fund the exact input token account with the exact hypothetical balance;
- fund SOL only for fees;
- verify exact token debit;
- verify native SOL credit;
- verify transfer-fee/withheld-fee semantics;
- verify residual token balance;
- verify whether ATA close is possible.

A native-SOL sell may never be checked through `minTokenDelta`.

---

# P4 — EXACT TOKEN PROVISIONING ABOVE 2^53

Ordinary fresh memecoin balances can exceed `Number.MAX_SAFE_INTEGER`.

The current Surfpool convenience API accepts JavaScript `number` for token amounts. Refusal is better than rounding, but it prevents ordinary positions from being simulated.

Implement one exact provisioning path, in this order:

## Option A — exact account bytes in the current daemon

Construct the token account bytes directly using a `u64` amount and call `setAccount` with the exact byte array. Preserve:

- mint;
- owner;
- amount;
- delegate/state/native/close-authority fields;
- Token-2022 account extensions required by the mint;
- rent-exempt lamports;
- token-program owner.

Verify the derived ATA matches the transaction account.

## Option B — Rust Surfpool worker

If exact Token-2022 account construction is materially safer in Rust, build a small WSL Rust worker pinned to the same Surfpool/Solana runtime versions.

It receives the immutable job from the daemon, runs one job, returns one result and exits.

## Option C — LiteSVM fallback

If Surfpool cannot support exact account/program restore safely, add a pinned Rust LiteSVM worker. LiteSVM supports raw program loading, arbitrary account writes and transaction simulation.

Do not replace the Windows engine or SQLite database. This is a simulator-worker implementation detail.

Tests:

```text
2^53 - 1
2^53
10^18 atoms
u64 max-shaped fixture
legacy token account
Token-2022 transfer-fee account
Token-2022 pausable account
```

No amount may be rounded.

---

# P5 — `SIMULATED_EFFECT_OK` MUST MEAN A COMPLETE ECONOMIC CONSERVATION CHECK

The current effect verifier must be strengthened.

## Runtime

Require:

```text
status == SIMULATED_OK
transactionError == null
```

## Input debit

Require exact debit under the leg’s frozen semantics.

A partial debit is not silently acceptable.

For native SOL:

```text
payer total delta
= swap input
+ base fee
+ priority fee
+ tip
+ created rent
- recovered rent
+ every other named transfer
```

For token input:

```text
exact token debit
subject only to explicitly decoded Token-2022 transfer-fee behavior
```

## Output credit

Require:

- output observed;
- output > 0;
- output >= minimum;
- output account/mint/program match;
- no unexplained residual or alternate recipient.

## Fee decomposition

The compute-budget bytes are the authoritative priority-fee calculation:

```text
ceil(unit_price_micro_lamports × applied_limit / 1_000_000)
```

The balance conservation check is independent corroboration.

Do not use a single `payer loss - others gained` equation for both buys and sells; a sell can increase the payer’s SOL balance.

Require:

```text
known base fee
known priority fee
known tip
known rent created/recovered
known transfer fee or explicit not-applicable
zero unexplained lamport residue
```

## Complete account coverage

Every static and ALT-loaded writable account must have:

```text
pre state
post state
owner
lamports
data hash
```

A 64-account truncation may be retained for debugging only.

For evidence:

```text
truncated == 0
unresolved lookups == 0
unobserved writable == 0
```

If one RPC simulation cannot return every account, use one of:

- direct post-state inspection from the local runtime;
- repeated deterministic replay from one frozen snapshot in account batches;
- Rust-worker access to the complete post-state.

## Unexpected value

Generate expected recipients from the exact instruction/route model:

- fee payer;
- user token accounts;
- pool/vault accounts;
- protocol/creator/buyback fee recipients;
- broadcaster tip account;
- rent recipients;
- cleanup account.

A recipient not in that model fails.

## Result

Only all four pass:

```text
RUNTIME_OK
EFFECT_OK
FEE_DECOMPOSITION_OK
ACCOUNT_COVERAGE_OK
```

Then and only then:

```text
SIMULATED_EFFECT_OK
```

---

# P6 — TEN LIVE PROOF CASES BEFORE ANY BROADER WORK

Do not continue broad strategy work until this proof exists.

Capture and simulate current, fresh, exact transactions:

```text
5 Pump/PumpSwap buys
5 Pump/PumpSwap sells
```

Coverage:

- at least one legacy SPL Token mint;
- at least one Token-2022 mint;
- at least one amount above 2^53;
- at least one native SOL output;
- at least one ATA creation;
- at least one pre-existing ATA;
- at least one transfer-fee or other nontrivial extension if encountered.

Each proof case must preserve:

- exact BUILD_CUSTOM response;
- exact unsigned transaction;
- exact lookup tables;
- exact JIT account/program snapshot;
- exact balance mutations;
- runtime result;
- effect verdict;
- fee conservation;
- every writable account;
- source-slot interval.

Required outcome:

```text
10/10 either:
  SIMULATED_EFFECT_OK
or
  a token/program/route-specific failure with a complete explanation

0 instrument/setup failures
0 missing-output artifacts
0 unsafe-number artifacts
```

Produce:

```text
artifacts/pump-effect-proof.json
docs/PUMP_EFFECT_PROOF.md
```

A failed real route is useful. A failed apparatus is not.

---

# P7 — PERSIST JIT SNAPSHOTS AND PROGRAM CODE DURABLY

The simulator response currently exports account/program state, but the Windows ledger must persist the exact artifacts.

Before marking a JIT job complete:

1. content-address and compress every account blob;
2. content-address every ELF;
3. persist program account, ProgramData, upgrade authority and hashes;
4. persist lookup-table account bytes and resolved addresses;
5. persist JIT execution slot;
6. persist every account-read context slot or bounded slot interval;
7. create a snapshot manifest;
8. store the manifest hash on the simulation job;
9. read back and verify all blobs.

A successful JIT job whose snapshot cannot be stored is:

```text
JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE
```

not offline evidence.

Do not call a later account read “the state at the build slot.”

When Jupiter omits `contextSlot`, store:

```text
build requested interval
build received interval
account capture slot interval
simulation slot
maximum observed drift
```

That is a latency-stressed experiment, not same-slot truth.

---

# P8 — UNBLOCK PUMP OFFLINE REPLAY WITHOUT BLOCKING THE DAEMON

The current offline Pump restore hangs because `net.deploy()` receives megabytes of ELF as a synchronous JavaScript `number[]` N-API argument on the HTTP request thread.

Try the cheapest fixes in order.

## Step 1 — content-addressed `.so` files + `soPath`

For each ELF:

- write it once under WSL Linux storage;
- verify SHA-256;
- deploy via `soPath`, not `soBytes: [...Buffer]`.

Do not marshal millions of JavaScript numbers.

## Step 2 — isolated child process per offline job

Run offline restore/simulation in a child process:

```text
HTTP daemon remains responsive
one immutable job file in
one immutable result file out
hard timeout
memory limit
child killed on timeout
```

The child may block internally without taking down health, JIT collection or the queue.

## Step 3 — Rust Surfpool worker

If `soPath` remains too slow or unstable, implement the worker in Rust against pinned `surfpool-sdk`.

## Step 4 — LiteSVM fallback

If Surfpool program restore still cannot reproduce Pump, use pinned LiteSVM for the offline replay worker.

Do not silently swap runtimes. Record runtime identity and require parity between:

```text
JIT Surfpool
offline candidate runtime
```

## Parity unit

Parity is per capability fingerprint:

```text
route labels
top-level programs
CPI programs
programdata hashes
instruction discriminators
token programs/extensions
simulator runtime/feature set
```

Do not use one global `EXECUTION_PARITY_ESTABLISHED` boolean.

A Pump fingerprint may become confirmatory while unsupported AMMs remain structural-only.

## Required Pump parity

At least:

```text
10 buy cases
10 sell cases
multiple mints
legacy + Token-2022
JIT and offline both effect-valid
same input/output deltas
same fee/rent semantics
same created/closed accounts
same result/error
compute drift <= frozen tolerance
```

Only then add that exact fingerprint to a reviewed confirmatory capability allowlist.

---

# P9 — MAKE THE TESTED CORE THE PRODUCTION PAPER ENGINE

`paper-core.ts` has behavioral tests, but `paper.ts` currently maintains separate decision logic.

Refactor:

```text
paper.ts       process shell, scheduling, dependency construction
paper-core.ts  the only entry/mark/exit/shadow behavior
```

`paper.ts` must call the core for:

- portfolio entry;
- portfolio mark;
- portfolio exit;
- shadow entry;
- shadow mark;
- shadow exit;
- blocked-exit retry.

Delete duplicated decision arithmetic from `paper.ts`.

Tests must execute the same functions the running process calls.

Add a test that fails when `paper.ts` does not import and invoke the core.

No source-substring test may be used as evidence of behavior.

---

# P10 — ONE FAMILY FROM ENTRY THROUGH FILL

## Portfolio entry

Required sequence:

```text
exact BUILD_CUSTOM buy
→ policy
→ effect-valid simulation
→ exact acquired token amount
→ immediate exact same-family sell
→ policy
→ effect-valid simulation
→ complete round-trip economics
→ risk/gates rerun
→ position
```

A buy without a verified sell is not an entry.

## Portfolio mark

Every decision-bearing mark is:

```text
exact full-balance same-family BUILD_CUSTOM sell
```

or a separately parity-proven direct Pump family.

`/order` remains a stored benchmark and drives no stop, peak, NAV, trail, take-profit or collapse decision.

## Portfolio exit

Required sequence:

```text
policy triggers at observation T
→ frozen reaction/build/submission latency
→ first later same-family effect-valid observation
→ fill
```

The trigger observation is never its own fill.

If no later valid exit exists:

```text
EXIT_BLOCKED
tokens remain held
rent remains locked
risk/NAV retain exposure
bounded retries continue
```

## Selective mark simulation

The free API/simulator budget cannot simulate every mark across an unlimited book.

Simulate:

- every entry buy/sell pair;
- every prospective trigger;
- the first later fill observation;
- every WSS emergency alarm;
- route/program/account-set changes;
- a preregistered random calibration sample of non-trigger marks.

Structural marks may guide collection but cannot create a confirmatory fill.

---

# P11 — FIX SHADOW LIFECYCLES

Maintain separately:

```text
alpha_shadow
canary_shadow
portfolio_paper
```

Every eligible episode opens fixed alpha and canary shadows regardless of portfolio acceptance/refusal.

Evidence class is immutable at each event:

```text
STRUCTURAL_ONLY
JIT_EFFECT_VALID
OFFLINE_REPRODUCIBLE
CONFIRMATORY
```

A position may be promoted only by creating a new evidence event—not by retroactively changing what an old event meant.

## Shadow exit state machine

```text
POSITION_OPEN
EXIT_TRIGGERED
AWAITING_FILL_OBSERVATION
EXIT_BLOCKED
POSITION_CLOSED
```

A shadow may not close at its trigger observation.

Apply frozen latency and use the first later effect-valid observation for its evidence class.

## Scheduling

`nearTrigger` must use:

```text
latest executable value
peak value
distance to stop
distance to trail
distance to take profit
time to max hold
```

not peak alone.

Priority:

1. blocked;
2. triggered/awaiting fill;
3. near trigger;
4. most overdue;
5. newest.

If backlog exceeds capacity:

- stop admitting new shadows;
- record skipped episodes;
- preserve inclusion probability;
- do not silently stretch cadence.

Identical books at identical size share observations.

---

# P12 — ONE ACCOUNTING DEFINITION AND EXPLICIT PNL FIELDS

Current field semantics are ambiguous.

Migrate to explicit fields:

```text
entry_cash_out_lamports
locked_rent_lamports
exit_cash_in_lamports
net_pnl_lamports
```

Do not use one `realized_lamports` field to mean both proceeds and PnL.

Backfill only when derivable from preserved raw evidence. Otherwise mark unknown.

One module calculates:

```text
entry cash out
exit cash in
locked rent
actual/expected failure cost
net PnL
viability
portfolio ledger
shadow ledger
replay
report
readiness
future canary
```

## Costs

Use measured simulation fields:

- base fee;
- applied CU limit;
- priority fee;
- route-specific tip;
- rent created/recovered;
- transfer fee;
- withheld fee;
- platform/integrator fee;
- failed-attempt fee.

Do not set unknown transfer fees to zero.

BUILD_CUSTOM having no Jupiter platform fee is an explicit family fact, not an unknown.

## Pump V2 account costs

Pump V2 can initialise additional accounts such as volume accumulators and quote-token ATAs.

Separate:

```text
one-time wallet setup
per-mint setup
recurring per-trade cost
recoverable rent
unrecoverable rent
```

A first trade and a repeat trade are different cost cases.

## Failure model

Replace a full assumed failure charge on every successful leg with:

```text
observed attempts
landed failures
conditional failure fee
upper confidence bound on failure probability
```

Actual failures are charged directly.

## Risk

Use one catastrophic-loss fraction for:

```text
proposed trade
existing positions
aggregate exposure
reports
```

Do not make an existing position become four times safer merely because it was accepted.

---

# P13 — FIX READINESS BEFORE IT EVER SEES A TRADE

Current readiness subtracts principal twice if `realized_lamports` is already PnL.

Use explicit `net_pnl_lamports`.

Correct:

## Equity and drawdown

Start from the actual frozen starting NAV.

Compute chronological wallet equity, including locked rent and open/blocked exposure.

Do not compute drawdown from cumulative PnL starting at zero.

## Cost stress

“2× costs” means doubling transaction costs:

```text
fees
tips
rent loss
failure cost
latency cost
```

It does not mean subtracting the entire trade principal again.

## Calendar exposure

Require:

```text
at least 21 distinct UTC calendar days
```

not merely 21 elapsed days between two timestamps.

## Confidence

Memecoin returns are heavy-tailed and clustered.

Use:

- mint-block bootstrap;
- UTC-day block bootstrap;
- robust mean/log-growth intervals;
- an anytime-valid confidence sequence or a preregistered fixed-horizon interval.

Do not rely only on a normal approximation.

## Shadow gate

The canary-shadow aggregate must use:

```text
exact current preregistered context
confirmatory evidence class
same notional
same cohort
same policy
```

not every historical closed shadow.

## Exact arithmetic

Do not convert large lamport sums through JavaScript `Number`.

Ratios may use a documented high-precision decimal/rational implementation.

---

# P14 — ONE CANONICAL EVIDENCE VIEW

Unify:

```text
legIsConfirmatory
confirmatory.ts
readiness SQL
canaryEvidenceGates
report SQL
capability matrix
```

Create one canonical module/view:

```text
confirmatory_positions_v1
```

A row requires:

- exact preregistered context;
- clean source commit;
- one supported capability fingerprint;
- same family across entry/marks/exit;
- exact transaction bytes;
- entry and exit `SIMULATED_EFFECT_OK`;
- linked `simulation_jobs.confirmatory = 1`;
- complete account coverage;
- frozen offline snapshot/program artifacts;
- all costs known;
- no lifecycle violation;
- no unresolved reconciliation;
- residual token balance zero.

Every report and gate queries that one view.

Mutation-test every clause.

---

# P15 — PUMP/PUMPSWAP FIRST, AGAINST OFFICIAL CURRENT SOURCES

Use as primary oracles:

```text
pump-fun/pump-public-docs
official pump IDL
official pump_amm IDL
official pump_fees IDL
official Pump SDK
official PumpSwap SDK
```

Pin source commit/version in provenance.

## Pump bonding curve

Support current:

- legacy and V2 layouts;
- SOL and USDC quote mints;
- legacy Token and Token-2022;
- real and virtual reserves;
- exact real-token capacity;
- protocol, creator and buyback fees;
- fee-recipient rules;
- volume accumulators;
- Mayhem;
- exact integer rounding.

## PumpSwap

Support:

- canonical pool/vault identities;
- base/quote orientation;
- SOL/USDC variants;
- current market-cap fee tier;
- creator/protocol/LP components;
- exact full-position sell capacity;
- migration state;
- protocol ownership.

## Parity

Compare:

```text
Epitaxy math
official SDK
current BUILD_CUSTOM response
settled on-chain swaps
```

A 123–257 bps residual is not parity.

Do not enable direct execution until quoter and builder both pass.

---

# P16 — MAYHEM AND TOKEN-2022 ARE MANDATORY FACTS

For every under-24-hour Pump token, persist:

- Mayhem enabled;
- Mayhem agent/fee-recipient identities;
- original/additional supply;
- agent token balance and net selling;
- 24-hour burn transition.

Do not interpret Mayhem random trading as organic maker/holder growth.

For Token-2022 decode current extensions, including:

- transfer fees;
- permanent delegate;
- default account state;
- non-transferable;
- transfer hook;
- confidential transfer;
- pausable;
- permissioned burn;
- unknown future extensions.

Unknown money-critical behavior:

```text
development: separate unknown cohort
canary/live: hard veto
```

---

# P17 — WIRE THE THREE CURRENTLY DEAD PRODUCTION MODULES

Current decision-bearing modules with no production importer:

```text
mintfacts.ts
entity.ts
accountwatch.ts
```

Wire in this order.

## 1. Mint facts

Direct chain facts override provider opinions.

Record provider/chain disagreements as source-quality evidence.

## 2. Pump/Mayhem/creator/entity facts

Require venue-specific canonical PDA/vault validation before excluding inventory from concentration.

Build:

- creator holdings/history;
- first 10/20 buyers;
- common initial funder;
- same-transaction co-purchase;
- shared fee payer;
- direct transfer graph;
- entity-adjusted top 1/5/10/20;
- creator/cluster net selling;
- real SOL inflow;
- holder/maker persistence;
- wash-like round trips.

Concentration denominator is total supply.

## 3. WSS risk alarm

Fix before wiring:

- a slot gap is not automatically a missed account write;
- hash full data, owner, lamports and context;
- one reconnect state machine;
- no duplicate reconnect loops;
- `unwatch` sends unsubscribe;
- reconnect epochs and gaps are explicit;
- decode SPL token amount, not account lamports.

On material change:

```text
enqueue immediate same-family observation
```

Raw state is an alarm, not a fill price.

---

# P18 — RUN REAL AGE COHORTS

The runtime currently matures candidates only for the configured 2–60-minute band.

Create retained candidate queues for:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

Each cohort uses the same:

- fixed notional;
- route family;
- accounting;
- risk facts;
- exit policies;
- evidence classes.

Do not pool cohorts.

Track Mayhem separately inside the first 24 hours.

A cohort selected on development data gets one untouched confirmatory window.

---

# P19 — REPAIR REJECT TRACKING END TO END

The domain classifier correctly separates provider absence from economic collapse.

The current backtest still maps “vanished” to -100%.

Replace it.

For a stratified sample of rejected episodes collect:

- exact same-family build;
- effect-valid simulation;
- direct pool state;
- executable value;
- provider health;
- source gaps;
- inclusion probability.

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

Only confirmed economic worthlessness becomes -100%.

Do not anchor from the first future price when the rejection-time price is missing.

---

# P20 — FREEZE THE CURRENT SCORE

Do not tune score weights until effect-valid labels exist.

Fix mathematical defects only:

- missing net buyers remains unknown;
- zero-risk features cannot dilute existing risk;
- missing organic score is not penalised twice;
- unknown never satisfies a hard gate.

After at least 100 valid development round trips compare:

```text
hard gates only
current deterministic score
simple calibrated severe-loss logistic model
simple conditional-log-return model
tree model only if chronologically superior
```

Separate risk and return targets.

Use public MemeTrans/SolRPDS/SolRugDetector data only for feature design and development priors. Prospective current data decides promotion.

No LLM in the trading loop.

---

# P21 — RATE-BUDGET AND UPGRADE DECISION

First eliminate duplicate calls and enforce backlog admission.

Measure:

- distinct positions due per second;
- calls by purpose;
- p50/p95/max mark lag;
- skipped episodes;
- 429s;
- emergency-exit wait;
- simulator queue;
- effect-valid labels/day.

The free Jupiter key is 1 RPS. The Developer plan is 10 RPS for $25/month with the same stated data freshness and latency.

Upgrade only when:

```text
the label generator is correct
and
1 RPS is demonstrably reducing valid labels or violating the mark SLA
and
the time/value gained exceeds $25/month
```

Do not evade quotas with multiple accounts.

Current Helius free capacity is sufficient for selective RPC/WSS until measured otherwise.

No paid archival RPC, gRPC, shreds, premium VPS or colocation yet.

---

# P22 — START VALID DEVELOPMENT LABELS

A new valid-development window requires:

- green Linux/Windows CI;
- protected branch;
- clean source SHA;
- fixed token-balance identity;
- asset-aware bounds;
- exact token provisioning;
- `SIMULATED_EFFECT_OK` semantics;
- complete account coverage;
- same-family production core;
- unified accounting;
- Pump capability proof;
- no unresolved lifecycle defect.

Initial development arms:

```text
route: BUILD_CUSTOM Pump/PumpSwap-supported fingerprints
notional: corrected canary-valid fixed notional
cohorts: all four, separate
policy: current control + one mechanism-distinct challenger
```

Checkpoints:

```text
10  — instrument sanity
25  — route/cost sanity
50  — first directional development read
100 — candidate arm selection allowed
```

At 50, do not call the strategy profitable.

Kill/pivot conditions:

- after 50 valid positions, an arm is net negative after all costs and top-3 removal;
- catastrophic incidence is unacceptable under the frozen gate;
- route/fill blockage makes the arm unrealizable;
- cost floor exceeds plausible edge.

The 2m–60m arm does not receive special protection. If it remains dominated by wipeouts, prioritise survivor cohorts.

---

# P23 — ONE UNTOUCHED CONFIRMATORY WINDOW

After development selection, freeze exactly:

```text
one capability fingerprint set
one route family
one notional
one age cohort
one primary valuation
one ATA treatment
one control exit
one challenger
one feature/gate set
```

Create a fresh context and preregistration before seeing its outcomes.

Require:

- at least 200 valid completed positions;
- at least 21 distinct UTC days;
- multiple market conditions;
- positive net PnL;
- positive expected log growth;
- positive robust lower bound;
- profit factor at least 1.25;
- bounded drawdown and CVaR;
- acceptable catastrophic incidence;
- most recent 50 net positive;
- positive after top 1/3/5/10 removal;
- positive after best day removal;
- positive after best five mints removal;
- no single trade/day domination;
- positive under 2× transaction-cost stress;
- positive under latency/failure/rent stress;
- positive realizable portfolio;
- positive exact canary-size shadow;
- zero replay divergence;
- zero unresolved reconciliation;
- stable program/simulator fingerprints.

Compare against:

```text
no trade
hold SOL
random contemporaneous eligible entries
hard-gates-only
current score
```

Do not weaken a failed gate.

---

# P24 — CANARY IMPLEMENTATION, NO FUNDING DURING THIS DIRECTIVE

The operator is 18 and legally eligible. Age is not a blocker.

Only after `artifacts/readiness.json` says `CANARY_READY`, build/finalise the real canary path.

It must use the same:

- transaction builder;
- capability allowlist;
- policy;
- effect verifier;
- accounting;
- exit state machine;
- reconciliation;
- route family.

Canary policy:

```text
separate wallet
one open position
one frozen exact notional
first five entries manually approved
maximum one attempted entry/day initially
no leverage
no averaging down
no martingale
halt on any effect mismatch
halt on any reconciliation uncertainty
halt on any unexpected partial/sliver outcome
```

Fund only:

```text
one max position
+ rent/setup
+ entry/exit fees
+ one failure
+ safety reserve
```

Do not fund during this directive.

Twenty real round trips establish execution fidelity, not permanent profitability.

`LIVE_READY` requires a later review of positive real canary economics.

---

# P25 — EXECUTOR REMAINS BLOCKED UNTIL EDGE EXISTS

The current executor still belongs to the older `/order` path and has no complete strategy loop.

Do not spend this session optimising broadcasters.

Later:

- implement the chosen BUILD_CUSTOM family;
- preserve exact transaction expiry;
- inspect all ALT-loaded accounts;
- sign only a fully bound intent;
- durable attempt before send;
- no retry while fate is unknown;
- chain-derived fills;
- complete entry/exit/ATA-close loop.

Broadcaster benchmark after confirmatory edge:

```text
ordinary RPC
Helius SWQOS-only
Helius Sender Max/default
Jupiter submit
direct Jito
audited direct venue
```

Compare complete wallet-to-wallet expected value, not headline latency.

---

# P26 — ARTIFACTS, RELEASE MANIFEST AND SECURITY

The current release-manifest script is stale and hardcodes old blockers and `tests.run=false`.

Replace hand-maintained blockers with machine facts.

The manifest must include:

- clean SHA;
- branch;
- CI run ID/URL/conclusion;
- test and mutation results;
- replay result;
- current schema/config/risk/context hashes;
- simulator/effect/capability versions;
- supported capability fingerprints;
- snapshot/program manifest hashes;
- valid development/confirmatory counts;
- current blockers.

The repository is currently public.

Prepare exact operator instructions to:

```text
make the repo private
```

or split:

```text
public generic core
private strategy/runtime/ops/data
```

Do not change visibility without explicit operator approval.

Never commit:

- runtime DB/WAL;
- raw operational payload corpus;
- account snapshots/ELFs;
- API endpoints/keys;
- wallet paths;
- private strategy thresholds;
- signer material.

Require one independent reviewer for:

- signer;
- executor;
- risk;
- config;
- migrations;
- readiness gates.

---

# P27 — REQUIRED BEHAVIORAL AND MUTATION TESTS

Add tests that fail against current `5b89953` for at least:

1. daemon token map keyed by account versus verifier keyed by owner/mint;
2. structured token balance aggregation;
3. native-SOL sell bound;
4. token-output buy bound;
5. request hash changes with side/input/output/program/accounts;
6. token-input request without token mutation is instrument-invalid;
7. token amount >2^53 is exact;
8. runtime success with no economic output fails;
9. partial input debit fails unless explicitly permitted;
10. side-aware SOL conservation;
11. fee decomposition equality, not merely non-null fields;
12. an omitted writable fails account coverage;
13. >64 writable/economic accounts cannot be confirmatory;
14. JIT snapshot is durably stored before completion;
15. missing ELF/programdata blocks replay;
16. `soPath` child worker keeps daemon health responsive;
17. JIT/offline Pump buy parity;
18. JIT/offline Pump sell parity;
19. per-fingerprint capability replaces global parity;
20. `paper.ts` imports and executes paper-core;
21. portfolio entry cannot open without same-family effect-valid sell;
22. portfolio mark cannot be `/order`;
23. portfolio exit requires later effect-valid fill;
24. shadow cannot close at trigger observation;
25. shadow blocked exit remains managed;
26. near-trigger uses latest mark;
27. backlog prevents new admission;
28. one global signal episode crosses time buckets without duplication;
29. unknown transfer fee cannot become zero;
30. runtime accounting is the same function used by report/readiness;
31. readiness does not subtract principal twice;
32. cost stress doubles costs, not principal;
33. drawdown starts from actual NAV;
34. 21 elapsed days but fewer distinct UTC days fails;
35. canary shadow query is context/evidence filtered;
36. development JIT cannot pass confirmatory gate;
37. provider disappearance is not -100%;
38. current Pump fee math matches official SDK;
39. Mayhem detected and separated;
40. Token-2022 pausable/permissioned-burn unknowns fail capital eligibility;
41. WSS reconnect is single-flight;
42. unwatch unsubscribes;
43. vault alarm uses token amount, not lamports;
44. stale release manifest cannot pass readiness;
45. 200 losing trades cannot pass;
46. top-three-fragile positive corpus cannot pass;
47. executor cannot start before machine-generated CANARY_READY;
48. live cannot start before positive real canary evidence.

Run mutation tests for every repaired defect.

---

# P28 — REQUIRED COMMANDS AND OUTPUTS

Commands:

```bash
pnpm audit:state
pnpm simulation:audit
pnpm simulator:doctor
pnpm simulator:pump-effect-proof
pnpm simulator:offline-pump-parity
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

Create/update:

```text
docs/AUDIT_HEAD_5B89953.md
docs/5B89953_EFFECT_WINDOW_INVALIDATION.md
docs/PUMP_EFFECT_PROOF.md
docs/OFFLINE_PUMP_PARITY.md
docs/CAPABILITY_MATRIX.md
docs/ACCOUNTING_SEMANTICS.md
docs/COHORT_EXPERIMENT.md
docs/REJECT_PANEL.md
docs/JUPITER_UPGRADE_ROI.md
docs/CANARY_READINESS.md
docs/MULTIPLE_TESTING_LEDGER.csv
docs/FAILURE_REGISTER.csv

artifacts/pump-effect-proof.json
artifacts/offline-pump-parity.json
artifacts/capability-matrix.json
artifacts/cost-surface.json
artifacts/shadow-status.json
artifacts/cohort-status.json
artifacts/reject-status.json
artifacts/readiness.json
artifacts/release-manifest.json
```

Provide exact Windows commands to:

- start/stop paper engine;
- start/stop WSL simulator and offline worker;
- halt new entries;
- terminate when flat;
- take a backup;
- inspect effect failures;
- inspect mark backlog;
- monitor cohorts.

Nothing automatically starts canary or live.

---

# P29 — FINAL REPORT

Report:

1. starting and ending SHA;
2. local differences from audited GitHub;
3. backup path/hash/integrity;
4. current position/shadow state;
5. current window invalidation;
6. token-balance identity fix;
7. asset-aware bound proof;
8. >2^53 provisioning proof;
9. ten Pump effect-proof results;
10. JIT snapshot persistence;
11. `soPath`/child/Rust/LiteSVM decision and measurement;
12. Pump offline parity;
13. supported capability fingerprints;
14. production paper-core wiring;
15. same-family lifecycle proof;
16. shadow trigger/fill proof;
17. unified accounting and explicit PnL fields;
18. corrected readiness calculations;
19. Pump/PumpSwap parity;
20. Mayhem/Token-2022 facts wired;
21. entity/WSS production importers;
22. age-cohort counts;
23. reject-panel counts;
24. effect-valid development trades/days;
25. offline-reproducible development trades/days;
26. confirmatory trades/days;
27. mark lag/skipped episodes;
28. whether Jupiter Developer is now justified;
29. every unresolved blocker;
30. exact operator actions;
31. exact keep-running commands;
32. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_EFFECT_LABELS_RUNNING
PUMP_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

The expected honest next milestone is:

```text
VALID_EFFECT_LABELS_RUNNING
```

Do not output `CANARY_READY` because tests pass, JIT succeeds, one Pump route replays, or 200 rows exist. It means a frozen strategy has positive, robust, all-cost, untouched confirmatory expected log growth and the full microscopic canary path is safe.
