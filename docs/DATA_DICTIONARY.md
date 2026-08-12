# DATA DICTIONARY

Every table in `data/runtime.db`, what each column actually holds, and where a
column's name does not describe its contents.

The schema is defined entirely by the `MIGRATIONS` array in
`packages/storage/src/db.ts`. There are four migrations and **the live database
has now applied all four** — `SELECT id FROM schema_migrations` returns 1, 2, 3,
4, so `execution_attempts` carries the foreign key that migration 4 adds. An
earlier revision of this document recorded three; that was true when written and
is no longer.

**Row counts here are a stale snapshot by construction.** They were re-measured
read-only at **2026-08-11**, but an engine was running during the read and the
discovery tables grew between consecutive statements — `candidates` moved from
10,372 to 10,446 inside one pass. Treat every figure below as an order of
magnitude and a shape, never as a current value. To regenerate them, run:

```
pnpm tsx scripts/dbcounts.ts
```

Anything in this document that depends on a count being *exactly* right is a
defect in the document.

## Conventions

### Amounts are TEXT, never INTEGER

Every raw token or lamport amount is stored as TEXT. `db.ts` states the reason in
its header comment: SQLite's INTEGER is 64-bit **signed**, and a u64 token amount
near the top of its range would be silently truncated. Silently is the operative
word — there is no error, just a wrong number that looks like a right one.

`repo.ts` enforces the rule at both ends. Its header says "bigints are written as
TEXT and read back as bigint," and every writer calls `.toString()` on the way in:
`insertQuote`, `claimIntent`, `insertFill`, `insertPosition`, `updatePosition`,
and `recordAttempt` — the last with an explicit null check so a null does not
become the string `"null"`. Readers do the inverse: `replay-cli.ts` wraps each
amount column in `BigInt(...)`, and `paper.ts` does `BigInt(row.cost_lamports)`.
`types.ts` states the same invariant one layer up — floating point is permitted
only for derived or scoring values that can never feed back into an amount.

The cost is that SQLite cannot do arithmetic on these columns without a cast, and
a cast reintroduces exactly the truncation the TEXT choice avoids. One place takes
the shortcut. `restoreLedger` in `apps/engine/src/paper.ts` runs:

```sql
SELECT COALESCE(SUM(CAST(realized_lamports AS INTEGER)),0) AS r FROM positions
```

That casts to signed 64-bit inside SQLite and then arrives in JavaScript as a
`number`, losing exactness above 2^53. At paper-mode NAV scale the values are
around 10^9 lamports and nothing is lost today, but the guarantee the TEXT
convention exists to provide is not present on this path.

### `utc_ms` and `mono_ms` are different clocks

`decision_snapshots` is the only table carrying both. `types.ts` documents the
monotonic field as "ms since process start; immune to wall-clock adjustment," and
`packages/strategy/src/screen.ts` populates it with `Math.round(performance.now())`.
`Provenance.receivedMonotonicMs` is filled the same way in `pipeline/src/cycle.ts`
and `adapters/src/http.ts`. Neither clock substitutes for the other:

| Column | Source | Answers | Fails at |
| --- | --- | --- | --- |
| `taken_utc_ms` | `Date.now()` | when did this happen, in a frame shared with the chain, the indexer and every other process | NTP steps, DST-free but not step-free; a backward correction can make a later event look earlier |
| `taken_mono_ms` | `performance.now()` | how much time really elapsed between two events **in the same process run** | meaningless across processes or restarts — it resets to zero every time the engine starts |

Freshness gates are the reason both are kept. A decision is vetoed when its inputs
are stale, and staleness is a duration. Computed from wall clock alone, a clock
correction between fetch and decision could manufacture or erase staleness —
`clock_skew` is a declared circuit breaker in `types.ts` because that failure is
expected, not hypothetical. The monotonic value is trustworthy for intra-run
durations; the UTC value is the only one that can be joined against anything else.

The cost: `taken_mono_ms` is not comparable across process runs, and nothing in
the schema records which run a row came from. Two snapshots reading 400 and 900
may be 500ms apart or a day apart. Do not sort or difference it table-wide.
Everywhere else the timestamp is `Date.now()` with no monotonic companion.

