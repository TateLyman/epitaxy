# PumpSwap cashback, re-verified against primary sources

**Directive section:** P7 / F13 / F14
**Read at:** 2026-08-16
**Status:** the repository's stated belief is **wrong** and is corrected here.
Placement verification and per-leg accumulator measurement are **not yet
implemented** — see "What is still missing".

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

## What is still missing

1. **Placement verification.** The P2 frozen account plan records ordered metas,
   so placement is now checkable *by position*, which is precisely what the docs
   say matters. The check should compare the plan's trailing accounts against
   the expected tail:

   ```
   buy   tail = [accumulatorATA?, coinCreatorPoolV2Pda?]
   sell  tail = [accumulatorATA?, userVolumeAccumulatorPda?, coinCreatorPoolV2Pda?]
   ```

   and **fail closed** when the pool is cashback-enabled and the tail does not
   match. Comparing the exact tail avoids hardcoding a named-account count that
   the IDL is free to change.

2. **Per-leg accumulator measurement.** Accumulator ATA and UVA PDA pre/post on
   the buy *and* on the sell, separately — the deltas are the evidence that both
   legs actually accrued.

3. **Claimed vs claimable.** Only *claimed* cashback may enter realized PnL.
   Accrued and claimable belong in a separate economic-value view. The claim
   costs a transaction, and `claimIsWorthwhile` must change the allocated cost
   rather than only its explanation string.

4. **Fee tier from the SDK, not from quote reserve** (F15). The canonical tier
   is defined by *current token price × 1,000,000,000 tokens*, and must be taken
   from the SDK's decoded/quoted tier with the fee-config hash persisted
   alongside it.

## Version pinning

The claims above were read on **2026-08-16** from the docs at
`raw.githubusercontent.com/pump-fun/pump-public-docs/main` and from the SDK
vendored in `node_modules/@pump-fun/pump-swap-sdk`. Re-read before relying on
them: this document records what was true when it was written, and Pump has
already changed fee-recipient behaviour once.
