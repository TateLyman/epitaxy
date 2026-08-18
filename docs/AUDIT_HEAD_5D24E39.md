# Audit head `5d24e39` — what the directive found, and what was done

**Directive:** `epitaxy_5d24e_ledger_first_profit_directive.md`
**Audited GitHub head:** `5d24e3973ced25b3b873c0223463895a25828e5a`
**Runtime audit incorporated:** `docs/RUNTIME_ADVERSARIAL_AUDIT_8F73CEF.md`
**Executed:** 2026-08-17

## Starting state

```
PASS          25
FAIL          26
NOT TESTABLE   8
```

> **THE APPARATUS IS REAL.
> THE EVIDENCE GRAPH AND ACCOUNTING ARE NOT.**

The local Windows tree was clean at exactly `5d24e39` and equal to `origin/master`.
Everything below was found on the operator's own machine, database, WSL worker
and configured RPC.

## What the local tree said that the directive did not

Three things differed from the directive's premises, each recorded when found:

**1. `packages/storage/src/backup.ts` already used `VACUUM INTO`.** The audit
described `onlineBackup` as "the call that does not converge". The function is
*named* for the incremental API and calls `VACUUM INTO`. There was no
nonconverging default to replace.

What there *was* is worse and unnoticed: `openDb` ran that 7 GB backup on
**every** open, whether or not a migration was pending — roughly five minutes and
7 GB of disk per status command, per script and per collector restart. It now
runs when `pendingMigrations()` is non-empty, read from the same table `migrate()`
reads.

**2. Only ONE trajectory collector was running**, not five: a single daemon tree
of six processes started 2026-08-16 18:27. Section S of the 8f73cef audit had
already stopped the other four, and its report says so.

**3. The WSL checkout is 20 commits behind.** `~/epitaxy` in Ubuntu-24.04 sits at
`3bc708d` and the Rust worker is not built there at all. The trajectory
collector's litesvm worker lives on the **Windows** side and is invoked as
`wsl -d Ubuntu-24.04 -- /mnt/c/Users/lyman/tradseee/offline-worker/target/release/epitaxy-offline-worker`;
its sha256 is `be02d7855a2b130a4460cdce923a53429f740877a2f151dcacf713686392d7d8`,
which matches the audit exactly. The stale WSL tree serves only
`epitaxy-simulatord`, a separate Surfpool-based daemon.

No scheduled task, Run key or Startup entry can launch the trajectory collector.
The only registered task is `epitaxy-simulatord`.

## Every reason the pre-repair window was closed, re-measured

`pnpm evidence:invalidate-old` does not read these from the audit. It re-runs
each measurement and refuses to invalidate a corpus that measures clean. All
eleven still held:

| code | measured 2026-08-17 | audit said |
| ---- | ------------------- | ---------- |
| `DANGLING_EVIDENCE_LINKS` | 292/292 observation ids and 292/292 job ids dangle | 0/292 resolve |
| `NO_RAW_PRE_POST_STATE` | 292/292 have no evidence-link row | C-4 |
| `SNAPSHOT_HASH_IS_NOT_A_HASH` | 292/292 not 64-hex; 292 fingerprints equal the snapshot hash | 292/292 |
| `PNL_OVER_UNEXPLAINED_VALUE` | 51 with a residue, 30 publishing net PnL | 51 / 30 |
| `UNOBSERVED_WRITABLE_ACCOUNTS` | 292/292 | 292/292 |
| `ENTRY_POLICY_IS_A_LABEL` | 1 distinct entry policy against 3 defined | 1 |
| `LATE_MARKS` | 708/1460 more than 60 s late | 697/1448 |
| `NO_COUNTERFACTUAL_CONTRACT` | 292/292 `SIMULATED_EXECUTION` | 292 |
| `TRAJECTORY_ECONOMICS_NULL` | 292/292 NULL `net_pnl_lamports` | 0 populated |
| `DIRTY_TREE_PROVENANCE` | 26/31 sessions dirty | 26/31 |
| `UNMANAGED_CONCURRENCY` | worst mint 58 trajectories | 58 |

Every figure reproduced. Late marks grew from 697/1448 to 708/1460 because the
corpus was still being written when the audit ran — and the audit said so.

## Ending state

