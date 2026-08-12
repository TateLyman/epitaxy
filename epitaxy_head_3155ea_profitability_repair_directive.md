# CLAUDE CODE DIRECTIVE — EPITAXY EXECUTABLE-TRUTH REPAIR AND PROFITABILITY RESET

**Repository:** `TateLyman/epitaxy`  
**Audited GitHub branch:** `master`  
**Audited GitHub HEAD:** `3155ea74795fd51279575803d17abeb293f20b08`  
**Date:** 2026-08-12  
**Allowed operating modes during this directive:** observe and paper only  
**Forbidden:** canary, live, funding a trading wallet, signing, submitting, or implying profitability

Execute this work in the Epitaxy repository. Do not work in `memecoinstuff`, `memecointrader`, or any graduation-auction repository. Do not merely return a plan.

The repository has done unusually strong work on deterministic replay, durability, risk halts, build probing, raw-payload retention, paper/live process separation, and intellectual honesty. Preserve that work. The problem is now narrower and more important:

> The current P2b window does not yet represent one coherent, executable trading strategy.

The current engine:

- prices paper entries and marks using Swap V2 `/order`, where all routers compete and Jupiter platform fees are included;
- proves “buildability” using Swap V2 `/build`, which is Metis-only, has a different fee model, and may return a different route and amount;
- scales a 0.05-SOL quote linearly to the actual position instead of requesting a final exact-size executable route;
- uses the quote’s worst-case threshold, then deducts another fee that the `/order` quote already includes;
- omits some actual fixed costs while double-counting or assuming others;
- builds exits only when the current control policy wants to leave, so the preregistered alternative policies do not have build-valid counterfactual fills at their own trigger times;
- records an alpha-shadow ledger event but does not create and follow an independent shadow position when the realizable portfolio refuses a signal;
- can close an unbuildable paper exit and release capital anyway;
- moves an unrouteable position to `EXIT_BLOCKED`, but `openPositions()` excludes that state, so the position is never managed again;
- can clear clock-resume reconciliation after database integrity passes even when fresh re-marking failed;
- still applies `Math.abs` to the legacy signed impact field in the entry gate;
- does not yet wire its own authoritative mint decoder, pool state, creator flows, or entity graph into eligibility;
- has no valid executable PnL observations and no complete canary execution loop.

Therefore the current P2b confirmatory window must be frozen as **development data**, not continued as confirmation.

The only permitted final states for this session are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`PROFITABLE`, `CANARY_READY`, and `LIVE_READY` are forbidden outputs.

---

# P0 — PRESERVE THE REAL LOCAL STATE BEFORE EDITING

The GitHub audit can see only committed `master`. The local PC may contain a newer commit, an open paper position, a dirty tree, a WAL file, or an active process.

Before changing anything, record:

```bash
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -30
pnpm status
pnpm health
pnpm capability -- --mode=paper
```

Record:

- exact local HEAD and whether it differs from `3155ea74795fd51279575803d17abeb293f20b08`;
- every dirty/untracked file;
- engine PID, start time, strategy/config/context hashes, and current halt state;
- current database path, WAL/SHM paths, schema version, latest row IDs, open positions, blocked exits, and last mark;
- current Jupiter/Helius endpoint classes and whether free API keys are active, without printing credential values.

If an open position exists:

1. set `HALT_NEW_ENTRIES`;
2. keep exit management active;
3. do not change its economic policy mid-position;
4. let it become flat or explicitly preserve it as a development-only unresolved position;
5. never kill the process in a way that abandons exit management.

Create a consistent SQLite online backup using `VACUUM INTO` or the backup API while WAL is active. Do not copy only the main DB file.

Run and save:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Produce SHA-256 manifests, table counts, max IDs/timestamps, and a read-back verification.

Create `docs/AUDIT_HEAD_3155EA.md`.

Commit the untouched baseline before semantic changes.

---

# P1 — INVALIDATE THE CURRENT P2B WINDOW WITHOUT DELETING IT

The current `docs/P2B_PREREGISTRATION.md` was frozen before several validity defects below were identified. Its data remain valuable development data, but it is not a valid confirmatory window.

Create:

```text
docs/P2B_INVALIDATION.md
```

State precisely:

- original preregistration commit;
- original start timestamp and context hash;
- number of signals, positions, marks, build attempts, and closed rows;
- which rows are development-only;
- each newly identified reason the window cannot compare its four policies fairly;
- that no threshold or result was used to create a replacement strategy.