Booleans are stored as INTEGER 0/1 (`eligible`, `transaction_buildable`,
`simulated`, `route_exists`, `ok`). Structured values are stored as JSON TEXT with
a `_json` suffix. IDs are TEXT UUIDv4 from `randomUUID()` via `repo.newId()`,
except `health_events.id` and `sign_refusals.id`, which are INTEGER AUTOINCREMENT.

---

## Migration 1 — `initial`

### `candidates`

One row per mint ever discovered, before any enrichment or gating. Written by
`insertCandidate` with `ON CONFLICT(mint) DO NOTHING`, so the row records the
**first** sighting and is never updated. The invariant is that discovery is
append-only and idempotent: re-seeing a mint on a later cycle must not overwrite
what we knew when we first saw it, because `first_seen_utc_ms` is the anchor every
age calculation depends on.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `mint` | TEXT | no | Base58 mint address. Primary key. |
| `name` | TEXT | no | Token name as the indexer reported it. |
| `symbol` | TEXT | no | Token symbol as the indexer reported it. |
| `decimals` | INTEGER | no | Token decimals. |
| `token_program` | TEXT | no | Owning program: SPL Token or Token-2022. |
| `creator` | TEXT | yes | Deployer address. Sourced from the provider's `dev` field. Null 11 times as measured. |
| `launchpad` | TEXT | no | One of `LaunchpadName`. `'unknown'` is a sentinel, not a null. |
| `first_seen_utc_ms` | INTEGER | no | When **we** first saw it. |
| `created_at_utc_ms` | INTEGER | yes | When the token claims it was created, per the source. |
| `source` | TEXT | no | `Provenance.source`, e.g. `jupiter.tokens.recent`. |
| `source_type` | TEXT | no | `Provenance.sourceType`, one of the five `SourceType` values. |
| `payload_hash` | TEXT | no | sha256 of the raw payload, for drift forensics. |
| `schema_version` | TEXT | no | Provider schema version string. |

Indexes: `idx_candidates_first_seen(first_seen_utc_ms)` serves the maturity queue
in `maturingMints`; `idx_candidates_creator(creator)` serves creator-reuse
lookups. Neither prevents a failure; both prevent a full scan of a growing table.

`created_at_utc_ms` and `first_seen_utc_ms` are ranked, not interchangeable:
`maturingMints` ages tokens by `COALESCE(created_at_utc_ms, first_seen_utc_ms)`.
A token discovered late has a `first_seen` that overstates its freshness.

Measured: **6,581 rows.**

### `decision_snapshots`

The frozen input to one decision. The comment in `db.ts` is explicit: "Replay
reads ONLY from here." The invariant is that a decision must be a pure function of
this row — if replay reproduces the decision, the snapshot captured everything;
if it does not, either the snapshot is incomplete or the strategy changed, and
`replay-cli.ts` reports that as a defect rather than smoothing it over.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `snapshot_id` | TEXT | no | UUID. Primary key. |
| `mint` | TEXT | no | Subject mint. |
| `taken_utc_ms` | INTEGER | no | Wall clock at capture. |
| `taken_mono_ms` | INTEGER | no | `performance.now()` at capture. Intra-run only. |
| `slot` | INTEGER | yes | Slot the data describes, when the source exposes one. |
| `token_age_ms` | INTEGER | yes | Token age at decision time. Replay derives `createdAt` back out of this rather than re-fetching. |
| `features_json` | TEXT | no | JSON object of numeric/null features. Observed keys include `tokenAgeMs`, `liquidityUsd`, `holderCount`, `organicScore`, `mcap`, `fdv`, `usdPrice`, `topHoldersPct`, `devBalancePct`, the 5m flow counters, and `roundTripLossBps`. |
| `raw_inputs_json` | TEXT | no | JSON object of the provider payload as consumed: `symbol`, `name`, `launchpad`, `dev`, `decimals`, `tokenProgram`, `audit`, `stats5m`, `buyQuoteId`, `sellQuoteId`. |
| `freshness_json` | TEXT | no | Per-source age in ms at decision time, e.g. `{"jupiter_tokens":6025,"quote":-1}`. |

Indexes: `idx_snapshots_mint_time(mint, taken_utc_ms)` and
`idx_snapshots_time(taken_utc_ms)`. Replay orders by `taken_utc_ms DESC` and joins
per snapshot; without these the largest table in the store is scanned twice.

