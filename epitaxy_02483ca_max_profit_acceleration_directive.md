# CLAUDE CODE DIRECTIVE — EPITAXY 02483CA: FROM EFFECT PROOF TO MAXIMUM EXPECTED LOG GROWTH

**Repository:** `TateLyman/epitaxy`  
**Audited committed `master`:** `02483ca45b2c40a98637f88c01d8bbef5e1c5496`  
**Date:** 2026-08-13  
**Operator:** legally able to trade  
**Repository visibility:** explicitly out of scope; spend zero time changing or discussing it  
**Current honest state:** `MEASUREMENT_REPAIR_REQUIRED`  
**Current proof-harness result:** 5 Pump/PumpSwap-family buys + 5 sells, 8/10 `SIMULATED_EFFECT_OK`, 2 route/economic refusals, 0 apparatus failures  
**Current strategy evidence:** 0 valid production round trips, 0 confirmatory positions, no repaired prospective evidence window  
**Primary objective:** maximize the probability and speed of reaching positive, robust, all-cost expected log growth—not maximize code volume, test count, apparent trade count, or paper NAV  
**Secondary objective:** prove quickly when an arm is economically dead so collection can be reallocated rather than defended

Execute this directive. Do not return a plan in place of work.

The next milestone is not “more architecture” and not “more tests.” It is:

```text
the running production paper loop books the exact economic settlement
that its simulator effect-verified,
then produces clean, shared-path, all-cost development trajectories
across the four age cohorts
while an isolated worker solves Pump offline replay in parallel
```

The repository has repeatedly implemented the correct pure module, tested it, and then left the running engine calling older duplicated logic. That pattern is now itself a release-blocking defect.

From this directive onward:

```text
IMPLEMENTED
=
production caller exists
+ production caller is the only caller for that behavior
+ live row proves the behavior
+ report reads that row
+ mutation test kills the behavior
```

A module, schema column, view, artifact, test, or comment without that chain is not completed.

The only allowed final states are:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_EFFECT_LABELS_RUNNING
PUMP_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`LIVE_READY` is forbidden.

No wallet funding, signing, submission, canary, or live trading during this directive unless the complete machine-generated `CANARY_READY` state is genuinely reached after an untouched confirmatory window. Passing tests, accumulating JIT rows, or solving S050 does not itself authorize capital.

---

# 0. THE ACTUAL FINDINGS AT `02483CA`

Treat these as hypotheses to verify against the local machine before changing anything.

## 0.1 What Claude genuinely fixed

The merged work established:

```text
10 current Pump-family proof legs
8 effect-verified
2 route/economic refusals
0 instrument/setup failures
```

It repaired:

- token-account-pubkey versus owner/mint balance identity;
- legacy Token versus Token-2022 identity;
- native-SOL sell output semantics;
- exact token provisioning above `2^53`;
- source ATA rent double counting;
- priority-fee suppression;
- JIT snapshot persistence;
- several effect-verification and accounting defects.

These repairs are valuable. Preserve them.

## 0.2 What is still not production-correct

The current production `paper.ts` still appears to:

1. implement entry separately from `paper-core.ts`;
2. derive acquired tokens from `netMinimumOutput(entry)` rather than the simulator’s measured token credit;
3. request the immediate sell for that router-derived amount rather than the exact measured acquired balance;
4. compute the exact same-family round-trip loss and merely log it;
5. open even when that exact measured round trip would breach the configured `maxRoundTripLossBps`;
6. book entry cost from assumed signature/priority/rent/failure fields instead of the effect-verified settlement;
7. book exit proceeds from router `expectedOutput` rather than the measured native-SOL credit;
8. default unknown transfer economics to zero in runtime paths;
9. create fills and positions describing different economics from the simulation that admitted them.

The current shadow loop appears to:

1. close at the same observation that triggered the exit;
2. bypass `shadow-lifecycle.ts`;
3. bypass `fill-latency.ts`;
4. use a local peak/stop-only `nearTrigger`;
5. warn on backlog but continue admissions;
6. duplicate identical alpha/canary observations;
7. use structural router values instead of measured effect settlements;
8. never produce valid production round-trip evidence.

The current pipeline appears to:

1. define four cohorts in `cohort.ts`;
2. define a retained queue in `cohort-queue.ts`;
3. still call `maturingMints` only for the configured 2–60 minute range;
4. therefore collect no production data for 1h–5h, 5h–24h, or 24h–7d.

The current risk alarm appears to:

1. exist in `risk-alarm.ts`;
2. not be constructed by the running paper engine;
3. claim `unwatch` sends unsubscribe while `AccountWatcher.unwatch()` only deletes local state;
4. permit duplicate reconnect scheduling from error + close;
5. hash only slot/data length/lamports rather than full account state.

The explicit PnL migration appears to:

1. add `net_pnl_lamports`, `execution_cost_lamports`, and `gross_proceeds_lamports`;
2. leave `insertPosition()` and `updatePosition()` writing only the old fields;
3. leave the running engine unable to populate the new columns;
4. make readiness rely on fallbacks around ambiguous historical semantics.

The canonical confirmatory view appears to:

1. join `simulation_jobs` directly and risk duplicating one position when a leg has multiple qualifying jobs;
2. omit durable replay-manifest/readback requirements;
3. omit supported capability fingerprint;
4. omit exact preregistered context/window;
5. omit trigger→later-fill lifecycle proof;
6. omit mark-coverage SLA;
7. omit known `execution_cost_lamports`;
8. omit a canonical measured settlement link.

Readiness appears to:

1. fix the double-principal subtraction;
2. fix the basic 2× cost stress;
3. add distinct-day and day-block bootstrap logic;
4. still calculate drawdown from cumulative PnL starting at zero rather than actual starting NAV;
5. still sum every historical closed `canary_shadow` without current-context, cohort, policy, notional, and evidence-class filtering;
6. still convert some bigint ratios through JavaScript `Number`.

The checked-in artifacts appear stale:

```text
release-manifest source: old dirty commit
tests.run: false
obsolete simulator blocker language
rate-budget: zero calls
cohort status: only 2m–60m
shadows: all STRUCTURAL_ONLY
reject panel: no EXECUTABLE_VALUE rows
```

