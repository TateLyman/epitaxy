# Evidence graph v1

> `entry_observation_id` resolved for **0 of 292** trajectories.
> `entry_simulation_job_id` resolved for **0 of 292**.
> They could not resolve, and no amount of collecting would have fixed it.

`simulation_jobs.job_id` was `job-<32 hex of the request hash>`.
`open-trajectory.ts:1053` minted `job-${randomUUID()}` and wrote it to no other
table. **The namespaces were disjoint by construction.**

That is the defect this schema removes — not by fixing the writer, but by making
the broken shape unrepresentable.

## The graph

```
experiment_contracts          frozen BEFORE the window opens
  └─ evidence_contexts        DEVELOPMENT_EVIDENCE | INSTRUMENT_DEVELOPMENT_INVALID
       └─ trajectory_reservations       the per-mint cap, as a schema fact
            └─ coherent_snapshots       snapshot_hash = sha256(manifest), NOT a slot
                 └─ evidence_blobs      content-addressed, read back before use
                      ├─ exact unsigned transaction bytes
                      ├─ canonical worker request
                      ├─ coherent snapshot manifest
                      └─ every economically relevant account, pre AND post
            └─ simulation_jobs
                 └─ simulation_steps            (job_id, step_index)
                      └─ account_state_manifests  pre/post per account, ABSENT explicit
                           └─ leg_settlements     one leg, one measured settlement
                                └─ trajectory_evidence_links   EVERY ARROW A FOREIGN KEY
                                     └─ trajectory_settlements
                                          └─ trajectory_policy_outcomes
```

## Why `trajectory_evidence_links` is a separate table

SQLite cannot add a constraint to an existing table, and rebuilding
`development_trajectories` **with** the constraints would fail on the 292 legacy
rows whose identifiers point at nothing.

A repair that requires deleting the evidence of the defect is not an acceptable
repair.

So the link row is new, every identifier on it is a real foreign key, and **the
292 legacy rows cannot be represented in it at all.** "0 of 292 resolve" is not
fixed; it is unexpressible.

## Identities are content-bound

A random id is a promise that some writer will later insert a row under it. A
content-bound id is not a promise — anyone holding the same content can
recompute it, so a reader can **check** the link rather than trust it.

```
observation_id  = sha256(trajectory_id | leg | purpose | transaction_hash | snapshot_hash)
worker_job_id   = sha256(canonical worker request)        -> job-<32 hex>
settlement_id   = sha256(observation_id | job_id | step_index | settlement_version)
snapshot_hash   = sha256(ordered account manifest + decoded clock/rent/epoch)
capability_fingerprint = sha256(venue, programId, programdata, tokenProgram,
                                feeConfigHash, selectedTier, cashbackEnabled,
                                workerBinaryHash, sdkVersions, protocolVersion)
```

**The id passed to the worker is the id inserted.** There is no second namespace
to keep in sync, because there is no second namespace.

`settlement_version` is inside the settlement id on purpose: a change to how a
settlement is derived produces a DIFFERENT settlement for the same observation
and job, and it must become a new row rather than an overwrite. That is what
append-only has to mean for a derived quantity.

## A slot number is not a hash

292 of 292 stored `snapshot_hash` values were the decimal slot number. 292 of 292
`capability_fingerprint` values were **identical to it**, and only 290 distinct
values existed across 292 rows — so two trajectories were already
indistinguishable in the one column meant to identify their inputs.

A slot number commits to no byte of the pool, the vaults, the mint or the fee
config. A replay comparing against it cannot detect that the state it re-fetched
is different, which is the entire purpose of the column.

Refused in **two** layers, because a check in one layer is a check that can be
bypassed by writing through another:

- `assertIsHash()` throws `NotAHash` in the domain;
- a `BEFORE INSERT` trigger on `coherent_snapshots` aborts anything that is not
  64 lowercase hex characters, and aborts a fingerprint equal to the slot.

## Raw state, or the numbers are unfalsifiable

The audit's C-4:

> `entry_cash_out`, `exit_cash_in`, rent and the venue skim are each recorded
> exactly once and are **unfalsifiable from the database**.

The worker returned complete pre/post account sets. They lived in process memory
and were reduced to the aggregate columns of `trajectory_settlements` before
anything was persisted.

`account_state_manifests` stores one row per `(job, step, leg, address)` with
**ABSENT explicit on both sides**:

```
created by the leg   pre = ABSENT      post = exact account state
closed by the leg    pre = exact state post = ABSENT
```

Neither is silently added to `unobserved`. That conflation is what let 292 of 292
trajectories settle while carrying an unmeasured lamport flow, and 275 of them
were SETTLED.

`CHECK ((pre_state = 'PRESENT') = (pre_blob_sha256 IS NOT NULL))` means the
distinction between "there are no bytes" and "we did not look" cannot be lost.

## Durability is read back, not assumed

`EvidenceStore.putDurable` writes the blob, **retrieves it**, re-hashes it, and
only then sets `readback_verified`. A row may not reference a blob that has not
survived that round trip, and `isPnlEligible`'s `rawStateDurable` reads the flag
rather than trusting that a write returned.

`pnpm evidence:blob-check` re-asks the question later, because silent corruption
of a research corpus is the failure that would be discovered years afterwards
and explain nothing.

## Persist before execute

```
1. persist the exact transaction bytes
2. persist the frozen plan
3. persist the snapshot
4. insert the observation
5. insert the worker job as REQUESTED
   -> only then execute
```

State progression, so a crash leaves a NAMED incomplete state reconcilable by
the same ids:

```
REQUESTED -> RUNTIME_RETURNED -> RAW_STATE_DURABLE
          -> EFFECT_VERIFIED -> SETTLEMENT_DERIVED -> COMPLETE
```

A trajectory does not become OPEN until the entry evidence graph and the
immediate-mechanics settlement are durable, and the link row — whose foreign keys
refuse anything dangling — is written in the same transaction.

## Checking it

```
pnpm evidence:graph-check            twelve link and identity checks
pnpm evidence:graph-check --strict   an EMPTY graph resolves trivially; --strict refuses it
pnpm evidence:blob-check             re-read and re-hash every registered blob
pnpm trajectory:trace -- --trajectory=<id>   recompute the economics independently
```