No UNIQUE constraint beyond the primary key. A mint is snapshotted every time it
is screened — up to 15 times for one mint as measured — and that is intended.
`freshness_json` uses `-1` as a sentinel for "no quote was taken," not as an age;
averaging it unfiltered produces a meaningless number.

Measured: **26,450 rows** across **5,888 distinct mints**.

### `screenings`

Every screening result, accepted and rejected. `db.ts` states why the rejected
ones are kept: without them you cannot measure whether a filter improves outcomes,
only that it tidies the visible trade log. The invariant is completeness — one row
per evaluation, with no survivorship filtering at write time.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `screening_id` | TEXT | no | UUID generated inside `insertScreening`, not by the caller. Primary key. |
| `mint` | TEXT | no | Subject mint. |
| `snapshot_id` | TEXT | no | The `decision_snapshots` row this decision read. |
| `evaluated_utc_ms` | INTEGER | no | Decision wall clock. |
| `eligible` | INTEGER | no | 0 or 1. |
| `hard_vetoes_json` | TEXT | no | JSON array of reason codes that fired. `[]` when eligible. |
| `soft_risk_score` | REAL | no | Aggregate soft risk. |
| `opportunity_score` | REAL | yes | Null permitted by DDL; 0 nulls observed. |
| `components_json` | TEXT | no | JSON object of score components: `breadth`, `liquidity`, `organic`, `tradability`, `freshness`, `raw`, `softRisk`. |
| `gates_json` | TEXT | no | JSON array of `GateResult`. |
| `strategy_version` | TEXT | no | Version of the strategy that produced this. Replay compares only matching versions. |

Indexes: `idx_screenings_mint(mint, evaluated_utc_ms)` backs the
last-evaluated-per-mint subquery in `maturingMints`;
`idx_screenings_eligible(eligible, evaluated_utc_ms)` backs `counters` and the
rejection breakdown, which filters `eligible = 0` over the whole table.

`gates_json` is easy to misread. Each `GateResult` carries `reason` and `detail`
**whether or not the gate passed** — a passing gate still records
`"reason":"stale_source","detail":"source age 6025ms > 60000ms"`, describing the
condition the gate checks rather than a condition that occurred. Only `passed` and
`hard_vetoes_json` say what actually happened.

Measured: **26,450 rows**, of which **50 eligible**.

### `quotes`

Every quote requested from a router, including failures. `db.ts`: discarding
failed quotes would bias every downstream cost estimate. The invariant is that the
denominator is preserved — a route that could not be quoted is evidence about
tradability, and dropping it makes the surviving quotes look better than the
market was.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `quote_id` | TEXT | no | Router-scoped quote id. Primary key; insert is `ON CONFLICT DO NOTHING`. |
| `mint` | TEXT | no | The subject token, which is *not* necessarily `input_mint` — for a sell it is the input, for a buy the output. |
| `input_mint` | TEXT | no | Mint spent. |
| `output_mint` | TEXT | no | Mint received. |
| `in_amount` | TEXT | no | bigint. |
| `out_amount` | TEXT | no | bigint. Optimistic. |
| `other_amount_threshold` | TEXT | no | bigint. Router's worst-case output at the requested slippage. This is the number paper fills use. |
| `slippage_bps` | INTEGER | no | Requested slippage. |
| `platform_fee_bps` | INTEGER | no | Router-reported platform fee. |
| `price_impact_pct` | REAL | no | Percent, not bps. `paper.ts` multiplies by 10,000 to get bps. |
| `router` | TEXT | no | Observed values: `metis`, `okx`, `dflow`. |
| `route_labels` | TEXT | no | **Not JSON.** `insertQuote` writes `routeLabels.join('>')` and `replay-cli.ts` splits on `>`. A label containing `>` would corrupt the round trip. |
| `signature_fee_lamports` | TEXT | no | bigint. |
| `prioritization_fee_lamports` | TEXT | no | bigint. |
| `rent_fee_lamports` | TEXT | no | bigint. |
| `transaction_buildable` | INTEGER | no | 1 only when the router returned a signable transaction. Quote-only requests omit `taker`, so this is 0 for all 269 rows measured. |
| `error_code` | INTEGER | yes | Router error code. All null as measured. |
| `error_message` | TEXT | yes | Router error text. |
| `requested_utc_ms` | INTEGER | no | Request sent. |
| `received_utc_ms` | INTEGER | no | Response received. Freshness is measured from here. |
| `latency_ms` | INTEGER | no | Round trip. |
| `side` | TEXT | no | `buy` or `sell`, from the caller's perspective, passed separately from the quote object. |