Verify each item. Correct the audit if the local machine differs. Do not preserve a false criticism for rhetorical symmetry.

---

# 1. PROFITABILITY PRINCIPLES

Every implementation choice is ranked by:

```text
expected increase in correct decision quality
× labels generated per unit time
× economic relevance
÷ engineering time
÷ risk of corrupting the corpus
```

The shortest path to profit is:

```text
correct settlement
→ correct trajectories
→ broad regime comparison
→ kill bad arms
→ select one arm once
→ untouched confirmation
→ microscopic canary
```

Not:

```text
more features
→ more tests
→ more dashboards
→ more infrastructure
→ hope
```

## 1.1 Optimize the objective that compounds

Primary strategy objective:

```text
expected log growth after:
  protocol fees
  creator fees
  LP fees
  transfer fees
  priority fee
  signature fee
  tips
  rent loss
  failed attempts
  reaction/build/submission latency
  partial fills
  blocked exits
  residual balances
```

Secondary objectives:

```text
minimize catastrophic-loss incidence
minimize exit-block probability
maximize robustness across mints and days
maximize valid labels/day
```

Do not optimize arithmetic mean profit while repeated betting loses wealth.

## 1.2 Treat the current 2–60 minute arm as a control, not the favored strategy

The checked-in historical canary shadows show a very large negative aggregate. The corpus is contaminated by structural-only routes, unpriced marks, look-ahead exits, old accounting, portfolio halts, and mixed contexts, so it is not a valid estimate.

It is still a brutal prior.

Do not spend the next week defending the 2–60 minute thesis.

The current “delayed momentum” score is not actually a momentum score. Its positive components are:

```text
breadth
liquidity
organic score
tradability
freshness
```

Positive price continuation is not a positive component; price change mostly appears as exhaustion risk.

Call the current score what it is:

```text
young-token quality heuristic
```

and test it as a control.

## 1.3 Separate universe, trajectory, entry policy, exit policy, and sizing

One market path should support multiple policy evaluations.

Do not open separate network-intensive “positions” merely because two policies want to observe the same mint, at the same cohort, route, notional, and time.

Canonical unit:

```text
trajectory_id =
mint
+ cohort
+ protocol state
+ route fingerprint
+ fixed notional
+ entry observation time
```

A trajectory stores the market path.

Policies attach decisions to it.

This prevents:

- duplicate Jupiter calls;
- policy-dependent data quality;
- unequal mark cadence;
- one arm seeing a different market than another;
- counting one signal as many trades.

---

# 2. P0 — PRESERVE AND VERIFY THE LOCAL MACHINE

Before edits, save:

```powershell
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -60
git diff
git diff --cached
node --version
pnpm --version

pnpm status
pnpm health
pnpm audit:state
pnpm simulation:audit
pnpm simulator:doctor
pnpm pump:effect-proof
pnpm capability:matrix
pnpm shadow:status
pnpm cohort:status
pnpm reject:status
pnpm cost:surface
pnpm rate:budget
pnpm readiness
pnpm release:manifest

wsl --status
wsl -l -v
```

Record:

- local HEAD versus `02483ca45b2c40a98637f88c01d8bbef5e1c5496`;
- working-tree state;
- Windows engine PID/start time/command/cwd;
- WSL simulator PID/start time/distro/kernel/command;
- simulator identity;
- database/WAL/SHM paths;
- exact schema/config/risk/provenance/engine/adapter/accounting/effect/simulator versions;
- all nonclosed positions and shadows;
- latest simulation jobs by validity/side/purpose/effect;
- latest health events;
- disk space;
- CI result;
- current artifacts and their source commits.

Take and verify a WAL-consistent backup.

Persist:

```text
path
bytes
sha256
integrity_check
foreign_key_check
table-count witnesses
maximum timestamps/ids
nonterminal exposure
```

Do not run migrations unless the backup reads back successfully.

Create:

```text
docs/AUDIT_HEAD_02483CA.md
artifacts/baseline-02483ca.json
```

Commit the baseline before semantic edits.

---

# 3. P1 — CLOSE THE CURRENT PRODUCTION WINDOW

The proof harness is valid development of the instrument.

The running strategy has no valid production round trip.

Close all strategy rows through the final production-settlement repair as:

```text
INSTRUMENT_DEVELOPMENT
or
STRUCTURAL_ONLY
```

Preserve every row.

Create:

```text
docs/02483CA_PRODUCTION_WINDOW_INVALIDATION.md
```

Record:

- source commits/contexts;
- exact reason each row cannot estimate strategy expectancy;
- which rows came from the proof harness;
- which rows came from production;
- whether entry amount, sell amount, costs, trigger, and fill were measured or assumed;
- whether lifecycle and mark SLA held.

No threshold, weight, cohort, notional, or exit policy may be selected from invalid rows.

A new data regime must begin only after P2–P8 pass.

Semantic changes require a real strategy/version bump. Do not keep calling materially different behavior `delayed-momentum-v0.4.0`.

---

# 4. P2 — ONE CANONICAL MEASURED LEG SETTLEMENT

Create one type owned by the domain layer:

```ts
interface MeasuredLegSettlement {
  observationId: string;
  simulationJobId: string;
  side: 'buy' | 'sell';
  family: RouteFamily;
  capabilityFingerprint: string;

  input:
    | {
        kind: 'native_sol';
        requestedLamports: bigint;
        actualTradeDebitLamports: bigint;
        totalPayerDebitLamports: bigint;
      }
    | {
        kind: 'token';
        mint: string;
        tokenProgram: string;
        tokenAccount: string;
        requestedAtoms: bigint;
        actualDebitAtoms: bigint;
      };

  output:
    | {
        kind: 'native_sol';
        minimumLamports: bigint;
        expectedLamports: bigint | null;
        actualCreditLamports: bigint;
      }
    | {
        kind: 'token';
        mint: string;
        tokenProgram: string;
        tokenAccount: string;
        minimumAtoms: bigint;
        expectedAtoms: bigint | null;
        actualCreditAtoms: bigint;
      };

  costs: {
    baseFeeLamports: bigint;
    priorityFeeLamports: bigint;
    tipLamports: bigint;
    protocolFeeLamports: bigint | null;
    creatorFeeLamports: bigint | null;
    lpFeeLamports: bigint | null;
    platformFeeLamports: bigint;
    transferFeeAtoms: bigint | null;
    transferFeeLamportsEquivalent: bigint | null;
    rentCreatedLamports: bigint;
    rentRecoveredLamports: bigint;
    failedAttemptCostLamports: bigint;
    unexplainedLamports: bigint;
  };

  createdAccounts: readonly string[];
  closedAccounts: readonly string[];
  residualTokenAtoms: bigint | null;
  fullAccountCoverage: boolean;
  effectValid: boolean;
  effectRefusals: readonly string[];
  snapshotManifestHash: string | null;
  replayable: boolean;
}
```