Close the current context. Never rewrite its rows.

Create a new schema/accounting/experiment version only after P2–P10 are complete. The new confirmatory start timestamp must be later than the final repair commit and clean process restart.

---

# P2 — CHOOSE ONE EXECUTION FAMILY PER OBSERVATION

A price from one route and a build from another route do not form an executable trade.

## 2.1 Define route families

Every quote/build/mark/fill must carry one explicit execution family:

```text
ORDER_EXECUTE
BUILD_CUSTOM
DIRECT_VENUE
QUOTE_ONLY_BENCHMARK
```

### ORDER_EXECUTE

- `/swap/v2/order`
- all routers compete: Metis, JupiterZ, Dflow, OKX
- Jupiter platform fee included in the quote and deducted automatically
- assembled transaction must be used unmodified
- must be submitted through `/execute`
- may require partial signing for JupiterZ
- paper sell buildability cannot be inferred from an unfunded wallet that does not own the hypothetical tokens
- until an actual canary validates it, ORDER_EXECUTE is an **economic benchmark**, not the primary paper-PnL route

### BUILD_CUSTOM

- `/swap/v2/build`
- Metis-only route
- quote and raw instructions come from the same response
- no default Jupiter `/order` swap fee
- exact-size transaction is assembled locally
- sent by an explicitly measured broadcaster, not automatically through Jupiter `/submit`
- primary candidate for structurally valid paper simulation because hypothetical balances can be supplied in a local SVM/fork

### DIRECT_VENUE

- audited venue-specific transaction
- exact pool program/account decoder
- exact fee arithmetic
- transaction policy, simulation, reconciliation, and chaos tests
- disabled until a measured route family justifies the engineering cost

### QUOTE_ONLY_BENCHMARK

- a useful price or route observation
- never PnL-eligible
- never called executable

## 2.2 Ban route hybrids

Create a first-class `ExecutionObservation` identifier. A PnL-eligible leg must use:

- one route family;
- one exact amount;
- one response;
- one route plan;
- one fee model;
- one instruction/transaction hash;
- one expiry;
- one context;
- one simulation result.

The following must fail closed:

```text
/order outAmount + /build instruction hash
/order platform fee + /build no-fee route
probe-size price + exact-size build
one routePlan + another routePlan's build
one context slot + another context's pool state
```

Mutation-test each mismatch.

## 2.3 Make BUILD_CUSTOM the first valid paper route

For the primary paper ledger:

1. Call `/build` at the exact intended entry amount.
2. Use that same response’s `outAmount`, `otherAmountThreshold`, route plan, fee fields, instructions, lookup-table map, and blockhash metadata.
3. Construct the complete versioned transaction.
4. Preserve:
   - every account meta including `isSigner` and `isWritable`;
   - every instruction in the documented order;
   - lookup-table address and resolved contents;
   - blockhash and last valid height;
   - packet size;
   - fee payer;
   - required signatures;
   - compute budget;
   - tip instruction if and only if the selected broadcaster requires it.
5. Run instruction policy.
6. Run full transaction policy.
7. Simulate it in a local SVM/fork fixture with exact captured mainnet accounts and the hypothetical paper wallet balance.
8. Book no paper entry unless all steps pass.
9. Use the same family for every subsequent mark and exit.

Do not call instruction-only policy “transaction policy.” Report both separately.

## 2.4 Fix the instruction-set hash

The current instruction-set hash must include:

- program ID;
- instruction data;
- ordered account pubkeys;
- `isSigner`;
- `isWritable`;
- instruction order;
- lookup-table identity/content hash.

Two instruction sets that differ in signer or writable privileges must never hash to the same value.

## 2.5 Preserve provider error taxonomy

`JupiterClient.build()` must not collapse every `SourceFetchError` into `null`.

Persist:

```text
NO_ROUTE
HTTP_429
HTTP_4XX
HTTP_5XX
TIMEOUT
SCHEMA_DRIFT
PARSER_ERROR
POLICY_REFUSAL
SIMULATION_FAILURE
EXPIRED
UNKNOWN
```

A provider failure is not an untradeable token. A no-route response is not an outage.

---

# P3 — EXACT-SIZE PAPER FILLS AND COMPLETE COST ACCOUNTING

## 3.1 Eliminate probe scaling from entries

The 0.05-SOL probe may remain a cheap screening feature.

