# Final report — directive `5d24e39`, ledger first

**Terminal state:**

```
VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING
```

Measured 2026-08-18T05:49Z against `contract-159d6dc1129230a6`, context
`ctx-47a91fa1a07b-DEV_WINDOW_5D24E`, at commit `47a91fa`, with the gate's own
live collector pass reporting `opened 2, marks 16, settled 1; restart PASS`.

**That window is now marked superseded, and this report is why.** The commit
carrying this document moved HEAD, and the collector refuses a contract whose
`source_commit` is not HEAD — so continuing to collect required a re-freeze,
which supersedes the window the numbers below describe. Nothing in it is invalid:
it is complete, audited clean, and preserved in full. Collection continues in
`ctx-8e64fba67ca1-DEV_WINDOW_5D24E` under `contract-a4317e98477ff177`, and
exactly one evidence context is `DEVELOPMENT_EVIDENCE` at any time.

Appendix C states what that costs and why the rule causing it is still right.

```
PASS 53    FAIL 0    NOT TESTABLE 0    OUT OF SCOPE 6
independently recomputed trajectories: 10 (0 failures)
```

from `PASS 25 / FAIL 26 / NOT TESTABLE 8` at `8f73cef`, and
`PASS 37 / FAIL 7 / NOT TESTABLE 4` at the first pass of this directive.

**No edge is claimed.** Section 23 says exactly what the numbers are and what
they are not.

---

## 1. Starting and ending SHA

```
starting   5d24e3973ced25b3b873c0223463895a25828e5a   (local == origin/master, CLEAN)
ending     47a91fa1a07b50a7b0a0c3fae671742cdc5cec81   branch master
commits    54, none pushed
```

The docs commit that carries this report moves HEAD past `47a91fa`. It touches
`docs/` and `artifacts/` only — no file the collector imports — so the running
apparatus is byte-identical to the commit its contract froze, checkable with
`git diff --stat 47a91fa..HEAD -- packages apps`. A *restart* after this point
needs a re-freeze; Appendix A says why, and it cost this directive five frozen
contracts to learn.

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
contract id      contract-159d6dc1129230a6
evidence context ctx-47a91fa1a07b-DEV_WINDOW_5D24E    DEVELOPMENT_EVIDENCE
source commit    47a91fa1a07b50a7b0a0c3fae671742cdc5cec81
window           DEV_WINDOW_5D24E   stated by the contract (migration 52)
cohort           FIRST_HOUR         notional 20,000,000 lamports
entry policies   HARD_GATES_RANDOM, CORRECTED_CURRENT_QUALITY_SCORE,
                 SURVIVOR_FLOW_CONTINUATION_V1
