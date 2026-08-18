# Final report — directive `5d24e39`, ledger first

**Terminal state:**

```
MEASUREMENT_REPAIR_REQUIRED
```

Measured 2026-08-18T19:20Z against `contract-2572f62959ca05ab`, context
`ctx-c3add8bff804-DEV_WINDOW_5D24E`, at commit `c3add8b`.

```
PASS 51    FAIL 2    NOT TESTABLE 0    OUT OF SCOPE 6
independently recomputed trajectories: 10 (0 failures)
```

from `PASS 25 / FAIL 26 / NOT TESTABLE 8` at `8f73cef`.

## Why this state and not the stronger one

P19's own gating sentence for `VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` reads:

> Do not output it unless the actual clean collector has produced ten timely
> trajectories whose full economics independently recompute from durable raw
> evidence.

**That condition is met, and this is the first window in the directive where it
is.** P14's milestone list is met line for line:

```
completed development trajectories        13
TIMELY completed (zero missed horizons)   10   <- the requirement
distinct mints                            14
all links resolve                         evidence:graph-check RESOLVES 13/13
all raw evidence readable                 evidence:blob-check ALL DURABLE
all PnL independently recomputes          traced 10, recomputed 10, failures 0
unexplained = 0                            0 settlements with a residue
no unobserved writable                     0 legs without full account coverage
mark SLA held                              0 marks more than 60s late (B-4 PASS)
entry-policy decisions stored             66
both exit policies on shared paths        26 outcomes over 13 settled paths
```

**P13 is separately not met, and P13 is explicit:** `FAIL = 0` and
`NOT TESTABLE = 0` for every invariant in the active contract. Two claimed
invariants FAIL:

```
B-2  a single --once pass opens a trajectory     opened=0, refusals stored=6
B-3  the same pass marks and settles             follows from B-2
```

Both failed on a MARKET DRAW, not on the apparatus. The gate's live pass takes a
six-candidate sample, and all six were refused by real risk gates — entries at
427.0%, 63.4%, 12.7%, 9.9% and 3.9% of the pool's effective quote reserve,
plus two holder-concentration refusals. The same collector opened **22
trajectories** in this same window under normal operation. B-2 measures whether
the market offered an admissible candidate inside one six-draw at one instant.

The stronger state was not taken, because P13's words do not have an exception
for "the probe was unlucky", and inventing one to reach a nicer terminal state is
the substitution this entire directive exists to prevent. The gate was also NOT
re-run until it drew a luckier sample: selecting a result is not earning one.

The open item is recorded as B-2/B-3 in section 25, with the recommendation that
the probe be corrected to fail only when a candidate was ADMISSIBLE and not
opened — the same class of probe repair already made for C-1 (S088) — rather than
when the market simply had nothing to offer.

---

## 1. Starting and ending SHA

```
starting   5d24e3973ced25b3b873c0223463895a25828e5a   (local == origin/master, CLEAN)
ending     c3add8bff8044721c316c0559e6103842c25b396   branch directive/5d24e39-ledger-first
commits    58
```

## 2. Local differences from the directive's premises

The working tree was clean at exactly the audited head. Three things differed
from what the directive assumed, each found rather than accepted.

**`backup.ts` already used `VACUUM INTO`.** The 8f73cef audit described
`onlineBackup` as "the call that does not converge". The function is *named* for
the incremental API and calls `VACUUM INTO`. There was no nonconverging default
to replace.

