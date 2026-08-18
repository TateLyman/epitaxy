# The pre-repair evidence window is closed

**Evidence context:** `5d24e-pre-repair`
**Validity:** `INSTRUMENT_DEVELOPMENT_INVALID`
**Closed:** 2026-08-17, at directive `5d24e39`
**Source commit the invalid rows were produced under:** `8f73cef2a1a87fb0019cab8c4bd5725e2a60114f` and earlier
**Machine-readable:** `artifacts/5d24e-invalid-window.json`
**Establishing audit:** `docs/RUNTIME_ADVERSARIAL_AUDIT_8F73CEF.md`

## What was closed

```
292  development trajectories
 52  trajectory settlements
1460 trajectory marks
545+ policy outcomes
 31  collector sessions
```

All of them. Not a subset chosen on their values.

**Nothing was deleted.** Every row is exactly where it was. The corpus is the
only record of how this instrument behaved while it was measuring wrongly, and a
repair that destroys the evidence of the defect cannot be checked afterwards.
What changed is that these trajectories are now assigned to an evidence context
whose validity is `INSTRUMENT_DEVELOPMENT_INVALID`, and every default report,
every readiness gate and every policy comparison reads validity from
`evidence_contexts` rather than deciding for itself.

## Why — eleven reasons, each re-measured rather than copied

`pnpm evidence:invalidate-old` does not read these numbers from the audit
document. It re-runs each measurement against the live corpus, and it **refuses
to invalidate** if no reason still holds. Run at close:

| code | measured on 2026-08-17 |
| ---- | ---------------------- |
| `DANGLING_EVIDENCE_LINKS` | 292/292 entry observation ids and 292/292 entry job ids resolve to nothing |
| `NO_RAW_PRE_POST_STATE` | 292/292 trajectories have no evidence-link row; no raw pre/post account state exists |
| `SNAPSHOT_HASH_IS_NOT_A_HASH` | 292/292 `snapshot_hash` values are not 64-hex digests; 292 capability fingerprints equal the snapshot hash |
| `PNL_OVER_UNEXPLAINED_VALUE` | 51 settlements carry a non-zero unexplained remainder; **30 publish net PnL anyway** |
| `UNOBSERVED_WRITABLE_ACCOUNTS` | 292/292 trajectories carry an unobserved-writable refusal |
| `ENTRY_POLICY_IS_A_LABEL` | 1 distinct entry policy value across the whole corpus, against 3 defined |
| `LATE_MARKS` | 708/1460 marks are more than 60 s late |
| `NO_COUNTERFACTUAL_CONTRACT` | 292/292 rows graded `SIMULATED_EXECUTION`; 0 bounded, 0 replayed |
| `TRAJECTORY_ECONOMICS_NULL` | 292/292 trajectories have a NULL `net_pnl_lamports` — `settleTrajectory()` was never called |
| `DIRTY_TREE_PROVENANCE` | 26/31 collector sessions were opened from a dirty tree |
| `UNMANAGED_CONCURRENCY` | worst mint produced 58 trajectories against a hard cap of 3 |

Every figure the audit reported reproduced exactly, except late marks, which grew
from 697/1448 to 708/1460 — the corpus was still being written when the audit
ran, and the audit said so.

## What may and may not be done with these rows

**May:** study how the instrument failed; reproduce a defect; count refusals as
apparatus telemetry; cite them as instrument-development history.

**May not:**

- pool them with the repaired experiment;
- estimate expectancy, edge, win rate or cost from them;
- let them reach `pnpm readiness`, a policy comparison, or any default report;
- treat the −215,427,510 lamport aggregate as a strategy result. 51 of the 52
  settlements behind it do not close their payer identity, and in the worst case
  the unexplained residue is **71 % of the loss the row reports**. That number
  measures an accounting defect, not a strategy.

Killing the strategy on these settlements would be killing it on an accounting
defect, which is why `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is not the terminal
state of this directive either.

## How the exclusion is enforced

Not by convention. The evidence context is a foreign key:

```sql
trajectory_evidence_context(trajectory_id, evidence_context_id)
  -> evidence_contexts(evidence_context_id, validity, reasons, audit_artifact_hash)
```

and the new graph tables (`trajectory_evidence_links`, `leg_settlements`,
`coherent_snapshots`, `account_state_manifests`, `simulation_steps`) declare real
foreign keys on identifiers that must resolve. **The 292 legacy rows cannot be
represented in them** — SQLite refuses the insert. "0 of 292 resolve" is
therefore not merely fixed; it is unexpressible.

The invalidation ledger is append-only. Reasons may be re-measured; a context's
validity and its opening are never rewritten.
