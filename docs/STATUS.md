# STATUS

Last updated: 2026-08-12T17:10Z

## Current state

**Observe mode is built and has been run against live mainnet data.** No position
has ever been opened, no key exists, no transaction has ever been signed or sent.

| Phase | State |
| --- | --- |
| 0 — environment audit | done |
| 1 — current-source verification | done |
| 2 — observe-mode vertical slice | **done, run against mainnet** |
| 3 — paper mode | **done, running** (strategy `v0.3.0`) |
| 3b — solana package (base58, mint/Token-2022, tx policy) | done, 32 unit tests on real mainnet fixtures |
| 3c — operational commands (`doctor`/`status`/`health`/`kill`/`secretscan`/`check`) | done |
| 4 — replay / backtest / report | **done**; replay verified 2,200 snapshots, 0 divergence |
| 5 — executor (signer, binding, effect, state machine, gates) | **built**, gated off by measurement |

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

**5. Missing provider data was hard-vetoing 100% of the target population.**
This is the same bug class as finding #2, found twice more. Measured over 3,561
screenings: `devBalancePercentage` was **null for 81%** of tokens and
`topHoldersPercentage` null for 21% — yet both were wired as hard vetoes, so a
field the provider simply had not computed was recorded as evidence against the
token. Of the 33 candidates that cleared liquidity, 31 died on
`dev_holds_too_much` while `devBalancePct` was null.

The rule now applied uniformly across all three cases: **absence of a provider
field is a fact about the provider, not about the token.** Present-and-bad is a
hard veto; absent is graded soft risk (`dev_balance_unavailable` 0.2,
`top_holders_unavailable` 0.15).

Provider `topHoldersPercentage` was additionally demoted to soft risk outright,
because it counts the liquidity pool as a holder. A bonding curve holding most
of supply is the counterparty we trade against, not a whale waiting to dump.

Measured effect after the fix (strategy `v0.2.0`, n=200): `dev_holds_too_much`
fell from **83% of screenings to 4%**, and the cheap layer began promoting
candidates to the quote stage again (`cheapPassed` 0 → 1 per cycle).

A hypothesis I held here was wrong and the measurement killed it: I expected
`topHoldersPercentage` to be uniformly ~89% because of pool inventory. The
distribution is actually median 3.55% / p75 22.7%, with only 41/3,561 in the
85–95% band. The ~89% figure applies only to the liquidity-passing subset.

**6. Authoritative holder concentration replaced the provider figure — and needs a keyed RPC.**
`fetchConcentration` (packages/solana/src/rpc.ts) measures concentration on-chain
and excludes program-controlled inventory *structurally*: a real wallet's token
account is owned by the System Program, whereas a pool authority is a PDA owned
by its AMM. This is a shape test, not a venue allowlist, so a new launchpad does
not silently defeat it. Accounts whose ownership cannot be resolved are counted
as program-controlled for the pool figure and excluded from the wallet figures,
so an unresolved account can never make concentration look *better* than it is.

`getTokenLargestAccounts` returns **HTTP 429 on `api.mainnet-beta.solana.com`
even on a first isolated call**, while `getTokenSupply`, `getMultipleAccounts`
and `getAccountInfo` all return 200. This is a per-method block, not our rate
budget. Consequence: the check reports *unavailable* on the public endpoint,
which is graded as soft risk (0.3) in observe/paper but is a **hard veto in
canary/live** — a mode that commits capital refuses an unmeasurable holder
distribution. A keyed RPC is therefore a hard prerequisite for canary/live, and
`pnpm doctor` probes this method explicitly so the limitation surfaces before
capital is at stake, not during.

**7. The account was too small to ever open a position — silently.**
Paper ran for hours opening nothing. That reads as "the strategy found nothing",
which is why it went unnoticed. The real cause was arithmetic: with a 2 SOL NAV
the largest position the risk caps could *ever* authorise was 0.02 SOL, while
the fee-viability floor was 0.0448 SOL. Every candidate, at every score up to
1.0, was refused with `size_below_viable`. The strategy was not selective; it
was disabled.

Two separate defects were tangled together here:

- *The cost model was wrong.* The floor charged full ATA rent (2,039,280
  lamports) as a sunk fee. Rent is **refunded when the token account is closed**,
  so on a successful exit it is a temporary lockup, not a cost. It is only truly
  lost when the position cannot be sold at all, because an account holding a
  nonzero balance cannot be closed. Now modelled as
  `2×(signature + priority) + rent×(1 − recoveryRate)` with `recoveryRate` an
  explicit, measurable assumption (currently 0.5) rather than an implicit 0.
  Non-recoverable round-trip cost: **0.00143 SOL**. Floor at 5% of notional:
  **0.0286 SOL**, down from 0.0448.
