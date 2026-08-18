# RUNTIME LEDGER AUDIT — 84984aa

Independent falsification audit of the `5d24e39` ledger-first directive, executed against
the actual local tree, the actual runtime database, the actual WSL worker and the actual
configured read-only RPC. No implementation report, commit message, STATUS claim,
checked-in artifact or test name was taken as evidence.

| | |
|---|---|
| HEAD | `84984aa963f8e26ae5949c14d300f65dd2f557d3` |
| remote | `origin/directive/5d24e39-ledger-first` @ `84984aa` (identical, 0 unpushed) |
| tree at audit start | clean |
| active contract | `contract-2572f62959ca05ab`, frozen at `c3add8b` |
| active context | `ctx-c3add8bff804-DEV_WINDOW_5D24E` |
| corpus | `data/runtime.db`, 9,130,508,288 bytes, schema 53 |
| backup | `data/backups/vacuum-2026-08-18T19-47-03-751Z.db`, 8,878,436,352 bytes, sha256 `18a7c410…f7fc32ebb`, integrity ok, 0 FK violations, 0 exposed positions |
| audited | 2026-08-18 |

**TERMINAL STATE: `MEASUREMENT_REPAIR_REQUIRED`**

Derived, not selected. `B-4` is a FAIL and `B-2`, `B-3`, `S-3` are NOT TESTABLE in the
active development contract. Any one of those pins the state.

---

## The single fact that dominates this audit

**The active contract is stranded, so the corpus cannot accept new evidence at HEAD.**

Ten concurrent trajectory collectors were started (§3). All ten refused. Eight refused with:

```
REFUSED: contract contract-2572f62959ca05ab was frozen at c3add8bff804
and this process is running 84984aa963f8.
```

The only commits between the freeze (`c3add8b`) and HEAD (`84984aa`) are `c3add8b` and
`84984aa` themselves, and `git diff --name-only c3add8b 84984aa` returns **20 files, all of
them under `artifacts/` or `docs/`**. No decision-bearing source changed. The collector
binds the contract to the commit SHA rather than to the decision-bearing subset of the
tree — even though `packages/storage/src/collector-lock.ts` already computes exactly that
distinction (`OUTPUT_ONLY` separates `dirtyArtifacts` from `dirtyFiles`) and uses it for the
dirty-tree gate.

The consequence is that `B-2`, `B-3` and `S-3` — the three invariants that require the
collector to actually collect — cannot become testable at HEAD under this contract, by any
sequence of actions that does not freeze a new contract. The state is pinned partly by
bookkeeping rather than by a property of the market or of the strategy.

---

## Ledger

`source` is what was read. `mutation` is what was done to it. `runtime rows` are the actual
identifiers. `economic consequence` is what the defect costs if believed.

### FAIL

#### B-4 — the corpus contains marks taken at their horizon rather than backfilled

- **source** `trajectory_marks.lateness_ms` / `sla_status`, live database, active context
- **mutation** observation
- **runtime rows** 167 marks over 25 trajectories in `ctx-c3add8bff804-DEV_WINDOW_5D24E`;
  12 `MISSED_HORIZON`, 155 `ON_TIME`

  | offset | n | over 10s SLA | over 60s | max lateness |
  |---|---|---|---|---|
  | 60 000 | 25 | 2 | 0 | 15 111 ms |
  | 180 000 | 25 | 1 | 1 | 75 052 ms |
  | 300 000 | 25 | 3 | 1 | 86 265 ms |
  | 600 000 | 25 | 1 | 1 | 78 189 ms |
  | 900 000 | 25 | 1 | 1 | 85 558 ms |
  | 1 800 000 | 22 | 0 | 0 | 9 677 ms |
  | 3 600 000 | 20 | 4 | 3 | **272 938 ms** |

- **economic consequence** a backfilled horizon carries the right label and the wrong
  instant. The 60-minute horizon is the worst affected, and it is the horizon the
  deterioration policy needs in order to differ from the fixed control. A mark taken 273 s
  late is priced against a pool that moved for 273 s without the strategy.

