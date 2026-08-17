# Independent runtime adversarial re-audit — epitaxy at `8f73cef`

**Terminal state: `MEASUREMENT_REPAIR_REQUIRED`**

**Original audited remote head:** `29c7cc7f086b9be5c21445fabd84f47794251857`
**Head audited here:** `8f73cef2a1a87fb0019cab8c4bd5725e2a60114f` (local `master` == `origin/master`, 37 commits ahead of `29c7cc7`)
**Date:** 2026-08-17T01:46:04Z — every count below is as of that instant, taken from
`artifacts/runtime-adversarial-audit-8f73cef.json`. The corpus is LIVE and a
collector is still writing to it, so re-running the harness will show larger
numbers and the same verdicts.

```
PASS 25    FAIL 26    NOT TESTABLE 8
```

Machine-generated ledger: `artifacts/runtime-adversarial-audit-8f73cef.json`
Machine-generated trace: `artifacts/runtime-trajectory-trace-966ef3fa.json`
Harnesses, committed so any of this can be re-run:
`scripts/runtime-adversarial-audit.ts`, `scripts/runtime-audit-worker-probe.ts`

Every verdict below came from running something against the operator's actual
tree, actual runtime database, actual WSL worker and actual configured RPC. No
verdict is copied from a commit message, `docs/STATUS.md`, a proof artifact, a
unit-test name, a source comment, a call graph or a green CI run.

Nothing here was funded, signed or submitted. No canary and no live run was
started. The live database was opened **read only**; every write probe ran
against a VACUUM-consistent copy under the system temp directory.

---

## The one-line summary

**The apparatus is real and the accounting is not.**

The collector genuinely runs: it discovers migrations, gates them on risk facts
collected before the decision, freezes an exact PumpSwap plan, executes both legs
in one persistent litesvm runtime, and marks and settles paths across process
restarts. The Rust worker is bit-exact at every u64 boundary the directive names.
Both legs of the cashback tail are verified fail-closed and both are measured
accruing.

What does not hold is everything downstream of that. The trajectory row points at
an observation, a worker job and a settlement **that do not exist**; its
`snapshot_hash` is a decimal slot number; 292 of 292 trajectories carry
unobserved writable accounts; 51 of 52 settlements publish economics with a
non-zero unexplained remainder and **zero** identity violations; the entry side of
the policy tournament was never wired; and `pnpm readiness` cannot read any of it.

`pnpm check` passes — **124 test files, 1,817 tests, 16.9 seconds, all green** —
while 26 invariants in this document fail. That is the directive's own thesis,
demonstrated again.

---

## A. The machine

```
local SHA            8f73cef2a1a87fb0019cab8c4bd5725e2a60114f   DIRTY (artifacts only)
remote SHA           8f73cef2a1a87fb0019cab8c4bd5725e2a60114f   equal
commits since 29c7cc7   37
collector processes  5 daemons (15 processes) at audit start; 1 after section S
collector cwd        C:\Users\lyman\tradseee
WSL distro           Ubuntu-24.04
worker path          offline-worker/target/release/epitaxy-offline-worker
worker SHA-256       be02d7855a2b130a4460cdce923a53429f740877a2f151dcacf713686392d7d8
                     ELF 64-bit x86-64, litesvm 0.6.1, runs and answers
database             data/runtime.db          7,355,133,952 bytes
                     data/runtime.db-wal         66,084,832 bytes
                     data/runtime.db-shm            131,072 bytes
schema version       46 (prospective_samples)     [the 29c7cc7 report says v43]
run contexts         41; the newest is a PAPER context at schema-v34
RPC hosts            dimensional-cosmological-sheet.solana-mainnet.quiknode.pro (primary, answering)
                     magical-silent-cloud.solana-mainnet.quiknode.pro
quota state          the fallback returns HTTP 429 "max usage reached"; the primary
                     429'd mid-audit during section S
CI                   .github/workflows present; NOT relied on — see the tally above
```

### The verified backup, taken before any audit mutation

```
method     VACUUM INTO      (see below)
path       <scratch>/audit-pre.db
bytes      7,079,682,048
sha256     fba75bf6f991ffce088eb2048d8de13c8560cac3b2e8d136b1af9c2df8480dd0
integrity_check        ok
foreign_key_check      0 violations
latest migration       46 / prospective_samples
witness rows           development_trajectories 278, trajectory_marks 1,260,
                       trajectory_settlements 49, execution_observations 43,096,
                       screenings 605,223, positions 20, fills 40, ledger_entries 1,574
elapsed    69,938 ms
```

**A note the operator should keep.** The first attempt used `node:sqlite`'s
`backup()`, which is `sqlite3_backup_step`. That call **restarts from page zero
whenever the source is written**, and with five collector daemons writing
continuously it never converged — it sat at 2.8 GB of 7.3 GB for eight minutes
with the page counter resetting. `VACUUM INTO` takes one read-transaction
snapshot and finished in 70 seconds. Any future pre-migration backup on a live
corpus should use `VACUUM INTO`; `packages/storage/src/backup.ts` uses
`onlineBackup`, which is the call that does not converge.

### A-1 [FAIL] the running collector is reproducible from its stamped commit

**26 of 31** collector sessions were opened from a DIRTY tree. A trajectory
opened from an uncommitted tree cannot be re-derived from its commit.

### A-2 [FAIL] the collector takes the process lock, so one writer owns the corpus

`apps/collector/src/trajectory-collect.ts` never imports `process_locks` and
never checks whether a lock is held.

- At the start of this audit **five** `trajectory:collect` daemons (15 processes)
  were running against one 7.3 GB database.
- `collector_sessions` records a peak of **6 simultaneously live sessions** and
  **7 sessions that never wrote `ended_utc_ms`** (they were killed).
- `process_locks.collector` names pid 24924, which is alive — and is
  `apps/collector/src/main.ts`, i.e. **`pnpm observe`, a different program**.
- `pnpm health` prints `OK engine.collector pid 24924 alive in observe` against
  that row while five unlocked writers run beside it.

