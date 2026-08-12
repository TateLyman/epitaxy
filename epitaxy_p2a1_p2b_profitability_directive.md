# CLAUDE CODE DIRECTIVE — EPITAXY P2a.1 VALIDITY REPAIR, THEN PREREGISTERED P2b

**Repository:** the local TypeScript Epitaxy memecoin trader containing `apps/engine/src/paper.ts`  
**Do not work on `memecoinstuff`, `memecointrader`, or any graduation-auction repository.**  
**Reported current lineage:** `fef544f` → `c330ace` → `75e9e54` → `4fa28ea`  
**Date:** 2026-08-12  
**Current mode:** paper only  
**Capital permission:** none. Do not enter canary or live mode.

Execute the work. Do not merely return a plan.

The objective is the fastest honest path to positive realized net expectancy. That means preserving useful observations while immediately removing any paper-PnL claim that depends on an unbuildable transaction, ambiguous price-impact semantics, mixed strategy versions, or a counterfactual fill that could not have occurred.

The required final state for this session is exactly one of:

```text
P2B_BLOCKED_INVALID_PAPER_FILLS
P2B_PREREGISTERED_AND_COLLECTING
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

`PROFITABLE`, `CANARY_READY`, and `LIVE_READY` are not permitted outcomes from this session.

---

## 0. PRESERVE AND IDENTIFY THE EXACT STATE

Before editing:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -20
git diff
git diff --cached
pnpm status
pnpm health
```

Record:

- exact repo path;
- branch;
- HEAD;
- dirty files;
- running engine PID and start time;
- config file and strategy version;
- current database path;
- open position count;
- current risk halt state;
- latest heartbeat;
- latest mark;
- current Jupiter base URL and whether an API key is active;
- current RPC HTTP/WSS endpoint classes, without printing credentials.