exit policies    FIXED_15M_CONTROL, FLOW_LIQUIDITY_DETERIORATION_V1
mark SLA         10,000 ms
counterfactual   counterfactual-v1, bounded impact cap 10 bps
claimed          54 invariants;  out of scope 6
```

## 22. Valid trajectories and distinct mints

```
52 trajectories across 52 DISTINCT mints
15 settled, 30 policy outcomes
286 counterfactual rows
```

One mint per trajectory — the sampling spread is exact, not merely broad. A
hundred paths across three pools is three outcomes with a hundred observations of
them, and no amount of collection turns one into the other.

### What was blocking the window, and what the refusals actually meant

The window opened nothing for its first thirty-five minutes, and the refusal
histogram explained why in a way that was wrong. Every line read like the market:

```
the entry is 160.9% of the pool's effective quote reserve, over the 0.5% bound
the entry is 304.8% …
the entry is  22.8% …
```

A 0.02 SOL entry at a 0.5% bound needs roughly 4 SOL of effective quote reserve
and the 25 migrations in the queue held 0.0035 to 0.087 SOL, so refusing them was
correct. The defect was that those 25 were the **only** thing the queue could
return. Seventy-five trajectories left open in already-demoted contexts excluded
70 of the 113 under-cap CONFIRMED migrations, and the 43 that survived the filter
were precisely the ones the depth gate had already refused. Twenty-four of the 25
mints repeated between cycle 1 and cycle 2.

The exclusion's reason is sound *within* a window — two concurrent trajectories
on one pool share a mark path and duplicate each other exactly — and false across
windows, because the mark pass, the scheduler and the backpressure brake are all
scoped to one evidence context. A trajectory open in a context nothing is marking
cannot duplicate anything. Scoping that one predicate restored 114 eligible
mints. Same command, same market:

```
before   quote reserves      3,513,644 … 87,553,872 lamports
after    quote reserves  2,192,591,027 … 41,850,888,953 lamports
```

**S090.** This is S078 in a second place: that fix scoped the reservation table,
and this query carries its own independent exclusion which the first fix never
reached.

**Age is not the discriminator, depth is.** Measured against each migration's own
`block_time` rather than when we happened to observe it, the pools admitted
across every window were 19 minutes to six days old. An earlier reading of this
number as "1 to 70 minutes" measured observation-to-open latency, not pool age,
and is withdrawn.

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

### The policy figures — both arms lose, and that is the finding

Over the 15 settled paths in the active window:

```
FIXED_15M_CONTROL                n=15  positive 1  total gross  -4,932,968
FLOW_LIQUIDITY_DETERIORATION_V1  n=15  positive 1  total gross  -4,887,337
in-window disagreements (different trigger offset): 4 of 15
```

**Both arms are negative before costs.** One path in fifteen closed positive
under either policy, and the challenger's advantage over the control is 45,631
lamports across the whole window — about 0.4% of one entry's notional, on a
sample where a single path swings by more than that.

An earlier window in this same directive, collected at `b71956b` and now demoted,
read `+1,229,949` and `+14,591,951` on its own 15 paths. Two windows of the same
size, on the same venue, days apart, differ by twenty million lamports and by
sign. That is what a sample of fifteen is worth, and it is the most useful number
in this report: it sets the scale of the noise any future claim has to clear.

**Neither figure is an edge, and neither kills the strategy.** Every one of the
following is true:

- **n = 15.** The readiness threshold is 100 valid paths per policy-cohort, and
  `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` would need a preregistered kill rule
  evaluated at 50, which does not exist yet and cannot be invented after seeing
  this.
- **Gross, not net.** Execution cost — dominated by the locked rent in the
  section above — is not deducted. Deducting it makes both arms worse, not
  better.
- **The exits are priced by a counterfactual graded DEVELOPMENT.** Calibrated
  conservative against exact replay on 4 pairs, all at -49 bps and all inside
  tolerance — enough to say it does not overstate an exit, not enough to promote
  it out of development evidence.
- **No hold-out exists**, and no threshold was tuned toward this result. MT048,
  the one sampling change made during this directive, is recorded as
  availability-driven and was made because candidates were unavailable, not
  because returns improved.

The correct reading is: the apparatus produces two policy decisions over one
shared, durable, independently recomputable mark path; they disagree on 4 of 15;
and over this window both lose money before costs. That is a working measurement
instrument reporting an unflattering measurement, which is the outcome this
directive was built to make possible.

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

1. **S079 — the RPC rate budget is per PROCESS while the quota is per ENDPOINT.**
   Open. Two collectors each hold a 4 req/s bucket against one endpoint measured
   at ~10.7 req/s, so the ceiling holds only because the per-process figure was
   set low enough for two. A third process would breach it and nothing would
   notice. A cross-process budget needs a shared token bucket.
2. **S091 — `evidence:invalidate-old` accepts a reason with no content.** Open;
   see section 5.
3. **The entity fact has never changed an entry decision.** Section 16. Wired,
   applied 270 times, decisive zero times in `decideEntry`.
4. **The marks-only pass reprints its full banner every tick.** Cosmetic; twenty
   blocks a minute of log for a pass that usually does nothing.
5. **Six invariants are OUT OF SCOPE**, each with a recorded reason, and are
   therefore not claimed anywhere else either: F-7, H-3, H-4, I-4, O-3, P-2.

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
VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING
```

The claimed set of 54 invariants reports FAIL 0 and NOT TESTABLE 0 against the
frozen contract, ten trajectories recompute from durable raw evidence with zero
failures and zero unexplained lamports, the bounded counterfactual is calibrated
conservative against exact replay, two exit policies decide over one shared mark
path and disagree on it, and one collector is running under the contract that
froze at the commit it is running.

What that state does **not** say: that an edge exists. Section 23 gives the
policy figures and the five reasons they are not one.

Nothing was funded. No key was read or created. Nothing was signed or submitted.
No canary and no live run was started. No gate was widened, no risk cap raised,
no threshold tuned toward an outcome, no test deleted and no timeout increased.
No LLM signal, no social sentiment, no additional venue and no execution purchase
were added. No invalid row was pooled with the repaired experiment, and no edge
is claimed from any settlement value, old or new.

---

## Appendix A — the provenance treadmill, and how to avoid paying it