The exact shape may differ. The invariants may not.

## 4.1 Canonical source

This settlement is derived only from:

```text
one exact observation
+ one completed simulation job
+ the persisted structured pre/post state
+ the exact economic request
```

Never derive it from router amounts after effect verification.

Never permit:

```text
simulation says one amount
paper position books another
```

## 4.2 One derivation function

Create one audited function/view:

```text
measuredSettlementOf(observationId, jobId)
```

Every runtime/research path reads it.

No caller recomputes:

```text
actual input
actual output
fees
rent
residual
```

## 4.3 Completeness

A settlement is incomplete if any money-critical quantity is unknown.

For a PnL-eligible leg:

```text
complete == true
effectValid == true
fullAccountCoverage == true
unexplainedLamports == 0
```

An explicit family fact may be zero:

```text
BUILD_CUSTOM Jupiter platform fee = 0
```

An unobserved value may not become zero.

## 4.4 Production request must use asset-aware bounds

Audit `apps/engine/src/simulate-observation.ts`.

The production request still appears to construct the compatibility form:

```text
mint + minTokenDelta
```

Replace it with the same asset-aware request semantics proven by P3.

Require the request hash to bind:

```text
side
input asset kind
output asset kind
input/output mints
token programs
source/destination accounts
exact input
minimum output
expected output
route family
fingerprint
expected recipients
declared tip
allowed created/closed accounts
```

The proof harness and production must build the same request through one function.

Delete compatibility fallback from any path that can produce a valid label.

---

# 5. P3 — PRODUCTION ENTRY MUST BOOK THE VERIFIED ROUND TRIP

Replace the manual production entry with one function in `paper-core.ts`.

Required sequence:

```text
screening candidate
→ exact BUILD_CUSTOM buy observation
→ exact buy simulation
→ measured buy settlement
→ exact acquired token amount = measured token credit
→ exact same-family sell observation for exactly that amount
→ exact sell simulation
→ measured sell settlement
→ one all-in immediate round-trip calculation
→ rerun exact tradability/cost gate
→ portfolio/risk admission
→ position + fills
```

## 5.1 Actual token amount

Forbidden:

```text
tokensReceived = netMinimumOutput(entry)
tokensReceived = router expected output
```

Required:

```text
tokensReceived = measured buy output credit
```

The router expected/minimum values remain benchmark and bound fields.

## 5.2 Exact immediate sell

The entry sell amount is exactly the measured token credit.

If the simulator reports a partial credit, either:

```text
book the explicit partial outcome under a separate policy
or
refuse the entry
```

Do not pretend it was a full fill.

## 5.3 Tradability gate must actually gate

The current engine appears to calculate immediate round-trip loss and only log it.

That is forbidden.

Compute:

```text
roundTripCashOut
roundTripCashIn
netImmediateRoundTripPnl
roundTripLossBps
```

from measured settlements and canonical accounting.

Then rerun:

```text
maxRoundTripLossBps
maxPriceImpactBps
route/capacity
all costs known
```

before opening.

A 401 bps loss against a 400 bps cap is refused.

No “close enough.”

## 5.4 Actual fill rows

The entry fill stores:

```text
actualInAmount = measured actual input
actualOutAmount = measured actual output
fees = measured
rent = measured
simulation job link
settlement link
```

The position stores the exact same amounts.

Add referential constraints so a position cannot point to a fill or settlement describing a different amount/family/observation.

## 5.5 One core

`paper.ts` may not contain entry economics.

It constructs collaborators and calls:

```text
admitPortfolioEntry()
```

The running process and tests execute the same function.

Add a dynamic integration test that starts the paper shell with fake dependencies and proves the entry call reaches that core.

A source substring is not sufficient.

---

# 6. P4 — EXPLICIT PNL FIELDS MUST BE WRITTEN BY PRODUCTION

Migrate runtime writers, not only schema.

Canonical position fields:

```text
entry_cash_out_lamports
locked_rent_lamports
exit_cash_in_lamports
gross_proceeds_lamports
execution_cost_lamports
net_pnl_lamports
```

Add equivalent fields to shadow trajectories/outcomes.

## 6.1 Runtime writer

Update:

```text
insertPosition
updatePosition
insertPositionExit
closeShadowPosition
ledger writers
fill writers
```

to populate explicit fields.

For every new closed row:

```text
net_pnl_lamports
=
exit_cash_in_lamports
-
entry_cash_out_lamports
```

with locked/recovered rent treated once.

## 6.2 No fallback in new contexts

Historical reports may use a clearly labeled legacy fallback.

Rows from the new regime must fail readiness if explicit fields are null.

## 6.3 Accounting source

One function calculates:

```text
entry cash out
exit cash in
execution cost
locked rent
net PnL
```

and is used by:

```text
paper runtime
shadow runtime
backtest
report
readiness
future canary
```

Add a call-graph test preventing another implementation.

## 6.4 First-use versus repeat-use costs

Pump/PumpSwap transactions can create:

```text
ATA
volume accumulator
quote-token ATA
other per-wallet/per-mint state
```

Separate:

```text
one-time wallet setup
one-time per-mint setup
recurring trade cost
recoverable rent
unrecoverable rent
```

A first trade and repeat trade are different cases.

Persist which case each leg used.

## 6.5 Failure cost

Actual failed attempts are charged directly.

Expected failure cost for sizing comes from:

```text
attempt count
landed failures
conditional landed failure fee
upper confidence bound
```

Do not charge a full assumed failure to every successful leg.

