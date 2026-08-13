# Window invalidation at 4890af0

§1 of the profitability-truth directive. Everything collected from the previous
invalidation through the final repair commit of this session is **development
data**. It is not deleted and not relabelled; its contexts are closed and it may
not be used as confirmatory evidence or to rank policies.

## What the window contained

Read from the runtime database at `2026-08-13T03:14:08Z`, before any semantic
change landed. Backup `data/backups/audit-2026-08-13T03-14-08-327Z.db`,
sha256 `11c7e00e4c5493387e7187a7fdff1ea1efaa937e6720e8c53f8cdbdfb815a074`,
`integrity_check ok`, 0 foreign-key violations, staleness bounded
`screenings 249295 ≤ 249295 ≤ 249395`.

```
execution_observations   6701   all BUILD_CUSTOM, all NOT_SIMULATED
signal_episodes           122
positions                  20   all POSITION_CLOSED
shadow_positions          253   179 open (90 alpha, 89 canary)
fills                      40   all simulated
run_contexts                9
simulation_jobs           TABLE ABSENT
reject_tracking       467993
screenings             249295
```

Source SHA at capture: `4890af0ea4686152d987ea62a3d41727d5476886`, matching the
audited HEAD exactly. Schema at migration **11** against code at **12** — the
live engine predated `simulation_jobs` entirely.

## Why none of it can be confirmatory

Each of these is sufficient on its own.

**Nothing was simulated.** 0 of 6,701 observations. `simulation` is
`NOT_SIMULATED` on every row, and the reason attached to them was itself stale.

**Every cost was wrong in the same direction.** `assumedPriorityFeeLamports` was
200,000 against a measured 3,018–3,564 — a 56× overstatement carrying a phantom
99 bps per leg and 198 bps per round trip at the 0.02 SOL size. Every PnL number,
every viability check and every size-surface row in the window used it.

**The shadow books were censored.** `openShadowBooks` ran only in the portfolio
refusal branch, so both books contained exactly the signals the portfolio had
*rejected*. Comparing them to portfolio results compared the trades we turned
down against the trades we took.

**Multi-table transactions named the wrong accounts.** The encoder built its
loaded-address order from instruction meta arrival; the runtime groups by table.
Any observation whose route used two or more lookup tables was assembled against
accounts other than the intended ones. It still encoded, still passed the packet
check, and still looked like a swap.

**Exposure omitted two states.** `EXIT_BLOCKED` and `RECONCILING` hold tokens and
were excluded from exposure and locked rent, so capital behind a position that
could not be sold was reported as free.

**Missing build fields became zeros.** An absent `otherAmountThreshold` became a
minimum output of 0 — a transaction accepting any fill at all, indistinguishable
on the stored row from a route with generous slippage.

**The exact bytes were never kept.** Only hashes. A row could prove a
transaction had not changed and could not produce it, so nothing in the window
can be re-simulated against what was actually policy-checked.

**Provenance was incomplete.** `strategyConfigHash` covered 16 of 31 config
fields. Windows running under different shadow notionals, catastrophic floors,
latency stress or route families reported identical provenance.

## What survives

The **structural** observations remain useful as development data: route
buildability, provider behaviour, screening rejections, episode identity, and
the eight collapse events. They describe what the providers and the market did,
and none of the defects above changes that.

The **economic** conclusions do not survive. In particular, the previously
reported "the strategy cannot size a viable trade at the committed NAV, ~11.4
SOL required" was computed with the 200,000-lamport phantom and is withdrawn.
With the corrected fee the minimum viable NAV at 0.02 SOL is about 2.05 SOL.
That is a correction to a measurement error and says nothing whatever about
whether the strategy is profitable.

## Rules for the closed window

- Its rows may not be pooled with anything collected after the repairs. The
  `dataRegimeId` now includes `requireLocalSimulation`, `requireExactSizeBuild`,
  `primaryRouteFamily` and the cost-accounting version, so pooling is refused
  mechanically rather than by convention.
- No policy is ranked on it.
- No threshold is tuned on it.
- It is not deleted. A corpus that recorded a defect is the only evidence the
  defect existed.
