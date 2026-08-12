# CLAUDE CODE DIRECTIVE — PROVE OR KILL THE ONLY SURVIVING MEMECOIN EDGE

**Date frozen:** 2026-08-12  
**Required final state:** `KILLED`, `COLLECTING_VALID_FORWARD_DATA`, or `READY_FOR_CANARY`  
**Current state before this work:** `NOT_READY_FOR_CAPITAL`

Execute this directive in the repository. Do not merely return a plan. Do not turn on live trading, deploy capital, deploy the guard program, or submit competitive transactions during this session. Build and validate everything required to make the next decision truthful.

The objective is not “make a bot that trades.” The objective is to determine, as quickly and rigorously as possible, whether the one remaining candidate strategy has positive **capture-adjusted, all-cost, executable expected log growth**, and to build a production path only if that proposition survives untouched forward data.

No profit is guaranteed. Do not describe the system as profitable before the forward gate passes.

---

## 0. THE EVIDENCE YOU MUST START FROM

There are two separate projects and they must not be conflated.

### Project A — the local general TypeScript paper trader

A prior local build reportedly had 187 tests, a replay harness, a paper engine, and 10 closed simulated positions. Four positions suffered near-total liquidity collapse and four others showed elevated exit costs. Its paper sample is far too small to establish an edge. Locate it if it exists locally, preserve its database and logs, and place it in observe-only mode. Do not count any of its trades toward the graduation strategy.

### Project B — `TateLyman/memecoinstuff`

Audit the exact working tree, remote, branch, and commit. The expected research branch is:

```text
repo: TateLyman/memecoinstuff
branch: claude/graduation-auction-edge
audited GitHub head: 2888c0c9e82b950d2c822891c00c400e17de5b19
```

Do not assume the local tree matches that commit. There may be unpushed work.

The repository has already paid to refute several attractive stories:

- post-first-buy wallet mirroring;
- queue-position entry;
- creator/reputation filtering as a complete edge;
- duplicate-pool PumpSwap arbitrage with the old quoter;
- BOOST reserve-shock discrepancies created by incorrect virtual-reserve accounting;
- the general early-launch “buy promising coins” strategy after executable-capacity and cost corrections.

Do not reopen those lines without a genuinely new falsifiable mechanism and an untouched dataset. More indicator engineering is not the priority.

The only candidate that still justifies work is:

> **A capped-delivery attempt to purchase the terminal inventory of standard SOL-denominated, non-Mayhem Pump bonding curves whose exact completion cost enters the frozen 0.10–0.25 SOL band, then hold the acquired inventory through migration and execute frozen Policy A in the canonical PumpSwap pool.**

Even this candidate is unvalidated. The most recent fresh pre-registered sample was only 45 captures and failed most gates. The current forward shadow cannot yet measure the three quantities that decide the strategy:

1. whether our capped attempt would actually win;
2. its complete cost including failed attempts;
3. the executable post-migration exit outcome.

Treat every historical positive result as a hypothesis-generation result until the repairs below are complete.

---

# P0 — PRESERVE THE STATE AND IDENTIFY WHAT IS ACTUALLY RUNNING

Before editing code:

1. Print and save:

```bash
pwd
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline --decorate -20
git diff --stat
git diff --cached --stat
```

2. Find every related repository, database, corpus, shadow log, service, timer, and running process on the PC and VPS. Record command lines and working directories. Do not assume names.

3. Before any checkout, reset, migration, or schema change:

- copy all databases and logs;
- preserve file timestamps;
- produce SHA-256 manifests;
- record sizes and line counts;
- make compressed, immutable backups;
- verify that the backups can be read.

4. Never run `git reset --hard`, delete an untracked file, truncate a database, or overwrite a forward log until the backup is verified.

5. Determine whether the Frankfurt VM is running:

- the old Python collector;
- the Rust `shadow` binary;
- both;
- neither;
- or a stale binary from a different commit.

Record:

- executable SHA-256;
- Git commit embedded in the binary or release manifest;
- process start time;
- service unit;
- environment variable **names only**;
- endpoint classes;
- reconnect count;
- last valid event time;
- disk space;
- clock offset;
- memory;
- restart history.

6. Inspect any forward logs already collected. Label them:

- `RAW_PRESERVABLE`;
- `PARTIALLY_SCOREABLE`;
- or `NOT_GATE_ELIGIBLE`.

Do not count a log toward the final gate unless its schema captures every frozen decision input and outcome without retrospective repair.

7. Commit the preserved baseline on a new audit branch. Push it so the exact state is reviewable. Do not expose secrets, keypairs, seed phrases, API values, or private SSH keys.

Create `docs/AUDIT_2026-08-12.md` with this inventory.

---

# P1 — FREEZE ONE CANONICAL STRATEGY SPECIFICATION

Create `docs/CANONICAL_STRATEGY.md` and a machine-readable `config/canonical_strategy.json`. Both must contain the same values and be hashed into every observation and decision record.

The existing intended strategy is:

```text
universe:
  Pump bonding curves
  SOL quote only
  standard curve mechanics only
  non-Mayhem only

entry state:
  exact completion cost between 0.10 and 0.25 SOL, inclusive
  exact full terminal sweep
  one position maximum
  no discretionary filter
  no social, creator, wallet, or LLM override

delivery:
  total entry delivery cap = 100,000 lamports
  route-specific accounting
  no route whose mandatory floor exceeds the cap

guard:
  exact snapshot equality
  exact curve identity
  standard-mechanics checks
  non-Mayhem check
  SOL-quote check
  minimum completion cost check
  maximum completion cost check
  maximum slot/expiry check
  fail before ATA creation
  fail before the tip transfer
  no partial/sliver purchase

migration:
  observe permissionless migration
  wait no more than the frozen 20-slot fallback window
  charge every actual or expected fallback cost correctly
  never assume another cranker will act

exit:
  Policy A only
  sell the entire executable balance at the first state where exact net
  full-position liquidation is at least 1.5× all-in cost
  otherwise execute the frozen 10-second fallback
  close the empty Token-2022 ATA in the exit transaction when safe
  account for close failure as a separate outcome

portfolio:
  one open position
  no leverage
  no averaging down
  no martingale
  no overlapping positions
```

## Resolve the 10-second clock mismatch before any further scoring

Historical `off_s` was measured from PumpSwap pool creation. Current Rust `fastpath::exit` accepts `millis_since_entry`, which may begin at the terminal bonding-curve purchase. Migration can occur several slots later. Those are not equivalent.

Trace the original pre-registration and every historical scorer. Establish the one canonical timing anchor that the frozen historical result actually used. It will likely be:

- pool creation time; or
- first executable canonical-pool state.

Do not silently choose whichever performs better.

Then:

- update all Python and Rust implementations to the same anchor;
- add cross-language parity fixtures;
- test migration delays of 0, 1, 2, 5, 10, and 20 slots;
- prove that a delayed migration cannot make the fallback fire immediately by accident;
- report the effect of the correction on every historical trade.

If the canonical historical strategy is ambiguous, choose the most conservative reproducible interpretation, document it, and restart the forward gate from zero.

## Freeze semantics

After this section:

- no threshold may change based on forward outcomes;
- no second exit policy may be substituted;
- no age, wallet, sentiment, or momentum filter may be added;
- no “small improvement” may enter the gate silently.

A change creates a new strategy ID and a new untouched forward window.

---

# P2 — REPAIR THE HISTORICAL PORTFOLIO SIMULATION

The current trade replay scores graduations independently. That is not a realizable wallet path when the specification says one position at a time.

Build a chronological event-driven portfolio simulator using exact slots, transaction ordering, and capital availability.

It must:

1. Sort opportunities by canonical decision order:

- slot;
- transaction index;
- outer instruction index;
- inner instruction index;
- deterministic mint tie-breaker only when chain order is unavailable.

2. Enforce one position at a time.

3. Skip an opportunity if the prior position has not exited and reconciled.

4. Treat entry size as a **discrete exogenous sweep cost**, not a continuously scalable fraction. The required terminal purchase is 0.10–0.25 SOL. Do not multiply the trade by a Kelly fraction as though the same opportunity can be resized freely.

5. Track an exact wallet ledger:

- free SOL;
- locked SOL;
- base transaction fees;
- priority fees;
- route tips;
- bonding-curve input;
- protocol and creator fees;
- ATA rent;
- recovered ATA rent;
- migration fallback spend;
- exit delivery;
- failed-attempt fees;
- close-account result;
- reconciliation adjustments.

6. Reserve enough balance for:

- maximum exit delivery;
- fallback migration;
- base fees;
- ATA creation;
- emergency recovery.

7. Charge all failed attempts. An expired, stale-snapshot, lost-race, or insufficient-minimum attempt may still consume a signature fee if it lands and fails.

8. Model a frozen retry policy:

- maximum attempts per opportunity;
- maximum slots;
- whether a re-priced attempt is permitted;
- whether the second attempt gets a new delivery budget;
- when the opportunity is abandoned.

Do not infer this after seeing results.

9. Use the exact executable quoter and current per-pool fee state. Never use:

- mid-price;
- last trade price;
- market cap;
- an aggregator print;
- quote reserves without usable pool capacity;
- a default fee schedule when the pool’s real schedule is available.

10. Calculate wealth-path expected log growth directly. Do not report `f≈0.57` as deployable sizing unless a valid method explains how a fixed 0.10–0.25 SOL sweep maps to that fraction as NAV changes.

11. Re-run:

- July 22–31;
- August 1–8 parameter-selection set;
- August 9–10 fresh pre-registered set;
- the full BOOST-era set;
- every available later day that was not used to choose parameters.

12. Report:

- number of eligible signals;
- attempted signals;
- captured signals under each capture assumption;
- skipped overlaps;
- skipped for insufficient free capital;
- failed attempts;
- completed positions;
- net SOL;
- arithmetic mean;
- median;
- expected log growth;
- profit factor;
- maximum drawdown;
- CVaR 5%;
- top-1/3/5/10/20 deletion;
- best five mints removed;
- best day removed;
- day and mint block-bootstrap intervals;
- exact contribution of ATA recovery;
- exact contribution of migration fallback;
- exact contribution of delivery spend;
- exact effect of the corrected 10-second anchor.

## Historical kill rule

If the corrected, chronological, one-position, all-cost simulation has any of the following, set the strategy to `KILLED`:

- non-positive expected log growth on the full available sample;
- non-positive expected log growth after deleting the best 10 trades;
- non-positive mean after deleting the best five mints;
- a negative lower bound under both mint-grouped and day-grouped uncertainty;
- profitability that requires unreproducible free ATA recovery;
- profitability that requires ignoring failed attempts;
- profitability that requires simultaneous positions;
- profitability that disappears under the canonical timing anchor.

Do not continue building a live trader merely because uncorrected aggregate PnL is positive.

Create `docs/HISTORICAL_REVALIDATION.md` and machine-readable results.

---

# P3 — REPLACE THE FORWARD COLLECTOR WITH AN EVENT-SOURCED TRUTH RECORD

The existing Rust `shadow` is not a profitability gate. It records curve state and completion timing but not the winner transaction, delivery spend, mint mapping, migration, pool state, inventory, exit, or PnL.

The older Python `collect.py` is also insufficient for Policy A:

- it samples only at t+2/5/10/15/30;
- it can miss a transient 1.5× exit;
- declared terminal fields are not all populated;
- it writes a migration only after the 30-second task completes;
- a crash can lose in-flight records;
- task failures can disappear;
- `would_capture` is only an observed-winner proxy, not actual capture probability.

Build one authoritative forward collector.

## Every curve update

Persist an append-only record containing:

- schema version;
- collector Git SHA;
- release/binary SHA-256;
- canonical strategy hash;
- source endpoint class and region;
- UTC wall timestamp;
- monotonic process timestamp;
- Solana slot;
- write version if supplied;
- subscription ID;
- curve PDA;
- raw account bytes or content hash plus durable raw blob reference;
- account length;
- virtual SOL;
- virtual token;
- real SOL;
- real token;
- token total supply;
- creator;
- quote mint;
- Mayhem flag;
- cashback flag;
- completion flag;
- exact completion cost;
- classification;
- message sequence;
- reconnect epoch;
- clock-offset measurement.

Do not discard subsequent eligible states. Persist every state transition required to reconstruct the precise transaction we would have signed.

## Curve identity mapping