### NOT TESTABLE (blocking, same weight as FAIL)

#### B-2 — a single `--once` pass opens a trajectory and writes current database rows
#### B-3 — the same pass continues to later marks and settles at least one policy outcome
#### S-3 — the collector was stopped and restarted with open trajectories and resumed correctly

- **source** live collector startup at HEAD
- **mutation** ten concurrent `--once` passes, then a restart attempt
- **runtime rows** all ten exited nonzero; exit 3 / exit 4; 0 trajectories opened in the
  window; `development_trajectories` unchanged at 691 rows
- **economic consequence** the loop that produces every number in this system is unproven
  at the commit that is checked out. `S-1` and `S-2` pass from the *existing* corpus, so
  resumption is evidenced historically but not at HEAD.

---

## Findings beyond the contract's own invariant list

These are defects the claimed invariants do not name, found by attacking the corpus and the
commands directly.

### F-07 — 14 of 15 corpus mutations are invisible to every verifier

Against an isolated copy (database **and** blob tree relocated to scratch, `relative_path`
rewritten so the real corpus was never touched), each mutation was applied one at a time and
then `trajectory:trace`, `evidence:graph-check`, `evidence:blob-check` and
`settlement:check` were run in turn.

| mutation | caught by |
|---|---|
| one lamport of payer delta | `trajectory:trace` |
| one quote-vault lamport | **none** |
| one base atom | **none** |
| fee config bytes | **none** |
| Clock | **none** |
| transfer fee | **none** |
| rent recovery | **none** |
| cashback claim | **none** |
| failed-attempt fee | **none** |
| snapshot blob | **none** |
| transaction bytes | **none** |
| account-plan meta | **none** |
| worker job ID | **none** |
| settlement ID | **none** |
| capability fingerprint | **none** |

**Root cause, confirmed by reading the checker and reproducing by hand.** The identity of a
trajectory is stored twice: on `development_trajectories` and again on
`trajectory_evidence_links`. `scripts/evidence-graph-check.ts:103-113` states
`ENTRY_SETTLEMENT_RESOLVES: 'entry_settlement_id joins leg_settlements'`, joins
`development_trajectories AS t`, and then tests `l.entry_settlement_id` — the *links* copy —
never `t`'s. Setting
`development_trajectories.entry_settlement_id = 'set-BOGUS'` on trajectory
`07c58942-777e-4771-927c-9c79224a4071` produced:

```
ok    ENTRY_SETTLEMENT_RESOLVES
verdict: RESOLVES
```

and `trajectory:trace` reported `RECOMPUTES`, `unexplained 0`.

The two copies currently agree on all 399 rows, so the corpus is not presently corrupt.
Nothing enforces that. `scripts/acceptance-gate.ts:167` reads
`capability_fingerprint, snapshot_hash … FROM development_trajectories` — the gate reads the
copy that is not checked.

- **economic consequence** every integrity guarantee in this system is a guarantee about a
  shadow table. A corrupted settlement ID, job ID, capability fingerprint or fee config on
  the row the gate actually reads passes every check the repository offers.

### F-05 — the milestone criterion reads a file, not the corpus

`scripts/runtime-adversarial-audit.ts:2716-2734` decides
`VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` from
`JSON.parse(readFileSync('artifacts/trajectory-trace.json'))` and tests
`recomputed >= 10 && failures === 0`.

Demonstrated: the file was replaced with

```json
{"traced":10,"recomputed":10,"failures":0,"note":"HAND-WRITTEN BY THE AUDIT - NO TRAJECTORY WAS RECOMPUTED"}
```

and the ledger printed `independently recomputed trajectories: 10 (0 failure(s))`. The
original file was restored immediately afterwards.

This also explains an instability that would otherwise look like nondeterminism: the same
harness reported `10` recomputations at 19:5x and `1` at 20:2x, because ten single-trajectory
`trajectory:trace` runs had each overwritten the artifact with `recomputed: 1`. Neither
number was a measurement of the database.

