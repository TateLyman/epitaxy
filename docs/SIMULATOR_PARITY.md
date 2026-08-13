# Simulator parity

What the simulator has been checked against, what that establishes, and what it
does not. §15 of the development-and-simulation directive requires parity
against known-confirmed mainnet transactions **before** `SIMULATED_OK` can count
as confirmatory evidence. This document is the record of where that stands.

Reproduce everything here with:

```bash
npx tsx scripts/capture-parity-corpus.ts && npx vitest run tests/simulator/parity.test.ts
```

## The corpus

Three settled Jupiter v6 swaps, slot 438690267. Captured by
`scripts/capture-parity-corpus.ts` into `tests/fixtures/parity/mainnet-confirmed.json`
from the public mainnet RPC. Read-only: no signable payload is ever requested and
nothing is ever sent.

| signature | signatures | observed fee | model fee | base + priority | CU on chain |
|---|---|---|---|---|---|
| `3YPyHXebC1pN…` | 1 | 41,044 | 41,044 | 5,000 + 36,044 | 67,268 |
| `5dNx5ihYH5i7…` | 1 | 80,001 | 80,001 | 5,000 + 75,001 | 108,690 |
| `4QZCutKyvuVq…` | 2 | 10,271 | 10,271 | 10,000 + 271 | 53,722 |

## What this establishes: fee parity, exactly

The fee is `5,000 × signatures + ceil(unit_price × unit_limit / 1e6)`, and every
input to it is in the transaction's own bytes. It does not depend on pool state,
so a settled transaction prices identically today as it did at its slot. This is
the same `priorityFeeLamports()` the engine uses to cost every leg, so a
disagreement here would be a costing defect rather than a curiosity.

All three reproduce to the lamport. The corpus deliberately includes a
**two-signature** transaction — a corpus of only single-signature transactions
cannot distinguish a per-signature fee from a flat one and would still pass with
the multiplier deleted — and one whose priority fee is only 271 lamports, which
is small enough that a rounding error would show.

Two independent measurements agree on the ceiling:

- Against a live Surfnet, `SetComputeUnitPrice(2054)` with a limit of 200,000
  charged **411 lamports** while consuming only 450 units. `ceil(2054 × 200000 /
  1e6) = 411`. The runtime prices the **requested limit**, not consumption.
- Against settled mainnet, the same formula reproduces all three fees above.

## What this does NOT establish: execution parity

`/v1/parity` returns `NOT_ESTABLISHABLE_WITHOUT_ARCHIVAL_STATE` for every case,
and that is the honest verdict rather than a placeholder.

Replaying a settled transaction requires the accounts as they stood at its slot.
That needs an archival node this project does not have. Running the same
signature against today's pools would be a different experiment wearing the same
name, and reporting its agreement as parity would be exactly the laundering this
document exists to prevent.

A second, independent blocker sits behind the first. Measured against
`@solana/surfpool` 1.5.0, `setAccount(address, lamports, data, owner)` has **no
executable parameter**, so a program account cannot be restored from a snapshot
at all — it comes back non-executable and every route through it fails with an
invalid-program error that reads as a fact about the token. Programs must be
supplied as ELF and go through `deploy()`. The protocol carries
`programElfBase64` for this, the daemon **refuses** a snapshot naming an
executable account without one, and no ELF capture pipeline exists yet.

So offline confirmatory simulation of a real route is blocked on two things:
archival account state, and program ELFs.

## Consequence for the evidence gate

`SIMULATED_OK` **does not currently count as confirmatory evidence.** The gate is
closed and is enforced in code, not in prose:

- `responseIsConfirmatory()` refuses any run that is not `CONFIRMATORY_OFFLINE`,
  refuses one whose daemon tree does not match its commit, refuses one that
  fetched accounts it did not freeze, and refuses one that violated the economic
  bounds the caller asserted.
- `identityIsConfirmatoryGrade()` refuses a `+dirty` daemon outright.
- The daemon refuses a `CONFIRMATORY_OFFLINE` request with no frozen snapshot,
  and refuses a snapshot containing a program without its ELF.

What is proven today is the **cost model**, against outcomes this project did not
produce and cannot influence. That is worth having on its own: the fee is the
term the strategy's edge is measured against, and it is now anchored rather than
assumed.

## What would close the gap

1. Archival account state at a target slot, for every account a route touches.
2. Program ELFs for every program on that route, captured and frozen.
3. Re-running these three transactions offline and comparing `unitsConsumed`,
   `err`, and every balance delta against the settled meta already recorded in
   the corpus file — which is why `observedComputeUnits` is captured now, ahead
   of anything being able to check it.