---

# 7. P5 — MAKE `PAPER.TS` A PROCESS SHELL

Move all decisions into importable production core modules.

`paper.ts` should own only:

```text
startup
dependencies
scheduling
health
shutdown
I/O
```

Core owns:

```text
portfolio entry
portfolio mark
portfolio trigger
portfolio later fill
blocked retry
shadow admission
shadow mark
shadow trigger
shadow later fill
cohort due processing
risk alarm handling
```

Delete duplicated arithmetic and lifecycle logic from `paper.ts`.

The current partial import of mark/exit helpers is not enough.

## 7.1 Required proof

Produce a machine-generated call graph:

```text
production process → core function → settlement/accounting function → writer
```

and a test that executes each chain.

## 7.2 Module completion gate

For every decision-bearing module:

```text
non-test importer count > 0
live invocation count > 0
live row/event count > 0
```

`no-dead-modules.test.ts` must fail when a pure module is imported only as a type or decorative call.

---

# 8. P6 — SHADOWS BECOME SHARED MARKET TRAJECTORIES

Do not use the old shadow corpus for edge estimates.

Create a new trajectory model.

## 8.1 One path, multiple policies

For one:

```text
mint
cohort
protocol state
route fingerprint
notional
entry time
```

collect one sequence of exact observations.

Attach:

```text
current-score entry policy
hard-gates-only benchmark
mechanistic challenger
control exit
challenger exit
```

without duplicating market data.

## 8.2 Lifecycle

Use `shadow-lifecycle.ts` in production.

Required:

```text
POSITION_OPEN
→ EXIT_TRIGGERED
→ AWAITING_FILL_OBSERVATION
→ POSITION_CLOSED
or
→ EXIT_BLOCKED
```

A trigger may never close directly.

## 8.3 Fill

Use `fill-latency.ts` in production.

The fill is:

```text
first later
same-family
effect-valid
priced
observation
after frozen latency
```

The trigger observation is never its own fill.

Persist:

```text
trigger observation
trigger time
fill observation
fill time
realized latency
look-ahead bias avoided
```

## 8.4 Selective simulation

Do not simulate every ten-second mark.

Simulate:

- every entry buy;
- every immediate entry sell;
- every prospective trigger;
- the first later fill candidate;
- every blocked retry;
- every WSS emergency alarm;
- route/account/program changes;
- a preregistered random calibration sample of ordinary marks.

Structural/direct marks can schedule work.

Only effect-valid fills create valid PnL.

## 8.5 Scheduler

Use the production `shadow-lifecycle.nearTrigger()` or one canonical replacement.

Urgency uses:

```text
latest executable value
peak
stop distance
trail distance
take-profit distance
time to maximum hold
unpriced state
blocked/triggered state
overdue duration
```

## 8.6 Backlog

When required marks exceed capacity:

```text
stop new trajectory admission
record skipped eligible episodes
record inclusion probability
preserve triggered/blocked positions first
```

Do not silently stretch cadence.

## 8.7 No duplicate alpha/canary calls

Identical books at identical size share:

```text
entry
marks
trigger observations
fill observations
```

They may carry different policy tags, not different market facts.

---

# 9. P7 — FIX SIGNAL IDENTITY

The current fifteen-minute bucket can count the same sustained opportunity as several trades.

Canonical signal identity must bind:

```text
mint
cohort
entry-policy version
protocol-state episode
```

A new episode requires a real state transition, such as:

```text
new cohort
bonding curve → PumpSwap migration
position fully closed + frozen re-entry cooldown
a preregistered new signal after the prior signal ended
```

It does not arise merely because wall time crossed a bucket.

Report how many historical “trades” collapse into one episode under the corrected identity.

Do not use that count to tune thresholds.

---

# 10. P8 — TEN PRODUCTION ROUND TRIPS BEFORE THE WINDOW STARTS

The proof harness is not enough.

Run the actual paper production loop with fake capital/no signer until it generates:

```text
10 complete entry buy/sell pairs
```

through the exact code that will collect development data.

Required per pair:

```text
buy measured settlement
sell measured settlement
same family
exact measured amount handoff
complete measured costs
round-trip gate applied
position/fill row if admitted
explicit PnL fields
snapshot manifest
no apparatus failure
```

Include:

- legacy Token;
- Token-2022;
- native-SOL sell output;
- ATA creation;
- pre-existing ATA;
- amount above `2^53`;
- at least one economic refusal;
- at least one accepted pair if the market supplies one.

The test is not “ten passes.”

It is:

```text
every result is either:
  complete accepted economics
or
  complete economic/route refusal

zero apparatus failures
zero router/simulator/booked-amount divergence
```

Create:

```text
artifacts/production-roundtrip-proof.json
docs/PRODUCTION_ROUNDTRIP_PROOF.md
```

Only then start the new JIT development regime.

Expected next state:

```text
VALID_EFFECT_LABELS_RUNNING
```

---

# 11. P9 — DIRECT PUMP/PUMPSWAP IS THE THROUGHPUT FAST PATH

Jupiter is useful for discovery, cross-checking, and unsupported-route fallback.

It should not be required for every ten-second Pump mark forever.

Build a parity-proven direct Pump adapter.

## 11.1 Pin current official sources

Pin:

```text
pump-fun/pump-public-docs
commit 9c82f61cb711b044a17f770ab8ce9f9bdf78f333
```

Vendor or checksum:

```text
pump IDL
pump_amm IDL
pump_fees IDL
official SDK versions
```

Record source hashes in every direct-route context.

## 11.2 Support current Pump V2 semantics

Implement current official buy/sell interfaces, including:

```text
native SOL quote
USDC quote
legacy Token
Token-2022
global/global_volume_accumulator
user_volume_accumulator
fee_config
sharing_config
creator vault
buyback/fee recipient accounts
exact slippage bounds
```

Do not assume the old fixed account list.

## 11.3 Dynamic fees

Read the on-chain fee configuration.

For bonding curve:

```text
market cap from mint supply and virtual reserves
dynamic protocol/creator fee tier
```

For canonical PumpSwap:

```text
canonical-pool identity
base supply
base reserve
effective quote reserve
dynamic LP/protocol/creator fee tier
```