```
PASS          37
FAIL           7
NOT TESTABLE   4
OUT OF SCOPE   8
```

against the frozen contract `contract-d2b2bf4f5f83b0a1`, which claims 52
invariants and removes 8 with a recorded reason each.

**Every one of the eleven remaining blockers is the same fact: the active window
has zero trajectories.** Not a code defect — an RPC capacity fact. See
`docs/CLEAN_WINDOW_RUNBOOK.md`.

## Closed

| audit id | finding | how |
| -------- | ------- | --- |
| K-1 | `costs.unexplainedLamports` never read by the canonical writer | `buildTrajectorySettlement` calls `isPnlEligible` instead of restating three of its four clauses |
| K-1 | the trajectory-level failed-attempt fee entered zero times | added to execution cost exactly once |
| K-2 | net PnL published over a residue; zero identity violations | the residue blocks PnL and raises two violations carrying the exact number |
| K-3 | `settleTrajectory()` never called; every economics column NULL | `persistTrajectoryEconomics` writes them without touching state, asserting one affected row |
| C-2 | 0/292 identities resolve, by construction | content-bound ids; the id passed to the worker IS the id inserted |
| C-3 | `snapshot_hash` is a slot number | `coherent.snapshotHash`; refused by a domain check AND a database trigger |
| C-3 | the fingerprint equals the snapshot hash | a fingerprint over named capability fields, which moves with seven of them |
| C-4 | no raw pre/post state persisted | content-addressed blobs, read back, linked per `(job, step, leg, address)` with ABSENT explicit |
| D-2 | a one-lamport quote credit attributes a 0.02 SOL entry | both sides conserve, within four lamports of documented rounding |
| E-3 | `assertPlanUnchanged` has no production caller | the frozen plan is compared against a plan **decoded from the bytes that will execute** |
| G-1 | fee config and Clock outside the equality set | the fee config is price-bearing; the Clock is observed on both sides |
| L-1 | five of seven ambiguities silently discarded | all eight now refuse loudly, and the conflict is recorded |
| N-1 | no path where the challenger exits earlier | the 5-horizon grid could not express it; 3m and 10m added as MT045 |
| N-2 | `decideEntry` has zero production callers | all three policies decide, twice, and the risk-fact delta is stored |
| P-1 | `assertUnwatchesExactly` is a subset check | both directions fail, and they fail differently |
| Q-1 | two scripts write `artifacts/readiness.json` | separate artifacts; `writeArtifact` refuses a path |
| R-1 | 16 hardcoded null gate inputs | readiness loads ONE frozen contract and the rows that belong to it |
| A-1/A-2 | dirty provenance, no lock | a provenance gate that refuses, and a dedicated lock with explicit takeover rules |
| I-3 | `claimable` hardcoded `0n` | measured from the accumulator ATA |
| J-3 | no fee-config hash or tier bound to a trajectory | both stored, with the market cap and the three bps components |

## Found by doing rather than by reading

- **The payer reconciliation added the cashback claim to the expected side.**
  `claim_cashback` is a third transaction; its lamports never pass through the
  buy or the sell, so the expression manufactured a residue of exactly the
  claimed amount. Wrong since it was written; nothing read it, so nothing
  disagreed.
- **A test fixture that could not have happened.**
  `trajectory-kernel-p4.test.ts` asserted *"satisfies the settlement identities"*
  over payer deltas short by one base fee across the round trip.
- **The exit was priced at the mark that revealed the deterioration** — the one
  observation the strategy demonstrably could not have traded at.
- **The five-horizon grid made N-1 structurally unsatisfiable**, whatever the
  market did.
- **`openDb` backed up 7 GB on every open.**
- **Two audit probes asserted a past finding rather than measuring.** A-2 was the
  literal `'FAIL'`; G-1 computed `uncovered = ['fee config', 'Clock']` as a
  literal and derived its verdict from that array's length.

## Not claimed

Removed from the contract with a recorded reason, and therefore not asserted
anywhere else either:

```
E-4  SDK vs current official Pump docs      needs network access this harness does not take
F-7  a 0.04 SOL round trip                  this contract opens at 0.02 SOL
H-3  cold / prewarmed / repeat runs         three worker round trips per pool; not this window
H-4  a warm lane refusing shared creation   no warm lane exists to refuse
I-4  cashback amortisation                  no claim has ever been made
J-4  the tier vs the official SDK result    the SDK does not export calculateFeeTier
O-3  the disclosed Mayhem agent wallet      needs the live disclosure
P-2  a material WSS update, end to end      the lane is off by default; 0 urgent marks have fired
```

## Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

The ledger is repaired and the gate is honest about what remains. Ten
independently recomputable trajectories do not exist, so
`VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` is not claimed.

---

# Second pass — 2026-08-18, terminal state reached

**Head:** `b71956b37104a9b6a315a2b6c23d7380a95f2dc6`
**Contract:** `contract-45d645af0e26ce9b`, context `ctx-b71956b37104-DEV_WINDOW_5D24E`

```
PASS 53    FAIL 0    NOT TESTABLE 0    OUT OF SCOPE 6
independently recomputed trajectories: 10 (0 failures)
terminal state: VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING
```

Full account, including every figure and every caveat on the policy numbers:
`docs/5D24E39_FINAL_REPORT.md`.

## On the ordering the directive asks for

The directive says not to restart evidence collection until the committed audit
reports zero FAIL and zero NOT TESTABLE. Two of the three FAILs standing before
this window — **B-3** ("the same pass continues to later marks and settles at
least one policy outcome") and **S-3** ("the collector was stopped and restarted
with open trajectories and resumed correctly") — are **live-run probes**. Both
read a collector's behaviour *during the audit itself*: `pnpm gate
--with-live-run` spawns the `--once` passes and measures them. Neither can report
anything but FAIL or NOT TESTABLE while no collector has ever run, so the
ordering as literally written cannot be satisfied by either of them.

What was satisfied instead, and is what the requirement is for: **every FAIL
whose cause was a defect was fixed and committed before the window opened.** The
third standing FAIL, C-1, was itself a defect in the probe — a link hardwired to
`SELECT 0 c`, which could never pass whatever the data said (S088). The two
live-run probes were then cleared by the gate's own collector pass, which is the
only apparatus that can clear them.

Stating it plainly rather than quietly claiming a clean gate preceded collection.

## The five defects this pass found

| | what it was | how it showed up |
|---|---|---|
| **S086** | a bounded-counterfactual REFUSAL violated its own table's CHECK | the exception killed the mark pass mid-run; six passes died in one window and the gate read the crash as "0 marks over 0 open trajectories" |
| **S087** | `contract:freeze` defaulted to `DEV_WINDOW_5D24E`, the collector to `DEV_WINDOW_V1`, nothing compared them | a trajectory landed in a context `pnpm readiness` does not read — every row real, every report empty |
| **S088** | the C-1 trace probe carried a placeholder link hardwired to `SELECT 0` | C-1 reported the trace broken on every trajectory ever opened, including ones whose exit step resolves perfectly |
| **S089** | `apps/collector/src/main.ts` built its RPC client directly and never read `RPC_ENDPOINT` | the two halves of one system could read two endpoints; measured, one collector ran fine while the other logged "max usage reached" on every concentration read |
| **S090** | trajectories left open in DEMOTED windows excluded their mints from every future candidate queue | 75 of them held 70 of the 113 under-cap migrations hostage; the survivors were exactly the depth-refused pools, so the window opened nothing for 35 minutes while 114 eligible mints sat behind the clause |

S090 is the one worth remembering. Its symptom was **indistinguishable from the
market**: a refusal histogram full of *"the entry is 160% of the pool's effective
quote reserve"* reads as a chain with no admissible pools. It was a fact about
our own bookkeeping. Scoping one predicate moved the queue's quote reserves from
0.0035–0.088 SOL to 2.19–41.85 SOL, same command, same minute.

## What the terminal state does not say

It does not say an edge exists. Over the 15 settled paths carrying outcomes:
`FIXED_15M_CONTROL` n=15, 5 positive, total gross +1,229,949;
`FLOW_LIQUIDITY_DETERIORATION_V1` n=15, 4 positive, total gross +14,591,951.
The threshold is 100 valid paths per policy-cohort, those figures are gross of an
execution cost dominated by locked rent, the challenger's total is a tail rather
than a central tendency, the exits are priced by a counterfactual graded
DEVELOPMENT, and no hold-out exists. Section 23 of the final report states each
of those.
