# `1c499cd` trajectory kernel directive — report

**Terminal state: `MEASUREMENT_REPAIR_REQUIRED`.**

Zero trajectories have completed. The state is unchanged from the previous
checkpoint, and the reason it is unchanged is now a measured fact rather than an
open question.

## What the state rests on

`LIVE_READY` is forbidden by the directive and is not claimed.

`VALID_TRAJECTORY_KERNEL_RUNNING` requires `SIMULATED_EXECUTION` evidence — a leg
the runtime actually executed against captured state, sequentially, with the
post-state measured. **No such leg exists**, because the one-pass sequential
worker (P3) is not built. Every other grade is above that one, so no stronger
claim is reachable either.

The collector therefore **refuses to open trajectories**, and that refusal is the
finding rather than a gap in it. Opening one without the sequential worker would
price the exit from a state that never contained the entry, which is the exact
approximation the directive forbids making silently.

## Sections completed

| section | state |
|---|---|
| P0 preserve the machine | done (previous checkpoint) |
| P1 evidence taxonomy | done |
| P2 coherent snapshot | done, proven against the live chain |
| P3 one-pass sequential worker | **not done — the binding constraint** |
| P4 trajectory kernel | done |
| P5 one settlement | done (previous checkpoint) |
| P6 Pump cashback | done, cross-checked against the SDK |
| P7 migration lane | done, proven against the live chain |
| P8 trajectory collector | done; refuses to open, see above |
| P9 fill deadlock | done (previous checkpoint) |
| P10 treatments | done |
| P11–P18 | **not done** |
| P19 required tests | 55 of the directive's tests added this pass |
| P20 commands and artifacts | partial |

## The measurements that changed what is known

### The candidate stream was the binding constraint

```
screened mints with a canonical PumpSwap pool     6 of 185   (~3%)
migration-sourced candidates mechanically viable  6 of 6     (100%)
```

Ninety-seven per cent of the trajectory budget was being spent on tokens that can
never be sold through the direct path. This is P7's thesis, and it holds.

### The stored migration corpus is noise

Measured on the runtime database at head `1c499cd`:

```
MIGRATION events                          256,880
  errored transactions                    256,235   (99.75%)
  distinct mints                               56
  canonicalPool(storedMint) == storedPool       0   of 300 sampled
  stored mints with a live canonical pool       0   of 60 sampled
```

Three independent defects: identity taken from log string position, failed
transactions counted as flow, and a dedup key that collapses a multi-instruction
transaction.

### Fee tiers are a step function, and cashback is small where fees are small

25 official tiers decoded live. Bottom tier LP 2 / protocol 93 / creator 30 bps
per leg — matching the directive's stated figures exactly, which is the check
that the decoding is right.

Cashback can only ever return the creator portion, and only on the buy leg,
because **`sell` carries no volume accumulator account in the IDL**. So it is
worth 30 bps at the bottom tier and 5 bps at the top: it matters most on small
coins and does not rescue a high-tier one.

## Defects I introduced and then found

Recorded because a directive that only lists what worked is not an audit.

**A swap decoded as a migration.** The PDA check accepts any instruction whose
derived pool is in the account keys — and a `buy` references that same pool. The
first live run recorded one mint as having migrated seven times. Fixed with the
anchor discriminator: the PDA answers *which* pool, the discriminator answers
*whether this instruction created it*. The 16 rows that decoder wrote are marked
`MISIDENTIFIED_BY_PDA_ONLY_DECODER` rather than deleted — a record of a decoder
that was wrong is itself a finding.

**A vacuous proof.** The first coherent-snapshot proof compared *all* accounts,
and since the Clock sysvar advances every slot the `!bytesIdentical || …` clause
short-circuited to true on every run without ever testing the derivation. It
passed and could not have failed. The comparison is now over economic accounts
only, and the artifact publishes `economicBytesIdentical` so a reader can tell
whether the assertion was exercised.

**A second migration attributed to the first token.** Searching transaction-wide
token balances before the instruction's own accounts made every instruction in a
two-migration transaction resolve to the earliest mint — a different route to
exactly what identity-by-string-position did. Caught by my own test.

**An overwritten module.** I wrote the new evidence taxonomy over the existing
`packages/domain/src/evidence.ts`, which grades a different thing. Restored from
git; the taxonomy now lives in `trajectory-evidence.ts`.

**Full signatures in an artifact.** `migration-lane-proof.json` truncated
`signature` but published `dedupKey`, which embeds it. A 64-byte signature and a
64-byte secret key are indistinguishable by shape, which is why the scanner
cannot tell them apart.

## Facts about the chain worth keeping

**A pool's oldest signature is usually not its creation.** Bots submit buys
against the deterministic pool PDA before the migration lands, so the earliest
entries are frequently failed snipes. On the first pool examined, the oldest
signature was a failed `buy_exact_quote_in`.

**`getSignaturesForAddress` returns newest-first**, so the last entry of one page
is the oldest of the most recent N, not the oldest overall. One live pool needed
25 pages of 1,000 to reach its creation.

**`base58Decode`'s 128-character limit is right for an address and wrong for
instruction data.** 108 of 200 instructions threw and became "data not readable".

## What would move the state

`P3`, and only P3. A persistent sequential worker that executes the buy and then
builds the sell from the buy-mutated state inside the same runtime, returning a
canonical settlement. Everything upstream of it — coherent snapshots, verified
migration identity, direct pool pricing, cashback mechanics, the kernel, the
treatments — is built and tested and waiting on it.

Nothing was funded, signed or submitted. Canary and live were never run, and no
risk limit was loosened.

## Verification

```
typecheck   clean
secretscan  clean, 1,235 files
tests       1,393 passed, 4 skipped, 98 files
```
