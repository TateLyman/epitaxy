# The true stateful size surface

`pnpm size:true-stateful-surface` → `artifacts/true-stateful-size-surface.json`

## What the retired surface said, and why it is gone

It generalised from **raw acquired atoms** at a single 0.02 SOL notional and
reported a "mechanical cliff at about 10⁹ atoms". Raw atoms move with decimals,
supply and price, so a threshold on them is a threshold on three unrelated
things wearing one number. It does not port from one token to the next, which is
the only thing a size rule has to do.

Everything here is dimensionless or a lamport cost, and every point is a buy, a
sell and a close that **committed in one runtime state**, with the sell priced
and built from the pool the buy moved.

## The surface

Four mints, 24 measured points, grid frozen before the first result.

| notional | AMM drag | repeat-trade drag | position/reserve | latency |
|---|---|---|---|---|
| 0.001 SOL | 241.5 bps | 791.5 bps | 0 bps | 0 bps |
| 0.0025 | 241.5 | 461.5 | 0 | −0.5 |
| 0.005 | 241.5 | 351.5 | 0.5 | −1 |
| 0.01 | 241.5 | **296.5** | 1 | −2.5 |
| 0.02 | 241.5 | 269 | 2.5 | −5.5 |
| 0.04 | 241.5 | 255 | 5.5 | −11 |

Three things are visible and each is a different mechanism:

**The AMM drag is flat.** 241.5 bps at every size. At these notionals it is
*fee*, not impact — the position never exceeds 5.5 bps of the base reserve, so
the curve barely moves. Anyone reading a round-trip loss at one size as "slippage"
is reading the fee.

**What falls with size is fixed cost amortising.** The gap between the repeat
drag and the flat 241.5 is 550 bps at 0.001 SOL and 13.5 bps at 0.04 — the same
absolute lamports (transaction fees, priority, tip) divided by a larger
denominator.

**What rises with size is exposure.** Position over reserve and latency
sensitivity both grow roughly linearly. Trading larger costs proportionally less
in fees and proportionally more in everything that depends on the market moving.

## The three setup cases, measured rather than assigned

An account that did not exist before the sequence and holds lamports after it
was *created*, and its rent-exempt minimum is a cost this trade paid and the
next trade on the same mint will not.

```
first wallet setup   everything the sequence opened, including accounts a
                     wallet opens once ever
first mint setup     the same minus the wallet-wide ones
repeat trade         neither — the steady state
```

At 0.02 SOL the difference between the first and third is about ten million
lamports, half the notional. A cost model that does not separate them describes
neither.

## Reconciliation

Every point reports `unexplainedResidualLamports` — the payer's measured loss
minus the components the script can name. It is **1 lamport** at every size,
from integer rounding in the AMM.

That field exists because it caught two defects that had been reported as
economics: a constant four-million-lamport shortfall from accounts the buy
opened that nothing observed, and a per-account over-credit from treating a fee
the pool sent to the creator vault as rent the payer recovered. A residual with a
name is a measurement; a residual absorbed into a cost is that cost being wrong
by an amount nobody can see.

## The development notional

**0.01 SOL**, chosen prospectively: the smallest grid notional whose median
repeat-trade drag clears a 300 bps mechanics gate. No return was looked at, and
the grid and the gate were both fixed before the first point was measured.

## What this does not establish

- The minimum representable output is **zero lamports** for one atom of these
  tokens. Dust cannot be exited, and residual atoms after a partial fill are
  worth nothing at any size.
- Two of six mints attempted failed entirely in the runtime
  (`InvalidProgramForExecution`, anchor `3012`). The surface describes the four
  that ran, and a selection effect from "the mints the apparatus can simulate"
  is possible and unmeasured.
- Latency is measured as *one further buy of the same size absorbed before the
  exit*. That is a specific counterfactual, not a distribution over what the
  market actually does in a block.
- None of this is a return. It is what the mechanics cost before any strategy.