The hot path currently receives a curve PDA while the builder needs mint and creator-derived accounts.

Build and continuously maintain a verified map from curve PDA to:

- mint;
- creator;
- associated bonding-curve token account;
- user ATA;
- creator vault;
- fee recipient/config;
- all other transaction accounts.

Populate it from authoritative Pump create/init events or another reproducible on-chain source. Provide an off-hot-path RPC fallback. Verify that deriving the bonding curve from the recovered mint reproduces the observed PDA. Fail closed on a mismatch.

The hot path must never perform DNS, HTTP, RPC, or disk reads to recover this mapping.

## Every eligible episode

Assign an immutable episode ID and persist:

- first eligible state;
- every subsequent eligible state;
- every leave-band state;
- exact hypothetical transaction bytes/hash for each frozen route;
- blockhash used;
- last-valid block height;
- max slot;
- modeled delivery;
- build latency;
- sign latency;
- enqueue-ready timestamp;
- reason no transaction could be built.

## Terminal transaction and auction outcome

For every episode, resolve from the chain:

- terminal trade signature;
- exact canonical instruction order;
- terminal buyer;
- terminal token amount;
- terminal SOL input;
- bonding-curve fees;
- transaction fee;
- priority fee;
- compute units consumed;
- every top-level and inner SOL transfer;
- known Jito tips;
- known Helius tips;
- other candidate delivery transfers;
- route classification;
- slot;
- transaction index;
- whether the curve left the band without completing;
- whether multiple contestants attempted and failed;
- whether a sidecar/bundle tip can be observed or only bounded.

Never write “clearing price” when only the winner’s observed spend is known. Store:

- observed winner delivery;
- lower bound;
- upper bound;
- what is unknowable.

## Migration and pool

Persist:

- completion event;
- migration transaction;
- migrator;
- migration cost;
- pool creation transaction;
- canonical pool address;
- base and quote vaults;
- raw pool account;
- raw fee/config accounts;
- exact virtual quote reserve;
- per-state LP/protocol/creator fee bps;
- first executable pool state;
- every pool/vault update through at least 30 seconds;
- all PumpSwap fills through at least 30 seconds;
- context slot and write version.

Policy A needs every observable executable state, not five sparse checkpoints.

## Counterfactual position

For each episode, reconstruct the exact inventory and all-in cost we would have had if captured. At every post-migration state calculate exact full-position liquidation with chain-identical rounding.

Persist raw inputs and derived outputs separately:

- base inventory;
- base reserve;
- real quote reserve;
- virtual quote reserve;
- fee rates;
- gross curve output;
- each fee component;
- net executable quote;
- multiple of all-in cost;
- Policy A decision;
- fallback clock;
- hypothetical exit transaction costs;
- ATA recovery;
- final net PnL.

## Durability requirements

- Serialization must use a real JSON/CBOR/Protobuf encoder, not hand-built strings.
- Every write error is fatal and visible.
- Disk-full is fatal.
- Rotate files safely.
- `fsync` or use a documented durable batching policy.
- Hash and manifest each closed segment.
- Store segments locally and remotely.
- Persist episode state incrementally; do not wait 30 seconds to write it.
- Deduplicate after reconnect.
- Mark source gaps.
- Repair resolvable gaps from RPC/block history.
- Never count an unresolved gap as a no-opportunity interval.
- Detect reorg/commitment changes.
- Emit heartbeats.
- Alert on zero messages, zero eligible curves beyond the empirically expected interval, reconnect storms, stale clock, low disk, schema mismatch, and protocol fingerprint changes.

Create `docs/FORWARD_SCHEMA.md`, fixtures, replay tests, fault-injection tests, and a one-command verifier.

The final gate starts only after this corrected collector commit is frozen. Earlier incomplete logs remain useful for diagnostics but not confirmatory evidence.

---

# P4 — MEASURE PREWARM COVERAGE CORRECTLY

The current 25 SOL warm threshold came from a brief cross-sectional live sample. That does not answer whether a curve can jump from above 25 SOL directly into the 0.10–0.25 SOL band or completion.

Using the historical event tape and forward raw curve states:

1. For every eligible band entry, record completion cost at:

- immediately previous update;
- two previous updates;
- five previous updates;
- one slot earlier;
- two slots earlier;
- five slots earlier.

2. Measure jump distributions and lead times.

3. For candidate warm thresholds from 1 to 100 SOL, report:

- percentage of eventual eligible episodes mapped in advance;
- median and lower-tail warning time;
- simultaneous warm-set size;
- memory cost;
- RPC/background mapping load;
- transaction prebuild success;
- missed opportunities.

4. Choose a threshold prospectively based on a frozen coverage target, not PnL. Prefer at least 99.9% historical episode coverage if operationally affordable.

5. Add an emergency path for an unmapped curve that jumps directly into the band. It may decline the trade, but it must record the miss explicitly rather than silently disappear.

6. Freeze the threshold and restart the forward gate if it changes the opportunity set.

---

# P5 — VERIFY CURRENT PROTOCOL MECHANICS CONTINUOUSLY

Do not assume the protocol still matches August 2026 code or old event schemas.

At startup and periodically fingerprint:

- Pump program ID and executable/programdata hash;
- upgrade authority;
- PumpSwap program ID and programdata hash;
- Mayhem program ID;
- bonding-curve discriminator;
- account offsets and supported lengths;
- Global account;
- fee config;
- fee recipients;
- creator-fee rules;
- graduation threshold/mechanics;
- migration program and accounts;
- Token-2022 extensions present on Pump mints;
- Helius and Jito tip accounts;
- canonical pool derivation;
- virtual reserve rules.

Fail closed and open a new regime ID if any load-bearing value changes.

The live quoter must read the real fee schedule. PumpSwap now uses market-cap-dependent fee tiers. A default `25/5/0` bps structure is a fixture only, not a production assumption. Persist the exact rates used in every valuation.

Add a daily parity job:

- sample real PumpSwap sells;
- reconstruct them from pre-state;
- require exact lamport equality;
- stop scoring if parity fails.

---

# P6 — BUILD ROUTE-SPECIFIC DELIVERY; DO NOT MISPRICE HELIUS

The entry delivery cap is 100,000 lamports. Route requirements differ.

## Helius

A 5,000-lamport Helius tip is valid only for explicit SWQOS-only routing. The default dual route requires a larger mandatory tip and cannot be treated as a 5,000-lamport route.

Implement:

```text
route = helius_swqos_only
endpoint explicitly contains swqos_only=true
minimum route tip checked at startup
priority fee + route tip <= 100,000 lamports
skipPreflight=true only after local deterministic validation
maxRetries=0
regional Frankfurt endpoint
warm connection
```

Default/Max Sender routing must be refused whenever its current mandatory floor exceeds the frozen cap.

## Jito

Build a separate Jito transaction and route:

- current tip accounts fetched and verified;
- live tip-floor stream recorded;
- priority fee/tip policy frozen;
- leader schedule considered;
- no Jito tip sent when it cannot help a non-Jito leader unless a measured dual-send policy justifies it;
- `jitodontfront` behavior evaluated only if compatible with the exact packet and threat model;
- transaction and bundle statuses reconciled;
- rate limits respected.

Jito’s auction is local to intersecting account locks and runs on short ticks. Benchmark **landing probability at the same opportunity state**, not generic ping latency.

## Multi-route safety

If identical intent is sent through more than one route:

- use the same guarded economic intent;
- ensure at most one transaction can succeed;
- make the guard reject stale state before ATA creation and before tip;
- reconcile every signature and bundle ID;
- count every landed failure fee;
- prevent an unguarded duplicate purchase;
- record route-specific enqueue and landing timestamps.

## No infrastructure shopping yet

Do not buy QuickNode shreds, premium RPC, a larger VPS, or a colocated server unless a measured bottleneck report shows positive expected ROI. Existing measurements already suggested candidate-specific QuickNode shreds were slower than Gatekeeper in this setup.

Use current free/cheap infrastructure to prove the edge first.

Create `docs/ROUTE_BENCHMARK.md`.

---

# P7 — BUILD THE INTEGRATED EXECUTION STATE MACHINE WITHOUT ARMING IT

The repository currently has modules for watching, building, signing, guarding, and pricing exits, but not one complete production process.