**What it cost, measured:** section S found **15 mints exceeding the hard
`--max-per-mint` cap of 3**, the worst at 58 — nineteen times the cap. Three of
those breaches happened inside 45 minutes on the day of this audit
(`FwN8kva…` 9 trajectories in 35 minutes, `24mdaLKy…` 8 in 45, `DDHX7W88…` 5 in
24). `migrationCandidates()` enforces `COUNT(*) < maxPerMint` correctly; five
daemons evaluate it against the same instant and all admit the same mint.

---

## B. The named command is real — but not one-pass

Run: `pnpm trajectory:collect -- --once --max-candidates=6 --max-open=2 --backfill-scan=6`

| # | invariant | verdict |
| - | --------- | ------- |
| B-1 | imports no signer or network-send code | **PASS** — 59 modules in the transitive import closure, none under `packages/execution` |
| B-2 | opens a trajectory and writes current DB rows | **PASS** — `opened=1`, 5 risk refusals stored, `development_trajectories` 273 → 275 |
| B-3 | continues to later marks and settles ≥1 policy outcome | **FAIL** — `marks taken this run = 0`, `settled this run = 0` over 64 open trajectories |
| B-4 | the corpus contains marks taken at their horizon | **FAIL** — **697 of 1,448** marks are more than 60 s late |

B-3 is not the command stopping after snapshot — it ran the full mark pass and
found nothing due. It means the one-pass claim rests on *other* processes having
already marked, which is exactly the property section A shows is unmanaged.

B-4 is the one that bites: a backfilled horizon carries the right label and the
wrong instant, so both exit policies agree trivially and the tournament cannot
distinguish the policies it exists to compare.

---

## C. The trace, and where it breaks

Traced trajectory: **`966ef3fa-e9b6-4002-a683-6b5ea0338c6a`**, mint
`1HcJG7NgqcLKagUfA7XWzpJQtFQMquaHr4he2oRpump`, settled with a settlement row.
Full machine-generated trace in
`artifacts/runtime-trajectory-trace-966ef3fa.json`.

| link | value | resolves? |
| ---- | ----- | --------- |
| candidate / migration | `1HcJG7Ngqc…` → `confirmed_migrations` | ✔ |
| candidate risk facts | by trajectory id | ✔ |
| account plan (buy) | `966ef3fa…/buy`, sha256 over ordered metas | ✔ |
| account plan (sell) | `966ef3fa…/sell` | ✔ |
| **snapshot hash** | `439747637` | ✘ **not a hash — a slot number** |
| **entry observation** | `obs-0ada7a79-a7b9-40f1-b997-61f32a2d15a6` | ✘ **dangling** |
| **entry worker job/step** | `job-059e850e-e3e9-4374-bc88-bb8c269547df` | ✘ **dangling** |
| entry settlement | `set-88c1a360-ea34-479a-8b31-953992fde322` → keyed by trajectory id | ✔ |
| immediate mechanics | `scope = IMMEDIATE_MECHANICS` | ✔ |
| mark ids | `(trajectory_id, offset_ms)` | ✔ |
| policy ids | `(trajectory_id, exit_policy)` | ✔ |
| trigger | `triggered_offset_ms` | ✔ |
| created accounts / leg cashback | by trajectory id | ✔ |
| **exit observation** | `NULL` | ✘ |
| **exit worker job/step** | *no column exists* | ✘ |
| report / readiness row | *see R* | ✘ |

Its settlement, in full, because it is the whole audit in one row:

```
entry_cash_out        23,923,479
gross_exit_credit     19,749,134
exit_cash_in          19,535,970
base_fees                 10,000     priority_fees 0     tips 0
rent_created           3,918,480     rent_recovered 2,074,080     rent_still_locked 1,844,400
transfer_fees                  0     failed_attempt_fees 0
cashback accrued/claimable/claimed/claim_cost      0 / 0 / 0 / 0
residual_token_atoms           0
execution_cost         1,854,400
net_pnl               -4,387,509     ← published
unexplained_lamports  -2,525,208     ← 58% of the loss it reports
pnl_blocked_reasons           []
identity_violations           []     ← none recorded
```

### C-1 [FAIL] every link is a foreign key or a checked immutable identity

5 of 15 do not resolve.

### C-2 [FAIL] the entry identity columns are foreign keys across the whole corpus

**0 / 292** `entry_observation_id` join to `execution_observations`.
**0 / 292** `entry_simulation_job_id` join to `simulation_jobs`.

They cannot. `simulation_jobs.job_id` is `job-<32 hex of the request hash>`;
`open-trajectory.ts` mints `job-${randomUUID()}` at line 1053 and writes it to no
other table. The namespaces are disjoint **by construction**, so no trajectory
has ever been joined to the worker job that produced it and none can be.

### C-3 [FAIL] `snapshot_hash` commits to the captured state

`packages/pipeline/src/open-trajectory.ts:1048` writes

```ts
snapshotHash: `${snapshot.slot}`,
```

and discards `coherent.snapshotHash`, which the coherent capture had already
computed. **292 / 292** stored `snapshot_hash` values are the decimal slot
number; **292 / 292** `capability_fingerprint` values are identical to it; only
**290 distinct values across 292 rows**, so two trajectories are already
indistinguishable in the one column meant to identify their inputs.

A slot number commits to no byte of the pool, the vaults, the mint or the fee
config. A replay comparing against it cannot detect that the state it re-fetched
is different.

### C-4 [FAIL] every economic amount is recomputable from raw pre/post state

It is not recomputable at all. The collector writes **no** `simulation_jobs` row
and **no** `execution_observations` row. The buy and sell pre/post account sets
exist only inside the worker process and are reduced to the aggregate columns of
`trajectory_settlements` before anything is persisted.

`entry_cash_out`, `exit_cash_in`, rent and the venue skim are each recorded
exactly once and are **unfalsifiable from the database**. That is the condition
the directive requires to be impossible.

---

## D. Direct-entry attribution

| # | invariant | verdict |
| - | --------- | ------- |
| D-1 | the direct lane rejects a routed or split entry | **PASS** |
| D-2 | mutating one vault delta breaks reconciliation | **FAIL** |

`attributeSoleVenue` requires `baseOut == takerCredit` exactly — the routed
fixture (taker credit 1,500,000 against a pool base out of 1,000,000) is refused
by name, and base out −1 atom is refused.

