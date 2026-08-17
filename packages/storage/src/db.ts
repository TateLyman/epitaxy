import { DatabaseSync } from 'node:sqlite';
import { onlineBackup, BackupFailed } from './backup.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Operational store.
 *
 * Choices worth stating:
 *  - `node:sqlite` (built into Node 24) instead of a native addon. On Windows
 *    a native build is a real fragility source (toolchain + antivirus), and
 *    this removes it entirely.
 *  - WAL mode, one logical writer per database.
 *  - Every bigint amount is stored as TEXT. SQLite INTEGER is 64-bit signed and
 *    would silently truncate a u64 token amount near the top of its range.
 */

export type Db = DatabaseSync;

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE IF NOT EXISTS candidates (
  mint              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  token_program     TEXT NOT NULL,
  creator           TEXT,
  launchpad         TEXT NOT NULL,
  first_seen_utc_ms INTEGER NOT NULL,
  created_at_utc_ms INTEGER,
  source            TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  schema_version    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_first_seen ON candidates(first_seen_utc_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_creator ON candidates(creator);

-- Frozen decision inputs. Replay reads ONLY from here.
CREATE TABLE IF NOT EXISTS decision_snapshots (
  snapshot_id       TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  taken_utc_ms      INTEGER NOT NULL,
  taken_mono_ms     INTEGER NOT NULL,
  slot              INTEGER,
  token_age_ms      INTEGER,
  features_json     TEXT NOT NULL,
  raw_inputs_json   TEXT NOT NULL,
  freshness_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON decision_snapshots(mint, taken_utc_ms);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON decision_snapshots(taken_utc_ms);

-- EVERY screening result, accepted and rejected. Required to measure whether
-- filters improve outcomes rather than just tidying the visible trade log.
CREATE TABLE IF NOT EXISTS screenings (
  screening_id      TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  snapshot_id       TEXT NOT NULL,
  evaluated_utc_ms  INTEGER NOT NULL,
  eligible          INTEGER NOT NULL,
  hard_vetoes_json  TEXT NOT NULL,
  soft_risk_score   REAL NOT NULL,
  opportunity_score REAL,
  components_json   TEXT NOT NULL,
  gates_json        TEXT NOT NULL,
  strategy_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screenings_mint ON screenings(mint, evaluated_utc_ms);
CREATE INDEX IF NOT EXISTS idx_screenings_eligible ON screenings(eligible, evaluated_utc_ms);

-- Every quote we requested, including failures. Discarding failed quotes would
-- bias every downstream cost estimate.
CREATE TABLE IF NOT EXISTS quotes (
  quote_id                  TEXT PRIMARY KEY,
  mint                      TEXT NOT NULL,
  input_mint                TEXT NOT NULL,
  output_mint               TEXT NOT NULL,
  in_amount                 TEXT NOT NULL,
  out_amount                TEXT NOT NULL,
  other_amount_threshold    TEXT NOT NULL,
  slippage_bps              INTEGER NOT NULL,
  platform_fee_bps          INTEGER NOT NULL,
  price_impact_pct          REAL NOT NULL,
  router                    TEXT NOT NULL,
  route_labels              TEXT NOT NULL,
  signature_fee_lamports    TEXT NOT NULL,
  prioritization_fee_lamports TEXT NOT NULL,
  rent_fee_lamports         TEXT NOT NULL,
  transaction_buildable     INTEGER NOT NULL,
  error_code                INTEGER,
  error_message             TEXT,
  requested_utc_ms          INTEGER NOT NULL,
  received_utc_ms           INTEGER NOT NULL,
  latency_ms                INTEGER NOT NULL,
  side                      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_mint ON quotes(mint, requested_utc_ms);

-- Forward tracking of REJECTED candidates, so we can measure the cost of each
-- gate rather than assuming filters are free.
CREATE TABLE IF NOT EXISTS reject_tracking (
  id                TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  rejected_utc_ms   INTEGER NOT NULL,
  primary_reason    TEXT NOT NULL,
  observed_utc_ms   INTEGER NOT NULL,
  price_usd         REAL,
  liquidity_usd     REAL,
  route_exists      INTEGER,
  horizon_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reject_mint ON reject_tracking(mint, observed_utc_ms);
CREATE INDEX IF NOT EXISTS idx_reject_reason ON reject_tracking(primary_reason);

CREATE TABLE IF NOT EXISTS intents (
  intent_id                 TEXT PRIMARY KEY,
  idempotency_key           TEXT NOT NULL UNIQUE,
  mint                      TEXT NOT NULL,
  side                      TEXT NOT NULL,
  input_mint                TEXT NOT NULL,
  output_mint               TEXT NOT NULL,
  max_input_amount          TEXT NOT NULL,
  min_output_amount         TEXT NOT NULL,
  max_total_fee_lamports    TEXT NOT NULL,
  max_priority_fee_lamports TEXT NOT NULL,
  deadline_utc_ms           INTEGER NOT NULL,
  strategy_version          TEXT NOT NULL,
  risk_snapshot_hash        TEXT NOT NULL,
  created_utc_ms            INTEGER NOT NULL,
  state                     TEXT NOT NULL,
  simulated                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_state ON intents(state);

CREATE TABLE IF NOT EXISTS fills (
  fill_id                TEXT PRIMARY KEY,
  intent_id              TEXT NOT NULL,
  mint                   TEXT NOT NULL,
  side                   TEXT NOT NULL,
  actual_in_amount       TEXT NOT NULL,
  actual_out_amount      TEXT NOT NULL,
  fee_lamports           TEXT NOT NULL,
  priority_fee_lamports  TEXT NOT NULL,
  rent_lamports          TEXT NOT NULL,
  signature              TEXT,
  slot                   INTEGER,
  simulated              INTEGER NOT NULL,
  utc_ms                 INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_signature ON fills(signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fills_mint ON fills(mint, utc_ms);

CREATE TABLE IF NOT EXISTS positions (
  position_id       TEXT PRIMARY KEY,
  mint              TEXT NOT NULL,
  state             TEXT NOT NULL,
  token_amount      TEXT NOT NULL,
  cost_lamports     TEXT NOT NULL,
  realized_lamports TEXT NOT NULL,
  opened_utc_ms     INTEGER NOT NULL,
  closed_utc_ms     INTEGER,
  strategy_version  TEXT NOT NULL,
  simulated         INTEGER NOT NULL,
  exit_reason       TEXT,
  peak_value_lamports TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_open_mint
  ON positions(mint, strategy_version) WHERE state IN ('POSITION_OPEN','EXIT_INTENT','INTENT_CREATED');

CREATE TABLE IF NOT EXISTS health_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  utc_ms        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  detail        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_time ON health_events(utc_ms);

-- Single-writer enforcement across processes.
CREATE TABLE IF NOT EXISTS process_locks (
  lock_name     TEXT PRIMARY KEY,
  pid           INTEGER NOT NULL,
  hostname      TEXT NOT NULL,
  acquired_utc_ms INTEGER NOT NULL,
  heartbeat_utc_ms INTEGER NOT NULL,
  mode          TEXT NOT NULL
);

-- Every parameter set we evaluate counts as a trial. Required to keep the
-- multiple-testing ledger honest.
CREATE TABLE IF NOT EXISTS trials (
  trial_id      TEXT PRIMARY KEY,
  utc_ms        INTEGER NOT NULL,
  description   TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  metric        TEXT NOT NULL,
  value         REAL,
  sample_size   INTEGER
);
`,
  },
  {
    id: 2,
    name: 'source_health_and_regime',
    sql: `
CREATE TABLE IF NOT EXISTS source_health (
  source          TEXT NOT NULL,
  utc_ms          INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  latency_ms      INTEGER,
  error_kind      TEXT,
  PRIMARY KEY (source, utc_ms)
);
CREATE INDEX IF NOT EXISTS idx_source_health_time ON source_health(utc_ms);

CREATE TABLE IF NOT EXISTS regime_samples (
  utc_ms              INTEGER PRIMARY KEY,
  sol_usd             REAL,
  sol_return_1h       REAL,
  launch_throughput   INTEGER,
  median_launch_liq   REAL,
  slot                INTEGER
);
`,
  },
  {
    id: 3,
    name: 'execution_attempts',
    sql: `
-- One row per broadcast. Written BEFORE the send, so a process that dies
-- mid-flight leaves behind the signature of a transaction that may have
-- landed. Without this, recovery cannot distinguish "never sent" from "sent
-- and unknown", and those two states call for opposite actions.
CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id        TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL,
  signature         TEXT NOT NULL,
  blockhash         TEXT NOT NULL,
  last_valid_height INTEGER NOT NULL,
  signed_utc_ms     INTEGER NOT NULL,
  sent_utc_ms       INTEGER,
  send_error        TEXT,
  outcome           TEXT NOT NULL,
  landed_slot       INTEGER,
  chain_error       TEXT,
  resolved_utc_ms   INTEGER,
  simulated_out     TEXT,
  simulated_in      TEXT,
  UNIQUE (intent_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_signature ON execution_attempts(signature);
CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON execution_attempts(outcome);

-- Refusals are evidence too. A signer that declines a thousand transactions
-- and never says why is indistinguishable from one that is simply broken.
CREATE TABLE IF NOT EXISTS sign_refusals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id     TEXT NOT NULL,
  utc_ms        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  detail        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refusals_intent ON sign_refusals(intent_id);
`,
  },
  {
    id: 4,
    name: 'attempts_reference_intents',
    sql: `
-- An attempt row is the only durable record that a transaction was signed, and
-- recovery resolves it by updating the intent it belongs to. An attempt whose
-- intent does not exist therefore resolves into nothing: the signature is on
-- chain, the process believes it handled it, and no intent ever changes state.
-- Migration 3 declared intent_id NOT NULL but never constrained it, so that row
-- was insertable. SQLite cannot add a constraint in place, hence the rebuild.
--
-- The INSERT below is deliberately unguarded. If an orphan already exists the
-- migration fails and startup stops, because an unattributable signature is
-- exactly the condition this system must never continue past.
CREATE TABLE execution_attempts_v4 (
  attempt_id        TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES intents(intent_id),
  attempt_no        INTEGER NOT NULL,
  signature         TEXT NOT NULL,
  blockhash         TEXT NOT NULL,
  last_valid_height INTEGER NOT NULL,
  signed_utc_ms     INTEGER NOT NULL,
  sent_utc_ms       INTEGER,
  send_error        TEXT,
  outcome           TEXT NOT NULL,
  landed_slot       INTEGER,
  chain_error       TEXT,
  resolved_utc_ms   INTEGER,
  simulated_out     TEXT,
  simulated_in      TEXT,
  UNIQUE (intent_id, attempt_no)
);
INSERT INTO execution_attempts_v4 SELECT
  attempt_id, intent_id, attempt_no, signature, blockhash, last_valid_height,
  signed_utc_ms, sent_utc_ms, send_error, outcome, landed_slot, chain_error,
  resolved_utc_ms, simulated_out, simulated_in
FROM execution_attempts;
DROP TABLE execution_attempts;
ALTER TABLE execution_attempts_v4 RENAME TO execution_attempts;
CREATE UNIQUE INDEX idx_attempts_signature ON execution_attempts(signature);
CREATE INDEX idx_attempts_outcome ON execution_attempts(outcome);
`,
  },
  {
    id: 5,
    name: 'position_marks_and_exit_outcomes',
    sql: `
-- Every mark of an open position, and the terminal record of how it ended.
--
-- Before this migration the only durable trace of a position's life was its
-- opening fill, its closing fill, and a single exit_reason string. That was
-- enough to say a position lost money and not enough to say why, or whether
-- anything observable would have said so earlier. Eight of the first ten paper
-- positions closed under one label that turned out to cover both "the token
-- evaporated" and "the price moved in our favour" (see
-- packages/domain/src/exitoutcome.ts).
--
-- NULL here means UNKNOWN and never zero. Several columns cannot be populated
-- until the on-chain and liquidity feeds land; they are declared now so that
-- backfilled and live rows share one shape, and so that "we did not measure
-- this" stays distinguishable from "we measured it and it was nothing". Any
-- consumer that coalesces these to 0 reintroduces exactly the defect this
-- table exists to remove.
CREATE TABLE IF NOT EXISTS position_marks (
  mark_id                              TEXT PRIMARY KEY,
  position_id                          TEXT NOT NULL REFERENCES positions(position_id),
  mint                                 TEXT NOT NULL,
  seq                                  INTEGER NOT NULL,
  observed_utc_ms                      INTEGER NOT NULL,

  -- Provider diagnostics, stored raw and signed. Never used to classify.
  raw_price_impact_pct                 REAL,
  raw_price_impact_bps_signed          INTEGER,

  -- The executable economics. This is what classification is built on.
  quoted_exit_input_token_amount       TEXT,
  quoted_exit_output_lamports          TEXT,
  quoted_exit_threshold_lamports       TEXT,
  position_entry_cost_lamports         TEXT NOT NULL,
  position_marked_value_lamports       TEXT,
  exit_value_ratio                     REAL,
  output_change_from_previous_mark_bps INTEGER,

  route_available                      INTEGER NOT NULL,
  route_labels                         TEXT,

  platform_fee_bps                     INTEGER,
  platform_fee_amount                  TEXT,
  transfer_fee_amount                  TEXT,
  estimated_network_fee_lamports       TEXT,
  estimated_priority_fee_lamports      TEXT,

  -- Pool and liquidity state. NULL until the reserve feed exists.
  pool_quote_reserve                   TEXT,
  pool_token_reserve                   TEXT,
  quote_reserve_change_from_entry_bps  INTEGER,
  quote_reserve_change_from_prev_bps   INTEGER,
  liquidity_usd                        REAL,
  liquidity_change_from_entry_bps      INTEGER,

  -- Actor flows. NULL until the transfer-graph feed exists.
  developer_net_token_flow             TEXT,
  clustered_insider_net_token_flow     TEXT,

  -- Provenance. A mark is only as good as its freshness.
  quote_requested_utc_ms               INTEGER,
  quote_received_utc_ms                INTEGER,
  quote_latency_ms                     INTEGER,
  source_utc_ms                        INTEGER,
  slot                                 INTEGER,
  source                               TEXT NOT NULL,
  backfilled                           INTEGER NOT NULL DEFAULT 0,

  UNIQUE (position_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_marks_position ON position_marks(position_id, seq);
CREATE INDEX IF NOT EXISTS idx_marks_mint_time ON position_marks(mint, observed_utc_ms);

-- One row per closed position. Separates what happened economically
-- (outcome) from which rule noticed (trigger_rule); collapsing those two is
-- the defect that made the first ten positions unreadable.
CREATE TABLE IF NOT EXISTS position_exits (
  position_id                     TEXT PRIMARY KEY REFERENCES positions(position_id),
  mint                            TEXT NOT NULL,
  outcome                         TEXT NOT NULL,
  trigger_rule                    TEXT NOT NULL,
  outcome_rationale               TEXT NOT NULL,
  exit_value_ratio                REAL,

  position_entry_cost_lamports    TEXT NOT NULL,
  quoted_exit_output_lamports     TEXT,
  gross_proceeds_lamports         TEXT,
  exit_fees_lamports              TEXT,
  net_proceeds_lamports           TEXT,
  realized_lamports               TEXT NOT NULL,

  entry_notional_lamports         TEXT,
  entry_fixed_costs_lamports      TEXT,
  ata_rent_lamports               TEXT,
  ata_rent_refunded               INTEGER,

  final_mark_id                   TEXT REFERENCES position_marks(mark_id),
  marks_observed                  INTEGER NOT NULL DEFAULT 0,
  opened_utc_ms                   INTEGER NOT NULL,
  closed_utc_ms                   INTEGER,
  held_ms                         INTEGER,
  strategy_version                TEXT NOT NULL,
  accounting_version              TEXT NOT NULL,
  backfilled                      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exits_outcome ON position_exits(outcome);
CREATE INDEX IF NOT EXISTS idx_exits_closed ON position_exits(closed_utc_ms);
`,
  },
  {
    id: 6,
    name: 'build_attempts',
    sql: `
-- Every structural build check, whether or not it succeeded.
--
-- Paper mode booked 38 fills across 19 positions against quotes where
-- transaction_buildable was false on all 2255 rows, because the flag was
-- written and read by no decision (P2a.1 §P0). The gate now refuses such a
-- fill, but refusing is only half of it: the EVIDENCE that a route was
-- buildable has to survive, or the corpus still cannot distinguish "we checked
-- and it built" from "we never asked".
--
-- Separate table rather than more columns on \`quotes\`, because a build is a
-- different observation from a price: it is taken against a taker, at a
-- moment, through an endpoint that may differ from the one that priced it.
-- Conflating them is what let /order pricing and /build buildability be
-- treated as the same route.
--
-- NULL means unknown. A build we did not attempt is not a build that failed.
CREATE TABLE IF NOT EXISTS build_attempts (
  build_id                 TEXT PRIMARY KEY,
  mint                     TEXT NOT NULL,
  side                     TEXT NOT NULL CHECK (side IN ('buy','sell')),
  position_id              TEXT,
  quote_id                 TEXT,

  requested_utc_ms         INTEGER NOT NULL,
  received_utc_ms          INTEGER,
  latency_ms               INTEGER,

  -- What we asked for. Amount is TEXT for the same reason every other amount
  -- is: SQLite INTEGER is 64-bit signed.
  input_mint               TEXT NOT NULL,
  output_mint              TEXT NOT NULL,
  amount                   TEXT NOT NULL,
  taker                    TEXT NOT NULL,
  slippage_bps             INTEGER,

  -- Where it came from. Recorded per row because /order and /build are
  -- different routes with different router universes and must never be
  -- reported as one.
  build_endpoint           TEXT NOT NULL,
  build_router             TEXT,
  build_request_id         TEXT,

  -- BUILD_SUCCEEDED | BUILD_FAILED | UNVERIFIABLE
  build_status             TEXT NOT NULL,
  build_error_code         INTEGER,
  build_error_class        TEXT,

  instruction_count        INTEGER,
  program_ids              TEXT,
  has_setup                INTEGER,
  has_cleanup              INTEGER,

  transaction_bytes_hash   TEXT,
  last_valid_block_height  INTEGER,
  expire_at                INTEGER,
  quote_context_slot       INTEGER,
  build_context_slot       INTEGER,

  -- Deliberately nullable and deliberately NOT defaulted to a pass. The
  -- transaction-policy decoder and a local SVM simulation are not wired yet;
  -- until they are, these stay NULL and no row may claim policy or simulation
  -- validation it never received.
  policy_status            TEXT,
  simulation_status        TEXT
);
CREATE INDEX IF NOT EXISTS idx_build_mint ON build_attempts(mint);
CREATE INDEX IF NOT EXISTS idx_build_status ON build_attempts(build_status);
CREATE INDEX IF NOT EXISTS idx_build_time ON build_attempts(requested_utc_ms);
`,
  },
  {
    id: 7,
    name: 'provenance_raw_payloads_diagnostics',
    sql: `
-- P2a.1 §P2.1 — what produced a row.
--
-- The window this session was called to repair pooled five incompatible
-- regimes into one average: strategy v0.2 with v0.3, pre-O042 snapshots with
-- post-O042 ones, 31-second marks with 10.5-second marks, a 0.06 SOL / 6% risk
-- policy with 0.5 SOL / 50%, and quote-only fills with build-validated fills.
-- Each of those changes what a row MEANS and none of them was on the row.
--
-- Stored once and referenced by hash rather than copied as eight columns onto
-- nine tables. A report that wants to pool two regimes has to join through a
-- key that makes the pooling visible.
CREATE TABLE IF NOT EXISTS run_contexts (
  context_hash          TEXT PRIMARY KEY,
  source_commit         TEXT NOT NULL,
  strategy_version      TEXT NOT NULL,
  strategy_config_hash  TEXT NOT NULL,
  risk_policy_hash      TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  paper_engine_version  TEXT NOT NULL,
  quote_adapter_version TEXT NOT NULL,
  data_regime_id        TEXT NOT NULL,
  mode                  TEXT NOT NULL,
  first_seen_utc_ms     INTEGER NOT NULL,
  last_seen_utc_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_regime ON run_contexts(data_regime_id);

-- P2a.1 §P1.1 — "persist the raw response or a durable raw blob plus hash.
-- Never preserve only the derived number."
--
-- Every derived field in this database is one parser bug away from being
-- wrong, and until now a parser bug was unrecoverable: the number was stored
-- and the bytes it came from were discarded. This table is what makes a
-- reclassification of history possible at all.
--
-- Deduplicated by payload hash. Two identical responses are one row; the
-- reference count says how many observations depended on it.
CREATE TABLE IF NOT EXISTS raw_payloads (
  payload_hash      TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  first_seen_utc_ms INTEGER NOT NULL,
  last_seen_utc_ms  INTEGER NOT NULL,
  ref_count         INTEGER NOT NULL DEFAULT 1,
  byte_length       INTEGER NOT NULL,
  body              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payload_seen ON raw_payloads(first_seen_utc_ms);

-- P2a.1 §P3.2 — the UTC day, persisted rather than held in a resettable
-- accumulator.
--
-- \`dayStartUtcMs\` used to live only in memory, was set once at startup and read
-- by nothing (O037), so the daily loss cap was permanent rather than daily.
-- Deriving the day's realized PnL from immutable closed positions keyed by an
-- explicit UTC date makes a rollover idempotent: running it twice, or at
-- midnight, or after a backwards clock step, recomputes the same number from
-- the same rows instead of zeroing a counter.
CREATE TABLE IF NOT EXISTS daily_accounting (
  utc_date            TEXT PRIMARY KEY,
  day_start_utc_ms    INTEGER NOT NULL,
  realized_lamports   TEXT NOT NULL,
  positions_closed    INTEGER NOT NULL,
  rolled_utc_ms       INTEGER NOT NULL,
  context_hash        TEXT
);

-- P2a.1 §P3.1 — both clocks, at every checkpoint.
--
-- A checkpoint that stores only wall time cannot detect that wall time moved.
-- Monotonic milliseconds are process-relative, so a row is only comparable with
-- another row from the same pid; that is exactly the comparison a resume
-- detector needs, and the pid column is what stops a cross-process comparison
-- being attempted.
CREATE TABLE IF NOT EXISTS clock_checkpoints (
  checkpoint_id   TEXT PRIMARY KEY,
  pid             INTEGER NOT NULL,
  monotonic_ms    REAL NOT NULL,
  wall_utc_ms     INTEGER NOT NULL,
  wall_delta_ms   INTEGER,
  monotonic_delta_ms REAL,
  skew_ms         REAL,
  discontinuity   TEXT,
  detail          TEXT,
  resync_required INTEGER NOT NULL DEFAULT 0,
  resync_done_utc_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clock_wall ON clock_checkpoints(wall_utc_ms);

-- Provenance keys. Nullable because every row written before this migration
-- genuinely has no context, and back-filling a guess would destroy the one
-- property the column exists to provide.
ALTER TABLE decision_snapshots ADD COLUMN context_hash TEXT;
ALTER TABLE screenings        ADD COLUMN context_hash TEXT;
ALTER TABLE quotes            ADD COLUMN context_hash TEXT;
ALTER TABLE positions         ADD COLUMN context_hash TEXT;
ALTER TABLE fills             ADD COLUMN context_hash TEXT;
ALTER TABLE position_marks    ADD COLUMN context_hash TEXT;
ALTER TABLE position_exits    ADD COLUMN context_hash TEXT;
ALTER TABLE build_attempts    ADD COLUMN context_hash TEXT;

-- P2a.1 §P1.1 — the impact fields, separated so that no single signed number
-- has to mean three things.
--
-- \`raw_price_impact_pct\` already exists on this table and keeps its meaning:
-- the signed fraction exactly as delivered. What was missing is the
-- non-negative quantity an exit rule is allowed to compare against a cap, and
-- the record of whether the field could be read at all. See
-- packages/domain/src/impact.ts for why negative is ordinary rather than
-- corrupt.
ALTER TABLE position_marks ADD COLUMN raw_impact_source_field TEXT;
ALTER TABLE position_marks ADD COLUMN raw_impact_string       TEXT;
ALTER TABLE position_marks ADD COLUMN impact_schema_status    TEXT;
ALTER TABLE position_marks ADD COLUMN adverse_impact_bps      REAL;
ALTER TABLE position_marks ADD COLUMN favourable_impact_bps   REAL;
ALTER TABLE position_marks ADD COLUMN impact_parser_version   TEXT;

-- The executable economics, named without ambiguity.
ALTER TABLE position_marks ADD COLUMN executable_sell_value_lamports TEXT;
ALTER TABLE position_marks ADD COLUMN all_in_cost_lamports           TEXT;
ALTER TABLE position_marks ADD COLUMN executable_value_ratio_bps     INTEGER;
ALTER TABLE position_marks ADD COLUMN signed_mark_return_bps         INTEGER;
ALTER TABLE position_marks ADD COLUMN round_trip_route_loss_bps      INTEGER;
ALTER TABLE position_marks ADD COLUMN quote_age_ms                   INTEGER;
ALTER TABLE position_marks ADD COLUMN route_exists                   INTEGER;
ALTER TABLE position_marks ADD COLUMN route_buildable                INTEGER;
ALTER TABLE position_marks ADD COLUMN raw_payload_hash               TEXT;

-- P2a.1 §P1.2 — the diagnostic, mutually exclusive and separate from both the
-- trigger rule and the economic outcome.
ALTER TABLE position_marks ADD COLUMN diagnostic         TEXT;
ALTER TABLE position_marks ADD COLUMN diagnostic_detail  TEXT;
ALTER TABLE position_marks ADD COLUMN diagnostic_version TEXT;

ALTER TABLE position_exits ADD COLUMN diagnostic         TEXT;
ALTER TABLE position_exits ADD COLUMN diagnostic_detail  TEXT;
ALTER TABLE position_exits ADD COLUMN diagnostic_version TEXT;
ALTER TABLE position_exits ADD COLUMN executable_value_ratio_bps INTEGER;

-- P2a.1 §P5 — ATA rent as locked capital.
--
-- \`ata_rent_refunded\` already exists as a nullable boolean and was never
-- populated by paper. These replace the guess with an audit trail: what was
-- locked, whether a close was even possible, what it cost, and — the field the
-- old model had no way to express — why the rent was NOT returned.
ALTER TABLE position_exits ADD COLUMN ata_created                   INTEGER;
ALTER TABLE position_exits ADD COLUMN ata_rent_locked_lamports      TEXT;
ALTER TABLE position_exits ADD COLUMN ata_close_buildable           INTEGER;
ALTER TABLE position_exits ADD COLUMN ata_close_simulated           INTEGER;
ALTER TABLE position_exits ADD COLUMN ata_close_attempted           INTEGER;
ALTER TABLE position_exits ADD COLUMN ata_close_confirmed           INTEGER;
ALTER TABLE position_exits ADD COLUMN ata_rent_recovered_lamports   TEXT;
ALTER TABLE position_exits ADD COLUMN ata_close_fee_lamports        TEXT;
ALTER TABLE position_exits ADD COLUMN ata_close_failure_reason      TEXT;
ALTER TABLE position_exits ADD COLUMN withheld_transfer_fee_lamports TEXT;
ALTER TABLE position_exits ADD COLUMN residual_token_amount         TEXT;
ALTER TABLE position_exits ADD COLUMN ata_accounting_version        TEXT;

-- P2a.1 §P4 — the fees the response actually reported, not the ones we assumed.
--
-- Official documentation lists 50bps for tokens younger than 24 hours; a live
-- probe measured 10bps. Neither is a fact about a specific trade. The response
-- for each order is, and until now it was parsed and thrown away.
ALTER TABLE position_exits ADD COLUMN actual_fee_bps                 INTEGER;
ALTER TABLE position_exits ADD COLUMN actual_fee_mint                TEXT;
ALTER TABLE position_exits ADD COLUMN actual_platform_fee_amount     TEXT;
ALTER TABLE position_exits ADD COLUMN actual_platform_fee_bps        INTEGER;
ALTER TABLE position_exits ADD COLUMN actual_signature_fee_lamports  TEXT;
ALTER TABLE position_exits ADD COLUMN actual_prioritization_fee_lamports TEXT;
ALTER TABLE position_exits ADD COLUMN actual_rent_fee_lamports       TEXT;

ALTER TABLE quotes ADD COLUMN fee_mint                    TEXT;
ALTER TABLE quotes ADD COLUMN platform_fee_amount         TEXT;
ALTER TABLE quotes ADD COLUMN raw_payload_hash            TEXT;
ALTER TABLE quotes ADD COLUMN impact_schema_status        TEXT;
ALTER TABLE quotes ADD COLUMN adverse_impact_bps          REAL;

-- P2a.1 §P2.2 — two ledgers from the same immutable signals.
--
-- \`portfolio_paper\` is the deployable policy: one wallet, one position at a
-- time, every risk cap enforced. \`alpha_shadow\` follows every eligible signal
-- and ignores the portfolio caps FOR MEASUREMENT ONLY, so that token-selection
-- and exit quality can be estimated without loss-dependent censoring — the
-- engine stopped taking entries after a bad day, so the days that followed a
-- loss are systematically missing from the sample, which is missing-not-at-
-- random and biases every estimate built on it.
--
-- The shadow ledger is not a wallet and can never be reported as one. The
-- \`ledger\` column is what stops the two being summed by accident.
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id            TEXT PRIMARY KEY,
  ledger              TEXT NOT NULL CHECK (ledger IN ('portfolio_paper','alpha_shadow')),
  position_id         TEXT,
  mint                TEXT NOT NULL,
  event               TEXT NOT NULL,
  utc_ms              INTEGER NOT NULL,
  notional_lamports   TEXT,
  realized_lamports   TEXT,
  nav_lamports        TEXT,
  free_lamports       TEXT,
  locked_rent_lamports TEXT,
  refusal             TEXT,
  detail              TEXT,
  context_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger_entries(ledger, utc_ms);
CREATE INDEX IF NOT EXISTS idx_ledger_position ON ledger_entries(position_id);
`,
  },
  {
    id: 8,
    name: 'execution_observations_and_shadow_books',
    sql: `
-- One observation, one route family, one trade.
--
-- The engine priced entries from /swap/v2/order and proved buildability from
-- /swap/v2/build, then booked a fill as though those were one trade. Measured
-- live 2026-08-12 at 0.02 SOL -> USDC, same instant:
--
--   /order  outAmount 1509732  feeBps 2  router metis
--   /build  outAmount 1510066  no fee fields at all
--
-- 334 units apart, different fee models, different route universes. A fill
-- claiming one price and the other's buildability describes a trade that was
-- available on neither.
--
-- Every economic field here comes from ONE response. A leg that is PnL-eligible
-- references exactly one row of this table, and nothing may be assembled by
-- reading two.
CREATE TABLE IF NOT EXISTS execution_observations (
  observation_id           TEXT PRIMARY KEY,
  family                   TEXT NOT NULL
    CHECK (family IN ('ORDER_EXECUTE','BUILD_CUSTOM','DIRECT_VENUE','QUOTE_ONLY_BENCHMARK')),
  mint                     TEXT NOT NULL,
  side                     TEXT NOT NULL CHECK (side IN ('buy','sell')),
  position_id              TEXT,
  shadow_position_id       TEXT,
  purpose                  TEXT NOT NULL,

  input_mint               TEXT NOT NULL,
  output_mint              TEXT NOT NULL,
  -- The EXACT amount requested. Never a probe scaled to something else.
  requested_amount         TEXT NOT NULL,
  expected_output          TEXT,
  minimum_output           TEXT,
  slippage_bps             INTEGER,

  -- As the response reported them. Whether the platform fee is already inside
  -- the amounts above is a property of the FAMILY, not of this row, and
  -- netExpectedOutput() is the only sanctioned way to ask.
  platform_fee_bps         INTEGER,
  platform_fee_amount      TEXT,
  platform_fee_mint        TEXT,
  signature_fee_lamports   TEXT,
  prioritization_fee_lamports TEXT,
  rent_fee_lamports        TEXT,
  broadcaster_tip_lamports TEXT,

  route_plan_hash          TEXT,
  route_labels             TEXT,
  instruction_set_hash     TEXT,
  instruction_count        INTEGER,
  compute_unit_limit       INTEGER,
  estimated_transaction_bytes INTEGER,
  writable_accounts        TEXT,
  lookup_tables            TEXT,

  raw_impact_string        TEXT,
  impact_schema_status     TEXT,
  adverse_impact_bps       REAL,

  blockhash                TEXT,
  last_valid_block_height  INTEGER,
  expire_at                INTEGER,
  context_slot             INTEGER,

  raw_payload_hash         TEXT,
  endpoint                 TEXT NOT NULL,
  request_id               TEXT,

  -- Three separate questions, three separate answers. NOT_RUN and
  -- NOT_SIMULATED are unknowns and never pass as approvals.
  instruction_policy       TEXT NOT NULL CHECK (instruction_policy IN ('PASS','FAIL','NOT_RUN')),
  transaction_policy       TEXT NOT NULL CHECK (transaction_policy IN ('PASS','FAIL','NOT_RUN')),
  simulation               TEXT NOT NULL
    CHECK (simulation IN ('SIMULATED_OK','SIMULATION_FAILED','NOT_SIMULATED')),
  policy_detail            TEXT,
  simulation_detail        TEXT,

  -- Typed rather than collapsed to null: a 429, a timeout, a schema drift and a
  -- genuine no-route are four different facts about two different things.
  failure                  TEXT,

  requested_utc_ms         INTEGER NOT NULL,
  received_utc_ms          INTEGER NOT NULL,
  latency_ms               INTEGER,
  context_hash             TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_mint ON execution_observations(mint, requested_utc_ms);
CREATE INDEX IF NOT EXISTS idx_obs_position ON execution_observations(position_id);
CREATE INDEX IF NOT EXISTS idx_obs_family ON execution_observations(family, side);
CREATE INDEX IF NOT EXISTS idx_obs_failure ON execution_observations(failure);

-- A real shadow book, not a label.
--
-- \`alpha_shadow\` used to be an event written on the realizable portfolio when
-- sizing refused a signal. It followed nothing, so it did not remove the
-- censoring it exists to remove: the engine stops entering after a bad day, and
-- the observations that follow a loss are therefore systematically absent from
-- the sample. A row saying "we did not take this" is not a substitute for
-- tracking what it would have done.
--
-- These positions have their OWN state machine, their own notional, and no
-- shared NAV. They are never summed with the realizable wallet -- the \`book\`
-- column is what makes that summation impossible to write by accident.
CREATE TABLE IF NOT EXISTS shadow_positions (
  shadow_position_id       TEXT PRIMARY KEY,
  book                     TEXT NOT NULL CHECK (book IN ('alpha_shadow','canary_shadow')),
  mint                     TEXT NOT NULL,
  state                    TEXT NOT NULL,
  -- Frozen per book, so a shadow result is a statement about a size someone
  -- could actually have deployed rather than about whatever capital was free.
  notional_lamports        TEXT NOT NULL,
  token_amount             TEXT NOT NULL,
  cost_lamports            TEXT NOT NULL,
  realized_lamports        TEXT,
  peak_value_lamports      TEXT,
  entry_observation_id     TEXT,
  exit_observation_id      TEXT,
  opened_utc_ms            INTEGER NOT NULL,
  closed_utc_ms            INTEGER,
  exit_reason              TEXT,
  diagnostic               TEXT,
  -- Why the realizable portfolio did NOT take this signal. The whole point of
  -- the book is the rows where this is not null.
  portfolio_refusal        TEXT,
  strategy_version         TEXT NOT NULL,
  context_hash             TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_book ON shadow_positions(book, state);
CREATE INDEX IF NOT EXISTS idx_shadow_mint ON shadow_positions(mint, opened_utc_ms);

CREATE TABLE IF NOT EXISTS shadow_marks (
  shadow_mark_id           TEXT PRIMARY KEY,
  shadow_position_id       TEXT NOT NULL REFERENCES shadow_positions(shadow_position_id),
  seq                      INTEGER NOT NULL,
  observed_utc_ms          INTEGER NOT NULL,
  observation_id           TEXT,
  executable_value_lamports TEXT,
  route_available          INTEGER NOT NULL,
  UNIQUE (shadow_position_id, seq)
);

-- Lifecycle repair: an EXIT_BLOCKED position keeps its tokens, its rent and its
-- exposure, and must be re-quoted at a bounded interval. These columns are what
-- lets the engine find it again and rate-limit the retries.
ALTER TABLE positions ADD COLUMN exit_blocked_since_utc_ms INTEGER;
ALTER TABLE positions ADD COLUMN exit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN last_exit_attempt_utc_ms INTEGER;
ALTER TABLE positions ADD COLUMN last_exit_failure TEXT;
ALTER TABLE positions ADD COLUMN entry_observation_id TEXT;
ALTER TABLE positions ADD COLUMN exit_observation_id TEXT;
ALTER TABLE positions ADD COLUMN route_family TEXT;
`,
  },
  {
    id: 9,
    name: 'replay_runs',
    sql: `
-- The machine-generated result of a replay run.
--
-- The canary gate used to infer replay success from the NUMBER of snapshots in
-- the corpus: 1000 rows existing was read as 1000 rows reproducing. Those are
-- different claims, and the second is the one that matters. A gate that infers
-- a result it did not read is the same error as reading a price and calling it
-- a trade.
CREATE TABLE IF NOT EXISTS replay_runs (
  run_id           TEXT PRIMARY KEY,
  run_utc_ms       INTEGER NOT NULL,
  strategy_version TEXT NOT NULL,
  source_commit    TEXT,
  examined         INTEGER NOT NULL,
  replayed         INTEGER NOT NULL,
  divergences      INTEGER NOT NULL,
  unverifiable     INTEGER NOT NULL,
  threw            INTEGER NOT NULL,
  detail           TEXT
);
CREATE INDEX IF NOT EXISTS idx_replay_runs_time ON replay_runs(run_utc_ms);
`,
  },
  {
    id: 10,
    name: 'exact_transaction_assembly',
    sql: `
-- §5 — proof that exact bytes existed, not that an estimate was plausible.
--
-- Every column here is a property of the ASSEMBLED message and none of it can
-- be read off a list of instructions: the fee payer's compiled position, the
-- real signature count, the true packet length, and the account set once
-- address lookup tables are resolved. The previous policy estimated the packet
-- size from the response's structure and could not see any of it.
--
-- \`serialized_transaction_hash\` is a hash of real bytes. It is not a signature,
-- nothing here is signed, and the transaction is never sent.
ALTER TABLE execution_observations ADD COLUMN serialized_transaction_hash TEXT;
ALTER TABLE execution_observations ADD COLUMN message_hash TEXT;
ALTER TABLE execution_observations ADD COLUMN actual_packet_bytes INTEGER;
ALTER TABLE execution_observations ADD COLUMN fee_payer TEXT;
ALTER TABLE execution_observations ADD COLUMN required_signature_count INTEGER;
ALTER TABLE execution_observations ADD COLUMN static_account_keys TEXT;
ALTER TABLE execution_observations ADD COLUMN readonly_accounts TEXT;
ALTER TABLE execution_observations ADD COLUMN assembly_error TEXT;
`,
  },
  {
    id: 11,
    name: 'signal_episodes',
    sql: `
-- §9.2 — one signal is one episode, not one per rescreen.
--
-- Discovery rescreens the same mint every cycle. Each rescreen produced an
-- independent shadow position, so a token eligible for ten minutes became
-- dozens of "trades" that are the same trade observed repeatedly. Averaging
-- over them counts one opinion many times and understates the standard error
-- of everything downstream.
--
-- An episode is (mint, book, cooldown bucket). A genuinely new opportunity in
-- the same mint after the cooldown is a new episode; a rescreen thirty seconds
-- later is not. The UNIQUE constraint makes the duplicate impossible rather
-- than merely discouraged -- the previous defence was that nobody had written
-- the code to duplicate, which is not a defence.
CREATE TABLE IF NOT EXISTS signal_episodes (
  signal_episode_id  TEXT PRIMARY KEY,
  mint               TEXT NOT NULL,
  book               TEXT NOT NULL,
  opened_utc_ms      INTEGER NOT NULL,
  cooldown_bucket    INTEGER NOT NULL,
  screenings_seen    INTEGER NOT NULL DEFAULT 1,
  last_seen_utc_ms   INTEGER NOT NULL,
  context_hash       TEXT,
  UNIQUE (mint, book, cooldown_bucket)
);
CREATE INDEX IF NOT EXISTS idx_episode_mint ON signal_episodes(mint, opened_utc_ms);

ALTER TABLE shadow_positions ADD COLUMN signal_episode_id TEXT;
-- §7 — a buy without a same-family sell is not an entry. Both observations are
-- named on the position, so a row that never proved it could be exited is
-- identifiable rather than merely suspected.
ALTER TABLE shadow_positions ADD COLUMN entry_sell_observation_id TEXT;
ALTER TABLE shadow_positions ADD COLUMN entry_round_trip_loss_bps INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_episode ON shadow_positions(book, signal_episode_id)
  WHERE signal_episode_id IS NOT NULL;
`,
  },
  {
    id: 12,
    name: 'simulation_jobs',
    sql: `
-- The durable record of every simulation this engine asked for.
--
-- Windows remains the only SQLite writer and the authoritative ledger. The
-- daemon keeps a small in-memory cache for retries; it is not a ledger and it
-- does not survive a restart. This table does.
--
-- SIMULATION_REQUESTED is written BEFORE the request leaves, so a crash between
-- send and reply leaves evidence that a job was in flight rather than silence.
-- A row stuck in REQUESTED is a known unknown; a missing row is an unknown
-- unknown, and only one of those can be reconciled.
--
-- (job_id, request_hash) is UNIQUE together: the same job with the same bytes
-- is idempotent, and the same job id with DIFFERENT bytes is a caller defect
-- the database refuses rather than reconciles.
CREATE TABLE IF NOT EXISTS simulation_jobs (
  job_id                   TEXT NOT NULL,
  request_hash             TEXT NOT NULL,
  execution_observation_id TEXT,
  mode                     TEXT NOT NULL,
  status                   TEXT NOT NULL
    CHECK (status IN ('SIMULATION_REQUESTED','SIMULATED_OK','SIMULATION_FAILED',
                      'SIMULATOR_UNAVAILABLE','SIMULATION_UNKNOWN')),
  requested_utc_ms         INTEGER NOT NULL,
  completed_utc_ms         INTEGER,

  snapshot_manifest_hash   TEXT,
  original_transaction_hash TEXT,
  original_blockhash       TEXT,
  blockhash_replaced       INTEGER,
  blockhash_proof_ok       INTEGER,

  simulator_source_sha     TEXT,
  simulator_binary_hash    TEXT,
  simulator_runtime        TEXT,
  simulator_feature_set    TEXT,
  protocol_version         INTEGER,

  units_consumed           INTEGER,
  transaction_error        TEXT,
  runtime_event_digest     TEXT,
  startup_ms               INTEGER,
  simulate_ms              INTEGER,
  total_ms                 INTEGER,
  confirmatory             INTEGER NOT NULL DEFAULT 0,
  confirmatory_refusal     TEXT,
  detail                   TEXT,
  context_hash             TEXT,

  PRIMARY KEY (job_id, request_hash)
);
CREATE INDEX IF NOT EXISTS idx_simjobs_obs ON simulation_jobs(execution_observation_id);
CREATE INDEX IF NOT EXISTS idx_simjobs_status ON simulation_jobs(status, requested_utc_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_simjobs_jobid ON simulation_jobs(job_id);
`,
  },
  {
    id: 13,
    name: 'exact_transaction_blob',
    sql: `
-- §5 — the reference to the EXACT bytes a leg was policy-checked against.
--
-- The row already carries serialized_transaction_hash, which proves the bytes
-- have not changed. It does not let anyone GET them. A hash answers "is this
-- the same transaction"; it cannot answer "what was the transaction", and a
-- simulation needs the second question answered.
--
-- The blob lives outside SQLite under data/blobs/, content-addressed and
-- gzipped. Multi-megabyte payloads in a WAL database make every checkpoint
-- expensive and every backup slower, and this one is already 1.6 GB.
--
-- Nullable, because assembly can legitimately fail and a refusal is still a row
-- worth keeping. A NULL here means the bytes were never captured, which is
-- exactly the condition that must stop a leg being confirmatory.
ALTER TABLE execution_observations ADD COLUMN exact_transaction_blob TEXT;

CREATE INDEX IF NOT EXISTS idx_obs_exact_blob
  ON execution_observations(exact_transaction_blob)
  WHERE exact_transaction_blob IS NOT NULL;
`,
  },
  {
    id: 14,
    name: 'age_cohorts',
    sql: `
-- §16 — the age cohort a position was opened in, frozen at open time.
--
-- Frozen deliberately. A position opened at four minutes old is a four-minute
-- experiment for its whole life; recomputing the cohort later from the token's
-- current age would migrate it into an older bucket while it is still running
-- and silently change what the bucket means.
--
-- Cohorts are never pooled. A token four minutes old and one four days old are
-- different populations: the older one has SURVIVED, and conditioning on
-- survival changes the holder set, the creator's demonstrated behaviour, and
-- whether the liquidity has been tested by anyone but us.
--
-- AGE_UNKNOWN is its own value and is not the youngest cohort. Absent is not
-- young.
ALTER TABLE shadow_positions ADD COLUMN cohort TEXT;
ALTER TABLE positions        ADD COLUMN cohort TEXT;
ALTER TABLE shadow_positions ADD COLUMN token_age_ms_at_open INTEGER;

CREATE INDEX IF NOT EXISTS idx_shadow_cohort ON shadow_positions(cohort, state);
`,
  },
  {
    id: 15,
    name: 'reject_outcome_classification',
    sql: `
-- §17 — what actually happened, classified, rather than inferred from a NULL.
--
-- price_usd is nullable, and a NULL price read as a number is zero, and zero
-- means the token went to nothing. Every gate then looks brilliant: the things
-- it rejected all "went to zero", when what happened is a provider stopped
-- answering about them.
--
-- That error always flatters the gates, and it is largest exactly where the
-- data is thinnest, so it survives any check that asks whether the numbers look
-- plausible.
--
-- NULL outcome means a row predates the classifier. It is NOT 'UNKNOWN': one
-- says nobody has looked, the other says somebody looked and could not tell.
ALTER TABLE reject_tracking ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN
    ('EXECUTABLE_VALUE','NO_ROUTE_CONFIRMED','POOL_DRAIN_CONFIRMED',
     'PROVIDER_MISSING','SOURCE_GAP','UNBUILDABLE','UNKNOWN'));
ALTER TABLE reject_tracking ADD COLUMN executable_value_lamports TEXT;
ALTER TABLE reject_tracking ADD COLUMN provider_answered INTEGER;
ALTER TABLE reject_tracking ADD COLUMN buildable INTEGER;
ALTER TABLE reject_tracking ADD COLUMN pool_reserves_lamports TEXT;

CREATE INDEX IF NOT EXISTS idx_reject_outcome ON reject_tracking(outcome, horizon_ms);
`,
  },
  {
    id: 16,
    name: 'simulation_validity',
    sql: `
-- P1 — whether a simulation measured the market or measured the instrument.
--
-- Every job written before the P2 repair described no economic leg: the
-- requested amount was the string '0' and the only balance mutation was SOL,
-- whatever the transaction actually spent. So every BUY was funded correctly
-- and every SELL was asked to spend an asset it had never been given. The
-- failures were uniform -- the same error at the same instruction index, across
-- every venue, mint and size -- which is the signature of an apparatus rather
-- than a market.
--
-- The rows are kept. They are evidence about a defect that was fixed, and
-- deleting them would erase the only proof the corpus was ever wrong. What they
-- must never do is act as evidence about a token, a route or a threshold.
--
-- NULL is not permitted going forward: a job that does not say whether it is
-- measuring anything is exactly the failure this column exists to prevent.
ALTER TABLE simulation_jobs ADD COLUMN validity TEXT
  CHECK (validity IS NULL OR validity IN
    ('INSTRUMENT_DEVELOPMENT','VALID_DEVELOPMENT','VALID_CONFIRMATORY'));

-- Every pre-existing row, without exception. The buys that "passed" are
-- included: a run whose bounds were vacuous did not pass an economic test, it
-- merely failed to violate one that was never stated.
UPDATE simulation_jobs SET validity = 'INSTRUMENT_DEVELOPMENT' WHERE validity IS NULL;

CREATE INDEX IF NOT EXISTS idx_simjobs_validity ON simulation_jobs(validity, status);
`,
  },
  {
    id: 17,
    name: 'simulation_effect',
    sql: `
-- P3 -- runtime success is not economic success.
--
-- A Solana runtime returning no transaction error proves the instructions did
-- not abort. It does not prove the taker received anything, that the debit was
-- the intended one, that the fee is fully attributable, or that value did not
-- move somewhere nobody was watching. Those are four questions, and every one
-- of them was previously collapsed into 'SIMULATED_OK' and read as "the leg
-- works" by the exit gate, the shadow book and the readiness check.
--
-- Stored rather than derived on read, because a verdict recomputed later is
-- recomputed under whatever the code believes TODAY, and the question a job has
-- to answer is what was actually established at the time.
ALTER TABLE simulation_jobs ADD COLUMN runtime_ok            INTEGER;
ALTER TABLE simulation_jobs ADD COLUMN effect_ok             INTEGER;
ALTER TABLE simulation_jobs ADD COLUMN fee_decomposition_ok  INTEGER;
ALTER TABLE simulation_jobs ADD COLUMN account_coverage_ok   INTEGER;
ALTER TABLE simulation_jobs ADD COLUMN simulated_effect_ok   INTEGER;
ALTER TABLE simulation_jobs ADD COLUMN effect_refusals       TEXT;

-- The measured economics. TEXT because these are lamport and raw-unit amounts
-- and SQLite INTEGER is 64-bit SIGNED -- a u64 near its ceiling silently
-- becomes negative, and a negative fee is not a number this system can notice
-- is wrong.
ALTER TABLE simulation_jobs ADD COLUMN input_debit             TEXT;
ALTER TABLE simulation_jobs ADD COLUMN output_credit           TEXT;
ALTER TABLE simulation_jobs ADD COLUMN base_fee_lamports       TEXT;
ALTER TABLE simulation_jobs ADD COLUMN priority_fee_lamports   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN tip_lamports            TEXT;
ALTER TABLE simulation_jobs ADD COLUMN rent_created_lamports   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN rent_recovered_lamports TEXT;
ALTER TABLE simulation_jobs ADD COLUMN transfer_fee_lamports   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN withheld_fee_lamports   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN unexpected_movement_lamports TEXT;
ALTER TABLE simulation_jobs ADD COLUMN unexpected_recipients   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN unobserved_accounts     TEXT;
ALTER TABLE simulation_jobs ADD COLUMN bounds_violations       TEXT;

-- Pre/post balances, so the verdict can be re-derived from what was seen rather
-- than believed. A verdict nobody can re-derive is an assertion.
ALTER TABLE simulation_jobs ADD COLUMN pre_sol_balances    TEXT;
ALTER TABLE simulation_jobs ADD COLUMN post_sol_balances   TEXT;
ALTER TABLE simulation_jobs ADD COLUMN pre_token_balances  TEXT;
ALTER TABLE simulation_jobs ADD COLUMN post_token_balances TEXT;
ALTER TABLE simulation_jobs ADD COLUMN created_accounts    TEXT;
ALTER TABLE simulation_jobs ADD COLUMN closed_accounts     TEXT;

CREATE INDEX IF NOT EXISTS idx_simjobs_effect ON simulation_jobs(simulated_effect_ok, validity);

-- The observation's own verdict. SIMULATED_OK stays as it was -- it is still a
-- true statement about the runtime -- and SIMULATED_EFFECT_OK is the strictly
-- stronger claim that legIsExecutable() requires.
--
-- SQLite cannot alter a CHECK constraint in place, so the column is widened by
-- rebuilding the check through a new column rather than by dropping the old
-- constraint and losing it entirely.
ALTER TABLE execution_observations ADD COLUMN simulation_effect TEXT
  CHECK (simulation_effect IS NULL OR simulation_effect IN
    ('SIMULATED_EFFECT_OK','EFFECT_REFUSED','NOT_VERIFIED'));
ALTER TABLE execution_observations ADD COLUMN simulation_effect_refusals TEXT;

-- Every pre-existing observation. Not 'EFFECT_REFUSED': nobody ran the check,
-- which is a different fact from running it and failing.
UPDATE execution_observations SET simulation_effect = 'NOT_VERIFIED' WHERE simulation_effect IS NULL;

CREATE INDEX IF NOT EXISTS idx_obs_effect ON execution_observations(simulation_effect);
`,
  },
  {
    id: 18,
    name: 'mark_source',
    sql: `
-- P9 -- what actually priced the mark that drove the decision.
--
-- Marks came from the /order quote: a router's opinion about a swap nobody
-- built. Stop, trail, take-profit, collapse, peak and NAV all read it, so every
-- exit rule in the system was reacting to a number that had never been through
-- policy, had never been simulated, and might not correspond to a transaction
-- that can be assembled at all.
--
-- /order is still recorded. It is a benchmark -- useful precisely because it is
-- cheap and available -- and the difference between it and the executable mark
-- is itself a measurement worth having. It is no longer decision-bearing.
ALTER TABLE position_marks ADD COLUMN mark_source TEXT
  CHECK (mark_source IS NULL OR mark_source IN ('BUILD_CUSTOM_SELL','PUMP_DIRECT','ORDER_QUOTE_BENCHMARK'));
ALTER TABLE position_marks ADD COLUMN mark_observation_id TEXT;
-- The benchmark, kept beside the executable mark so the gap can be measured
-- rather than assumed.
ALTER TABLE position_marks ADD COLUMN benchmark_order_lamports TEXT;
ALTER TABLE position_marks ADD COLUMN benchmark_minus_executable_bps INTEGER;
-- Whether this mark may drive a stop, a trail, a peak or NAV.
ALTER TABLE position_marks ADD COLUMN decision_bearing INTEGER;

-- Every existing mark. They were priced by /order and nothing else, and
-- relabelling them as executable would be inventing evidence.
UPDATE position_marks SET mark_source = 'ORDER_QUOTE_BENCHMARK', decision_bearing = 0
  WHERE mark_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_marks_source ON position_marks(mark_source, decision_bearing);
`,
  },
  {
    id: 19,
    name: 'cohort_provenance',
    sql: `
-- P15 -- where a cohort came from, so a NULL cannot be quietly filled later.
--
-- 965 shadow positions carry no cohort. They are not unassigned in the sense of
-- a missing measurement: they were opened before the cohort feature existed, and
-- no age was recorded at their open either. The feature has assigned a cohort to
-- every shadow opened since.
--
-- The distinction matters because the obvious repair is to match each old
-- position to the nearest decision snapshot by mint and time and derive an age
-- from it. That is inference, not re-derivation: nothing links a shadow position
-- to the snapshot that produced it, so the join would be a guess about which
-- screening was probably the one. A cohort assigned that way looks exactly like
-- a measured one and is not, which is the error this whole corpus was rebuilt
-- to remove.
--
-- So the rows stay NULL and say why.
ALTER TABLE shadow_positions ADD COLUMN cohort_source TEXT
  CHECK (cohort_source IS NULL OR cohort_source IN ('ASSIGNED_AT_OPEN','PREDATES_FEATURE'));

UPDATE shadow_positions SET cohort_source = 'ASSIGNED_AT_OPEN' WHERE cohort IS NOT NULL;
UPDATE shadow_positions SET cohort_source = 'PREDATES_FEATURE' WHERE cohort IS NULL;

CREATE INDEX IF NOT EXISTS idx_shadow_cohort ON shadow_positions(cohort, cohort_source);
`,
  },
  {
    id: 20,
    name: 'shadow_evidence_class',
    sql: `
-- P10 -- the evidence class a shadow qualified for AT OPEN, stored.
--
-- It was derived at report time by joining back to the simulation jobs. That
-- derivation runs under whatever the code believes today, so a shadow opened
-- when nothing was effect-verified would silently become JIT_EFFECT_VALID the
-- moment a later run of the same observation passed. The class is a property of
-- what was established when the position was opened, and it must not drift.
--
-- Never aggregated across classes. A structural shadow and an effect-verified
-- one are not two of the same thing, and adding them gives a number that
-- describes neither.
ALTER TABLE shadow_positions ADD COLUMN evidence_class TEXT
  CHECK (evidence_class IS NULL OR evidence_class IN
    ('STRUCTURAL_ONLY','JIT_EFFECT_VALID','OFFLINE_REPRODUCIBLE','CONFIRMATORY'));

-- Every existing row. All of them were opened on simulations that described no
-- economic leg, so STRUCTURAL_ONLY is not a default here -- it is the answer.
UPDATE shadow_positions SET evidence_class = 'STRUCTURAL_ONLY' WHERE evidence_class IS NULL;

CREATE INDEX IF NOT EXISTS idx_shadow_evidence ON shadow_positions(evidence_class, book);
`,
  },
  {
    id: 21,
    name: 'structured_token_balances',
    sql: `
-- P2 -- token balances with their identity attached.
--
-- The columns being replaced held two JSON maps keyed by TOKEN-ACCOUNT PUBKEY.
-- The effect verifier looked them up by owner:mint. Two ends of one wire,
-- two meanings for one key, and a lookup that could never match: every token
-- delta read as unobserved, and a buy that credited its ATA exactly as intended
-- was refused for "output delta is missing".
--
-- A map key is a place for that to hide. These columns hold arrays of rows that
-- each carry tokenAccount, owner, mint, tokenProgram and amount, so nothing
-- downstream has to reconstruct an identity from a string.
--
-- The old columns are KEPT. They are the evidence of what the daemon actually
-- sent while the defect was live, and deleting them would erase the only proof
-- the corpus was wrong.
ALTER TABLE simulation_jobs ADD COLUMN pre_token_accounts  TEXT;
ALTER TABLE simulation_jobs ADD COLUMN post_token_accounts TEXT;
-- Resolved deltas, so a reader does not have to re-run the aggregation to see
-- what the run concluded about each asset.
ALTER TABLE simulation_jobs ADD COLUMN token_deltas TEXT;
`,
  },
  {
    id: 22,
    name: 'explicit_pnl_fields',
    sql: `
-- P12/P13 -- PnL that cannot be misread as gross proceeds.
--
-- realized_lamports was read two ways. The readiness gate computed
-- realized minus cost, which subtracts the principal a SECOND time when the
-- column already holds the net result: a position that cost 20,000,000 and
-- returned 1,000,000 of profit scored as a 19,000,000 loss. Every gate
-- downstream -- net PnL, profit factor, log growth, drawdown, every robustness
-- check -- then described a strategy that does not exist.
--
-- A column whose meaning has to be inferred from its caller is a column that
-- will be inferred wrongly. These say what they are.
ALTER TABLE positions ADD COLUMN net_pnl_lamports TEXT;
-- What it cost to EXECUTE: fees, tip, unrecovered rent, failure cost. This is
-- what a 2x cost stress doubles. Doubling the principal is not a cost stress,
-- it is a different trade, and it is a test no strategy can pass.
ALTER TABLE positions ADD COLUMN execution_cost_lamports TEXT;
-- Gross proceeds of the exit, before any cost. Kept separate so the three
-- quantities can never collapse into one another again.
ALTER TABLE positions ADD COLUMN gross_proceeds_lamports TEXT;

CREATE INDEX IF NOT EXISTS idx_positions_pnl ON positions(closed_utc_ms, net_pnl_lamports);
`,
  },
  {
    id: 23,
    name: 'confirmatory_positions_v1',
    sql: `
-- P14 -- ONE definition of confirmatory evidence.
--
-- The clauses lived in five places: legIsConfirmatory, the readiness SQL,
-- canaryEvidenceGates, the report queries and the capability matrix. Five
-- copies of one definition is five chances to drift, and the way you discover
-- they have drifted is that the gate refuses a position the report already
-- counted -- or worse, the other way round.
--
-- A VIEW is the right shape for this because it cannot be partially adopted.
-- A caller either reads it or does not, and one that does not is visible in a
-- grep rather than hidden inside a WHERE clause that looks similar enough.
--
-- Every clause is a requirement and the joins are inner: a position missing its
-- entry or exit observation does not partially qualify.
CREATE VIEW IF NOT EXISTS confirmatory_positions_v1 AS
SELECT
  p.position_id,
  p.mint,
  p.cost_lamports,
  p.realized_lamports,
  p.net_pnl_lamports,
  p.execution_cost_lamports,
  p.gross_proceeds_lamports,
  p.opened_utc_ms,
  p.closed_utc_ms,
  p.cohort,
  e.family                AS family,
  e.observation_id        AS entry_observation_id,
  x.observation_id        AS exit_observation_id,
  c.source_commit         AS source_commit,
  c.context_hash          AS context_hash
FROM positions p
JOIN execution_observations e ON e.observation_id = p.entry_observation_id
JOIN execution_observations x ON x.observation_id = p.exit_observation_id
JOIN run_contexts c           ON c.context_hash   = p.context_hash
JOIN simulation_jobs je       ON je.execution_observation_id = e.observation_id
JOIN simulation_jobs jx       ON jx.execution_observation_id = x.observation_id
WHERE
  -- closed, and holding nothing. A residual balance is exposure whatever the
  -- state column says.
  p.closed_utc_ms IS NOT NULL
  AND CAST(p.token_amount AS INTEGER) = 0
  -- a clean commit: a dirty tree is not reproducible
  AND c.source_commit NOT LIKE '%+dirty'
  -- one family from entry through exit
  AND e.family = x.family
  AND e.side = 'buy' AND x.side = 'sell'
  -- both policies passed on both legs
  AND e.instruction_policy = 'PASS' AND x.instruction_policy = 'PASS'
  AND e.transaction_policy = 'PASS' AND x.transaction_policy = 'PASS'
  -- the ECONOMIC verdict, not merely the runtime one
  AND e.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND x.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
  -- reproducible: a frozen snapshot, not a moving chain
  AND je.confirmatory = 1 AND jx.confirmatory = 1
  AND je.validity = 'VALID_CONFIRMATORY' AND jx.validity = 'VALID_CONFIRMATORY'
  -- every writable observed on both sides
  AND je.account_coverage_ok = 1 AND jx.account_coverage_ok = 1
  -- the exact bytes, retained
  AND e.exact_transaction_blob IS NOT NULL AND x.exact_transaction_blob IS NOT NULL
  AND e.raw_payload_hash IS NOT NULL AND x.raw_payload_hash IS NOT NULL
  -- costs known: a net PnL that has to be inferred is not a measurement
  AND p.net_pnl_lamports IS NOT NULL
  -- no unresolved clock discontinuity anywhere in the corpus
  AND NOT EXISTS (
    SELECT 1 FROM clock_checkpoints k
    WHERE k.resync_required = 1 AND k.resync_done_utc_ms IS NULL
  );
`,
  },
  {
    id: 24,
    name: 'jit_snapshot_manifest',
    sql: `
-- P7 -- the exact state a JIT run executed against, persisted here rather than
-- only inside the response that reported it.
--
-- A response is transient. The ledger is not, and an offline replay months from
-- now has to restore what the run actually saw, not what a later read of the
-- same accounts returns. Those are different states and the difference is the
-- whole reason offline replay exists.
--
-- A successful JIT job whose snapshot could not be stored is
-- JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE. It is real evidence about the strategy
-- and it is not offline evidence, and the distinction is a column rather than
-- something a reader has to infer from an absence.
CREATE TABLE IF NOT EXISTS snapshot_manifests (
  manifest_hash        TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  created_utc_ms       INTEGER NOT NULL,
  -- Every account blob, content-addressed. The blob store holds the bytes.
  account_count        INTEGER NOT NULL,
  account_blob_hashes  TEXT NOT NULL,
  -- Programs, their ProgramData and their ELF hashes, so a replay can redeploy
  -- from code rather than hope the runtime happens to have it.
  program_count        INTEGER NOT NULL,
  program_manifest     TEXT NOT NULL,
  -- Lookup tables: the account bytes AND the addresses they resolved to. A
  -- table that was extended since resolves differently, which is why the
  -- resolved list is stored rather than re-derived.
  lookup_table_manifest TEXT,
  -- Time. When the provider omits contextSlot this is an interval, never a
  -- point, and a later account read is never called "the state at the build".
  execution_slot       INTEGER,
  build_requested_utc_ms INTEGER,
  build_received_utc_ms  INTEGER,
  capture_slot_low     INTEGER,
  capture_slot_high    INTEGER,
  max_observed_drift_slots INTEGER,
  -- Read back and verified after writing. A blob nobody re-read is a blob
  -- nobody knows is there.
  readback_verified    INTEGER NOT NULL DEFAULT 0,
  omissions            TEXT
);

CREATE INDEX IF NOT EXISTS idx_manifest_job ON snapshot_manifests(job_id);

-- Whether this job's snapshot is durable enough to replay from.
ALTER TABLE simulation_jobs ADD COLUMN replayable TEXT
  CHECK (replayable IS NULL OR replayable IN
    ('REPLAYABLE','JIT_EFFECT_VALID_BUT_NOT_REPLAYABLE','NOT_APPLICABLE'));
`,
  },
  {
    id: 25,
    name: 'explicit_position_economics',
    sql: `
-- P9 -- the whole cash flow of a position, named.
--
-- Migration 22 added net_pnl_lamports, execution_cost_lamports and
-- gross_proceeds_lamports and no writer populated them. A migrated-but-unwritten
-- column is worse than a missing one: its existence reads as evidence the
-- number is kept, and every reader either recomputed PnL its own way or read
-- NULL and reported zero.
--
-- These four complete the identity, so nothing has to be re-derived:
--
--   net_pnl_lamports = exit_cash_in_lamports - entry_cash_out_lamports
--
-- with locked and recovered rent identified SEPARATELY, because rent is
-- capital the account holds rather than a cost the market charged, and netting
-- it into either side hides the distinction that decides whether a 3,688 bps
-- round trip is really a 363 bps one.
--
-- NULL means undetermined. It never means zero. An open position has no exit
-- cash in, and a leg whose residual was not observed has no residual of zero.
ALTER TABLE positions ADD COLUMN entry_cash_out_lamports TEXT;
ALTER TABLE positions ADD COLUMN exit_cash_in_lamports TEXT;
ALTER TABLE positions ADD COLUMN locked_rent_lamports TEXT;
ALTER TABLE positions ADD COLUMN residual_token_atoms TEXT;

-- P11 -- an episode ends, so a genuinely new signal after the cooldown can
-- start one. Without a close, every mint ever screened stays one episode
-- forever; with only a wall-clock bucket, 14:59 and 15:01 were two.
ALTER TABLE signal_episodes ADD COLUMN closed_utc_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_episode_open ON signal_episodes(mint, book, closed_utc_ms);

`,
  },

  {
    id: 26,
    name: 'exploration_trigger_fill_and_confirmatory_v2',
    sql: `
-- Migration 25 had ALREADY RUN in the live database when these statements were
-- appended to it, so they never executed. Migrations are recorded by id and
-- skipped once applied: editing an applied one leaves the schema believing it
-- is current while the columns do not exist.
--
-- That is the same defect this directive is about, in the schema layer -- and
-- it was caught the same way, by checking the running database rather than the
-- source. Everything below is in a NEW migration so it actually applies.
-- P17 -- which arm bought this screening, and with what probability.
--
-- The whole quote budget went to the highest-liquidity survivors, so the
-- corpus could only answer "how do high-liquidity survivors perform". It could
-- not answer what the gates refused that would have worked, because a gate
-- evaluated only on what it admitted is evaluated on its own output.
--
-- inclusion_probability is what makes the sample reweightable. A biased
-- sample whose bias is unrecorded is worse than no sample: it looks like
-- evidence.
ALTER TABLE screenings ADD COLUMN selection_arm TEXT;
ALTER TABLE screenings ADD COLUMN inclusion_probability REAL;
ALTER TABLE screenings ADD COLUMN selection_stratum TEXT;
CREATE INDEX IF NOT EXISTS idx_screening_arm ON screenings(selection_arm, evaluated_utc_ms);

-- P10 -- an exit TRIGGER is not an exit FILL.
--
-- The engine observed a route, decided to exit, and closed against that same
-- observation. That is a fill at the instant of noticing, with no reaction,
-- build, simulation, signature or landing in between. Every exit in the corpus
-- was priced at a moment no real exit could have reached.
--
-- The trigger is now persisted and the fill must come from a LATER
-- same-family observation, at least FROZEN_FILL_LATENCY_MS after it. These
-- columns are what survives a restart between the two.
ALTER TABLE positions ADD COLUMN exit_triggered_utc_ms INTEGER;
ALTER TABLE positions ADD COLUMN exit_trigger_observation_id TEXT;
ALTER TABLE positions ADD COLUMN exit_trigger_reason TEXT;
ALTER TABLE positions ADD COLUMN exit_fill_latency_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_positions_triggered ON positions(state, exit_triggered_utc_ms);

-- P21 -- confirmatory_positions_v2.
--
-- v1 is kept and unchanged: rows already counted under it must not silently
-- change meaning, and a view that is edited in place rewrites history.
--
-- v2 adds what this directive made available and therefore required:
--
--   the EXPLICIT cash flow, so PnL is read rather than inferred
--   the identity net = cash in - cash out, checked in the view itself
--   a durable replay manifest on both legs
--   no residual atoms
--   a trigger that is not the fill
--   a frozen strategy and cohort
--
-- Every clause is a requirement and the joins are inner: a position missing
-- its entry or exit observation does not partially qualify.
CREATE VIEW IF NOT EXISTS confirmatory_positions_v2 AS
SELECT
  p.position_id, p.mint, p.cost_lamports, p.realized_lamports,
  p.net_pnl_lamports, p.execution_cost_lamports, p.gross_proceeds_lamports,
  p.entry_cash_out_lamports, p.exit_cash_in_lamports, p.locked_rent_lamports,
  p.residual_token_atoms, p.exit_fill_latency_ms,
  p.opened_utc_ms, p.closed_utc_ms, p.cohort, p.strategy_version,
  e.family AS family,
  e.observation_id AS entry_observation_id,
  x.observation_id AS exit_observation_id,
  c.source_commit AS source_commit,
  c.context_hash  AS context_hash
FROM positions p
JOIN execution_observations e ON e.observation_id = p.entry_observation_id
JOIN execution_observations x ON x.observation_id = p.exit_observation_id
JOIN run_contexts c           ON c.context_hash   = p.context_hash
JOIN simulation_jobs je       ON je.execution_observation_id = e.observation_id
JOIN simulation_jobs jx       ON jx.execution_observation_id = x.observation_id
WHERE
  p.closed_utc_ms IS NOT NULL
  AND CAST(p.token_amount AS INTEGER) = 0
  AND c.source_commit NOT LIKE '%+dirty'
  AND e.family = x.family
  AND e.side = 'buy' AND x.side = 'sell'
  AND e.instruction_policy = 'PASS' AND x.instruction_policy = 'PASS'
  AND e.transaction_policy = 'PASS' AND x.transaction_policy = 'PASS'
  AND e.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND x.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND je.simulated_effect_ok = 1 AND jx.simulated_effect_ok = 1
  AND je.confirmatory = 1 AND jx.confirmatory = 1
  AND je.validity = 'VALID_CONFIRMATORY' AND jx.validity = 'VALID_CONFIRMATORY'
  AND je.account_coverage_ok = 1 AND jx.account_coverage_ok = 1
  AND e.exact_transaction_blob IS NOT NULL AND x.exact_transaction_blob IS NOT NULL
  AND e.raw_payload_hash IS NOT NULL AND x.raw_payload_hash IS NOT NULL
  -- P9: every explicit field present. A NULL here is undetermined, and an
  -- undetermined cash flow is not evidence.
  AND p.net_pnl_lamports IS NOT NULL
  AND p.entry_cash_out_lamports IS NOT NULL
  AND p.exit_cash_in_lamports IS NOT NULL
  AND p.locked_rent_lamports IS NOT NULL
  -- the identity, checked rather than trusted
  AND CAST(p.net_pnl_lamports AS INTEGER)
      = CAST(p.exit_cash_in_lamports AS INTEGER) - CAST(p.entry_cash_out_lamports AS INTEGER)
  -- P5: nothing left behind. A residual balance is exposure whatever the
  -- state column says, and NULL means nobody looked.
  AND p.residual_token_atoms IS NOT NULL
  AND CAST(p.residual_token_atoms AS INTEGER) = 0
  -- P10: the trigger is not the fill. A position with no recorded trigger
  -- closed against the observation that triggered it.
  AND p.exit_triggered_utc_ms IS NOT NULL
  AND p.exit_fill_latency_ms IS NOT NULL
  AND p.exit_fill_latency_ms >= 1200
  -- P24: one frozen arm. A mixture of strategy versions is not a sample.
  AND p.strategy_version IS NOT NULL
  AND p.cohort IS NOT NULL
  -- replayable: a durable manifest on BOTH legs, not a JIT run that happened
  -- to succeed
  AND je.snapshot_manifest_hash IS NOT NULL AND jx.snapshot_manifest_hash IS NOT NULL
  AND je.replayable = 'REPLAYABLE' AND jx.replayable = 'REPLAYABLE'
  AND NOT EXISTS (
    SELECT 1 FROM clock_checkpoints k
    WHERE k.resync_required = 1 AND k.resync_done_utc_ms IS NULL
  );
`,
  },

  {
    id: 27,
    name: 'direct_chain_events',
    sql: `
-- P12 -- the signal clock, from the chain.
--
-- Discovery is a 30-second poll of a provider's feeds, and every candidate's
-- age is whatever that provider's updatedAt says. The clock the strategy
-- reacts to is somebody else's polling interval rather than the event.
--
-- logsSubscribe on the Pump and PumpSwap programs gives the event at
-- processed, with a slot. That is the earliest an alarm can exist.
--
-- commitment is stored because processed CAN be reverted. A row that does not
-- say which commitment it arrived at cannot be reconciled later, and treating
-- processed as settled is how a reorg becomes a fill.
CREATE TABLE IF NOT EXISTS direct_chain_events (
  signature             TEXT NOT NULL,
  program_id            TEXT NOT NULL,
  slot                  INTEGER NOT NULL,
  instruction           TEXT,
  kind                  TEXT NOT NULL,
  commitment            TEXT NOT NULL,
  -- Monotonic, so a wall-clock adjustment cannot reorder the corpus.
  received_monotonic_ms INTEGER NOT NULL,
  received_utc_ms       INTEGER NOT NULL,
  tx_error              TEXT,
  -- Set when a later read at confirmed/finalized disagrees with what
  -- processed reported. NULL means not yet reconciled, which is not the same
  -- as reconciled and fine.
  reversal_status       TEXT,
  PRIMARY KEY (signature, program_id)
);
CREATE INDEX IF NOT EXISTS idx_direct_events_slot ON direct_chain_events(slot);
CREATE INDEX IF NOT EXISTS idx_direct_events_kind ON direct_chain_events(kind, received_utc_ms);
`,
  },

  {
    id: 28,
    name: 'bounded_event_pipeline',
    sql: `
-- P8 -- compact, decision-useful events instead of a firehose.
--
-- The previous build wrote every raw notification synchronously to this
-- database: 1,055 events/second, 6,981,407 rows in 111 minutes, a projected
-- 91 million rows/day, and 2.97 GB -> 6.15 GB in one session. Sixty-eight per
-- cent were UNKNOWN. The decision-useful yield was 43 migration events.
--
-- direct_chain_events is RETAINED but no longer written by the engine. The
-- rows already there are evidence of what the firehose did and deleting them
-- would erase the finding.
CREATE TABLE IF NOT EXISTS chain_events (
  signature             TEXT NOT NULL,
  program_id            TEXT NOT NULL,
  slot                  INTEGER NOT NULL,
  kind                  TEXT NOT NULL,
  instruction           TEXT,
  -- The identity a decision needs. NULL means the logs did not name one, which
  -- is why an event without either is dropped rather than stored.
  mint                  TEXT,
  pool                  TEXT,
  commitment            TEXT NOT NULL,
  received_monotonic_ms INTEGER NOT NULL,
  received_utc_ms       INTEGER NOT NULL,
  tx_error              TEXT,
  -- Set when a later read at confirmed/finalized disagrees with processed.
  reversal_status       TEXT,
  PRIMARY KEY (signature, program_id)
);
CREATE INDEX IF NOT EXISTS idx_chain_events_mint ON chain_events(mint, received_utc_ms);
CREATE INDEX IF NOT EXISTS idx_chain_events_kind ON chain_events(kind, received_utc_ms);

-- Aggregate flow, so throughput is measurable without keeping every row.
CREATE TABLE IF NOT EXISTS chain_flow_bars (
  bucket_utc_ms         INTEGER NOT NULL,
  program_id            TEXT NOT NULL,
  trades                INTEGER NOT NULL DEFAULT 0,
  migrations            INTEGER NOT NULL DEFAULT 0,
  launches              INTEGER NOT NULL DEFAULT 0,
  configs               INTEGER NOT NULL DEFAULT 0,
  unknown               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_utc_ms, program_id)
);

-- What the pipeline dropped, and why. A dropped event is a coverage fact.
CREATE TABLE IF NOT EXISTS chain_pipeline_health (
  observed_utc_ms       INTEGER PRIMARY KEY,
  received              INTEGER NOT NULL,
  parsed                INTEGER NOT NULL,
  unknown               INTEGER NOT NULL,
  duplicates            INTEGER NOT NULL,
  dropped               INTEGER NOT NULL,
  persisted             INTEGER NOT NULL,
  queue_high_water      INTEGER NOT NULL,
  bytes_in              INTEGER NOT NULL
);

-- A bounded sample of what the parser could NOT name, so it stays auditable.
CREATE TABLE IF NOT EXISTS chain_unknown_samples (
  signature             TEXT PRIMARY KEY,
  program_id            TEXT NOT NULL,
  slot                  INTEGER NOT NULL,
  logs_json             TEXT NOT NULL,
  received_utc_ms       INTEGER NOT NULL
);
`,
  },

  {
    id: 29,
    name: 'flow_bars_by_mint',
    sql: `
-- P8 -- trades are AGGREGATED, not stored.
--
-- Trades outnumber every other kind by two orders of magnitude and no decision
-- reads an individual one: the candidate queue wants launches, migration age
-- wants migrations, and the flow signal wants COUNTS per mint per interval.
-- Storing each trade reproduced the firehose at a seventh of the size, which
-- is still 19 million rows a day.
--
-- A NEW table rather than a rebuilt one. The v1 bars keep the 46 rows they
-- already hold: the project guard refuses destructive SQL against the ledger,
-- and it is right to - dropping a table to change a primary key is exactly the
-- move that loses data nobody noticed was load-bearing.
CREATE TABLE IF NOT EXISTS chain_flow_bars_v2 (
  bucket_utc_ms         INTEGER NOT NULL,
  program_id            TEXT NOT NULL,
  -- Empty string when the logs did not name a mint. Never NULL, so the
  -- primary key stays usable.
  mint                  TEXT NOT NULL DEFAULT '',
  trades                INTEGER NOT NULL DEFAULT 0,
  migrations            INTEGER NOT NULL DEFAULT 0,
  launches              INTEGER NOT NULL DEFAULT 0,
  configs               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_utc_ms, program_id, mint)
);
CREATE INDEX IF NOT EXISTS idx_flow_bars_v2_mint ON chain_flow_bars_v2(mint, bucket_utc_ms);
`,
  },

  {
    id: 30,
    name: 'confirmatory_positions_v3',
    sql: `
-- P16 -- one position, one row.
--
-- v1 and v2 JOIN simulation_jobs on the observation id. An observation has up
-- to THREE simulation jobs in the live corpus, so a position with three
-- qualifying entry jobs and three qualifying exit jobs produces NINE rows -
-- and every count, every mean and every bootstrap over that view is inflated
-- by a factor nobody can see from the outside.
--
-- v3 uses EXISTS. The qualifying job is a CONDITION on the position, not a row
-- multiplied into it, so the cardinality is the position's own.
--
-- v1 and v2 are retained unchanged: a view edited in place rewrites history.
CREATE VIEW IF NOT EXISTS confirmatory_positions_v3 AS
SELECT
  p.position_id, p.mint, p.cost_lamports, p.realized_lamports,
  p.net_pnl_lamports, p.execution_cost_lamports, p.gross_proceeds_lamports,
  p.entry_cash_out_lamports, p.exit_cash_in_lamports, p.locked_rent_lamports,
  p.residual_token_atoms, p.exit_fill_latency_ms,
  p.opened_utc_ms, p.closed_utc_ms, p.cohort, p.strategy_version,
  e.family AS family,
  e.observation_id AS entry_observation_id,
  x.observation_id AS exit_observation_id,
  c.source_commit  AS source_commit,
  c.context_hash   AS context_hash
FROM positions p
JOIN execution_observations e ON e.observation_id = p.entry_observation_id
JOIN execution_observations x ON x.observation_id = p.exit_observation_id
JOIN run_contexts c           ON c.context_hash   = p.context_hash
WHERE
  p.closed_utc_ms IS NOT NULL
  AND CAST(p.token_amount AS INTEGER) = 0
  AND c.source_commit NOT LIKE '%+dirty'
  AND e.family = x.family
  AND e.side = 'buy' AND x.side = 'sell'
  AND e.instruction_policy = 'PASS' AND x.instruction_policy = 'PASS'
  AND e.transaction_policy = 'PASS' AND x.transaction_policy = 'PASS'
  AND e.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND x.simulation_effect = 'SIMULATED_EFFECT_OK'
  AND e.exact_transaction_blob IS NOT NULL AND x.exact_transaction_blob IS NOT NULL
  AND e.raw_payload_hash IS NOT NULL AND x.raw_payload_hash IS NOT NULL
  -- the explicit cash flow, and the identity CHECKED rather than trusted
  AND p.net_pnl_lamports IS NOT NULL
  AND p.entry_cash_out_lamports IS NOT NULL
  AND p.exit_cash_in_lamports IS NOT NULL
  AND p.locked_rent_lamports IS NOT NULL
  AND CAST(p.net_pnl_lamports AS INTEGER)
      = CAST(p.exit_cash_in_lamports AS INTEGER) - CAST(p.entry_cash_out_lamports AS INTEGER)
  -- P4: execution cost is costs only, so it can never reach the cash out
  AND CAST(p.execution_cost_lamports AS INTEGER) < CAST(p.entry_cash_out_lamports AS INTEGER)
  -- nothing left behind
  AND p.residual_token_atoms IS NOT NULL
  AND CAST(p.residual_token_atoms AS INTEGER) = 0
  -- the trigger is not the fill
  AND p.exit_triggered_utc_ms IS NOT NULL
  AND p.exit_fill_latency_ms IS NOT NULL
  AND p.exit_fill_latency_ms >= 1200
  -- one frozen arm
  AND p.strategy_version IS NOT NULL
  AND p.cohort IS NOT NULL
  -- EXISTS, not JOIN. This is the cardinality fix: a qualifying job is a
  -- condition on the position rather than a row multiplied into it.
  AND EXISTS (
    SELECT 1 FROM simulation_jobs je
    WHERE je.execution_observation_id = e.observation_id
      AND je.simulated_effect_ok = 1
      AND je.account_coverage_ok = 1
      AND je.confirmatory = 1
      AND je.validity = 'VALID_CONFIRMATORY'
      AND je.snapshot_manifest_hash IS NOT NULL
      AND je.replayable = 'REPLAYABLE'
  )
  AND EXISTS (
    SELECT 1 FROM simulation_jobs jx
    WHERE jx.execution_observation_id = x.observation_id
      AND jx.simulated_effect_ok = 1
      AND jx.account_coverage_ok = 1
      AND jx.confirmatory = 1
      AND jx.validity = 'VALID_CONFIRMATORY'
      AND jx.snapshot_manifest_hash IS NOT NULL
      AND jx.replayable = 'REPLAYABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM clock_checkpoints k
    WHERE k.resync_required = 1 AND k.resync_done_utc_ms IS NULL
  );
`,
  },

  {
    id: 31,
    name: 'direct_mint_facts',
    sql: `
-- P11 -- what the CHAIN says about a mint, kept per mint rather than per row.
--
-- The pipeline read the mint only when capital was at risk, so paper -- the
-- mode that produces the entire research corpus -- never read one. Nothing in
-- the corpus can currently say how often a candidate carries a freeze
-- authority, a transfer hook or a permanent delegate, which means the gate
-- that would refuse those in a capital mode has never been exercised and its
-- cost has never been measured. A risk control first run with money on it is
-- not a risk control.
--
-- Keyed by mint and not by screening: these facts belong to the token, they
-- change on the order of a governance action, and duplicating them per row
-- would make a re-read look like a new fact.
CREATE TABLE IF NOT EXISTS direct_mint_facts (
  mint                        TEXT PRIMARY KEY,
  read_utc_ms                 INTEGER NOT NULL,
  token_program               TEXT,
  -- SAFE / HOSTILE / UNKNOWN. Three states everywhere, never two.
  mint_authority              TEXT NOT NULL,
  freeze_authority            TEXT NOT NULL,
  permanent_delegate          TEXT NOT NULL,
  default_account_state       TEXT NOT NULL,
  transfer_hook               TEXT NOT NULL,
  non_transferable            TEXT NOT NULL,
  pausable                    TEXT NOT NULL,
  confidential                TEXT NOT NULL,
  overall                     TEXT NOT NULL,
  -- The fee that applies THIS epoch, and the worst any schedule allows.
  current_epoch_fee_bps       INTEGER,
  worst_case_fee_bps          INTEGER,
  maximum_fee_atoms           TEXT,
  -- Extension discriminants, comma separated, so the corpus can be counted.
  extension_types             TEXT,
  has_unknown_extension       INTEGER NOT NULL DEFAULT 0,
  decode_failure              TEXT,
  reasons                     TEXT,
  -- Where the provider and the chain disagreed, if they did.
  provider_disagreements      TEXT
);
CREATE INDEX IF NOT EXISTS idx_direct_mint_facts_overall
  ON direct_mint_facts(overall, read_utc_ms DESC);

-- P11 -- Mayhem, which is not organic activity.
--
-- Agent buys and sells are flow, and counting them as breadth or momentum
-- measures the agent rather than the market. Persisted separately so it can be
-- SUBTRACTED rather than quietly included.
CREATE TABLE IF NOT EXISTS mayhem_facts (
  mint                    TEXT PRIMARY KEY,
  observed_utc_ms         INTEGER NOT NULL,
  enabled                 INTEGER,
  agent_identity          TEXT,
  agent_state             TEXT,
  agent_inventory_atoms   TEXT,
  agent_buy_count         INTEGER,
  agent_sell_count        INTEGER,
  agent_buy_lamports      TEXT,
  agent_sell_lamports     TEXT,
  additional_supply_atoms TEXT,
  burn_transition         TEXT,
  hours_since_launch      REAL,
  source                  TEXT NOT NULL
);
`,
  },
  {
    id: 32,
    name: 'shadow_trigger_lifecycle',
    sql: `
-- P6 -- a shadow trigger stops closing the position.
--
-- The shadow loop fired decideExit on a mark and closed on that same mark, at
-- that same mark's value, with no later fill of any kind. Every shadow result
-- in the corpus is therefore a fill at the trigger price, which is the one
-- price a real exit can never get: it is the price that CAUSED the decision to
-- exit, observed before the decision existed.
--
-- packages/domain/src/shadow-lifecycle.ts has had the state machine that
-- forbids this since it was written, including the transition guard whose
-- error message is 'a shadow may not close at its trigger observation'. No
-- production file imported it. The machine-generated call graph found that:
-- manageShadowBooks could not reach admitPortfolioExit by any path.
--
-- These columns are what the machine needs to remember between cycles.
ALTER TABLE shadow_positions ADD COLUMN triggered_utc_ms INTEGER;
ALTER TABLE shadow_positions ADD COLUMN trigger_observation_id TEXT;
-- What the position was worth AT the trigger. Kept so the look-ahead bias the
-- old design was booking can be measured rather than described.
ALTER TABLE shadow_positions ADD COLUMN trigger_value_lamports TEXT;
ALTER TABLE shadow_positions ADD COLUMN trigger_reason TEXT;
ALTER TABLE shadow_positions ADD COLUMN fill_latency_ms INTEGER;
ALTER TABLE shadow_positions ADD COLUMN look_ahead_bias_lamports TEXT;
-- How many marks have gone by since the trigger without a valid fill. A
-- position stuck here is exposure nobody is reporting.
ALTER TABLE shadow_positions ADD COLUMN exit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_positions ADD COLUMN blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_shadow_positions_state
  ON shadow_positions(state, triggered_utc_ms);
`,
  },
  {
    id: 33,
    name: 'entity_concentration',
    sql: `
-- P11 -- concentration over ENTITIES, not just addresses.
--
-- intelligence/entity.ts has had union-find clustering and an entity-vs-address
-- comparison since it was written, and nothing in production ever built a
-- LINK. cluster() was therefore always called with an empty list, every holder
-- came out as its own entity, and the entity figure was the address figure
-- wearing a different name.
--
-- Both are stored side by side because the GAP is the finding. A token whose
-- top ten addresses hold 18% and whose top ten entities hold 71% is not a
-- decentralised token that happens to be clustered; it is a token that was
-- built to look decentralised.
CREATE TABLE IF NOT EXISTS entity_concentration (
  mint                   TEXT PRIMARY KEY,
  measured_utc_ms        INTEGER NOT NULL,
  address_count          INTEGER NOT NULL,
  entity_count           INTEGER NOT NULL,
  -- Holders whose funding history could not be read. NOT independent wallets.
  unknown_history_count  INTEGER NOT NULL,
  -- False when too many holders are unexamined for the entity figure to mean
  -- anything. It is then not a better number than the address figure, merely a
  -- different one.
  trustworthy            INTEGER NOT NULL,
  top_entity_1_bps       INTEGER,
  top_entity_5_bps       INTEGER,
  top_entity_10_bps      INTEGER,
  top_entity_20_bps      INTEGER,
  top_address_1_bps      INTEGER,
  top_address_5_bps      INTEGER,
  top_address_10_bps     INTEGER,
  top_address_20_bps     INTEGER,
  links_built            INTEGER NOT NULL,
  detail                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_entity_concentration_gap
  ON entity_concentration(trustworthy, measured_utc_ms DESC);
`,
  },
  {
    id: 34,
    name: 'tournament_arm',
    sql: `
-- P19 -- the arm a trajectory belongs to, assigned AS IT OPENS.
--
-- Retrospective labelling of an existing corpus is how an arm ends up holding
-- the trajectories that suit it. The allocation is balanced by construction and
-- deterministic given the counts, so a restart does not reshuffle it, and it
-- depends on nothing about the candidate -- assigning by score or liquidity or
-- age would measure each arm on a different population.
--
-- The tournament does not run yet: zero valid trajectories exist and the first
-- checkpoint is ten per arm. What this column does now is make sure that when
-- they arrive they are already allocated.
ALTER TABLE shadow_positions ADD COLUMN tournament_entry_arm TEXT;
ALTER TABLE shadow_positions ADD COLUMN tournament_exit_arm TEXT;
CREATE INDEX IF NOT EXISTS idx_shadow_positions_arm
  ON shadow_positions(tournament_entry_arm, tournament_exit_arm, state);
`,
  },
  {
    id: 35,
    name: 'exploration_debt',
    sql: `
-- Finding G -- exploration entitlement that survives a cycle.
--
-- allocate() has taken a carriedDebt and returned nextDebt since it was
-- written. runCycle() passed neither, so the remainder was recomputed from zero
-- every cycle: with a budget of 2, floor(2 * 0.25) is 0, and the exploration arm
-- that the design claims is 25% ran exactly never.
--
-- Keyed by strategy version and stratum, because an entitlement earned under one
-- scorer is not owed under another, and a debt pooled across cohorts would spend
-- itself wherever candidates happen to be densest.
CREATE TABLE IF NOT EXISTS exploration_debt (
  strategy_version TEXT NOT NULL,
  stratum          TEXT NOT NULL,
  debt             REAL NOT NULL,
  updated_utc_ms   INTEGER NOT NULL,
  PRIMARY KEY (strategy_version, stratum)
);
`,
  },
  {
    id: 36,
    name: 'development_trajectories',
    sql: `
-- P8 -- development trajectories, which do NOT pretend to own capital.
--
-- The portfolio risk budget prevents opening and must not be loosened to
-- manufacture paper positions. A research trajectory is not a position: it has
-- no NAV, consumes no free capital and is bounded by no portfolio position
-- limit. It is bounded by hard safety facts, mechanics viability and a frozen
-- sampling design, which are the things that actually make it informative.
--
-- Kept in its own table for exactly that reason. Writing these into positions
-- would make every capital-bearing invariant in the e2e suite meaningless, and
-- those invariants are asserted against the DATABASE rather than the code path.
CREATE TABLE IF NOT EXISTS development_trajectories (
  trajectory_id            TEXT PRIMARY KEY,

  -- The immutable economic identity. No row may change any of these; a
  -- different observation is a different economic event and gets a new row.
  entry_observation_id     TEXT NOT NULL,
  entry_simulation_job_id  TEXT NOT NULL,
  entry_settlement_id      TEXT NOT NULL,
  venue                    TEXT NOT NULL,
  pool                     TEXT NOT NULL,
  capability_fingerprint   TEXT NOT NULL,
  snapshot_hash            TEXT NOT NULL,
  mint                     TEXT NOT NULL,
  cohort                   TEXT NOT NULL,
  stratum                  TEXT NOT NULL,
  migration_age_ms         INTEGER,
  notional_lamports        TEXT NOT NULL,
  entry_policy_inputs      TEXT NOT NULL,

  -- The treatments this trajectory was evaluated under. Shared trajectory,
  -- many policies -- which is what makes the comparison a comparison.
  entry_policy             TEXT NOT NULL,
  exit_policy              TEXT NOT NULL,

  state                    TEXT NOT NULL,

  -- Evidence. A trajectory carries the grade of what it actually rests on.
  evidence_grade           TEXT NOT NULL,
  max_attainable_grade     TEXT NOT NULL,

  -- The counterfactual bound. A future pool state does not contain this
  -- entry, so its own impact is measured and haircut rather than ignored.
  quote_impact_ratio       REAL,
  base_impact_ratio        REAL,
  max_impact_ratio         REAL,
  haircut_bps              INTEGER,
  within_small_impact      INTEGER NOT NULL DEFAULT 0,

  -- Amounts as TEXT: SQLite INTEGER is 64-bit SIGNED and these are u64.
  entry_cash_out_lamports  TEXT,
  exit_cash_in_lamports    TEXT,
  haircut_exit_lamports    TEXT,
  execution_cost_lamports  TEXT,
  net_pnl_lamports         TEXT,
  pnl_blocked_reasons      TEXT NOT NULL DEFAULT '[]',

  cashback_accrued         TEXT NOT NULL DEFAULT '0',
  cashback_claimable       TEXT NOT NULL DEFAULT '0',
  cashback_claimed         TEXT NOT NULL DEFAULT '0',
  cashback_claim_cost      TEXT NOT NULL DEFAULT '0',

  exit_observation_id      TEXT,
  fill_latency_ms          INTEGER,

  opened_utc_ms            INTEGER NOT NULL,
  settled_utc_ms           INTEGER,
  refusals                 TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_devtraj_state ON development_trajectories(state, opened_utc_ms);
CREATE INDEX IF NOT EXISTS idx_devtraj_stratum ON development_trajectories(stratum, cohort);
CREATE INDEX IF NOT EXISTS idx_devtraj_policies ON development_trajectories(entry_policy, exit_policy);

-- P7 -- confirmed migrations, keyed the way the directive requires.
--
-- (signature, program_id) -- the key chain_events uses -- collapses every
-- instruction in a transaction to one row, so a transaction migrating more
-- than one thing keeps one arbitrary member of the set. The instruction index
-- is what keeps two migrations in one transaction as two.
CREATE TABLE IF NOT EXISTS confirmed_migrations (
  signature              TEXT NOT NULL,
  instruction_index      INTEGER NOT NULL,
  program_id             TEXT NOT NULL,

  mint                   TEXT NOT NULL,
  bonding_curve          TEXT NOT NULL,
  canonical_pool         TEXT NOT NULL,
  pool_base_token_account  TEXT,
  pool_quote_token_account TEXT,
  quote_mint             TEXT,
  creator                TEXT,

  is_mayhem_mode         INTEGER,
  is_cashback_coin       INTEGER,

  slot                   INTEGER NOT NULL,
  block_time             INTEGER,
  commitment             TEXT NOT NULL,
  -- processed is a claim that can be rolled back. NULL means not yet checked,
  -- which is not the same as checked and fine.
  reversal_status        TEXT,
  identity_source        TEXT NOT NULL,
  observed_utc_ms        INTEGER NOT NULL,

  PRIMARY KEY (signature, instruction_index, program_id)
);
CREATE INDEX IF NOT EXISTS idx_confmig_mint ON confirmed_migrations(mint);
CREATE INDEX IF NOT EXISTS idx_confmig_slot ON confirmed_migrations(slot DESC);
CREATE INDEX IF NOT EXISTS idx_confmig_pool ON confirmed_migrations(canonical_pool);
`,
  },
  {
    id: 37,
    name: 'trajectory_marks_and_outcomes',
    sql: `
-- P9 -- the later shared market path, and the paired policy outcomes on it.
--
-- One row per (trajectory, offset). The offset is part of the key so a mark is
-- taken once per horizon and a re-run cannot silently add a second 15-minute
-- observation to the same path.
CREATE TABLE IF NOT EXISTS trajectory_marks (
  trajectory_id     TEXT NOT NULL,
  offset_ms         INTEGER NOT NULL,
  observed_utc_ms   INTEGER NOT NULL,
  -- TEXT because SQLite INTEGER is 64-bit SIGNED and these are u64.
  executable_lamports      TEXT,
  exit_capacity_lamports   TEXT,
  effective_quote_reserve  TEXT,
  -- Why this mark carries no price. Never collapsed to "no route": that one
  -- word hid six different facts and is how 93% of a corpus became useless.
  refusal           TEXT,
  PRIMARY KEY (trajectory_id, offset_ms),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);
CREATE INDEX IF NOT EXISTS idx_tmarks_traj ON trajectory_marks(trajectory_id, offset_ms);

-- Every policy sees the SAME path, so outcomes are paired by construction.
-- The key includes the policy, so one path yields one row per policy and a
-- second evaluation cannot overwrite the first.
CREATE TABLE IF NOT EXISTS trajectory_policy_outcomes (
  trajectory_id     TEXT NOT NULL,
  exit_policy       TEXT NOT NULL,
  triggered_utc_ms  INTEGER,
  triggered_offset_ms INTEGER,
  reason            TEXT NOT NULL,
  exit_mark_lamports   TEXT,
  entry_cash_out_lamports TEXT,
  gross_delta_lamports TEXT,
  settled_utc_ms    INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, exit_policy),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);
CREATE INDEX IF NOT EXISTS idx_tpolicy_traj ON trajectory_policy_outcomes(trajectory_id);
`,
  },
  {
    id: 38,
    name: 'mark_lateness',
    sql: `
-- How late a mark was against its due time.
--
-- This belongs in its own migration because 37 HAD ALREADY RUN on the live
-- database. Migrations are idempotent by id, so editing an applied one changes
-- the file and not the schema -- the column silently never appears, and every
-- insert then fails with "no column named lateness_ms" against a migration
-- that reads as if it created it.
--
-- A mark taken long after its horizon represents that horizon in NAME ONLY.
-- The first live run fetched five horizons in one burst and every exit policy
-- then agreed trivially, which is why this is recorded per row rather than
-- inferred later.
ALTER TABLE trajectory_marks ADD COLUMN lateness_ms INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 39,
    name: 'leg_account_plans',
    sql: `
-- P2/F12 -- the EXACT plan of the bytes a leg executed.
--
-- The SDK chooses things: it selects a fee recipient from a list, appends
-- remaining accounts when cashback applies, and derives associated token
-- accounts under whichever token program the mint uses. Two builds of "the
-- same" leg are therefore not guaranteed to be the same transaction, and a
-- system that captures state for one build, simulates a second and fingerprints
-- a third is comparing three different experiments.
--
-- This is the row that makes a replay comparable to what happened, rather than
-- to what a rebuild would probably produce.
CREATE TABLE IF NOT EXISTS leg_account_plans (
  trajectory_id     TEXT NOT NULL,
  leg               TEXT NOT NULL,
  -- sha256 over programs, instruction data and ORDERED account metas. Position
  -- is part of the identity: PumpSwap reads the cashback accumulator ATA at
  -- remaining index 0, so present and present-in-the-right-place differ.
  fingerprint       TEXT NOT NULL,
  instruction_count INTEGER NOT NULL,
  -- The full plan: [{programId, data, accounts:[{pubkey,isSigner,isWritable,index}]}]
  plan_json         TEXT NOT NULL,
  program_ids       TEXT NOT NULL,
  accounts          TEXT NOT NULL,
  writable_accounts TEXT NOT NULL,
  recorded_utc_ms   INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, leg),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

CREATE INDEX IF NOT EXISTS idx_leg_plans_fingerprint ON leg_account_plans(fingerprint);
`,
  },
  {
    id: 40,
    name: 'created_accounts',
    sql: `
-- P6 -- every account a leg brought into existence, and who benefits from it.
--
-- The size surface reported ZERO created-account rent on every row while total
-- drag ran to 0.010-0.012 SOL. The accounts the transaction created were simply
-- not in anyone's observe list, and an account nobody observed reports
-- identically to one that cost nothing.
--
-- The economically load-bearing columns are the last three. Rent on an account
-- we hold close authority over is a FLOAT: it comes back. Rent on a shared
-- protocol account we cannot close is a TRANSFER from us to whoever trades the
-- pool next. Collapsing them into one "rent" number is what made a first
-- trader's one-time cost look like a recurring mechanics floor, and then made a
-- larger notional look like the fix.
CREATE TABLE IF NOT EXISTS created_accounts (
  trajectory_id     TEXT NOT NULL,
  leg               TEXT NOT NULL,
  pubkey            TEXT NOT NULL,
  owner             TEXT NOT NULL,
  space             INTEGER NOT NULL,
  -- TEXT because SQLite INTEGER is 64-bit SIGNED and these are u64 lamports.
  rent_exempt_min   TEXT NOT NULL,
  -- Balance above the exemption. The coin-creator fee vault is opened AND paid
  -- in one transaction, so its closing balance is rent plus a fee the pool sent
  -- it; crediting the whole balance back to the payer flattered every sell.
  excess_lamports   TEXT NOT NULL,
  economic_scope    TEXT NOT NULL,
  recoverability    TEXT NOT NULL,
  shared_with_other INTEGER NOT NULL,
  recorded_utc_ms   INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, leg, pubkey),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

CREATE INDEX IF NOT EXISTS idx_created_scope ON created_accounts(economic_scope);
CREATE INDEX IF NOT EXISTS idx_created_shared ON created_accounts(shared_with_other);
`,
  },
  {
    id: 41,
    name: 'leg_cashback',
    sql: `
-- P7/F13 -- what each leg moved through the cashback accounts, PER LEG.
--
-- The repository asserted for two commits that \`sell\` carries no volume
-- accumulator, because the IDL names it only on the instructions that manage it
-- directly. It carries two of them as optional positional remaining accounts,
-- and modelling one leg's creator-fee recovery instead of two understated the
-- retained round trip by roughly half.
--
-- One row per leg, never summed before storage. A single summed figure cannot
-- show whether the SECOND leg accrued, which is exactly the evidence the
-- correction needs.
--
-- \`accrued_to_us\` is the discriminating fact: the creator fee goes either to
-- the accumulator or to the creator's vault, never both. Both moving, or
-- neither, means something other than the modelled path happened and the leg is
-- not evidence for either -- so it is nullable, and null is not false.
CREATE TABLE IF NOT EXISTS leg_cashback (
  trajectory_id            TEXT NOT NULL,
  leg                      TEXT NOT NULL,
  -- TEXT because these are signed lamport deltas and SQLite INTEGER is 64-bit
  -- SIGNED; the amounts fit, but every other amount column in this schema is
  -- TEXT and a mixed convention is how a bigint becomes a float.
  accumulator_wsol_delta   TEXT,
  accumulator_delta        TEXT,
  creator_vault_delta      TEXT,
  fee_recipient_delta      TEXT,
  -- NULL when it could not be determined. Never coerced to 0.
  accrued_to_us            INTEGER,
  -- Whether the pool was cashback-enabled AT BUILD TIME, decoded from the pool
  -- rather than read off a possibly-hours-old migration row.
  is_cashback_coin         INTEGER NOT NULL,
  recorded_utc_ms          INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, leg),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

CREATE INDEX IF NOT EXISTS idx_leg_cashback_accrued ON leg_cashback(accrued_to_us);
`,
  },
  {
    id: 42,
    name: 'collector_telemetry',
    sql: `
-- P11/P13 -- what the running collector actually did, in the DATABASE.
--
-- The status commands these tables serve must answer when no collector is
-- attached. A \`wss:status\` that can only report on a live in-process watcher
-- reports nothing the moment the process stops, which is exactly when an
-- operator asks it what happened. So the process writes and the commands read,
-- and neither has to be running for the other to work.
--
-- P13's arithmetic is the reason \`collector_sessions\` exists at all. The rate
-- budget this replaces divided counts by ELAPSED WALL TIME, downtime included:
-- a process that ran twenty minutes out of a day reported "48 requests/day
-- against a 10,000/day quota" and concluded quota was not the constraint. That
-- describes the downtime. Everything is per ACTIVE SECOND, and active seconds
-- are the sum of these sessions.
CREATE TABLE IF NOT EXISTS collector_sessions (
  session_id       TEXT PRIMARY KEY,
  started_utc_ms   INTEGER NOT NULL,
  -- Advanced every cycle. A session whose heartbeat stopped is a session that
  -- died, and the difference between it and one that exited cleanly is whether
  -- ended_utc_ms was ever set.
  heartbeat_utc_ms INTEGER NOT NULL,
  ended_utc_ms     INTEGER,
  mode             TEXT NOT NULL,
  source_commit    TEXT NOT NULL,
  dirty            INTEGER NOT NULL,
  pid              INTEGER NOT NULL,
  endpoint         TEXT NOT NULL,
  cycles           INTEGER NOT NULL DEFAULT 0
);

-- Operational counters, not evidence. These are UPSERTED and accumulate within
-- a session; nothing downstream treats a counter as a trade outcome, and a
-- counter that could not be incremented would be a worse lie than one that can.
CREATE TABLE IF NOT EXISTS collector_counters (
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  -- For solana_rpc, the METHOD. Counting all RPC as one hides which call is the
  -- one exhausting the quota, which is the only actionable part.
  detail        TEXT NOT NULL DEFAULT '',
  count         INTEGER NOT NULL DEFAULT 0,
  errors_429    INTEGER NOT NULL DEFAULT 0,
  quota_errors  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, kind, detail),
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

CREATE TABLE IF NOT EXISTS collector_latency_samples (
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  ms              INTEGER NOT NULL,
  recorded_utc_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_latency_kind ON collector_latency_samples(kind);

-- P11 -- the EXACT addresses that were subscribed.
--
-- Stored rather than re-derived, because unwatch must use these. Re-deriving at
-- unwatch time means a derivation change silently leaks subscriptions instead
-- of failing, and a leaked subscription looks identical to a quiet account.
CREATE TABLE IF NOT EXISTS wss_subscriptions (
  session_id           TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  address              TEXT NOT NULL,
  trajectory_id        TEXT,
  subscribed_utc_ms    INTEGER NOT NULL,
  unsubscribed_utc_ms  INTEGER,
  events               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, kind, address),
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

-- Socket coverage gaps. Per-ACCOUNT silence is deliberately NOT recorded: a
-- quiet account across slots is a quiet account, and manufacturing a gap for
-- every account that simply did not trade buries the one real gap, which is the
-- interval where the socket was down and nothing could have been seen.
CREATE TABLE IF NOT EXISTS wss_gaps (
  session_id        TEXT NOT NULL,
  gap_start_utc_ms  INTEGER NOT NULL,
  gap_end_utc_ms    INTEGER,
  reason            TEXT NOT NULL,
  addresses_resynced INTEGER NOT NULL DEFAULT 0,
  addresses_changed  INTEGER NOT NULL DEFAULT 0,
  still_unreadable   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_wss_gaps_session ON wss_gaps(session_id);

-- P11 -- the urgent queue, and proof it was actually consumed.
--
-- A vault that just moved 5% is the observation whose value decays fastest;
-- serving it after a queue of routine marks is the same as not having detected
-- it. \`consumed_utc_ms\` is what distinguishes a queue that works from one that
-- only fills.
CREATE TABLE IF NOT EXISTS urgent_marks (
  session_id       TEXT NOT NULL,
  trajectory_id    TEXT NOT NULL,
  address          TEXT NOT NULL,
  before_balance   TEXT,
  after_balance    TEXT,
  queued_utc_ms    INTEGER NOT NULL,
  consumed_utc_ms  INTEGER,
  PRIMARY KEY (session_id, trajectory_id, queued_utc_ms),
  FOREIGN KEY (session_id) REFERENCES collector_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_urgent_unconsumed ON urgent_marks(consumed_utc_ms);
`,
  },
  {
    id: 43,
    name: 'candidate_risk_facts',
    sql: `
-- P10 -- the risk facts, as they stood BEFORE the decision they informed.
--
-- Every module behind these columns existed and was tested, and none of them
-- reached the trajectory collector. A candidate was admitted on mechanics
-- alone: it had a canonical pool, the buy simulated, the sell simulated.
-- Whether the mint could freeze our exit, whether the venue was in Mayhem mode,
-- whether four of the top five holders were one wallet -- none of it was
-- consulted, and none of it was stored against the trajectory that resulted.
--
-- \`collected_utc_ms\` is load-bearing rather than decorative. A gate reading a
-- fact collected AFTER selection is a post-hoc annotation and the position was
-- taken either way, so the row records when it was true and the admission
-- refuses anything stamped later than the decision.
--
-- Every verdict column is nullable and UNKNOWN is stored as the string, never
-- as NULL-meaning-fine. Absent-means-safe is the direction this system's errors
-- have repeatedly travelled.
CREATE TABLE IF NOT EXISTS candidate_risk_facts (
  mint                  TEXT NOT NULL,
  pool                  TEXT NOT NULL,
  collected_utc_ms      INTEGER NOT NULL,
  -- The trajectory this admitted, when one was opened. NULL for a refusal,
  -- which is the majority and is the product.
  trajectory_id         TEXT,
  mint_overall          TEXT NOT NULL,
  freeze_authority      TEXT NOT NULL,
  mint_authority        TEXT NOT NULL,
  permanent_delegate    TEXT NOT NULL,
  transfer_hook         TEXT NOT NULL,
  mint_decode_failure   TEXT,
  transfer_fee_kind     TEXT NOT NULL,
  transfer_fee_bps      INTEGER,
  -- NULL means neither venue was read. NEVER false: a token whose pool and
  -- bonding curve were both unavailable has not been shown to be non-Mayhem.
  mayhem_enabled        INTEGER,
  mayhem_source         TEXT NOT NULL,
  -- ORGANIC | CONTAMINATED_UNQUANTIFIED | UNKNOWN. Mayhem flow is neither
  -- organic nor zero; the agent share cannot be isolated without the program
  -- layout, and subtracting an unmeasured quantity is a guess with a minus sign.
  breadth_usability     TEXT NOT NULL,
  is_cashback_coin      INTEGER,
  accumulator_wsol_ata  TEXT,
  concentration_kind    TEXT NOT NULL,
  entity_adjusted_share REAL,
  canonical_pool        INTEGER NOT NULL,
  requires_shared_setup INTEGER,
  stratum               TEXT NOT NULL,
  admitted              INTEGER NOT NULL,
  -- Every reason, as JSON. Not the first one: collapsing six facts into one
  -- word is how 93% of a previous corpus became uninformative.
  refusals              TEXT NOT NULL,
  PRIMARY KEY (mint, collected_utc_ms)
);

CREATE INDEX IF NOT EXISTS idx_risk_admitted ON candidate_risk_facts(admitted);
CREATE INDEX IF NOT EXISTS idx_risk_stratum ON candidate_risk_facts(stratum);
CREATE INDEX IF NOT EXISTS idx_risk_trajectory ON candidate_risk_facts(trajectory_id);
`,
  },
  {
    id: 44,
    name: 'trajectory_settlements',
    sql: `
-- P5 -- ONE canonical settlement per trajectory, written once.
--
-- \`buildTrajectorySettlement\` was correct and unreachable for several commits:
-- its only call site was the trajectory kernel, which the collector never
-- reaches, and no table existed to put a result in. So every trajectory net PnL
-- was UNKNOWN BY CONSTRUCTION rather than for want of a sample -- the collector
-- measured a full round trip and then discarded the economics.
--
-- This settles the IMMEDIATE MECHANICS: the buy and the sell that actually
-- executed, in one runtime, against exact captured state. It deliberately does
-- NOT settle the policy exit, which is a mark on a later path and therefore a
-- counterfactual; conflating the two would let a hypothetical exit price wear
-- the label of a measured one.
--
-- Append-only on the trajectory id. An outcome that could be rewritten is not
-- evidence, and INSERT OR IGNORE makes a retry idempotent while refusing a
-- second, different answer for the same trajectory.
CREATE TABLE IF NOT EXISTS trajectory_settlements (
  trajectory_id            TEXT PRIMARY KEY,
  scope                    TEXT NOT NULL,
  -- TEXT because SQLite INTEGER is 64-bit SIGNED and these are lamport figures.
  entry_cash_out           TEXT NOT NULL,
  exit_cash_in             TEXT,
  gross_exit_credit        TEXT,
  base_fees                TEXT NOT NULL,
  priority_fees            TEXT NOT NULL,
  tips                     TEXT NOT NULL,
  transfer_fees            TEXT NOT NULL,
  failed_attempt_fees      TEXT NOT NULL,
  rent_created             TEXT NOT NULL,
  rent_recovered           TEXT NOT NULL,
  rent_still_locked        TEXT NOT NULL,
  cashback_accrued         TEXT NOT NULL,
  cashback_claimable       TEXT NOT NULL,
  cashback_claimed         TEXT NOT NULL,
  cashback_claim_cost      TEXT NOT NULL,
  residual_token_atoms     TEXT NOT NULL,
  -- DERIVED from the payer identity, never assumed zero. A residue is a cost
  -- the model does not know about.
  unexplained_lamports     TEXT NOT NULL,
  execution_cost           TEXT NOT NULL,
  -- NULL with reasons whenever a component is unknown. Never a silent zero.
  net_pnl                  TEXT,
  pnl_blocked_reasons      TEXT NOT NULL,
  identity_violations      TEXT NOT NULL,
  settled_utc_ms           INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

CREATE INDEX IF NOT EXISTS idx_tsettle_net ON trajectory_settlements(net_pnl);
`,
  },
  {
    id: 45,
    name: 'exploration_entitlement',
    sql: `
-- Item 55 -- how much exploration budget remains, and how much was spent.
--
-- pnpm exploration:status aliased cohort:status, which answers which CELLS
-- ARE UNDER-FILLED. That is a different question from HOW MUCH EXPLORATION
-- BUDGET REMAINS, and the alias meant nobody could tell that the exploration
-- arm had never actually run: the allocator existed, was tested, was pure, and
-- no production caller invoked it.
--
-- A gate evaluated only on the candidates it admitted is evaluated on its own
-- output. The 25% draw exists so the corpus contains rows the ranking would
-- never have bought, and an entitlement that is not tracked is an entitlement
-- that silently goes unspent.
--
-- Keyed by window so a restart RESUMES rather than re-granting: the ledger is
-- the state, and the process holds none of it.
CREATE TABLE IF NOT EXISTS exploration_entitlement (
  window_id        TEXT NOT NULL,
  stratum          TEXT NOT NULL,
  -- FROZEN before collection. Choosing it afterwards, having seen which arm did
  -- better, is choosing an answer.
  fraction         REAL NOT NULL,
  granted          INTEGER NOT NULL DEFAULT 0,
  consumed         INTEGER NOT NULL DEFAULT 0,
  updated_utc_ms   INTEGER NOT NULL,
  PRIMARY KEY (window_id, stratum)
);

-- Which arm each trajectory came from, and with what probability.
--
-- Without the probability the sample cannot be reweighted, and a biased sample
-- whose bias is unrecorded is worse than no sample: it looks like evidence.
ALTER TABLE development_trajectories ADD COLUMN exploration_arm TEXT;
ALTER TABLE development_trajectories ADD COLUMN inclusion_probability REAL;
ALTER TABLE development_trajectories ADD COLUMN exploration_window TEXT;

CREATE INDEX IF NOT EXISTS idx_traj_arm ON development_trajectories(exploration_arm);
`,
  },
  {
    id: 46,
    name: 'prospective_samples',
    sql: `
-- reject:panel-v2 -- the panel that is PROSPECTIVE, because the sample and the
-- scoring rule are fixed before any outcome exists.
--
-- reject_tracking records THAT a token was rejected: mint, reason, a price and
-- a liquidity figure. It does not record the STATE the rejection was made on,
-- and a panel scored from state fetched later is a different experiment -- the
-- pool has traded, the reserves have moved, and the thing being scored is no
-- longer the thing the filter saw.
--
-- Three tables because three things must not be written at the same time:
--   the RULE      frozen once, before any row is admitted
--   the SAMPLE    written at the instant of rejection, outcome-free
--   the OUTCOME   written later, and only for horizons the rule declared
CREATE TABLE IF NOT EXISTS prospective_panels (
  panel_id            TEXT PRIMARY KEY,
  -- Frozen BEFORE collection. Changing any of these is a new panel, never an
  -- edit: a horizon added after seeing outcomes is a horizon chosen on them.
  declared_utc_ms     INTEGER NOT NULL,
  horizons_ms         TEXT NOT NULL,
  metric              TEXT NOT NULL,
  -- The commit the rule was frozen at, so a rule that moved is detectable.
  source_commit       TEXT NOT NULL,
  notes               TEXT
);

CREATE TABLE IF NOT EXISTS prospective_samples (
  sample_id           TEXT PRIMARY KEY,
  panel_id            TEXT NOT NULL,
  mint                TEXT NOT NULL,
  -- The STATE, by reference. This is the column reject_tracking lacks and the
  -- reason a v1 panel could never be prospective.
  snapshot_id         TEXT NOT NULL,
  rejected_utc_ms     INTEGER NOT NULL,
  primary_reason      TEXT NOT NULL,
  -- Every gate verdict, not just the first one to fire. A filter's cost cannot
  -- be attributed when only the winning reason was kept.
  gate_verdicts       TEXT NOT NULL,
  -- How this row entered the panel. Without it the panel is a convenience
  -- sample, and a biased sample whose bias is unrecorded looks like evidence.
  inclusion_probability REAL,
  stratum             TEXT,
  -- Executable state AT REJECTION, in lamports as TEXT (SQLite INTEGER is
  -- 64-bit SIGNED). Null means the provider did not answer, never zero.
  pool_reserves_lamports TEXT,
  executable_quote_lamports TEXT,
  route_exists        INTEGER,
  FOREIGN KEY (panel_id) REFERENCES prospective_panels(panel_id)
);
CREATE INDEX IF NOT EXISTS idx_psample_panel ON prospective_samples(panel_id, rejected_utc_ms);
CREATE INDEX IF NOT EXISTS idx_psample_mint ON prospective_samples(mint);
CREATE UNIQUE INDEX IF NOT EXISTS idx_psample_once ON prospective_samples(panel_id, mint, snapshot_id);

-- Outcomes, keyed by a horizon the PANEL declared. A horizon not in
-- horizons_ms has no row here, which is what stops a metric being read off a
-- window picked once the answer was visible.
CREATE TABLE IF NOT EXISTS prospective_sample_marks (
  sample_id           TEXT NOT NULL,
  horizon_ms          INTEGER NOT NULL,
  observed_utc_ms     INTEGER NOT NULL,
  -- How late the mark actually was. A horizon reached late carries the right
  -- label and the wrong instant.
  lateness_ms         INTEGER NOT NULL,
  executable_lamports TEXT,
  -- Why this mark carries no price. Never collapsed to "no route".
  refusal             TEXT,
  PRIMARY KEY (sample_id, horizon_ms),
  FOREIGN KEY (sample_id) REFERENCES prospective_samples(sample_id)
);
CREATE INDEX IF NOT EXISTS idx_pmark_due ON prospective_sample_marks(horizon_ms, observed_utc_ms);
`,
  },
  {
    id: 47,
    name: 'evidence_graph_v1',
    sql: `
-- =====================================================================
-- EVIDENCE GRAPH V1  --  the 5d24e39 directive, P0.4 / P1 / P2 / P3
--
-- The 8f73cef runtime audit established that the apparatus runs and the
-- evidence graph does not:
--
--   0 / 292  entry_observation_id values resolve
--   0 / 292  entry_simulation_job_id values resolve
--   292/292  snapshot_hash values are decimal SLOT NUMBERS
--   292/292  capability fingerprints are the same slot number
--   292/292  trajectories carry unobserved writable accounts
--    51/52   settlements carry a non-zero unexplained remainder
--    30      of those publish net PnL anyway
--
-- The old columns are NOT dropped and the old rows are NOT deleted. They
-- are instrument-development history and they stay exactly where they are.
-- What changes is that a trajectory in an ACTIVE evidence context must
-- carry a row in trajectory_evidence_links, where every arrow is a real
-- foreign key -- and that table is new, so no dangling legacy value can
-- enter it.
--
-- Why a side table rather than ALTER TABLE ... ADD FOREIGN KEY: SQLite
-- cannot add a constraint to an existing table, and rebuilding
-- development_trajectories with the constraints WOULD FAIL on the 292
-- legacy rows whose identifiers point at nothing. A rebuild that requires
-- deleting the evidence of the defect is not an acceptable repair.
-- =====================================================================

-- ---------------------------------------------------------------------
-- P0.4  APPEND-ONLY INVALIDATION LEDGER
--
-- Old evidence is closed, never deleted. Every default report reads
-- validity from here rather than deciding for itself.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_contexts (
  evidence_context_id  TEXT PRIMARY KEY,
  context_hash         TEXT NOT NULL,
  source_commit        TEXT NOT NULL,
  tree_dirty           INTEGER NOT NULL,
  opened_utc_ms        INTEGER NOT NULL,
  closed_utc_ms        INTEGER,
  -- DEVELOPMENT_EVIDENCE          admissible as development evidence
  -- INSTRUMENT_DEVELOPMENT_INVALID  preserved history, excluded everywhere
  validity             TEXT NOT NULL
    CHECK (validity IN ('DEVELOPMENT_EVIDENCE','INSTRUMENT_DEVELOPMENT_INVALID')),
  -- JSON array of strings. Every reason, not the first one that fired.
  reasons              TEXT NOT NULL DEFAULT '[]',
  -- sha256 of the audit document that established the invalidation, so a
  -- reader can check the claim against the artifact rather than the prose.
  audit_artifact_hash  TEXT,
  notes                TEXT
);
CREATE INDEX IF NOT EXISTS idx_evctx_validity ON evidence_contexts(validity, opened_utc_ms);

-- Which trajectories belong to which evidence context. A separate table
-- because the legacy trajectories predate the concept and must be
-- attributable to a closed context retroactively without editing them.
CREATE TABLE IF NOT EXISTS trajectory_evidence_context (
  trajectory_id        TEXT PRIMARY KEY,
  evidence_context_id  TEXT NOT NULL,
  assigned_utc_ms      INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id),
  FOREIGN KEY (evidence_context_id) REFERENCES evidence_contexts(evidence_context_id)
);
CREATE INDEX IF NOT EXISTS idx_tec_ctx ON trajectory_evidence_context(evidence_context_id);

-- ---------------------------------------------------------------------
-- P12.2  FROZEN EXPERIMENT CONTRACT
--
-- Frozen BEFORE a window opens. Readiness loads ONE contract and the rows
-- that belong to it; it does not assemble a verdict from whatever is in
-- the database, which is how a position report came to answer a
-- trajectory question.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiment_contracts (
  contract_id          TEXT PRIMARY KEY,
  evidence_context_id  TEXT NOT NULL,
  frozen_utc_ms        INTEGER NOT NULL,
  source_commit        TEXT NOT NULL,
  context_hash         TEXT NOT NULL,
  collector_version    TEXT NOT NULL,
  kernel_version       TEXT NOT NULL,
  route_fingerprint    TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  notional_rule        TEXT NOT NULL,
  cohort               TEXT NOT NULL,
  entry_policies       TEXT NOT NULL,
  exit_policies        TEXT NOT NULL,
  mark_sla_ms          INTEGER NOT NULL,
  counterfactual_contract TEXT NOT NULL,
  cashback_treatment   TEXT NOT NULL,
  mayhem_treatment     TEXT NOT NULL,
  cost_rent_treatment  TEXT NOT NULL,
  risk_facts           TEXT NOT NULL,
  thresholds           TEXT NOT NULL,
  -- The set of audit invariants this contract CLAIMS. An invariant not in
  -- this list is out of scope and is not claimed anywhere else either.
  claimed_invariants   TEXT NOT NULL,
  contract_hash        TEXT NOT NULL,
  FOREIGN KEY (evidence_context_id) REFERENCES evidence_contexts(evidence_context_id)
);
CREATE INDEX IF NOT EXISTS idx_contract_ctx ON experiment_contracts(evidence_context_id, frozen_utc_ms);

-- ---------------------------------------------------------------------
-- P1.4  ATOMIC CANDIDATE RESERVATION
--
-- A process lock gives ONE writer. It does not give a per-mint sampling
-- cap: five daemons evaluating COUNT(*) < maxPerMint against the same
-- instant all admitted the same mint, and the worst mint produced 58
-- trajectories against a cap of 3.
--
-- The cap is enforced by a UNIQUE INDEX on (window_id, mint, ordinal)
-- plus a CHECK that the ordinal is within the cap, inside one
-- BEGIN IMMEDIATE. A count followed by a later independent insert cannot
-- express that, no matter how carefully it is written.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trajectory_reservations (
  reservation_id       TEXT PRIMARY KEY,
  window_id            TEXT NOT NULL,
  mint                 TEXT NOT NULL,
  reservation_ordinal  INTEGER NOT NULL CHECK (reservation_ordinal >= 1),
  max_per_mint         INTEGER NOT NULL CHECK (max_per_mint >= 1),
  trajectory_id        TEXT,
  status               TEXT NOT NULL
    CHECK (status IN ('RESERVED','OPENED','ABANDONED')),
  reserved_utc_ms      INTEGER NOT NULL,
  resolved_utc_ms      INTEGER,
  owner_session_id     TEXT NOT NULL,
  -- The reservation cannot be for an ordinal above the cap it was taken
  -- under. Stated in the schema so it holds regardless of the caller.
  CHECK (reservation_ordinal <= max_per_mint)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resv_ordinal ON trajectory_reservations(window_id, mint, reservation_ordinal);
-- At most ONE unresolved reservation per (window, mint). This is the index
-- that makes "no open trajectory for this mint" a database fact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_resv_open
  ON trajectory_reservations(window_id, mint) WHERE status = 'RESERVED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_resv_trajectory
  ON trajectory_reservations(trajectory_id) WHERE trajectory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resv_window ON trajectory_reservations(window_id, reserved_utc_ms);

-- ---------------------------------------------------------------------
-- P3.1  CONTENT-ADDRESSED EVIDENCE BLOBS
--
-- The audit's finding C-4: the worker's pre/post account state existed
-- only in process memory and was reduced to aggregate columns before
-- anything was persisted. Every economic amount was therefore recorded
-- exactly once and was unfalsifiable from the database.
--
-- SQLite holds the hash and the metadata. The bytes live under
-- data/evidence-blobs/<sha256[0:2]>/<sha256>, gzip-compressed, and every
-- blob is READ BACK and re-hashed before it is marked durable.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_blobs (
  blob_sha256          TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  byte_length          INTEGER NOT NULL CHECK (byte_length >= 0),
  stored_length        INTEGER NOT NULL,
  compression          TEXT NOT NULL CHECK (compression IN ('gzip','none')),
  relative_path        TEXT NOT NULL,
  -- Set only after the file was read back and its sha256 recomputed.
  readback_verified    INTEGER NOT NULL DEFAULT 0,
  readback_utc_ms      INTEGER,
  written_utc_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_kind ON evidence_blobs(kind, written_utc_ms);

-- ---------------------------------------------------------------------
-- P2.3 / P3.3  COHERENT SNAPSHOTS WITH REAL HASHES
--
-- snapshot_hash was the decimal slot number on 292 of 292 rows, and
-- capability_fingerprint was the SAME value. A slot number commits to no
-- byte of the pool, the vaults, the mint or the fee config, so a replay
-- comparing against it cannot detect that the state it re-fetched differs.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coherent_snapshots (
  snapshot_hash        TEXT PRIMARY KEY,
  slot                 INTEGER NOT NULL,
  captured_utc_ms      INTEGER NOT NULL,
  mint                 TEXT NOT NULL,
  pool                 TEXT NOT NULL,
  -- sha256 over the ordered account manifest (address, owner, lamports,
  -- executable, rentEpoch, data hash) -- the value snapshot_hash IS.
  manifest_blob_sha256 TEXT NOT NULL,
  account_count        INTEGER NOT NULL,
  fee_config_hash      TEXT,
  capability_fingerprint TEXT NOT NULL,
  programdata_hashes   TEXT NOT NULL DEFAULT '{}',
  sdk_versions         TEXT NOT NULL DEFAULT '{}',
  worker_binary_hash   TEXT,
  FOREIGN KEY (manifest_blob_sha256) REFERENCES evidence_blobs(blob_sha256)
);
CREATE INDEX IF NOT EXISTS idx_snap_mint ON coherent_snapshots(mint, captured_utc_ms);

-- A slot number can never be mistaken for a snapshot hash again: a hash is
-- 64 lowercase hex characters and a decimal slot is not.
CREATE TRIGGER IF NOT EXISTS trg_snapshot_hash_is_a_hash
BEFORE INSERT ON coherent_snapshots
FOR EACH ROW WHEN NEW.snapshot_hash NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'snapshot_hash must be a sha256 hex digest, not a slot number');
END;
CREATE TRIGGER IF NOT EXISTS trg_capability_fingerprint_is_a_hash
BEFORE INSERT ON coherent_snapshots
FOR EACH ROW WHEN NEW.capability_fingerprint = CAST(NEW.slot AS TEXT)
BEGIN
  SELECT RAISE(ABORT, 'capability_fingerprint may not be the slot number');
END;

-- ---------------------------------------------------------------------
-- P3.2  RAW PRE/POST ACCOUNT MANIFESTS
--
-- One row per (job, step, leg, account, side). ABSENT is represented
-- EXPLICITLY -- an account created by the leg has pre = ABSENT and an
-- account closed by it has post = ABSENT. Neither is silently added to
-- the unobserved set, which is what let 292 of 292 trajectories settle while
-- carrying an unmeasured lamport flow.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_state_manifests (
  manifest_id          TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  step_index           INTEGER NOT NULL,
  leg                  TEXT NOT NULL CHECK (leg IN ('buy','sell','close','claim')),
  address              TEXT NOT NULL,
  role                 TEXT NOT NULL,
  writable             INTEGER NOT NULL,
  -- STATIC or ALT_LOADED. An ALT-loaded writable that nobody observed is
  -- the same defect as a static one and must be countable separately.
  key_source           TEXT NOT NULL CHECK (key_source IN ('STATIC','ALT_LOADED','SYSVAR','DERIVED')),
  pre_state            TEXT NOT NULL CHECK (pre_state IN ('PRESENT','ABSENT')),
  post_state           TEXT NOT NULL CHECK (post_state IN ('PRESENT','ABSENT')),
  pre_blob_sha256      TEXT,
  post_blob_sha256     TEXT,
  pre_lamports         TEXT,
  post_lamports        TEXT,
  recorded_utc_ms      INTEGER NOT NULL,
  FOREIGN KEY (pre_blob_sha256) REFERENCES evidence_blobs(blob_sha256),
  FOREIGN KEY (post_blob_sha256) REFERENCES evidence_blobs(blob_sha256),
  -- PRESENT means there are bytes. ABSENT means there are not, and the
  -- difference must not be expressible as "we did not look".
  CHECK ((pre_state = 'PRESENT') = (pre_blob_sha256 IS NOT NULL)),
  CHECK ((post_state = 'PRESENT') = (post_blob_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asm_once
  ON account_state_manifests(job_id, step_index, leg, address);
CREATE INDEX IF NOT EXISTS idx_asm_job ON account_state_manifests(job_id, step_index);

-- ---------------------------------------------------------------------
-- P2.3  SIMULATION STEPS
--
-- simulation_jobs already exists and is keyed by the request hash. What
-- was missing is the STEP: one worker job executes several legs, and a
-- settlement must name which one it came from.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulation_steps (
  job_id               TEXT NOT NULL,
  step_index           INTEGER NOT NULL CHECK (step_index >= 0),
  leg                  TEXT NOT NULL CHECK (leg IN ('buy','sell','close','claim')),
  observation_id       TEXT,
  transaction_blob_sha256 TEXT NOT NULL,
  request_blob_sha256  TEXT,
  response_blob_sha256 TEXT,
  status               TEXT NOT NULL
    CHECK (status IN ('REQUESTED','RUNTIME_RETURNED','RAW_STATE_DURABLE',
                      'EFFECT_VERIFIED','SETTLEMENT_DERIVED','COMPLETE','FAILED')),
  runtime_ok           INTEGER,
  effect_ok            INTEGER,
  units_consumed       INTEGER,
  transaction_error    TEXT,
  started_utc_ms       INTEGER NOT NULL,
  completed_utc_ms     INTEGER,
  PRIMARY KEY (job_id, step_index),
  FOREIGN KEY (transaction_blob_sha256) REFERENCES evidence_blobs(blob_sha256),
  FOREIGN KEY (request_blob_sha256) REFERENCES evidence_blobs(blob_sha256),
  FOREIGN KEY (response_blob_sha256) REFERENCES evidence_blobs(blob_sha256)
);
CREATE INDEX IF NOT EXISTS idx_step_obs ON simulation_steps(observation_id);

-- ---------------------------------------------------------------------
-- P4  PER-LEG MEASURED SETTLEMENT
--
-- The settlement of ONE leg, derived from the raw manifests above, with
-- its own eligibility verdict. buildTrajectorySettlement consumes these;
-- it does not recompute them from aggregates it was handed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leg_settlements (
  settlement_id        TEXT PRIMARY KEY,
  trajectory_id        TEXT NOT NULL,
  leg                  TEXT NOT NULL CHECK (leg IN ('buy','sell','close','claim')),
  observation_id       TEXT NOT NULL,
  job_id               TEXT NOT NULL,
  step_index           INTEGER NOT NULL,
  settlement_version   TEXT NOT NULL,

  cash_out_lamports    TEXT,
  cash_in_lamports     TEXT,
  gross_credit_lamports TEXT,
  base_fee_lamports    TEXT NOT NULL,
  priority_fee_lamports TEXT NOT NULL,
  tip_lamports         TEXT NOT NULL,
  transfer_fee_lamports TEXT NOT NULL,
  failed_attempt_fee_lamports TEXT NOT NULL,
  rent_created_lamports TEXT NOT NULL,
  rent_recovered_lamports TEXT NOT NULL,
  rent_still_locked_lamports TEXT NOT NULL,
  cashback_accrued_lamports TEXT NOT NULL,
  cashback_claimable_lamports TEXT NOT NULL,
  cashback_claimed_lamports TEXT NOT NULL,
  cashback_claim_cost_lamports TEXT NOT NULL,
  residual_token_atoms TEXT NOT NULL,
  unexplained_lamports TEXT NOT NULL,

  -- The four conditions isPnlEligible names, each stored as its own fact
  -- rather than collapsed into a verdict nobody can take apart.
  complete             INTEGER NOT NULL,
  effect_valid         INTEGER NOT NULL,
  full_account_coverage INTEGER NOT NULL,
  residual_semantics_known INTEGER NOT NULL,
  transfer_fee_status  TEXT NOT NULL
    CHECK (transfer_fee_status IN ('MEASURED','NOT_APPLICABLE','UNKNOWN')),
  raw_state_durable    INTEGER NOT NULL,
  pnl_eligible         INTEGER NOT NULL,
  ineligibility_reasons TEXT NOT NULL DEFAULT '[]',

  derived_utc_ms       INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id),
  FOREIGN KEY (job_id, step_index) REFERENCES simulation_steps(job_id, step_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_legset_once ON leg_settlements(trajectory_id, leg, settlement_version);
CREATE INDEX IF NOT EXISTS idx_legset_job ON leg_settlements(job_id, step_index);

-- ---------------------------------------------------------------------
-- P2.3  THE LINK ROW  --  every arrow is a foreign key
--
-- A trajectory in an active evidence context must have one of these, and
-- SQLite will refuse to insert it if any link does not resolve. That is
-- the whole point: the 292 legacy rows CANNOT be represented here, which
-- is how "0 of 292 resolve" becomes impossible rather than merely fixed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trajectory_evidence_links (
  trajectory_id        TEXT PRIMARY KEY,
  evidence_context_id  TEXT NOT NULL,
  reservation_id       TEXT NOT NULL,
  snapshot_hash        TEXT NOT NULL,
  capability_fingerprint TEXT NOT NULL,
  account_plan_hash    TEXT NOT NULL,
  fee_config_hash      TEXT,
  selected_tier        TEXT,

  entry_observation_id TEXT NOT NULL,
  entry_job_id         TEXT NOT NULL,
  entry_step_index     INTEGER NOT NULL,
  entry_settlement_id  TEXT NOT NULL,

  -- NULL is valid ONLY while the trajectory is open. The graph check
  -- enforces that against the state column, which a CHECK constraint here cannot
  -- see.
  exit_observation_id  TEXT,
  exit_job_id          TEXT,
  exit_step_index      INTEGER,
  exit_settlement_id   TEXT,

  linked_utc_ms        INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id),
  FOREIGN KEY (evidence_context_id) REFERENCES evidence_contexts(evidence_context_id),
  FOREIGN KEY (reservation_id) REFERENCES trajectory_reservations(reservation_id),
  FOREIGN KEY (snapshot_hash) REFERENCES coherent_snapshots(snapshot_hash),
  FOREIGN KEY (entry_settlement_id) REFERENCES leg_settlements(settlement_id),
  FOREIGN KEY (exit_settlement_id) REFERENCES leg_settlements(settlement_id),
  FOREIGN KEY (entry_job_id, entry_step_index) REFERENCES simulation_steps(job_id, step_index),
  FOREIGN KEY (exit_job_id, exit_step_index) REFERENCES simulation_steps(job_id, step_index),
  -- Both halves of an exit link, or neither. A job id with no step index is
  -- how a dangling identifier gets written without anyone noticing.
  CHECK ((exit_job_id IS NULL) = (exit_step_index IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tel_ctx ON trajectory_evidence_links(evidence_context_id);

-- ---------------------------------------------------------------------
-- P9.1  ENTRY POLICY DECISIONS
--
-- All 292 rows carried the string literal 'HARD_GATES_RANDOM', written
-- AFTER admitCandidate had already decided. decideEntry had zero
-- production callers. So the entry side of the tournament had a sample of
-- zero and the label described nothing that happened.
--
-- A decision row is written per (trajectory, policy) BEFORE the entry, by
-- the policy itself, over the pre-entry feature snapshot. Three policies
-- over one shared trajectory is a paired comparison; one label is not.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trajectory_policy_decisions (
  trajectory_id        TEXT NOT NULL,
  entry_policy         TEXT NOT NULL,
  policy_version       TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('ENTER','REJECT')),
  reason               TEXT NOT NULL,
  -- The exact features the policy saw, as JSON. A decision that cannot be
  -- re-derived from its inputs is an opinion.
  feature_snapshot     TEXT NOT NULL,
  feature_snapshot_hash TEXT NOT NULL,
  decided_utc_ms       INTEGER NOT NULL,
  -- Whether a risk fact CHANGED this decision, recorded at decision time.
  -- P10.1: a fact that never alters an outcome is not wired in.
  risk_facts_applied   TEXT NOT NULL DEFAULT '[]',
  decision_without_risk_facts TEXT
    CHECK (decision_without_risk_facts IS NULL OR decision_without_risk_facts IN ('ENTER','REJECT')),
  PRIMARY KEY (trajectory_id, entry_policy),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);
CREATE INDEX IF NOT EXISTS idx_tpd_policy ON trajectory_policy_decisions(entry_policy, decision);

-- ---------------------------------------------------------------------
-- P8  COUNTERFACTUAL CONTRACTS
--
-- A hypothetical entry did not happen on mainnet, so a later mainnet
-- quote is not an exact future exit for it. All 292 rows were graded
-- SIMULATED_EXECUTION and 545 policy outcomes rested on those marks.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counterfactual_marks (
  trajectory_id        TEXT NOT NULL,
  offset_ms            INTEGER NOT NULL,
  evidence_class       TEXT NOT NULL
    CHECK (evidence_class IN ('BOUNDED_COUNTERFACTUAL_V1','RESERVE_DELTA_REPLAY_V1')),
  contract_version     TEXT NOT NULL,
  -- The local displacement OUR entry made to the pool, carried forward.
  post_entry_base_reserve  TEXT NOT NULL,
  post_entry_quote_reserve TEXT NOT NULL,
  -- The real mainnet state at the mark.
  observed_base_reserve    TEXT NOT NULL,
  observed_quote_reserve   TEXT NOT NULL,
  -- The conservative adverse adjustment applied to it, and the formula.
  adjusted_base_reserve    TEXT NOT NULL,
  adjusted_quote_reserve   TEXT NOT NULL,
  haircut_formula      TEXT NOT NULL,
  haircut_bps          INTEGER NOT NULL,
  haircut_lamports     TEXT NOT NULL,
  entry_impact_bps     INTEGER NOT NULL,
  impact_bound_bps     INTEGER NOT NULL,
  counterfactual_exit_lamports TEXT,
  -- DEVELOPMENT until the bound is calibrated against replay.
  evidence_grade       TEXT NOT NULL
    CHECK (evidence_grade IN ('DEVELOPMENT','CALIBRATED')),
  refusal              TEXT,
  computed_utc_ms      INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, offset_ms, evidence_class),
  FOREIGN KEY (trajectory_id, offset_ms) REFERENCES trajectory_marks(trajectory_id, offset_ms),
  -- P8.2: bounded mode exists ONLY at or under the frozen impact bound.
  CHECK (evidence_class <> 'BOUNDED_COUNTERFACTUAL_V1' OR entry_impact_bps <= impact_bound_bps)
);

CREATE TABLE IF NOT EXISTS counterfactual_calibration (
  calibration_id       TEXT PRIMARY KEY,
  trajectory_id        TEXT NOT NULL,
  offset_ms            INTEGER NOT NULL,
  bounded_exit_lamports TEXT NOT NULL,
  replay_exit_lamports TEXT NOT NULL,
  error_lamports       TEXT NOT NULL,
  error_bps            REAL NOT NULL,
  tolerance_bps        REAL NOT NULL,
  -- The bound must be CONSERVATIVE: bounded <= replay. A bounded value
  -- above the replayed one is an optimistic bound and invalidates the rows.
  conservative         INTEGER NOT NULL,
  within_tolerance     INTEGER NOT NULL,
  pool_events_applied  INTEGER NOT NULL,
  computed_utc_ms      INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

-- ---------------------------------------------------------------------
-- P5  APPEND-ONLY TRANSITIONS
--
-- Rather than overwriting economic history, record the transition. A
-- second different answer is then visible as two rows plus a conflict,
-- not as a silently discarded INSERT OR IGNORE.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_transitions (
  transition_id        TEXT PRIMARY KEY,
  entity               TEXT NOT NULL,
  entity_key           TEXT NOT NULL,
  from_state           TEXT,
  to_state             TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  recorded_utc_ms      INTEGER NOT NULL,
  detail               TEXT
);
CREATE INDEX IF NOT EXISTS idx_trans_entity ON evidence_transitions(entity, entity_key, recorded_utc_ms);

-- Every EvidenceConflict that was thrown, so a loud failure is also a
-- durable one. A conflict that only ever reached a log is not evidence.
CREATE TABLE IF NOT EXISTS evidence_conflicts (
  conflict_id          TEXT PRIMARY KEY,
  entity               TEXT NOT NULL,
  entity_key           TEXT NOT NULL,
  existing_hash        TEXT NOT NULL,
  offered_hash         TEXT NOT NULL,
  detail               TEXT NOT NULL,
  recorded_utc_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflict_entity ON evidence_conflicts(entity, entity_key);
`,
  },
  {
    id: 48,
    name: 'evidence_graph_columns',
    sql: `
-- Columns on existing tables. Separate migration so a failure here is
-- distinguishable from a failure creating the tables above.

-- P1.1: the lock must record WHICH COMMIT and WHICH COMMAND LINE owns it.
-- 'process_locks.collector names pid 24924, which is alive -- and is a
-- different program' was only diagnosable by hand because these were absent.
ALTER TABLE process_locks ADD COLUMN source_commit TEXT;
ALTER TABLE process_locks ADD COLUMN command_line TEXT;

-- P7.2: a mark carries its own SLA verdict. A late mark is MISSED_HORIZON,
-- not a valid backfilled horizon -- 697 of 1,448 marks were more than 60s
-- late and every one of them carried the right label on the wrong instant.
ALTER TABLE trajectory_marks ADD COLUMN sla_status TEXT;
ALTER TABLE trajectory_marks ADD COLUMN due_utc_ms INTEGER;
ALTER TABLE trajectory_marks ADD COLUMN sla_bound_ms INTEGER;
-- P6.4: the fee table this mark was priced against.
ALTER TABLE trajectory_marks ADD COLUMN fee_config_hash TEXT;
ALTER TABLE trajectory_marks ADD COLUMN selected_tier TEXT;
ALTER TABLE trajectory_marks ADD COLUMN evidence_class TEXT;

-- P6.4 on the trajectory itself.
ALTER TABLE development_trajectories ADD COLUMN fee_config_hash TEXT;
ALTER TABLE development_trajectories ADD COLUMN selected_tier TEXT;
ALTER TABLE development_trajectories ADD COLUMN market_cap_lamports TEXT;
ALTER TABLE development_trajectories ADD COLUMN creator_fee_bps INTEGER;
ALTER TABLE development_trajectories ADD COLUMN protocol_fee_bps INTEGER;
ALTER TABLE development_trajectories ADD COLUMN lp_fee_bps INTEGER;
ALTER TABLE development_trajectories ADD COLUMN cashback_flag INTEGER;
-- P2.3: the exit half of the identity, which had no column at all.
ALTER TABLE development_trajectories ADD COLUMN exit_simulation_job_id TEXT;
ALTER TABLE development_trajectories ADD COLUMN exit_settlement_id TEXT;
ALTER TABLE development_trajectories ADD COLUMN entry_step_index INTEGER;
ALTER TABLE development_trajectories ADD COLUMN exit_step_index INTEGER;
-- P10.1: raw AND entity-adjusted, and whether the difference mattered.
ALTER TABLE development_trajectories ADD COLUMN concentration_raw REAL;
ALTER TABLE development_trajectories ADD COLUMN concentration_entity_adjusted REAL;
ALTER TABLE development_trajectories ADD COLUMN concentration_stratum TEXT;
ALTER TABLE development_trajectories ADD COLUMN token2022_fee_status TEXT;

-- P4.5: the trajectory-level failed-attempt parameter, which the settlement
-- builder accepted and then added to no total.
ALTER TABLE trajectory_settlements ADD COLUMN settlement_version TEXT;
ALTER TABLE trajectory_settlements ADD COLUMN entry_settlement_id TEXT;
ALTER TABLE trajectory_settlements ADD COLUMN exit_settlement_id TEXT;

-- P9.3: which entry policy this outcome is paired with. The outcome table
-- was keyed by exit policy alone, so an entry-policy treatment could not be
-- represented even once decideEntry started being called.
ALTER TABLE trajectory_policy_outcomes ADD COLUMN entry_policy TEXT;
ALTER TABLE trajectory_policy_outcomes ADD COLUMN entry_decision TEXT;
ALTER TABLE trajectory_policy_outcomes ADD COLUMN net_pnl_lamports TEXT;
ALTER TABLE trajectory_policy_outcomes ADD COLUMN pnl_blocked_reasons TEXT;
ALTER TABLE trajectory_policy_outcomes ADD COLUMN evidence_class TEXT;

CREATE INDEX IF NOT EXISTS idx_marks_sla ON trajectory_marks(sla_status);
`,
  },
{
    id: 49,
    name: 'reservation_retry',
    sql: `
-- A CANDIDATE REFUSED ONCE MUST BE RETRYABLE.
--
-- \`abandonReservation\` frees the ordinal for COUNTING — \`used\` excludes
-- ABANDONED rows — but the abandoned row still occupies the deterministic
-- primary key sha256(window|mint|ordinal). So the next attempt at the same
-- mint collided on the PRIMARY KEY and reported RESERVATION_RACE_LOST, in a
-- window with exactly one process running and no race at all.
--
-- Measured 2026-08-17: eleven admissible, deep, under-cap pools were refused
-- for this reason on the pass immediately after the one that abandoned them.
-- A window could therefore only ever open the mints that succeeded on their
-- FIRST attempt, and a transient refusal — a thin minute, an RPC hiccup —
-- removed a mint permanently.
--
-- A refusal is a fact about an instant, not about a mint.
--
-- The cap is unchanged and still enforced: at most maxPerMint NON-ABANDONED
-- reservations per (window, mint), which is what the partial index below says.
-- Abandoned rows are history and are excluded from it.
DROP INDEX IF EXISTS idx_resv_ordinal;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resv_ordinal
  ON trajectory_reservations(window_id, mint, reservation_ordinal)
  WHERE status <> 'ABANDONED';
`,
  },
{
    id: 50,
    name: 'counterfactual_inputs',
    sql: `
-- P8: THE INPUTS A COUNTERFACTUAL EXIT NEEDS, ON THE ROWS THAT HAVE THEM.
--
-- counterfactual_marks has existed since migration 48 and nothing wrote a
-- single row, because the two states the construction needs were never
-- persisted anywhere:
--
--   the LOCAL post-entry reserves -- the displacement our entry actually made,
--   which is the only thing that distinguishes a counterfactual from a later
--   quote; and
--
--   the REAL reserves at each mark, which trajectory_marks stored only as
--   effective_quote_reserve. That figure includes the pool's VIRTUAL quote and
--   is correct for depth and wrong for a constant-product exit: the virtual
--   term is not lamports anyone can withdraw.
--
-- Without both, every policy outcome rested on a later mainnet quote against a
-- pool that never contained our entry -- 545 of them before the repair -- and
-- the haircut columns on those rows came from the ENTRY impact bound rather
-- than from any contract over the exit.
-- BOTH, because the two contracts need different things. The bounded contract
-- carries the DISPLACEMENT onto the later real reserves; the reserve-delta
-- replay starts from the ABSOLUTE local state and applies intervening events
-- to it. Deriving either from the other needs the pre-entry reserves, which
-- are not on this row.
ALTER TABLE development_trajectories ADD COLUMN post_entry_base_reserve TEXT;
ALTER TABLE development_trajectories ADD COLUMN post_entry_quote_reserve TEXT;
ALTER TABLE development_trajectories ADD COLUMN entry_base_delta_atoms TEXT;
ALTER TABLE development_trajectories ADD COLUMN entry_quote_delta_lamports TEXT;
ALTER TABLE development_trajectories ADD COLUMN entry_impact_bps INTEGER;

ALTER TABLE trajectory_marks ADD COLUMN observed_base_reserve TEXT;
ALTER TABLE trajectory_marks ADD COLUMN observed_quote_reserve TEXT;

-- counterfactual_marks named its two displacement columns post_entry_*, and
-- boundedCounterfactual ADDS them to the observed reserves. An absolute
-- post-entry reserve added to the later real state doubles the pool, and the
-- exit is then priced against roughly twice the liquidity that existed --
-- which flatters every counterfactual by understating slippage. The table has
-- never held a row, so the names are corrected rather than worked around.
ALTER TABLE counterfactual_marks RENAME COLUMN post_entry_base_reserve TO entry_base_delta_atoms;
ALTER TABLE counterfactual_marks RENAME COLUMN post_entry_quote_reserve TO entry_quote_delta_lamports;

CREATE INDEX IF NOT EXISTS idx_cf_marks_class
  ON counterfactual_marks(evidence_class, trajectory_id);
`,
  },
];

export interface OpenOptions {
  readonly path: string;
  readonly readonly?: boolean;
  /** Skip the automatic pre-migration backup (tests only). */
  readonly skipBackup?: boolean;
}

export function openDb(opts: OpenOptions): Db {
  const abs = resolve(opts.path);
  mkdirSync(dirname(abs), { recursive: true });

  const db = new DatabaseSync(abs, { readOnly: opts.readonly ?? false });
  if (opts.readonly) return db;

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // The pre-migration backup, taken AFTER opening rather than before.
  //
  // It used to be a copyFileSync of the main .db file with the failure
  // swallowed. That is not a backup while WAL is active -- committed pages may
  // live only in -wal, so the copy is silently older than the database or torn
  // across a checkpoint -- and swallowing the error meant a migration ran
  // anyway with nothing behind it. Both halves of that were wrong.
  //
  // A migration rewrites the only copy of a research corpus that cannot be
  // regenerated. If we cannot prove we have a readable snapshot of it first,
  // the correct behaviour is to refuse to start, not to proceed hopefully.
  //
  // BACK UP WHEN THERE IS A MIGRATION TO PROTECT AGAINST, AND NOT OTHERWISE.
  //
  // This used to back up on EVERY open. The invariant is right and the trigger
  // was wrong: what needs a snapshot behind it is a schema change, not the act
  // of opening a file. On the 7.3 GB corpus the unconditional version cost
  // ~5 minutes and 7 GB of disk per `openDb` — per status command, per script,
  // per collector restart — which is why five daemons were left running rather
  // than restarted, and why a mark scheduler with a 10-second SLA could not
  // exist. `pendingMigrations` is read from the same table `migrate` reads, so
  // the two cannot disagree about whether anything is about to change.
  const hasContent = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' LIMIT 1`).get() !== undefined;
  const pending = hasContent ? pendingMigrations(db) : [];
  if (!(opts.skipBackup ?? false) && hasContent && pending.length > 0) {
    try {
      onlineBackup(db, `${abs}.bak`);
    } catch (e) {
      db.close();
      throw new BackupFailed(
        'pre-migration',
        `${(e as Error).message}. Refusing to migrate: the database is a research corpus that cannot be ` +
          'regenerated, and a migration with no verified backup behind it is not recoverable. Fix the ' +
          'backup (disk space, permissions, a stale .bak.partial) or pass skipBackup deliberately.',
      );
    }
  }

  migrate(db);
  return db;
}

/**
 * Migrations declared but not yet applied.
 *
 * Exported because two things must agree about it: the pre-migration backup
 * (which is expensive and must run exactly when a schema change is about to
 * happen) and `migrate` itself. Deriving both from one query is the only way to
 * guarantee they cannot drift.
 */
export function pendingMigrations(db: Db): readonly Migration[] {
  let applied: Set<number>;
  try {
    applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  } catch {
    // The table does not exist yet: everything is pending.
    return MIGRATIONS;
  }
  return MIGRATIONS.filter((m) => !applied.has(m.id));
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_utc_ms INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_utc_ms) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Cross-process single-writer lock. Two executors running at once is a
 * catastrophic failure mode (double-spend of the same balance), so this is
 * checked at startup and heartbeated while running.
 */
export class ProcessLock {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly mode: string,
    private readonly staleAfterMs = 30_000,
  ) {}

  acquire(): { ok: true } | { ok: false; heldBy: number; ageMs: number } {
    const now = Date.now();
    const row = this.db.prepare('SELECT pid, heartbeat_utc_ms FROM process_locks WHERE lock_name = ?').get(this.name) as
      | { pid: number; heartbeat_utc_ms: number }
      | undefined;

    if (row) {
      const age = now - row.heartbeat_utc_ms;
      // A live heartbeat from another pid means a second instance is running.
      if (age < this.staleAfterMs && row.pid !== process.pid) {
        return { ok: false, heldBy: row.pid, ageMs: age };
      }
    }
    this.db
      .prepare(
        `INSERT INTO process_locks (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lock_name) DO UPDATE SET
           pid=excluded.pid, hostname=excluded.hostname,
           acquired_utc_ms=excluded.acquired_utc_ms, heartbeat_utc_ms=excluded.heartbeat_utc_ms,
           mode=excluded.mode`,
      )
      .run(this.name, process.pid, hostnameSafe(), now, now, this.mode);

    this.timer = setInterval(() => this.heartbeat(), Math.floor(this.staleAfterMs / 3));
    this.timer.unref();
    return { ok: true };
  }

  heartbeat(): void {
    try {
      this.db
        .prepare('UPDATE process_locks SET heartbeat_utc_ms = ? WHERE lock_name = ? AND pid = ?')
        .run(Date.now(), this.name, process.pid);
    } catch {
      // Heartbeat failure is surfaced by the staleness check on the other side.
    }
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    try {
      this.db.prepare('DELETE FROM process_locks WHERE lock_name = ? AND pid = ?').run(this.name, process.pid);
    } catch {
      /* best effort on shutdown */
    }
  }
}

/**
 * Exported so lock holders and lock reapers derive the host identically. If
 * these two ever disagreed, `kill` would treat a local lock as foreign and
 * refuse to clear it, or worse, treat a foreign one as local.
 */
export function hostnameSafe(): string {
  return process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'unknown';
}

/**
 * Highest applied migration, as the schema version stamped onto observations.
 *
 * Read from the database rather than from `MIGRATIONS.length`, because the
 * question a provenance record has to answer is what shape the data ACTUALLY
 * had when the row was written, not what shape the code believes it should.
 */
export function schemaVersion(db: Db): string {
  const r = db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get() as { v: number };
  return `schema-v${r.v}`;
}