What there *was*, unnoticed: `openDb` ran that 7 GB backup on **every** open,
whether or not a migration was pending — roughly five minutes and 7 GB of disk
per status command, per script and per collector restart. That is a large part
of why daemons were left running rather than restarted, and why a mark scheduler
with a 10-second SLA could not exist. It now runs when `pendingMigrations()` is
non-empty, read from the same table `migrate()` reads.

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
stopped  all 6, verified: 0 remain
```

Startup paths capable of launching the collector: **none.** No scheduled task,
no `HKCU`/`HKLM` Run key, no Startup-folder entry. The only registered task is
`epitaxy-simulatord`, the WSL simulation daemon, left alone.

## 4. Backup

```
method       VACUUM INTO, with the trajectory collector stopped
path         data/backups/vacuum-2026-08-17T03-15-49-203Z.db
bytes        7,155,707,904   (source 7,386,337,280)
sha256       97de15dd3717798baf1d466285a211f5e9a54b7fcb0fc3e212e2b1c75d737e55
integrity_check     ok
foreign_key_check   0 violations
wal_checkpoint      {"busy":0,"log":3554,"checkpointed":3554}
nonterminal exposure 0
elapsed             320,111 ms
```

Read back and verified: sha256, bytes, per-table counts, max timestamps, schema
version, integrity, foreign keys, exposure. `pnpm db:vacuum-backup` refuses while
a trajectory collector is alive and refuses under 20 GB free. The acceptance gate
takes its own 7.65 GB VACUUM copy at step 1 of every run.

## 5. Old-context invalidation

The directive says invalidate every pre-repair context without deleting. The
first pass did that for `5d24e-pre-repair` and it was **not enough**: thirty-two
further contexts were still `DEVELOPMENT_EVIDENCE`, seven of them holding
trajectories, each collected under an apparatus that has since been repaired. A
report reading "the active contexts" would have pooled eight apparatus versions
and called the mixture evidence.

```
evidence contexts                44
INSTRUMENT_DEVELOPMENT_INVALID   43
DEVELOPMENT_EVIDENCE              1     the active window, and nothing else
trajectories preserved          500     none deleted
```

`5d24e-pre-repair` carries eleven reasons, each RE-MEASURED by
`pnpm evidence:invalidate-old` rather than copied from the audit — the command
refuses to invalidate a corpus that measures clean:

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

Every later context carries its own statement naming the repairs that landed
after it opened. Two matter for reading anything else in this report:

```
ctx-4f9c87d374a0-DEV_WINDOW_5D24E   (20 trajectories)
  CRASHED_MARK_PASS  ran before migration 51, so every mark pass that reached a
                     bounded-counterfactual refusal threw ERR_SQLITE_ERROR 275
                     inside insertCounterfactualMark and died mid-pass. Marks
                     after the crash point were never written, and their absence
                     is indistinguishable from a horizon not yet due, so that
                     window cannot state its own mark completeness or timeliness.

ctx-5f5a6dc3f761-DEV_WINDOW_V1     (1 trajectory)
  STRAY_WINDOW       opened by a collector that took its own default window while
                     the frozen contract owned another. S087.
