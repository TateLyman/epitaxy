# TARGETED_FLOW_V1

Module: `packages/intelligence/src/targeted-flow.ts`

## The firehose is not coming back

The previous build subscribed to the Pump and PumpSwap **programs**. Measured over
a 256-second window on 2026-08-16: **219 messages per second**, roughly 18.9m per
day, to catch migrations arriving a few dozen times an hour. It exhausted both
endpoints' credits producing data about tokens nobody was considering.

`logsSubscribe` has no server-side filter finer than "mentions this program", so
that outcome was structural rather than a tuning error.

## What replaces it

**Preferred — Helius Enhanced WebSockets.** One `transactionSubscribe` whose
`accountInclude` contains only the pools and vaults currently under observation.
Helius currently accepts up to 50,000 addresses, which is far more than this
apparatus will ever have open at once.

`buildAccountInclude()` **refuses** to include a program id. That is enforced in
code rather than remembered, because it is a one-line difference between a
candidate subscription and the firehose, and the failure is expensive and silent.

**Fallback — no Enhanced WebSockets.** `getSignaturesForAddress(pool)` at the two
entry clocks only, for mechanically viable candidates only. Never a poll over every
token on the chain.

## Bars

`0–30s`, `30–60s`, `60–120s`, `120–180s`, `180–300s`, all relative to the migration
instant. Each carries unique buyer/seller **entities**, buy/sell/net quote volume,
creator flow, Mayhem flow, trade count, and a coverage verdict.

Entities rather than wallets: twenty wallets funded by one address is one buyer
wearing twenty hats, and counting it as twenty is exactly the measurement error
that makes a coordinated launch look like organic demand.

## The four rules that make a bar mean something

1. **Dedupe by `(signature, eventIndex)`.** A reconnect replays, a subscription
   rebuild replays, a fallback poll overlaps the stream. Two swaps in one
   transaction remain two events; the same swap twice is one.
2. **A failed transaction is not flow.** It is observed activity and zero value.
   Counting it inflates precisely the moments that matter most, because failed
   transactions cluster where liquidity is thinnest.
3. **`processed` is telemetry; `confirmed` is evidence.** A processed notification
   can be rolled back. `reconcileToConfirmed()` exists so that reconciliation can
   *remove* an event that was already counted.
4. **A gap is persisted, not smoothed.** Any overlap between a stream gap and a bar
   makes that bar `INCOMPLETE`, and every quantity in it becomes `null` — never
   zero, which would read as "nobody traded".

A bar the observation window has not reached yet is `ABSENT`, which is a third
state again: not observed is not the same as observed-and-empty.

## Coverage states

| state | meaning | quantities |
|---|---|---|
| `COMPLETE` | fully observed, no gaps | measured |
| `INCOMPLETE` | a gap overlaps the bar | all `null` |
| `ABSENT` | the window had not reached this bar | all `null` |

## Current status

`pnpm flow:coverage` reports `NOT_RUN` until a targeted subscription or the
fallback poll has run. Until then every post-migration flow field is null, and
`SURVIVOR_FLOW_CONTINUATION_V1` is `NOT_EVALUABLE` at T120 by construction — which
`pnpm policy:coverage` states rather than hiding behind a REJECT.

## Commands

```bash
pnpm flow:status     # gaps and live state
pnpm flow:coverage   # bar-level coverage -> artifacts/flow-coverage.json
```