Build an integrated, testable system with separate collector and signer/executor boundaries.

## Background state

Maintain in memory, outside the hot path:

- verified curve→mint mappings;
- protocol accounts;
- fee config;
- fee recipients;
- current blockhash ring;
- last-valid block heights;
- leader schedule;
- route health;
- priority-fee estimates for the actual writable accounts;
- current tip floors;
- warmed route connections;
- wallet balance snapshot;
- position and intent state.

## Entry state machine

```text
DISCOVERED
WARM
PREBUILT
ELIGIBLE
SIGNED
ENQUEUED
LANDED_SUCCESS
LANDED_FAILURE
EXPIRED
LOST_RACE
RECONCILING
```

Every transition must be idempotent and persisted.

## Post-entry state machine

```text
POSITION_ACQUIRED
AWAITING_MIGRATION
FALLBACK_MIGRATION_REQUIRED
MIGRATING
POOL_DISCOVERED
POOL_WATCHING
EXIT_TRIGGERED
EXIT_ENQUEUED
EXIT_LANDED
ATA_CLOSE_CONFIRMED
RECONCILED
```

Implement:

- the 20-slot migration timeout;
- permissionless fallback migration;
- canonical pool verification;
- Policy A on every executable pool update;
- exact full-balance sell;
- ATA close;
- crash recovery;
- startup reconciliation;
- unknown-signature recovery;
- stale-blockhash handling;
- route outage handling;
- unpriceable-pool emergency state;
- kill switch checked continuously.

## Safety architecture

- The collector has no private key.
- The signer cannot make strategy decisions.
- The executor signs only a fully bound intent.
- Every program, account, instruction, writable account, amount, fee, tip, blockhash, and expiry is allowlisted or bound.
- No arbitrary Jupiter or third-party serialized transaction is signed.
- No LLM participates in the live loop.
- No hidden remote command can arm trading.
- `LIVE_ALLOWED=false` by default.
- Build-time and runtime arming both required.
- An empty or missing config never defaults to live.

Create a complete local-validator/LiteSVM integration suite covering:

- stale snapshot;
- partial inventory race;
- band below minimum;
- band above maximum;
- max-slot expiry;
- ATA already exists;
- ATA absent;
- Mayhem;
- non-SOL quote;
- extended account lengths;
- fee-config change;
- program upgrade;
- migration delayed 20 slots;
- migration already completed;
- route duplicate;
- process crash before send;
- crash after send before response;
- exit threshold boundary;
- fallback timing anchor;
- sell full balance;
- close success;
- close failure;
- disk full;
- clock jump;
- reconnect gap.

Do not deploy the program or fund the wallet during this directive.

---

# P8 — FIX DEPLOYMENT AND SUPPLY-CHAIN SECURITY

The current GitHub/VPS setup is not suitable for a live signer.

Known issues to correct:

- the branch is unprotected;
- required status checks are absent;
- the deploy workflow defaults to an older branch;
- the existing workflow deploys the old collector, not the graduation system;
- it accepts an arbitrary branch input;
- SSH host trust is established on first use;
- the update timer executes whatever is pushed to its tracked branch;
- test failure can be ignored and deployment can continue.

For the collector:

- pin an exact signed release SHA;
- require all tests;
- require manual production-environment approval;
- pin the SSH host key;
- verify artifact SHA on the VM;
- use a dedicated unprivileged service account;
- use read-only filesystem paths where possible;
- preserve append-only data separately from code;
- keep API values in a root-owned environment file;
- disable automatic code execution from branch pushes.

For any eventual signer:

- separate VM or OS user;
- no GitHub Actions access to the key;
- no auto-update;
- no shell-access dependency for routine operation;
- minimal outbound network allowlist;
- no inbound ports;
- local encrypted key or hardware-backed signer where practical;
- explicit manual release promotion;
- two-step arming;
- daily withdrawal/sweep policy only after the system is validated;
- immutable audit log.

Disable the existing auto-update timer before any key is ever placed on the VM:

```bash
sudo systemctl disable --now mcbot-update.timer
```

Do not execute that command blindly if the unit has a different name; inspect first.

Add branch protection and CI. Produce a signed release manifest containing:

