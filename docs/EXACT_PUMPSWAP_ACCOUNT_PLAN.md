# The exact PumpSwap account plan

**Directive section:** P2 / F12, extended by P7 / F13 / F14
**Read against:** `@pump-fun/pump-swap-sdk` 1.19.0, on 2026-08-16
**Status:** implemented and enforced on both legs.

## The rule

```
build once → capture from THAT plan → execute THOSE bytes → fingerprint THEM
```

No rebuild is permitted anywhere in the loop. The SDK **chooses** things, and
two builds of "the same" leg are therefore not guaranteed to be the same
transaction:

- it selects a buyback fee recipient from a list in the global config;
- it appends remaining accounts conditionally, on two different conditions;
- it derives associated token accounts under whichever token program the mint
  happens to use, which is not predictable from the pool.

A system that captures state for one build, simulates a second and fingerprints
a third is comparing three different experiments and reporting one number.

## What the plan records

`freezeAccountPlan(leg, instructions)` is called on the **same array** that is
encoded on the next line — not a re-derivation of it. It records, per
instruction: the program id, the exact instruction data as base64, and the
ordered account metas with their index, signer and writable flags.

Position is part of the identity, so reordering the accounts changes the
fingerprint. That matters concretely: PumpSwap reads the cashback accumulator
ATA at remaining index 0 and the accumulator PDA at index 1, so *present* and
*present in the right place* are different facts.

Both legs are frozen and stored. Until this directive only the entry's plan
existed, so a replay had nothing to compare the sell against.

## The account layout of a leg

```
[ named accounts, per the IDL ]
[ accumulator WSOL ATA ]        buy and sell, when isCashbackCoin
[ UserVolumeAccumulator PDA ]   SELL ONLY, when isCashbackCoin
[ pool-v2 PDA ]                 when the pool names a coin creator
[ buybackFeeRecipient ]         ALWAYS
[ buybackFeeRecipientTokenAccount ] ALWAYS
```

### The two accounts that are observed, never derived

The last two are appended unconditionally on every buy and every sell, and the
recipient comes from a list in the global config rather than from the pool. They
are therefore **read off the built instruction** and recorded, never predicted.

This is not a detail. The first version of the cashback placement check assumed
the cashback accounts were last, compared its expected tail against the final
positions, and **refused every candidate on the chain**. The check was
fail-closed, so the wrong model produced a loud refusal rather than a quiet
mis-measurement — which is the entire argument for refusing rather than warning.

### What is verified, and when

`remainingTailRefusal` compares the ordered accounts that sit *before* the two
selected ones against the expected tail for the leg's regime, and it runs
**before either leg executes**. That timing is forced by the failure mode:
omitting the cashback accounts produces a valid transaction that lands, trades
normally, and pays the creator fee to the creator. There is no error to catch
afterwards, and nothing distinguishes the two outcomes in the result.

A refusal here is `CASHBACK_ACCOUNTS_MISPLACED`, and it is a refusal rather than
a warning because at the bottom canonical tier the difference is 30 bps per leg.

### A derivation that failed is not an account that was omitted

`expectedRemainingTail` reports an address it could not derive in `underivable`
and leaves it out of the expected list, and `remainingTailRefusal` refuses
separately on that. Merging the two would let a failed derivation read as a
builder defect — or, worse, let a builder defect read as a failed derivation.

## Coverage: every account the plan touches is in the captured state

`planAccountsNotCaptured` compares the frozen plan against the snapshot. This is
the check the derive-the-addresses approach could not make: the snapshot is
assembled from `swapAccountAddresses`, which re-derives what it *believes* the
leg will use, and on live pools the two differ by about fifteen accounts.

An account missing from the runtime does not fail loudly. It executes as
uninitialised and produces an error that reads as a fact about the token.

Accounts the plan names and the chain does not have are recorded in
`incompleteness` as *created by the leg* — which is exactly the cold-setup cost
P6 measures, so it is a finding rather than a failure.

## Sole-venue attribution

Showing the canonical base vault changed is not enough; a split or routed entry
moves it too. The entry is admitted only when

```
pool base out == taker credit,  and quote in > 0
```

Otherwise part of the flow went somewhere else and the run is not direct
evidence about this venue. Refusal name: `ENTRY_NOT_SOLE_VENUE`.

## What is stored

| table | what |
| --- | --- |
| `leg_account_plans` | both legs' frozen plans and fingerprints |
| `created_accounts` | every account a leg brought into existence, per leg |
| `leg_cashback` | accumulator, creator vault and fee recipient deltas, per leg |

`insertAccountPlan` refuses a *different* plan under the same identity and
accepts an identical retry, so evidence cannot be rewritten and an idempotent
re-record is not an error.

## What this does not claim

The plans describe transactions built and executed in an isolated local runtime
against exact captured mainnet state. Nothing here has been funded, signed or
submitted, and a frozen plan is a statement about bytes rather than about
profitability.