- **economic consequence** the one criterion separating `MEASUREMENT_REPAIR_REQUIRED` from
  `VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` is forgeable with a text editor, and is
  perturbed by ordinary use of an unrelated command. This is the precise failure `Q-1`
  exists to forbid — "reads a proof artifact as database evidence" — occurring inside the
  ledger that adjudicates `Q-1`.

### F-15 — the harness transcribes verdicts it did not derive

`scripts/runtime-adversarial-audit.ts:158` reads `AUDIT_SIDECAR`. Sections B, F, Q, R and S
consume it. For Q, `sectionQ` computes `bad = q.filter(c => c.verdict === 'FAIL')` and passes
iff `bad.length === 0`, where `q` is a caller-authored array of
`{name, exit, verdict, result}`. For R, `seeds.every(s => s.verdict === 'NOT_READY')`.

`pnpm gate` does genuinely run these probes and derive the verdicts it supplies — the command
sweep runs each command and judges artifact collisions, `NOT_IMPLEMENTED`-with-exit-0, and
unexpected nonzero exits. So the current PASSes are not fabricated. But the ledger cannot
distinguish a sidecar produced by `pnpm gate` from one written by hand, and it records the
result as its own finding either way.

- **economic consequence** six invariants' PASS is an assertion of provenance, not a
  falsification. Running the ledger alone (as this audit first did) correctly reports them
  `NOT TESTABLE`; the PASS appears only when something else vouches for them.

### F-06 — the audit artifact misstates what it audited

`scripts/runtime-adversarial-audit.ts:2740` emits
`auditedRemoteHead: '29c7cc7f086b9be5c21445fabd84f47794251857'` as a hardcoded literal.
The actual remote head is `84984aa963f8e26ae5949c14d300f65dd2f557d3`.

### F-03 — `collector_sessions` leaks a row per refusal

At audit start: **41** rows with `ended_utc_ms IS NULL` and **0** live collector processes.
The ten-collector attack added **8 more** (41 → 49) although every collector refused and
exited. The session row is opened before the contract check and is not closed on the refusal
path.

- **economic consequence** §3 requires "one collector session remains live" as an
  observable. It is not one; it is 49, and the number only grows. Any check written against
  it measures history, not liveness.

### F-04 — `collector:lock-status` reports `single owner: NO` for a single collector

`TRAJECTORY_PATTERN = 'trajectory-collect\.ts'` matches every process in the launcher chain.
For one daemon the observed chain was PIDs 26148 → 27844 → 33664 → 21308 → 35028 → 16768, a
strictly linear npx → tsx → node ancestry, reported as `6 trajectory collector processes are
alive` with `single owner: NO` and exit 1. The command sweep marks this command
`mayExitNonZero: true`, so the false alarm is tolerated rather than caught.

### F-08 — `settlement:check` verifies a window that is empty

```
0 effect-verified leg(s) since 2026-08-18T19:07:43.470Z
wrote artifacts/settlement-identity.json
exit 0
```

`trajectory_settlements.rent_recovered` for `07c58942-…` was set to `999999999` on the copy;
the command reported the same green result. It examines a recent rolling window, finds
nothing in it, and exits 0. `leg_settlements` holds 798 rows and
`trajectory_settlements` 451.

### F-09 — append-only is convention, not constraint

`sqlite_master` contains exactly two triggers, both on `coherent_snapshots`
(`trg_snapshot_hash_is_a_hash`, `trg_capability_fingerprint_is_a_hash`), both shape checks.
There is no append-only trigger on `trajectory_marks`, `trajectory_policy_outcomes`,
`leg_settlements` or `trajectory_settlements`.

| attack | database response |
|---|---|
| same mark offset, different value (INSERT) | refused — UNIQUE `(trajectory_id, offset_ms)` |
| second different exit for one policy (INSERT) | refused — UNIQUE `(trajectory_id, exit_policy)` |
| **same mark offset, UPDATE in place** | **accepted, `changes=1`** |
| update a nonexistent trajectory | no error, 0 rows |
| unguarded `UPDATE development_trajectories SET state='SETTLED'` | no error, **691 rows** |

