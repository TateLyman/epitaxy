# Development window V1 — the preregistration

**Directive section:** P14
**Written:** 2026-08-16, **before** the window opens.
**Status:** `NOT STARTED — blocked on the RPC daily quota.`

This document exists to be written first. A window whose parameters are recorded
after its outcomes is not a preregistration; it is a description.

## The blocker, stated plainly

The window cannot start today. The RPC endpoint returns:

```
HTTP 429  {"code":-32003,"message":"daily request limit reached
                                    - upgrade your account"}
```

That is the **daily allowance**, not a per-second rate limit, so backing off does
not help — every retry today fails. `pnpm rate:budget-v2` names it as the binding
constraint on observed evidence rather than on a modelled ratio, and the
collector stops a pass rather than grinding out apparatus refusals whose
histogram would read as a chain with no canonical pools.

Start the window when the quota resets, or after moving to a plan with headroom.
Nothing in this repository purchases anything.

## What is frozen

Changing any of these **inside** the window invalidates it. That is the point of
listing them.

| dimension | value | where |
| --- | --- | --- |
| notional | 20,000,000 lamports (0.02 SOL) | `NOTIONAL_LAMPORTS` |
| slippage | 3% | `openTrajectory` |
| venue | canonical PumpSwap, direct, both legs | `buildBuyFrom` / `buildSellFrom` |
| entry policy | `HARD_GATES_RANDOM` | collector |
| exit policies | `FIXED_15M_CONTROL`, `FLOW_LIQUIDITY_DETERIORATION_V1` | `evaluateExitPolicies` |
| mark horizons | 1m, 5m, 15m, 30m, 60m | `MARK_OFFSETS_MS` |
| max entity-adjusted holder share | 0.50 | `DEVELOPMENT_LIMITS` |
| max raw top-holder share | 0.80 | `DEVELOPMENT_LIMITS` |
| Mayhem | admitted, stratified | `DEVELOPMENT_LIMITS` |
| unmeasured transfer fee | refused | `DEVELOPMENT_LIMITS` |
| CU margin | 20%, floor 10,000 units | `FROZEN_CU_MARGIN_PCT` |
| fill latency | `FROZEN_FILL_LATENCY_MS` | `resolveFill` |

Every threshold above is recorded in `docs/MULTIPLE_TESTING_LEDGER.csv` with the
sample it was chosen on — which for MT035–MT037 is **no sample at all**. All
three are availability-driven: they were set because a measurement is
unaffordable or a formula implies them, not because returns improved. None spends
alpha, and none may be revised on outcomes without a hold-out.

## The command

```bash
pnpm trajectory:collect --interval=300 --max-candidates=8 --max-open=3
```

The daemon's state lives entirely in the database, so a restart resumes open
trajectories and takes whatever marks are due. Marks that come due during an
outage are recorded with a large `lateness_ms` and are **backfilled, not timely**
— the schema distinguishes them and `pnpm readiness` counts only timely paths.

## The stratum, and why nothing is pooled

```
CANONICAL / CASHBACK? / MAYHEM? / FEE-KIND / SETUP / CONCENTRATION-TIER
```

Six dimensions, each of which changes the economics materially. A cashback coin
in Mayhem mode is a different regime from a plain non-cashback coin, and
averaging them describes neither.

Two of these carry an admission of what was *not* measured:

- `CONCENTRATION_RAW_ONLY` — clustering was judged on balances alone, because
  walking every top holder's signature history exceeds the RPC allowance.
- `COLD_SETUP` / `SETUP_UNKNOWN` — whether the entry had to open accounts another
  trader's organic transaction would have opened anyway.

Neither may be pooled with its measured counterpart. A cell identity that hides
which tier decided is a cell that cannot be interpreted later.

## Checkpoints

| paths per cell | what becomes permitted |
| --- | --- |
| 10 | apparatus sanity only |
| 25 | cost and fillability sanity |
| 50 | early elimination of a policy |
| 100 per policy-cohort | development selection |

**No model may be fitted before 100 complete valid paths and an untouched
validation split.** `tests/unit/score-frozen.test.ts` asserts the precondition is
still unmet, so a model appearing in the tree early is a test failure rather than
a discovery.

## What is collected regardless of outcome

Refusals are the product. Every examined candidate writes a
`candidate_risk_facts` row whether admitted or refused, with **every** failing
reason rather than the first — collapsing six facts into one word is how 93% of a
previous corpus became uninformative.

Apparatus failures are named apart from market facts throughout. An exhausted
quota, an unreadable pool and a pool that genuinely is not canonical are three
different rows, and only the last is evidence about a token.

## What ends the window

Any of:

- a threshold in the frozen table is changed;
- the collector's source commit changes in a way that touches the entry or exit
  path;
- the RPC provider or endpoint changes, since latency and freshness are part of
  the instrument;
- a defect is found that invalidates already-collected paths.

The last has happened repeatedly in this repository's history and each time the
affected corpus was invalidated in writing rather than quietly re-labelled. See
`docs/*_WINDOW_INVALIDATION.md`.

## What this window cannot produce

It cannot produce `CANARY_READY`. A positive development shadow is not a canary;
`CANARY_READY` requires an untouched passing confirmatory window and a real safe
canary execution path, and running one is a human act that
`.claude/hooks/guard.mjs` blocks the assistant from taking.

Nothing in this window is funded, signed or submitted. Every leg executes in an
isolated local runtime against exact captured mainnet state.
