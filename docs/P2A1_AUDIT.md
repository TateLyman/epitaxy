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