- *The capital was genuinely insufficient.* Even corrected, 2 SOL cannot clear
  the floor. Minimum viable NAV is ~2.9 SOL at a perfect score and ~5.7 SOL at a
  typical one. Paper NAV raised to 10 SOL, which is the honest statement that
  **this strategy has a minimum capital requirement**, not a preference.

`pnpm doctor` now fails on `config.viableCapital` when the largest permitted
position sits below the floor, so this cannot recur silently. A unit test pins
both directions: 10 SOL trades, 2 SOL is refused at every score.

Screening logic was untouched, so `strategyVersion` stays at `v0.2.0` and the
replay dataset remains valid. The change is to sizing policy only, and no
position had ever been opened under the old sizing.

**8. `reject_tracking` was recording rejections but no outcomes.**
Every row had a horizon of ~2 ms: the table stored the instant of rejection and
nothing after it. The question it exists to answer — what did the tokens we
refused go on to do — was unanswerable, so no gate could be justified or
challenged with evidence.

The cycle now runs a fourth phase that re-observes rejected mints on a
10-minute cadence, anchored on each mint's *first* rejection so a horizon means
the same thing for every row. One batched `search` request covers 100 mints, so
the whole panel costs one request per cycle.

Two things this deliberately does not do: it does not drop mints the provider
stopped quoting (that is the most common outcome in this population, and
dropping them would leave a panel made entirely of survivors — they are recorded
with a null price and counted as −100%), and it does not infer route existence
from liquidity, which is a different claim than the one being made.

`pnpm backtest` reports gate counterfactuals off this panel. It explicitly
**refuses to print a strategy equity curve**, because too few positions exist for
one to mean anything, and prints the reason instead.

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

## Open calibration question (not yet answered)

After fixing finding #5, the binding constraint is `insufficient_liquidity` at
**98.5%** of rejects. Liquidity in the strategy's age window is pinned at the
pump.fun bonding-curve floor: p10 $2,282 / p50 $2,285 / p95 $2,862, with only
**1.1%** clearing the configured $8,000 floor.

That floor is 400x our maximum position (0.1 SOL, ~$20). It may well be far
stricter than exit economics require — but **we have never quoted anything below
it**, so the claim "small pools are unexecutable" is currently unsupported by
any measurement. This is a selection effect, not evidence.

It will be resolved by measuring round-trip cost against a stratified sample of
sub-threshold tokens, not by lowering the threshold until trades appear. Until
that measurement exists the floor stays where it is.

## Safety posture (additions)

- No `sendTransaction` method exists on the RPC client *at all*, so no
  observe/paper/replay/backtest path can reach the network with a signature.
- The RPC client falls back to a secondary endpoint on transport failure but
  **rethrows immediately on schema drift**: asking a different host until one
  agrees with us is how a bug becomes a silent policy change.
- `pnpm kill` clears a lock only after confirming the owning pid is dead, and
  refuses to touch locks written by another host. Force-clearing a live lock
  would let two engines share one ledger.
- `pnpm secretscan` is verified against a planted 64-byte keypair array rather
  than assumed to work. It never prints matched text.
- Token-2022 extension decoding fails closed: an unknown discriminant is refused,
  not skipped.

## Post-fix funnel (strategy v0.2.0, 10 SOL NAV)

Measured over a 0.4h window after findings #7 and #8 were fixed:

```
screenings           4398
eligible                8   (0.18%, ~22/hour)
paper positions         3   (simulated fills, real quotes)
```

The `sole cause` column in `pnpm report` is the actionable one: a gate that only
ever fires alongside others can be loosened without admitting a single extra
candidate. Currently `insufficient_liquidity` is the sole blocker **47** times
and `excessive_impact` **8** times; every other gate is almost always
co-occurring. So the liquidity floor is the only calibration that would change
the funnel, which is exactly the open question below.

## Replay determinism

`pnpm replay` re-decides stored snapshots and compares against what was recorded:

```
snapshots examined   3000
replayed             2200   (current strategy version)
skipped (other ver)   800
divergent               0
```

The harness earned its place immediately by finding a real defect: `route_labels`
is written as a `>`-joined path but replay was parsing it as JSON, so 10 rows
threw. That is a storage/deserialization mismatch that no test asserted on and
no runtime path exercised, because nothing else reads quotes back out.

## Verified-unverified

One claim this system cannot yet make: **that a signable transaction can be
produced at all.** All 53 quotes report `transaction_buildable = 0`. That is
correct and intended — quote-only requests omit `taker`, so Jupiter never
returns a transaction to a keyless process — but it means the build-and-sign
path has never been exercised end to end. `pnpm report` prints this as
UNVERIFIED rather than letting an empty column read as success. Canary must
demonstrate it before live.