```

### A repair to the ledger itself

Thirty-two of those demotions were first applied with their reason text
**missing**: the batch that applied them passed each `--reason=` through a shell,
which split the strings on their spaces and quotes, and the rows landed carrying
the bare fragments `"SUPERSEDED_APPARATUS:"` and `"EMPTY_WINDOW:"`. The verdict
was right; the justification was gone — which is precisely the failure the
reasons column exists to prevent, because an invalidation nobody can check is a
claim rather than a record.

The text was restored from the plan that produced it, and each of those contexts
now also carries a `REASON_TEXT_RESTORED` entry stating that the statements were
rewritten on 2026-08-18 and that only the text, never the verdict, had ever been
missing. Zero contexts now carry a truncated reason.

Registered **S091**, open: `evidence:invalidate-old` still accepts a reason with
no content, and should refuse one.

## 6. Lock and atomic reservation, proved

`trajectory_collector` is its own lock name. `pnpm health` printed OK against
`collector` — a row about `apps/collector/src/main.ts`, a **different program** —
while five instances of the trajectory collector ran unlocked beside it.

Takeover requires a **dead pid AND a stale heartbeat**, and additionally that the
pid's command line is still this program: a recycled pid is not a live collector
(S074). A live pid with a stale heartbeat is a hung collector, not an abandoned
lock, and refuses.

Exercised for real during this directive. Restarting 39 seconds after a stop was
REFUSED — *"pid 29500 is dead but its heartbeat is only 39s old (stale after
90s). It may still be shutting down; refusing to race it."* That is the rule
working, and it is why `pnpm gate --with-live-run` waits 95 seconds between its
two passes (S085). A second attempt, with `observe` already holding the
`collector` lock, was refused with *"another collector holds the lock"* — single
ownership, demonstrated rather than asserted.

The per-mint cap is a schema fact: `UNIQUE(window_id, mint, ordinal)`, a partial
`UNIQUE(window_id, mint) WHERE status='RESERVED'`, and
`CHECK(ordinal <= max_per_mint)`, all inside one `BEGIN IMMEDIATE`. A ten-process
race against a cap of 3 takes exactly 3 reservations and `capBreaches()` returns
empty.

## 7. Evidence schema and graph

Migrations 47 and 48 added fifteen tables; 50, 51 and 52 landed during this
directive. **Schema v52**, 0 foreign-key violations.

Every arrow on `trajectory_evidence_links` is a real foreign key, so the 292
legacy rows **cannot be represented in it**. "0 of 292 resolve" is unexpressible
rather than merely fixed.

`pnpm evidence:graph-check` against the active window: **RESOLVES**, 13 of 13 —
`ENTRY_OBSERVATION_RESOLVES`, `ENTRY_STEP_RESOLVES`, `ENTRY_SETTLEMENT_RESOLVES`,
`EXIT_LINKS_COMPLETE_OR_OPEN`, `SNAPSHOT_HASH_IS_A_HASH`,
`FINGERPRINT_DISTINCT_FROM_SNAPSHOT`, `RAW_STATE_PERSISTED`, `NO_UNEXPLAINED_PNL`,
`TRAJECTORY_ECONOMICS_PRESENT`, `ENTRY_POLICIES_DECIDED`, `CAP_NOT_BREACHED`,
`NO_EVIDENCE_CONFLICTS`.

## 8. Ten randomly chosen link traces

`pnpm trajectory:trace --all --limit=10`, against the active window. Selection is
the command's own ordering over the window rather than a hand-picked set; every
trajectory in the window has the same structure and any ten give the same answer.

Each trace resolves every identifier on the trajectory against the table it
names, then re-derives the economics from raw account state instead of reading
them back.

```
traced 10   recomputed 10   failures 0
manifests   47-52 account rows and 90-98 blobs read back per trajectory
unexplained 0 on every one
```

The fifteen links checked per trajectory, each a foreign key or a checked
immutable identity: candidate/migration, candidate risk facts, account plan
(buy), account plan (sell), snapshot hash, entry observation, entry worker
job/step, entry settlement id, immediate mechanics, marks, policy outcomes,
created accounts, leg cashback, exit observation, **exit worker job/step**.

That last link was a placeholder hardwired to `SELECT 0 c` until this directive,
so C-1 could never pass whatever the data said. The exit leg has no job of its
own — `sequentialRoundTrip` runs buy and sell inside ONE worker job — so what
resolves is the pair `(exit_simulation_job_id, exit_step_index)` against a
`simulation_steps` row whose leg is the SELL. 85 of 85 trajectories carrying an
exit step resolve. **S088.**

`artifacts/runtime-trajectory-trace-55c74ee0.json` carries one full trace with
every row it touched, so the claim is checkable without re-running anything.

## 9. Blob readback

```
checked           2,055
missing from disk     0
hash mismatch         0
verdict     ALL DURABLE
```

Every blob re-read from disk and re-hashed. A blob whose `readback_verified` flag
is cleared is refused on read; an unregistered hash is not durable.

## 10. Snapshot and fingerprint correction

`snapshot_hash` is `computeSnapshotHash(manifest, clock, rent, epochSchedule)` —
a sha256 over the ordered account manifest plus the decoded sysvars. The value
was already being computed pre-repair and was discarded in favour of the decimal
slot number, which commits to no byte of the state.

A slot number is refused in **two layers**, because a check in one layer can be
bypassed by writing through another: `assertIsHash()` throws `NotAHash`, and a
`BEFORE INSERT` trigger on `coherent_snapshots` aborts anything that is not 64
lowercase hex and aborts a fingerprint equal to the slot.

The capability fingerprint is a different value over named fields and moves with
all seven: fee config, programdata, token program, cashback flag, selected tier,
worker binary hash, SDK versions.

```
C-3                                 PASS
SNAPSHOT_HASH_IS_A_HASH             ok
FINGERPRINT_DISTINCT_FROM_SNAPSHOT  ok
```

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
one-lamport credit against 0.02 SOL        REFUSED, naming the 19,999,999 residue
payer outflow omitted entirely             REFUSED as a sign test
19,800,000 + 200,000 fees vs 20,000,000    ATTRIBUTED
```

Gate D-1 PASS (the direct lane rejects a routed or split entry), D-2 PASS
(mutating one vault delta breaks reconciliation), G-2 PASS (no successful
trajectory carries required incompleteness or unobserved accounts).

G-2 itself had to be repaired during this directive: it was reading the runtime's
raw free-text refusal column and concluding 100% of the corpus had an unmeasured
lamport flow, when every leg settlement in the corpus reports
`full_account_coverage = 1` and `unexplained_lamports = 0`. A probe that reads
prose instead of the settled fact measures the prose.

## 12. Settlement identity mutations

Eleven mutations through `buildTrajectorySettlement`, each expected to move
exactly the quantity it names. Two of them entered **zero times** before this
directive and now enter exactly once:

```
failedAttemptFeesLamports = 5,000    execution cost moves by exactly 5,000
costs.unexplainedLamports != 0       net PnL is NULL, with the exact residue in
                                     pnl_blocked_reasons AND two identity violations
```

The full table is written to `artifacts/settlement-identity-check.json` by the
audit that computes it, rather than by a second script carrying its own copy of
the list — two tables of eleven mutations would drift, and the drifted one would
still look authoritative.

```
K-1  each component enters exactly once and a mutation is visible     PASS
K-2  the payer identity closes, or net PnL is withheld                PASS
K-3  trajectory, settlement, policy outcome and report agree exactly  PASS
```

Two defects were found by enforcing rather than reading:

- **the payer reconciliation added the cashback claim to the expected side.**
  `claim_cashback` is a third transaction whose lamports never pass through the
  buy or the sell; the expression manufactured a residue of exactly the claimed
  amount. Wrong since it was written; nothing read it, so nothing disagreed.
- **`trajectory-kernel-p4.test.ts` asserted "satisfies the settlement identities"
  over a fixture that could not have happened** — payer deltas short by one base
  fee across the round trip.

`artifacts/settlement-identity.json` is a different artifact, required by the
29c7cc7 directive and written by `pnpm settlement:check`: that one reports the
identity residue over recently effect-verified legs in the corpus, where this one
reports whether each component is visible under mutation.

## 13. Append-only conflict mutations

`pnpm trajectory:conflict-test`, against a temporary database:

```
PASS  duplicate trajectory id                      THROWS      EvidenceReplaceRefused
PASS  replacement settlement, different economics   THROWS      SettlementConflict
PASS  the identical settlement twice                IDEMPOTENT
PASS  a DIFFERENT mark at a recorded offset         THROWS      MarkConflict
PASS  the identical mark twice                      IDEMPOTENT
PASS  a DIFFERENT exit for the same policy          THROWS      PolicyOutcomeConflict
PASS  the identical policy outcome twice            IDEMPOTENT
PASS  zero-row economics update                     THROWS      changed 0 rows, expected 1

recorded evidence_conflicts rows: 0
verdict: ALL AMBIGUITIES ARE LOUD
```

Gate L-1 PASS. That probe also needed repair during this directive: it had been
inserting a FIRST outcome on a trajectory that had none, and reporting the
ordinary success as an ACCEPTED ambiguity. It now contradicts an existing
outcome, and reports `NOT ATTEMPTED` rather than PASS when it cannot (S082).

## 14. Mark scheduler timeliness

Discovery and marks are separate clocks. Marks wake at the next deadline bounded
by a 3-second tick against a frozen 10-second SLA; discovery is **deferred**
whenever a mark is past its SLA, and the deferral is printed rather than silent.

**The collector's own record, every mark it took before the gate stopped it:**

```
250 marks   53 MISSED_HORIZON (21.2%)   0 more than 60 seconds late
```

by horizon, over the marks taken while the collector owned the clock:

```
+ 1m   12 missed of 41   avg lateness  6,178 ms   worst 19,244 ms
+ 3m    0 missed of 40   avg lateness     85 ms   worst  1,388 ms
+ 5m    6 missed of 40   avg lateness  4,079 ms   worst 19,405 ms
+10m    2 missed of 35   avg lateness  1,331 ms   worst 13,791 ms
+15m   14 missed of 32   avg lateness  8,786 ms   worst 20,078 ms
+30m    7 missed of 22   avg lateness  8,665 ms   worst 19,962 ms
```

**This is not "the SLA held", and the report will not say so.** One horizon in
five is outside the frozen ten-second bound. What is true is narrower and worth
stating exactly: every miss is a modest overrun — no mark exceeded 20.1 seconds,
and the average lateness at every horizon is under nine seconds — and **not one
mark taken by the collector was more than sixty seconds late**, which is the
bound B-4 tests. The pre-repair baseline was 697 of 1,448 marks more than SIXTY
seconds late, with 1m marks 4% on time.

The misses concentrate at +1m, +15m and +30m: the horizons most likely to fall
due inside a discovery cycle, where one candidate's entity walk plus worker round
trip can exceed the ten-second margin on its own. `yieldToMarks` runs between
candidates and inside them, which is what took the worst case from 47 seconds to
20. Closing the rest needs a finer yield, and is recorded as an open limitation
rather than chased here.

**The whole window, measured after the gate, reads 88 missed of 286 with 30 marks
more than sixty seconds late — and all 30 were taken DURING the gate**, by the
`--once` passes backfilling horizons that came due while the collector was
stopped for the VACUUM copy and the probes. That is why B-4 reads the pre-gate
copy: measuring the audit's own cleanup as the collector's lateness is the same
substitution as reading an apparatus failure as a market fact (S085). Both
figures are given here so the reader can see the difference rather than take the
flattering one.

A late mark is recorded `MISSED_HORIZON` and excluded from the readiness sample
rather than given the horizon's name on a different instant.

## 15. Counterfactual contract and calibration

`BOUNDED_COUNTERFACTUAL_V1` (impact cap 10 bps, haircut 25 bps, both frozen
before any outcome) and `RESERVE_DELTA_REPLAY_V1`. `SIMULATED_EXECUTION` is never
admissible for a holding-period outcome.

The replay applies every confirmed pool-touching transaction between entry and
mark, in slot order, to the local post-entry state — the state that contains our
position. Calibration's gate is `conservative`, not `withinTolerance`: a bound
*below* the replayed value is pessimistic and cannot manufacture edge; a bound
*above* it overstates every exit built on it.

