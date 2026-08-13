# Pump effect proof — ten live cases

P6. Five Pump buys and five Pump sells, built fresh against the chain and
simulated with a setup that describes the leg. `pnpm pump:effect-proof` →
`artifacts/pump-effect-proof.json`.

The bar is not ten passes. It is ten results whose failures are the market's:

> a failed real route is useful; a failed apparatus is not

## Current result

```
buys        5   effect-ok 1
sells       5   effect-ok 0
effect OK   1/10
INSTRUMENT failures 3   (required: 0)

ROUTE_ECONOMIC_REFUSAL          6
INSTRUMENT_MISSING_OBSERVATION  3
EFFECT_OK                       1
```

**P6 is not satisfied.** Three instrument failures remain, all on sells.

## What this run established

**The first effect-verified leg this repository has ever produced.** One Pump
buy passed all four checks with its token credit measured exactly:

```
owner=8MNXnWvhMvzf  mint=HY3sPMdKwBzY  delta=17,823,066,830  created=true
```

That number is the point. Before P2 it read as unobserved, every time.

## Three defects found by running it, not by reasoning about it

**1. The token-balance identity mismatch (P2), confirmed and repaired.** The
daemon serialised by token-account pubkey; the verifier looked up `owner:mint`.
Proven against the stored corpus first — every key in every stored map is a
base58 account pubkey and no `owner:mint` key has ever existed.

**2. A mint decoded as a token account.** The first structured output carried
rows for the route's own mint accounts with garbage owners. A mint is owned by
the token program too, and the length check was `>= 72`. Sizes are the
discriminator: legacy mint 82, token account 165, Token-2022 165 plus a type
byte where 1 is Mint and 2 is Account.

**3. The taker's own ATA was not being watched.** `MAX_WATCHED_ACCOUNTS` was 64
and the watched list was an unordered `slice`. A Pump route resolves past 64
through its lookup tables, and a buy has no token mutation to name its
destination — so the pool's movement was observed, the fee payer's was observed,
and the one account the trade exists to credit was not. Reported as "output
delta is missing" on a transaction that had delivered. The daemon's own bounds
check agreed, for the same reason.

The leg's accounts now go first, where truncation cannot reach them.

## A fourth, in the proof harness itself

Four of the five mints are **Token-2022**. The harness derived the token program
from a stored observation's static keys and declared legacy Token, so the
verifier refused them — correctly. It had been told to assert a program that was
not the one in play, and an assertion that does not hold is a refusal.

The authoritative answer needs no RPC: an associated token address is derived
*from* the program, so exactly one of the two derivations appears among the
accounts the route compiled against. That one is the program.

This satisfies P6's Token-2022 coverage requirement, by accident and then on
purpose.

## What remains — the sells

Three sells report "runtime succeeds but output delta is missing" while their
runtime succeeded.

A token→SOL sell's output is **native lamports**, not a token delta, and the
current `EconomicBounds` sends one generic `mint + minTokenDelta` for both
directions. P3 of the directive replaces it with explicit `inputAsset` and
`outputAsset` discriminated unions for exactly this reason:

> A native-SOL sell may never be checked through `minTokenDelta`.

The measurement is also confounded by the provisioning itself: the cheatcode
creates the source token account, the payer carries that rent, and the payer's
net SOL delta therefore mixes trade proceeds with setup cost. Separating them is
what the asset-aware bounds are for.

Until that lands, a sell's economic effect cannot be verified, and none is
claimed.

## Coverage against P6's list

| requirement | status |
|---|---|
| legacy SPL Token mint | yes — `HY3sPMdKwBzY`, the one that passed |
| Token-2022 mint | yes — four of five |
| amount above 2^53 | not in this sample; largest was 1.78e10 |
| native SOL output | yes — all five sells, and it is what fails |
| ATA creation | yes — every buy created its destination |
| pre-existing ATA | not isolated in this sample |
| transfer-fee extension | none encountered |

Three of seven coverage items are unmet, which is a further reason P6 is not yet
satisfied.


---

# After P3 — asset-aware bounds

```
buys        5   effect-ok 4
sells       5   effect-ok 0
effect OK   4/10
INSTRUMENT failures 0   (required: 0)

ROUTE_ECONOMIC_REFUSAL  6
EFFECT_OK               4
```

**Zero instrument failures.** That gate is met: nothing in this run fails
because of the apparatus.

## The sells now measure

Before P3 a token→SOL sell reported "output delta is missing" because the
request asked `minTokenDelta` about an account the trade never touches. With the
output named as native lamports, the credits appear:

| leg | in | out |
|---|---|---|
| sell `9rbHhJU7Vs` | 1,678 atoms | 3,868,516 lamports |
| sell `GUrsAdHKt3` | 905 atoms | 2,071,739 lamports |
| sell `HPMU32wr8u` | 10,872 atoms | 2,084,821 lamports |
| sell `HgSPYBvkVo` | 695 atoms | 4,146,740 lamports |
| sell `EVULoNF4De` | 144,013,431,162 atoms | 19,489,917 lamports |

And the exact token debit matches the input on every one.

## The round trip is brutal, and that is a market fact

Buy 20,000,000 lamports of `9rbHhJU7Vs` → 1,678 atoms. Sell those 1,678 atoms
back → 3,868,516 lamports.

**An 80.7% loss on an immediate round trip.** Not a defect: 0.02 SOL is a large
fraction of these pools, so the buy moves the price against itself and the sell
moves it again. This is exactly the number the whole apparatus was built to
measure, and it is the first time it has been measured correctly.

If it holds across a real sample, no entry signal clears it and the honest
conclusion is that this size cannot trade these pools. That conclusion is not
drawn from five cases.

## The remaining defect is mine, and it is a second number

The daemon reports `native SOL credit -1420` where the verifier reports
`4,146,740` for the same leg.

Both are computing "what did the sell pay out", and they disagree because I
compensated for provisioning rent in the verifier's context and not in the
daemon's bounds check. Opening a source token account so the sell has something
to spend is a setup cost; against a 0.02 SOL leg its 2,039,280 lamports is ten
percent of the notional, so whether it is included dominates the answer.

Two implementations of one quantity is the exact defect class this project keeps
finding — a cost that appears in one path and disappears in another. It is
recorded rather than patched with a third adjustment:

- the daemon must be told which created accounts are the SETUP's, not the
  trade's, and exclude their rent from the credit;
- or the setup must provision the source account without the payer carrying its
  rent, so the question does not arise.

The second is cleaner and is what P4's exact-account-bytes path would allow:
writing the token account directly, rent-exempt, rather than having the
transaction open it.

Until then a sell's credit has two values, and neither is quoted as the answer.