The **quote** leg is tested only for SIGN:

```
quote in → 0            attributed = false   ✔
quote in → 1 lamport    attributed = TRUE    ✘   (against a 20,000,000 lamport entry)
```

So "the canonical pool accounts for **all named deltas**" is true of the base
vault and false of the quote vault. The notional is never compared to what the
pool actually received.

---

## E. Build-once semantics

| # | invariant | verdict |
| - | --------- | ------- |
| E-1 | capture, execution and fingerprint describe one build | **PASS** |
| E-2 | the exit plan is frozen from the bytes the sell executed | **PASS** |
| E-3 | a rebuild dependency is *detected* rather than assumed absent | **FAIL** |
| E-4 | the April 2026 fee recipients and ordering match the SDK/docs | **NOT TESTABLE** |

E-1 holds structurally: `buyPlan = freezeAccountPlan('buy', raw)` and
`buyBytes = encode(built.instructions, …)` sit inside one `buildBuyFrom` window
with no second build between them, and the sell plan is frozen from
`trip.sellInstructions`.

E-3: `assertPlanUnchanged` (`packages/solana/src/account-plan.ts:173`) has **zero
production callers**. The build-once property currently rests on two expressions
being adjacent in one function. Nothing would fail if a future edit inserted a
rebuild between them.

E-4: there is no hardcoded recipient list to compare — the open path reads
whatever the SDK selects off the frozen plan (`selectedTrailingAccounts`), which
is the correct design. Confirming SDK 1.19.0 itself against current official Pump
docs needs network access this harness deliberately does not take. **This is a
production invariant and it is NOT TESTABLE here, so it blocks promotion on its
own.**

---

## F. Worker exactness — the strongest section

Driven against the real Rust worker over WSL (`scripts/runtime-audit-worker-probe.ts`),
every value written into a live litesvm account and read back.

| mutation | result | verdict |
| -------- | ------ | ------- |
| lamports `2^53-1`, `2^53`, `2^53+1`, `10^18`, `u64 max`; `rentEpoch = u64 max` | all six bit-exact as decimal strings; u64 max returned `18446744073709551615` | **PASS** |
| `clock.unixTimestamp = -315,619,200` (1960-01-01, a valid i64) | accepted, Clock present, nothing unobserved | **PASS** |
| re-init with one unrelated account | 0 of 6 previously known accounts survived; instance `audit-f-1:113625:1` → `audit-f-2:113625:3`; sysvars exact; binary `be02d785…`, litesvm 0.6.1 | **PASS** |
| `commandTimeoutMs = 1 ms`, then a follow-up command | init timed out; the follow-up **refused** rather than being served a stale line | **PASS** |
| observe → re-init → observe | instance ids differ, so a cross-instance comparison is detectable | **PASS** |
| `maxOutputBytes = 4,096` across init + a six-account observe | bound enforced and job-scoped | **PASS** |
| a 0.04 SOL job under the output limit | **NOT TESTABLE** — the collector opens at 0.02 SOL and no 0.04 SOL job exists to inspect | **N/T** |

This section is genuinely clean. The u64-as-decimal-string discipline, the
job-scoped counters, the instance id and the request/response pairing all do what
they claim.

---

## G. Quote-state equality

### G-1 [FAIL] each required mutation breaks equality or invalidates the job

`assertQuoteStateSurvived` compares a full `accountHash` (owner, lamports,
executable, rentEpoch, data), which is right. The problem is the SET it compares
over: `sequential-round-trip.ts:398` quotes `req.priceBearingAccounts`, and
`open-trajectory.ts:331` defines that as exactly
`[pool, baseVault, quoteVault, mint]`.

```
pool data          covered
base vault data    covered
quote vault data   covered
owner              covered
lamports           covered
executable flag    covered
fee config         NOT COVERED — fetched into the runtime, not price-bearing
Clock              NOT COVERED — not an account in the observe set at all
```

A fee config swapped between the quote and the sell changes the tier the sell is
charged and the equality check would not notice. At the tier step this repository
itself measured, that is up to **200 bps of round trip**, attributed to the market
rather than to the mutation.

### G-2 [FAIL] no successful trajectory carries required incompleteness

**292 of 292** trajectories carry at least one `unobserved on buy/sell/close`
entry in `refusals`. **275 of them are SETTLED.**

An unobserved writable is a lamport flow nobody measured. It is precisely what
reappears in section K as the unexplained remainder, and **100% of the corpus
carries one.**

---

## H. Cold / warm economics

| # | invariant | verdict |
| - | --------- | ------- |
| H-1 | every created account carries owner, space, rent, payer, recoverability, scope | **PASS** — 545 rows, 0 with an UNKNOWN scope |
| H-2 | the recurring surface excludes one-time shared setup rent | **PASS**, vacuously |
| H-3 | cold / prewarmed-nonprice / repeat runs for one snapshot | **NOT TESTABLE** |
| H-4 | a warm trajectory refuses creation of a shared non-user account | **NOT TESTABLE** |

Created-account rent totals **1,074,909,360 lamports** across the corpus, of
which **472,890,240** is recoverable and **0** is marked shared with other
traders. Scopes are `WALLET_GLOBAL` (228, not recoverable), `WALLET_TOKEN_MINT`
(228, recoverable) and `WALLET_QUOTE_MINT` (89, not recoverable).

H-2 passes only because the corpus contains **no** shared creation, so the two
never have to be separated. The cold/warm hypothesis is **unexercised, not
supported**.

H-4: `requiresSharedAccountCreation` is computed and *recorded*, and the
collector prints a `COLD_SETUP` line. **Nothing refuses.** There is no warm lane
that could refuse, because a single lane opens every trajectory. With shared rent
at zero the error today is zero; the guard the directive asks for does not exist.

---

## I. Cashback on both legs — the other clean section

| # | invariant | verdict |
| - | --------- | ------- |
| I-1 | both legs accrue, measured rather than asserted | **PASS** |
| I-2 | omitted or misordered accounts refuse before the leg runs | **PASS** |
| I-3 | accrued is not cash; claimed enters PnL once | **PASS** |
| I-4 | amortisation changes allocated cost | **NOT TESTABLE** |

**I-1, from `leg_cashback`, not from a document:**

