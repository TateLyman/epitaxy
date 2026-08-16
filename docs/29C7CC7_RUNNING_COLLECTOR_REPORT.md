# Running-collector directive `29c7cc7` — final report

**Terminal state:** `MEASUREMENT_REPAIR_REQUIRED`

**Starting SHA:** `4ec715f` (local `master`, equal to `origin/master`)
**Ending SHA:** `a2ce674` — nine commits ahead, not pushed
**Date:** 2026-08-16

---

## 1. Why the state is not `VALID_TRAJECTORY_KERNEL_RUNNING`

The directive's own definition requires an **actual `pnpm trajectory:collect`
process** to carry a current confirmed candidate all the way to an append-only
database trajectory that a current clean report reads.

Every stage of that loop now exists and runs. Two things stop the claim:

1. **Both RPC endpoints are exhausted.** The primary returns `daily request
   limit reached`; the fallback returns `max usage reached`. No candidate can be
   read, so no trajectory has been opened since the wiring landed, so the
   loop has not been demonstrated end to end **on this build**.
2. **The sample is 8 timely complete paths.** The threshold is 200, over 21
   distinct UTC days. There are 2.

Either alone is sufficient to withhold the claim. Both are true.

## 2. Local versus remote

`origin/master` is at `4ec715f`. Local `master` is nine commits ahead and
**unpushed**. Nothing was pushed; opening a PR was not requested.

## 3. Backup proof

Taken before schema 39 → 42, by `pnpm db:migrate`:

```
path       data/runtime.db.backup-2026-08-16T19-10-39-106Z
bytes      7,024,992,256
sha256     1c331d911e909c0b78fbc930dd2f0248d66593415db2c001ddd8ada66319d305
integrity  ok
foreign keys 0 violations
witness    execution_observations: 43,096 rows, within [43,096, 43,096] on source
elapsed    180,031 ms
```

Migration 43 followed. Live schema is **v43**.

## 4. Invalid claims corrected

| claim | correction |
| --- | --- |
| "`sell` has no volume accumulator in the pump_amm IDL" | It has two, as optional positional remaining accounts. The claim read the IDL's NAMED accounts. Modelling one leg's creator-fee recovery instead of two understated the retained round trip by roughly half. |
| tier classified from raw quote reserve | The tier is a function of MARKET CAP (`quoteReserve × supply / baseReserve`). Every call site passed the wrong axis; one passed a hardcoded `0n`. |
| `tierFor` returns null below the first threshold | The program charges the FIRST tier there — the case for the pools this system samples most. |
| `entityAdjustedConcentration([])` → `MEASURED share 0` | An empty history list is `HISTORY_INCOMPLETE`. Vacuous truth over an empty collection reported unmeasured clustering as measured-and-safe. |
| `claimIsWorthwhile` amortised over N | It computed N and used it only in the reason string. Every caller charged the full claim to one trajectory. |
| call graph: `manageShadowBooks → admitPortfolioExit` reached | The artifact was stale (generated at `0fdc24e`). Regenerating at `4ec715f`, before any of this work, showed it already unreachable. |
| STATUS.md schema v36 | v43. The document was stale by three directives. |

## 5. The collector's production call path

```
live create_pool log (processed)  →  fetch tx at CONFIRMED  →  decode by
official discriminator  →  reconcile  →  candidate queue
  →  risk facts collected and STAMPED  →  admission gate, refusals stored
  →  coherent snapshot v2  →  exact direct PumpSwap buy, plan FROZEN
  →  cashback tail verified fail-closed  →  ONE persistent runtime
  →  buy  →  observe  →  sell built from the committed post-buy state
  →  base ATA close appended to the sell  →  created accounts classified
  →  append-only trajectory + both leg plans + per-leg cashback
  →  shared mark path 1m/5m/15m/30m/60m, urgent queue drained first
  →  both exit policies on the SAME path  →  append-only outcomes  →  close
```

Asserted behaviourally, not by grepping source:
`collector-wiring-29c7cc7`, `live-lane-p8-p13`, `candidate-risk-p10`,
`cashback-both-legs-p7`, `created-accounts-p6`, `prewarm-cu-p6`,
`sequential-round-trip-p3`, `account-plan-p2`.

## 6. Direct entry attribution

`ENTRY_NOT_SOLE_VENUE` unless `pool base out == taker credit` and quote in > 0.
A split or routed entry moves the base vault too, so showing it changed proves
nothing about the venue.

## 7–9. Snapshot, worker, output scaling

Unchanged from the previous head and still holding: coherent snapshot v2 with
exact Clock/Rent/EpochSchedule restored; u64 as decimal strings across NDJSON;
`known` and job accounting reset on `Init`; scoped output where withheld bytes
REFUSE rather than reading as zero.

## 10–11. Cold/warm economics and created accounts

`created_accounts` (migration 40) stores every account a leg brought into
existence with its economic scope, recoverability and whether another trader
would have opened it anyway. `swapAccountRoles` names the accounts that
previously all fell to `UNKNOWN`.

The three surfaces are **built and not run** — `pnpm size:cold-warm-surface`
needs live RPC. `created_accounts` has **0 rows**, because no trajectory has
opened since migration 40 landed.

**No cold/warm number is claimed.**

## 12–13. Cashback and fee tier

Placement is verified fail-closed on both legs against the frozen plan, before
either executes. `leg_cashback` (migration 41) stores per-leg deltas, never
summed on the way in.

**0 rows.** Cashback is verified structurally and has **not** been observed
accruing. The bps hypotheses in `docs/PUMPSWAP_CASHBACK_V2.md` remain
hypotheses.