It may not price the actual paper entry.

After sizing chooses a proposed amount:

1. request a fresh exact-size BUILD_CUSTOM observation;
2. recompute all cost gates at that size;
3. refuse if route, impact, fee, policy, or viability changed;
4. use exact response amounts;
5. bind the final observation to the position and fill.

Never linearly scale `otherAmountThreshold`.

## 3.2 Stop double-charging platform fees

For `/order`, Jupiter states that its platform fee is included in the quote and deducted automatically. Therefore:

- do not multiply the returned `outAmount` or `otherAmountThreshold` by another `(1 - feeBps)`;
- persist the raw fee amount, rate, and mint;
- reconcile actual `/execute` `inputAmountResult` and `outputAmountResult` in canary/live;
- keep `/order` and `/build` fee models separate.

For `/build`:

- use the response’s exact route economics;
- charge a platform fee only if `platformFeeBps` was deliberately requested;
- account for AMM/program fees already embedded in the route’s output;
- account separately for network fee, priority fee, broadcaster tip, ATA rent, transfer fees, and cleanup.

Add tests that fail if an included fee is deducted twice.

## 3.3 Stop substituting assumptions for response fields

Every leg should store:

```text
input amount
expected output
minimum output
platform fee amount/bps/mint
signature fee
priority fee
broadcaster tip
rent created
rent recovered
transfer fee current and future epoch
withheld transfer fees
compute units
route plan
pool/program
transaction size
quote/build latency
decision latency
simulation latency
expiry
```

An assumption may exist only when the field is truly unavailable, and must be:

- named `assumed_*`;
- versioned;
- reported separately;
- swept in sensitivity analysis.

## 3.4 Include all fixed costs

Current entry cost must include, as applicable:

- exact input;
- base signature fee;
- priority fee;
- broadcaster tip;
- ATA/account rent;
- transfer fee;
- any platform/integrator fee not already embedded;
- failed-attempt fee expectation.

Current exit net value must subtract:

- base signature fee;
- priority fee;
- broadcaster tip;
- transfer fee;
- close-account fee;
- expected failed-attempt cost.

Do not omit signature fees because they are small. Exact accounting cannot selectively ignore small costs while testing a thin edge.

## 3.5 Three paper valuations, one primary

Persist:

```text
EXPECTED_OUTPUT
MINIMUM_OUTPUT_STRESS
LATENCY_STRESSED_OUTPUT
```

Do not choose whichever looks better after the fact.

The primary paper fill rule must be frozen before collection. `otherAmountThreshold` is a slippage floor, not an estimate that every real fill equals the worst permitted output. Use it as a stress case unless evidence justifies it as the base case.

---

# P4 — FIX POSITION LIFECYCLE AND RECOVERY

## 4.1 `EXIT_BLOCKED` remains open and managed

`openPositions()` currently omits `EXIT_BLOCKED`.

Fix the state machine so the managed set includes:

```text
POSITION_OPEN
EXIT_INTENT
EXIT_BLOCKED
RECONCILING
```

An `EXIT_BLOCKED` position:

- keeps its token balance;
- keeps its rent locked;
- remains in exposure/NAV;
- is re-quoted and re-built at bounded intervals;
- blocks new entries when required;
- can only close after a build-valid, policy-valid simulated or real exit;
- is never released from the wallet merely because a quote existed.

Add an invariant:

```text
token_amount > 0 and closed_utc_ms IS NULL
=> position appears in the managed set
```

Test it with every state mutation.

## 4.2 Never close an unbuildable paper exit

The current code explicitly closes and realizes PnL after an exit build fails.

That is an impossible wallet path.

New behavior:

```text
exit rule fires
    -> attempt exact route build
    -> policy
    -> simulation
    -> if valid: close at the first later valid execution observation
    -> if invalid: EXIT_BLOCKED and keep managing
```

The failed build is charged under the frozen failed-attempt model if applicable.

## 4.3 Resume reconciliation requires successful fresh observations

After a clock/sleep discontinuity, do not clear `resync_required` merely because `PRAGMA integrity_check` passes.

Require:

- database integrity and foreign-key checks;
- source/RPC health;
- every managed position reloaded;
- a fresh route/build/simulation attempt for every managed position;
- no position with an unknown balance/state;
- current wallet/ledger reconciliation;
- mark timestamps later than the discontinuity checkpoint.