Do not hardcode one historical fee percentage.

## 11.4 Effective PumpSwap reserves

Use current official semantics:

```text
effective quote reserve
=
quote vault reserve
+
virtual_quote_reserves
```

where applicable.

Validate canonical pool/vault identities.

## 11.5 Mayhem

Persist:

```text
Mayhem enabled
Mayhem agent/program/fee-recipient identities
agent balance
agent net buying/selling
additional supply
burn transition
hours since creation
```

Mayhem random trading may not count as organic breadth, momentum, maker growth, or holder growth.

## 11.6 Direct quoter parity

The existing direct Pump quoter differs from Jupiter by roughly 123–257 bps.

That is not parity.

For each supported fingerprint compare:

```text
Epitaxy direct quote
official SDK quote
Jupiter BUILD_CUSTOM response
effect-verified simulation settlement
settled on-chain swaps when available
```

Across:

```text
buy/sell
multiple sizes
multiple mints
bonding curve
canonical PumpSwap
legacy Token
Token-2022
SOL/USDC quote
fee tiers
```

Required:

```text
exact integer agreement where the official SDK is deterministic
or
a documented bounded difference attributable to timing/slot
```

No 100+ bps unexplained residual.

## 11.7 Direct builder

Only after quote parity:

- construct exact official instructions;
- apply the same policy decoder;
- simulate through the same settlement path;
- fingerprint the exact program/account shape;
- never sign or submit in paper mode.

## 11.8 Use in production

After parity:

```text
WSS/RPC direct state
→ cheap exact direct mark
```

At entry, trigger, and fill:

```text
exact direct build
→ policy
→ effect-valid simulation
```

Jupiter remains:

```text
discovery
benchmark
fallback
cross-check
```

This is the largest plausible increase in valid labels/day and mark quality.

---

# 12. P10 — WIRE THE ACTUAL ON-CHAIN RISK FACTS

## 12.1 Mint facts

The production `cycle.ts` must fetch direct mint facts for promoted candidates and pass them into `screenCheap`.

Provider flags are comparison fields, not the authoritative verdict.

Persist disagreements.

## 12.2 Token-2022

Decode current money-critical extensions:

```text
transfer fee
permanent delegate
default frozen state
non-transferable
transfer hook
confidential transfer
pausable
permissioned burn
unknown future extension
```

Development:

```text
separate unknown cohort
```

Capital modes:

```text
hard refusal
```

## 12.3 Entity concentration

The current direct concentration implementation classifies top token accounts but does not run the real entity clustering module.

Build and persist:

```text
top raw addresses
top entities
unknown-history share
common funder links
shared fee payer
same-transaction co-purchase
direct transfers
creator cluster
Mayhem agent cluster
net cluster selling
```

Only canonical verified market inventory is excluded from concentration.

An unresolved owner stays risk-bearing.

## 12.4 Creator behavior

Persist:

```text
creator balance
creator first buy
creator net flow
creator sells in 1m/5m/30m windows
creator prior launches
prior-launch survival/rug outcomes
```

Use only directly observed facts.

## 12.5 First-buyer/bundle behavior

Capture early buyer entities and bundle/co-purchase structure.

Use persistent sniper/ring identity as:

```text
risk/context
```

not automatically as positive alpha.

Association with profitable flow can be selection-confounded.

---

# 13. P11 — WIRE AND REPAIR THE WSS ALARM

Construct `ReserveAlarm` from the running paper engine for every open/triggered/blocked supported Pump trajectory.

Fix:

- real `accountUnsubscribe` on unwatch;
- single-flight reconnect;
- one reconnect timer;
- full state hash;
- subscription acknowledgement/timeout;
- epoch reset;
- no stale pending request IDs;
- explicit coverage intervals;
- duplicate-notification handling.

A slot gap is not proof an account update was missed.

Record it as:

```text
time/slot coverage uncertainty
```

On material reserve/authority/mint/creator change:

```text
enqueue immediate same-family exact observation
```

Raw WSS data never becomes a fill.

Watch:

```text
bonding curve / pool reserves
mint account
fee config
creator vault
Mayhem agent account
critical authorities
```

prioritized by exposure.

---

# 14. P12 — FOUR COHORTS MUST RUN IN PRODUCTION

Use the retained queue in the actual pipeline.

Cohorts:

```text
2m–60m
1h–5h
5h–24h
24h–7d
```

The same mint should be reconsidered once in each cohort when still available.

The configured 2–60 minute max age may no longer prevent older cohort screens.

## 14.1 Same economics

Every cohort uses the same:

```text
route family
notional
settlement
cost accounting
risk facts
trajectory model
exit policies
evidence rules
```

## 14.2 Protocol-state strata

Also persist:

```text
bonding curve
migration transition
canonical PumpSwap
noncanonical/unsupported
minutes since migration
```

Do not pool those blindly.

## 14.3 Mayhem strata

Within the first 24 hours:

```text
Mayhem
non-Mayhem
unknown
```

At 24h–7d record whether Mayhem supply burn completed.

## 14.4 Balanced initial allocation

Until each age cohort has 25 valid trajectories:

```text
serve the least-complete cohort first
```

Do not let 2–60m consume the budget merely because it appears first.

After 25 per cohort, use preregistered successive elimination.

---

# 15. P13 — PREREGISTER THE FASTEST USEFUL STRATEGY TOURNAMENT

Do not launch dozens of parameter arms.

One shared trajectory can evaluate a small number of mechanism-distinct policies.

## 15.1 Entry policies

Run exactly these initial policies:

### A. `HARD_GATES_ONLY_RANDOM`

A contemporaneous eligible benchmark.

- hard safety/tradability gates;
- no opportunity-score selection;
- randomized when the budget cannot admit all;
- inclusion probability persisted.

This answers whether the score adds anything.

### B. `CURRENT_QUALITY_SCORE_CONTROL`

The current v0.4 score, unchanged except mathematical defects.

Do not rename it momentum.

### C. `SURVIVOR_FLOW_CONTINUATION_V1`

A frozen mechanistic challenger using only pre-entry facts:

- current route effect-valid and under the exact cost cap;
- positive net buyer persistence across non-overlapping windows;
- positive or stable holder growth;
- positive or stable real liquidity/quote reserves;
- price continuation positive but not vertical/exhausted;
- no creator/entity/Mayhem-agent material net selling;
- concentration below the frozen cap;
- no adverse authority/extension change;
- protocol state and cohort explicit.

Prefer rank/quantile rules computed within contemporaneous cohort over arbitrary global units, but freeze them before observing development outcomes.

The policy must have a concise causal story:

```text
new independent demand
+ improving exit capacity
+ no informed supply hitting the pool
```

Do not create a kitchen-sink score.

## 15.2 Exit policies

Start with one control exit policy across all three entry policies:

```text
current stop/trail/take-profit/max-hold rules
implemented with trigger→later-fill semantics
```

After 25 valid trajectories per cohort, add at most one mechanism-distinct challenger:

```text
flow/liquidity deterioration exit
```

It may trigger on:

- creator/entity net selling;
- real reserve/liquidity deterioration;
- net buyer reversal;
- WSS critical change;
- route/capacity loss.

It still fills at a later effect-valid observation.

## 15.3 No outcome-based threshold tuning

Before the new window:

- write every threshold;
- write why it exists;
- write the multiple-testing ID;
- write the selection/elimination rule.

After outcomes arrive, thresholds do not move.

A later version is a new experiment.

## 15.4 Sampling

When API/simulator capacity is scarce, use randomized stratified sampling.

Persist:

```text
eligible count
admitted count
selection probability
cohort
policy eligibility
reason not admitted
```

This allows inverse-probability sensitivity analysis and prevents “the API happened to choose the sample.”

---

# 16. P14 — SIZE CALIBRATION BEFORE BROAD COLLECTION

The current 0.02 SOL notional may be too small for fixed costs and too large for the thinnest pools.

Run a separate development-only size calibration on a preregistered sample.

Sizes:

```text
0.01 SOL
0.02 SOL
0.05 SOL
0.10 SOL
```

For direct Pump parity-capable routes, quote all sizes from one state snapshot.

For each size measure:

```text
protocol/creator/LP fees
network costs
rent/setup case
price impact
position share of real quote reserve
immediate round-trip drag
sell capacity
blocked probability
```

Freeze one primary development notional.

Selection rule must be written before outcomes, for example:

```text
smallest size satisfying:
  exact route/capacity
  current impact cap
  current round-trip cap
  position share cap
  known complete costs
```

Do not choose the size with the best observed PnL.

Canary size and economically optimal size may differ. Report both.

---

# 17. P15 — START VALID JIT LABELS AS SOON AS PRODUCTION PROOF PASSES

Do not wait for S050 before learning which arm is viable.

After P2–P14 production proof:

```text
start one clean JIT development regime
```

Keep the simulator/engine running continuously on a clean commit.

## 17.1 Checkpoints

Per cohort and policy:

```text
10  — instrument sanity
25  — route/cost/lifecycle sanity
50  — early elimination allowed
100 — one development selection allowed
```

## 17.2 Early kill

At 50 valid completed trajectories, eliminate an arm when all are true:

```text
net negative after complete costs
negative without top 3
catastrophic/blocked incidence unacceptable
no plausible correction from known measurement uncertainty
```

Do not protect the original strategy.

A strategy killed by correct economics is success.

## 17.3 Continue promising arms

Allocate new capacity to arms that:

```text
remain positive after top-tail removal
have lower catastrophic incidence
have lower blocked exits
show stable cohort/day behavior
```

Do not call them profitable yet.

---

# 18. P16 — SOLVE S050 IN PARALLEL, NOT SERIAL

Create a separate worktree/branch:

```text
pump-offline-worker
```

Do not block JIT development collection.

## 18.1 One bounded Surfpool-Rust spike

Implement an isolated Rust worker pinned to the same Solana/Surfpool versions.

Input:

```text
immutable request file
snapshot manifest
content-addressed accounts/ELFs
```

Output:

```text
immutable result file
runtime identity
full pre/post settlement
```

Run one Pump route with a hard timeout.

The HTTP/JIT daemon remains responsive.

## 18.2 If Surfpool still fails, move immediately to LiteSVM

Do not spend days patching one opaque program-restore path.

LiteSVM worker requirements:

- exact program ELF loading;
- exact account writes;
- slot/sysvar restore;
- v0/ALT transaction handling;
- no signing/submission;
- full post-state access;
- pinned runtime identity.

## 18.3 Runtime parity

The offline worker must match JIT economic effects per capability fingerprint.

Require at least:

```text
10 buys
10 sells
multiple mints
legacy + Token-2022
multiple sizes
same status/error
same debit/credit
same fees/rent
same created/closed accounts
same residual
compute drift within frozen tolerance
```

Only the exact passing fingerprints become:

```text
OFFLINE_REPRODUCIBLE
```

## 18.4 Per-fingerprint parity

Delete global parity as the promotion mechanism.

One supported Pump fingerprint may progress while another remains JIT-only.

---

# 19. P17 — REBUILD THE CONFIRMATORY VIEW BEFORE IT CAN AUTHORIZE MONEY

Create a canonical materialized/query layer with one row per position.

Avoid join multiplication by selecting one exact qualifying job per leg using a unique linkage or `EXISTS`.

Required clauses:

- exact preregistered context;
- clean source commit;
- supported capability fingerprint;
- same route family from entry through fill;
- exact transaction bytes;
- exact measured settlements;
- complete known costs;
- effect-valid entry and exit;
- durable readback-verified replay manifests;
- offline parity for that fingerprint;
- trigger→later-fill proof;
- mark SLA/coverage proof;
- no unresolved reconciliation;
- residual token amount zero;
- explicit PnL fields;
- no lifecycle violation;
- no duplicate signal episode.

Name/version:

```text
confirmatory_positions_v2
```

Every:

```text
report
readiness gate
canary gate
capability count
```

queries it.

Retire competing definitions from decision paths.

---

# 20. P18 — FINISH READINESS MATHEMATICS

## 20.1 Drawdown

Start from the actual frozen starting NAV.

Include:

```text
cash
locked rent
open position conservative value
blocked exposure
```

Compute chronological wallet equity.

Do not compute drawdown from zero-based cumulative PnL.

