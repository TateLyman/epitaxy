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
  const hasContent = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' LIMIT 1`).get() !== undefined;
  if (!(opts.skipBackup ?? false) && hasContent) {
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