A provider failure leaves resync unresolved and entries blocked.

## 4.4 Kill semantics

Preserve explicit states:

```text
HALT_NEW_ENTRIES
EXIT_ONLY
TERMINATE_WHEN_FLAT
EMERGENCY_RECONCILE
```

No halt mode may abandon an open or blocked position.

## 4.5 Crash exactly-once tests

Extend durability tests across:

- crash after quote but before build;
- crash after build but before position insert;
- crash after position insert but before fill;
- crash after exit trigger but before build;
- crash after EXIT_BLOCKED;
- crash after simulated close but before ledger update;
- crash during UTC rollover;
- crash during resync.

Every recovery must produce exactly one position, exactly one accounting path, and no released capital without a valid exit.

---

# P5 — BUILD A REAL ALPHA-SHADOW BOOK

The current `alpha_shadow` is an event label attached to the realizable portfolio. When portfolio sizing refuses a signal, it writes a refusal row and follows no position. That does not solve loss-dependent censoring.

Create an independent shadow-position table/state machine.

For every eligible signal:

- request the same exact-size valid BUILD_CUSTOM entry observation under a frozen shadow notional;
- open a shadow position even when the realizable portfolio is halted, full, or out of capital;
- allow overlapping shadow positions;
- track each to its own exit under the frozen policy;
- use no future information;
- preserve build/simulation failures;
- do not share NAV/free-capital state with portfolio paper;
- never sum shadow PnL with realizable PnL.

Required estimands:

```text
signal-conditional expectancy
realizable one-wallet expectancy
canary-config expectancy
```

Add a separate `canary_shadow` book using the committed canary constraints and exact canary size. This reveals whether paper profits at 0.05 SOL survive at the amount the system could legally deploy under its own risk config.

---

# P6 — FIX RISK SIZING FOR MEMECOIN GAP RISK

## 6.1 Stop sizing from the nominal stop alone

The current sizing logic treats a 25% stop as planned loss. Historical paper observations already include near-total value collapse within one mark interval.

Use at least:

```text
planned_loss = max(
  nominal_stop_loss,
  empirically observed severe-loss quantile,
  configured catastrophic-loss floor
)
```

Before enough valid observations exist, assume a 100% principal-loss floor for these tokens.

Report both:

```text
stop-based risk
catastrophic principal-at-risk
```

## 6.2 Include the proposed trade in aggregate loss

The aggregate planned-loss check must evaluate:

```text
existing planned loss + proposed planned loss
```

not only the existing book.

Mutation-test the exact boundary.

## 6.3 Canary cannot be looser than live

Audit every risk field across paper/canary/live.

Current canary percentage settings are looser than live in several dimensions. A mode with a smaller absolute entry cap is not automatically safer.

Require that canary be no more permissive than live for:

- risk budget;
- notional fraction;
- simultaneous positions;
- aggregate planned loss;
- daily/weekly/drawdown halts;
- priority fee;
- slippage;
- fee fraction;
- total exposure.

No canary/live override may loosen these fields.

## 6.4 Resolve canary viability honestly

The committed canary maximum is 0.02 SOL. At that size:

- ATA rent is a large share of notional;
- 50-bps-per-side `/order` fees may apply under 24 hours;
- broadcaster tips/priority fees are material;
- zero rent recovery in bad exits is plausible.

Do not raise the canary cap simply to make the strategy trade.

First compare:

- BUILD_CUSTOM + ordinary RPC;
- BUILD_CUSTOM + Helius SWQOS-only;
- BUILD_CUSTOM + other legitimate low-cost broadcaster;
- ORDER_EXECUTE benchmark;
- audited direct venue.

If no route has positive conservative expectancy at or below the canary cap, record:

```text
STRATEGY_NOT_CANARY_VIABLE_AT_CURRENT_SIZE
```

A larger canary requires a new explicitly justified risk policy after strong evidence, not a silent config change.

---

# P7 — WIRE AUTHORITATIVE ON-CHAIN RISK INTO ELIGIBILITY

The repository has a good mint decoder and direct RPC client, but eligibility currently relies mostly on Jupiter token metadata, five-minute aggregates, and holder concentration.

## 7.1 Mint and token-account safety

Before capital eligibility, call the direct decoder and persist:

- token program;
- decimals;
- mint authority;
- freeze authority;
- permanent delegate;
- default frozen state;
- transfer hook;
- non-transferable;
- pausable;
- confidential extensions;
- transfer-fee current/future epoch;
- fee authorities;
- withheld fees;
- close behavior;
- every unknown extension.

