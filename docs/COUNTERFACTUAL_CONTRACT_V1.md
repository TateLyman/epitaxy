# Counterfactual contract v1

A hypothetical entry did not happen on mainnet. The pool that exists fifteen
minutes later **never contained our 0.02 SOL**, so a later mainnet quote is not
an exact future exit for a position that was never taken.

What the 8f73cef audit found:

```
evidence grades in the corpus:  SIMULATED_EXECUTION = 292
BOUNDED_COUNTERFACTUAL = 0      FULL_EVENT_REPLAY = 0
545 policy outcomes rest on later mainnet quotes with NO contract
```

and worse: the haircut columns on those rows came from the **entry** impact
bound, not from any contract over the exit. The gross delta the tournament
reported was built entirely from marks that carried no grade saying what they
were.

## Two admissible classes, and nothing else

```
BOUNDED_COUNTERFACTUAL_V1    cheap; development only; valid at or under a frozen
                             impact bound, with a frozen conservative haircut
RESERVE_DELTA_REPLAY_V1      exact; every confirmed pool-touching transaction
                             between entry and mark, applied in order
```

`SIMULATED_EXECUTION` is **never** admissible for a holding-period outcome. It
describes the immediate mechanics — the buy and the sell in one runtime instant —
which is a real and useful measurement of something else.

`admissibleForPnl()` refuses a missing contract **by name**, so the refusal is
countable rather than an absent grade nobody looked for.

## Bounded mode

Frozen before any outcome existed:

```
BOUNDED_IMPACT_CAP_BPS  = 10     entry impact above this and the row is REFUSED
HAIRCUT_FLOOR_BPS       = 25     the conservative adverse adjustment
HAIRCUT_FORMULA         = adverse_reserve_displacement_v1
```

The construction:

1. take the **real mainnet reserves** at the mark;
2. apply **our entry's displacement** to them — the pool our position would have
   faced contains our base and our quote;
3. adjust adversely by the frozen haircut: less quote available, more base to
   push through. **Both directions make the exit worse.**
4. price the exit against that.

Step 2 is what makes it a counterfactual rather than a quote. Step 3 is what
makes it conservative. A haircut that could flatter an exit is not a haircut, it
is a free parameter.

Above the cap the row is **refused**, not haircut harder. A bound that stretches
to cover any impact is not a bound.

Every bounded row is graded `DEVELOPMENT`. It cannot be promoted by assertion,
and a grade is not a plan to calibrate later.

## Reserve-delta replay

For a calibration subset:

1. collect every confirmed PumpSwap transaction touching the pool between entry
   and mark;
2. extract the pool-vault pre/post deltas from transaction metadata;
3. apply them **in slot order** to the local post-entry pool state;
4. price the counterfactual exit against the result.

That state contains our entry, so what comes out is the pool our position would
actually have faced. Expensive — it needs every intervening signature — which is
why it is a calibration subset rather than the routine path.

## Calibration: the gate is `conservative`, not `withinTolerance`

```
bounded BELOW replayed   pessimistic. Costs opportunity, cannot manufacture edge.
bounded ABOVE replayed   OPTIMISTIC. Every row carrying it OVERSTATES the exit.
```

The second is the failure mode that turns a losing strategy into a
winning-looking one, so `conservative` is the gate and `withinTolerance`
(±200 bps, frozen) is reported alongside it.

If the bound is not conservative, **bounded rows are invalidated.**

## Today

```
bounded rows  0
replay rows   0
paired        0
```

`pnpm counterfactual:calibrate` reports `status: NOT_RUN` with that reason and
exits non-zero. It does **not** emit zeros: a zero error rate over zero
comparisons reads as a calibrated bound, which is the exact substitution this
repository forbids everywhere else.

## Confirmatory collection

Later confirmatory work requires an approved replay contract, or an
independently justified and calibrated bounded contract. **No later mainnet
quote without one of those may enter PnL.**