The application layer never issues `UPDATE` against these tables — `grep` over `packages/`
and `apps/` returns nothing — so the corpus is append-only in practice. The directive's
requirement is that every one of these fail *loudly*; three of five do not.

### F-10 — two of the three entry policies have never entered

Corpus-wide, `trajectory_policy_decisions`:

| entry policy | ENTER | REJECT |
|---|---|---|
| `HARD_GATES_RANDOM` | 230 | 169 |
| `CORRECTED_CURRENT_QUALITY_SCORE` | **0** | 399 |
| `SURVIVOR_FLOW_CONTINUATION_V1` | **0** | 399 |

All three policies are evaluated on every path, so the label is genuinely not attached after
a common decision (`N-2` is correct). But of the five divergence cases §11 requires, two —
"quality enters, random rejects" and "survivor-flow enters, quality rejects" — have **zero**
instances in the corpus, because neither policy has ever entered anything.

- **economic consequence** the entry tournament has one populated arm and two empty ones. No
  comparison between entry policies is available at any sample size, and none will become
  available while both alternatives reject unconditionally.

### F-11 — the recorded risk-fact counterfactual is measured at a layer where it cannot differ

`trajectory_policy_decisions.decision_without_risk_facts` equals `decision` in **1,197 of
1,197** rows corpus-wide (230 ENTER/ENTER, 967 REJECT/REJECT), with
`risk_facts_applied = ["ENTITY_ADJUSTED_CONCENTRATION"]` on every row.

**This is not evidence that the risk fact is inert, and an earlier draft of this finding
said so incorrectly.** The entity-adjusted gate fires *upstream*, at admission, before a
candidate can become a trajectory. It demonstrably fires: the collector logs carry 131
occurrences of

```
entity-adjusted share 57.6% vs limit 50.0%
```

and `reject_tracking` carries 196 `soft:concentration_unknown` and 45
`soft:provider_concentration_high`. Of 445 rows in `entity_concentration`, 392 are
`trustworthy = 1`.

The defect is that the column recorded *on the trajectory* is structurally incapable of
differing. Every trajectory is by construction a candidate that already passed the entity
gate, so `decision_without_risk_facts` is a counterfactual over a population from which the
counterfactual's only effect has already been removed. It will read "the risk fact changed
nothing" forever, no matter how binding the gate becomes.

- **economic consequence** the one stored field that is supposed to evidence a risk fact's
  effect on a decision can never evidence it. `O-2` therefore passes only on a constructed
  counterexample, and the corpus offers no way to confirm or refute the gate's live effect
  from the trajectory record alone — the evidence exists only in log text, which is not
  queryable evidence and is not covered by any invariant.

### F-12 — the counterfactual calibration rests on two rows

`counterfactual_calibration` is **empty (0 rows)**. The checked-in
`artifacts/counterfactual-calibration.json` reports `boundedRows: 2253`, `replayRows: 22`,
**`pairedRows: 2`**, and on that basis `"verdict": "BOUND_IS_CONSERVATIVE"`, with provenance
`sourceCommit: c3add8b`, `treeDirty: true`, `dirtyFiles: 11`.

What does hold, and is real: the bound is *enforced*. 41 counterfactual marks in the active
context carry
`IMPACT_ABOVE_BOUND: the entry moved the pool 11 bps, over the frozen bound of 10 bps`.
A non-conservative path is refused rather than haircut.

### F-13 — artifact provenance marks itself stale

Of 110 files in `artifacts/`, **27** carry provenance at all. Of those, **16** are stamped
`treeDirty: true` and **21** carry a `sourceCommit` other than HEAD — including
`trajectory-readiness.json` (`c3add8b`, `dirtyFiles: 13`) and `experiment-contract.json`
(`c3add8b`, `dirtyFiles: 20`).

