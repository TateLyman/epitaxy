# Final report — directive `5d24e39`, ledger first

**Terminal state:**

```
MEASUREMENT_REPAIR_REQUIRED
```

---

## 1. Starting and ending SHA

```
starting   5d24e3973ced25b3b873c0223463895a25828e5a   (local == origin/master, CLEAN)
ending     559799a…                                    branch directive/5d24e39-ledger-first
commits    9, none pushed
```

## 2. Local differences from the directive's premises

The working tree was clean at exactly the audited head. Three things differed
from what the directive assumed, each found rather than accepted:

**`backup.ts` already used `VACUUM INTO`.** The 8f73cef audit described
`onlineBackup` as "the call that does not converge". The function is *named* for
the incremental API and calls `VACUUM INTO`. There was no nonconverging default
to replace.

What there *was*, unnoticed: `openDb` ran that 7 GB backup on **every** open,
whether or not a migration was pending — roughly five minutes and 7 GB of disk
per status command, per script and per collector restart. That is a large part
of why five daemons were left running rather than restarted, and why a mark
scheduler with a 10-second SLA could not exist. It now runs when
`pendingMigrations()` is non-empty, read from the same table `migrate()` reads.

**ONE trajectory collector was running, not five.** A single daemon tree of six
processes, started 2026-08-16 18:27. Section S of the audit had already stopped
the other four and its report says so.

**The WSL checkout is 20 commits behind.** `~/epitaxy` in Ubuntu-24.04 sits at
`3bc708d` with no Rust worker built at all. The trajectory collector's litesvm
worker lives on the **Windows** side and is invoked through WSL by absolute path;
its sha256 is `be02d7855a2b130a4460cdce923a53429f740877a2f151dcacf713686392d7d8`,
matching the audit exactly. The stale WSL tree serves only `epitaxy-simulatord`,
a separate Surfpool daemon.

## 3. Processes and tasks found and stopped

```
found    1 trajectory-collect daemon tree, 6 processes
         21976 -> 17784 -> 20716 -> 9060 -> 26768 -> 12752
stopped  all 6, verified: 0 remain
```

Startup paths capable of launching the collector: **none.** No scheduled task,
no `HKCU`/`HKLM` Run key, no Startup-folder entry. The only registered task is
`epitaxy-simulatord` (Running), which is the WSL simulation daemon and was left
alone. The screening collector was also left alone.

## 4. Backup

```
method       VACUUM INTO, with the trajectory collector stopped
path         data/backups/vacuum-2026-08-17T03-15-49-203Z.db
bytes        7,155,707,904   (source 7,386,337,280)
sha256       97de15dd3717798baf1d466285a211f5e9a54b7fcb0fc3e212e2b1c75d737e55
integrity_check     ok
foreign_key_check   0 violations
wal_checkpoint      {"busy":0,"log":3554,"checkpointed":3554}
schema version      46
nonterminal exposure 0
free disk           781.7 GB
elapsed             320,111 ms
```

Read back and verified: sha256, bytes, per-table counts, max timestamps, schema
version, integrity, foreign keys, exposure. `pnpm db:vacuum-backup` refuses while
a trajectory collector is alive and refuses under 20 GB free.

## 5. Old-context invalidation

Context `5d24e-pre-repair`, validity `INSTRUMENT_DEVELOPMENT_INVALID`,
292 trajectories assigned, **0 unassigned**, nothing deleted.

`pnpm evidence:invalidate-old` re-measures every reason rather than copying it,
and refuses to invalidate a corpus that measures clean. All eleven held; every
figure the audit reported reproduced:

```
DANGLING_EVIDENCE_LINKS      292/292 observation ids and 292/292 job ids dangle
NO_RAW_PRE_POST_STATE        292/292 have no evidence-link row
SNAPSHOT_HASH_IS_NOT_A_HASH  292/292 not 64-hex; 292 fingerprints equal it
PNL_OVER_UNEXPLAINED_VALUE   51 with a residue; 30 publishing net PnL
UNOBSERVED_WRITABLE_ACCOUNTS 292/292
ENTRY_POLICY_IS_A_LABEL      1 distinct policy against 3 defined
LATE_MARKS                   708/1460 more than 60s late   (audit: 697/1448)
NO_COUNTERFACTUAL_CONTRACT   292/292 SIMULATED_EXECUTION
TRAJECTORY_ECONOMICS_NULL    292/292 NULL net_pnl_lamports
DIRTY_TREE_PROVENANCE        26/31 sessions dirty
UNMANAGED_CONCURRENCY        worst mint 58 trajectories
```

