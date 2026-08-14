# Stateful round-trip proof

`pnpm simulator:stateful-roundtrip-proof` → `artifacts/stateful-roundtrip-proof.json`

One wallet, one lifecycle: buy → **measured** token credit → sell exactly those
atoms from the buy's post-state → close the account → one cash flow.

## What changed from the previous proof

The earlier ten-case proof ran ten **independent** legs, each in a fresh SVM
with an invented wallet. Five buys plus five sells is not five round trips:

- the sell spent an amount nobody had acquired
- out of an account nobody had created
- and the rent the buy paid was never the rent the sell recovered

Here the sell's provisioning IS the buy's post-state — the exact credited atoms,
and the SOL balance the buy left behind. The fees the buy paid are gone before
the sell starts.

## Result

```
attempted                 25
complete                   5
unknown money-critical    20
instrument failures        0
market failures            3
ATA created and closed     5
amount above 2^53          none observed
```

`complete` requires effect-verified on both legs AND every money-critical cost
known. A Token-2022 leg whose transfer fee and withheld fee were never measured
is **not** complete — unknown is not zero.

## The finding: a mechanical cliff at ~10⁹ atoms

Sorted by the atoms the buy actually acquired, at a 0.02 SOL notional:

| acquired atoms | trading loss (bps) | n |
|---|---|---|
| 168 – 44,590,556 | **~10,000** (total loss) | 17 |
| 5,487,945,694 – 863,270,902,263 | **66 – 335** | 8 |

There is a gap between 4.46 × 10⁷ and 5.49 × 10⁹ with nothing in it, and **no
exceptions in 25 samples**. Below the cliff the sell returns 3, 4 or 5 lamports
on a 20,000,000 lamport buy — dust. The position is destroyed by quantization,
not by price.

This is a mechanics fact, and it does not depend on the signal, the token or
the venue. A score cannot rescue it.

### A hypothesis that the sample falsified

The first six cases were all Token-2022 and all lost ~99.9%, while the one
legacy round trip lost 54 bps. That looked conclusive and it was wrong. Widening
to 25 cases put Token-2022 mints (Gillis 205 bps, Grox 209, Spoderman 271) on
the good side and legacy mints (BOB 10,003 and 10,002) on the bad side. The
discriminator is the atom count, not the token program.

Recorded because a six-sample split that clean is exactly what a premature
threshold gets fitted to.

## Two instrument defects this proof found

**The lamport cap held an atom count.** `buildSimulationRequestForLeg` bound
`maxLamportsSpent` from the input asset, and a token-input sell has no lamport
figure there — so it bound the token ATOM COUNT. A sell of 905 atoms asserted
the payer could spend at most 905 lamports and was refused for spending 6,121
on fees it could not avoid. The cap now lives on the leg and is always lamports.

**Rent was double-counted across independent legs.** Measured on the first
production round trip: 3,688 bps all-in against 363 bps of trading cost. Each
leg simulated from a fresh state provisions accounts a real round trip already
holds. In the stateful lifecycle the account is created once, closed once, and
the good cases land at 54–109 bps rather than 363.

## What this does not establish

The **paper engine** has not produced a stateful round trip. This is a proof
harness. The production loop still opens a position from a buy and observes an
exit separately, so no live row carries this lifecycle.

Five complete lifecycles from a script is instrument development. It is not a
strategy sample and nothing is fitted to it.