There are two incompatible definitions of "dirty" in the tree:

- `packages/storage/src/collector-lock.ts:505-509` filters `OUTPUT_ONLY` paths and sets
  `dirty = dirtyFiles.length > 0` — artifacts do **not** dirty the tree.
- `packages/research/src/artifact-provenance.ts:38` sets
  `dirty = git status --porcelain … .length > 0` — artifacts **do** dirty the tree.

Because `artifacts/` is tracked, writing one artifact dirties the tree, so every artifact
written afterwards is stamped `dirty: true`. This audit reproduced it without touching a
single source file: ten read-only commands left `10` modified tracked files. The provenance
flag whose stated purpose is "a dirty artifact is not reproducible" is true almost always,
and therefore carries no information.

### F-14 — the seed sweep covers 4 of the 10 conditions

`pnpm gate` ran: `baseline`, `200 losses`, `a dirty artifact claiming READY`,
`replay divergences present` — all `NOT_READY`. Not exercised: a positive sample carried by
three winners; invalid old contexts; unrelated simulation jobs; late marks; unresolved
blocked exits; nonzero unexplained values; missing raw blobs; wrong capability fingerprint.

The harness states the reason plainly in its own output, and it is correct: *"none of these
can pass, but only because fourteen gates are hardcoded UNKNOWN. The gate is not
discriminating between the seeds; it is refusing all of them for the same reason."*

### F-16 — the development contract does not pin capture capability

The contract's `capability_fingerprint` is `sha256(JSON.stringify(SDK_VERSIONS))` — a
contract-level statement of the venue model, documented as such at
`scripts/contract-freeze.ts:216`. It is deliberately *not* the per-capture fingerprint.

The per-capture fingerprints inside that one frozen contract's context are three distinct
values: `d7a568ed…` (12 trajectories), `2bbe26af…` (7), `5cde7c92…` (6). Nothing constrains
them: `approvedFingerprints` exists at
`packages/research/src/confirmatory-trajectories.ts:128` but is supplied as `[]` by
`scripts/trajectory-status.ts:190`, and the development path never populates it.

- **economic consequence** §14 requires that a wrong capability fingerprint cannot pass.
  In the development path there is no approved set to violate, so capture-capability drift
  inside a frozen window is undetectable — and it demonstrably occurred three times inside
  this one.

---

## What holds

Verified independently, not accepted from a report.

| | evidence |
|---|---|
| **corpus integrity** | `VACUUM INTO` backup verified on read-back: integrity ok, 0 FK violations, schema 53, 0 exposed positions, sha256 recorded |
| **all 21 §5 link classes resolve** | 20 settled trajectories in the active context; contract, reservation, snapshot, manifest/blob, entry plan, entry tx bytes, both observations, both worker job/step, both raw pre/post, both settlements, marks, policy decisions, trigger, trajectory settlement, policy outcome, readiness row, counterfactual — **0 dangling** |
| **independent recomputation** | 10 of 10 trajectories recompute exactly; `unexplained 0` on every one. `scripts/trajectory-trace.ts` imports only `openDb`, `EvidenceStore`, `writeArtifact` — it genuinely does not call `buildTrajectorySettlement`; the only match for that name in the file is the comment saying so |
| **dirty-tree refusal (§4)** | modifying `packages/strategy/src/exits.ts` uncommitted → exit **2**, refusal names the file. `--instrument-development` → exit **4**, and only after printing "Its context is permanently excluded from every report and from readiness" |
| **single writer (§3)** | exactly one process reached the OS lock file; the rest refused. Lock released cleanly on exit — `trajectory_collector` absent from `process_locks` afterwards. `maxPerMint=3` respected: 0 mints over cap across 399 `OPENED` reservations. 0 duplicate opens |
| **counterfactual bound enforced (§10)** | 41 marks refused with `IMPACT_ABOVE_BOUND` at 11 bps against the frozen 10 bps; both `BOUNDED_COUNTERFACTUAL_V1` (166) and `RESERVE_DELTA_REPLAY_V1` (4) present with grade and haircut stored |
| **exit treatments genuinely differ (§11)** | on 20 shared paths, `FIXED_15M_CONTROL` triggers at 900 000 ms on all 20; `FLOW_LIQUIDITY_DETERIORATION_V1` falls back to 900 000 ms on 13 and extends to 1 800 000 ms on **7**. The two policies disagree on 7 of 20 |
| **external constants (§12)** | `PUMP_PROGRAM` `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` matches pump-fun/pump-public-docs. `MAYHEM_PROGRAM` `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` confirmed against the official docs. Agent identity is correctly held `UNKNOWN` with the reason attached rather than guessed |
| **Token-2022 NOT_APPLICABLE vs UNKNOWN (§12)** | `packages/intelligence/src/risk-facts-order.ts:174,177` returns `NOT_APPLICABLE` for a legacy mint and for a Token-2022 mint with no transfer-fee extension, and `UNKNOWN` only when the fact was not obtained. `packages/domain/src/trajectory-settlement.ts:51` — "Only UNKNOWN blocks. NOT_APPLICABLE contributes a real, measured zero" |
| **stale-lock recovery** | the killed owner's `trajectory_collector` lock did not block a later start; the `engine` lock (pid 35036, heartbeat 309 738 s stale) is correctly reported `DEAD` rather than honoured |

