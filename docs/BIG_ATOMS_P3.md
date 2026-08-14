# P3 — amounts above 2^53

`pnpm simulator:big-atoms-proof` → `artifacts/big-atoms-proof.json`

## What is proven

The **instrument** carries amounts above `Number.MAX_SAFE_INTEGER` exactly.

Verified against the live daemon (`tests/simulator/daemon-contract.test.ts`):

```
10^18 atoms      reach raw account bytes, no exactNumber, no rounding
2^64             refused — not a balance the chain can hold
```

The defect this replaced: the daemon ran `exactNumber` over **every** balance
mutation, refusing token amounts above `MAX_SAFE_INTEGER` before reaching the
exact-byte path that has no such limit. It was guarding an API the token path
no longer takes, and it excluded the ordinary case — a nine-decimal mint with a
billion supply is 10^18 atoms.

SOL still crosses a JS number boundary, because `fundSol` genuinely takes one,
and is exact-range checked. Token atoms are u64-range checked and written as
bytes.

## What is NOT proven, and why it is the market rather than the code

The directive requires a **live BUILD_CUSTOM** case above 2^53, on the grounds
that no synthetic unit test closes P3. That case does not exist in this corpus,
and the reason is measurable.

Across 1,040 live buy observations the cheapest mint is 1.826 × 10⁶ atoms per
lamport, which at small size implies ~4.93 SOL would clear 2^53. It does not,
because output is **sublinear in input** — the credit is bounded by the pool's
token reserve, not by what you spend:

| hypothetical buy | measured credit | ratio |
|---|---|---|
| 20 SOL | 511,331,707,065,605 | — |
| 600 SOL | 951,494,455,050,882 | **30× the input, 1.86× the output** |

The best live route asymptotes at roughly 9.5 × 10¹⁴, which is 10.6% of 2^53
(9,007,199,254,740,992). Buying more atoms than the pool holds is not possible
at any notional.

So: **no live BUILD_CUSTOM route in this corpus can credit more than 2^53
atoms**, at any size, because no routed pool holds that many atoms of its
token. This is a fact about the tokens currently reachable, not about the
encoder, the request hash, the daemon precheck or the settlement.

## What would close it

A mint with more decimals or a far larger supply appearing in the candidate
population, at which point the existing script proves it with no changes. The
check is left in place and runs against whatever is live.

## Honesty note on the notional

These are **instrument** runs. The notional is far above any tradeable size and
no wallet is funded: the balance is hypothetical, inside a Surfnet destroyed
with the job, and the taker is a public key with no keypair anywhere in this
system. None of these runs is a strategy label and none is counted as one.