```
buy    228 legs   88 accrued to us   140 undetermined   89 on cashback coins
sell   228 legs   89 accrued to us   139 undetermined   89 on cashback coins
```

The sell accrues as often as the buy. The repository's old one-leg model, which
asserted that `sell` carries no volume accumulator, is refuted by the data and
not merely by a re-reading of the IDL.

**I-2, eight fixtures against `remainingTailRefusal`:**

```
buy correct                       ACCEPTED
buy missing the accumulator       REFUSED
buy misordered                    REFUSED
sell correct                      ACCEPTED
sell missing the ATA              REFUSED
sell missing the accumulator PDA  REFUSED
non-cashback pool                 ACCEPTED
underivable accumulator address   REFUSED
```

Fail-closed, positionally, with the two SDK-selected trailing accounts skipped
correctly. The last row matters: an address the caller could not derive refuses
rather than being read as an account the builder omitted.

**I-3, with one caveat.** 28 settlements carry a non-zero accrual, 0 carry a
claim, and accrued is correctly excluded from PnL. But `claimable` is
**hardcoded `0n`** at `open-trajectory.ts:1012` rather than read from the
accumulator account state, so the receivable this system has built up is
invisible to every surface. The directive asks for claimable *measured from
account state*; it is asserted.

---

## J. Fee-tier classification

| # | invariant | verdict |
| - | --------- | ------- |
| J-1 | the tier is a function of market cap, not quote reserve | **PASS** |
| J-2 | below the first threshold the FIRST tier is charged | **PASS** |
| J-3 | the fee-config hash and selected tier are bound to the trajectory | **FAIL** |
| J-4 | the tier matches the official SDK/program result | **NOT TESTABLE** |

J-1, constructed both ways:

```
equal quote reserve (100 SOL), caps 100e9 vs 10e12   →  110 bps vs 36 bps   (differ ✔)
equal cap (2e12), reserves 50 SOL vs 200 SOL         →   48 bps vs 48 bps   (same  ✔)
```

J-3: **no `fee_config_hash` and no `selected_tier` column exists** on
`development_trajectories` or on `trajectory_marks`. `feeConfigHash()` has no
production caller outside scripts and the research capability fingerprint;
`tierForPool` is called only in `packages/pipeline/src/direct-mark.ts` and its
result is discarded before the mark is stored. Pump has already changed fee
behaviour once — a trajectory that does not record the fee table it was priced
against cannot distinguish "the tier changed" from "Pump republished the table".

J-4 is NOT TESTABLE in-process: the SDK does not export `calculateFeeTier`, so
`selectFeeTier`'s replication is asserted against a **code comment**. A divergence
is worth the full tier step.

---

## K. Settlement identities — the most expensive failures

### K-1 [FAIL] each component enters exactly once

Eleven independent mutations against `buildTrajectorySettlement`. Nine move
exactly the quantity they name. **Two enter ZERO times:**

