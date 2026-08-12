# P2a.1 — VALIDITY AUDIT

**Date:** 2026-08-12T18:50Z
**Repository:** `C:\Users\lyman\tradseee` (Epitaxy TypeScript paper trader)
**Branch:** `master` **HEAD at audit:** `4fa28ea01dbff2211b600bed62ca6d01ce353f88`
**Remote:** none. This repository has never been pushed anywhere.
**Mode:** paper only. Canary and live were not enabled and no key exists.

**Final state: `P2B_BLOCKED_INVALID_PAPER_FILLS`**

---

## §0 — State at audit time

| | |
| --- | --- |
| dirty files | `all.json`, `vr.json`, and two directive `.md` files — all untracked, none source |
| unpushed work | all six commits; there is no remote to push to |
| engine | pid 12540, `--mode=paper`, started 2026-08-12 10:09:34 local, heartbeat 3s |
| strategy version | `delayed-momentum-v0.3.0` |
| database | `./data/runtime.db`, 1,041,285,120 bytes + 7,638,512 bytes of `-wal` |
| open positions | 0 |
| closed positions | 19 |
| realised paper PnL | −0.447487987 SOL |
| Jupiter | `https://api.jup.ag`, API key **active** |
| RPC | Helius HTTPS + WSS, free plan |

### Backup

Taken with `VACUUM INTO` rather than a file copy, because the engine holds the
database open in WAL mode and committed pages may live only in `-wal`.

```
data/backups/epitaxy-2026-08-12T18-52-01-969Z.db
sha256  85e251f883bdfca7baa540451b4c32ccd9b69f8504a4b2edf3f919931c506702
size    1,030,561,792 bytes
```

`PRAGMA integrity_check` **ok**, `PRAGMA foreign_key_check` **ok (0 violations)**,
`wal_checkpoint(PASSIVE)` checkpointed 796 frames. Backup re-opened read-only and
re-checked: **ok**.

Row counts are verified as `before ≤ backup ≤ after` rather than by equality. The
engine appends continuously, so an equality check fails for a *healthy* database
and cannot be distinguished from a torn snapshot. The first attempt did exactly
that and reported a false failure on 100 rows.

---

## P0 — The buildability blocker. **CONFIRMED.**

### Every stored quote

```
quotes stored                 2255
  transaction_buildable = 1      0
  carrying an errorCode          0
  side=buy    847 quotes,  0 buildable
  side=sell  1408 quotes,  0 buildable
```

### Cause

`JupiterClient.quote()` deliberately omits `taker`. Its own doc comment says so:

> Quote-only order. Deliberately omits `taker`, which means Jupiter returns
> routing and fees but never a signable transaction.

`toExecutableQuote` then sets `transactionBuildable = typeof o.transaction === 'string' && o.transaction.length > 0`, which is correctly `false`. The flag was
written to storage on every row from the first commit.

**Nothing read it.** `grep` across the tree finds `transaction_buildable` in the
schema, the repository writer, the replay reconstructor and one report query.
There was no decision branch. This is the same dead-field class as O028, O031,
O037, O040 and the old `maxExitImpactBps` knob — every mechanism except the one
that uses it.

### Consequence

```
fills stored                  38   (19 buy, 19 sell, 38 simulated, 0 signatures)
positions                     19
  closed with realised PnL    19
  PAPER_PNL_ELIGIBLE           0
```

> **0 historical paper trades establish executable PnL.**

The 19 closed positions carry −0.447487987 SOL of realised paper PnL. None of it
is executable evidence: neither leg of any trade ever had a buildable,
policy-validated transaction at decision time. The rows remain valid as
**quote-path observations** — routing, fees, amounts and the executable-value
trajectory are real — and they are retained in full.

### Second defect found here

