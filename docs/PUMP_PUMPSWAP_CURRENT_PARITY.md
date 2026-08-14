# Current official Pump/PumpSwap parity

`pnpm pumpswap:parity` → `artifacts/pumpswap-parity.json`

## Pinned versions

Verified against the npm registry on 2026-08-13, both matching the versions the
audited directive names:

```
@pump-fun/pump-sdk        1.36.0
@pump-fun/pump-swap-sdk   1.19.0
```

Installed with exact pins (`pnpm add -E`).

## Result

```
probe              0.02 SOL
measured pools     5
median |residual|  0 bps
worst  |residual|  0 bps
```

Every measured pool matched **to the atom**:

| mint | local | Jupiter |
|---|---|---|
| AUojwMGu6eag | 364,810,035,597 | 364,810,035,597 |
| jKBmeX6zWzjM | 896,660,992,613 | 896,660,992,613 |
| 6jbo1zD87ZyJ | 747,435,175,281 | 747,435,175,281 |
| BbYLxqukAb91 | 261,111,915,441 | 261,111,915,441 |
| GzrN3MUCcfP4 | 90,766,312,107 | 90,766,312,107 |

Exact, not "close". The directive's bar is that a 123–257 bps residual is not
parity; the measured residual is zero.

## Why it is exact, and what that does and does not prove

The local side is **not a reimplementation**. It is the official SDK's own
`buyQuoteInput` over the official SDK's own `decodePool`, `decodeGlobalConfig`
and `decodeFeeConfig`. Writing the arithmetic from memory could not have
cleared this bar: the fee tier is dynamic
(`FeeTier { marketCapLamportsThreshold, fees { lpFeeBps, protocolFeeBps,
creatorFeeBps } }`), and the quote reserve is effective rather than raw —
`virtualQuoteReserves` is a first-class parameter, and passing only the vault
balance misprices every canonical pool.

So what this proves is the part that was actually in doubt: **our** pool
identification, account reading and reserve extraction feed the official model
correctly. It does not prove Pump's arithmetic, which was never ours to prove.

## What is still missing

- Only the **PumpSwap** side is modelled. The Pump bonding curve V2 instruction
  set (`buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `user_volume_accumulator`,
  `sharing_config`, USDC quote) is not.
- 35 of 40 candidates had no account at the canonical pool PDA. That is
  correct: a canonical PumpSwap pool only exists **after** migration, and the
  youngest candidates — the ones this strategy is defined over — are still on
  the bonding curve and cannot be priced by this model at all.
- Parity is measured against Jupiter BUILD_CUSTOM, not against a settled
  on-chain swap. The directive asks for all four legs of the comparison.
- No per-fingerprint allowlist has been derived from this.

## Consequence

The local quoter is **not** enabled for decision-bearing fills. BUILD_CUSTOM
remains the executable oracle, per the directive's own rule that a direct
builder is not enabled by confidence alone and must pass the same policy,
effect and parity tests.

What it is now safe to use it for is high-frequency marks and alarms on
migrated pools, where an exact match against the router removes the reason to
spend a quote.
