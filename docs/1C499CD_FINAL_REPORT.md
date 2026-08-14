# `1c499cd` trajectory kernel directive — final report

**Terminal state: `VALID_TRAJECTORY_KERNEL_RUNNING`.**

`LIVE_READY` is forbidden by the directive and is not claimed. Nothing was
funded, signed or submitted; canary and live were never run; no risk cap was
loosened.

## Why this state and not another

| candidate state | verdict |
|---|---|
| `MEASUREMENT_REPAIR_REQUIRED` | superseded — trajectories now complete |
| **`VALID_TRAJECTORY_KERNEL_RUNNING`** | **claimed** — 20/20 complete, 20/20 coherent |
| `DEVELOPMENT_EDGE_CANDIDATE` | **not claimed** — no edge measured, only a cost structure |
| `PUMP_CONFIRMATORY_COLLECTION_STARTED` | not claimed — no frozen contract has been stamped against live collection |
| `CANARY_READY` | not claimed — requires `FULL_EVENT_REPLAY` evidence, which does not exist |
| `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` | **not claimed**, and this is a deliberate correction (below) |

## Sections

| | |
|---|---|
| P0 preserve the machine | done |
| P1 evidence taxonomy | done |
| P2 coherent snapshot | done, proven live |
| P3 one-pass sequential worker | done, proven live |
| P4 trajectory kernel | done |
| P5 one settlement | done |
| P6 Pump cashback | done, cross-checked against the SDK |
| P7 migration lane | done, proven live |
| P8 trajectory collector | done |
| P9 fill deadlock | done |
| P10 treatments | done |
| P11 cohort comparability | done |
| P12 risk facts before selection | done |
| P13 vault watching | done |
| P14 size and cost surface | done, and it overturned P8's reading |
| P15 prospective reject panel | done |
| P16 fingerprint allowlist | done |
| P17 bottleneck on active time | done |
| P18 confirmatory contract and readiness | done |
| P19 required tests | 1,477 passing across 104 files |
| P20 commands and artifacts | done |
| P21 fastest research lane | the migration lane, built and running |
| P22 final report | this |

**Not done and stated plainly:** `scripts/true-stateful-proof.ts` still contains
the pass-1/pass-2 structure P3 replaces. The replacement exists, is tested and is
used by the live path, but that script was not converted, so it still produces
the older checked-in artifacts.

## The three measurements that changed what is known

### 1. The candidate stream was the binding constraint

```
screened mints with a canonical PumpSwap pool     20 of ~1,200   (~1.7%)
migration-sourced candidates mechanically viable   6 of 6, then 20 of 20
```

98% of the trajectory budget was being spent on tokens that can never be sold
through the direct path.

### 2. The stored migration corpus was noise

```
MIGRATION events                          256,880
  errored transactions                    256,235   (99.75%)
  distinct mints                               56
  canonicalPool(storedMint) == storedPool       0   of 300 sampled
```

Identity from log string position, failed transactions counted as flow, and a
dedup key that collapses a multi-instruction transaction. All three repaired;
6 of 6 identities correct against the live chain.

### 3. The round-trip drag is a FIXED setup cost, not price impact

The single most consequential result, and it **overturned my own earlier
headline**.

```
size (lamports)   drag p50 (bps)   drag p50 (lamports)
    2,500,000           40,313          10,078,250
    5,000,000           20,279          10,139,978
   10,000,000           10,263          10,263,436

spread across sizes, in LAMPORTS   0.018
spread across sizes, in BPS        2.928
```

A 4× size change moves the lamport cost 1.8% and the rate 293%. The cost is
~10,100,000 lamports — five rent-exempt minimums of 2,039,280 — for accounts the
first trade on a new token must open. `10,078,250 = 5 × 2,039,280 − 118,150`.

**This is why `STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is not claimed.** The
single-notional run showed "median −12.7%", which reads as a proportional drag
that no memecoin strategy could clear. It is not proportional. It is a
first-trade cost that amortises with size and does not recur on the same token,
and the proportional floor underneath it is 250 bps. Killing the strategy on the
first reading would have been killing it on a units error.

## Defects I introduced and then found

Recorded because a report listing only what worked is not an audit.

- **A swap decoded as a migration.** The PDA check accepts any instruction
  referencing the pool, and a `buy` does. One mint was recorded as migrating
  seven times. Fixed with the anchor discriminator. Those rows are marked
  `MISIDENTIFIED_BY_PDA_ONLY_DECODER`, not deleted.
- **A proof that could not fail.** The first coherent-snapshot proof compared all
  accounts; the Clock sysvar advances every slot, so the assertion
  short-circuited on every run without testing the derivation.
- **A second migration attributed to the first token**, caught by my own test.
- **An overwritten module** — I wrote the new evidence taxonomy over the existing
  `evidence.ts`. Restored from git.
- **Full signatures in an artifact** via an embedded dedup key.
- **A blind rent measurement.** `createdAccountRentAcross` reported zero created
  accounts because the vaults were in the snapshot but not the per-step observe
  list. An account nobody observed is not an account that cost nothing.

## Chain facts worth keeping

- A pool's **oldest signature is usually not its creation** — bots snipe the
  deterministic PDA before migration lands. On the first pool examined, the
  oldest signature was a failed `buy_exact_quote_in`.
- `getSignaturesForAddress` is newest-first; one pool needed **25 pages** of
  1,000 to reach its creation.
- `base58Decode`'s 128-character bound is right for an address and wrong for
  instruction data — 108 of 200 instructions silently became "data not readable".
- **`sell` carries no volume accumulator in the IDL.** Cashback accrues on buy
  volume only, and the accumulator ATA is an *optional* remaining account, so a
  builder that omits it lands a valid trade that accrues nothing.

## What would move the state further

Not measurement. **Re-run the trajectory set at a notional where the fixed cost
is not the entire result** (0.1–1 SOL). Every economic number produced so far at
0.02 SOL is mostly arithmetic about rent.

Then: a frozen `ConfirmatoryContract` stamped before collection begins, 200
completed trajectories over 21 distinct UTC days, and the P18 readiness gates —
every one of which treats an unknown as a failure.

## Verification

```
typecheck   clean
secretscan  clean
tests       1,477 passed, 4 skipped, 104 files
```