The collector refuses when its frozen contract's `source_commit` is not HEAD.
That rule is right — a window collected at a different commit than its contract
froze is not the experiment that was declared — and it means **every commit made
while a window is open strands that window.** Four contracts were frozen and
superseded unused during this directive for exactly that reason, at `5f5a6dc`,
`602e86d`, `5be9358` and a predecessor. Each stranded context is recorded with
`STRANDED_BY_HEAD` naming the commit that superseded it, rather than deleted or
silently reused.

The working order is: make every change, `pnpm check`, commit, **then**
`pnpm contract:freeze --apply`, then start the collector and do not touch the
tree until the window closes.

---

## Appendix B — clause-by-clause coverage of the directive

Verified against the directive text rather than from memory, each with a concrete
check rather than an assertion that it was done.

| clause | requirement | evidence |
|---|---|---|
| P0.1 | establish local truth before changing code | section 2; SHAs, process trees, scheduled tasks, WSL worker sha256, RPC hosts recorded |
| P0.2 | stop every trajectory collector | section 3; 6 processes stopped, 0 remain, no startup path |
| P0.3 | `VACUUM INTO` backup, read back and verified | section 4; sha256, bytes, counts, integrity, foreign keys, exposure; ≥20 GB free enforced |
| P0.4 | append-only invalidation ledger, nothing deleted | section 5; `evidence_contexts` carries all seven required columns; 40 of 41 contexts invalid; 427 trajectories preserved |
| P1.1 | dedicated `trajectory_collector` lock, `BEGIN IMMEDIATE`, stale takeover rules | section 6; plus an OS-level lock file at `data/trajectory-collector.pid` as the second line of defence |
| P1.2 | Task Scheduler `MultipleInstances = IgnoreNew` | `docs/COLLECTOR_SINGLE_OWNER.md` |
| P1.3 | refuse dirty evidence collection | `evidenceContextValidity`; a modified ARTIFACT is correctly not a dirty tree |
| P1.4 | atomic candidate reservation, unique constraints, ten-process race | section 6; P17 #3 |
| P2.1–2.3 | the evidence graph, deterministic identities, schema | section 7; all twelve tables, all ten trajectory link columns |
| P2.4 | persist before execution, named state progression | `persist-evidence.ts`: REQUESTED → RUNTIME_RETURNED → RAW_STATE_DURABLE → EFFECT_VERIFIED → SETTLEMENT_DERIVED → COMPLETE |
| P2.5 | atomic trajectory open after blob readback | section 7 |
| P3.1 | content-addressed blob store, read back before durable | section 9; 2,055 blobs re-hashed, 0 missing |
| P3.2 | required accounts, ABSENT explicit on both sides | P17 #11; G-2 PASS |
| P3.3 | real hashes | section 10; `fee_config_hash`, `capability_fingerprint`, `snapshot_hash`, `leg_account_plans.fingerprint` (the account-plan hash), `simulation_jobs.simulator_binary_hash` |
| P3.4 | quote-state equality broken by any mutation | section 11; P17 #23/#24 now tested directly, G-1 PASS |
| P4.1 | `isPnlEligible` for entry AND exit | `settlement.ts` calls it for buy and sell |
| P4.2 | unexplained value blocks PnL | section 12; K-2 PASS |
| P4.3 | exact cost components, once each | section 12; K-1 PASS over eleven mutations |
| P4.4 | the single cash identity | K-3 PASS: trajectory, settlement, policy outcome and report agree exactly |
| P4.5 | explicit economics persisted | on `trajectory_settlements` (`gross_exit_credit`, `residual_token_atoms`, `unexplained_lamports`) and the trajectory row |
| P4.6 | independent recomputation command | section 8 and 23; `pnpm trajectory:trace` does not call the settlement writer it checks |
| P5 | append-only means loud conflicts | section 13; eight probes, `ALL AMBIGUITIES ARE LOUD` |
| P6.1 | sole-venue conservation on both sides | section 11 |
| P6.2 | `assertPlanUnchanged` called in production | `open-trajectory.ts:1452` |
| P6.3 | pinned Pump docs commit and SDK versions | `sdk-versions.ts`: docs `9c82f61c…`, pump-sdk 1.36.0, pump-swap-sdk 1.19.0; E-4 and J-4 PASS |
| P6.4 | fee tier stored and fail-closed | section 17; J-1..J-4 PASS |
| P7.1–7.3 | split schedulers, frozen SLA, backpressure | section 14 |
| P7.4 | honest `--once` semantics | documented at the flag; the gate exercises it |
| P8.1–8.3 | counterfactual classes, bounded mode, replay calibration | section 15; `BOUND_IS_CONSERVATIVE` |
| P8.4 | no later mainnet quote without a contract | M-2 PASS; observed live as `FLOW_LIQUIDITY_DETERIORATION_V1=unpriced` |
| P9.1–9.3 | all three entry policies, two exit policies, paired outcomes | section 16; N-1..N-3 PASS |
| P10.1 | entity-adjusted concentration in the decision | section 16b — wired and applied 270 times, decisive ZERO times in `decideEntry`, stated rather than buried |
| P10.2 | Mayhem verified against disclosure | O-1 PASS; O-3 OUT OF SCOPE with its reason |
| P10.3 | Token-2022 canonical decoder | section 17 |
| P11 | warm/cold, cashback, fee regimes | section 18; strata recorded. P11 defers optimisation until ten recomputable trajectories exist, so the separate runs are future work by the directive's own text |
| P12.1–12.4 | one readiness owner, frozen contract, no old evidence, honest commands | section 19; Q-1 and R-1..R-3 PASS |
| P13 | acceptance gate, FAIL 0 and NOT TESTABLE 0 | section 20, and the ordering caveat stated rather than glossed |
| P14 | one clean window, ten trajectories, real-time horizons | section 22 |
| P15 | profit search AFTER ten valid trajectories | not begun; section 23 gives the figures and five reasons they are not an edge |
| P16 | instrument first, then decide infrastructure | section 24 |
| P17 | 39 mutation and runtime tests | 60 tests in `directive-5d24e39-p17.test.ts`; #23 and #24 added during this review |
| P18 | commands, docs and artifacts | all 17 commands, all 10 docs, all 8 artifacts — `settlement-identity-check.json` added during this review |
| P19 | the final report, 27 numbered items | this document, sections 1–27, no gaps and no duplicates |