- source commit;
- dirty-tree flag;
- compiler/toolchain;
- dependency lock hashes;
- binary SHA;
- guard program SHA;
- canonical config SHA;
- schema SHA;
- test results.

Create `docs/DEPLOYMENT_SECURITY.md`.

---

# P9 — ESTIMATE CAPTURE PROBABILITY HONESTLY

Passive history cannot reveal losing bids. The observed winner’s delivery is an upper bound on what was sufficient, not the auction clearing price. A passive shadow also cannot prove that our transaction would have landed first.

Report three different quantities and never merge them:

1. **Conditional trade outcome:** return if the terminal inventory is captured.
2. **Capture probability:** probability our frozen route and cap acquire that inventory.
3. **Per-eligible-signal economics:** capture-adjusted outcome including all failed attempt fees.

For passive forward data, produce conservative bounds:

- optimistic capture classification;
- pessimistic capture classification;
- interval-censored/unknown;
- result under each bound.

Do not count `observed winner delivery <= cap` as a confirmed capture.

You may design a non-spending route/probe experiment, but do not submit it during this session. It must not create abusive account contention, distort the market, or claim equivalence without evidence. Simulation alone is not a capture-probability measurement.

Ultimately, an actual, legitimately permitted, tightly controlled canary is required to identify real capture probability. Until then, readiness cannot exceed `COLLECTING_VALID_FORWARD_DATA`.

---

# P10 — PRE-REGISTER AN ANYTIME-VALID FORWARD GATE

The strategy was selected after many failed hypotheses. Ordinary p-values and a fresh 45-trade sample are not enough. Create `docs/FORWARD_PREREGISTRATION.md`, commit it, tag it, and hash it into every record before starting the new window.

## Unit of analysis

Define:

- eligible episode;
- attempted episode;
- captured episode;
- completed position;
- day;
- mint;
- protocol regime;
- route regime.

Prevent one curve from being counted repeatedly as independent observations.

## Minimum evidence

No canary decision before:

- 100 scoreable captured outcomes;
- 14 distinct UTC days;
- no unresolved source gaps;
- no protocol-regime change.

The default decision point is:

- 200 scoreable captured outcomes;
- 30 calendar days.

An earlier pass after 100/14 is permitted only if a pre-registered anytime-valid confidence sequence/e-process crosses every required boundary. Do not use repeated ordinary confidence intervals while peeking.

## All gates must pass

At the actual discrete one-position wallet path:

1. Net mean return > 0.
2. Expected log growth > 0.
3. Anytime-valid lower bound for expected log growth > 0.
4. Mint-clustered lower bound > 0.
5. Day-clustered lower bound > 0.
6. Positive after deleting the best 10 trades.
7. Positive after deleting the best five mints.
8. Positive after deleting the best day.
9. Positive without cashback.
10. Positive after actual route tips and priority fees.
11. Positive after every landed failed-attempt fee.
12. Positive after actual migration fallback.
13. Positive when ATA recovery failures are charged at their observed rate.
14. Positive under a conservative capture-probability bound.
15. Most recent 50 completed positions net positive.
16. No single mint contributes more than 10% of positive PnL.
17. No single day contributes more than 25% of positive PnL.
18. No unexplained replay divergence.
19. No unresolved reconciliation event.
20. Program/quoter parity remains exact.
21. Build success and route-enqueue success meet the pre-registered minimum.
22. Capture-adjusted expected SOL per eligible episode is positive.
23. Drawdown stays inside the pre-registered bound.
24. Results survive the exact chronological one-position simulation.
25. There has been no threshold or policy change since the window began.

Report top-1/3/5/10/20 deletion even when not a formal gate.

Use:

- day-block bootstrap;
- mint-cluster bootstrap;
- robust mean diagnostics;
- expected log;
- CVaR;
- maximum drawdown;
- tail concentration;
- regime split;
- route split;
- capture-probability sensitivity;
- failed-attempt sensitivity;
- ATA-recovery sensitivity;
- 10-second-anchor sensitivity only as a diagnostic, never to select a better anchor.

If a gate fails, do not weaken it. Either continue collecting under the unchanged specification or mark the strategy `KILLED`.

---

# P11 — CANARY RULES, ONLY AFTER THE FORWARD GATE