## 20.2 Canary shadow

Filter exactly:

```text
current preregistered context
confirmatory evidence class
chosen cohort
chosen entry policy
chosen exit policy
chosen notional
supported fingerprint
```

Historical structural shadows may not enter the gate.

## 20.3 Robust uncertainty

Use:

- position/mint block bootstrap;
- UTC-day block bootstrap;
- robust mean/log-growth interval;
- catastrophic/blocked-rate confidence interval;
- fixed-horizon or anytime-valid stopping rule.

Memecoin returns are heavy-tailed and clustered.

A normal approximation alone is insufficient.

## 20.4 Exact arithmetic

Do not convert large lamport totals through `Number`.

Use rational/high-precision decimal calculations for ratios.

## 20.5 Tail fragility

Require positive result after:

```text
top 1
top 3
top 5
top 10
best day
best five mints
```

The latest autonomous memecoin evidence shows apparent profitability can disappear when only the top three trades are removed. Treat this as a mandatory fragility check.

---

# 21. P19 — REPAIR THE REJECT PANEL INTO A STRATEGY TOOL

The current reject artifact has no `EXECUTABLE_VALUE` outcomes and mostly historical/unclassified rows.

For a stratified randomized sample of rejected episodes collect:

```text
same-family direct/Jupiter build
effect-valid simulation
direct pool state
executable value
provider health
source coverage
inclusion probability
```

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

Never map provider disappearance to −100%.

Use the panel to answer:

```text
which hard gates remove catastrophic losers?
which remove later winners?
which simply remove data availability?
```

Do not tune on the same panel without a new experiment version.

---

# 22. P20 — MODEL RISK AND RETURN SEPARATELY

Do not add machine learning before 100 valid development trajectories.

At that checkpoint compare:

## Severe-loss model

Target:

```text
total/severe loss
blocked exit
route loss
```

Use:

```text
regularized logistic model
or simple calibrated tree only if chronologically superior
```

## Conditional-return model

Among non-catastrophic, executable outcomes:

```text
conditional log return
quantile return
```

Use simple models first.

## Policy

Expected value combines:

```text
catastrophic probability
× catastrophic payoff
+
survival probability
× conditional return
-
complete execution costs
```

A single score should not hide those two mechanisms.

No LLM in the trading loop.

No social-text model during this directive.

Public datasets may guide feature design, not prove the live strategy.

---

# 23. P21 — THROUGHPUT AND PAID INFRASTRUCTURE

Measure after valid labels begin:

```text
calls by purpose
duplicate calls
valid labels/hour
valid completed trajectories/day
p50/p95/max mark lag
trigger→fill lag
blocked-exit wait
429s
skipped episodes
simulator queue
direct-Pump coverage
```

## 23.1 Jupiter

Current plan choices include roughly:

```text
Free       1 RPS
Developer 10 RPS, $25/month
```

Upgrade only when:

```text
production label generator is correct
and
direct Pump has not yet removed the bottleneck
and
1 RPS measurably reduces valid labels/day or violates trigger/fill SLA
```

Once those conditions hold, the $25 Developer plan is likely high ROI relative to engineering time. Record the measured case before purchase.

Do not evade quotas.

## 23.2 Helius/RPC/WSS

Use existing capacity until measured otherwise.

Remember WSS is metered by credits under current billing.

Prioritize subscriptions by exposure and supported route.

## 23.3 No premium execution infrastructure yet

Do not buy:

```text
shreds
premium gRPC
colocation
large VPS
private relays
```

before an untouched edge exists.

---

# 24. P22 — RELEASE MANIFESTS MUST DESCRIBE THE BUILD THAT EXISTS

Replace stale hand-maintained blockers.

The release manifest includes:

```text
source SHA/dirty
CI run ID/URL/conclusion
test result
mutation result
replay result
schema/config/risk/context versions
simulator/runtime/effect versions
supported fingerprints
snapshot/program manifests
production round-trip proof
valid development counts
confirmatory counts
current blockers
```

Artifacts generated from an older source commit fail readiness.

`tests.run=false` cannot survive a green release.

Health surfaces must query:

```text
actual stored replayable snapshots
actual parity state
actual simulator identity
```

not hardcoded `NO_FROZEN_SNAPSHOTS`.

---

# 25. P23 — REQUIRED BEHAVIORAL AND MUTATION TESTS

Add tests that fail against current `02483ca` for at least:

1. production entry uses measured token credit, not router minimum;
2. immediate sell amount equals measured acquired tokens;
3. exact round-trip gate actually refuses above cap;
4. production fill equals measured settlement;
5. production costs equal measured settlement;
6. unknown transfer fee cannot become zero;
7. paper shell calls core entry;
8. paper shell calls core shadow lifecycle;
9. trigger observation cannot close a shadow;
10. later fill requires same family and effect validity;
11. blocked shadow remains managed;
12. new shadow states are included in exposure queries;
13. production scheduler uses canonical near-trigger;
14. backlog stops admission;
15. identical books share observations;
16. signal episode does not duplicate on a fifteen-minute boundary;
17. explicit PnL fields are populated on every new close;
18. one canonical accounting implementation writes runtime and report;
19. new-context readiness rejects null explicit PnL;
20. production simulation request uses asset-aware bounds;
21. production and proof harness use one request builder;
22. cohort queue is called by production cycle;
23. each of four cohorts receives a production due event;
24. mint facts are fetched and passed into screen;
25. entity clustering affects the production concentration reading;
26. Mayhem flow does not count as organic breadth;
27. risk alarm is constructed for open supported positions;
28. unwatch emits `accountUnsubscribe`;
29. reconnect is single-flight;
30. full account data changes account hash;
31. direct Pump dynamic fees match official SDK;
32. canonical PumpSwap effective quote reserves match official SDK;
33. direct quoter 100+ bps residual fails parity;
34. confirmatory view cannot duplicate a position from multiple jobs;
35. view requires replayable readback-verified manifest;
36. view requires supported fingerprint;
37. view requires trigger→later-fill proof;
38. view requires known execution cost;
39. drawdown starts at starting NAV;
40. canary shadow gate excludes old contexts/classes;
41. bigint ratios avoid unsafe Number conversion;
42. stale release artifact cannot authorize canary;
43. 200 losing trades cannot pass;
44. top-three-fragile corpus cannot pass;
45. development JIT cannot count as confirmatory;
46. executor cannot start before current generated `CANARY_READY`;
47. canary cannot use a different settlement/accounting path;
48. live remains blocked pending later real-canary review.

