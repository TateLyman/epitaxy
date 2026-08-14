# Coherent snapshot V2

`packages/solana/src/coherent-snapshot.ts`

## The defect this replaces

The previous capture read accounts sequentially and stamped a single slot on the
result. Between the first read and the last, a pool can be traded, a vault can be
drained and a fee config can be rewritten. The stamped slot therefore described
none of the accounts, and the set as a whole described a state that never
existed.

That is worse than a missing measurement. A missing measurement is visibly
absent; a blended one is a confident number derived from a fiction, and nothing
downstream can tell the difference.

## What coherence means here

Only *price-bearing* accounts have to be simultaneous. A program's bytes cannot
change what a swap costs; a vault's can. So the module splits them:

| class | examples | may drift |
|---|---|---|
| economically mutable | pool, base vault, quote vault, mint, fee config | **no** |
| static | programs, ALTs, sysvars | yes |

Refusing on a program's drift would reject good snapshots and teach the operator
to widen the bound — which would then also admit a drifting vault. The split
exists so that the bound on the accounts that matter can stay at zero.

## The three mechanisms

1. **Batch.** `getMultipleAccounts` returns up to 100 accounts served at one
   context slot. Within a batch, coherence is the node's guarantee rather than
   our hope. All economic accounts go in the first batch; more than 100 of them
   is refused rather than split, because a split cannot be simultaneous.
2. **Pin.** `minContextSlot` makes the node refuse to serve from a replica behind
   the slot already observed. A refusal is information; a silently older account
   is a state that never coexisted with its neighbours.
3. **Bound and enforce.** Batches can still land on different slots. The observed
   drift across economic accounts is recorded *and* checked against a frozen
   bound.

`DEFAULT_DRIFT_BOUND_SLOTS` is **0**. Any nonzero bound admits a state that never
existed. It is a parameter only so that a caller needing a looser bound has to
write the number down and defend it rather than inherit one silently.

## What is recorded

Requested slot · capture slot low/high · economic drift · commitment · block time
**from the chain** · epoch · Clock · Rent · EpochSchedule · every account's hash ·
per-batch context slots · ALT bytes and resolved addresses · programdata hashes ·
fee-config hash · omissions · incompleteness.

Two details that were specifically wrong before:

- **`rentEpoch` is never hardcoded to 0.** It is carried through as read, and
  `null` (the provider did not say) hashes differently from `0n` (the epoch is
  zero). They are different facts.
- **Block time comes from `getBlockTime`, not `Date.now()`.** The local clock is
  this machine's opinion about a chain it does not run.

## u64 handling

Every u64 is a decimal string in the snapshot type and therefore in JSON. No
lamport or token amount crosses JavaScript `Number`. A test asserts a
`2^53 + 1` lamport balance survives a JSON round trip intact.

## Fail closed

- An account named in `requireDecodable` that is absent refuses the snapshot.
- A truncated sysvar refuses rather than decoding a partial one.
- A lookup table whose body is not a multiple of 32 refuses rather than
  truncating — a truncated table resolves *fewer* accounts than the transaction
  references, which then reads as a missing account rather than as a corrupt
  table.
- A missing account that is *not* required is recorded in `omissions` and in
  `incompleteness`. It is never silently dropped.

## The proof

`scripts/coherent-snapshot-proof.ts` → `artifacts/coherent-snapshot-proof.json`

Two independent readers capture separately against the live chain, then:

```
same snapshot account set
→ same account hashes
→ same pool facts
→ same fee tier
```

**The comparison is made over the economic accounts alone, and this matters.**
Comparing over *all* accounts makes the assertion vacuous: the Clock sysvar
advances every slot, so "bytes identical" is false on every run and a
`!bytesIdentical || …` clause short-circuits to true without ever testing the
derivation. A proof that cannot fail is not a proof. The published artifact
carries `economicBytesIdentical` precisely so a reader can tell whether the
derived facts were actually exercised.

The proof also asserts the negative case: an impossible drift bound must
**refuse**, because refusing is the behaviour that distinguishes this module from
the one it replaces.

### Latest run

Two captures of a live migrated pool, one after the other:

```
economicAccountsWhoseBytesChanged  []          ← the pool did not move
economicBytesIdentical             true        ← so the derivation IS tested
poolFactsIdentical                 true
feeTierIdentical                   true  (250 bps round trip)
accountsWhoseBytesChanged          [Clock]     ← and only the clock ticked
economic drift, reader A / B       0 / 0
refused when bound impossible      yes
```

## Known limits

- `getMultipleAccounts` guarantees one context slot *per response*; the module
  trusts the node's reported slot. A node that lies about its own context slot is
  not detectable from inside this module.
- Programdata hashes are the hashes of the captured program accounts, not a
  verified ELF build. Restoring an actual ELF into a program cache is P3's job,
  not this module's.
- Feature-set capture is not implemented. It is listed in `incompleteness`
  rather than implied to be present.
