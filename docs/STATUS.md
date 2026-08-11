# STATUS

Last updated: 2026-08-11T22:05Z

## Current state

**Observe mode is built and has been run against live mainnet data.** No position
has ever been opened, no key exists, no transaction has ever been signed or sent.

| Phase | State |
| --- | --- |
| 0 — environment audit | done |
| 1 — current-source verification | done |
| 2 — observe-mode vertical slice | **done, running** |
| 3 — paper mode | in progress |
| 4 — replay / backtest / report | not started |
| 5 — executor (canary/live) | not started, gated off |

## What actually ran

Live run 2026-08-11T21:59–22:02Z, keyless Jupiter, mainnet:

```
candidates discovered   717
screenings persisted   1861
round-trip quotes         4  (2 full round trips)
eligible candidates       1
```

Nothing about that run was simulated. Numbers below are measured, not modelled.

## Measured economics

The single most important number in this system is what a full in-and-out costs
before any thesis is applied.

| Token | Age at quote | Liquidity | Probe | Round-trip loss |
| --- | --- | --- | --- | --- |
| `6rme4sMM…pump` | seconds | ~$3k | 0.05 SOL | **298 bps** |
| `5ziigNJ8…pump` (POIPOI) | 52 min | $16k | 0.05 SOL | **134 bps / 255 bps** (two samples, 3 min apart) |

Both were routed `metis` → `Pump.fun Amm`. This is the empirical case for the
delayed-momentum thesis: waiting costs optionality but roughly halves the cost
floor. Neither figure includes priority fees, ATA rent, or failed transactions.

## Findings that changed the design

**1. The discovery feed and the strategy do not intersect.**
`/tokens/v2/recent` contains only tokens whose first pool was just created. The
strategy refuses anything under 2 minutes old. Screening the recent feed
directly produced 90/90 `too_young` rejections — a filter that can never pass.
Fixed by adding a maturation queue (`maturingMints`) that re-fetches banked
mints once they age into the window, via `search` (100 mints per request).

**2. `organicScore` is 0 for every token under ~1 hour old.**
n=461, zero exceptions. Jupiter has not computed reputation that early. As a
hard veto this silently rejected 100% of the strategy's own window. Absence of a
provider's score is a data-availability fact, not evidence about the token, so
it is now a **soft risk (0.25)**; a score that *has* been computed and is low
remains a hard veto.

**3. The maturation queue must round-robin, not sort by age.**
Ordering by age pinned the queue to the youngest 100 in-window mints, so nothing
older than ~5 minutes was ever re-examined. Reordered to least-recently-screened
first. The first eligible candidate appeared one cycle later.

**4. Jupiter's new-token fee does not match its documentation.**
Docs state 50 bps for tokens under 24h. Every live quote measured returned
`feeBps: 10`. Unresolved — see RESEARCH.md. Config models **50 bps** anyway
(`assumedNewTokenFeeBps`), because being wrong in the expensive direction is
survivable and being wrong in the cheap direction is not.

## Rejection breakdown (n=1861 screenings)

```
insufficient_liquidity       1838
too_few_holders              1748
dev_holds_too_much           1559
insufficient_net_buyers      1522
insufficient_flow            1351
concentrated_ownership        733
low_organic_score             461   (pre-fix; no longer a hard veto)
too_young                      90
stale_source                   69
provider_flagged_suspicious    31
excessive_impact                1
```

Base rate of eligibility is roughly **1 in 1800 screenings**. That is the
headline result of observe mode so far and it is deliberately not "fixed" by
loosening gates: every reject is stored with its state at reject time
(`reject_tracking`) so a later pass can measure what each filter cost us.

## Safety posture

- `MODE` defaults to `observe`. `config/observe.json` is the only committed config.
- No keypair file exists; `TRADING_KEYPAIR_PATH` is unset.
- Quotes are requested **without `taker`**, so Jupiter cannot return a signable
  transaction to a process running in observe or paper mode.
- Cross-process lock (`process_locks`) prevents a second collector from running.
- All external strings (token name, symbol, launchpad) are stripped of control
  characters and bidi overrides before they touch a log line or the database.

## Next

1. Paper engine: position lifecycle against live executable quotes.
2. `pnpm doctor` / `status` / `health` / `kill`.
3. Replay determinism harness over stored snapshots.
4. Remaining docs and the failure register.