Run mutation tests against each repaired behavior.

---

# 26. P24 — REQUIRED COMMANDS

Add/wire:

```bash
pnpm audit:state
pnpm production:roundtrip-proof
pnpm simulation:audit
pnpm simulator:doctor
pnpm simulator:pump-effect-proof
pnpm simulator:offline-pump-parity
pnpm capability:matrix
pnpm pump:official-parity
pnpm pump:direct-proof
pnpm trajectory:status
pnpm cohort:status
pnpm policy:tournament
pnpm reject:status
pnpm size:calibration
pnpm cost:surface
pnpm rate:budget
pnpm replay
pnpm report
pnpm readiness
pnpm release:manifest
```

Create/update:

```text
docs/AUDIT_HEAD_02483CA.md
docs/02483CA_PRODUCTION_WINDOW_INVALIDATION.md
docs/PRODUCTION_ROUNDTRIP_PROOF.md
docs/DIRECT_PUMP_PARITY.md
docs/OFFLINE_PUMP_WORKER.md
docs/TRAJECTORY_SEMANTICS.md
docs/POLICY_TOURNAMENT_PREREGISTRATION.md
docs/SIZE_CALIBRATION.md
docs/COHORT_EXPERIMENT.md
docs/REJECT_PANEL.md
docs/CANARY_READINESS.md
docs/MULTIPLE_TESTING_LEDGER.csv
docs/FAILURE_REGISTER.csv

artifacts/baseline-02483ca.json
artifacts/production-roundtrip-proof.json
artifacts/direct-pump-parity.json
artifacts/offline-pump-parity.json
artifacts/trajectory-status.json
artifacts/cohort-status.json
artifacts/policy-tournament.json
artifacts/reject-status.json
artifacts/size-calibration.json
artifacts/rate-budget.json
artifacts/readiness.json
artifacts/release-manifest.json
```

Nothing automatically starts canary or live.

---

# 27. P25 — KEEP-RUNNING OPERATIONS

Provide exact Windows commands to:

- start/stop the paper engine;
- start/stop the WSL JIT simulator;
- start/stop the offline worker;
- halt new admissions while preserving management;
- terminate when flat;
- take a verified backup;
- monitor valid labels;
- monitor cohort balance;
- monitor trajectory backlog;
- monitor trigger→fill lag;
- monitor WSS coverage;
- inspect effect/economic refusals;
- inspect direct-Pump parity drift.

The engine must be restarted after a semantic commit so new rows carry a clean current context.

Do not combine rows across restarts/versions without explicit compatibility.

---

# 28. P26 — DEVELOPMENT SELECTION AND CONFIRMATION

After at least 100 valid trajectories per surviving arm, select once using the preregistered rule.

Freeze:

```text
entry policy
exit policy
cohort
protocol state
notional
route fingerprint set
valuation
latency
cost treatment
risk gates
```

Create a new untouched context before the first confirmatory outcome.

Confirmatory requirements remain:

```text
at least 200 valid completed positions
at least 21 distinct UTC days
positive net PnL
positive expected log growth
positive robust lower bound
profit factor >= 1.25
bounded drawdown/CVaR
acceptable catastrophic/blocked incidence
recent 50 positive
positive after top-tail/day/mint removal
positive under 2× execution-cost stress
positive under latency/failure/rent stress
positive realizable portfolio
positive exact canary-size confirmatory trajectories
zero replay divergence
zero unresolved reconciliation
stable fingerprints
```

Do not weaken a failed gate.

---

# 29. P27 — MICROSCOPIC CANARY, ONLY LATER

Only after `CANARY_READY`:

```text
separate wallet
one open position
one frozen tiny notional
first five entries manually approved
one attempted entry/day initially
no leverage
no averaging down
no martingale
halt on effect mismatch
halt on reconciliation uncertainty
halt on partial/sliver surprise
```

Fund only:

```text
one position
+ exact setup/rent
+ entry/exit costs
+ one failure
+ reserve
```

Do not fund during this directive unless the full state is actually reached.

Real canary establishes execution fidelity.

A later review determines whether real economics remain positive.

---

# 30. FINAL REPORT

Report:

1. starting/ending SHA;
2. local differences from audited GitHub;
3. backup path/hash/integrity;
4. current exposure;
5. invalidated window;
6. production request-builder parity with proof harness;
7. canonical measured settlement;
8. exact production buy→sell amount handoff;
9. exact round-trip gate proof;
10. production explicit PnL rows;
11. production core call graph;
12. trigger→later-fill proof;
13. shared trajectory proof;
14. signal deduplication;
15. four-cohort production proof;
16. direct Pump official-source pin;
17. direct Pump/PumpSwap parity;
18. Mayhem/Token-2022/entity facts;
19. WSS production coverage;
20. production round-trip proof results;
21. valid development trajectories by cohort/policy;
22. early eliminated arms;
23. size calibration;
24. labels/hour and rate bottleneck;
25. whether Jupiter Developer is justified;
26. S050 worker result;
27. offline parity by fingerprint;
28. confirmatory-view clauses;
29. readiness corrections;
30. current blockers;
31. exact operator commands;
32. one final state only:

```text
MEASUREMENT_REPAIR_REQUIRED
VALID_EFFECT_LABELS_RUNNING
PUMP_CONFIRMATORY_COLLECTION_STARTED
CANARY_READY
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

The expected honest result of this directive is:

```text
VALID_EFFECT_LABELS_RUNNING
```

Do not output it merely because the proof harness still works.

It requires:

```text
the production loop generated complete round trips
the booked settlement equals the effect-verified settlement
the later-fill lifecycle is active
explicit PnL is written
all four cohorts can collect
the clean JIT development regime is actually running
```

The fastest route to maximum profitability is not to make the current strategy look good. It is to make bad arms die quickly, preserve market time, and let only robust all-cost expected log growth survive.
