# The size surface

`pnpm size:admission-surface` → `artifacts/economic-admission-surface.json`
`pnpm simulator:stateful-roundtrip-proof` → `artifacts/stateful-roundtrip-proof.json`

## 1. The configured score threshold is decorative

Machine-generated from the running config and the live ledger, using the same
`sizePosition` and `viableFloorLamports` the engine uses — not a recomputation
that agrees until one of them changes.

```
NAV                    9.582071288 SOL
risk budget per trade  0.023955178 SOL   (0.25% of NAV)
round-trip overhead    0.00206528  SOL
min viable notional    0.0209128   SOL   (fixed costs must not dominate)
configured min score   0.35
EFFECTIVE min score    0.88
```

The score-to-size curve, at the points that matter:

| score | notional | outcome |
|---|---|---|
| 0.35 | 0.008384 SOL | refused — below the viable floor |
| 0.70 | 0.016769 SOL | refused |
| 0.85 | 0.020362 SOL | refused |
| 0.87 | 0.020841 SOL | refused, by 71,796 lamports |
| **0.88** | **0.021081 SOL** | **first admitted size** |
| 1.00 | 0.023955 SOL | admitted |

`minOpportunityScore = 0.35` has never rejected anything that sizing would have
admitted. Every discussion of "lowering the score threshold" is about a lever
that is not connected: the binding constraint is that 0.25% of a 9.58 SOL book
is 0.024 SOL, and a round trip's fixed costs need 0.021 SOL of notional before
they stop dominating.

**This is why no position has opened.** Not the gates, not the score — the
arithmetic of the risk budget against the mechanics floor.

Three levers exist and all three are real decisions rather than tuning:
raise NAV, raise the risk fraction, or lower the overhead. The directive
forbids the first two as ways to manufacture trades. The third is the honest
one, and P6's ATA-close work is exactly that: recovering the 0.00204 SOL of
rent removes the largest single term in the overhead.

## 2. What the stateful round trips say about size

25 lifecycles at 0.02 SOL, from `artifacts/stateful-roundtrip-proof.json`:

| acquired atoms | trading loss | n |
|---|---|---|
| 168 – 44,590,556 | ~10,000 bps | 17 |
| 5.49e9 – 8.63e11 | 66 – 335 bps | 8 |

Nothing between 4.46e7 and 5.49e9; no exceptions. Below the cliff the sell
returns 3–5 lamports on a 20,000,000 lamport buy. The position is destroyed by
quantization, not by price, and this is independent of the signal.

At the admitted notional the strategy can only trade tokens whose price implies
more than roughly 10⁹ atoms per position. That is a **selection rule**, not a
score input, and it is enforced by the measured round-trip gate rather than by
a heuristic on decimals.

## 3. What is NOT established

The preregistered grid — 0.001, 0.0025, 0.005, 0.01, 0.02, 0.04 SOL — has not
been run. The 0.02 SOL column is the only one measured, and it was measured at
25 cases rather than a full per-fingerprint sweep.

Running the smaller sizes is not currently informative: at 0.02 SOL the round
trip is already quantization-dominated for two thirds of live candidates, and
every smaller size makes that worse rather than revealing a different regime.
The grid becomes worth running when the overhead falls, because that is what
moves the viable floor.

No development size has been chosen. Choosing one from this would be choosing
from a single measured column.