Index: `idx_quotes_mint(mint, requested_utc_ms)`.

Measured: **269 rows**, **0** with `transaction_buildable = 1`.

### `reject_tracking`

Forward tracking of rejected candidates, so the cost of each gate can be measured
rather than assumed to be zero. The invariant is that a horizon means the same
thing on every row: `recordForwardObservation` anchors every observation to the
mint's **first** rejection, because an actively screened mint is re-rejected every
cycle and anchoring on the latest one would make horizons incomparable.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT | no | UUID. Primary key. |
| `mint` | TEXT | no | Subject mint. |
| `rejected_utc_ms` | INTEGER | no | **The anchor, not this row's rejection time.** On forward-observation rows `recordForwardObservation` writes `target.anchorUtcMs`, the first rejection ever recorded for this mint. |
| `primary_reason` | TEXT | no | Reason attached to the **anchor**, copied forward. Not the reason that fired at `observed_utc_ms`. |
| `observed_utc_ms` | INTEGER | no | When this observation was actually taken. This is the only honest per-row timestamp. |
| `price_usd` | REAL | yes | Indexer mark. Null means the token was no longer quoted; `backtest-cli.ts` counts that as -100%, not as missing. |
| `liquidity_usd` | REAL | yes | Indexer liquidity. |
| `route_exists` | INTEGER | yes | 0/1/null. |
| `horizon_ms` | INTEGER | no | `observed_utc_ms - anchor`. Approximately 0 on the initial rejection row. |

Indexes: `idx_reject_mint(mint, observed_utc_ms)` and
`idx_reject_reason(primary_reason)`. The follow-up query groups by mint over a
lookback window; the panel load orders by `mint, horizon_ms`.

No UNIQUE constraint. This is a panel, not a log of rejections: one mint
contributes many rows, most of them zero-horizon re-rejections from repeated
screening. `rejectsNeedingFollowUp` filters on `horizon_ms > minGapMs` for exactly
that reason — counting all rows would permanently exclude the mints most worth
following.

Measured: **44,529 rows**, of which **18,129** have `horizon_ms > 60,000` and are
genuine forward observations.

### `intents`

The bounded instruction handed to the executor. Mirrors `TradeIntent`. The
invariant is idempotency, and it lives in the `UNIQUE` constraint on
`idempotency_key` rather than in a read-then-write, because a read-then-write is
not atomic across a crash and a crash is exactly what interrupts this operation.
`claimIntent` uses `INSERT OR IGNORE` and reports whether it created or found the
row; "found" means an earlier attempt may already be in flight.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `intent_id` | TEXT | no | UUID. Primary key. |
| `idempotency_key` | TEXT | no | UNIQUE. `sha256(strategyVersion\|mint\|side\|amount\|epochMs)` truncated to 32 hex chars. |
| `mint` | TEXT | no | Subject mint. |
| `side` | TEXT | no | `buy` or `sell`. |
| `input_mint` | TEXT | no | Mint spent. |
| `output_mint` | TEXT | no | Mint received. |
| `max_input_amount` | TEXT | no | bigint ceiling. Enforced by the binding layer. |
| `min_output_amount` | TEXT | no | bigint floor. Enforced by the effect layer. |
| `max_total_fee_lamports` | TEXT | no | bigint ceiling on total fees. |
| `max_priority_fee_lamports` | TEXT | no | bigint ceiling; the transaction policy's fee ceiling derives from this rather than a separate setting. |
| `deadline_utc_ms` | INTEGER | no | Expiry. Past this, signing refuses with `intent_expired`. |
| `strategy_version` | TEXT | no | Producing strategy version. |
| `risk_snapshot_hash` | TEXT | no | Hash of the risk state at formation. |
| `created_utc_ms` | INTEGER | no | Formation wall clock. |
| `state` | TEXT | no | A `PositionState` value, seeded to `'INTENT_CREATED'`. The enum is shared with `positions.state`; only a subset applies here. |
| `simulated` | INTEGER | no | 0/1. |

Index: `idx_intents_state(state)`, which serves the executor's scan for
non-terminal intents.

Measured: **0 rows.** Nothing has ever formed an intent — consistent with
`transaction_buildable = 0` on every quote and with the executor's entry/exit loop
being absent rather than stubbed.