Unknown unsupported behavior fails closed for canary/live and remains a separate cohort in paper research.

## 7.2 Fix concentration treatment

An unresolved holder owner must not be automatically classified as harmless program-controlled inventory.

Use three categories:

```text
WALLET
VERIFIED_PROGRAM_CONTROLLED
UNKNOWN
```

Only verified pool/vault/burn/escrow semantics may be excluded from wallet concentration.

A creator-controlled PDA is not safe merely because it is program-owned.

Build a versioned known-program/entity registry.

## 7.3 Pool/vault state

All eight historical collapse cases routed through Pump.fun Amm but cannot be explained because pool fields are null.

Implement the highest-value venue first:

```text
Pump/PumpSwap
```

Decode and monitor:

- actual pool and vault accounts;
- real versus virtual reserves;
- fee configuration;
- canonical pool/migration state;
- LP authority and removable liquidity;
- creator inventory and creator LP;
- reserve changes;
- pool transition;
- route fragmentation;
- full-position executable capacity.

Then add Raydium/Meteora only in order of observed opportunity count.

## 7.4 Creator and entity flows

Persist decision-time and mark-time:

- creator balance;
- first buyers;
- common-funder clusters;
- same-transaction co-purchases;
- synchronized purchase clusters;
- shared fee payer;
- direct transfer graph;
- bundle linkage when legitimately observable;
- entity-adjusted top 1/5/10/20 supply;
- creator/cluster net selling;
- real SOL inflow and token distribution.

MemeTrans and SolRugDetector show that holding concentration, bundle/entity linkage, state changes, and organized behavior are core risk dimensions. Do not attempt to replace them with one provider score.

## 7.5 WSS risk trigger

Use `SOLANA_RPC_WS` with explicit commitment.

For every managed position:

- subscribe to verified pool/vault/token accounts;
- persist context slot and receive timestamp;
- trigger an immediate exact execution observation on material reserve, authority, fee, or creator-flow change;
- retain the regular cadence as a fallback.

Direct state is a trigger, not a substitute for executable price.

## 7.6 Unknown freshness is not fresh

Current code often computes:

```text
missing updatedAt -> sourceAgeMs = 0
```

Replace with explicit unknown state.

A missing source timestamp may be:

- soft risk in observe;
- separate cohort in paper;
- hard veto in canary/live when load-bearing.

Never turn absence into perfect freshness.

---

# P8 — REPAIR REJECT TRACKING

The current reject backtest treats disappearance from a provider as a total loss. Provider absence can reflect indexing/organic-score heuristics or an outage rather than zero executable value.

For each rejected candidate, preserve:

- actual reject-time price if available;
- direct pool/reserve state;
- exact route family;
- exact-size build outcome;
- executable full-position value;
- provider health;
- source coverage status.

At each horizon classify:

```text
EXECUTABLE_VALUE
NO_ROUTE_CONFIRMED
POOL_DRAIN_CONFIRMED
PROVIDER_MISSING
SOURCE_GAP
UNBUILDABLE
UNKNOWN
```

Only a chain-confirmed economically worthless state is a -100% outcome.

Do not choose the first later priced observation as the anchor when reject-time price is missing. That introduces a future anchor.

Use inverse-probability or explicit missingness sensitivity only when justified; never drop missing cases silently.

---

# P9 — REDUCE THE MULTIPLE-TESTING SURFACE

The current preregistration evaluates:

```text
4 policies × 7 sizes × 4 ATA-recovery scenarios = 112 cells
```

Fifty trades cannot select reliably across that grid.

## 9.1 Primary test

Freeze one deployable route family, one exact notional, one ATA treatment, and at most two policies:

```text
CONTROL
ONE MECHANISM-DISTINCT CHALLENGER
```

All other sizes and ATA cases are sensitivity analysis, not candidates.

The primary notional must be:

- within eventual canary constraints; or
- explicitly labeled research-only and incapable of promotion.

## 9.2 Fair counterfactual policy coverage

Every open position must receive a build/simulation-capable execution observation at every scheduled mark, or at every policy’s potential trigger boundary.

Do not build only when the control policy exits. That gives alternative policies no valid fill at their own trigger times.

For each policy:

1. trigger from information available at the mark;
2. apply frozen decision/build/submission latency;
3. execute at the first later same-family build-valid simulated observation;
4. enforce a maximum observation gap and maximum wait;
5. record `EXIT_BLOCKED` if none appears;
6. never reuse the trigger observation as its fill unless the frozen latency model permits it.

## 9.3 Make admissibility executable code

`confirmatory.admissible()` must enforce, not merely document:

- timestamp after the preregistration commit;
- exact clean source SHA;
- exact data-regime ID;
- exact strategy/config/risk/schema/adapter hashes;
- one route family;
- exact-size entry and exit;
- both entry and exit build success;
- full transaction-policy success;
- simulation success;
- raw payload hashes;
- complete mark sequence;
- maximum mark spacing;
- no source gaps;
- no disqualifying diagnostics;
- correct ATA accounting;
- no mixed contexts;
- no open/blocked position mislabeled closed.

A corpus of all-null contexts must not pass as “one regime.”

## 9.4 Statistical discipline

At 50 valid trades, report only diagnostics. Do not select a deployment policy.

Primary gate remains at least:

- 200 valid completed positions;
- 21 calendar days;
- multiple market conditions;
- positive untouched-holdout net expectancy;
- positive expected log growth;
- positive after top 1/3/5/10 removal;
- acceptable mint/day block intervals;
- no single trade/day dominating;
- positive under 2× costs;
- positive under latency and route-failure stress;
- positive under observed ATA-recovery failure;
- realizable portfolio positive, not only alpha shadow.

Record every tried strategy, age band, policy, size, feature set, and time filter in the multiple-testing ledger. Report PBO/deflated-performance diagnostics when the sample permits.

---

# P10 — TEST WHETHER THE CURRENT AGE BAND IS STRUCTURALLY WRONG

The current strategy targets 2–60-minute-old tokens.

That cohort has three structural disadvantages:

- Jupiter documents 50-bps fees for tokens under 24 hours on `/order`;
- Solana rug-pull research finds very short lifecycles and organized behavior;
- historical Epitaxy development rows contain catastrophic value collapse.

Do not silently change the production strategy. Collect parallel observe/shadow cohorts with no capital:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

Use identical executable-route accounting and risk features.

The 24h–7d cohort is especially important because it:

- crosses the new-token fee boundary;
- conditions on survival;
- provides time for holder/entity/liquidity behavior to become measurable.

Do not merge cohorts. Do not promote one from the same data that selected it.

The purpose is to determine whether the quickest path to positive expectancy is:

```text
better filtering inside 2–60m
or
moving to a lower-cost survivor regime
```

This may matter more than any exit-policy adjustment.

---

# P11 — ROUTE ECONOMICS BENCHMARK

For the same token, timestamp, and exact amount, compare:

```text
ORDER_EXECUTE quote benchmark
BUILD_CUSTOM Metis route
audited direct venue when available
```

For BUILD_CUSTOM broadcasters compare:

```text
ordinary dedicated RPC
Helius SWQOS-only
Helius default/Max
Jupiter /submit
Jito direct when legitimate
```

Use current actual requirements:

- Jupiter `/submit` requires at least 0.001 SOL tip and is likely uneconomic at 0.02–0.05 SOL;
- Helius SWQOS-only permits a much smaller tip;
- Helius default/Max has a larger tip floor;
- priority fees remain separate.

Measure:

- complete wallet-to-wallet output;
- DEX/program fee;
- platform fee;
- transfer fee;
- signature fee;
- priority fee;
- tip;
- ATA/rent;
- transaction size;
- simulation success;
- landing probability once canary eventually exists;
- latency;
- failed-attempt cost;
- route survival.

Do not purchase infrastructure. `docs/UPGRADE_ROI.md` must show that a paid resource recovers more expected profit than it costs.

## Direct PumpSwap adapter decision

Because all eight historical collapse cases routed through Pump.fun Amm, a direct PumpSwap adapter may have high information and execution value.

Build it only after:

- exact pool/account decoder;
- fee parity against mainnet observations;
- transaction policy;
- local simulation;
- route comparison;
- maintained program fingerprint;
- chaos tests.

A direct adapter should be enabled only if it materially improves all-in outcome without weakening safety.

---

# P12 — FIX REPORTS, CAPABILITY, AND DEPLOYMENT GATES

## 12.1 PnL eligibility

Current report/capability SQL says “both legs” but checks only a successful sell build.

Require:

- entry build ID;
- exit build ID;
- same execution family;
- full policy success;
- simulation success;
- context hashes;
- exact amounts;
- raw payloads;
- admissible mark sequence;
- no blocked lifecycle violation.

## 12.2 Reports

The default report must begin with current valid evidence:

```text
valid confirmatory positions
valid development positions
invalid historical positions
open positions
EXIT_BLOCKED positions
```

Do not show aggregated invalid historical PnL first and explain later that it is invalid.

Every report must identify:

- DB snapshot hash;
- source SHA;
- context hash;
- max row IDs;
- generated timestamp;
- current route family;
- exact sample inclusion query.

Avoid converting exact monetary sums through JavaScript `Number`.

## 12.3 Deployment gates

Current canary gates count all closed simulated positions and only require 72 hours.

Replace them with the actual evidence contract:

- 200 PnL-eligible current-context positions;
- 21 days;
- positive holdout net expectancy;
- expected log growth;
- profit factor;
- drawdown;
- top-winner fragility;
- cost/latency stress;
- build/simulation success;
- zero replay divergence;
- zero unresolved reconciliation;
- no critical security/execution finding;
- current route family can be executed at canary size;
- local acknowledgement for canary as well as live.

Replay gates must read a machine-generated replay result, not infer success from snapshot count.

Live promotion requires completed canary round trips, not merely confirmed transactions.

## 12.4 Executor truth

`apps/executor/src/main.ts` currently says the execution loop is not wired.

Keep canary/live unavailable until that loop exists and passes:

- exact intent;
- order/build;
- route-specific signing;
- partial-signature support or explicit JupiterZ exclusion;
- policy;
- effect simulation;
- submission;
- reconciliation;
- position creation;
- exit;
- ATA close;
- crash recovery.

Do not call the system “technically capable of canary” before that.

---

# P13 — EXECUTOR CORRECTIONS BEFORE ANY CANARY

1. `ORDER_EXECUTE` must submit through `/execute`, not direct RPC.
2. Support JupiterZ partial signing correctly or explicitly exclude it and measure the opportunity cost.
3. Do not derive a transaction’s last valid height from a different, freshly fetched blockhash. Persist the transaction/order’s real expiry metadata.
4. Resolve address lookup tables and inspect all loaded writable accounts.
5. Validate the complete transaction, not only static instructions.
6. Bind actual fee payer, input/output token accounts, receiver, and cleanup.
7. Reconcile wallet-reflected balances and `/execute` amount results.
8. Record actual failed transaction fees.
9. No new intent while any prior attempt is `UNKNOWN`.
10. One canary position maximum.

---

# P14 — SOURCE AND SCORE RESEARCH

The current deterministic score is a useful baseline, not a proven edge. Its weights and normalizations are hand-chosen.

Before tuning:

- fix the executable labels;
- build direct on-chain features;
- collect enough chronological data;
- preserve rejected and accepted cohorts.

Known current issues to repair:

- config says v0.3.0 while `STRATEGY_VERSION` constant still says v0.2.0;
- legacy signed impact still enters stored features;
- missing organic score is penalized both as a zero component and soft risk;
- averaging soft risks lets a new zero-risk feature dilute existing risk;
- provider-ranked feeds create attention/survivor selection;
- direct mint facts are not used by eligibility;
- market regime is not used.

Use the current score as a frozen baseline.

Only after labels exist, compare:

1. hard-gates-only;
2. current deterministic score;
3. calibrated logistic severe-loss model;
4. simple expected-return/continuation model;
5. maintained tree model only if it beats simpler baselines chronologically.

Risk and return targets remain separate. No LLM in the live loop.

---

# P15 — OPERATIONS AND SUPPLY-CHAIN HARDENING

The private `master` branch is currently unprotected and no CI workflow is visible.

Add:

```text
.github/workflows/ci.yml
```

