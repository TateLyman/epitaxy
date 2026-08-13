# Effect window invalidation at 5b89953

P1. Every context through the final repair commit of this session is **development
of the instrument**. Rows are preserved. None of them can estimate strategy
expectancy.

## The window

| | |
|---|---|
| source commits | `2617bb7` … `5b89953`, and this session's repair commits |
| corpus at close | 29,844 observations, 136 simulation jobs |
| `INSTRUMENT_DEVELOPMENT` jobs | 116 |
| `VALID_DEVELOPMENT` jobs | 20 |
| effect-verified jobs | **0** |
| confirmatory trades | **0** |
| shadows | 1,083+, all `STRUCTURAL_ONLY` |
| marks | 603, all `ORDER_QUOTE_BENCHMARK`, none decision-bearing |
| portfolio positions holding tokens | 0 |

## Why the window cannot estimate expectancy

Four reasons, each independently sufficient.

**1. The token-balance identity mismatch.** The daemon serialised token balances
keyed by token-account pubkey; the effect verifier looked them up by
`owner:mint`. The lookup could never match, so every token delta read as
unobserved. All 20 `VALID_DEVELOPMENT` jobs are `EFFECT_REFUSED`, and eleven of
them had a runtime that succeeded. Those eleven are not eleven trades that
delivered nothing — they are eleven trades nobody could see.

**2. The taker's ATA was outside the watch window.** `MAX_WATCHED_ACCOUNTS` was
64 with an unordered slice. On a Pump route the account the trade exists to
credit fell past the cut, so its balance was never read on either side.

**3. Mint accounts decoded as token accounts.** Until corrected, the structured
output carried phantom balances attributed to addresses that do not exist.

**4. Native-SOL sell output measured through a token-shaped bound.** A
token→SOL sell's output is lamports; the request carried one generic
`mint + minTokenDelta` for both directions. No sell in this window has a
verifiable economic effect.

## What was NOT selected from this window

No threshold, score weight, exit policy, cohort, route family or model was
chosen or tuned on any of it. The score's weights are unchanged. The risk
policy is unchanged. Where arithmetic defects were repaired — soft-risk
dilution, the gross-buys substitution, the two loss models — the changes are
recorded in `docs/MULTIPLE_TESTING_LEDGER.csv` as defects rather than
calibrations, and none of them moved a threshold value.

## Rows are kept

Nothing is deleted or rewritten. The 116 `INSTRUMENT_DEVELOPMENT` jobs and the
20 `EFFECT_REFUSED` ones are the only proof the corpus was ever wrong, and the
legacy `pre_token_balances` / `post_token_balances` columns are retained
alongside the structured replacements for the same reason: they are the evidence
of what the daemon actually sent while the defect was live.

## The next window

Does not start until P2–P9 pass. As of this document, P6 reports 1 of 10
effect-verified and 3 instrument failures, so it has not started.