`fills` has **no `quote_id` column**. Columns are `fill_id, intent_id, mint,
side, actual_in_amount, actual_out_amount, fee_lamports, priority_fee_lamports,
rent_lamports, signature, slot, simulated, utc_ms`. A fill therefore cannot be
tied to the exact quote that priced it; provenance is `(mint, side, timestamp)`
proximity only. The classification above does not depend on resolving that link,
because zero quotes are buildable and so every leg is `QUOTE_ONLY` whichever
quote priced it. It still blocks per-row P2b provenance and must be fixed.

### Fix applied

`requireBuildableFill: boolean` added to `AppConfigSchema` and set **true** in
all four mode configs. `tryEnter` now refuses, records a `unbuildable_entry_refused`
health event, and books nothing. Fails closed; the field is required, so a config
omitting it cannot load.

This is not a strategy change. It withdraws a claim the system was never
entitled to make.

---

## P1 — Impact semantics. **The directive's premise is refuted by the live API.**

### What the corpus contains

```
quotes                        2255
  min price_impact_pct          -1
  max price_impact_pct         210.7085052008875
  NEGATIVE                    1262   (56% of all rows)
  exactly 0                      0
  greater than 1                 3

position_marks                 561
  signed bps range          -10000 .. 1457
  NULL (honest unknown)          0
```

### What the provider actually returns

No raw payload was ever persisted — `quotes` stores only derived numbers — so the
historical rows **cannot** be traced from storage. That is itself a defect. The
question was instead settled against the live endpoint, quote-only, on 2026-08-12:

```
GET https://api.jup.ag/swap/v2/order   1 SOL -> USDC
  priceImpact     = -0.1820511452303203      (number, percent)
  priceImpactPct  = "-0.0018205114523032028" (string, fraction)
  transaction     = null
  taker           = null
```

Three findings, and the first contradicts the directive:

1. **Jupiter returns NEGATIVE impact for an ordinary adverse quote.** The
   directive states that raw `priceImpactPct` is documented as a 0..1 decimal and
   that *"any negative raw Jupiter impact is `SCHEMA_OR_PARSER_ERROR`, not a
   market event."* The deployed API demonstrably returns `-0.0018…` on a plain
   1 SOL → USDC quote with deep liquidity. Applying that rule mechanically would
   condemn **1262 of 2255 rows (56%)** as parser errors when they are faithful
   records. **The rule is not implemented.** Negative is retained as a market fact:
   negative = adverse, you receive less than the reference.

2. **The parser is correct.** `priceImpact = priceImpactPct × 100`. The code takes
   `priceImpact / 100`, which reproduces `priceImpactPct` exactly. Both branches
   agree to 15 decimal places; a test pins this.

3. **The names are inverted relative to intuition** — the field called `…Pct` is
   the *fraction*, the field without the suffix is the *percent*. Worth stating,
   since a future reader will assume the opposite.

`min = -1` is therefore **-100%**, a genuine total-loss quote, and `-10000` bps on
the mark series is the same event. The historical `Math.abs` turned that into
`+10000` and filed it alongside a `+519` cost drift — real conflation, already
removed from the exit path in commit `fef544f`.

### Still outstanding under P1

- `packages/intelligence/src/gates.ts:313` still applies `Math.abs` to
  `roundTrip.buy.priceImpactPct` on the **entry** gate. Now that the sign is known
  to be meaningful, this treats a *favourable* quote as adverse. Not yet fixed:
  it changes which tokens are eligible, and the directive forbids changing
  economics before preregistration. It is a correctness fix, needs a ledger row
  and a strategy-version bump, and must land before the confirmatory window.
- `toExecutableQuote` coerces a missing impact field to `0` (twice: the `: 0`
  fallback and `Number.isFinite(impact) ? impact : 0`). Zero means "no impact",
  i.e. safe — violating the project's own rule that absence of a provider field is
  never treated as safe. Latent: 0 rows currently have exactly 0.
- No raw provider payload or hash is persisted anywhere.

---

## P2 — Regime mixing already present

```
positions by strategy version     marks by cadence regime
  delayed-momentum-v0.2.0  10       backfilled=1  150 marks / 10 positions (~31s)
  delayed-momentum-v0.3.0   9       backfilled=0  411 marks /  9 positions (10.5s)
```

