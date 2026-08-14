# The immediate round trip, measured

`scripts/live-one-pass-trajectory.ts` → `artifacts/live-one-pass-trajectory.json`
`pnpm trajectory:one-pass`

## What was run

Twenty freshly migrated PumpSwap tokens from the `confirmed_migrations` queue —
**not** the screening stream, because only ~1.7% of screened mints have a
canonical pool (20 found against 1,180 refused for having none).

Each went **buy → sell → close inside one runtime**, the sell built from the
state the buy committed and executed against that same state.

```
complete round trips                20 of 20
quoteStateSurvived                  20 of 20
buy actually moved the sell pool    20 of 20
wrapped SOL stranded at close        0 of 20
residual tokens at close             0 of 20
```

These are the first trajectories to complete in this system. The apparatus works.

## The result

**Every one of the twenty loses money on an immediate round trip.** Drag as a
fraction of the 20,000,000 lamport notional:

```
-2.53  -2.54  -2.54  -2.54
-12.73 -12.74 -12.74 -12.74 -12.74 -12.74
-14.12
-21.67 -21.67 -21.67 -21.67 -21.67 -21.67 -21.67 -21.67
-31.86
```

The accounting is complete: wrapped SOL and residual tokens are both zero at
close on all twenty, so this is realised cash rather than value parked somewhere
unmeasured.

## What is established

**The best case is −2.54%**, and that is *exactly* the 250 bps round-trip fee at
the bottom canonical tier decoded live from the fee config (LP 2 + protocol 93 +
creator 30 = 125 bps per leg, doubled), plus base and priority fees. A best case
*below* the fee floor would have meant the fee model was wrong; it is not.

**An immediate round trip is never profitable.** Twenty of twenty. Any strategy
must clear the drag within its holding period before it earns anything.

## What is NOT established, and I am not going to pretend otherwise

**The losses cluster on repeated exact values, and I have not explained why.**

`-21.67%` appears eight times across eight *different* tokens, to the lamport
(4,333,248 ± 2). `-12.74%` appears six times. Genuine price impact into twenty
different pools would be continuous, not quantised.

Worse for any simple explanation: **the same token gives different values on
different runs.** `C7TNyyj4` measured −22.94% on one run and −2.54% on another;
`GKhe46z6` −12.73% then −2.53%. That rules out a per-token property.

Hypotheses tested and **rejected**:

- **Cross-venue artifact** — that the Jupiter-built buy landed somewhere other
  than the pool the sell used. Rejected: the buy mutated the sell pool's base
  vault on 20 of 20.
- **Unrecovered rent** — that the trade opened protocol-owned accounts whose
  rent-exempt minimum the payer funded. Rejected: `createdAccountRentAcross`
  reports **zero** created accounts on every trip. The step gaps are suspiciously
  close to 2,039,280 (the 165-byte rent-exempt minimum), which is what motivated
  the hypothesis, but no account was actually created.
- **Value stranded in wrapped SOL or residual tokens** — rejected, both zero.

So the clustering remains open. Until it is explained, **the median is not a
mechanics floor and must not be quoted as one.** The number that survives
scrutiny is the *best* case of −2.54%, which is a hard lower bound on round-trip
cost and is independently corroborated by the fee table.

## Why this distinction matters

The previous directive recorded this exact failure mode: a constant shortfall
"measured as a rate reads as a 41,818 bps pricing error at 0.001 SOL and a 1,044
bps one at 0.04 SOL — the same defect, reported as six different numbers."

Publishing "median −12.7% mechanics drag" would repeat it. A number with an
unexplained quantised structure is a measurement of something, and until it is
known what, it cannot be attributed to the market.

## What is NOT claimed

- **These are not fills.** Nothing was signed, submitted or funded on chain. The
  wallet balance is a local runtime mutation so an unfunded payer does not fail
  for a reason that is not about the token.
- **No holding period was evaluated.** Every number here is an immediate round
  trip; the strategy holds for a frozen 15 minutes.
- **Twenty tokens clears apparatus sanity (10) but not costs/fillability (25).**
  No arm may be selected or eliminated on this.
- **Evidence grade is `SIMULATED_EXECUTION`** — exact sequential mechanics, no
  future state involved.

## Next

Resolve the clustering before quoting any median. The concrete next step is to
dump the full per-step lamport deltas for two trips that landed on the same
cluster value and diff them account by account: whatever is equal to the lamport
across different tokens will name itself.
