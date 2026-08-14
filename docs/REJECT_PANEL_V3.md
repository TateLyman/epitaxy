# The reject panel, v3

`packages/research/src/reject-panel.ts` · `pnpm reject:panel-v2`
→ `artifacts/reject-panel-v2.json`

## Why the previous panel could not answer its own question

It evaluated historical rejections against **current** state.

A token rejected a week ago and now worthless looks like a correct rejection
whether or not it tripled first. A token rejected and now up 10× looks like a
false negative even if it was unsellable throughout. Both readings come from
looking at the end of the path instead of the path.

## What v3 does instead

Sample **at rejection time**, at a preregistered inclusion probability, and
follow the trajectory forward like any other. Classify later, from evidence
collected in between.

Persisted at sampling time: the decision snapshot, all pre-entry facts, the
inclusion probability, the coherent market state, the direct mechanics, and
provider health. Then: the future mark trajectory, later fillability, and
fixed-horizon executable outcomes.

Sampling is deterministic in `(seed, mint, rejectionTime)`. The rejection
timestamp is in the key so a token rejected twice gets two independent draws —
repeated rejections do not systematically appear or vanish together.

## Classification, in order

```
PROFITABLE_EXECUTABLE · UNPROFITABLE_EXECUTABLE · CATASTROPHIC · BLOCKED_EXIT
NO_SUPPORTED_VENUE · PROVIDER_GAP · APPARATUS_FAILURE · UNKNOWN
```

**Order matters.** Apparatus and provider failures are checked **first**, before
any market outcome. A trajectory that failed for our reasons must never be
recorded as a market fact — that substitution is how an instrument's own failure
rate becomes evidence about a strategy. The test asserts this with a case that
shows a spectacular apparent profit and still classifies as
`APPARATUS_FAILURE`.

`CATASTROPHIC` is separated from ordinary losses because it governs risk sizing,
and pooling it hides the tail that matters most.

## "No route" was the wrong label

`NO_SUPPORTED_VENUE` is a fact about **the venues we support**, not about the
token.

Measured on the corpus, ~98% of screened mints have no canonical PumpSwap pool.
Under the old "no route" label almost the entire reject panel said *the market
refused* when it meant *we support one venue*.

## The false-negative denominator

Apparatus failures, provider gaps, unsupported venues and unknowns are
**excluded** from the denominator — not counted as correct rejections.

They are rows where the question was never asked. Putting them in the denominator
makes a gate look better the more often the instrument breaks.

## Do not tune and report on the same panel

`assertPanelNotReused` throws when a gate tuned on panel version N is scored on
version N. A gate scored on the data that shaped it measures memory, not skill.

## Current standing

**No prospective sample has been collected.** The artifact reports the rate as
`null` rather than zero, and carries the legacy retrospective counts explicitly
marked as *not comparable* — they were evaluated against current state rather
than against the path, which is the defect this version exists to remove.
