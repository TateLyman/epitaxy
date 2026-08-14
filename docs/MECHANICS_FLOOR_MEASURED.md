# The mechanics floor, measured

`scripts/live-one-pass-trajectory.ts` → `artifacts/live-one-pass-trajectory.json`
`pnpm trajectory:one-pass`

## What was run

Six freshly migrated PumpSwap tokens, taken from the `confirmed_migrations`
queue — **not** from the screening stream, because only ~3% of screened mints
have a canonical pool and a trajectory budget spent on the other 97% measures
nothing.

Each one went **buy → sell → close inside one runtime**, with the sell built from
the state the buy committed and executed against that same state. Six of six
completed. **Six of six had `quoteStateSurvived = true`** — the state the sell
was priced from was, per account by content hash, the state it executed against.

This is the first time trajectories have completed in this system.

## The result

Net lamports on a 20,000,000 lamport (0.02 SOL) buy:

| mint | acquired atoms | net lamports | drag |
|---|---|---|---|
| `C7TNyyj4AG` | 487,852,742,069 | −508,829 | **−2.54%** |
| `3M86JjNiFQ` | 1,040,332,317,438,418 | −2,545,568 | −12.73% |
| `FzoGxtVtxU` | 111,924,651,639,204 | −2,547,840 | −12.74% |
| `24WQ29ENFu` | 410,059,847,598,882 | −2,824,215 | −14.12% |
| `A7Peht9JUj` | 582,579,539,822 | −4,333,248 | −21.67% |
| `HLwz7bUo1Y` | 894,642,501,529 | −6,372,528 | −31.86% |

**Every single one loses money. Median drag −12.7%.**

## Why the best case is the check that this is real

−2.54% is **exactly** the 250 bps round-trip fee at the bottom canonical tier,
decoded live from the fee config (LP 2 + protocol 93 + creator 30 = 125 bps per
leg, doubled).

The floor landing precisely where the fee table says it should is what makes the
rest credible. Had the best case come in *below* 250 bps, the fee model would be
wrong rather than the trade good.

Everything above that floor is **price impact into thin post-migration pools**.
At 0.02 SOL — a deliberately small research notional — the impact is already
five to twelve times the fee.

## What this means for any strategy

A strategy must clear **~12.7% gross in its holding period just to break even**,
on the median token, at 0.02 SOL. That is the bar, and it is set by mechanics
rather than by anything the strategy does.

This does not by itself kill the strategy. It is an *immediate* round trip: the
strategy holds for a frozen 15-minute horizon and exits on a signal, so the
relevant question is whether a 15-minute move exceeds the drag often enough. But
it establishes the number that question has to beat, and the number is large.

It also says something concrete about sizing: drag is dominated by impact, and
impact grows with size, so the drag measured here is a **floor**, not an average.
A larger notional is worse, not better.

## What is NOT claimed

- **These are not fills.** No transaction was signed or submitted; nothing was
  funded on chain. The wallet balance in the runtime is a local mutation so an
  unfunded payer does not fail for a reason that is not about the token.
- **Six tokens is six tokens.** The directive's own checkpoints put apparatus
  sanity at 10 and costs/fillability at 25. This is below apparatus sanity, and
  no arm may be eliminated or selected on it.
- **No holding period was evaluated.** Every number here is an immediate round
  trip.
- **Evidence grade is `SIMULATED_EXECUTION`**, not `BOUNDED_COUNTERFACTUAL`:
  these are exact sequential mechanics, with no future state involved at all.