The corpus already spans two strategy versions, two mark cadences, two risk
policies (0.06/6 and 0.5/50) and the pre/post-O042 snapshot boundary. Per §2.1
none of these may be pooled. Combined with P0, **no confirmatory window has
started.**

---

## Defects found this session

| id | defect | status |
| --- | --- | --- |
| — | `transaction_buildable` written on 2255 rows, read by no decision; 38 fills booked on quote-only pricing | **fixed** (gate + 13 tests) |
| — | `fills` has no `quote_id`; a fill cannot be tied to its quote | open |
| — | no raw provider payload or hash persisted; historical impact untraceable from storage | open |
| — | missing impact field coerced to `0` = "safe" | open |
| — | entry gate `Math.abs` conflates favourable with adverse impact | open, deliberately deferred |
| — | `pnpm health` reports a 1096-minute-old KILL health *event* as a current critical | open |

## Verification

290 tests across 18 files pass. Typecheck and secretscan clean. Backup verified.

## What this session did NOT do

No canary, no live, no key, no funded wallet, no transaction. P2b ranking was not
started, per the directive and the explicit instruction. The exit policy was not
changed.


---

# P0.2 — Both legs, decoded. **COMPLETE.**

The entry leg was build-gated in the first half of this session; the exit leg was
not. That gap is worth naming precisely, because it is the same defect class as
everything else in this document: a position could be opened on a route that was
proven buildable and then closed against a price that nobody had shown could be
traded, and the resulting realized PnL would have looked exactly like evidence.

`apps/engine/src/buildleg.ts` now runs one function for both legs. It:

- calls `/swap/v2/build` with the taker;
- runs `evaluateInstructionPolicy()` over the returned instructions, using the
  same program allowlist, instruction cap, signer rule and priority-fee cap the
  executor applies to real transaction bytes;
- persists the attempt **whether or not it succeeded**;
- fills `transaction_bytes_hash`, `last_valid_block_height`, `expire_at` and
  `build_context_slot` from the response.

### What the policy check is, and what it is not

`/swap/v2/build` returns instructions, not serialized bytes. So the executor's
`evaluateTransactionPolicy()` cannot run on it unchanged, and pretending
otherwise would be the exact failure this session exists to remove. The checks
were separated from their input format instead:

| decidable from instructions | needs the assembled message |
|---|---|
| program allowlist | fee payer is account 0 |
| instruction count | required signature count |
| unexpected co-signers | recent blockhash present |
| compute unit limit present | packet size ≤ 1232 bytes |
| priority fee ≤ cap | |

`InstructionPolicyResult.coverage` is the literal string `instructions-only`, it
is stored inside `policy_status` as `POLICY_PASS(instructions-only)`, and a
mutation that widens it to `full-transaction` is caught by a test. Nothing this
check approves may ever be signed.

### `simulation_status` is still not a pass

It is written as an explicit string rather than left NULL, because a NULL reads
as an omission and this is a decision:

- buy leg: `NOT_SIMULATED(no local SVM fixture wired; structural build only)`
- sell leg: `NOT_SIMULATED(taker does not hold the hypothetical tokens; a
  mainnet simulation would fail for a reason unrelated to the route)`

The directive names both tempting shortcuts here — claiming mainnet simulation
success from a wallet that lacks the token, and silently downgrading to
quote-only. Neither is taken. A local SVM fork with synthetic balances remains
the correct way to close this and is not wired.

---

# P1.2 — The label split, and history reclassified

Eight mutually exclusive diagnostics, ordered so that facts which invalidate a
measurement outrank the measurement. The ordering claim is the substance:

```
1 PROVIDER_FAILURE          we did not observe the market at all
2 SCHEMA_OR_PARSER_ERROR    we observed it and cannot trust our reading
3 NO_EXIT_ROUTE             no route existed at any price
4 UNBUILDABLE_EXIT          a price existed, no transaction could be built
5 STALE_EXIT_QUOTE          the observation was too old to act on
6 EXECUTABLE_VALUE_COLLAPSE the position is worth a fraction of its cost
7 ADVERSE_EXIT_IMPACT       impact against us exceeded the frozen cap
8 ROUND_TRIP_COST_EXPANSION still sellable, round trip loses money
```