| mutation | effect |
| -------- | ------ |
| `failedAttemptFeesLamports = 5,000` (the builder's own parameter) | **none** |
| `costs.unexplainedLamports = 2,500,000` | **none** |

`executionCost(leg)` sums only the **per-leg** `failedAttemptCostLamports`; the
trajectory-level `failedAttemptFeesLamports` is stored in
`trajectory_settlements.failed_attempt_fees` and added to no total. Latent today —
`openTrajectory` never passes it — but the API accepts it and loses it.

The second is not latent. `isPnlEligible()` in `packages/domain/src/settlement.ts`
states the rule in its own header:

```
  complete              every money-critical quantity is known
  effectValid           the trade demonstrably happened
  fullAccountCoverage   every writable was observed on both sides
  unexplained == 0      no lamport left the payer unaccounted for
```

`buildTrajectorySettlement` checks the first three and **never reads the fourth**.
So a leg the domain itself calls PnL-ineligible still produces a published net
PnL. `isPnlEligible` is called by the paper engine and by `settlement-check`; it
is not called by the canonical writer for the trajectory corpus.

### K-2 [FAIL] the payer identity closes, or net PnL is withheld

Forced fixture (payer delta moved 2,500,000 lamports off the named flows):

```
unexplained        = -2,500,000
netPnl             = -2,700,000       ← published anyway
pnlBlockedReasons  = 0
identityViolations = 0
```

In the live corpus:

```
settlements                              52
with a NON-ZERO unexplained remainder    51
of those, publishing a net PnL anyway    30
carrying an identity violation            0
```

Worst case in the database: trajectory `2b9bca05-71de-454b-9de7-adcfdf731e69`
publishes **net −6,426,787 lamports with −4,564,488 unexplained** — the residue is
**71% of the loss the row reports**, on a 20,000,000 lamport notional.

`unexplainedLamports` is computed, stored, and **read by nothing**. It is neither
a `pnlBlockedReason` nor a `checkIdentities` violation.

**This falsifies two published claims:**

- commit `4edb5f7` — *"P5 closes: the payer identity reconciles to ZERO on both legs"*
- `docs/29C7CC7_RUNNING_COLLECTOR_REPORT.md` blocker 4 — *"~~Net PnL is UNKNOWN~~ — **closed.** Canonical settlement is wired and the payer identity reconciles to zero on both legs."*

`docs/STATUS.md` says the opposite of both — *"every settlement still carries a
non-zero `unexplained` remainder … and not yet zero"* — and **STATUS.md is
correct**. The report and the commit message are not.

### K-3 [FAIL] the trajectory, the settlement, the policy outcome and the report agree

```
trajectory_settlements.net_pnl IS NOT NULL          31
development_trajectories.net_pnl_lamports IS NOT NULL   0
development_trajectories.execution_cost_lamports IS NOT NULL   0
```

`settleTrajectory()` is the only writer of those columns and the collector never
calls it — `closeTrajectory()` sets `state` and `settled_utc_ms` and nothing else.
**Every economics column on `development_trajectories` is permanently NULL.** Any
consumer reading the trajectory row rather than the settlement row sees a corpus
with no costs and no PnL at all.

---

## L. Append-only evidence

### L-1 [FAIL] every ambiguity fails LOUDLY

Run against the VACUUM-consistent copy, never the corpus.

| attempt | outcome |
| ------- | ------- |
| duplicate trajectory id | **REFUSED LOUDLY** — `EvidenceReplaceRefused` |
| replacement settlement with different economics | **SILENTLY DISCARDED** — row unchanged, writer returned `void` |
| a different exit attached to the same trajectory | **SILENTLY DISCARDED** — `INSERT OR IGNORE`, no signal |
| duplicate mark at a recorded offset with a different price | **SILENTLY DISCARDED** — mark `(30f0a674, 1800000ms)` kept `18678909` against a second, different `123456789` |
| an unrelated qualifying simulation job attached to the trajectory | **IMPOSSIBLE TO ATTACH OR DETECT** — no column joins `simulation_jobs` to a trajectory; 176 qualifying jobs exist and none is reachable |
| zero-row update (settle a nonexistent id) | zero rows changed, statement reported success |
| multi-row update (settle every open trajectory at once) | **64 rows changed in one statement**, nothing bounded it |

`insertTrajectory` is correct — it throws. Every other writer uses
`INSERT OR IGNORE` and returns `void`. `insertTrajectorySettlement`'s own comment
says a second different answer "is refused rather than allowed to overwrite the
first"; it is **discarded**, which is not the same thing, because the caller
cannot tell. With five daemons racing the same open trajectories, a discarded
write and a market fact are indistinguishable after the fact.

---

## M. Future counterfactuals

| # | invariant | verdict |
| - | --------- | ------- |
| M-1 | a bounded trajectory and a full event replay exist for the same entry, errors compared | **FAIL** |
| M-2 | no policy outcome rests on a later mainnet quote without either contract | **FAIL** |

```
evidence grades in the corpus:   SIMULATED_EXECUTION = 292
BOUNDED_COUNTERFACTUAL = 0       FULL_EVENT_REPLAY = 0
replay_runs: 1 run, 0 divergences
```

Every row is `SIMULATED_EXECUTION`: the exit is priced in the same runtime instant
as the entry, which measures **mechanics**, not a holding period. The 1m/5m/15m/
30m/60m marks are later mainnet quotes against a pool state that never contained
our entry, and **545 policy outcomes** carry one. The haircut columns on those
rows come from the ENTRY impact bound, not from a contract over the exit.

That is exactly the *"later mainnet quote without either contract"* the directive
names as not a valid trajectory. The gross delta over the control outcomes is
built entirely from these marks, and the corpus does not carry the grade that
would say so.

---

## N. Policy treatments

| # | invariant | verdict |
| - | --------- | ------- |
| N-1 | the policies are genuinely different treatments | **FAIL** |
| N-2 | one shared path is evaluated by ALL entry policies | **FAIL** |
| N-3 | the two EXIT policies run on the SAME path and can disagree | **PASS** |

All five counterexamples the directive names were constructed and all five hold
*in the pure functions*:

```
random enters + quality rejects        seed audit-3
quality enters + random rejects        seed audit-0
quality enters + flow rejects          true
flow enters + quality rejects          true
fixed holds while deterioration exits  deterioration 1,900,000 vs fixed 1,900,000
deterioration holds while fixed exits  deterioration 2,800,000 vs fixed 1,900,000
```

N-1 is marked FAIL because the first exit counterexample is not a counterexample:
on the deteriorating path both policies trigger at the same mark. The
`FLOW_LIQUIDITY_DETERIORATION_V1` challenger only ever differs by holding
*longer*; there is no constructed path in this build where it exits *earlier*
than the control at a different mark.

**N-2 is the serious one.** The corpus carries **one** distinct entry policy —
`HARD_GATES_RANDOM = 292` — against **three** defined in
`packages/strategy/src/treatments.ts`. `decideEntry` has **zero production
callers**. `apps/collector/src/trajectory-collect.ts:896` writes the string
literal `'HARD_GATES_RANDOM'` on every row, *after* `admitCandidate` has already
made the decision.

That is precisely "labels attached after a common decision". The entry side of
the tournament does not exist: the two challengers have a sample of zero and the
label describes nothing that happened.

N-3 holds and is worth keeping: both exit policies run over one shared mark path
(275 each), and **45 of 275 paired paths have a different trigger offset**.

---

## O. Mayhem / entity facts

| # | invariant | verdict |
| - | --------- | ------- |
| O-1 | agent flow is not independent breadth; unknown contamination is not organic | **PASS** |
| O-2 | entity-adjusted concentration alters an actual entry decision | **FAIL** |
| O-3 | the disclosed Mayhem agent wallet/program is the one this tree uses | **NOT TESTABLE** |

O-1, on a synthetic bonding curve with the mayhem byte at offset 81:

```
byte set        → decoded true    → CONTAMINATED_UNQUANTIFIED
byte cleared    → decoded false   → ORGANIC
truncated data  → decoded null    → UNKNOWN  (never coerced)
```

O-2: **1,959 of 1,959** risk-fact rows are stratified `CONCENTRATION_RAW_ONLY`.
`entity_concentration` holds 57 rows and **none is joined to a candidate
decision**. The entity-adjusted tier is never walked, so the raw top-holder share
decides every admission — and since an incomplete history can only *understate*
clustering, the gate that fires is the weaker of the two on every candidate.

O-3: the constant in this tree is `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e`.
This harness takes no network access; it is recorded here so it can be checked
against the current official disclosure out of band. **NOT TESTABLE blocks
promotion.**

---

## P. WSS

### P-1 [FAIL] subscriptions are exact, the pool PDA is refused, the unwatch uses stored addresses

```
pool PDA (300 bytes, owned by the AMM) → vaultBalance     REFUSED   ✔ NotATokenAccount
real token account                     → 123,456,789      ✔
unwatch the stored set                 → accepted         ✔
unwatch stored set + 1 NEVER-SUBSCRIBED address → accepted  ✘
6% reserve move  material              → true             ✔
0.1% reserve move material             → false            ✔
drainOrder(['b'], ['a','b','c'])       → [b, a, c]        ✔
```

`assertUnwatchesExactly` computes only `stored NOT IN asked` — a **leak** check. It
does not compute `asked NOT IN stored`, so unwatching an address that was never
subscribed passes, even though `UnwatchMismatch`'s own message reads *"unwatch was
asked for addresses that were never subscribed"*. The function is named
"exactly"; the implementation is a subset check and the error text describes the
direction it does not test.

One `LiveVaultWatch` is shared across every open trajectory, so an over-broad
unwatch silently cancels another trajectory's vault coverage — and the gap is then
recorded against the chain rather than against us.

### P-2 [NOT TESTABLE] a material update is delivered, queued, consumed, and survives a resync

`41` subscription rows, `10` gap rows, **`0` urgent marks, `0` consumed**.
`--live-lane` is OFF by default (measured at 219 messages/second, which exhausted
both endpoints), so the running collector has no socket at all and its marks are
on a 300-second timer. The urgent queue is the only thing that makes a 5% vault
move actionable rather than decorative, and it has never fired.

---

## Q. Command truth

31 named commands run one at a time against the live database. **3 FAIL.**

### Q-1 `pnpm readiness` and `pnpm readiness:positions` overwrite each other

Two **different scripts** write the same file:

```
scripts/trajectory-readiness.ts  →  artifacts/readiness.json
scripts/readiness.ts             →  artifacts/readiness.json
```

`trajectory-readiness.ts`'s own header explains why this must not happen —
*"a readiness verdict assembled from the wrong table is a verdict about the wrong
experiment"* — and it then prints *"The old POSITION readiness still exists, under
its own name: `pnpm readiness:positions`"*. The **name** is separate; the
**artifact** is not.

Demonstrated live during this sweep: after `readiness:positions` ran,
`artifacts/readiness.json` held `confirmatoryTrades`,
`validDevelopmentTrades` and `sample.validCompletedPositions` — a report about 519
canary-shadow positions — under the filename documented as the exact trajectory
contract. Both files carry `verdict: "NOT_READY"`, so a consumer keying on
`verdict` cannot tell which experiment answered; the position report has no
`ready` field at all, where the trajectory report has `ready: false`.

`tests/unit/commands-mean-their-names-p12.test.ts` contains a test titled
*"57 — no command is a silent alias for a different capability"* and another
titled *"the old position-oriented status keeps its own name"*. Both pass. Neither
asserts anything about the artifact. A test name is not the assertion.

### Q-2 `pnpm capability` is slow and reports a false capability

It exceeded the sweep's 240 s bound on the live database and had to be killed;
standalone it completed in ~280 s with exit 1, over tables of 6,775 quotes and 603
position marks. More importantly it reports:

```
! local_simulation_available   no   no local SVM fixture …
  ENGINE CANNOT OPEN A POSITION — see flags above
```

while `pnpm trajectory:collect` is executing **both legs in a local litesvm
runtime on every open**. The flag describes the Surfpool path only, and the
headline verdict is derived from it.

### What did NOT fail

`pnpm landed:parity-v2` exits **non-zero** and names its prerequisite — the
NOT_IMPLEMENTED stub behaves. `pnpm trajectory:status` counts proof artifacts as
zero explicitly. `pnpm parity:coverage` refuses to assign tiers when the fee
config could not be read, and says so rather than defaulting everything to the
bottom tier. `pnpm rate:budget-v2` refuses every purchase that is not the
measured binding constraint. Alias pairs that share an artifact because they are
the **same script** with a different argument (`dev:status`, `cohort:status`,
`reject:status`, `shadow:status`, `ledger:identity`) are not counted as
collisions.

---

## R. Readiness

| # | invariant | verdict |
| - | --------- | ------- |
| R-1 | the default `pnpm readiness` reads ONE database-stamped exact trajectory contract | **FAIL** |
| R-2 | no seeded corpus passes | **PASS** |
| R-3 | a development result cannot satisfy a real-canary gate | **PASS** |

R-1: `contractHeld` is passed as the literal `false`; `netPnlLamports` as the
literal `null`; **16 of the gate inputs are literal nulls**. The script never
mentions `trajectory_settlements`, so the **52 settlements and 31 net PnL figures
now in the database reach no gate at all**. No contract table exists — nothing
matching `%contract%` or `%frozen%` — so **there are no frozen fields to mutate.**

The gate is fail-closed and answers NOT READY, which is the right answer for the
wrong reason. It cannot become READY on evidence because it does not read the
evidence, and it therefore cannot detect that the evidence got *worse*.

R-2: every seed the directive names was written into a copy of the corpus and the
real `pnpm readiness` was run against it. **None passed.**

```
baseline                                  NOT_READY  22 blockers  timely=12   days=2
200 losses                                NOT_READY  20 blockers  timely=212  days=202
positive sample carried by the top 3      NOT_READY  20 blockers  timely=212  days=202
600 invalid old closed shadows            NOT_READY  22 blockers
300 unrelated qualifying simulation jobs  NOT_READY  22 blockers
a dirty artifact claiming READY           NOT_READY  22 blockers
a null run context                        NOT_READY  22 blockers
the wrong database snapshot (no marks)    NOT_READY  20 blockers  timely=312  days=300
50 blocked exits                          NOT_READY  22 blockers
a gross delta beyond 2^53                 NOT_READY  20 blockers  gross=1801439849498692507
replay divergences present                NOT_READY  23 blockers
```

Note what R-2 actually shows. Two seeds cleared **both** sample thresholds — 212
and 312 timely paths across 202 and 300 distinct UTC days — and the verdict did
not move, because fourteen other gates are hardcoded UNKNOWN. The gate is not
discriminating between the seeds; it is refusing all of them for the same reason.
The bigint seed is handled correctly: the sum is carried as a `BigInt` and printed
exactly.

R-3 holds: the corpus is entirely `SIMULATED_EXECUTION`,
`positiveExactCanarySizeShadow` is null, null is a FAIL, and `pnpm readiness`
exits 1. **A development result cannot satisfy the canary gate.**

---

## S. Restart and duration

| # | invariant | verdict |
| - | --------- | ------- |
| S-1 | a restart resumes without duplicate candidates | **FAIL** |
| S-2 | a restart resumes without duplicate marks or lost policy state | **PASS** |
| S-3 | stopped and restarted with open trajectories, resumed correctly | **PASS** |
| S-4 | long enough to produce actual 1m / 5m / 15m marks | **PASS** |

**The mutation.** SIGKILL all 15 `trajectory-collect` processes (five concurrent
daemons × three process layers) with **42 trajectories open**, then restart ONE
daemon with the operator's own flags
(`--interval=300 --max-candidates=8 --max-open=3 --backfill-scan=40`) and let it
run a full cycle.

```
                       before      after
trajectories             292         292      no candidate re-opened
open                      42          41
marks                  1,420       1,421      +1, none duplicated
policy outcomes          500         502      +2 — both policies on one new path
duplicate marks            0           0
settled with <2 outcomes   0           0
```

The restarted daemon **settled `de710f80` (mint `24mdaLKyM1`)** at
`FIXED_15M_CONTROL = -15,523,980` and
`FLOW_LIQUIDITY_DETERIORATION_V1 = -15,523,980` — a trajectory **opened by a
process that no longer exists**. All the mark scheduler's state lives in the
database, and that is what makes the resume real rather than asserted.

S-4, timeliness by horizon:

```
 1m   292 marks    57 within 60s of the horizon
 5m   292 marks   201
15m   292 marks   177
30m   292 marks   172
60m   280 marks   144
```

Real marks at every horizon exist. They are a minority (B-4: 697 of 1,448 marks
are late), which is what B-4 records.

S-1 is the concurrency cost, quantified: **292 trajectories across 42 distinct
mints, the most-sampled mint at 58 against a `--max-per-mint` of 3, and 15 mints
over the cap.** One mint is a fifth of the sample. `migrationCandidates()`
enforces the cap correctly *per cycle*; nothing enforces it over the study, and
five unlocked daemons evaluate the same `COUNT(*) < 3` against the same instant.

### One more thing the restart cycle reproduced live

```
mechanically viable: 0 of 8
     8  no canonical PumpSwap pool
…
STOPPING THIS PASS: the RPC endpoint refused 1 read(s) in a row.
  [solana_rpc/rate_limited] HTTP 429: max usage reached
```

The quota breaker was added to `candidateFacts`, which is the *admission* pass.
`snapshotCandidate` (`trajectory-collect.ts:517`) and `openTrajectory`
(`open-trajectory.ts:315`) still collapse a 429 into the string
**`'no canonical PumpSwap pool'`**. So the refusal histogram in that cycle
reported a fact about our quota as a fact about the chain — the exact
substitution the surrounding comments say the fix removed, still present two
functions away, and caught by running it.

---

## The failure ledger

Ranked by what it costs the evidence, not by section order.

| # | section | finding | consequence |
| - | ------- | ------- | ----------- |
| 1 | K-2 | 51 of 52 settlements carry a non-zero unexplained remainder; 30 publish net PnL anyway; 0 identity violations | net PnL is published on rows whose payer identity is short by up to 71% of the loss reported. Falsifies commit `4edb5f7` and report blocker 4 |
| 2 | K-1 | `costs.unexplainedLamports` — the fourth condition `isPnlEligible` requires — is never read by `buildTrajectorySettlement` | the rule is written down and the canonical writer skips it |
| 3 | C-2 | 0/292 entry observation and worker-job ids resolve; the namespaces are disjoint by construction | no trajectory can ever be joined to the worker job that produced it |
| 4 | C-4 | no raw pre/post state is persisted against a trajectory | every economic amount is recorded once and is unfalsifiable from the database |
| 5 | G-2 | 292/292 trajectories carry unobserved writables; 275 settled | 100% of the corpus has an unmeasured lamport flow |
| 6 | N-2 | `decideEntry` has zero production callers; all 292 rows are labelled `HARD_GATES_RANDOM` | the entry tournament does not exist; the label is attached after a common decision |
| 7 | K-3 | `settleTrajectory()` is never called; every economics column on `development_trajectories` is NULL | the trajectory row and the settlement row disagree by construction |
| 8 | C-3 | `snapshot_hash` = `capability_fingerprint` = decimal slot number, 290 distinct over 292 | the identity column commits to no byte of the state |
| 9 | M-1/M-2 | all 292 rows are `SIMULATED_EXECUTION`; 545 policy outcomes rest on later mainnet quotes with no bounded or replayed contract | the gross delta is not a strategy result and the grade does not say so |
| 10 | A-2 / S-1 | no process lock on `trajectory:collect`; five concurrent daemons; 15 mints over a hard cap of 3 | the sample is not independent across rows and `pnpm health` reports OK |
| 11 | L-1 | five of seven append-only ambiguities are silently discarded rather than refused | a lost write and a market fact are indistinguishable |
| 12 | Q-1 | `pnpm readiness` and `pnpm readiness:positions` write the same artifact from different scripts | the position gate silently replaces the trajectory gate's verdict in the file downstream readers key on |
| 13 | R-1 | readiness hardcodes `contractHeld: false` and 16 null inputs; never reads `trajectory_settlements` | right answer, wrong reason; it cannot detect the evidence getting worse |
| 14 | G-1 | fee config and Clock are outside the quote-state equality set | a swapped fee config is worth up to 200 bps and would not be noticed |
| 15 | D-2 | the quote vault delta is checked only for sign | 1 lamport against a 0.02 SOL entry still attributes as sole venue |
| 16 | J-3 | no fee-config hash or selected tier is bound to any trajectory | no historical row survives a Pump fee change |
| 17 | B-4 | 697 of 1,448 marks are more than 60 s late | backfilled horizons make the exit policies agree trivially |
| 18 | O-2 | 1,959/1,959 risk-fact rows are `CONCENTRATION_RAW_ONLY` | the weaker of two concentration gates decides every admission |
| 19 | P-1 | `assertUnwatchesExactly` is a subset check; its error text describes the direction it does not test | an over-broad unwatch cancels another trajectory's coverage |
| 20 | E-3 | `assertPlanUnchanged` has no production caller | build-once rests on two adjacent expressions |
| 21 | A-1 | 26 of 31 collector sessions were opened from a dirty tree | those rows are not re-derivable from their commit |
| 22 | Q-2 | `pnpm capability` needs ~280 s and reports `local_simulation_available: no` while litesvm runs every leg | a status command contradicts the running system |
| 23 | B-3 | a `--once` pass took 0 marks and settled 0 | the one-pass claim rests on other processes |
| 24 | H-4 | `requiresSharedSetup` is recorded, never refused | a cold row and a warm row enter the same average |
| 25 | N-1 | no constructed path exists where the challenger exits EARLIER at a different mark | the challenger can only differ by holding longer |
| 26 | I-3 (partial) | `claimable` is hardcoded `0n` rather than read from account state | the accrued receivable is invisible to every surface |

### NOT TESTABLE — each one blocks promotion on its own

| section | invariant | why |
| ------- | --------- | --- |
| E-4 | April 2026 fee recipients and ordering vs current official Pump docs | needs network access this harness does not take |
| F-7 | a 0.04 SOL round trip under the output limit | the collector opens at 0.02 SOL; no such job exists |
| H-3 | cold / prewarmed-nonprice / repeat runs for one snapshot | needs a fresh snapshot and three full worker round trips per pool |
| H-4 | a warm trajectory refuses shared account creation | there is no warm lane that could refuse |
| I-4 | amortisation changes allocated cost | no claim has ever been made |
| J-4 | the selected tier matches the official SDK result | the SDK does not export `calculateFeeTier` |
| O-3 | the currently disclosed Mayhem agent wallet | needs the live disclosure |
| P-2 | a material WSS update delivered, queued, consumed, resynced | `--live-lane` is off by default; 0 urgent marks have ever fired |

---

## What is genuinely good, and should not be lost in the ledger

- **The Rust worker is exact.** Every u64 boundary, `rentEpoch` at u64 max, a
  negative i64 clock, job-scoped counters, instance identity and
  request/response pairing under a forced timeout — all six probes pass.
- **The cashback tail is fail-closed on both legs**, positionally, skipping the
  two SDK-selected trailing accounts correctly, and an underivable address
  refuses rather than reading as an omission. `leg_cashback` shows the sell
  accruing as often as the buy: the one-leg model is refuted by data.
- **The restart is real.** A daemon started after every previous process was
  SIGKILLed settled a trajectory opened by one of them, with both policies, and
  produced no duplicate mark.
- **Sole-venue attribution refuses a routed entry by name**, and the base-vault
  identity is exact to the atom.
- **Fee-tier selection is a function of market cap**, both directions
  constructed, and the below-first-threshold case charges the first tier.
- **The readiness gate is fail-closed** and no seeded corpus passes it, including
  two that clear both sample thresholds.
- **`pnpm landed:parity-v2` exits non-zero and names its prerequisite.** The
  NOT_IMPLEMENTED discipline works.
- **The collector cannot sign.** 59 modules in its transitive import closure,
  none under `packages/execution`.

---

## Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

Not `VALID_TRAJECTORY_KERNEL_RUNNING`. `docs/29C7CC7_RUNNING_COLLECTOR_REPORT.md`
opens by claiming that state and closes, in section 25, with
`MEASUREMENT_REPAIR_REQUIRED`; the two are irreconcilable and the second is right.
A kernel whose trajectory rows point at three identifiers that do not exist,
whose settlements publish net PnL over an unreconciled payer identity, and whose
entry-policy label was never produced by an entry policy, is not a valid
trajectory kernel — it is an apparatus that runs.

`DEVELOPMENT_EDGE_CANDIDATE` is not claimed: no edge has been measured, and the
only PnL figures in the database are contradicted by their own residuals.

`PUMP_CONFIRMATORY_COLLECTION_STARTED` is not claimed: nothing in the corpus is
graded above `SIMULATED_EXECUTION`.

`CANARY_READY` is not claimed and cannot be. It requires a real canary, which is a
human act, and `pnpm readiness` exits 1 on 22 blockers.

`STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is not claimed either. The economics are
not yet corrected — killing the strategy on these settlements would be killing it
on an accounting defect.

**Eight production invariants are NOT TESTABLE. Any one of them prevents
promotion on its own, and 26 FAILs sit underneath them.**

---

## What this audit changed on the operator's machine

Stated because an audit that mutates and does not say so is worse than one that
does not run.

1. **Ran `pnpm trajectory:collect -- --once --max-candidates=6 --max-open=2 --backfill-scan=6`**
   against the live database (section B). It opened one trajectory,
   `DDHX7W88vs…`, and stored five risk refusals. This is the directive's required
   step.
2. **Section S stopped all five collector daemons and restarted one**, with the
   operator's own flags. The machine now runs a single collector rather than
   five. Its log is `data/collector-daemon-audit.log`.
3. **Ran 31 status commands once each** (section Q). They rewrote their own
   artifacts, which is what they are for — that is the diff you see under
   `artifacts/`. One of those rewrites is finding Q-1 itself: `readiness.json`
   was left holding the *position* gate's report, and has been regenerated from
   `pnpm readiness` before this document was committed.
4. **No write touched `data/runtime.db` other than through the collector and the
   status commands themselves.** Every mutation probe (L, R) ran against a
   VACUUM-consistent copy under the system temp directory. The corpus was opened
   read-only by the harness.

Nothing was funded, signed or submitted. No key was read or created. No canary
and no live run was started. No gate was widened, no risk cap raised, no test
deleted and no timeout increased.

---

## Reproducing this

```bash
# 1. a consistent copy of the corpus (VACUUM INTO, not sqlite3_backup_step)
node --no-warnings -e "new (require('node:sqlite').DatabaseSync)('data/runtime.db',{readOnly:true}).exec(\"VACUUM INTO '/tmp/audit-pre.db'\")"
cp /tmp/audit-pre.db /tmp/audit-mutable.db

# 2. the worker probes (section F) — needs WSL and the built Rust worker
pnpm tsx scripts/runtime-audit-worker-probe.ts /tmp/F.json

# 3. the full ledger
AUDIT_COPY_DB=/tmp/audit-mutable.db AUDIT_SIDECAR=/tmp/sidecar.json \
  pnpm tsx scripts/runtime-adversarial-audit.ts
```

The harness degrades every probe it cannot run to `NOT TESTABLE` with the reason,
never to a silent pass, and it derives the terminal state rather than choosing it:
any FAIL or any NOT TESTABLE pins it at `MEASUREMENT_REPAIR_REQUIRED`.