## The executor exists and refuses to run

`pnpm canary` and `pnpm live` are wired to real code today. Both exit 1 before a
key is loaded, and they say why in measurements rather than in a refusal:

```
$ pnpm canary                          $ pnpm live
8 gates, 4 not met                     12 gates, 7 not met
  signer.keypair          unset          + evidence.onChainFills      0 (need 30)
  rpc.primary             unset          + evidence.attemptFailureRate  no attempts
  evidence.paperPositions 5 (need 200)   + live.acknowledgement       LIVE_ACK_PATH unset
  evidence.observationWindow 0.7h (72h)
```

This is deliberately not a feature flag. A disabled path rots; this one is
executed on every invocation and what stops it is evidence. Thresholds live in
`packages/execution/src/gates.ts` as written-down numbers reported next to the
observation, so a reader can disagree with the choice instead of reverse-
engineering it. **A gate whose evidence cannot be gathered fails** — never
"passes with a warning", because an unmeasurable precondition is exactly where a
system is most likely to be wrong about itself.

### Three layers, none optional

`Signer.sign()` runs policy → binding → effect and stops at the first refusal.

- **Policy** — structural sanity: are we the fee payer, is every program on the
  allowlist, is the priority fee under the ceiling.
- **Binding** — does this transaction match the intent that asked for it? Bounds
  the deadline, the priority fee, and lamport outflow from account 0.
- **Effect** — what will these bytes actually *do*? Answered by simulating and
  diffing token-account balances, not by parsing.

That last split is an admitted limitation made structural. Jupiter's swap amounts
sit inside Anchor instruction data whose discriminator and field order I could
not verify against a current official source at signing time. Hardcoding a
remembered layout would produce a check that *appears* to bound the trade and
silently does not, which is worse than no check. So `binding.ts` bounds only what
the bytes prove unambiguously, and `effect.ts` establishes the amount bound by
measurement. A System Transfer of unexpected length is counted as
`undecodable_system_transfer` and refused: an amount we cannot read is not an
amount we can bound.

### A failed send is not a transaction that did not happen

It is a transaction whose fate is unknown, and the three possible truths (never
broadcast / broadcast and landed / broadcast and failed) call for different
actions. So the `execution_attempts` row carrying the signature is written to
SQLite **before** the send, a send that throws is recorded `UNKNOWN` rather than
`FAILED`, and expiry is only declared once block height provably exceeds
`lastValidBlockHeight`. Absence of a status is evidence of absence only after the
blockhash is dead. `resolveOutstanding()` blocks all execution while any attempt
is unresolved, and `apps/executor/src/main.ts` refuses to trade if it returns
nonzero — trading on top of an unknown balance is how one bad transaction becomes
a bad afternoon.

Idempotency is a UNIQUE constraint, not a read-then-write, because read-then-write
is not atomic across a crash and a crash is precisely what interrupts this.

### What is deliberately absent

The entry/exit loop is a visible gap in `main.ts`, not a stub. A stub that
appears to trade and does not is worse than a hole you can see.

`pnpm reconcile` is the only path allowed to write fills for on-chain trades, and
it writes them from `getTransaction` balance deltas rather than from the quote
that preceded them — the quote is what we hoped for, the balances are what
happened. It records `priorityFeeLamports: 0` because `getTransaction` does not
separate the priority component from the base fee; a fabricated split would
corrupt the very cost model that depends on it.

### Signer test suite

18 tests, all passing, against real ed25519 keys and genuinely wire-format-correct
v0 transactions. They exist because the signer is the only component whose failure
is unbounded: every other defect costs a trade, a signer defect costs the wallet.
Covered: keypair loading refuses a stored public half that disagrees with its
secret half; refusals for wrong fee payer, unauthorised program, priority fee
above the intent, expired intent, outflow above the intent, and unverified effect;
signature placement at slot zero leaves the message byte-identical; the emitted
signature verifies against the message it claims to sign.

Writing them found one real defect in the tests themselves rather than the code —
a case named "refuses a priority fee above the intent" was asserting the opposite,
because the policy ceiling is derived from the intent and raising one raises both.
Split into two tests that each assert what their name says.

## 2026-08-11 — test suites, register, ledger, agent controls

**180 tests across 12 files, all passing in 3.65s. Typecheck clean.** Property,
replay, chaos and e2e suites are now in place, so items 2 and 3 of the previous
"Next" list are done.