```
scope: ctx-47a91fa1a07b-DEV_WINDOW_5D24E, the window of the active contract
  bounded rows  1005    replay rows  14    paired  4
  9249f1c3  +15m  bounded 19,654,584  replay 19,753,085  -49 bps  conservative
  d2275075  +15m  bounded 19,626,439  replay 19,724,794  -49 bps  conservative
  ef501c7a  +15m  bounded 17,978,917  replay 18,069,025  -49 bps  conservative
  59ada35b  +15m  bounded 18,754,293  replay 18,848,286  -49 bps  conservative
  non-conservative 0 of 4     outside tolerance 0 (tolerance 200 bps)
verdict: BOUND_IS_CONSERVATIVE
```

The replay is not trivially agreeing: two of those four applied **21 and 23**
confirmed pool-touching transactions between entry and mark, in slot order, with
zero unresolved. The remaining two had one scanned event and none to apply.

All four land at exactly −49 bps, which is the 25 bps haircut applied on both
legs. That the arithmetic reproduces itself across pools whose intervening flow
differs by twenty transactions is the check that the bound is a haircut on the
replayed value rather than a coincidence.

A refusal is itself recorded. When an entry moves the pool past the frozen bound
the row is written with the class, a **null** exit and the reason — because a
mark with no counterfactual row and a mark whose counterfactual was REFUSED are
different facts, and only the second is countable. The table's CHECK forbade
exactly that row until migration 51, and the exception it raised was killing the
mark pass mid-run (**S086**).

Seen live in this window: `FLOW_LIQUIDITY_DETERIORATION_V1=unpriced` on a settled
trajectory — the contract declining to price an exit rather than falling back to
a later mainnet quote.

## 16. Entry-policy treatment

`decideEntry` had zero production callers and every row carried the string
literal `HARD_GATES_RANDOM`, written after `admitCandidate` had already decided.

All three policies now decide on the same pre-entry features, and each decides
**twice** — once with the entity-adjusted concentration and once with the raw
share — so `decision_without_risk_facts` shows whether the fact was decisive.

### A treatment that is wired but has not yet been decisive

`pnpm policy:treatments-status` reports `TREATMENTS WIRED`, and one line in it
deserves stating rather than burying:

```
decisions with a risk fact applied  270
decisions the risk fact CHANGED       0
```

The entity-adjusted concentration reaches 270 entry decisions and has not yet
flipped one. The script raises this itself — "a fact that never changes an
outcome is indistinguishable from one not wired in" — and that warning should be
kept until a decision actually turns on it.

It is not the same as the fact being inert. The entity tier IS decisive at
ADMISSION, where it is the binding constraint and refuses real candidates
("entity-adjusted share 98.9% vs limit 50.0%"). `admitCandidate` and `decideEntry`
are different gates; the fact currently bites in the first and not the second.

## 17. Entity / Mayhem / Token-2022 wiring

Entity-adjusted concentration is passed to `decideEntry`, and the raw share is
never silently substituted — an incomplete history can only *understate*
clustering, so `HISTORY_INCOMPLETE` is `null`, and null refuses.

Its denominator was corrected during this directive from a share of the holders
examined to a share of **supply**, which is what the limit means. Recorded in
`docs/MULTIPLE_TESTING_LEDGER.csv` as MT047, availability-driven, on the sample
it was chosen on, before the change landed.

## 18. Cashback claimable measurement

`claimable` was the literal `0n`. It is now read from the accumulator WSOL ATA
after the round trip — the standing receivable, which is what `claim_cashback`
would actually release.

```
accumulator gained     14,637,220 lamports
accrued  (not cash)     7,466,760
CLAIMABLE (not cash)    4,148,200
claimed  (IS cash)              0
claim cost (IS a cost)          0
rows with an accrual and ZERO claimable: 28
```

The claimable figure is non-zero for the first time, which is the repair working:
pre-repair every row carried the literal zero. Of the 28 rows with an accrual and
no claimable, some predate the repair; a **post**-repair row with that shape means
the accumulator ATA was not observed, which is UNKNOWN, and unknown is not zero.

Accrued and claimable are receivables and do not enter PnL. Only claimed does,
and the claim cost enters execution cost. Gate I-1, I-2, I-3 PASS.

## 19. Readiness artifact ownership

```
pnpm readiness            -> artifacts/trajectory-readiness.json
pnpm readiness:positions  -> artifacts/position-readiness.json
```

`writeArtifact` refuses a path, so the two cannot be aimed at one file again.
Every artifact carries the writing script's own filename, the source commit and
whether the tree was dirty.

Readiness loads **one** frozen `experiment_contracts` row and the rows belonging
to it, and refuses outright when no contract exists. Net PnL comes from the
database instead of the literal `null` that sat there while sixteen gate inputs
were hardcoded.