A 500 from an aggregator and a drained pool produce the same missing number. The
old system called both a liquidity event.

### All 603 historical marks reclassified

`scripts/reclassify.ts`, run with `--apply`:

| diagnostic | marks |
|---|---|
| NONE | 590 |
| EXECUTABLE_VALUE_COLLAPSE | 8 |
| ADVERSE_EXIT_IMPACT | 5 |
| UNVERIFIABLE | 0 |

Two things were deliberately **not** reconstructed. `routeBuildable` stays NULL,
because no build was ever attempted for these rows and null is the honest
answer — which also means no historical row can be labelled `UNBUILDABLE_EXIT`.
`providerFailed` stays false, because the old engine skipped the mark entirely
on an outage, so a stored mark is by construction not an outage. That is a fact
about the old control flow, and it is why outages are *absent* from the
historical corpus rather than rare in it.

**Re-labelling rescues nothing.** All 603 still fail `admissible()` on
`NO_RAW_PAYLOAD` and `NOT_BUILD_VALID`, and the script prints that.

---

# P6 — The size surface. **Measured live.**

Seven notionals, one token, one instant, both legs. `artifacts/size-surface.json`.

| size SOL | buy build | sell build | round-trip bps | feeBps | ATA rent bps | fixed cost bps | within canary cap | min NAV |
|---|---|---|---|---|---|---|---|---|
| 0.005 | yes | yes | 45 | 10 | **4078** | 2859 | yes | 0.55 |
| 0.010 | yes | yes | -162 | 10 | 2039 | 1429 | yes | 1.05 |
| 0.020 | yes | yes | 169 | 10 | **1019** | 714 | yes | 2.05 |
| 0.030 | yes | yes | 154 | 10 | 679 | 476 | no | 3.05 |
| 0.050 | yes | yes | 87 | 10 | 407 | 285 | no | 5.05 |
| 0.075 | yes | yes | 158 | 10 | 271 | 190 | no | 7.55 |
| 0.100 | yes | yes | 95 | 10 | 203 | 142 | no | 10.05 |

Three findings.

**Buildability is not size-limited.** Both legs build at every notional from
0.005 to 0.100 SOL. Whatever the constraint is, it is not the router's ability
to construct a transaction.

**The constraint is fixed cost, and it is severe at deployable size.** The canary
cap is the smaller of 0.02 SOL and 0.10% of NAV. At 0.02 SOL, ATA rent alone is
**1019 bps — 10.2% of the trade** — and total non-recoverable fixed cost is
714 bps. P5 establishes that rent recovery is currently unproven and therefore
zero, so that burden is real rather than a lockup. A strategy has to clear
roughly 10% before it does anything at the size we are actually permitted to
deploy at.

**The NAV question answers itself.** Under the frozen risk policy, 0.020 SOL
needs 2.05 SOL of NAV and 0.050 SOL needs 5.05. Paper NAV was raised to ~5.7 SOL
and the first entry was 0.0486 SOL. That is not a coincidence, and it is why
"proven at 0.05" says nothing about canary.

The one negative round-trip figure (-162 bps at 0.010 SOL) is a favourable
instantaneous round trip and is almost certainly a transient between two quotes
rather than free money. n=1 token, one instant.

**Deliberately absent** from the artifact: expected net return, expected log
growth, maximum drawdown, tail loss. Those are properties of a distribution;
there are zero build-valid completed trades to estimate one from, and producing
them here would be fabrication.

---

# P7 — The collapses. **Eight, not four, and none of them explained.**

`scripts/collapse-forensics.ts`.

The reported figure was four. There are **eight**, across eight distinct mints.