`docs/FAILURE_REGISTER.csv` holds **181 rows** in 13 columns — 119 `implemented`,
37 `partial`, 22 `designed_not_implemented`, 3 `not_applicable_current_architecture`.
Every referenced fixture and owner module was confirmed to exist before commit.
`docs/MULTIPLE_TESTING_LEDGER.csv` holds 11 rows. `.claude/` carries six subagents,
a `permissions.deny` path policy, and one PreToolUse command-content hook with 44
subprocess tests behind it.

New documents: `ASSUMPTIONS.md` (A1–A17, each with its falsifier), `DECISION_LOG.md`
(D1–D12 with the rejected alternative), `UPGRADE_ROI.md`.

### The first paper outcomes exist, and they are not a result

**10 closed positions, all simulated. 1 winner. Net −0.248 SOL on 0.487 SOL
deployed.** This is n=10 from a single session. It cannot support any statement
about expectancy and must not be quoted as performance. Several documents
previously said "zero closed positions exist"; that is now corrected in A8, MT008
and MT009.

What the ten do carry is a **diagnostic**: 8 of 10 exited via `exit_cost_exploded`
— `exits.ts:51` forcing a sale because exit price impact breached
`maxExitImpactBps`. `stop_loss` and `trailing_stop` fired once each, so the
directional exit rules are almost untested.

### The exit reason is lying, and that was the actual finding

The first reading of those eight was that entries are sized beyond what exit
liquidity supports. **That was wrong.** Entry size was 0.05 SOL against a
`quoteProbeLamports` of exactly 0.05 SOL — the gate probes at the size actually
traded, and buy-side impact at entry was under 8 bps in every case. The
size-mismatch hypothesis is falsified.

Reading the sell-quote series instead showed the eight are **two populations**:

| | n | final sell impact | SOL returned | what happened |
| --- | --- | --- | --- | --- |
| Liquidity collapse | 4 | −9,900 to −10,000 bps | ~0 | the pool went away; ~100% loss |
| Cost drift | 4 | +519 to +911 bps | ≈ entry | the rule worked as intended |

Both record `exit_cost_exploded`, because `apps/engine/src/paper.ts:360` builds
the input as `Math.round(Math.abs(sell.priceImpactPct) * 10_000)`. The `Math.abs`
discards the only thing that separates "this sale costs more than we allow" from
"the pool this position lived in no longer exists".

Two consequences, registered as **Q029** and **Q030**:

1. Post-hoc analysis reading the `exit_reason` column would attribute four total
   losses to a miscalibrated cost cap and tune `maxExitImpactBps` — the wrong
   parameter, against rugs that no exit rule could have salvaged.
2. A large *favourable* impact reading also exceeds the cap and forces a sale.
   Not yet observed in the corpus; recorded as latent.

**No production code was changed.** Removing the `Math.abs` moves four of ten
observed exits onto a different rule, which is a deliberate change to exit
semantics and needs a decision, not a cleanup commit. `tests/unit/exits.test.ts`
pins the current behaviour so that change is visible when it happens.

**MT011 is corrected rather than rewritten** — the original framing trusted the
`exit_reason` column, and roughly 4 of 10, not 8, are actually evidence about
entry sizing or the liquidity floor. MT005's evidence is correspondingly weaker
than it first appeared.

### Two corrections found by reading back what was written

`db.ts:335` **does** back up the database on every non-readonly open, and
`data/runtime.db.bak` exists. The register claimed no backup existed. Corrected
O017 to `partial` rather than `implemented`, because the copy does not checkpoint
the WAL or copy `runtime.db-wal` (live file 299 MB against a 181 MB `.bak`), it
overwrites the previous copy every run, and its failure path is an empty `catch`
whose comment claims it surfaces the error. It does not.

`tests/replay/determinism.test.ts:148` accepted an `over` parameter and never
spread it, so the "sell" leg of the round-trip fixture was byte-identical to the
buy leg. Fixed; the suite still passes, now for the reason it claims.

Also corrected: `ARCHITECTURE.md` said `apps/executor/src/main.ts` calls
`loadConfig()` bare — it passes the mode explicitly (D9). Four callers still call
it bare; only `doctor.ts:48` matters, and that is O023.

## 2026-08-12 — provider keys wired, and what verifying them turned up

A Jupiter Portal key and a Helius key became available. Wiring them was expected
to be a five-minute change; re-verifying the providers against current official
documentation turned up three defects instead, all of which had been latent
because **no key had ever existed to exercise the keyed paths**.