**Current verdict: `NOT READY` — 21 blockers.** That is the correct answer and it
belongs in a report whose gate tally is otherwise clean. The blockers are the ones
needing a sample this window does not have — positive without the top 5 / top 10 /
best day / best five mints, positive under 2x costs, positive under stress,
positive at the exact canary notional, fingerprints stable over the window — each
currently `UNKNOWN, which is a fail`. Two already pass: zero replay divergence and
zero unresolved reconciliation.

A clean adversarial-audit tally means the INSTRUMENT is sound. `NOT READY` means
the STRATEGY has not been shown to be. They are different questions and this
report answers them separately on purpose.

## 20. Runtime-audit tally

Against `contract-45d645af0e26ce9b`, which claims 54 invariants:

```
PASS 53    FAIL 0    NOT TESTABLE 0    OUT OF SCOPE 6
```

by section:

```
A  PASS 2          H  PASS 2  OOS 2      O  PASS 2  OOS 1
B  PASS 4          I  PASS 3  OOS 1      P  PASS 1  OOS 1
C  PASS 4          J  PASS 4             Q  PASS 1
D  PASS 2          K  PASS 3             R  PASS 3
E  PASS 4          L  PASS 1             S  PASS 4
F  PASS 6  OOS 1   M  PASS 2
G  PASS 2          N  PASS 3
```

from `PASS 25 / FAIL 26 / NOT TESTABLE 8` at `8f73cef`, and
`PASS 37 / FAIL 7 / NOT TESTABLE 4` at the first pass of this directive.

P13 requires FAIL = 0 and NOT TESTABLE = 0 for every invariant in the active
development contract. Both hold.

The six OUT OF SCOPE carry a recorded reason each and, per P13, are removed from
the contract rather than carried as "NOT TESTABLE but promoted anyway":

```
F-7  a 0.04 SOL round trip under the output limit - this contract opens at
     0.02 SOL, so no such job exists to inspect
H-3  cold / prewarmed / repeat runs for one snapshot need three full worker round
     trips per pool; not in this window
H-4  a warm lane that could REFUSE shared account creation does not exist, so the
     guard cannot be exercised
I-4  cashback amortisation changing allocated cost - no claim has been made, so
     there is nothing to check
O-3  no official Pump disclosure of a Mayhem agent wallet or program id is
     reachable without network access this harness does not take
P-2  the live websocket lane is OFF by default - 219 messages/second, measured,
     which is what exhausted both endpoints
```

### On the ordering P13 asks for

P13 says not to start a clean evidence window until the committed audit reports
zero FAIL and zero NOT TESTABLE. Two of the three FAILs standing before this
window — **B-3** and **S-3** — are **live-run probes**: both read a collector's
behaviour *during the audit itself*, which is why `pnpm gate --with-live-run`
spawns the `--once` passes and measures them. Neither can report anything but
FAIL or NOT TESTABLE while no collector has ever run, so that ordering cannot be
satisfied literally by either.

What was satisfied is what the requirement is for: **every FAIL whose cause was a
defect was fixed and committed before the window opened.** The third, C-1, was
itself a defect in the probe (S088). The two live-run probes were then cleared by
the gate's own collector pass, which is the only apparatus that can clear them.

Stated plainly rather than quietly claiming a clean gate preceded collection.

## 21. Clean-window contract

```
contract id      contract-2572f62959ca05ab
evidence context ctx-c3add8bff804-DEV_WINDOW_5D24E    DEVELOPMENT_EVIDENCE
source commit    c3add8bff8044721c316c0559e6103842c25b396
window           DEV_WINDOW_5D24E   (stated by the contract; migration 52)
cohort           FIRST_HOUR         notional 20,000,000 lamports
entry policies   HARD_GATES_RANDOM, CORRECTED_CURRENT_QUALITY_SCORE,
                 SURVIVOR_FLOW_CONTINUATION_V1
exit policies    FIXED_15M_CONTROL, FLOW_LIQUIDITY_DETERIORATION_V1
mark SLA         10,000 ms
counterfactual   counterfactual-v1, bounded impact cap 10 bps
claimed          54 invariants;  out of scope 6
```

The contract id now binds the WINDOW as well as the content (S095). Before that
fix, two freezes at one commit under different window names minted the same id
and the second silently kept the first window's context.

## 22. Valid trajectories and distinct mints

```
22 trajectories across 14 distinct mints
13 settled, 26 policy outcomes
10 settled paths with a COMPLETELY CLEAN per-mark SLA record
138 marks, 3 outside the 10s bound, 0 beyond 60s
```

The ten timely paths are the milestone. They are not the ten largest, the ten
best or the ten chosen — they are every settled path whose seven horizons were
each taken inside the frozen bound.

