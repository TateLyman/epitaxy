# True sequential round trip

`pnpm simulator:true-stateful-proof` → `artifacts/true-stateful-roundtrip-proof.json`

## What is being claimed

One local market state. A buy commits into it, the sell is **priced and built
from what the buy left**, the sell executes against that same state, and the
close recovers what it can. Six steps, one runtime, one wallet-to-wallet cash
flow.

```
capture pool, vaults, mint, fee config, and every program's actual ELF
  → buy commits
  → read the POST-BUY pool out of the runtime
  → price and build the sell against THAT pool, for exactly the credited atoms
  → run buy, sell, close as one committed sequence
  → measure the payer's native balance from beginning to end
```

## Why the sell cannot come from a router

Jupiter builds against current mainnet. It cannot price a pool that a
hypothetical buy just moved, so its sell would be chosen — route, size and
minimum output — against pre-buy depth. Substituting one here would rebuild the
linked-leg defect *inside the runtime that exists to prevent it*.

`packages/solana/src/pumpswap-offline.ts` makes the account source a parameter.
Every field of the official SDK's `SwapSolanaState` comes from account bytes and
nothing else, so the runtime's committed post-buy bytes feed the official
builder directly. Reads are synchronous and total: an account the source does
not have is an error naming that account, never a zero.

## The classification is code

`packages/domain/src/statefulness.ts`. `classifyRoundTrip` refuses:

| provenance | class |
|---|---|
| priced on mainnet, executed on mainnet | `LINKED_FRESH_STATE_LEGS` |
| inventory carried, everything else re-read | `LINKED_FRESH_STATE_LEGS` |
| **priced on mainnet, executed on committed state** | `LINKED_FRESH_STATE_LEGS` |
| committed both ways, venue overlap unmeasured | `SEQUENTIAL_BUT_DISJOINT_VENUE` |
| committed both ways, buy moved the sell's pool | `TRUE_SEQUENTIAL_ROUND_TRIP` |

The third row is the subtle one and it is why two provenances are tracked
instead of one. A sell that *executes* on committed state but was *priced* on
mainnet still had its size, route and minimum output chosen against depth that
no longer exists.

Only `TRUE_SEQUENTIAL_ROUND_TRIP` sets `usableAsStrategyEvidence`.

## Three defects, each found by running it

| symptom | cause |
|---|---|
| `AddressLookupTableNotFound` on every routed buy | the lookup **tables** were never captured — only the addresses inside them. A v0 message names its tables by address and the runtime has to read each one to resolve anything through it |
| `InstructionError(0, InvalidAccountData)` on the close | the official sell already appends its own `CloseAccount` on the wrapped-SOL side, so closing it again hit an account that no longer existed |
| a 41% round-trip loss | measured on the native balance *before* that unwrap. The proceeds were sitting one account over, still wrapped |

## What the completed trips measure

At 0.02 SOL, on tokens with a canonical PumpSwap pool:

```
AMM drag            246 bps, stable across runs
sell quote error    5,000 lamports — the base fee, and nothing else
self-impact         -3 to -19 bps
```

The sign of the self-impact matters and the naive expectation is backwards. A
buy leaves the pool with **less base and more quote**, so selling the same atoms
back into it fetches *more*. A fresh-state sell under-reports here rather than
flattering. Taking a magnitude would have hidden the direction, and the
direction is the finding.

## What this is not

It is not a strategy estimate. It measures what the mechanics cost on a
lifecycle nobody chose for its return, on tokens selected only for having a
pool. Most Pump mints in the corpus have no canonical PumpSwap pool at all —
they are still on the bonding curve — and that is reported as
`MARKET_NO_CANONICAL_POOL`, a fact about the market rather than a failure of the
apparatus.