**O028 — a secret that was loaded and consumed by nothing.** `HELIUS_API_KEY`
was read by `loadSecrets()` and used by zero callers. `pnpm doctor` reported it
as present. So an operator could set the key, see it confirmed, and get no
on-chain capability whatsoever — A5's top-holder measurement would silently
never run. `loadSecrets()` now derives `rpcHttp` from the key when
`SOLANA_RPC_HTTP` is unset, and records in `rpcHttpDerivedFromHeliusKey` which
source won, so doctor reports `endpoint derived from HELIUS_API_KEY` rather than
implying the operator configured an endpoint they never configured.

**O029 — a bucket configured at exactly the documented ceiling.** Jupiter
publishes a **free** Portal-keyed tier at 1 rps / 60 rpm. `SOURCE_MATRIX.csv`
did not record that this tier existed; it recorded the keyless 0.5 rps as though
it were the only limit. Meanwhile `config/source-limits.json` already carried
`withKeyRequestsPerSecond: 1.0` — exactly the ceiling, in breach of the
"strictly UNDER" rule stated in that file's own `_meta`. Lowered to 0.8,
preserving the 0.8x headroom ratio the keyless bucket already used.

The interesting part is how the matrix came to be wrong. The 0.5 rps figure was
verified correctly, against the right page, on the right date. What was never
asked was whether that number was *one of several tiers*. A verified number can
still be the wrong number, and a `checked_at_utc` stamp does not detect it.

**O030 — a live credential that has to live in a URL.** Helius authenticates by
query parameter, so consuming the key means building a string that contains it.
That is the provider's design, not a choice. `heliusRpcUrl()` assembles it in
one place; `scrubSecrets()` redacts it; `secretscan`'s `helius_url_with_key`
rule fails the build if the assembled form is ever committed.

Seven tests in `tests/unit/secrets.test.ts` pin this, including redaction of the
URL when interpolated into an ordinary error message — the realistic leak path,
since pino's key-path redaction does not apply to a URL sitting inside a string.
Confirmed against three deliberate mutations: dropping `encodeURIComponent`
fails 1 of 7, reversing the endpoint precedence fails 1 of 7, removing the
`api-key=` branch from `scrubSecrets` fails 2 of 7. All three files restored.

Suite: **194 tests / 14 files**, ~4s. Typecheck clean, secretscan clean over 103
files. Register now 186 rows: 122 implemented, 38 partial, 23
designed_not_implemented, 3 not_applicable.

**What this does not change.** The keyless path is still the default and still
works, so no subscription is load-bearing and the master constraint holds. And
2x throughput multiplies an expectancy that is still unmeasured at n=10. The
free key was worth taking because it costs nothing, not because it improves the
odds of anything. `UPGRADE_ROI.md` has been amended on both points — including
the discovery that most of the paid-RPC section's premise is probably wrong,
since 1M free Helius credits at 1 credit per RPC call likely covers the
on-chain checks that page assumed had to be bought.

**Not done, deliberately:** the keys themselves are not in this repository and
were not written by me. They belong in `.env`, which is git-ignored and which
`.claude/settings.json` denies reading.

## 2026-08-12 — P1: exit accounting rebuilt on executable value

Strategy version `delayed-momentum-v0.2.0` -> `delayed-momentum-v0.3.0`.
Accounting version `exit-accounting-v1`. Schema migration 5.
Baseline before this work: commit `f7826a5`, backup
`data/backups/runtime-baseline-20260812T0328Z.db` (383,127,552 bytes).

### The label was doing two jobs and could do neither

Eight of the first ten closed paper positions carried exit reason
`exit_cost_exploded`, which fired on `Math.abs(priceImpactPct) > maxExitImpactBps`.
Reading the stored quotes showed that one label covered a token that had
evaporated to 13 lamports and a position that was worth **105.7% of its cost**
when it was ejected, twenty-one seconds after opening.

The fix was not to delete the `Math.abs`. Jupiter documents **no sign convention
for `priceImpactPct` at all** — verified 2026-08-12 against both the v2 OpenAPI
spec and the v1 swagger, recorded in `docs/RESEARCH.md` as O032. A threshold over
a field whose direction the vendor never specified cannot be given a stable
meaning in either direction. The knob was removed rather than corrected, and
replaced with `liquidityCollapseRatioBps`, stated over the SOL a full-position
sell was quoted to return. Leaving `maxExitImpactBps` in the config unused would
have been the third instance of the O028/O031 dead-config defect class.

Outcome and trigger are now two columns. `ExitOutcome` answers "what happened to
the money"; `TriggerRule` answers "which rule noticed". Conflating them is what
produced a single label spanning a 20x difference in severity.

### All ten positions reclassified (`scripts/backfill-exit-accounting.ts`)

