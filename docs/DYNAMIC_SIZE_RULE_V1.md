# DYNAMIC_SIZE_RULE_V1

Module: `packages/strategy/src/size-rule.ts`
Ledger: `MT050`

## The defect

Every trajectory opened at a flat **0.02 SOL**. On a shallow pool that notional is
an absurd fraction of the reserve, so the depth gate refused — correctly — and the
candidate was lost.

But the refusal was about an **arbitrary research notional**, not about the token.
A 0.0025 SOL position in the same pool would have been ordinary. Each of those
refusals removed a real market observation from the corpus for a reason that had
nothing to do with the market.

## What changed, and what did not

**Changed:** the rule now asks *what size fits this pool?* instead of *does this
pool fit my number?*

**Not changed:** any safety bound. Every limit below is the one the fixed notional
already had to clear. 0.02 SOL is retained as the ceiling.

| bound | value |
|---|---|
| position share of effective quote reserve | ≤ 50 bps |
| local immediate price impact | ≤ 50 bps |
| bounded-counterfactual entry impact | ≤ 10 bps |
| warm recurring round-trip mechanics drag | ≤ 400 bps |
| exact entry/exit mechanics | must complete |
| token/reserve capacity | must be sufficient |

Candidate sizes: `0.0025`, `0.005`, `0.01`, `0.02` SOL. The **largest** admissible
size wins — largest rather than smallest, because a 0.0025 SOL position whose costs
are dominated by base fees measures the fee schedule rather than the market. The
bounds are what keep "largest" honest.

## Outcome-blind, structurally

`chooseSize(candidates, bounds)` takes no return, no mark, no PnL and no future
state. The type signature is the guarantee, not the discipline — there is no
parameter through which an outcome could arrive.

An **unmeasured** bound refuses. A price impact that could not be computed is not a
small one, and the size that would benefit most from that misreading is the largest.

## All four sizes are persisted

`size_rule_evaluations` stores every candidate with the condition that bound it,
and which one was chosen. Storing only the winner makes the rule unfalsifiable:
nobody could tell afterwards whether a refusal was a shallow pool or a bad rule.

## Cold versus recurring economics

Four classes, kept apart:

```text
FIRST_EVER_WALLET_SETUP   paid once per wallet, ever
WARM_WALLET_GLOBAL        the steady state
NEW_MINT_RECURRING        the base ATA this token needs and no other does
REPEAT_MINT               nothing new to create
```

Charging global setup to every hypothetical trajectory makes every trajectory look
worse than the strategy is, and a corpus that systematically understates its own
returns kills arms that work. The opposite error is worse and more tempting:
ignoring setup entirely, so the canary's first day arrives with an unbudgeted cost.

`pooledSetupCost()` **throws** when a first-ever setup is pooled with recurring
economics. A throw rather than a warning, because the pooled average is not
obviously wrong on inspection — it just quietly biases every cost comparison.

The base token ATA is closed in the sell transaction where valid, and the recovered
rent is accounted separately from the rent still locked.

## Command

```bash
pnpm size-rule:surface   # chosen sizes and the binding conditions
```