### `fills`

What actually moved. `Fill.actualInAmount` is documented in `types.ts` as
"wallet-reflected amounts, not quoted amounts," and for on-chain trades
`reconcile-cli.ts` is the only permitted writer and derives them from
`getTransaction` balance deltas.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `fill_id` | TEXT | no | UUID. Primary key. |
| `intent_id` | TEXT | no | **Misleading in paper mode. See below.** |
| `mint` | TEXT | no | Subject mint. |
| `side` | TEXT | no | `buy` or `sell`. |
| `actual_in_amount` | TEXT | no | bigint spent. |
| `actual_out_amount` | TEXT | no | bigint received. |
| `fee_lamports` | TEXT | no | bigint. In paper mode this is a modelled platform fee in token/lamport terms, not a chain fee. |
| `priority_fee_lamports` | TEXT | no | bigint. Reconciliation writes 0 here because `getTransaction` does not separate the priority component from the base fee, and a fabricated split would corrupt the cost model. |
| `rent_lamports` | TEXT | no | bigint. Paper charges assumed ATA rent on buys, 0 on sells. |
| `signature` | TEXT | yes | Transaction signature. Always null for simulated fills. |
| `slot` | INTEGER | yes | Landed slot. Always null for simulated fills. |
| `simulated` | INTEGER | no | 0/1. |
| `utc_ms` | INTEGER | no | Fill wall clock. |

Indexes: `idx_fills_signature` is UNIQUE **partial** — `WHERE signature IS NOT NULL`.
The partial clause is what makes it usable: two on-chain fills can never claim the
same transaction, while any number of simulated fills coexist with null
signatures. A non-partial unique index would have allowed exactly one simulated
fill in the whole database. `idx_fills_mint(mint, utc_ms)` serves per-mint history.

Measured: **20 rows** (10 buy, 10 sell), all simulated.

### `positions`

The open/closed lifecycle of a holding. The invariant is one live position per
(mint, strategy version), enforced by a partial unique index rather than by
application logic.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `position_id` | TEXT | no | UUID. Primary key. |
| `mint` | TEXT | no | Subject mint. |
| `state` | TEXT | no | A `PositionState`. `EXIT_BLOCKED` is terminal-in-practice: paper sets it when the exit rule fires and no sell route exists. |
| `token_amount` | TEXT | no | bigint held. Zeroed on close. |
| `cost_lamports` | TEXT | no | bigint. Entry notional **plus** assumed priority fee and ATA rent. Not the amount swapped. |
| `realized_lamports` | TEXT | no | bigint. Signed P&L, `proceeds - cost`. Negative values are stored as a leading-minus TEXT string. |
| `opened_utc_ms` | INTEGER | no | Open wall clock. |
| `closed_utc_ms` | INTEGER | yes | Close wall clock. |
| `strategy_version` | TEXT | no | Producing strategy version; part of the uniqueness key. |
| `simulated` | INTEGER | no | 0/1. |
| `exit_reason` | TEXT | yes | Written by `updatePosition` on exit. `insertPosition` always writes null. |
| `peak_value_lamports` | TEXT | yes | **Initialised to `cost_lamports`, not to a mark.** `insertPosition` passes `p.costLamports.toString()`. A position never marked above cost reports a peak equal to its cost, which is indistinguishable from a real peak at breakeven. 5 of 10 rows are in that state. |

Indexes: `idx_positions_state(state)` serves `openPositions`.
`idx_positions_open_mint` is UNIQUE on `(mint, strategy_version)` filtered to
`state IN ('POSITION_OPEN','EXIT_INTENT','INTENT_CREATED')`. It prevents the
double-entry failure — buying the same token twice concurrently — while allowing
any number of historical closed positions in the same mint. The filter list
includes `INTENT_CREATED`, so the reservation exists from intent formation rather
than from fill.

Measured: **10 rows**, all `POSITION_CLOSED` and all simulated; exit reasons `exit_cost_exploded` (8)
and `stop_loss` (1).

### `health_events`