| position | mint | cost SOL | final executable | ratio | OLD reason | NEW outcome |
| --- | --- | --- | --- | --- | --- | --- |
| e8276fb2 | Do3oMFHg | 0.050839280 | 0.047538284 | 0.9351 | exit_cost_exploded | cost_drift |
| d68a5fc5 | 5bjC6rcN | 0.052139280 | 0.000481520 | 0.0092 | exit_cost_exploded | **liquidity_collapse** |
| acd33808 | DE6svnZL | 0.042939280 | 0.045388189 | **1.0570** | exit_cost_exploded | cost_drift |
| eff38f80 | 414LMZzC | 0.049343458 | 0.044628326 | 0.9044 | exit_cost_exploded | cost_drift |
| c8069ef2 | 3XiaH5DA | 0.049320251 | 0.000000013 | 0.0000 | exit_cost_exploded | **liquidity_collapse** |
| 5599b5d8 | DWAtCiyw | 0.050368663 | 0.023688794 | 0.4703 | stop_loss | severe_exit_degradation |
| 39bb459b | 8vPXzkoy | 0.048880498 | 0.043306010 | 0.8860 | trailing_stop | ordinary_stop_loss |
| cb9b5c75 | HTaEUsni | 0.045527853 | 0.000000008 | 0.0000 | exit_cost_exploded | **liquidity_collapse** |
| 6f8b1e79 | 23n8oNsU | 0.052233144 | 0.000491353 | 0.0094 | exit_cost_exploded | **liquidity_collapse** |
| b348a030 | 8vPXzkoy | 0.045884531 | 0.043027745 | 0.9377 | exit_cost_exploded | cost_drift |

150 marks and 10 exits persisted, all flagged `backfilled=1`.

### Where the money actually went

| outcome | n | net SOL | share of losses |
| --- | --- | --- | --- |
| liquidity_collapse | 4 | -0.199076823 | **80.1%** |
| severe_exit_degradation | 1 | -0.027590533 | 11.1% |
| cost_drift | 4 | -0.014641483 | 5.9% |
| ordinary_stop_loss | 1 | -0.007073668 | 2.8% |

This is the number the old label made unobtainable. Four positions out of ten
account for four fifths of all losses, and they are not a stop-loss problem.
Tuning `stopLossBps` or `maxExitImpactBps` against this corpus would have been
tuning against 2.8% of the damage.

### Were the collapses survivable? All four were abrupt; none was doomed at entry

| position | entry mark | peak | final | worst single step | healthy for | fatal step over |
| --- | --- | --- | --- | --- | --- | --- |
| d68a5fc5 | 0.990 | 1.115 | 0.0092 | 105.4pp = 95% of drawdown | 17/18 marks (515s) | 30.9s |
| c8069ef2 | 0.952 | 1.072 | 0.0000 | 86.3pp = 81% of drawdown | 37/38 marks (1131s) | 30.8s |
| cb9b5c75 | 0.891 | 0.981 | 0.0000 | 98.1pp = 100% of drawdown | 6/7 marks (176s) | 30.9s |
| 6f8b1e79 | 0.942 | 1.074 | 0.0094 | 106.2pp = 100% of drawdown | 17/18 marks (514s) | 31.2s |

Three of the four **peaked above cost**. Every fatal step measures ~31s, which
is exactly the mark cadence. **At this resolution we cannot distinguish a
one-block rug from a 25-second drain**, and that is a limitation of the
instrument, not a finding about the market. It is the direct justification for
the P2 10s cadence and WebSocket pool monitoring.

### Two further defects found while doing this

**`take_profit` had never been able to fire.** Gain was measured with
`lossBps(mark, cost)`, which is *positive* when the position is winning, and
then tested as `-up >= takeProfitBps` — false for every possible input. Zero
take-profits across ten positions was not evidence that none qualified.
Replaying the corrected rule over the stored marks with no look-ahead,
`39bb459b` crosses 6000bps at mark 13 of 19 and closes at **+0.033411329 SOL**
instead of trailing-stopping six marks later at -0.007073668 SOL. `takeProfitBps`
itself is unchanged at 6000. (O033, MT013.)

**Positions were marked against the slippage floor.** `paper.ts` used
`otherAmountThreshold`, which is derived from our own `slippageBps` and is not an
observation of anything. Every mark was understated by exactly the slippage
setting, biasing both the stop loss and the trailing stop toward early exits.
Marks now record `outAmount` as the value and keep `otherAmountThreshold`
beside it. (O036.)

### Counterfactual, stated with its limits

`scripts/counterfactual-exits.ts` replays the corrected rules over the stored
marks. 6 of 10 positions could be priced; the other 4 ran out of marks, because
the old exit is what ended the series and inventing a price past that point
would be fabricating a fill. Of the 6, **5 fire on the same mark as the real
exit — zero saving by construction.** The entire +0.041224850 SOL delta is the
one `take_profit` position. **The corrected collapse rule rescues none of the
four collapses.** That is the honest result, and it is why P2 is next rather
than any threshold tuning.