Back up the runtime database correctly while WAL is active. Use the SQLite online backup API or `VACUUM INTO`; do not copy only the main `.db` file and ignore `-wal`. Save SHA-256, size, row counts, and timestamps. Run:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA wal_checkpoint(PASSIVE);
```

Do not reset, rewrite, or delete existing evidence. Preserve the pre-P2a and post-P2a windows separately.

Create `docs/P2A1_AUDIT.md`.

---

# P0 — THE PAPER SAMPLE HAS A BUILDABILITY BLOCKER

The repository previously reported:

```text
transaction_buildable = 0 on every quote
```

and interpreted this as harmless because quote-only requests omitted `taker`. It then opened simulated paper positions.

That interpretation is incompatible with this project’s own rules:

> A quoted price without a buildable transaction is not executable.  
> Paper mode rejects a fill if a real order could not be built.

## 0.1 Audit every historical paper fill

For every paper entry and exit, report:

- quote endpoint and request mode;
- quote request/response timestamp;
- quote context slot;
- input/output mints and exact raw amounts;
- route labels and AMM keys;
- raw `feeBps`, `feeMint`, and platform fee;
- raw `priceImpactPct` or V2 `priceImpact`;
- whether `taker` was supplied;
- whether the API returned a transaction or raw instructions;
- whether transaction policy validation ran;
- whether a local simulation ran;
- whether the quote/order expired;
- whether the paper fill was nevertheless booked.

Classify each leg:

```text
QUOTE_ONLY
BUILD_SUCCEEDED
BUILD_FAILED
POLICY_VALIDATED
SIMULATION_SUCCEEDED
UNVERIFIABLE
```

A trade is `PAPER_PNL_ELIGIBLE` only when both entry and the relevant exit state have a structurally buildable, policy-valid transaction path at the exact size and decision time. Do not grandfather old rows.

If all existing paper entries are quote-only, state plainly:

```text
0 historical paper trades establish executable PnL
```

The old rows remain useful as quote-path observations.

## 0.2 Implement structural buildability in paper mode

Use the current Jupiter Swap V2 APIs.

Preferred approach:

- `/order` for the same production route when a taker-bound transaction can be obtained;
- `/build` for raw, policy-inspectable instructions when paper-mode balances make `/order` impossible;
- label `/build` as Metis-only and never combine `/order` pricing with `/build` buildability as though they are the same route;
- persist the exact endpoint, router universe, route, fee model, and request mode.

`/build` requires a taker. Construct the full transaction locally from returned instructions, lookup tables, blockhash metadata, ATA setup, cleanup, and compute instructions. Run the same transaction-policy decoder used by the executor.

For paper sell validation, the real mainnet wallet does not own the hypothetical tokens. Therefore:

- build structurally from `/build`;
- simulate in a controlled local SVM/fork fixture with the exact hypothetical token balance and captured mainnet accounts;
- do not claim mainnet simulation success from a wallet that lacks the token;
- do not silently downgrade to quote-only.

If structural buildability cannot be established for a leg, record the quote and outcome but no paper fill.

Add fields/tables rather than overloading booleans:

```text
build_endpoint
build_router
build_request_id
build_status
build_error_code
build_error_class
transaction_hash
transaction_bytes_hash
policy_status
simulation_status
last_valid_block_height
expire_at
quote_context_slot
build_context_slot
```

Mutation-test the gate: deliberately return valid pricing with `transaction: ""`, `transaction: null`, malformed instructions, unsupported programs, and stale expiry. All must prevent a paper fill.

---

# P1 — PRICE IMPACT IS CURRENTLY SEMANTICALLY UNSAFE

The system reported final impacts around `-9,900` to `-10,000` bps and grouped them with positive `+519` to `+911` bps because `paper.ts` applies `Math.abs`.

Do not merely remove `Math.abs` and move on.

Current Jupiter documentation defines raw `priceImpactPct` as a decimal from 0 to 1. A negative raw Jupiter impact is therefore a schema/derivation contradiction unless the stored field is a custom signed metric.

## 1.1 Trace the field end to end

For every impact-related field, identify:

- source endpoint;
- raw JSON field;
- raw string;
- parsed number;
- scaling;
- sign convention;
- reference price;
- code line deriving bps;
- storage column;
- exit-rule consumer;
- report consumer.

Persist the raw response or a durable raw blob plus hash. Never preserve only the derived number.

Create separate, unambiguous fields:

```text
raw_jupiter_price_impact_pct
raw_jupiter_price_impact_bps
round_trip_route_loss_bps
signed_mark_return_bps
executable_sell_value_lamports
all_in_cost_lamports
executable_value_ratio_bps
quote_age_ms
route_exists
route_buildable
```

Required invariants:

```text
0 <= raw_jupiter_price_impact_pct <= 1
raw_jupiter_price_impact_bps >= 0
executable_value_ratio_bps may be 0 or greater
signed_mark_return_bps may be negative or positive
```

Any negative raw Jupiter impact is `SCHEMA_OR_PARSER_ERROR`, not a market event.

## 1.2 Split the reason without changing economics yet

Replace the ambiguous analytical label with mutually exclusive diagnostics:

```text
NO_EXIT_ROUTE
UNBUILDABLE_EXIT
EXECUTABLE_VALUE_COLLAPSE
ADVERSE_EXIT_IMPACT
ROUND_TRIP_COST_EXPANSION
STALE_EXIT_QUOTE
PROVIDER_FAILURE
SCHEMA_OR_PARSER_ERROR
```

Classification must use economic quantities:

- `EXECUTABLE_VALUE_COLLAPSE`: the exact sell quote returns only a frozen small fraction of all-in cost;
- `ADVERSE_EXIT_IMPACT`: raw nonnegative Jupiter impact exceeds the frozen cap;
- `ROUND_TRIP_COST_EXPANSION`: executable sell remains available but all-in round-trip loss exceeds the frozen cap;
- provider/API failures are never token facts.

Reclassify historical records from preserved raw inputs where possible. Unrecoverable rows are `UNVERIFIABLE`.

**Keep the current actual exit policy unchanged until P2b is preregistered.** It is acceptable to improve labels now. It is not acceptable to choose new exit semantics after seeing which rule rescues the ten existing trades.

Add boundary and mutation tests. No `Math.abs` may remain on any directional market or PnL variable.

---

# P2 — DO NOT MIX THE RISK-POLICY CHANGE INTO ONE EXPERIMENT

P2a changed paper-only:

```text
dailyLossCapLamports: 0.06 SOL -> 0.5 SOL
drawdownHaltPct: 6 -> 50
```

The motivation—avoid loss-dependent missing observations—is legitimate. The implementation changes the portfolio policy and therefore creates a new experiment.

## 2.1 Tag every observation

Every candidate, decision snapshot, quote, mark, position, fill, and exit must carry:

```text
source_commit
strategy_version
strategy_config_hash
risk_policy_hash
schema_version
paper_engine_version
quote_adapter_version
data_regime_id
```

The confirmatory P2b window starts after all P0/P1 fixes are committed and the engine is restarted. Do not pool:

- v0.2 with v0.3;
- pre-O042 with post-O042;
- 31-second marks with 10.5-second marks;
- 0.06/6 risk policy with 0.5/50;
- quote-only fills with build-validated fills.

## 2.2 Run two ledgers, not one compromised ledger

Create two simultaneous outputs from the same immutable signals:

### `alpha_shadow`

- follows every eligible signal;
- permits overlapping virtual positions;
- ignores portfolio daily/drawdown halts only for outcome measurement;
- records exact counterfactual executable outcomes;
- never claims to be a realizable wallet;
- is used to estimate token-selection/exit alpha without loss-dependent censoring.

### `portfolio_paper`

- one realizable wallet path;
- enforces one-position/portfolio/risk limits;
- uses actual free capital;
- is the deployable policy;
- records skipped opportunities and why.

This resolves missing-not-at-random censoring without loosening the deployable risk policy.

Report both estimands:

```text
conditional strategy expectancy
realizable constrained-portfolio expectancy
```

Do not use the unconstrained alpha-shadow result as a canary result.

## 2.3 Risk enforcement audit

Enumerate every field in:

- the risk config schema;
- `SAFER_WHEN_LOWER`;
- `SAFER_WHEN_HIGHER`;
- canary/live configs.

For each field, name the exact runtime enforcement branch and test. A field present only in validation, comments, reports, or the “do not loosen” list is a critical defect.

Implement or delete the remaining three declared-but-unused risk halts. Do not leave them as ceremonial config.

Call `assertNotLoosened` at the actual config-merge boundary, or remove it and replace it with a complete typed enforcement mechanism. Tests must prove every environment/CLI override can tighten but cannot loosen canary/live policy.

`pnpm kill` must not abandon open positions. Separate:

```text
HALT_NEW_ENTRIES
EXIT_ONLY
TERMINATE_WHEN_FLAT
EMERGENCY_RECONCILE
```

A kill file that simply stops the process while a position is open fails the requirement.

---

# P3 — MAKE CADENCE AND POWER-LOSS RECOVERY REAL

The measured 10.54–10.56 second spacing is a useful result. Preserve it.

## 3.1 Use the correct clocks

Use monotonic time for:

- mark cadence;
- discovery cadence;
- timeouts;
- stale-lock detection;
- quote latency.

Use UTC wall time only for:

- logging;
- day boundaries;
- human reports.

`lastDiscoveryUtcMs` must not control scheduling. NTP corrections, manual clock changes, sleep, and resume can move wall time.

Track both clocks and detect:

```text
abs(wall_delta - monotonic_delta) > threshold
```

On resume/clock discontinuity:

1. block new entries;
2. refresh RPC/WSS connections;
3. reconcile every open position;
4. obtain fresh executable exit routes;
5. verify database integrity;
6. resume only after health passes.

## 3.2 Make daily loss accounting immutable

Prefer deriving UTC-day realized PnL from immutable closed fills by timestamp over mutating a resettable accumulator.

Requirements:

- `startOfUtcDay(now)` computed deterministically;
- rollover happens before the risk decision;
- missed multiple days are handled;
- restart at midnight is idempotent;
- clock rollback cannot double-reset;
- rollover and risk snapshot are transactional;
- a UTC date key is persisted.

For SQLite lamport columns that fit signed 64-bit, use `INTEGER` plus Node `statement.setReadBigInts(true)`. For values that may exceed signed 64-bit, retain canonical decimal `TEXT` and sum in JavaScript `bigint`. Never read exact money through a JavaScript `number`.

Test beyond `Number.MAX_SAFE_INTEGER`, negative PnL, and signed 64-bit boundaries.

## 3.3 Power-loss proof

Power settings do not prove recovery. Add a destructive integration test:

1. open a paper position;
2. write marks with WAL active;
3. terminate the process without cleanup;
4. restart;
5. run integrity/foreign-key checks;
6. detect the unresolved position;
7. refresh its executable exit;
8. resume marks before discovery;
9. prove no duplicate position or day reset;
10. preserve exactly-once accounting.

A PID restart is not a successful recovery unless this passes.

---

# P4 — FREE INFRASTRUCTURE IMPROVEMENTS BEFORE PAID UPGRADES

If the Jupiter integration is still keyless, create and use a free Jupiter API key. Current official terms provide:

```text
keyless: 0.5 RPS / 30 RPM
free API key: 1 RPS
```

All general Swap/Price/Token requests share the general bucket. `/execute` has a separate bucket.

Record actual observed limits. Do not create multiple accounts or keys to evade limits.

Budget the general bucket explicitly:

- open-position build/quote checks first;
- emergency exits first;
- discovery after risk;
- enrichment last.

Use no static new-token fee assumption. Persist the actual per-order:

```text
feeBps
feeMint
platformFee.amount
platformFee.feeBps
signatureFeeLamports
prioritizationFeeLamports
rentFeeLamports
```

Official documentation currently lists 50 bps for tokens younger than 24 hours, while an earlier live probe observed 10 bps. The response for each trade is the source of truth.

Use a free standard RPC/WSS provider such as the existing Helius free plan, within its terms, for:

- direct account subscriptions;
- direct pool/vault state;
- concentration reads;
- slot and source-health monitoring.

Do not confuse direct account state with an executable sell quote. Use it as a high-frequency trigger, then request a fresh Jupiter build/quote.

For each open position, subscribe at explicitly chosen commitment—not the default—to the route’s pool/vault accounts where the layout is understood. Record commitment and context slot. A direct state alarm can arrive much faster than a 10-second quote cycle.

No paid API, VPS, or stream upgrade is justified until corrected build-valid paper outcomes show positive expectancy and the measured bottleneck is infrastructure rather than strategy.

---

# P5 — ATA RENT IS LOCKED CAPITAL, NOT AUTOMATICALLY FREE

P1 previously changed ATA rent from sunk cost to refundable. That is directionally better but must not become an automatic credit.

Track:

```text
ata_created
ata_rent_locked_lamports
ata_close_buildable
ata_close_simulated
ata_close_attempted
ata_close_confirmed
ata_rent_recovered_lamports
ata_close_fee_lamports
ata_close_failure_reason
withheld_transfer_fee_lamports
```

Paper accounting:

- debit rent when ATA creation would occur;
- keep it as locked capital while the position is open;
- credit it only when a structurally valid close is possible after the full sell;
- charge close transaction costs;
- never recover rent when token balance/withheld fees/extensions prevent close;
- report results at 100%, observed, 50%, and 0% recovery.

If profitability disappears without perfect ATA recovery, that is a headline deployment blocker.

---

# P6 — CAPITAL AND SIZE MUST MATCH THE EVENTUAL DEPLOYMENT

The paper NAV was increased to roughly 5.7 SOL so the sizing function could exceed a 0.0286 SOL viability floor, and the first paper entry was about 0.0486 SOL.

Do not choose virtual NAV merely to make the strategy trade.

Produce a size surface at exact notionals:

```text
0.005
0.010
0.020
0.030
0.050
0.075
0.100 SOL
```

At each size report:

- buy buildability;
- sell buildability;
- round-trip route loss;
- feeBps;
- impact;
- ATA/rent burden;
- route survival;
- collapse rate;
- expected net return;
- expected log growth;
- maximum drawdown;
- tail loss.

The current master canary cap is the smaller of 0.02 SOL and 0.10% of NAV. Therefore a result proven only around 0.05 SOL does not validate the canary.

State the minimum bankroll required by the frozen risk policy at each notional. Do not solve an uneconomic small-trade problem by silently assuming a larger bankroll.

---

# P7 — AUDIT THE FOUR REPORTED “LIQUIDITY COLLAPSES”

Before constructing a rule from four cases, establish what actually happened.

For each collapse and matched non-collapse controls, reconstruct:

- mint;
- token age;
- entry and exit quote raw payloads;
- quote/build endpoint;
- context slots;
- route plan;
- AMM/pool accounts;
- actual real reserves at each relevant slot;
- virtual versus real liquidity;
- pool/vault balance changes;
- migration/config changes;
- fee schedule;
- transfer-fee extensions;
- mint/freeze/delegate/hook authorities;
- creator/top-holder flows;
- liquidity additions/removals;
- no-route/provider-error history;
- quote age and cadence;
- exact executable value trajectory.

Classify each as one of:

```text
TRUE_POOL_DRAIN
CREATOR_OR_CLUSTER_DUMP
LIQUIDITY_REMOVAL
MIGRATION_OR_POOL_TRANSITION
ROUTE_DISAPPEARANCE
TRANSFER_FEE_OR_TOKEN_RESTRICTION
STALE_QUOTE
PROVIDER_FAILURE
PARSER_OR_UNIT_ERROR
UNKNOWN
```

A value near zero from a Jupiter route is not by itself proof that on-chain liquidity vanished.

The highest-value research question is:

> Which decision-time variables distinguish catastrophic executable-value collapse from ordinary cost drift?

Do not fit a hard gate on four rows. Use the cases to define candidate mechanisms, then test prospectively on all accepted and rejected tokens.

---

# P8 — PREREGISTER P2b BEFORE RUNNING THE SWEEP

P2b is a multiple-testing trap. Per-mark observations within one position are not independent trades.

Create and commit `docs/P2B_PREREGISTRATION.md` before computing policy rankings.

## 8.1 Eligible data

Primary confirmatory data must be:

- collected after P0–P7 are frozen;
- one code SHA;
- one strategy/config/risk hash;
- build-valid;
- complete raw quote provenance;
- 10.5-second-or-faster documented cadence;
- no unresolved gaps;
- no pre-O042 snapshots;
- no pooled earlier strategy versions.

Earlier trades are development data only.

## 8.2 Freeze a small policy set

At most four mechanism-distinct policies:

1. current production paper policy;
2. corrected adverse-impact policy using raw nonnegative impact;
3. executable-value-collapse emergency rule;
4. one simple time/trailing policy chosen without inspecting confirmatory outcomes.

Freeze every threshold and tie-break. Each policy counts in the multiple-testing ledger.

## 8.3 Counterfactual execution rules

For each position/policy:

- use only marks known at that time;
- trigger at the first qualifying mark;
- apply measured decision/build/submission latency;
- execute at the first later build-valid quote/order, not the trigger quote;
- if no build-valid exit exists, record `EXIT_BLOCKED`;
- include all fees, rent, close, failed attempts, and quote expiry;
- never forward-fill through missing marks;
- never use a future route to rescue an earlier decision.

The unit of resampling is position/mint and UTC day, never mark.

## 8.4 Required output

For each policy and size:

- completed trades;
- censored/unverifiable;
- route/build failure;
- net SOL;
- net return;
- median;
- win rate;
- payoff ratio;
- profit factor;
- expected log growth;
- maximum drawdown;
- CVaR 5%;
- collapse incidence;
- time under water;
- top-1/3/5/10 deletion;
- top mint/day contribution;
- mint-block and day-block intervals;
- results by API/market regime;
- comparison with no trade, SOL hold, current policy, and random contemporaneous eligible tokens.

Do not select a policy from fewer than 50 valid trades. Do not call it deployment evidence before the project’s 21-day/200-trade gate. A policy chosen on development data gets one untouched forward test.

Use the multiple-testing ledger and report PBO/deflated-performance diagnostics when sample size permits.

---

# P9 — ENGINE HEALTH MUST DISTINGUISH ALIVE FROM ABLE TO TRADE

The engine previously reported healthy while 145 candidates were eligible and it had no position for roughly 16 hours because the daily loss halt never rolled.

Expose independently:

```text
process_alive
data_sources_healthy
discovery_running
marks_running
entry_allowed
risk_halt_reason
exit_management_active
open_position_reconciled
database_healthy
clock_healthy
resume_resync_required
buildability_gate_healthy
```

Alert when:

- entry is halted across a UTC rollover;
- eligible signals occur but no entry decision is produced;
- open positions exist without fresh marks;
- build-valid rate collapses;
- quote-only rows are being booked as fills;
- replayable count falls;
- unverifiable rows increase;
- the engine restarts without reconciliation.

A legitimate daily halt is not an error, but it must never be displayed simply as “healthy.”

---

# P10 — TESTS THAT MUST FAIL AGAINST THE OLD BUGS

Add mutation/integration tests for:

1. quote has price but no transaction/instructions → no fill;
2. entry build valid, exit build invalid → no closed executable-PnL claim;
3. negative raw Jupiter impact → parser/schema failure;
4. signed return negative but raw impact small → no impact-cost conflation;
5. zero executable proceeds → collapse label;
6. provider 429 → provider health, not token collapse;
7. risk cap crosses UTC midnight → releases exactly once;
8. UTC clock jumps backward → no cadence burst or double reset;
9. sleep/resume → entry blocked until reconciliation;
10. kill file with open position → exit management remains alive;
11. every risk field has a reachable enforcement branch;
12. config override tries to loosen every canary/live cap → refused;
13. PnL exceeds JavaScript safe integer → exact bigint result;
14. crash with WAL and open position → exact recovery;
15. ATA close unavailable → no rent credit;
16. old O042 snapshot → explicitly unverifiable;
17. mixed config hashes → report refuses to pool;
18. mark-level bootstrap attempted → test refuses; group by position/day;
19. counterfactual trigger quote reused as fill → refused;
20. missing build/raw quote provenance → row excluded from confirmatory results.

Run:

```bash
pnpm check
pnpm replay
pnpm doctor
pnpm health
pnpm report
```

Record exact counts.

---

# REQUIRED FINAL REPORT

At the end, report:

1. exact repo, branch, and commit;
2. dirty/unpushed changes found;
3. exact database backup and integrity results;
4. process and open-position state;
5. number of historical entries/exits by buildability class;
6. number of historical paper trades still PnL-eligible;
7. exact meaning and source of every impact field;
8. reclassification of the collapse/cost rows;
9. whether any parser/schema bug existed;
10. risk fields enforced versus still dead;
11. whether kill preserves exit management;
12. power-loss recovery test result;
13. post-fix strategy/config/risk hashes;
14. free Jupiter/Helius quota currently active;
15. current confirmatory sample start timestamp;
16. P2b preregistration commit;
17. current valid trade/day counts;
18. exact blockers to 21 days/200 trades;
19. whether corrected historical economics kill the strategy;
20. one final state only:

```text
P2B_BLOCKED_INVALID_PAPER_FILLS
P2B_PREREGISTERED_AND_COLLECTING
STRATEGY_KILLED_BY_CORRECTED_ECONOMICS
```

Do not ask whether to remove `Math.abs`. Resolve the semantic audit first, split diagnostics immediately, and leave economic policy unchanged until the preregistration is committed.