Append-only operational log. Written by `recordHealth`, which truncates `detail`
to 500 characters — bounded so an unbounded external error string cannot become an
unbounded row.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | INTEGER | no | AUTOINCREMENT primary key. |
| `utc_ms` | INTEGER | no | `Date.now()` inside the writer; not caller-supplied. |
| `kind` | TEXT | no | Free-form event kind, e.g. `kill_invoked`, `cycle_error`, `exit_blocked`. Not constrained to the `CircuitBreaker` union in `types.ts`. |
| `severity` | TEXT | no | `info`, `warn`, or `critical`, by TypeScript signature only. No CHECK constraint. |
| `detail` | TEXT | no | Truncated to 500 chars. |

Index: `idx_health_time(utc_ms)`. Measured: **4 rows**, all `kill_invoked` / `info`.

### `process_locks`

Cross-process single-writer enforcement, held by the `ProcessLock` class in
`db.ts`. Two executors running at once is a double-spend of the same balance, so
this is checked at startup and heartbeated while running. The lock is considered
stale after 30s of no heartbeat, and the heartbeat interval is one third of that.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `lock_name` | TEXT | no | Logical lock, e.g. `engine`. Primary key — one holder per name. |
| `pid` | INTEGER | no | Holder's process id. |
| `hostname` | TEXT | no | From `hostnameSafe()`, exported so holders and reapers derive the host identically. Falls back to `'unknown'`. |
| `acquired_utc_ms` | INTEGER | no | First acquisition. |
| `heartbeat_utc_ms` | INTEGER | no | Last heartbeat. Staleness is measured from here. |
| `mode` | TEXT | no | The `Mode` the holder is running in. |

The primary key on `lock_name` does the work: `acquire` upserts with
`ON CONFLICT(lock_name) DO UPDATE`, so two holders cannot exist as separate rows.
Liveness is a `pid` comparison against a fresh heartbeat, with a limitation worth
stating: a pid on a *different host* writing to the same file is compared as if it
were local. `hostname` is recorded, not consulted. Measured: **1 row** (`engine`,
mode `paper`).

### `trials`

Every parameter set evaluated counts as a trial, to keep the multiple-testing
ledger honest. Nothing prevents a trial going unrecorded; this only makes recorded
trials countable.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `trial_id` | TEXT | no | UUID. Primary key. |
| `utc_ms` | INTEGER | no | `Date.now()` inside the writer. |
| `description` | TEXT | no | Human label. |
| `params_json` | TEXT | no | `JSON.stringify` of arbitrary params. |
| `metric` | TEXT | no | Metric name. |
| `value` | REAL | yes | Metric value; null when the trial produced none. |
| `sample_size` | INTEGER | yes | n behind `value`. |

No indexes. Measured: **0 rows.**

---

## Migration 2 — `source_health_and_regime`

### `source_health`

One row per source observation. Written by `recordSourceHealth`, on both success
and failure paths across `cycle.ts`, `collector/main.ts` and `paper.ts`.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `source` | TEXT | no | Source identifier, e.g. `jupiter.tokens.recent`. |
| `utc_ms` | INTEGER | no | `Date.now()` inside the writer. |
| `ok` | INTEGER | no | 0/1. |
| `latency_ms` | INTEGER | yes | Often null — most call sites pass null rather than a measured latency. |
| `error_kind` | TEXT | yes | Failure classification; null on success. |

`PRIMARY KEY (source, utc_ms)` with `ON CONFLICT DO NOTHING` means two
observations of one source in the same millisecond silently collapse to one — a
deliberate dedupe against retry loops, costing a small unmeasurable undercount of
high-frequency sources. Index: `idx_source_health_time(utc_ms)`. Measured:
**1,062 rows**, all `ok = 1`; no failure has ever been recorded, so this table
currently proves availability and nothing about failure handling.

### `regime_samples`

Market-wide context sampled over time. `utc_ms` is itself the primary key, so
there is exactly one sample per millisecond globally.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `utc_ms` | INTEGER | no | Sample time. Primary key. |
| `sol_usd` | REAL | yes | SOL price. |
| `sol_return_1h` | REAL | yes | Trailing 1h return. |
| `launch_throughput` | INTEGER | yes | Launches per interval. |
| `median_launch_liq` | REAL | yes | Median launch liquidity. |
| `slot` | INTEGER | yes | Slot at sample time. |

No writer exists in `repo.ts`. Measured: **0 rows.** The table is provisioned, not
used.

---

## Migration 3 — `execution_attempts`

### `execution_attempts`