### Verification

- `pnpm check` — 246 tests, 16 files, all pass; typecheck clean; secretscan clean.
- Exit rules mutation-tested five ways, all caught: collapse `<=` to `<` (3 fail),
  collapse gated behind `minHoldMs` (1), take-profit arguments swapped back to
  the original bug (2), route check demoted below collapse (1),
  stop-loss `>=` to `>` (1).
- **Replay: 2000 of 2000 snapshots reproduced exactly** across the version bump,
  via the new `--as-version=` flag. Zero divergence, so v0.3.0 is attributable
  entirely to the exit changes and the entry path is byte-identical.
- `pnpm doctor` — 15 checks, 0 failed, 0 warnings.

A version bump previously made `pnpm replay` skip every stored snapshot and
report zero divergences while verifying nothing; the exit code was the only
thing separating that from a real pass. (O035.)

Unit tests were also reading the operator's real `.env` — a consequence of
closing O031 — so `tests/unit/secrets.test.ts` passed on a clean checkout and
failed on any configured machine, printing a live key in its diff. Suppressed at
the loader in `tests/setup.ts`. (O034.)

### Still open from P1

The same `Math.abs(priceImpactPct)` construction exists on the **entry** side at
`packages/intelligence/src/gates.ts:313`. It is not fixed here because entry
gating is P5/P6, and changing it now would confound the exit measurement.


## 2026-08-12 — P2a: the instrument, and three things it was not measuring

P2 asks whether any prospective signal could have escaped the four liquidity
collapses. P1 established that the corpus **cannot answer that**: every collapse
did all its damage inside a single mark interval, and the mark interval was ~31s
because open positions were only re-quoted when discovery ran. The resolution of
the entire exit corpus was set by the discovery budget. That is a property of the
instrument, not of the market (**O039**).

Commits: `c330ace`, `75e9e54`.

### What changed

| Change | Was | Is |
| --- | --- | --- |
| mark cadence | tied to `discoveryIntervalMs` (~31s observed) | `markIntervalMs`, its own field, 10s |
| loop tick | discovery cadence | mark cadence; discovery gates itself |
| paper `maxSimultaneousPositions` | 3 | 1 for the measurement phase (a tightening) |

Measured after restart, from `position_marks` rather than from the log: spacing
min 10540ms, median 10555ms. The blind spot is 3x narrower. It is not gone — a
sub-10s collapse is still one interval — and that limit stays stated rather than
forgotten.

### Three defects found while verifying it

The engine was live with 145 eligible candidates and **zero open positions**, and
had been for ~16h while reporting itself healthy.

**O037 — the daily loss cap was permanent, not daily.** `dayStartUtcMs` was
assigned once in `restoreLedger` and read by nothing, so `realizedTodayLamports`
accumulated from process start and never released at midnight UTC. The engine was
refusing every entry against losses realised on a previous calendar day. A cap
that never releases is indistinguishable from a hang. Same dead-field class as
O028, O031 and the old `maxExitImpactBps` knob — every mechanism except the one
that uses it.

**O038 — realised P&L summed through a double.** `SUM(CAST(realized_lamports AS
INTEGER))` read back as a JS number, which is precisely what storing the column
as TEXT exists to prevent. Latent, not yet wrong: paper NAV is far below 2^53.

**O040 / O041 — risk guarantees with no enforcement.** Four risk halts
(`drawdownHaltPct`, `dailyLossHaltPct`, `weeklyLossHaltPct`,
`maxAggregatePlannedLossPct`) were declared in the schema and listed in
`SAFER_WHEN_LOWER` — the tree would refuse to *loosen* four caps that nothing
enforced. Separately, the config header claimed `assertNotLoosened` enforced that
rule at load time; it is exported and never called, and `loadConfig` merges no env
or CLI values at all. `drawdownHaltPct` is now implemented as the `drawdown_halt`
refusal against peak NAV. The other three are a **named canary blocker**, not a
silent gap.

Neither `paper.ts` defect was reachable by a test, because `paper.ts` calls
`main()` at import. The ledger helpers now live in `apps/engine/src/ledger.ts`
for that reason alone.

### O042 — decisions were not re-derivable from their snapshots

This is the serious one, and it was only visible because O035 had just been fixed.

`finalizeScreen` evaluated the concentration gate against an authoritative
on-chain holder distribution and **stored none of it**. `replayOne` passed `null`
and carried a comment saying the caller excluded rows that had a measurement;
`replayAll` filtered on `strategy_version` and nothing else. The comment described
a filter that did not exist.

