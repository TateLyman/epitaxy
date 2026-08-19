-- ############################################################################
-- PHASE G ADDENDUM §A.3 — VALIDATE CURVE-STATE PRICING BEFORE ANY USE AT SCALE
--
-- The addendum's §A.2 names the initial Global parameters as the technical risk and
-- says to read them rather than assume them. They do not need to be read, because the
-- pump program EMITS the curve state after every trade: pump_evt_tradeevent carries
-- virtualSolReserves and virtualTokenReserves as the program computed them. The state
-- is therefore OBSERVED at every trade, and the only thing that needs validating is
-- whether the roll-forward BETWEEN observations is exact.
--
-- That is a stronger position than the addendum assumed was available, and it removes
-- the failure mode it warned about: no single constant is assumed across the corpus,
-- because no constant is used at all.
--
-- TWO TESTS, BOTH ANCHORED ON WHAT THE PROGRAM SAID
--
--   TOKEN ROLL-FORWARD. From each mint's first event, roll virtualTokenReserves
--   forward on TOKEN AMOUNTS ONLY and compare with what the program reported at each
--   later event. The token leg carries no fee term, so any drift here is a fact about
--   the tape rather than about fees — which is exactly §A.3's falsification test for
--   the §2 diagnosis. Flat across all five trade-count buckets confirms the mechanism;
--   drift means something else is unaccounted.
--
--   THE INVARIANT. Derive virtualSolReserves from k = virtualToken x virtualSol taken
--   at the mint's first event, and compare with what the program reported. This tests
--   whether k is actually constant over a curve's life, which is the assumption §A.1
--   asks to cross-check and report the divergence of rather than average away.
--
-- The event table carries both camelCase and snake_case variants of every field for
-- different program eras, so each is COALESCEd and the populated share is returned:
-- a validation that silently read a NULL column would pass by measuring nothing.
--
-- Scoped to mints whose FIRST event falls in Phase B's window, so the population is
-- the one §A.4 would re-price rather than a convenience sample.
WITH params AS (
  SELECT
    DATE '2026-07-16' AS win_lo,
    DATE '2026-08-15' AS win_hi,
    -- The event stream is read a day wider so a mint created at the window edge still
    -- has its later trades available.
    DATE '2026-07-15' AS read_lo,
    DATE '2026-08-16' AS read_hi
),

ev AS (
  SELECT
    t.mint,
    t.evt_block_slot                                            AS slot,
    t.evt_block_time                                            AS block_time,
    t.evt_tx_index                                              AS tx_index,
    COALESCE(t.evt_inner_instruction_index, -1)                 AS inner_index,
    COALESCE(t.isBuy, t.is_buy)                                 AS is_buy,
    CAST(COALESCE(t.solAmount, t.sol_amount) AS DECIMAL(38,0))   AS sol_amount,
    CAST(COALESCE(t.tokenAmount, t.token_amount) AS DECIMAL(38,0)) AS token_amount,
    CAST(COALESCE(t.virtualSolReserves, t.virtual_sol_reserves) AS DECIMAL(38,0))   AS v_sol,
    CAST(COALESCE(t.virtualTokenReserves, t.virtual_token_reserves) AS DECIMAL(38,0)) AS v_token,
    -- Which variant actually carried the value, so the coverage of each is visible.
    CASE WHEN t.virtualTokenReserves IS NOT NULL THEN 'CAMEL'
         WHEN t.virtual_token_reserves IS NOT NULL THEN 'SNAKE'
         ELSE 'NEITHER' END                                     AS field_variant
  FROM pumpdotfun_solana.pump_evt_tradeevent t
  CROSS JOIN params p
  WHERE t.evt_block_date >= p.read_lo
    AND t.evt_block_date <= p.read_hi
),

/* One row per event, ordered within its mint, carrying the mint's FIRST observed
   state as the anchor and the running token flow since it. */
