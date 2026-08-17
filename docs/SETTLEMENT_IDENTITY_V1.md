# Settlement identity v1

The single most expensive finding in the 8f73cef audit:

```
settlements                              52
with a NON-ZERO unexplained remainder    51
of those, publishing a net PnL anyway    30
carrying an identity violation            0
```

Worst case in the corpus: trajectory `2b9bca05` published **net −6,426,787
lamports with −4,564,488 unexplained** — the residue is **71 % of the loss the
row reports**, on a 20,000,000 lamport notional.

`unexplainedLamports` was computed, stored, and **read by nothing**. It was
neither a `pnlBlockedReason` nor a `checkIdentities` violation.

## The one identity

```
net_pnl = exit_cash_in + cashback_claimed - entry_cash_out - cashback_claim_cost
```

Accrued cashback and claimable cashback are **not cash**. The trajectory
settlement, the trajectory row, the policy outcome, the report and readiness all
return this same value, and `pnpm trajectory:trace` re-derives it from raw
account bytes without calling the writer that produced it.

## Eligibility: seven conditions, and `isPnlEligible` owns four of them

```
complete                    every money-critical quantity is known
effectValid                 the trade demonstrably happened
fullAccountCoverage         every writable was observed on BOTH sides
unexplained == 0            no lamport left the payer unaccounted for
--- properties of the PERSISTED graph, supplied by the writer ---
rawStateDurable             every blob survived read-back
linksResolve                observation, job and step ids resolve to rows
residualSemanticsKnown      a residual token balance's meaning is established
```

`buildTrajectorySettlement` used to check the first three and **never read the
fourth**. It restated three of `isPnlEligible`'s clauses instead of calling it,
so a leg the domain itself called PnL-ineligible produced a published net PnL.
It calls `isPnlEligible` now, which means a condition added there can never again
be missing here.

The last three are absent by default and **absent means UNKNOWN, and unknown
blocks**. `DURABLE_EVIDENCE` is a named constant rather than a default parameter
precisely so that claiming durability is visible in a diff.

## Non-zero unexplained blocks PnL. No exception.

```
unexplained != 0
  -> net_pnl_lamports = NULL
  -> pnl_blocked_reasons includes the exact residue
  -> identity_violations includes the exact residue, AND a second violation
     saying a net PnL was published over it
```

The exact number goes into the message, not a boolean: it is what tells a reader
whether this is a rounding artefact or 71 % of the reported loss.

## Cost components, each exactly once

Included:

```
base fees              per leg
priority fees          per leg
tips                   per leg
measured transfer fees per trajectory
actual landed failed-attempt fees   per leg AND per trajectory
permanently unrecovered rent        created minus recovered
cashback claim cost
```

Excluded:

```
PRINCIPAL                  it is the entry, not a cost
expected failure cost      a forecast is not a realised cost
rent that came back        it was never spent
```

`executionCost(leg)` already contains the per-leg base fee, priority fee, tip,
net rent and per-leg failed-attempt cost. The three additions at trajectory level
are the transfer fee, the **trajectory-level** failed-attempt fee and the
cashback claim cost — and no more, because adding `rentLocked` on top counted
rent twice.

The trajectory-level failed-attempt fee entered **zero times**: the API accepted
it, stored it in `trajectory_settlements.failed_attempt_fees`, and added it to no
total. The audit's mutation set it to 5,000 lamports and measured no effect at
all. It was latent — nothing passed it — and an API that accepts a cost and loses
it is a defect whether or not a caller has reached it yet.

## A defect found by enforcing rather than by reading

The payer reconciliation added the cashback claim to the expected side:

```ts
namedPayerDelta = tradeIn - tradeOut - namedFees - namedRent + namedCashback   // WRONG
```

`actualPayerDelta` sums the ENTRY and EXIT legs' own payer deltas.
`claim_cashback` is a **third transaction** against the accumulator; its lamports
never pass through the buy or the sell. Adding the claim to the expected side
asserted a flow those two legs did not carry and manufactured a residue of
**exactly the claimed amount**.

A fixture with 60,000 claimed and 5,000 of claim cost produced a spurious −55,000
unexplained. Under the old build that was computed and ignored, so nothing
disagreed. The expression had been wrong since it was written.

If a claim LEG is ever settled as part of a trajectory, it must arrive as a third
`MeasuredLegSettlement` and be added to **both** sides of the reconciliation, not
to one.

## And a fixture that could not have happened

`tests/unit/trajectory-kernel-p4.test.ts` asserted *"satisfies the settlement
identities"* over a fixture whose payer deltas were short by exactly one base fee
across the round trip. It passed because `checkIdentities` did not look at
`unexplainedLamports`.

A fixture that cannot have happened, passing as evidence that the identities
hold, is the same defect one layer up.

## Sole-venue attribution conserves BOTH sides

The quote leg was tested only for SIGN:

```
quote in -> 0            attributed = false   correct
quote in -> 1 lamport    attributed = TRUE    against a 20,000,000 lamport entry
```

"The canonical pool accounts for all named deltas" was true of the base vault and
false of the quote vault, because the notional was never compared to what the
pool actually received.

Now: `payer outflow` must equal `quote vault credit + named fee flows`, within
the venue model's documented four-lamport rounding (four fee components, each
rounding down by at most one lamport). A **missing** payer outflow refuses by
name — a missing input must not read as a passed check.

## Checking it

```
pnpm ledger:identity                          the corpus-level identity sweep
pnpm trajectory:trace -- --trajectory=<id>    independent recomputation from raw bytes
pnpm trajectory:conflict-test                 eight append-only ambiguities, all loud
```