Once the running engine had written enough v0.3.0 rows for replay to actually
execute, **28 of 1012 snapshots diverged**: `softRiskScore` on all 28, and 4 that
lost a stored `concentrated_ownership` **hard veto** entirely.

Fixed at the snapshot, not at the filter. Fixing the filter would have been O035
again — verifying less while reporting success.

| replay | replayed | divergent | unverifiable |
| --- | --- | --- | --- |
| v0.3.0 (current) | 1476 | **0** | 34 |
| v0.2.0 (`--as-version=`) | 488 | **0** | 0 |

The 34 cannot be repaired — the data was never collected. They are counted and
printed as `unverifiable`, never as passes. `replayable()` fails closed on an
unparseable row so corruption is still reported as a divergence rather than
relabelled as an explanation it has not earned.

### Risk changes — PAPER ONLY (MT014, MT015)

`canary` and `live` were **not touched**.

| paper | was | is |
| --- | --- | --- |
| `dailyLossCapLamports` | 0.06 SOL | 0.5 SOL |
| `drawdownHaltPct` | 6 (enforced by nothing) | 50 (enforced) |

The daily cap is a loosening of an enforced cap and is recorded as one. Two
reasons, neither of them "returns improved":

1. **It censored the sample precisely after losses.** Trades were missing not at
   random — they were missing exactly following losing sequences, so the surviving
   sample over-represents days that started with wins. For a phase whose entire
   purpose is unbiased estimation of expectancy, that is a defect in the
   instrument, the same class as O039.
2. At ~2 entries/day it made P8's own preregistered 200-closed-trade gate a
   100-day run.

Paper mode holds no capital, so the cap protects nothing there; the newly enforced
drawdown halt bounds total paper loss at 50% of NAV. **No entry gate, liquidity
floor, position size, or exit threshold was changed.** In particular the liquidity
floor was not lowered to manufacture trades.

### Verification

- 277 tests pass across 17 files; typecheck and secretscan clean; `doctor` 15/15.
- Mutation testing: **5/5** caught on the ledger helpers, **6/6** on the drawdown
  halt and peak NAV, **7/7** on concentration capture and the unverifiable
  accounting. Each set includes the original defect as a mutation.
- One mutation set caught a regression in this very change: `replayable()` ran
  outside the caller's `try`, so a corrupt row crashed the whole replay instead of
  being reported. Now fails closed.

### State after restart

Engine live, one open position, marks at 10s, concentration captured and
round-tripping. **This does not yet answer P2's question** — that needs collapses
observed at the new cadence, and there are none yet.

## Next

1. ~~**MT011 and MT005** — why 8 of 10 exits were forced by cost.~~ **Answered
   2026-08-12.** They were not forced by cost. One label was covering four
   liquidity collapses, four ordinary cost drifts, and one position that was up
   5.7%. See the P1 section above.
2. ~~**P2a — resolve the 31s blind spot.**~~ **Instrument fixed 2026-08-12.**
   Marks now land at 10.5s median, one open position at a time. The *question*
   is still open: no collapse has been observed at the new cadence yet, so
   whether a prospective signal exists remains unanswered. No exit threshold
   should move before it is.
3. **P2b — counterfactual exits at every mark** (fixed, trailing, time,
   executable-output decay, reserve decay, dev/cluster selling), no look-ahead.
   The existing `scripts/counterfactual-exits.ts` prices only whole positions
   against the current rules; P2b needs a policy sweep recorded per mark.
4. **P2c — Helius WebSocket pool monitoring and alert-mode re-quoting**, so a
   material reserve/authority/LP change triggers a mark instead of waiting for
   the next tick.
5. **The three unenforced risk halts (O040)** — `dailyLossHaltPct`,
   `weeklyLossHaltPct`, `maxAggregatePlannedLossPct`. A canary blocker: they are
   declared in `config/live.json` and an operator would reasonably believe they
   are active.
6. `pnpm reconcile` must take the process lock (O024) — a live hazard today.
7. A backup that survives the WAL (O017).
8. Clock-skew and sleep/resume detection (A17, D015, O012) — the last wholly
   unguarded environmental assumptions.
9. `pnpm doctor --mode=` (O023); `evidence.replayCorpus` counting divergences
   rather than snapshots (S022).
10. Measure actual Helius credit burn over a week of observe mode, then decide
   whether P005/P006/P012/P013 are blocked by money or only by implementation.
   The free tier is 1M credits/month at 1 credit per standard RPC call, so the
   answer is probably "implementation" — but that is a measurement, not a guess.
