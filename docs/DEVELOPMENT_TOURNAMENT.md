# Development tournament — preregistration

**Written before the first trajectory. Nothing here has been changed after
seeing a result, and a change to any of it is a decision that belongs in
`docs/MULTIPLE_TESTING_LEDGER.csv`.**

Source of truth: `packages/domain/src/tournament.ts`. Fixed in place by
`tests/unit/tournament-p19.test.ts`, so a later edit is a visible act rather
than a quiet adjustment made while looking at a number.

## Status

**Not running.** Zero valid trajectories exist and the first checkpoint is ten
per arm. What is wired is the **allocation**: every trajectory is assigned an
arm as it opens.

That distinction matters. Labelling an existing corpus afterwards is how an arm
ends up holding the trajectories that happen to suit it.

## Arms

Three entry policies × two exit policies = six cells.

| entry | what it is |
|---|---|
| `HARD_GATES_RANDOM` | the floor — everything the hard gates admit, chosen at random among them |
| `CORRECTED_CURRENT_QUALITY_SCORE` | the current score, on corrected v0.6.0 semantics |
| `SURVIVOR_FLOW_CONTINUATION_V1` | continuation of survivor flow rather than a quality judgement |

| exit | what it is |
|---|---|
| `FIXED_TIME_CONTROL` | a control that cannot be tuned and cannot look ahead |
| `FLOW_DETERIORATION_V1` | exit on deteriorating flow or liquidity |

**No parameter grid.** Three distinct hypotheses, not one hypothesis tuned six
ways — a grid spends the alpha on the tuning rather than on the question.

`HARD_GATES_RANDOM` is the arm that matters most. If the score cannot beat
random-among-admitted, the score is not doing anything, and that is the cheapest
possible thing to learn.

## Allocation

Balanced across all six cells, deterministic given the counts already in the
corpus, and **blind to the candidate**. `allocateArm` takes exactly one
argument — the counts — so there is nowhere to pass a score, a liquidity or an
age. Allocating on any of those would measure each arm on a different
population, and the comparison would be between populations rather than
policies.

Read from the corpus rather than held in memory, so two processes and a restart
all see the same allocation state.

## Checkpoints, in completed valid trajectories per arm

| n | question |
|---|---|
| 10 | does the instrument work at all on this arm? Not a performance question |
| 25 | are the sizes, costs and fillability what the size surface predicted? |
| 50 | first point at which an arm may be **eliminated** |
| 100 | first point at which at most one arm may be **selected** |

An arm below 50 is not judged. `judgeArm` returns
`eligibleForElimination: false` and no reasons — including for an arm that is
deeply negative, because the temptation to move a checkpoint is strongest
exactly when it would help.

## Elimination at 50

Any one of these kills or deprioritises an arm:

| reason | threshold |
|---|---|
| `NET_NEGATIVE_AFTER_ALL_COSTS` | net ≤ 0 |
| `NEGATIVE_WITHOUT_TOP_THREE` | net ≤ 0 with the three largest winners removed |
| `CATASTROPHIC_INCIDENCE_UNACCEPTABLE` | > 5% of trajectories |
| `BLOCKED_EXIT_INCIDENCE_UNACCEPTABLE` | > 20% of exits |
| `MECHANICS_DRAG_CONSUMES_EDGE` | gross edge ≤ the measured mechanics floor |
| `VALID_LABEL_THROUGHPUT_TOO_LOW` | < 3 valid trajectories/day |
| `ONE_MINT_OR_DAY_CARRIES_RESULT` | > 50% of net from one mint, or one day |

`MECHANICS_DRAG_CONSUMES_EDGE` is measured against the size surface's own
number — **241.5 bps at the development notional**, from
`artifacts/true-stateful-size-surface.json`. An edge below the floor is a cost.

**The original 2m–60m thesis gets no protection.** That is enforced by there
being no branch that could give it any: `judgeArm` is a pure function of a
preregistered observation and does not know which arm it is judging.

## Objective

Primary: **robust expected log growth per capital-hour.**

Secondary: CVaR, catastrophic incidence, blocked-exit incidence, tail/day/mint
concentration.

**Not win rate.** Win rate is maximised by never cutting a loser. **Not total
PnL** either — that is maximised by whichever arm happened to catch the biggest
mint, which is the thing `ONE_MINT_OR_DAY_CARRIES_RESULT` exists to detect.

## What has to be true before this can start

1. **Valid trajectories.** The shadow lifecycle now triggers and awaits a fill
   (P6); no trajectory has yet completed through it. Every one of the 1,038
   closed before that is void — see
   `docs/SHADOW_TRIGGER_FILL_INVALIDATION.md`.
2. **Throughput.** At 3 valid trajectories/day/arm and 6 arms, the 50-trajectory
   checkpoint is ~17 days of collection. The measured mark-scheduler backlog is
   an open blocker on that.
3. **A clean context.** The directive requires a fresh development context, and
   the corpus currently spans five strategy versions.

## After selection

At 100+, at most **one primary arm and one challenger** may be selected, and
they go to an untouched confirmatory window (P22) whose parameters freeze before
its first outcome. Nothing about the confirmatory window may be chosen after
seeing a confirmatory result.
