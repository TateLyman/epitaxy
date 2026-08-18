# Policy treatments v1

```
the corpus carried ONE distinct entry policy — HARD_GATES_RANDOM = 292 —
against THREE defined in packages/strategy/src/treatments.ts.
decideEntry had ZERO production callers.
trajectory-collect.ts:896 wrote the string literal 'HARD_GATES_RANDOM' on every
row, AFTER admitCandidate had already made the decision.
```

That is "labels attached after a common decision". The entry side of the
tournament did not exist: the two challengers had a sample of zero, and the label
described nothing that happened.

## The sample is selected independently of any entry policy

A trajectory is opened on **mechanics viability and the hard safety gates** —
never on a policy's opinion. Then every policy is asked what IT would have done,
over the same pre-entry features.

That makes the comparison **paired**: same token, same pool, same marks, same
costs, different decision. Pairing removes the token-selection variance, which at
this sample size is the dominant term.

## Entry policies

```
HARD_GATES_RANDOM                the causal control. NO signal beyond the gates,
                                 seeded so it is reproducible across machines.
CORRECTED_CURRENT_QUALITY_SCORE  the score, with coverage required.
SURVIVOR_FLOW_CONTINUATION_V1    buyer persistence, non-Mayhem inflow, reserve
                                 and exit-capacity trends, continuation slope,
                                 creator selling, entity concentration.
```

One row per `(trajectory, entry_policy)` in `trajectory_policy_decisions`, each
carrying the decision, the reason, the exact feature snapshot, its hash, the
policy version and the decision timestamp.

**An unknown is never a pass.** A policy that treated null as "fine" would enter
most often on exactly the tokens nothing is known about. In this build the
collector does not yet measure the flow features, so
`SURVIVOR_FLOW_CONTINUATION_V1` REJECTS with a named unknown — which is a real
decision with a real reason, and is what a sample of zero was not.

## Did a risk fact change the decision?

Every decision is made **twice**: once with the entity-adjusted concentration and
once with the raw top-holder share. `decision_without_risk_facts` records the
second.

A fact that never alters an outcome is not wired in. The audit found
`entity_concentration` holding 57 rows, **none joined to a candidate decision**,
and 1,959 of 1,959 risk-fact rows stratified `CONCENTRATION_RAW_ONLY` — so the
raw share decided every admission, and since an incomplete history can only
UNDERSTATE clustering, the weaker of the two gates fired on every candidate.

## Exit policies

```
FIXED_15M_CONTROL                 the frozen horizon
FLOW_LIQUIDITY_DETERIORATION_V1   first deterioration trigger -> first LATER valid fill
```

Both run over one shared mark path.

### The challenger fills LATER than it triggers

A deterioration is detected BY a mark. Pricing the exit at that same mark books
it at the one observation the strategy demonstrably could not have traded at — it
did not know until the mark existed. That flatters the challenger by exactly the
move that triggered it, which is the move most likely to be adverse.

```
triggeredAtMs   when the rule FIRED
filledAtMs      the first LATER mark carrying a tradable price
```

The control's trigger and fill coincide, because a preregistered horizon is a
clock it can stand ready at. That asymmetry is what makes the comparison fair
rather than rigged.

`filledAtMs = null` means the rule fired and no later mark carried a price: a
**blocked exit**, not a fill at the trigger.

### And the grid had to change

On the old 1/5/15/30/60 grid the challenger needed two measured marks to see a
drop, so its earliest trigger was 5m — and the first mark after 5m was 15m, the
control's own horizon. **It could never exit before the control, on any path,
whatever the market did.**

That is the audit's N-1, and the cause was the measurement grid, not the policy.
3m and 10m horizons were added; recorded as MT045, availability-driven, before
any outcome existed under the current contract. With heavy-tailed returns,
"exiting early is the error" is the half of the hypothesis most worth testing,
and the grid had made it untestable.

## Paired outcomes

All applicable `entry_policy × exit_policy` outcomes are stored for the same
trajectory. This is a **paired policy comparison**, not six disjoint candidate
samples.

## Checking it

```
pnpm policy:treatments-status
```

reports decisions per policy, how many trajectories carry all three, **how many
trajectories the policies DISAGREE on** — three policies that never disagree are
one policy with three names — whether any risk fact changed a decision, and
whether the challenger has ever exited earlier than the control.
