# Pump cashback economics

`packages/solana/src/cashback.ts` · `artifacts/cashback-mechanics-surface.json`

Every fact here was read out of the `pump_amm` IDL shipped in
`@pump-fun/pump-swap-sdk`, and every derivation is cross-checked against the
SDK's own in `scripts/cashback-mechanics-surface.ts`. A PDA derived from seeds I
read is a *claim* about the IDL; the cross-check is what makes it a fact.

```
userVolumeAccumulator   mine == sdk   ✓
globalVolumeAccumulator mine == sdk   ✓
accumulatorWsolAta      mine == sdk   ✓
```

## Two IDL facts that change the economics

### 1. `sell` has no volume accumulator account

Only `buy` carries `user_volume_accumulator`. **Cashback accrues on buy volume,
not on round-trip volume.** A model that credits both legs overstates cashback by
roughly a factor of two.

This is why the surface reports `maxCashbackRecoverableRoundTripBps` as *one*
leg's creator fee rather than two.

### 2. The accumulator WSOL ATA is optional and positional

The IDL's own words on `buy`:

> For cashback coins, optionally pass user_volume_accumulator_wsol_ata as
> remaining_accounts[0]. If provided and valid, the ATA will be initialized if
> needed.

**Optional** is the load-bearing word. A builder that omits it still produces a
valid transaction that lands and trades normally — it simply accrues nothing, and
the creator fee goes to the creator.

So a cashback coin bought without the account is indistinguishable from one
bought with it, right up until the PnL is wrong by the entire creator fee. That
is why `cashbackAccrualRefusal` fails closed: it returns the reason no cashback
will accrue, and the caller must handle it rather than assume.

The SDK confirms the same contract — it pushes the ATA into `remainingAccounts`
only `if (pool.isCashbackCoin)`.

## The three quantities

Never collapsed, because collapsing them books a receivable as revenue.

| | source | in PnL |
|---|---|---|
| `accrued` | `cashback_earned` on the accumulator | no |
| `claimable` | min(owed, the accumulator ATA's WSOL balance) | no |
| `claimed` | `total_cashback_claimed` | **yes** |

`claimable` is bounded by the balance actually behind it. A receivable larger
than its funding is not claimable, and treating it as such turns an unfunded
accumulator into phantom revenue.

`claimCost` is an execution cost. See
`packages/domain/src/trajectory-settlement.ts`, which holds all four separately.

## `UserVolumeAccumulator` layout

From the IDL struct, in order. Discriminator `[86,255,112,14,102,53,154,250]`.

```
user                      pubkey
needs_claim               bool
total_unclaimed_tokens    u64
total_claimed_tokens      u64
current_sol_volume        u64
last_update_timestamp     i64
has_total_claimed_tokens  bool
cashback_earned           u64
total_cashback_claimed    u64
```

## `claim_cashback` accounts

```
user                                        w
user_volume_accumulator                     w   PDA ["user_volume_accumulator", user]
quote_mint
quote_token_program
user_volume_accumulator_wsol_token_account  w   ATA(accumulator, quote_mint, quote_token_program)
user_wsol_token_account                     w   ATA(user, quote_mint, quote_token_program)
system_program
event_authority                                 PDA ["__event_authority"]
program
```

## The fee and cashback surface

25 official tiers, decoded live from the fee config. The mechanics floor is a
**step function of market cap**, not a constant — 241.5 bps is the bottom tier,
not a universal number.

| tier | LP | protocol | creator | per leg | round trip | round trip if cashback fully recovered |
|---|---|---|---|---|---|---|
| bottom (mcap 0) | 2 | 93 | 30 | 125 | 250 | 220 |
| top (mcap 98,240 SOL) | 20 | 5 | 5 | 30 | 60 | 55 |

The bottom tier matches the directive's stated figures exactly: creator 30 bps,
protocol 93 bps, LP 2 bps per leg.

Note what the last column means at the top tier: cashback is worth 5 bps there
against 30 bps at the bottom. **Cashback matters most on small coins**, which are
also where the round-trip drag is largest. It does not rescue a high-tier coin.

## Claim amortisation

A claim is a transaction and transactions cost. Claiming 900 lamports for a
5,000 lamport fee is a 4,100 lamport loss, and a per-trajectory claim is almost
always exactly that. `claimIsWorthwhile` refuses those.

This is the second reason only `claimed` enters PnL: cashback that is never
economically worth claiming is not revenue, however much of it accrues.

## Strata

Never pooled. A cashback coin at a high fee tier is a materially different
regime from a non-cashback coin at the bottom tier, and averaging them describes
neither.

```
CANONICAL_CASHBACK      CANONICAL_NONCASHBACK
NONCANONICAL_CASHBACK   NONCANONICAL_NONCASHBACK
```

## Not done

The directive requires, before a noncanonical pool is used as a low-fee arm:
LP ownership, withdraw authority, burn/lock status, pool age, depth persistence
and exit capacity. **None of these are implemented.** Noncanonical pools are
therefore classified but not tradeable, and the stratum exists to keep them
separate rather than to authorise them.

`claim_cashback` is decoded and its accounts are known, but **no claim has been
built or submitted** — that would be an execution act, and this system does not
sign.