| mint | entry cost | marks | above 10% floor | last healthy | final |
|---|---|---|---|---|---|
| 23n8oNsU… | 52,233,144 | 18 | 17 | 55,945,145 | 491,353 |
| 3XiaH5DA… | 49,320,251 | 38 | 37 | 42,553,483 | 13 |
| 5bjC6rcN… | 52,139,280 | 18 | 17 | 55,423,987 | 481,520 |
| 8rojswXF… | 52,118,869 | 52 | 51 | 58,972,970 | 494,083 |
| BZbZPhcN… | 52,239,280 | 79 | 78 | 63,863,620 | 13 |
| GHSzMoRv… | 52,239,280 | 34 | 33 | 73,546,279 | 8 |
| GaGMcyqD… | 52,239,280 | 9 | 8 | 46,306,384 | 44,815 |
| HTaEUsni… | 45,527,853 | 7 | 6 | 44,642,327 | 8 |

Two structural facts, both from the "above 10% floor" column:

**Every collapse happened inside a single mark interval.** In all eight cases,
every mark but the last was above the 10% floor. The fall is faster than the
sampling, at the 31s cadence these were recorded at and probably at 10.5s too.
Any rule defined over a *level* is reached only after the fall has happened.
This is the mechanism Policy C in the preregistration exists to test.

**Every collapse is on `Pump.fun Amm`.** Eight of eight, one route.

And then the honest part: **every one is classified `UNKNOWN`.** Distinguishing
a true pool drain from a creator dump, a liquidity removal and a pool migration
requires reserve state, transfer-fee extension state and creator flow at each
slot. `position_marks` *declares* columns for all of those. Every one is NULL on
every row, because the feeds were never wired. 32 required evidence items are
absent across the eight cases.

A near-zero Jupiter route is not by itself proof that on-chain liquidity
vanished. Fitting a hard gate to these eight rows would be fitting to the only
variable that was actually measured, which is the outcome.

---

# P9 — Capability, extended

`pnpm capability` now reports 18 flags. The four that changed:

- `clock_healthy` — **measured** from persisted monotonic/wall checkpoint pairs
  rather than reporting that it had never looked;
- `resume_resync_required` — **measured**, and outstanding across a restart;
- `single_data_regime` — refuses to describe a mixed corpus as one thing;
- `pnl_eligible_trades` — the number P2b turns on. Currently **0**.

---

# Verification, this session

| check | result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm secretscan` | 143 files, 0 findings |
| `pnpm test` | 387 tests, 21 files, all pass, 2.6s |
| `scripts/mutate-p2a1.py` | 32 mutations, all caught |
| `scripts/mutate-ledger.py` | 11 mutations, all caught |
| `scripts/mutate-halts.py` | 10 mutations, all caught |
| `scripts/mutate-drawdown.py` | 6 mutations, all caught |
| `scripts/mutate-replay.py` | 7 mutations, all caught |
| destructive crash recovery | SIGKILL mid-write, WAL un-checkpointed, 12/12 marks recovered, sequence unbroken |

Four mutations survived the first `mutate-p2a1.py` run. All four were real
coverage gaps and all four got tests: an unasked buildability must not read as a
failed one, an unobserved token balance must not read as an empty account, a
co-signer other than the taker must be refused, and an instruction-level pass
must never claim full transaction coverage.

---

# What this session did NOT do

- **No mainnet simulation.** No local SVM fork with synthetic balances exists.
  `simulation_status` says so on every row.
- **No exit-policy change.** The economics are frozen exactly as they were until
  `docs/P2B_PREREGISTRATION.md` was committed, which is the point of committing
  it.
- **No P7 mechanism identified.** The eight collapses are classified UNKNOWN
  because the data to classify them was never collected.
- **No pool/vault, transfer-graph, or Token-2022 extension feed.** Those columns
  remain NULL, which is why P5 rent recovery is zero and P7 is unanswerable.
- **No canary, no live, no acknowledgement file.** No capital was placed at risk
  and none can be by anything in this commit.
- **No claim of profitability.** Zero trades in this corpus establish executable
  PnL.