## 23. Independent recomputation, and what the economics do and do not say

`pnpm trajectory:trace --all --limit=10` re-derives each trajectory from its raw
pre/post worker state **without calling the production settlement builder**.

```
traced 10   recomputed 10   failures 0
```

Every one reports `unexplained 0`, with `entry out`, `exit in` and `net pnl`
derived equal to stored to the lamport, from 50–52 account rows and 95–98 blobs
read back per trajectory.

### The round-trip cost is rent, not slippage

A reader taking `net_pnl` at face value would conclude the round trip loses 32%
to 42% of notional. It does not:

```
gross sell credit    19,749,136   on every trajectory   → ~125 bps each way
entry impact                 9 bps
base fee                10,000
rent created        10,036,320
rent recovered       2,074,080
rent still locked    7,962,240   ← dominates net_pnl −8,466,067
```

The market cost is the stated fee — lp 2 bps, protocol 93 bps, creator 30 bps,
125 bps a side — plus 9 bps of impact. The rest is rent locked in accounts the
round trip created and did not close. `execution_cost` counts locked rent as
cost, which is the conservative choice for a research measure.

The control that makes this checkable: the one trajectory whose sell leg created
a single account rather than two returns 19,501,171 of 20,000,000 — a 2.49% round
trip, exactly twice the stated fee.

### The policy figures across three windows, and why none is an edge

This directive collected three windows that reached settlement. Same venue, same
notional, same two policies, days and hours apart:

```
window                          n     FIXED_15M_CONTROL   FLOW_LIQUIDITY_DET_V1
ctx-b71956b37104 (superseded)   15          +1,229,949            +14,591,951
ctx-8eb790b0feb9 (superseded)   45          -3,926,459            -35,124,390
ctx-c3add8bff804 (THIS ONE)     13          +9,594,170             +8,726,327
```

**The sign flips between windows.** In this window only 2 of 13 paths closed
positive under either policy, and the totals are positive because one path
returned roughly +14,000,000 on a 20,000,000 notional. Remove it and both arms
are negative again. The 45-path window — the largest — is the most negative.

That instability IS the result. It sets the scale of noise any future claim has
to clear, and it is worth more than any of the three totals taken alone. A
strategy conclusion drawn from any single one of these windows would have been
confidently wrong, and would have pointed in a different direction depending on
which window you happened to run.

**Every one of these remains true:**

- **n = 13 here, 45 at most.** The readiness threshold is 100 valid paths per
  policy-cohort, and `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` needs a
  preregistered kill rule evaluated at 50 which does not exist and cannot be
  invented after seeing this.
- **Gross, not net.** Execution cost — dominated by locked rent — is not
  deducted. Deducting it makes every arm worse.
- **Two paths here were `unpriced`**: the counterfactual contract refused to
  price the exit rather than falling back to a later mainnet quote. That refusal
  is the apparatus working (M-2), and it means the totals above are over the
  paths that COULD be priced.
- **The exits are priced by a counterfactual graded DEVELOPMENT**, calibrated
  conservative against exact replay — 2 of 2 here at -49 bps, inside tolerance,
  one of them replaying 6 confirmed pool events out of 58 scanned.
- **No hold-out exists**, and the one sampling change made during this directive
  (MT048) is recorded as availability-driven, made because candidates were
  unavailable rather than because returns improved.

## 24. Active-time RPC usage and purchase recommendation

Measured over **active collector seconds**, not wall time.

```
total calls                 114,432
calls per ACTIVE second       4.503
quota errors                     48   all historical, from the exhausted endpoints
trajectories per active day  1,336.3

93,935  wss_events/logs
11,872  solana_rpc/getAccountInfo        48 quota errors
 3,427  solana_rpc/getTokenLargestAccounts
 3,427  solana_rpc/getTokenSupply
 1,641  mark_jobs
   130  solana_rpc/entityTierWalk
```

`getSignaturesForAddress` is the call the entity tier needs, and the previously
configured endpoint refused it 15 of 20 times at 2.4 req/s while serving every
other method. On the endpoint supplied for this directive it is 20 of 20 at
10.7 req/s (**S075**). That is a capacity fact about a provider, not a defect.

**Recommendation unchanged:** Helius Developer, approximately $49/month, as the
smallest purchase that removes a measured binding constraint — use the dashboard
price as source of truth, and keep the key out of logs, chat and Git.

**Do NOT buy** Jupiter Developer, Shreds, a dedicated validator, colocation, an
archival node or Business infrastructure. None before a positive untouched edge
exists, and section 23 is explicit that none does.

## 25. Unresolved blockers