`docs/5D24E_INVALID_WINDOW.md`, `artifacts/5d24e-invalid-window.json`.

## 6. Lock and atomic reservation, proved

`trajectory_collector` is its own lock name. `pnpm health` printed OK against
`collector` — a row about `apps/collector/src/main.ts`, a **different program** —
while five instances of the trajectory collector ran unlocked beside it.

Takeover requires a **dead pid AND a stale heartbeat**. A live pid with a stale
heartbeat is a hung collector, not an abandoned lock, and refuses. `EPERM` from
`process.kill(pid, 0)` means the process EXISTS.

The per-mint cap is a schema fact: `UNIQUE(window_id, mint, ordinal)`, a partial
`UNIQUE(window_id, mint) WHERE status='RESERVED'`, and
`CHECK(ordinal <= max_per_mint)`, all inside one `BEGIN IMMEDIATE`.

**Proved:** a ten-process race against a cap of 3 takes exactly 3 reservations
and `capBreaches()` returns empty (P17 #3). `pnpm collector:lock-status` reports
`single owner: YES` and exits non-zero when it does not.

## 7. Evidence schema and graph

Migrations 47 and 48: fifteen new tables, 0 foreign-key violations, schema v48.

```
evidence_contexts            trajectory_evidence_context
experiment_contracts         trajectory_reservations
evidence_blobs               coherent_snapshots
account_state_manifests      simulation_steps
leg_settlements              trajectory_evidence_links
trajectory_policy_decisions  counterfactual_marks
counterfactual_calibration   evidence_transitions
evidence_conflicts
```

Every arrow on `trajectory_evidence_links` is a real foreign key, so **the 292
legacy rows cannot be represented in it.** "0 of 292 resolve" is unexpressible
rather than merely fixed.

`docs/EVIDENCE_GRAPH_V1.md`.

## 8. Ten link traces

**Not produced.** `pnpm trajectory:trace --all --limit=10` reports:

```
no trajectory carries an evidence-link row, so there is nothing to recompute.
Pre-repair trajectories cannot be traced: their raw state was never persisted.
```

That is the honest answer and it is section 22's blocker, not a separate one.
`artifacts/trajectory-trace.json` carries `status: NOT_RUN` with the reason
rather than zeros.

## 9. Blob readback

`registered blobs: 0`. `pnpm evidence:blob-check` reports
`status: NOT_RUN, reason: no evidence blob has been written yet` and exits
non-zero. It does not emit zeros.

The mechanism is proved at unit level: exact transaction bytes round-trip from
the store; a blob whose `readback_verified` flag is cleared is **refused** on
read; an unregistered hash is not durable (P17 #10).

## 10. Snapshot and fingerprint correction

`snapshot_hash` is `coherent.snapshotHash` — a sha256 over the ordered account
manifest plus the decoded clock, rent and epoch schedule. The value was already
computed and was discarded in favour of `${snapshot.slot}`.

A slot number is refused in **two layers**, because a check in one layer can be
bypassed by writing through another: `assertIsHash()` throws `NotAHash`, and a
`BEFORE INSERT` trigger on `coherent_snapshots` aborts anything that is not 64
lowercase hex, and aborts a fingerprint equal to the slot.

The capability fingerprint is a different value over named fields and **moves
with all seven**: fee config, programdata, token program, cashback flag, selected
tier, worker binary hash, SDK versions (P17 #9).

## 11. Direct attribution conservation

The quote leg was tested only for SIGN:

```
quote in -> 0            attributed = false   correct
quote in -> 1 lamport    attributed = TRUE    against a 20,000,000 lamport entry
```

Now the payer outflow must equal the quote-vault credit plus the named fee flows
— protocol, creator vault, buyback, cashback accumulator, each **measured** from
the leg's own pre/post state — within four lamports of documented rounding.

```
one-lamport credit against 0.02 SOL   REFUSED, naming the 19,999,999 residue
payer outflow omitted entirely        REFUSED as a sign test
19,800,000 + 200,000 fees vs 20,000,000   ATTRIBUTED
```

## 12. Settlement identity mutations

Eleven mutations through `buildTrajectorySettlement`. The two that entered **zero
times** now enter exactly once:

```
failedAttemptFeesLamports = 5,000    execution cost moves by exactly 5,000
costs.unexplainedLamports != 0       net PnL is NULL, with the exact residue in
                                     pnl_blocked_reasons AND two identity violations
```

Gate section K: **K-1, K-2 and K-3 all PASS.**

Two defects found by enforcing rather than reading:

- **the payer reconciliation added the cashback claim to the expected side.**
  `claim_cashback` is a third transaction whose lamports never pass through the
  buy or the sell; the expression manufactured a residue of exactly the claimed
  amount. Wrong since it was written; nothing read it, so nothing disagreed.
- **`trajectory-kernel-p4.test.ts` asserted "satisfies the settlement identities"
  over a fixture that could not have happened** — payer deltas short by one base
  fee across the round trip.

## 13. Append-only conflict mutations

All seven the audit ran, plus one:

```
duplicate trajectory id                     REFUSED  EvidenceReplaceRefused
replacement settlement, different economics  REFUSED  SettlementConflict
the identical settlement twice               idempotent
a different mark at a recorded offset        REFUSED  MarkConflict
the identical mark twice                     idempotent
a different exit for one policy              REFUSED  PolicyOutcomeConflict
the identical policy outcome twice           idempotent
an unrelated job attached to a trajectory    REFUSED  FOREIGN KEY constraint failed
zero-row update through the writer           REFUSED  changed 0 rows, expected 1
multi-row close through the writer           REFUSED_BY_KEY, cannot address >1
```

`pnpm trajectory:conflict-test` runs these against a temporary database. Gate
section L: **PASS.**

## 14. Mark scheduler timeliness

Discovery and marks are separate clocks. Marks wake at the next deadline bounded
by a 3-second tick, against a frozen 10-second SLA; discovery keeps 300 seconds
and is **deferred** whenever a mark is past its SLA.

Every mark carries `sla_status`, `due_utc_ms` and `sla_bound_ms`. A late mark is
`MISSED_HORIZON` and is excluded from the readiness sample. The count is printed
every pass.

Observed in the repaired `--once` pass: 10 marks taken, **10 MISSED_HORIZON**, all
against pre-repair trajectories whose horizons were 38,000 s in the past. That is
the correct classification of a backfill, and it is why the mark pass is now
scoped to the window it collects for.

Active context: no marks yet.

## 15. Counterfactual contract and calibration

`BOUNDED_COUNTERFACTUAL_V1` (impact cap 10 bps, haircut 25 bps, both frozen
before outcomes) and `RESERVE_DELTA_REPLAY_V1`. `SIMULATED_EXECUTION` is never
admissible for a holding-period outcome.

Calibration's gate is `conservative`, not `withinTolerance`: a bound *below* the
replayed value is pessimistic and cannot manufacture edge; a bound *above* it
overstates every exit built on it.

**Not calibrated.** 0 bounded rows, 0 replay rows, 0 pairs.
`pnpm counterfactual:calibrate` reports `NOT_RUN` with that reason and exits
non-zero. Every bounded row would be graded `DEVELOPMENT` until it is.

## 16. Entry-policy treatment

`decideEntry` had zero production callers and every row carried the string
literal `HARD_GATES_RANDOM`, written after `admitCandidate` had already decided.

All three policies now decide on the same pre-entry features, and each decides
**twice** — once with the entity-adjusted concentration and once with the raw
share — so `decision_without_risk_facts` shows whether the fact was decisive.

Proved at unit level: three distinct policies on one shared feature set; a
constructed disagreement (quality enters, flow rejects); an unknown feature never
read as a pass (P17 #30, #30b, #30c).

**No production decision rows exist**, because no trajectory has opened.

## 17. Entity / Mayhem / Token-2022 wiring

Entity-adjusted concentration is passed to `decideEntry`, and the raw share is
never silently substituted — an incomplete history can only *understate*
clustering, so `HISTORY_INCOMPLETE` is `null`, and null refuses. Raw and
entity-adjusted are stored separately on the trajectory with the stratum that
says which tier was measured.

Mayhem is a stratum and `CONTAMINATED_UNQUANTIFIED` is not organic (gate O-1:
PASS). Token-2022 uses the canonical decoder: no extension is `NOT_APPLICABLE`,
a present-but-undecodable extension is `UNKNOWN`, and only the second blocks PnL.

Gate O-2 FAILS **only** because the active window has no decisions to inspect.

## 18. Cashback claimable

`claimable` was the literal `0n`. It is now read from the accumulator WSOL ATA
after the round trip — the standing receivable, which is what `claim_cashback`
would release.

Corpus totals (pre-repair): accrued 3,318,560; claimable 0; claimed 0; claim cost
0; accumulator gained 10,489,020 lamports; 28 settlements carry an accrual with
zero claimable, all predating the repair.

Accrued and claimable are **not cash** and do not enter PnL. Only claimed does,
and the claim cost enters execution cost.

## 19. Readiness artifact ownership

```
pnpm readiness            -> artifacts/trajectory-readiness.json
pnpm readiness:positions  -> artifacts/position-readiness.json
```

`writeArtifact` refuses a path, so the two cannot be aimed at one file again.
Every artifact carries the writing script's own filename, the source commit and
whether the tree was dirty.

Readiness loads **one** frozen `experiment_contracts` row and the rows that
belong to it, and refuses outright when no contract exists. Net PnL comes from
the database instead of the literal `null` that sat there while 31 figures did.
The sample is defined by exclusion and the report names which clause emptied it.

Gate R-1: **PASS**. R-2: **PASS** — no seeded corpus passes, including a dirty
artifact claiming READY.

## 20. Runtime-audit tally

Against `contract-d2b2bf4f5f83b0a1`, claiming 52 invariants:

```
PASS 37    FAIL 7    NOT TESTABLE 4    OUT OF SCOPE 8
```

from `PASS 25 / FAIL 26 / NOT TESTABLE 8` at `8f73cef`.

**P13 is NOT satisfied.** It requires FAIL = 0 and NOT TESTABLE = 0.

All eleven blockers are one fact:

```
B-2  a --once pass opens a trajectory        no trajectory opened
B-3  that pass marks and settles             no trajectory opened
C-1  one trajectory traces end to end        no trajectory opened
I-1  both legs accrue, measured              no leg in the active window
M-1  bounded and replay compared             no counterfactual rows
M-2  no outcome without a contract           no outcomes
N-2  all entry policies decide               no decisions
N-3  both exit policies on one path          no paths
O-2  entity concentration alters a decision  no decisions
S-3  restart resumes with open trajectories  none open
S-4  1m/5m/15m marks exist in this context   no marks
```

Eight are OUT OF SCOPE with a recorded reason each (E-4, F-7, H-3, H-4, I-4, J-4,
O-3, P-2) and are therefore not claimed anywhere else either.

## 21. Clean-window contract

```
contract id      contract-d2b2bf4f5f83b0a1
contract hash    d2b2bf4f5f83b0a16016fd7c3c177238d3b20b4d99a93c957e3f2bc3026a23e9
evidence context ctx-faa8e69264f2-DEV_WINDOW_5D24E   DEVELOPMENT_EVIDENCE
cohort           FIRST_HOUR       notional 20,000,000 lamports
entry policies   HARD_GATES_RANDOM, CORRECTED_CURRENT_QUALITY_SCORE, SURVIVOR_FLOW_CONTINUATION_V1
exit policies    FIXED_15M_CONTROL, FLOW_LIQUIDITY_DETERIORATION_V1
mark SLA         10,000 ms
counterfactual   counterfactual-v1, bounded impact cap 10 bps
claimed          52 invariants;  out of scope 8
```

## 22. Valid trajectories and distinct mints

```
0 trajectories, 0 mints
```

**The window did not open.** Measured 2026-08-17T04:50Z:

```
primary   quiknode   HTTP 429  "daily request limit reached - upgrade your account"
fallback  helius     HTTP 429  "max usage reached"
public    mainnet-beta
          getSlot, getAccountInfo, getMultipleAccounts, getTokenSupply,
          getSignaturesForAddress        HTTP 200
          getTokenLargestAccounts        HTTP 429, 0 of 8 at 5s spacing
```

`getTokenLargestAccounts` is the call the concentration gate needs. Without it,
`admitCandidate` refuses every candidate with *"neither entity-adjusted nor raw
concentration could be read"*.

**That refusal is correct and was not weakened.** Unknown concentration is not
safe concentration. The endpoint is the blocker, not the gate.

A repaired `--once` pass confirmed the rest of the path runs: the lock was taken,
the provenance gate passed, the reservation path ran, marks were taken with SLA
verdicts and the pass settled cleanly. Its refusal histogram:

```
3  neither entity-adjusted nor raw concentration could be read
1  the entry is 568.1% of the pool's effective quote reserve, over the 0.5% bound
1  the entry is  75.3% …
1  the entry is  20.1% …
```

The second group is the depth gate: the deep pools in the candidate queue have
already reached their per-mint cap, and what remains is drained.

## 23. Independent recomputation

`0 recomputed, 1 failure` — the failure being that nothing is traceable. No
trajectory carries an evidence-link row.

The mechanism is complete and unit-proved; it has had nothing to run against.

## 24. Active-time RPC usage and purchase recommendation

Measured over **active collector seconds**, not wall time. The figure this
replaces divided by elapsed time including downtime, and concluded quota was not
the constraint while describing the downtime.

```
sessions examined        50
active seconds           70,362   (19.5 h)
sessions never ended     10       killed rather than stopped
total calls              104,852
calls per ACTIVE second  1.489
quota errors             48
trajectories per active day  358.4

93,935  wss_events/logs
 6,238  solana_rpc/getAccountInfo    48 quota errors
 1,700  solana_rpc/getTokenLargestAccounts
 1,700  solana_rpc/getTokenSupply
 1,279  mark_jobs
```

**Recommendation:** **Helius Developer**, approximately $49/month for 10M credits
at 50 RPC requests/second — use the dashboard price as source of truth. It is the
smallest purchase that removes a measured binding constraint: 48 quota refusals
at 1.49 calls per active second, with both endpoints returning explicit
out-of-credit errors. Do not put the key in logs, chat or Git.

**Do NOT buy:** Jupiter Developer (direct PumpSwap is the primary lane and Free's
1 RPS has not been shown to limit completed trajectories); Shreds; a dedicated
validator; colocation; an archival node; Business infrastructure. None before a
positive untouched edge exists.

## 25. Unresolved blockers

1. **RPC capacity.** Both configured endpoints out of credits; the public
   endpoint refuses `getTokenLargestAccounts`. Registered as `S071`, status
   `open`, and the only one that is not a code path. **Closing it is a purchase,
   which is a human act.**
2. **The candidate queue is exhausted at depth.** Deep pools have reached their
   per-mint cap and what remains is drained — 20 % to 568 % of pool quote reserve
   against a 0.5 % bound. New migrations supply new deep pools; discovery needs
   working RPC.
3. **The counterfactual bound is uncalibrated.** Structurally blocked on (1).
4. **Eight invariants are out of scope**, with reasons. Three (E-4, J-4, O-3)
   need out-of-band confirmation against current official Pump disclosure.
5. **9 commits are unpushed**, on `directive/5d24e39-ledger-first`.

## 26. Keep-running commands

```bash
# state, right now
pnpm collector:list                 # must be 0
pnpm collector:lock-status          # must be: single owner YES
pnpm scheduler:status               # marks due, overdue, next deadline
pnpm evidence:graph-check           # twelve link and identity checks
pnpm policy:treatments-status
pnpm rpc:usage                      # over ACTIVE seconds; the purchase question

# the gate, end to end
pnpm gate                           # FAIL 0 and NOT TESTABLE 0 required

# once RPC capacity exists
pnpm doctor                                     # source.rpc must be OK
pnpm trajectory:collect -- --interval=300 --max-open=3 --max-per-mint=3 \
  --contract=contract-d2b2bf4f5f83b0a1
pnpm trajectory:trace -- --all --limit=10
pnpm readiness
```

`docs/CLEAN_WINDOW_RUNBOOK.md` is the full sequence.

## 27. Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

The ledger is repaired: identities resolve or the row cannot exist, unexplained
value withholds PnL and raises a violation carrying its exact number, conflicts
are loud, marks carry their own SLA verdict, all three entry policies decide, and
readiness reads a frozen contract instead of sixteen hardcoded nulls.

`VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` requires ten timely trajectories whose
economics recompute from durable raw evidence. There are zero, and the reason is
an exhausted RPC quota rather than a defect. Claiming the state on a repaired
apparatus that has measured nothing would be the same substitution this whole
directive exists to remove.

Nothing was funded. No key was read or created. Nothing was signed or submitted.
No canary and no live run was started. No gate was widened, no risk cap raised,
no test deleted and no timeout increased.
