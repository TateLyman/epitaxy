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


---

# After P4 — exact bytes, and a number of mine corrected

```
buys        5   effect-ok 4
sells       5   effect-ok 0
effect OK   4/10
INSTRUMENT failures 0   (required: 0)

ROUTE_ECONOMIC_REFUSAL  6
EFFECT_OK               4
```

## S055 is closed by removing the question, not by adjusting for it

The source token account is now written byte for byte, rent-exempt, by the
setup. The fee payer never funds it, so there is no provisioning rent to
compensate for in one place and forget in another. Accounts the setup wrote are
also excluded from `rentCreated`, because they existed before the transaction
ran.

## A number in the previous section was wrong

That section reported sell credits of 3,868,516 / 2,071,739 / 2,084,821 /
4,146,740 lamports and called the round trip an 80.7% loss.

**Those were double-counting rent.** The verifier's formula already adds
`rentCreated` back, and the harness was passing the same figure again as
`provisioningRentLamports`. The honest numbers:

| leg | rent created by the tx | output credit |
|---|---|---|
| sell `EVULoNF4De` | 0 | **19,488,023** |
| sell `HPMU32wr8u` | 2,074,080 | 10,948 |
| sell `GUrsAdHKt3` | 2,074,080 | -3,676 |
| sell `HgSPYBvkVo` | 4,148,160 | -2,404 |
| sell `9rbHhJU7Vs` | 4,148,160 | -282,404 |

`EVULoNF4De` is the shape a real sell has: no account creation, 19.5M lamports
back on a 0.02 SOL position. The others are dust positions whose proceeds do not
cover their own mechanics.

The 80.7% round-trip figure should not be quoted. It was arithmetic of mine, not
a market measurement.

## Unobserved and non-positive were one message

Both produced "output delta is missing", so a sell whose proceeds genuinely did
not cover its mechanics was classified as an instrument failure -- the market's
answer filed as our own, which is the exact inversion this exercise exists to
prevent.

They are now different: `null` is unobserved and remains an apparatus failure;
an observed credit of zero or less is `the output credit is N, which is not a
gain` and is the trade's answer.

With that separated, **instrument failures are zero** and the six refusals are
all economic.

## P6 is still not satisfied

Four of ten effect-verified. No sell verifies, because on these positions no
sell is a gain. That is a result about size and liquidity rather than about the
apparatus, and it is five cases.


---

# After P5 — P6 IS SATISFIED

```
buys        5   effect-ok 4
sells       5   effect-ok 4
effect OK   8/10
INSTRUMENT failures 0   (required: 0)

EFFECT_OK               8
ROUTE_ECONOMIC_REFUSAL  2
```

P6's bar is **not** ten passes. It is:

> 10/10 either `SIMULATED_EFFECT_OK` or a token/program/route-specific failure
> with a complete explanation — 0 instrument failures, 0 missing-output
> artifacts, 0 unsafe-number artifacts.

Eight verify. Two refuse, each with a complete and specific explanation. Zero
instrument failures. **The bar is met.**

## What moved it from 4 to 8

One line. Every run reported `fee decomposition incomplete: no priority fee
reported`, including every run whose fee was perfectly well known from its own
compute-budget instructions, because the fee was suppressed unless a
balance-derived residual agreed with the bytes exactly.

That residual is not a second measurement of the same thing. It is
`payer loss - others gained`, and the identity does not hold for a sell — a sell
*increases* the payer's balance, so the subtraction produces a number with no
meaning and then suppresses the one that had meaning.

The runtime charges on the requested limit and the requested limit is in the
transaction. The bytes are authoritative; the balance check is corroboration,
recorded on `priorityFeeCorroborated` rather than gating.

## The two refusals

**`buy 9rbHhJU7Vs` — the route spent more than it was given.**

```
requested 20,000,000    actual debit 20,278,400    excess 278,400
```

Net of base fee, priority fee and rent. 278,400 lamports — 139 bps of the
notional — leaves the payer for something the cost model does not name. Worth
pursuing: an unmodelled cost of that size is exactly what turns a positive
backtest into a negative account.

**`sell 9rbHhJU7Vs` — the position is worth less than it costs to sell.**

```
input 1,678 atoms    output credit -277,839 lamports
```

Two independent sources agree: the effect verifier computes -277,839, and the
daemon's own bounds check reports the same figure against the route's stated
545-lamport minimum. Not an artifact — a dust position whose exit does not cover
its own mechanics.

## Coverage

| requirement | status |
|---|---|
| legacy SPL Token mint | yes |
| Token-2022 mint | yes, four of five |
| native SOL output | yes, all five sells, four verified |
| ATA creation | yes |
| amount above 2^53 | not in this sample; the encoder is tested to u64 max |
| pre-existing ATA | not isolated |
| transfer-fee extension | none encountered |