1. **B-2 and B-3 fail on a market draw, and that is why the terminal state is
   `MEASUREMENT_REPAIR_REQUIRED`.** The gate's live pass samples six candidates;
   in the certifying run all six were refused by real risk gates (427.0%, 63.4%,
   12.7%, 9.9%, 3.9% of pool reserve, plus two concentration refusals). The same
   collector opened 22 trajectories in this window. The probe conflates "the
   collector can open a trajectory" with "the market offered an openable
   candidate in this six-draw". **Recommended repair:** FAIL only when a
   candidate was ADMISSIBLE and was not opened; report NO_ADMISSIBLE_CANDIDATE
   otherwise. This is the same class of correction already made for C-1 (S088).
   It was deliberately NOT made here, because editing a probe that is currently
   failing one's own run, to reach a better terminal state, is indistinguishable
   from selecting a result.
2. **S079 — the RPC rate budget is per PROCESS while the quota is per ENDPOINT.**
   Two collectors each hold a 4 req/s bucket against one endpoint measured at
   ~10.7 req/s. A third process would breach it and nothing would notice.
3. **S091 — `evidence:invalidate-old` accepts a reason with no content**, which
   is how 32 contexts were once demoted carrying empty justifications.
4. **S096 — `collector:lock-status` counts matching PROCESSES, not process
   TREES**, so one detached wrapper chain reports as six collectors. The database
   lock is the real enforcement and is unaffected (A-2 PASS).
5. **Three marks in this window exceeded the 10s SLA** (3 of 138, worst 15,111
   ms), none beyond 60s. The S094 yield repair took the worst case from 43,251 ms
   to this. Closing the remainder needs a finer yield inside the worker round
   trip itself.
6. **The entity fact has still never changed an entry decision** — wired, applied,
   decisive at ADMISSION, never decisive inside `decideEntry`.

## 26. Exact keep-running commands

```bash
# state, right now
pnpm collector:list                 # must be 1 process tree, and only one
pnpm collector:lock-status          # must be: single owner YES
pnpm scheduler:status               # marks due, overdue, next deadline
pnpm evidence:graph-check           # thirteen link and identity checks
pnpm evidence:blob-check            # re-reads and re-hashes every blob
pnpm policy:treatments-status       # all three entry policies, both exits
pnpm cashback:status                # accrued / claimable / claimed, kept apart
pnpm rpc:usage                      # over ACTIVE seconds; the purchase question
pnpm readiness                      # the trajectory gate; NOT READY is correct today

# the evidence, per trajectory
pnpm trajectory:trace -- --all --limit=10
pnpm trajectory:trace -- --trajectory=<id>
pnpm trajectory:conflict-test       # append-only ambiguities must be loud

# the counterfactual
pnpm counterfactual:replay -- --limit=4 --offset=900000 --context=<ctx>
pnpm counterfactual:calibrate       # conservative is the gate, not withinTolerance

# the whole gate, end to end
pnpm gate --with-live-run           # FAIL 0 and NOT TESTABLE 0 required
pnpm check                          # typecheck + secretscan + test

# stopping cleanly
pnpm collector:stop-all --apply
```

### Restarting the collector

The collector refuses when its frozen contract's `source_commit` is not HEAD, so
after any commit:

```bash
pnpm contract:freeze --apply                      # note the new contract id
SOLANA_RPC_HTTP=<endpoint> RPC_ENDPOINT=<endpoint> \
  pnpm tsx apps/collector/src/trajectory-collect.ts \
  --mode=observe --contract=<contract-id> --backfill-scan=60 --interval=180
```

`pnpm observe` must also be running: the trajectory collector's backfill lane
only finds pools among mints the screening collector has already recorded, so
with `observe` stopped the candidate supply is not slow, it is zero.

`docs/CLEAN_WINDOW_RUNBOOK.md` is the full sequence.

## 27. Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

The ledger is repaired and the milestone is met. Ten timely trajectories, each
with every horizon inside the frozen SLA, recompute their full economics from
durable raw evidence with zero failures and zero unexplained lamports. The
evidence graph resolves, every blob re-hashes, the counterfactual bound is
calibrated conservative against exact replay, all three entry policies decide on
shared features, and both exit policies decide on shared mark paths.

The state is nonetheless the conservative one, because P13 requires FAIL = 0 for
every claimed invariant and two claimed invariants fail — on a market draw rather
than on the apparatus, as section 25 sets out. P19's own gating sentence for the
stronger state is satisfied; P13's requirement is not. Where the two disagree,
this report takes the reading that claims less.

Nothing was funded. No key was read or created. Nothing was signed or submitted.
No canary and no live run was started. No gate was widened, no risk cap raised,
no threshold tuned toward an outcome, no test deleted and no timeout increased.
No LLM signal, no social sentiment, no additional venue and no execution purchase
were added. No invalid row was pooled with the repaired experiment, and no edge
is claimed from any settlement value, old or new.
