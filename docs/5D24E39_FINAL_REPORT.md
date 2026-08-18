# Final report — directive `5d24e39`, ledger first

**Terminal state:**

```
VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING
```

Measured 2026-08-18T02:13Z against `contract-45d645af0e26ce9b`, context
`ctx-b71956b37104-DEV_WINDOW_5D24E`, at commit `b71956b`, with the collector
running.

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
ending     b71956b37104a9b6a315a2b6c23d7380a95f2dc6   branch master
commits    50, none pushed
```

The docs commit that carries this report moves HEAD past `b71956b`. It touches
`docs/` and `artifacts/` only — no file the collector imports — so the running
apparatus is byte-identical to the commit its contract froze. A *restart* after
this point still needs a re-freeze; see section 26.

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
evidence contexts                41
INSTRUMENT_DEVELOPMENT_INVALID   40
DEVELOPMENT_EVIDENCE              1     the active window, and nothing else
trajectories preserved          427     none deleted
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

## 9. Blob readback

```
checked           2,055
missing from disk     0
hash mismatch         0
verdict     ALL DURABLE
```

Every blob re-read from disk and re-hashed. A blob whose `readback_verified` flag
is cleared is refused on read; an unregistered hash is not durable.

## 14. Mark scheduler timeliness

Discovery and marks are separate clocks. Marks wake at the next deadline bounded
by a 3-second tick against a frozen 10-second SLA; discovery is **deferred**
whenever a mark is past its SLA, and the deferral is printed rather than silent.

**The collector's own record, measured immediately before the gate stopped it:**

```
+ 1m   45 marks   10 missed   worst lateness 20,902 ms
+ 3m   45 marks    0 missed   worst lateness  1,026 ms
+ 5m   42 marks    3 missed   worst lateness 12,697 ms
+10m   40 marks    0 missed   worst lateness  2,084 ms
+15m   35 marks    9 missed   worst lateness 20,562 ms
+30m   25 marks    3 missed   worst lateness 17,763 ms
+60m    5 marks    0 missed   worst lateness      25 ms
                  ---------
       237 marks  25 missed   10.5%
```

against a pre-repair baseline of **697 of 1,448 marks more than sixty seconds
late**, with 1m marks 4% on time. The misses concentrate at +1m and +15m, the
horizons most likely to fall due inside a discovery cycle.

**After the gate the same window reads 69 missed of 282, worst lateness
453,882 ms**, and that difference is the gate itself: it stops the collector,
takes a 7.65 GB VACUUM copy, runs the probes and only then spawns its `--once`
passes, which backfill every horizon that came due in between. B-4 therefore
reads the **pre-gate copy** — measuring the audit's own cleanup as the
collector's lateness is the same substitution as reading an apparatus failure as
a market fact (S085).

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
scope: ctx-b71956b37104-DEV_WINDOW_5D24E, the window of the active contract
  bounded rows  501     replay rows  10     paired  4
  3f177c19  +15m  bounded 19,654,606  replay 19,753,087  -49 bps  conservative
  c3b1c930  +15m  bounded 19,654,603  replay 19,753,086  -49 bps  conservative
  e0c49e7e  +15m  bounded 20,683,327  replay 20,786,991  -49 bps  conservative
  ec62f2b0  +15m  bounded 18,107,484  replay 19,776,982 -844 bps  conservative
  non-conservative 0 of 4
verdict: BOUND_IS_CONSERVATIVE
```

The two pairs with no intervening pool event land at exactly −49 bps, which is
the 25 bps haircut applied on both legs. That the arithmetic reproduces itself
where nothing else moved is the check that the replay is doing what it claims.

One pair is outside the 200 bps tolerance, and on the pessimistic side. It is
reported rather than dropped.

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

## 21. Clean-window contract

```
contract id      contract-45d645af0e26ce9b
evidence context ctx-b71956b37104-DEV_WINDOW_5D24E    DEVELOPMENT_EVIDENCE
source commit    b71956b37104a9b6a315a2b6c23d7380a95f2dc6
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
49 trajectories across 47 distinct mints
14 settled, 28 policy outcomes, 5 pairs disagreeing
286 counterfactual rows
```

Forty-seven mints for forty-nine trajectories. A hundred paths across three pools
is three outcomes with a hundred observations of them, and no amount of
collection turns one into the other.

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

### The policy figures, and why they are not an edge

Over the 15 settled paths carrying outcomes at the time of writing:

```
FIXED_15M_CONTROL                n=15  positive 5  total gross  +1,229,949
FLOW_LIQUIDITY_DETERIORATION_V1  n=15  positive 4  total gross +14,591,951
```

**This is not an edge and must not be reported as one.** Every one of the
following is true of those numbers:

- **n = 15.** The readiness threshold is 100 valid paths per policy-cohort.
- **Gross, not net.** Execution cost — dominated by the locked rent above — is
  not deducted. A gross figure is not a return.
- **The challenger's total is a tail, not a central tendency.** It has FEWER
  positive paths than the control and a larger total, which is the signature of
  one or two large winners. A mean over 15 with that shape says almost nothing.
- **The exits are priced by a counterfactual graded DEVELOPMENT.** It is
  calibrated conservative against replay on 4 pairs — that is enough to say it
  does not overstate, not enough to promote it.
- **No hold-out exists**, and no threshold was tuned toward this result. If one
  ever is, it goes in `docs/MULTIPLE_TESTING_LEDGER.csv` first, with the sample.

The correct reading is: the apparatus now produces two policy decisions over one
shared, durable, independently recomputable mark path, and they disagree on 5 of
15 paths. That is a working measurement instrument. It is not a result.

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

## 26. The provenance treadmill, and how to avoid paying it

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