One row per broadcast, written **before** the send. The comment in `db.ts` states
the reason: recovery must be able to distinguish "never sent" from "sent and
unknown", and those two states call for opposite actions. The signature is
deterministic given the message, so it identifies the transaction whether or not
the send call returns.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `attempt_id` | TEXT | no | UUID. Primary key. |
| `intent_id` | TEXT | no | Owning intent. FK only after migration 4. |
| `attempt_no` | INTEGER | no | Retry ordinal within the intent. |
| `signature` | TEXT | no | Base58 signature, known before sending. |
| `blockhash` | TEXT | no | Recent blockhash used. |
| `last_valid_height` | INTEGER | no | Upper bound on the blockhash's life. Expiry is proved against this, never assumed from elapsed time. |
| `signed_utc_ms` | INTEGER | no | Signing time. |
| `sent_utc_ms` | INTEGER | yes | Send time. Null means the send was never attempted or never returned. |
| `send_error` | TEXT | yes | Client-side send error. |
| `outcome` | TEXT | no | `SIGNED`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `EXPIRED`, `UNKNOWN`. Seeded `SIGNED`. A throwing send becomes `UNKNOWN`, never `FAILED`. |
| `landed_slot` | INTEGER | yes | Confirmed slot. |
| `chain_error` | TEXT | yes | On-chain failure detail. |
| `resolved_utc_ms` | INTEGER | yes | When the fate became known. |
| `simulated_out` | TEXT | yes | bigint. Simulated output from the effect layer. |
| `simulated_in` | TEXT | yes | bigint. Simulated input from the effect layer. |

Constraints: `UNIQUE (intent_id, attempt_no)` prevents two rows claiming the same
retry slot of one intent. `idx_attempts_signature` is UNIQUE on `signature` and
prevents two rows claiming one transaction — the database refuses rather than the
caller remembering to. `idx_attempts_outcome(outcome)` backs `unresolvedAttempts`,
which filters `outcome IN ('SIGNED','SUBMITTED','UNKNOWN')` and whose nonzero
result blocks all further trading.

The `AttemptRow` interface in `repo.ts` omits `simulated_out` and `simulated_in`
even though `unresolvedAttempts` uses `SELECT *`. Present at runtime, invisible to
the type.

Measured: **0 rows.**

### `sign_refusals`

Refusals are evidence. `db.ts`: a signer that declines a thousand transactions and
never says why is indistinguishable from one that is simply broken.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | INTEGER | no | AUTOINCREMENT primary key. |
| `intent_id` | TEXT | no | Intent the refusal relates to. No FK. |
| `utc_ms` | INTEGER | no | `Date.now()` inside the writer. |
| `kind` | TEXT | no | Refusal code from the policy, binding or effect layer. |
| `detail` | TEXT | no | Truncated to 2,000 chars by `recordSignRefusal`. |

Index: `idx_refusals_intent(intent_id)`. Measured: **0 rows.**

---

## Migration 4 — `attempts_reference_intents`

Not a new table. It rebuilds `execution_attempts` solely to add
`REFERENCES intents(intent_id)` to `intent_id`, because SQLite cannot add a
constraint in place. The `db.ts` comment explains the failure it closes: an
attempt whose intent does not exist resolves into nothing — the signature is on
chain, the process believes it handled it, and no intent ever changes state.

The copy `INSERT` is deliberately unguarded. If an orphan already exists the
migration throws, `migrate()` rolls back and rethrows, and startup stops, because
an unattributable signature is exactly the condition this system must not continue
past.

**This migration has not been applied to `data/runtime.db`.** `schema_migrations`
contains ids 1, 2, 3 only, and reading `sqlite_master` back confirms the live
`execution_attempts` still declares `intent_id TEXT NOT NULL` with no `REFERENCES`
clause. It will apply on the next non-readonly `openDb`, and since
`execution_attempts` is empty it will apply cleanly.

---

## Referential integrity

`openDb` sets `PRAGMA foreign_keys = ON` for writable connections, so declared
foreign keys are enforced. Exactly one is declared in the whole schema, and it is
in the migration this database has not yet run.

