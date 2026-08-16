# PumpSwap cashback, re-verified against primary sources

**Directive section:** P7 / F13 / F14
**Read at:** 2026-08-16
**Status:** the repository's stated belief was **wrong** and is corrected here.
Placement verification and per-leg accumulator measurement are now
**implemented and enforced** — see "What is implemented now".

## What the repository believed

> `sell` carries no volume accumulator in the pump_amm IDL.

That sentence is in this codebase and it is the reason only one leg's
creator-fee recovery was ever modelled. It is half-true in a way that produced a
wrong economic model: the accumulator is not a **named** account on `sell` in
the IDL, because it is an **optional positional remaining account** — exactly as
it is on `buy`.

## What the primary sources say

Three independent sources, all agreeing.

### 1. Official docs — `pump-fun/pump-public-docs/docs/PUMP_CASHBACK_README.md`

| leg | remaining index | account |
| --- | --- | --- |
| BUY | 0 | WSOL ATA of the `UserVolumeAccumulator` |
| SELL | 0 | WSOL ATA of the `UserVolumeAccumulator` |
| SELL | 1 | the `UserVolumeAccumulator` PDA itself |

Cashback accrues in **the WSOL ATA of the `UserVolumeAccumulator`**, not in the
user's wallet.

If the accounts are not appended on a cashback-enabled coin, *"the creator fee
will go to the creator as it normally would"*. There is no error. The trade
succeeds and the cashback silently does not exist.

### 2. The installed SDK — `@pump-fun/pump-swap-sdk/src/sdk/offlinePumpAmm.ts`

```
line 652   buy:   if (pool.isCashbackCoin) remainingAccounts.push( <ATA> )
line 859   sell:  if (pool.isCashbackCoin) remainingAccounts.push( <ATA>, <UVA PDA> )
```

**Buy pushes one account. Sell pushes two.** Both are followed by the coin
creator's `poolV2Pda` when `coinCreator` is set, so the cashback accounts are
the *first* remaining accounts, not the last.

### 3. The IDL — `src/idl/pump_amm.json`

`user_volume_accumulator` appears as a named account only on the instructions
that manage it directly (`init_user_volume_accumulator`,
`sync_user_volume_accumulator`, `close_user_volume_accumulator`,
`claim_cashback`). Its absence from `sell`'s named accounts is what the
repository mistook for "sell has no accumulator".

## Why this mattered economically

The repo modelled cashback as recovering the creator fee on **one** leg. The
official semantics recover it on **both**, which changes the retained round-trip
floor materially at the bottom tier:

```
BOTTOM-TIER NONCASHBACK    ~250 bps raw venue round trip
BOTTOM-TIER CASHBACK       ~190 bps retained, IF both legs are appended and claimed
>=420 SOL CANONICAL        ~50 bps retained, protocol + LP = 25 bps/leg
```

These remain **hypotheses to measure**, not PnL claims. Nothing here has been
funded, signed or submitted.

## What is already true in this repository

`buildBuyFrom` and `buildSellFrom` call `sdk.buyInstructions` and
`sdk.sellInstructions`, so the remaining accounts **are** appended by the SDK
whenever the decoded pool reports `isCashbackCoin`. That is good — and it is
also exactly the shape of defect this project keeps finding: it probably works,
and nothing checks that it does.

## What is implemented now

### 1. Placement verification, fail-closed — and it caught my own error first

`remainingTailRefusal` compares the ordered accounts of the frozen plan against
the expected tail, **before either leg executes**. It refuses rather than warns,
because omitting the accounts produces a valid transaction that lands and trades
normally and pays the creator fee to the creator: there is nothing to catch
afterwards.

**The first version of this check was wrong, and refused every candidate on the
chain.** The tail is not what the section above originally described. The SDK
appends two more accounts after the cashback ones, unconditionally, on both legs:

```
buy   [accumATA?]          [poolV2?]  buybackFeeRecipient  buybackFeeRecipientTokenAccount
sell  [accumATA?, uvaPDA?] [poolV2?]  buybackFeeRecipient  buybackFeeRecipientTokenAccount
```

`buybackFeeRecipient` comes from a list in the global config, so it cannot be
predicted from the pool — F12 exactly. It is OBSERVED off the built instruction
and recorded, and the verifiable accounts are compared *before* it.

A warning would have been read past. The refusal was not, which is the whole
argument for failing closed.

### 2. Per-leg accumulator measurement

`leg_cashback` stores one row per leg: accumulator WSOL ATA delta, UVA PDA delta,
creator vault delta, fee recipient delta. **Never summed on the way in** — a
single figure across both legs cannot answer the question F13 raises, which is
whether the SELL accrued, and a sum written once could never be taken apart.

`accrued_to_us` is the discriminating fact: the creator fee goes to the
accumulator OR to the creator's vault, never both. Both moving, or neither, means
something other than the modelled path happened and the leg is evidence for
neither — so the column is nullable, and null is not false.

`pnpm trajectory:collect` prints `buy accrued N, sell accrued M`. If `sell` stays
at zero while `buy` climbs, the old one-leg model was right after all and this
correction is wrong. That is precisely why it is counted rather than asserted.

### 3. Claimed vs claimable

`claimIsWorthwhile` now returns `allocatedCostLamports` and
`allocatedClaimableLamports`. It previously computed the trajectory count and
used it **only inside the reason string**, so every caller charged the whole
5,000 lamport claim to one trajectory whatever it passed — an amortisation that
had not reached any number a caller could read.

Only *claimed* cashback enters realized PnL. Accrued and claimable stay in a
separate economic-value view.

### 4. Fee tier from market cap, not quote reserve (F15)

`tierForPool` computes `quoteReserve × baseMintSupply / baseReserve` — the SDK's
own `poolMarketCap` — and selects with `selectFeeTier`, which replicates
`calculateFeeTier` including an edge `tierFor` had wrong: **below the first
threshold the program charges the FIRST tier, not nothing**, which is exactly the
case for the pools this system samples most.

Every classification call site had been passing raw quote reserve into a
market-cap parameter; one passed a hardcoded `0n`. They are not proportional — a
pool with a small quote reserve and a tiny base reserve is a HIGH cap — so the
substitution put pools in the bottom tier and reported a 250 bps floor where the
program charges 50.

An unread mint supply REFUSES rather than defaulting to the canonical billion,
and `feeConfigHash` is persisted so a stored tier survives Pump republishing the
table.

## Still outstanding

Cashback is verified structurally on every built leg. It has **not** been
observed accruing: `leg_cashback` is empty, because the RPC daily quota is
exhausted and no trajectory has opened since the wiring landed. The bps figures
above remain hypotheses, and this document does not upgrade them.

## Version pinning

The claims above were read on **2026-08-16** from the docs at
`raw.githubusercontent.com/pump-fun/pump-public-docs/main` and from the SDK
vendored in `node_modules/@pump-fun/pump-swap-sdk`. Re-read before relying on
them: this document records what was true when it was written, and Pump has
already changed fee-recipient behaviour once.
