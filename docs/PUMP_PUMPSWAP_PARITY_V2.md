# PumpSwap parity, v2

`pnpm pumpswap:parity-v2` → `artifacts/pumpswap-parity-v2.json`

## What v1 proved, and what it did not

Five buy quotes, one 0.02 SOL notional, current `Pump.fun Amm` routes, a local
wrapper over the official SDK. It did not prove sell parity, parity at any other
size, or — the one that matters — that the number the model produces is the
number the chain produces.

## Four sources per cell

| source | what it tests |
|---|---|
| `SDK_OVER_RPC` | the official SDK reading mainnet through our RPC |
| `OFFLINE_MODEL` | the same SDK reading a captured account **set** |
| `RUNTIME_EXECUTED` | what the transaction actually moved in the runtime |
| `JUPITER_BENCHMARK` | the router's own expected output |

The first two agreeing tests our account extraction. **The second and third
agreeing is the one that decides whether the model may drive a mark** — a quote
nobody executes is an opinion. Jupiter is a benchmark and is allowed to differ:
it may route through another venue entirely, and when it does that is a fact
about the route, not a parity failure.

## Result

```
mints                     3
cells                    36     (6 sizes x 2 sides x 3 mints)
measured                 36
buys                     18     sells 18
exact runtime/offline    36 / 36
base token programs      Token-2022 only
quote mints              wrapped SOL only
```

**Zero basis points on both sides at every size.** The offline model predicts
the runtime's executed output to the lamport.

## The defect a one-size matrix could not have caught

Before the fix, the sell arm disagreed with the runtime by:

```
0.001 SOL   -41,818 bps
0.0025      -16,727
0.005        -8,363
0.01         -4,181
0.02         -2,090
0.04         -1,045
```

Six numbers, one defect. The absolute error is constant at about 4.1 million
lamports and only the denominator moves. A matrix at a single notional would
have seen exactly one of these and called it a pricing residual.

It was two things, and neither was pricing:

1. **The accounts the sell opened were not observed.** A fixed observe list
   cannot see an account the transaction decides to create. Both legs now
   contribute their own account lists.
2. **Created-account rent was credited at the account's closing balance.** The
   coin-creator fee vault is opened *and paid* in the same transaction, so its
   balance is rent plus a fee the pool sent it. `rentExemptLamports` derives the
   exemption from the chain's constants — `(128 + len) x 3480 x 2` — and only
   that part is credited back; the excess is reported separately.

## Coverage this matrix still does not have

Stated rather than implied:

- **USDC quote** — every canonical pool in the sample quotes in wrapped SOL
- **legacy SPL base** — every mint in the sample is Token-2022
- **bonding curve** — only migrated pools have a canonical PumpSwap pool at all
- **Mayhem vs non-Mayhem** — not yet distinguished in the sample
- **fee-tier boundaries** — 21 of 36 cells had a dynamic fee config present; the
  boundary itself was not targeted
- **settled on-chain events** — compared against the runtime, not against a
  landed mainnet transaction

A direct route is not yet a production family. Quote parity and effect parity
hold; sequential lifecycle parity holds on this sample; instruction and account
parity against a *landed* transaction has not been run.