| Relationship | Enforced? |
| --- | --- |
| `execution_attempts.intent_id` → `intents.intent_id` | FOREIGN KEY, added in migration 4. **Not yet present in the live file.** |
| `screenings.snapshot_id` → `decision_snapshots.snapshot_id` | Implied by naming only. Replay depends on this join and would silently examine fewer rows if it broke. |
| `screenings.mint`, `decision_snapshots.mint`, `quotes.mint`, `positions.mint`, `fills.mint`, `reject_tracking.mint` → `candidates.mint` | Implied by naming only. |
| `sign_refusals.intent_id` → `intents.intent_id` | Implied by naming only. |
| `positions` → `fills` | No column links them in either direction. |
| `fills.intent_id` → `intents.intent_id` | **No foreign key, and in paper mode the column does not contain an intent id at all.** |

### `fills.intent_id` is a known defect, not a design

`apps/engine/src/paper.ts` writes two kinds of fill, and neither carries an intent
id:

- Buy, line 267: `intentId: result.outcome.snapshotId` — a `decision_snapshots.snapshot_id`.
- Sell, line 365: `intentId: row.position_id` — a `positions.position_id`.

Paper mode never calls `claimIntent`, so no intent exists to reference. The column
is `NOT NULL`, so something had to go there, and what went there was whatever
identifier was in scope. The result is a column whose contents are one of two
different things depending on `side`. Measured against the live database:

| Check | Result |
| --- | --- |
| Fills whose `intent_id` matches no `intents.intent_id` | 12 of 12 |
| Fills whose `intent_id` matches a `decision_snapshots.snapshot_id` | 10 (all buys) |
| Fills whose `intent_id` matches a `positions.position_id` | 6 (all sells) |

`apps/executor/src/reconcile-cli.ts` does it correctly — it looks up the intent and
writes `intentId: intent.intent_id`. The column is therefore correct on the
on-chain path and overloaded on the paper path, which is the worst of both: a
query joining `fills` to `intents` returns the on-chain fills, silently drops
every paper fill, and reports no error.

Migration 4 does not catch this; it constrains `execution_attempts`, not `fills`.
A `FOREIGN KEY` added to `fills.intent_id` today would fail on all 12 rows.

Two other joins to distrust:

- `reject_tracking.rejected_utc_ms` does not identify the rejection that produced
  the row. It is the mint's first rejection, repeated on every forward observation.
  Grouping by it counts mints, not rejections.
- `quotes.mint` is the subject token, and it equals `input_mint` on a sell and
  `output_mint` on a buy. Joining on `input_mint` finds only half the quotes.

---

## What replay and backtest may read

The boundary exists because the value of this dataset is that a decision can be
re-derived from what it saw. A decision re-derived from data that arrived *after*
it was made proves nothing. Lookahead does not announce itself; it shows up as a
strategy that works in analysis and not in production.

| Tool | Reads | Why |
| --- | --- | --- |
| `pnpm replay` (`replay-cli.ts`) | `decision_snapshots` joined to `screenings`, plus `quotes` by id | `decision_snapshots` is the frozen decision input. `db.ts` says replay reads only from here. `screenings` supplies the stored answer to compare against. `quotes` is fetched by the exact `buyQuoteId`/`sellQuoteId` recorded in `raw_inputs_json`, so a quote can only enter replay if the original decision named it. |
| `pnpm backtest` (`backtest-cli.ts`) | `reject_tracking`, plus one count from `positions` | It measures gate counterfactuals: what happened next to tokens each gate removed. That is forward data by construction. `positions` is read only for a closed-position count printed in the limitations block. |

Both open with `openDb({ readonly: true })`, which skips migration and cannot write.

Three rules the tools follow that the schema does not enforce:

1. **Replay never re-fetches.** `reconstruct()` derives `createdAt` from
   `taken_utc_ms - token_age_ms` rather than asking a provider, so replay does not
   depend on a source still being reachable or still returning the same thing.
2. **Replay does not invent missing inputs.** Concentration was not captured in the
   snapshot, so it is passed as `null`, and rows decided *with* a concentration
   measurement are excluded by the caller rather than compared against nothing.
3. **Replay only compares matching `strategy_version`.** Other versions are counted
   separately, because comparing v0.1.0 decisions against v0.2.0 code measures the
   version bump, not determinism.

What the boundary costs: replay cannot verify any gate whose input was not written
into `features_json` or `raw_inputs_json`. Concentration is one such gate today.
Adding a gate without extending the snapshot silently shrinks what replay can
prove, and nothing in the schema will complain.

`backtest-cli.ts` states plainly that it is not a strategy equity curve: every
number is an indexer mark, not a fill, and marks systematically overstate what a
seller receives in thin markets — precisely this population.