seq AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (PARTITION BY e.mint ORDER BY e.slot, e.tx_index, e.inner_index) AS n,
    FIRST_VALUE(e.v_token) OVER (PARTITION BY e.mint ORDER BY e.slot, e.tx_index, e.inner_index) AS v_token_first,
    FIRST_VALUE(e.v_sol)   OVER (PARTITION BY e.mint ORDER BY e.slot, e.tx_index, e.inner_index) AS v_sol_first,
    MIN(e.block_time) OVER (PARTITION BY e.mint)                AS mint_first_seen,
    -- Signed token flow INTO the curve, cumulative and INCLUSIVE of this event. A buy
    -- takes tokens out of the curve; a sell puts them back.
    SUM(CASE WHEN COALESCE(e.is_buy, FALSE) THEN -e.token_amount ELSE e.token_amount END)
      OVER (PARTITION BY e.mint ORDER BY e.slot, e.tx_index, e.inner_index
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)    AS cum_token_delta,
    FIRST_VALUE(CASE WHEN COALESCE(e.is_buy, FALSE) THEN -e.token_amount ELSE e.token_amount END)
      OVER (PARTITION BY e.mint ORDER BY e.slot, e.tx_index, e.inner_index) AS first_token_delta
  FROM ev e
),

in_window AS (
  SELECT s.*
  FROM seq s
  CROSS JOIN params p
  WHERE CAST(s.mint_first_seen AS DATE) >= p.win_lo
    AND CAST(s.mint_first_seen AS DATE) <= p.win_hi
),

scored AS (
  SELECT
    w.mint,
    w.n,
    w.field_variant,
    w.v_token,
    w.v_sol,
    -- The anchor is the state AFTER event 1, so the flow of event 1 itself is not
    -- applied again.
    w.v_token_first + (w.cum_token_delta - w.first_token_delta)  AS v_token_rolled,
    -- k from the mint's own first observation. No constant is assumed across mints.
    CASE WHEN w.v_token > 0
         THEN (w.v_token_first * w.v_sol_first) / w.v_token
    END                                                          AS v_sol_from_invariant
  FROM in_window w
  WHERE w.n > 1
    AND w.v_token IS NOT NULL
    AND w.v_sol IS NOT NULL
    AND w.v_token_first IS NOT NULL
    AND w.v_sol_first IS NOT NULL
)

SELECT
  CASE
    WHEN n - 1 = 1 THEN '1'
    WHEN n - 1 BETWEEN 2 AND 5 THEN '2-5'
    WHEN n - 1 BETWEEN 6 AND 20 THEN '6-20'
    WHEN n - 1 BETWEEN 21 AND 100 THEN '21-100'
    ELSE '101+'
  END                                                            AS trades_since_anchor,
  field_variant,
  COUNT(*)                                                       AS n_events,
  COUNT(DISTINCT mint)                                           AS n_mints,
  -- TOKEN ROLL-FORWARD: reconstructed over reported.
  APPROX_PERCENTILE(CAST(v_token_rolled AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0), 0.10) AS token_p10,
  APPROX_PERCENTILE(CAST(v_token_rolled AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0), 0.50) AS token_p50,
  APPROX_PERCENTILE(CAST(v_token_rolled AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0), 0.90) AS token_p90,
  COUNT_IF(ABS(CAST(v_token_rolled AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0) - 1e0) <= 0.01) AS token_within_1pct,
  -- THE INVARIANT: SOL derived from k over SOL as reported.
  APPROX_PERCENTILE(CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_sol AS DOUBLE), 0), 0.10) AS sol_p10,
  APPROX_PERCENTILE(CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_sol AS DOUBLE), 0), 0.50) AS sol_p50,
  APPROX_PERCENTILE(CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_sol AS DOUBLE), 0), 0.90) AS sol_p90,
  COUNT_IF(ABS(CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_sol AS DOUBLE), 0) - 1e0) <= 0.01) AS sol_within_1pct,
  -- IMPLIED PRICE: the quantity §A.4 would actually use, reported on its own terms.
  APPROX_PERCENTILE(
    (CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_token_rolled AS DOUBLE), 0))
    / NULLIF(CAST(v_sol AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0), 0), 0.50)              AS price_p50,
  COUNT_IF(ABS(
    (CAST(v_sol_from_invariant AS DOUBLE) / NULLIF(CAST(v_token_rolled AS DOUBLE), 0))
    / NULLIF(CAST(v_sol AS DOUBLE) / NULLIF(CAST(v_token AS DOUBLE), 0), 0) - 1e0) <= 0.01)     AS price_within_1pct
FROM scored
GROUP BY 1, 2
ORDER BY 1, 2
