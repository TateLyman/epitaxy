# The "stateful" proof is linked-leg instrument development

`artifacts/stateful-roundtrip-proof.json` is reclassified:

```
LINKED_LEG_INSTRUMENT_DEVELOPMENT
```

It is not deleted. Its completion rate, its "atom cliff" and its return
distribution are **not** strategy estimates and nothing is fitted to them.

## What it actually does

The proof carries two things from the buy into the sell:

```
post-buy SOL balance
measured token credit
```

Both are **wallet inventory**. The sell then runs as a fresh
`DEVELOPMENT_JIT` request, which means the daemon fetches current mainnet
state for everything else:

```
pool base reserve          re-fetched
pool quote vault           re-fetched
virtual quote reserves     re-fetched
creator / protocol accounts re-fetched
user volume accumulator    re-fetched
fee config                 re-fetched
every other writable       re-fetched
```

So the shape is:

```
linked wallet inventory across TWO independent market states
```

not:

```
buy commits state -> sell executes against that exact post-buy state
```

The code comment claimed the second. It said *"THE STATEFUL CARRY … the sell
starts from the SOL the buy LEFT"* — true, and the wrong half of the problem.
Naming it stateful is the defect, not the carry itself.

## Why it matters, and in which direction

A buy moves the pool: base reserve down, effective quote reserve up. The sell
should face **that** pool. Instead it faces the untouched one, so the round
trip is measured against a market the buy never touched.

Worse than the reserves: the sell **route** is chosen by Jupiter against
current mainnet state. A route selected for a pool that still has its
pre-buy depth is not the route a real exit would take, so route choice,
rounding and self-impact are all evaluated against the wrong book.

The error flatters. Selling into a pool you did not just buy from is
systematically better than selling into one you did.

Its size is **not known**, which is the point. It is bounded by the position's
share of the reserve, and that share was never measured — which is exactly the
gap the dimensionless mechanics below exist to close.

## Why Jupiter cannot fix this

`/build` constructs against current mainnet state. It cannot build a sell
against a hypothetical local pool produced by a buy that was never submitted.
No amount of care with the Jupiter path closes this, because the thing needed
does not exist on the other side of that API.

The counterfactual therefore requires a locally constructed official
Pump/PumpSwap transaction against a locally committed state. Jupiter stays as
discovery, benchmark, cross-check and fallback route — not as the oracle for a
hypothetical post-buy state.

## The report/artifact contradiction

| | attempted | complete | unknown cost | market failures |
|---|---|---|---|---|
| `docs/STATEFUL_ROUNDTRIP_PROOF.md` | 25 | 5 | 20 | 3 |
| `artifacts/stateful-roundtrip-proof.json` | 22 | 5 | 12 | 5 |

Both claim to describe one run. The proof was executed repeatedly while the
candidate ordering was changed; the artifact was overwritten each time and the
prose was not. Nothing forced them to agree.

Fixed by generating the figures from the artifact and stamping every artifact
with the commit that produced it — not by retyping the numbers.

## The atom cliff is not a portable finding

The previous window reported a hard cliff at roughly 10⁹ acquired atoms: below
it, total loss; above it, 66–335 bps. The correlation was real in that sample
and the **variable is not portable**. Raw atom count moves with decimals,
supply and price, so a threshold on it is a threshold on three unrelated things
at once.

It is replaced with dimensionless mechanics, each of which means the same thing
across mints:

```
position atoms / mint supply
position atoms / real base reserve
input quote / effective quote reserve
minimum representable quote output
position share of full executable capacity
exact price impact
exact all-cost immediate round-trip drag
```

The cliff, restated in these terms, is most likely *minimum representable quote
output* — a position so small that the sell rounds to dust. That is a
hypothesis about the previous sample, and it is not carried forward as a
finding.

## What remains valid from that window

The **instrument** repairs, which do not depend on the market state being
sequential:

- the residual identity holding at zero on measured legs
- the exit's own fees and rent being counted
- rent separated from trading cost
- exact-atom PumpSwap parity
- the measured settlement as one derivation

None of those are strategy estimates either.