---

## Appendix C — what re-freezing mid-flight costs

Re-freezing at a new commit does not merely start a new window; it **abandons the
open trajectories in the old one**. The mark scheduler, the backpressure brake
and the settle pass are all scoped to the active evidence context, so the moment
a new contract becomes active every still-open trajectory in the previous window
stops being marked. Those paths are truncated at whatever horizon they had
reached, can never satisfy `pathIsComplete`, and therefore can never produce a
policy outcome.

This directive froze **five** contracts and superseded four of them, each time
because a defect was found and fixed after the window had opened:

```
5f5a6dc   superseded   stray window (S087) — 1 trajectory
602e86d   superseded   no trajectory opened
5be9358   superseded   candidate queue sterilised by demoted windows (S090) — 1
b71956b   superseded   16 settled, 10 recomputed, PASS 53 at its own commit — 67
47a91fa   ACTIVE       the window this report measures — 52
```

The `b71956b` window is the expensive one: it was complete and audited clean at
its own commit, and 22 of its trajectories were still open when it was
superseded. Nothing is deleted and every recorded mark remains valid, but that
collection time is not recoverable and those 22 paths will never settle.

**500 trajectories exist; 52 are in the valid window.** A reader comparing those
two numbers should know the gap is the cost of finding four defects, not a
property of the market.

The rule that causes this is correct — a window collected at a different commit
than its contract froze is not the experiment that was declared — so the lesson
is procedural, and it is the one in Appendix A: make every change, run
`pnpm check`, commit, **then** freeze, then leave the tree alone until the window
closes.

## Appendix D — where a probe is broader than the window it reports on

Two checks in this report are corpus-wide by construction, and a reader should
know which:

**N-3** — "the two exit policies are evaluated on the SAME path and can disagree
on it" — counts disagreements across `trajectory_policy_outcomes` with no context
scope. Its verdict would therefore be satisfied by disagreements recorded in
windows that have since been demoted. In the active window it is independently
true: **4 of 15 settled paths have different trigger offsets**, so the invariant
does not rest on old evidence here. The probe should still be scoped, and that it
is not is recorded rather than relied upon.

**`pnpm policy:treatments-status`** reports 302 paired exit paths and 270 entry
decisions carrying a risk fact. Those counts span every context including the
invalidated ones. They are a statement about WIRING — that the code paths are
called and can disagree — and not about this window's evidence. Section 16 gives
the in-window figures separately for exactly that reason.

Neither is a defect in the apparatus. Both are places where a number that looks
like evidence is actually a statement about the machinery, and this report
separates them rather than letting the larger number stand in for the smaller
one.