At minimum:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test -- --run
pnpm replay against committed fixtures
pnpm secretscan
pnpm check
```

Add a bounded mutation subset for every safety-critical PR.

Protect `master`:

- require CI;
- require clean linear history or reviewed PR;
- disallow force pushes;
- disallow deletion;
- require manual release promotion for any signer artifact.

Create a release manifest containing:

- source SHA;
- dirty flag;
- Node/pnpm versions;
- lockfile hash;
- config/risk/schema hashes;
- binary/script hashes;
- test counts/results;
- replay result;
- known blockers.

Add a concise README with:

- paper-only status;
- exact commands;
- current evidence count;
- no profitability claim;
- recovery commands.

Archive or move the unrelated graduation-edge directive from the Epitaxy root so Claude cannot inherit wrong-project instructions again.

## Windows continuous operation

Add a documented Task Scheduler or service setup that:

- starts paper mode at boot/login;
- restarts on failure with bounded backoff;
- uses the correct working directory;
- writes logs;
- never starts canary/live;
- detects an existing process lock;
- runs reconciliation before discovery.

Power settings reduce sleep risk; they do not replace crash/reboot recovery.

---

# P16 — REQUIRED TESTS

Add tests that fail against the current defects:

1. `/order` price plus `/build` instructions cannot form one observation.
2. probe-size quote cannot price a different entry size.
3. included Jupiter fee cannot be deducted twice.
4. entry signature fee cannot be omitted.
5. build raw payload hash must link to build attempt.
6. instruction hash changes when `isSigner` changes.
7. instruction hash changes when `isWritable` changes.
8. provider 429 remains provider failure.
9. `EXIT_BLOCKED` remains managed.
10. unbuildable exit cannot close or release capital.
11. resync cannot clear after provider failure.
12. alpha-shadow opens after portfolio refusal.
13. alpha-shadow position is tracked independently.
14. canary shadow uses canary size/config.
15. aggregate planned loss includes proposed trade.
16. catastrophic-loss floor bounds size.
17. canary cannot be looser than live.
18. unknown holder owner is not treated as verified-safe program inventory.
19. missing `updatedAt` is unknown, not zero age.
20. entry gate never applies `Math.abs` to signed impact.
21. PnL eligibility requires entry and exit builds.
22. PnL eligibility requires simulation.
23. all-null contexts fail single-regime check.
24. pre-preregistration row fails admissibility.
25. mark gap above threshold fails admissibility.
26. alternative policy receives its own later build-valid fill.
27. trigger observation cannot be reused illegally as fill.
28. provider disappearance is not automatically -100%.
29. `/order` transaction is sent only through `/execute`.
30. JupiterZ partial signature is preserved or route explicitly refused.
31. actual transaction expiry is persisted.
32. ALT-loaded writable accounts are inspected.
33. invalid historical PnL never appears in current aggregate.
34. release gate reads actual replay result.
35. executor cannot start merely because 200 invalid old positions exist.

Run full:

```bash
pnpm check
pnpm replay
pnpm doctor
pnpm health
pnpm capability -- --mode=paper
pnpm report
```

Run mutation tests against each repaired defect.

---

# P17 — START THE NEW VALID WINDOW

Only after P0–P16:

1. commit all fixes;
2. require a clean tree;
3. produce release/context hashes;
4. run all gates;
5. back up the database;
6. create a new context and preregistration;
7. restart paper;
8. verify first exact-size entry build/simulation;
9. verify first mark build/simulation;
10. verify an intentionally forced EXIT_BLOCKED stays managed;
11. verify alpha-shadow and portfolio-paper diverge correctly on a refused signal.

The primary experiment should be deliberately small:

```text
one route family
one exact deployable notional
one control policy
one challenger
one primary ATA treatment
```

Collect other sizes, age cohorts, and route families as labeled shadow/sensitivity arms.

Do not reset the multiple-testing ledger.

---

# REQUIRED FINAL RESPONSE

At the end, report:

1. exact local repo path, branch, starting HEAD, ending HEAD;
2. whether local work was ahead of GitHub;
3. backup path/hash/integrity result;
4. open/blocked position handling;
5. why the old P2b window was invalidated;
6. selected primary execution family;
7. proof that quote, build, policy, simulation, and fill share one observation;
8. exact cost-accounting equation;
9. exact entry/exit/ATA treatment;
10. state-machine tests;
11. alpha-shadow proof;
12. canary-shadow proof;
13. on-chain risk fields now wired;
14. pool/creator/entity coverage;
15. route benchmark results;
16. current canary-size viability;
17. new primary preregistration;
18. new context hash/start time;
19. current valid trade/day count;
20. every unresolved blocker;
21. exact commands to monitor/restart/stop;
22. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_CONFIRMATORY_COLLECTION_STARTED
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

Do not enable canary or live. Do not fund a wallet. Do not describe the strategy as profitable from quote-only observations, development data, or a newly restarted empty experiment.