## 14. Canonical settlement identity

`pnpm settlement:check` reports 0 effect-verified legs in the window. Settlement
identity is unchanged and unexercised by new data.

## 15. Database trajectory trace

```
development_trajectories     64   (59 SETTLED, 5 AWAITING_FILL_OBSERVATION)
trajectory_marks            320
trajectory_policy_outcomes  118   two policies over one shared path
leg_account_plans            26
candidate_risk_facts         26   3 admitted
confirmed_migrations         47
collector_sessions           10
created_accounts              0
leg_cashback                  0
```

Capital-bearing tables are untouched by this work: `positions` 20, `fills` 40,
`ledger_entries` 1,574 — all pre-existing paper-engine rows. The collector
imports no signer and refuses to start in canary or live.

## 16–17. Mark path and paired outcomes

One shared path per candidate; both exit policies evaluated on it, so paired
outcomes differ only by policy. 8 of 59 settled paths are **timely**; the rest
are backfilled and are counted as such.

Gross delta over 58 control outcomes: **−498,037,551 lamports**.
**This is not a strategy result.** It is gross, it is mostly backfilled, and net
is UNKNOWN.

## 18. Counterfactual class

Everything collected is bounded-uncalibrated. Full replay has not been built, so
no bounded outcome may be called confirmatory.
See `docs/FUTURE_COUNTERFACTUAL_CALIBRATION.md`.

## 19. WSS and risk-fact coverage

Live socket subscribed and delivering (2 events in the first 10 seconds after
the provider fix). Subscriptions, gaps, resyncs and urgent-queue consumption are
persisted and read by `pnpm wss:status`. Risk facts reach the gate and refuse.

## 20. Completed trajectories by cell

```
23  NONCANONICAL/…                                          0 admitted
 2  CANONICAL/NONCASHBACK/MAYHEM/LEGACY_FEE/…/RAW_ONLY      2 admitted
 1  CANONICAL/CASHBACK/NONMAYHEM/LEGACY_FEE/…/RAW_ONLY      1 admitted
```

No cell is near the 100-path checkpoint.

## 21–22. Bottleneck and infrastructure

**Binding constraint, measured:** `solana_rpc:getAccountInfo` — the daily quota
is exhausted on both endpoints. An observed quota error outranks a modelled
ratio here: the endpoint sat at **0.9% of its 10/s limit** while refusing every
call, so "rate capacity is not the constraint" was true and useless.

Duty cycle 40.4% over 10 sessions.

`pnpm rate:budget-v2` marks **helius_developer ALLOWED** on that evidence and
refuses everything else, including Jupiter Developer (not the binding resource)
and shreds/colocation/dedicated nodes (forbidden before a positive untouched
edge — faster access to a losing strategy loses faster).

**Nothing was purchased. This code cannot purchase anything.**

## 23. Unresolved blockers

1. **Both RPC endpoints exhausted.** Blocks the window and three artifacts.
2. `artifacts/cold-warm-size-surface.json`, `cashback-both-legs.json`,
   `account-plan-proof.json` — not produced; all need live RPC.
3. `created_accounts` and `leg_cashback` are empty; both were wired after the
   last trajectory opened.
4. Net PnL is UNKNOWN — no canonical settlement per trajectory yet.
5. Full event replay is not built, so no counterfactual is calibrated.
6. `landed:parity-v2`, `reject:panel-v2`, `exploration:status` still refuse and
   exit non-zero, with their exact prerequisites named. `landed:parity-v2`
   cannot be built without a canary, which is a human act.
7. Entity-adjusted concentration is not walked; the raw tier decides and every
   admitted candidate is stratified `CONCENTRATION_RAW_ONLY`.

## 24. Collection commands

```bash
pnpm trajectory:collect --interval=300 --max-candidates=8 --max-open=3
pnpm trajectory:status      # database rows only; proof artifacts count as zero
pnpm wss:status             # socket coverage, gaps, urgent queue
pnpm rate:budget-v2         # per ACTIVE second; names the binding constraint
pnpm readiness              # the exact trajectory contract; exits non-zero
pnpm size:cold-warm-surface # COLD / PREWARMED / REPEAT — needs RPC
```

## 25. Terminal state

```
MEASUREMENT_REPAIR_REQUIRED
```

The apparatus is repaired and the loop is wired. The measurement is not made:
no trajectory has opened on this build, two evidence tables are empty, and the
sample is 8 timely paths against 200.

`LIVE_READY` is forbidden and is not claimed. `CANARY_READY` is not claimed and
cannot be, since it requires a real canary. `DEVELOPMENT_EDGE_CANDIDATE` is not
claimed: no edge has been measured, only costs and refusals.
`STRATEGY_KILLED_BY_CORRECTED_ECONOMICS` is not claimed either — killing it on
this sample would be killing it on an apparatus reading.

Nothing here has been funded, signed or submitted. No key was read or created.
Every leg executed in an isolated local runtime against exact captured state.

---

### The pattern worth keeping

Five defects were found by **running** the system, not by reading it:

- a websocket pointed at a different provider than HTTP, which had never once
  connected;
- a daily quota reported as "this token has no canonical pool";
- an empty holder-history list reporting unmeasured clustering as measured;
- my own cashback tail model, wrong, and caught because the check refused
  instead of warning;
- a stale artifact holding a green check over a required edge that had been
  broken for several commits.

Each of these passed every test that existed. That is the directive's thesis,
demonstrated on this directive's own work.