Do not arm a canary until:

- every gate above passes;
- the operator is legally and contractually eligible to use every required service;
- the integrated binary and guard have passed the production checklist;
- the release is pinned and manually approved;
- the exact capital-at-risk is understood.

This strategy cannot be canaried with a 0.01 SOL “tiny trade.” The terminal sweep itself is 0.10–0.25 SOL. State that plainly.

When canary eligibility eventually exists:

- separate wallet;
- only enough balance for one maximum-band position plus all fees, rent, fallback, exit, and safety reserve;
- one position;
- no reloading automatically;
- first five entries require manual approval;
- maximum one attempted opportunity per day initially;
- no retries beyond the frozen policy;
- stop after one unexplained execution failure;
- stop after one reconciliation mismatch;
- stop after one program/config fingerprint change;
- stop after one unexpected partial/sliver outcome;
- stop after one ATA that cannot be closed for an unexplained reason;
- stop after one actual result outside the modeled executable bounds;
- no size escalation for at least 20 completed live positions;
- compare live capture rate, delivery, latency, and exit outcomes against forward-shadow predictions after every trade.

Do not call 20 trades proof of profitability. They validate implementation fidelity only.

---

# P12 — WHAT NOT TO BUILD

Until the graduation edge either passes or is killed:

- no generic “AI memecoin picker”;
- no sentiment model;
- no LLM trade decisions;
- no copying wallets;
- no new score weights;
- no social scraping arms;
- no launch sniping outside the frozen strategy;
- no paid RPC upgrade without measured ROI;
- no direct Jupiter integration for the terminal Pump buy;
- no second strategy mixed into the same bankroll;
- no parameter sweep on forward data;
- no retrospective relabeling of a failed gate;
- no claims based on paper marks rather than executable full-position values.

Allocate engineering effort approximately:

```text
50% forward truth collection and capture measurement
25% historical/accounting repair
15% integrated execution and recovery
10% security and operational verification
0% new strategy ideation until the gate resolves
```

---

# REQUIRED COMMANDS AND DELIVERABLES

Provide one top-level command for each:

```bash
make audit
make test
make parity
make historical-revalidate
make collector-check
make forward-status
make replay
make readiness
make release-manifest
```

Equivalent commands are acceptable, but they must be documented and noninteractive.

Create or update:

```text
docs/AUDIT_2026-08-12.md
docs/CANONICAL_STRATEGY.md
docs/HISTORICAL_REVALIDATION.md
docs/FORWARD_SCHEMA.md
docs/FORWARD_PREREGISTRATION.md
docs/FORWARD_STATUS.md
docs/ROUTE_BENCHMARK.md
docs/DEPLOYMENT_SECURITY.md
docs/READINESS.md
config/canonical_strategy.json
artifacts/readiness.json
artifacts/release-manifest.json
```

`artifacts/readiness.json` must be generated from raw data, not hand-edited, and include:

- state;
- source commit;
- strategy hash;
- schema hash;
- historical gate results;
- forward counts;
- day count;
- capture-bound results;
- all-cost E[log];
- confidence boundaries;
- failed gates;
- unresolved gaps;
- protocol fingerprint;
- collector health;
- release hash;
- exact reason capital is or is not allowed.

At the end of this session, report:

1. Exact repository, branch, and commit audited.
2. Whether the working tree had unpushed changes.
3. What was actually running on the PC and VPS.
4. Which existing logs are gate-eligible.
5. Every correctness defect found.
6. Every defect fixed.
7. Test and parity results.
8. Corrected historical results under the chronological wallet.
9. Whether the strategy survives the historical kill rule.
10. The corrected collector’s schema and health.
11. Current forward eligible/captured/completed counts.
12. What remains unknowable without a real canary.
13. Exact commands to keep valid collection running.
14. Exact estimated maximum SOL at risk in one eventual canary position.
15. One final state only:

```text
KILLED
COLLECTING_VALID_FORWARD_DATA
READY_FOR_CANARY
```

Do not output `READY_FOR_CANARY` merely because code compiles, tests pass, the guard works, historical aggregate PnL is positive, or a small paper sample is positive. It means every pre-registered forward, execution, security, eligibility, and reconciliation gate has passed.