One caveat on the single-writer result: because eight of the ten collectors refused on the
contract mismatch *before* reaching lock acquisition, only about two processes genuinely
contended for the lock. The property held, but the test was weaker than intended, and it
cannot be strengthened until a contract exists at HEAD.

---

## Harness tally at HEAD

Ledger alone, no sidecar — what the repository can prove about itself unaided:

```
PASS 40   FAIL 1   NOT TESTABLE 7   OUT OF SCOPE 5
```

With `pnpm gate` supplying externally-derived probe evidence:

```
PASS 49   FAIL 1   NOT TESTABLE 3   OUT OF SCOPE 6
```

Both derive `MEASUREMENT_REPAIR_REQUIRED`.

`VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` requires one collector, clean source, ten completed
timely trajectories, all links resolving, durable raw evidence, exact independent PnL
recomputation, zero unexplained value, actual treatments and a valid counterfactual contract.
Six of those nine hold. **One collector** does not (none can start). **Ten completed timely
trajectories** does not (12 marks missed their horizon; the milestone counter reads a file).
**Actual treatments** does not (two of three entry arms have never entered).

---

## Reproduction

```bash
pnpm db:vacuum-backup                 # refuses while a collector holds the lock, by design
pnpm runtime:audit                    # ledger alone
pnpm gate                             # copy-based probes + ledger
pnpm gate --with-live-run             # adds B-2/B-3/S-3 — currently refuses, see above
pnpm trajectory:trace -- --trajectory=<id>
pnpm evidence:graph-check
```

Destructive probes in this audit ran only against
`…/scratchpad/copy-base.db` with the blob tree copied alongside and
`evidence_blobs.relative_path` rewritten, so `data/runtime.db` and `data/evidence-blobs`
were never mutated. The one live write attempted was the ten-collector start, which opened
no trajectory because all ten refused.

---

## Not fixed

Per the directive, nothing above was repaired. The complete ledger is the deliverable.

The repairs these findings imply, in the order their absence currently blocks measurement:

1. bind the contract to the decision-bearing subset of the tree, not to the commit SHA —
   `collector-lock.ts` already computes the distinction;
2. derive the recomputation count from the database, not from `artifacts/trajectory-trace.json`;
3. make the integrity checks read the same columns the gate reads, or enforce that the two
   copies of the identity agree;
4. close `collector_sessions` on the refusal path;
5. establish why `CORRECTED_CURRENT_QUALITY_SCORE` and `SURVIVOR_FLOW_CONTINUATION_V1`
   reject unconditionally before any entry comparison is attempted.

Item 5 is the one that decides whether there is anything to measure. The other four decide
whether the measurement can be believed.
