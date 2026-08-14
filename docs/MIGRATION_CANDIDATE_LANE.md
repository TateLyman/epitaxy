# The migration candidate lane

`packages/solana/src/migration.ts` · `apps/collector/src/trajectory-collect.ts`
`pnpm trajectory:collect` · `artifacts/migration-lane-proof.json`

## Why the candidate stream was the binding constraint

```
screened mints with a canonical PumpSwap pool     20 of ~1,200   (~1.7%)
migration-sourced candidates mechanically viable  20 of 20       (100%)
```

Ninety-eight per cent of the trajectory budget was being spent on tokens that can
never be sold through the direct path. Fixing the fill loop, the settlement and
the mark cadence could not produce a completed trajectory while the candidates
themselves were unsellable.

## What the stored corpus looked like

Measured on the runtime database at head `1c499cd`:

```
MIGRATION events                          256,880
  errored transactions                    256,235   (99.75%)
  distinct mints                               56
  canonicalPool(storedMint) == storedPool       0   of 300 sampled
  stored mints with a live canonical pool       0   of 60 sampled
```

Three independent defects.

**Identity by string position.** `mint` was the first base58 string in the logs
and `pool` the second. Log ordering is not an interface; it is an implementation
detail of whatever emitted it. Zero of three hundred pairs survived the only
check that matters.

**Failed transactions counted as flow.** Bots spam migrate attempts and lose the
race. Each failure was recorded as a migration.

**The wrong dedup key.** `(signature, program_id)` collapses every instruction in
a transaction to one row, so a transaction migrating more than one thing keeps
one arbitrary member of the set.

## How identity is established now

Derive the pool as a PDA of a candidate mint, then **require that address to
appear in the transaction's account list**. The program cannot have created a
pool whose address it never referenced, so this is a verification rather than a
guess.

**The instruction's own accounts are searched before the transaction-wide token
balances**, and that ordering is load-bearing. Searching transaction-wide first
made every instruction in a two-migration transaction resolve to whichever mint
appeared earliest — a different route to exactly what identity-by-string-position
did.

**The anchor discriminator is required.** The PDA check alone is not sufficient:
a `buy` or `sell` references the same pool, so "the derived pool is in the
account keys" is true for every trade against it. Verified on live data — with
only the PDA check, one mint was recorded as having migrated **seven times**.
Identity by PDA answers *which pool*; the discriminator answers *whether this
instruction created it*. Both are required.

Rows written by the PDA-only decoder are marked
`MISIDENTIFIED_BY_PDA_ONLY_DECODER` rather than deleted. A record of a decoder
that was wrong is itself a finding.

## Finding the creation transaction

Two facts make this harder than it sounds, and both were measured.

**`getSignaturesForAddress` returns newest-first.** The last entry of one page is
the oldest of the most recent N, not the oldest overall. One live pool needed
**25 pages of 1,000** to reach its creation.

**The oldest signature is often not the creation.** Bots submit buys against the
deterministic pool PDA *before* the migration lands, so the earliest entries are
frequently failed snipes. On the first pool examined, the oldest signature was a
failed `buy_exact_quote_in`.

`findPoolCreation` therefore pages to the end, then walks forward from the oldest
until an instruction actually carries a creation discriminator.

## `processed` is a claim

A migration acted on at `processed` and never rechecked is a candidate that may
not exist. `reconcileCommitment` returns `STILL_UNKNOWN` for an unchecked
sighting — which is not the same as `CONFIRMED`, and only `CONFIRMED` enters the
candidate queue. All 256,880 legacy rows have `reversal_status` NULL.

## The lane

```
confirmed migration → coherent pool snapshot → direct mechanics → trajectory selection
```

Launch and bonding-curve candidates stay a **separate** research lane. Millions
of pre-migration tokens must not consume the same high-cost trajectory budget.
