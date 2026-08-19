-- ============================================================================
-- EPITAXY — WALLET PERSISTENCE TEST (Dune / Trino SQL)
--
-- Question: do wallets that traded well in a fit window trade well in a
-- disjoint holdout window? If not, there is nothing to copy and both the
-- race version and the screening-feature version close immediately.
--
-- Everything here is DEVELOPMENT_RECONSTRUCTED. Nothing is evidence.
-- All returns are GROSS. The 2.69% round-trip cost floor is NOT in Dune data
-- and must be subtracted before any cell is called profitable.
--
-- SCHEMA CAUTION: Dune's Solana DEX columns change. Verify names in the schema
-- explorer before running. Columns assumed here:
--   block_time, project, trader_id, tx_id,
--   token_bought_mint_address, token_sold_mint_address,
--   token_bought_amount, token_sold_amount, amount_usd
-- ============================================================================


-- ----------------------------------------------------------------------------
-- SHARED BASE — normalise swaps into signed SOL/token legs
-- Paste this CTE block at the top of queries 1-4.
-- ----------------------------------------------------------------------------

WITH params AS (
  SELECT
    TIMESTAMP '2026-06-01 00:00:00' AS fit_start,
    TIMESTAMP '2026-07-15 00:00:00' AS fit_end,
    TIMESTAMP '2026-07-16 00:00:00' AS hold_start,
    TIMESTAMP '2026-08-15 00:00:00' AS hold_end,
    'So11111111111111111111111111111111111111112' AS wsol,
    20 AS min_positions_fit,      -- frozen before looking at any return
    0.10 AS top_fraction          -- top decile. FROZEN. Do not tune.
),

swaps AS (
  SELECT
    t.block_time,
    t.trader_id,
    t.tx_id,
    CASE WHEN t.token_bought_mint_address = p.wsol
         THEN t.token_sold_mint_address
         ELSE t.token_bought_mint_address END           AS mint,
    CASE WHEN t.token_bought_mint_address = p.wsol
         THEN 'SELL' ELSE 'BUY' END                     AS side,
    CASE WHEN t.token_bought_mint_address = p.wsol
         THEN t.token_bought_amount
         ELSE t.token_sold_amount END                   AS sol_amount,
    CASE WHEN t.token_bought_mint_address = p.wsol
         THEN t.token_sold_amount
         ELSE t.token_bought_amount END                 AS token_amount
  FROM dex_solana.trades t
  CROSS JOIN params p
  WHERE t.project IN ('pumpdotfun', 'pumpswap')
    AND t.block_time >= p.fit_start
    AND t.block_time <  p.hold_end
    AND (t.token_bought_mint_address = p.wsol OR t.token_sold_mint_address = p.wsol)
    AND t.token_bought_amount > 0
    AND t.token_sold_amount   > 0
),

-- Carry-forward mark: last observed SOL price per token, per mint.
-- Used to value positions the wallet never closed. Marking these at zero
-- would be harsh; excluding them would let hold-the-loser wallets look skilled.
last_price AS (
  SELECT mint, sol_per_token
  FROM (
    SELECT
      mint,
      sol_amount / NULLIF(token_amount, 0) AS sol_per_token,
      ROW_NUMBER() OVER (PARTITION BY mint ORDER BY block_time DESC) AS rn
    FROM swaps
    WHERE token_amount > 0
  ) x
  WHERE rn = 1
),

-- One row per (wallet, mint) = one position.
positions AS (
  SELECT
    s.trader_id,
    s.mint,
    MIN(CASE WHEN s.side = 'BUY'  THEN s.block_time END)                    AS first_buy,
    MAX(CASE WHEN s.side = 'SELL' THEN s.block_time END)                    AS last_sell,
    SUM(CASE WHEN s.side = 'BUY'  THEN s.sol_amount   ELSE 0 END)           AS sol_in,
    SUM(CASE WHEN s.side = 'SELL' THEN s.sol_amount   ELSE 0 END)           AS sol_out,
    SUM(CASE WHEN s.side = 'BUY'  THEN s.token_amount ELSE 0 END)           AS tok_bought,
    SUM(CASE WHEN s.side = 'SELL' THEN s.token_amount ELSE 0 END)           AS tok_sold,
    COUNT(*)                                                                AS n_swaps
  FROM swaps s
  GROUP BY 1, 2
  HAVING SUM(CASE WHEN s.side = 'BUY' THEN s.sol_amount ELSE 0 END) > 0
),

-- Realised return, with unclosed residual marked at last observed price.
position_pnl AS (
  SELECT
    pos.trader_id,
    pos.mint,
    pos.first_buy,
    pos.n_swaps,
    pos.sol_in,
    pos.tok_bought - pos.tok_sold                                           AS tok_residual,
    (pos.tok_bought - pos.tok_sold) * COALESCE(lp.sol_per_token, 0)         AS residual_value,
    pos.tok_sold >= 0.99 * pos.tok_bought                                   AS is_closed,
    -- primary: carry-forward marked
    (pos.sol_out + (pos.tok_bought - pos.tok_sold) * COALESCE(lp.sol_per_token, 0)
       - pos.sol_in) / NULLIF(pos.sol_in, 0)                               AS ret_carryfwd,
    -- sensitivity: unclosed residual worth nothing
    (pos.sol_out - pos.sol_in) / NULLIF(pos.sol_in, 0)                      AS ret_zero
  FROM positions pos
  LEFT JOIN last_price lp ON lp.mint = pos.mint
)

-- ============================================================================
-- QUERY 1 — POSITION RECONSTRUCTION SANITY CHECK
-- Run this first. If the closed-position share is implausible or returns are
-- absurd, the schema assumptions are wrong and nothing downstream is valid.
-- ============================================================================
SELECT
  COUNT(*)                                              AS positions,
  COUNT(DISTINCT trader_id)                             AS wallets,
  COUNT(DISTINCT mint)                                  AS mints,
  AVG(CASE WHEN is_closed THEN 1.0 ELSE 0.0 END)        AS closed_share,
  APPROX_PERCENTILE(ret_carryfwd, 0.10)                 AS p10,
  APPROX_PERCENTILE(ret_carryfwd, 0.50)                 AS median,
  APPROX_PERCENTILE(ret_carryfwd, 0.90)                 AS p90,
  AVG(ret_carryfwd)                                     AS mean_carryfwd,
  AVG(ret_zero)                                         AS mean_zero_marked,
  STDDEV(ret_carryfwd)                                  AS sd
FROM position_pnl;


-- ============================================================================
-- QUERY 2 — RANK WALLETS ON THE FIT WINDOW, WITH DISAPPEARANCE ACCOUNTING
--
-- Rank by MEAN return per position, never total PnL — total PnL just
-- rediscovers the wallets with the most capital.
-- ============================================================================
-- (prepend the SHARED BASE block)
, fit_wallets AS (
  SELECT
    pp.trader_id,
    COUNT(*)                          AS n_fit,
    AVG(pp.ret_carryfwd)              AS mean_ret_fit,
    STDDEV(pp.ret_carryfwd)           AS sd_fit,
    APPROX_PERCENTILE(pp.ret_carryfwd, 0.5) AS median_ret_fit,
    SUM(pp.sol_in)                    AS sol_deployed_fit
  FROM position_pnl pp
  CROSS JOIN params p
  WHERE pp.first_buy >= p.fit_start AND pp.first_buy < p.fit_end
  GROUP BY 1
  HAVING COUNT(*) >= (SELECT min_positions_fit FROM params)
),

ranked AS (
  SELECT
    fw.*,
    NTILE(10) OVER (ORDER BY fw.mean_ret_fit DESC) AS fit_decile
  FROM fit_wallets fw
),

-- Every fit wallet's holdout activity, INCLUDING wallets that vanished.
-- Disappearance is an outcome, not an exclusion.
holdout_activity AS (
  SELECT
    r.trader_id,
    r.fit_decile,
    r.mean_ret_fit,
    COUNT(pp.mint)              AS n_hold,
    AVG(pp.ret_carryfwd)        AS mean_ret_hold
  FROM ranked r
  LEFT JOIN position_pnl pp
    ON pp.trader_id = r.trader_id
   AND pp.first_buy >= (SELECT hold_start FROM params)
   AND pp.first_buy <  (SELECT hold_end   FROM params)
  GROUP BY 1, 2, 3
)

SELECT
  fit_decile,
  COUNT(*)                                                   AS wallets_in_decile,
  AVG(mean_ret_fit)                                          AS avg_fit_return,
  SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END)                AS vanished,
  1.0 * SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END) / COUNT(*) AS vanish_rate,
  AVG(CASE WHEN n_hold > 0 THEN mean_ret_hold END)           AS avg_holdout_return,
  SUM(n_hold)                                                AS holdout_positions
FROM holdout_activity
GROUP BY 1
ORDER BY 1;

-- READ THIS TABLE AS FOLLOWS:
--   * avg_holdout_return flat across deciles  -> no persistence. Branch closes.
--   * decile 1 holdout return > population AND > 2.69% -> persistence worth testing.
--   * vanish_rate rising in decile 1 -> the winners are blowing up and
--     the fit ranking is selecting variance, not skill.


-- ============================================================================
-- QUERY 3 — HOLDOUT PANEL FOR OFFLINE DAY-CLUSTERED BOOTSTRAP
--
-- Dune cannot bootstrap. Export this panel and run it through the same
-- day-clustered bootstrap the Phase B cell ledger used. One preregistered
-- hypothesis: "top decile by fit rank beats the population in holdout."
-- That is ONE test, not one per wallet.
-- ============================================================================
-- (prepend SHARED BASE and the fit_wallets / ranked CTEs from query 2)
SELECT
  DATE(pp.first_buy)                                         AS utc_day,
  CASE WHEN r.fit_decile = 1 THEN 'TOP_DECILE' ELSE 'REST' END AS cohort,
  pp.trader_id,
  pp.mint,
  pp.first_buy,
  pp.sol_in,
  pp.is_closed,
  pp.ret_carryfwd,
  pp.ret_zero
FROM position_pnl pp
JOIN ranked r ON r.trader_id = pp.trader_id
CROSS JOIN params p
WHERE pp.first_buy >= p.hold_start AND pp.first_buy < p.hold_end
ORDER BY utc_day, cohort;


-- ============================================================================
-- QUERY 4 — THE VERSION B TEST (the one that maps onto your apparatus)
--
-- Not "can I copy the wallet" but "does a good wallet's early presence predict
-- the TOKEN's forward return." No latency requirement. This is the query that
-- becomes a screening feature if it works.
-- ============================================================================
-- (prepend SHARED BASE and the fit_wallets / ranked CTEs from query 2)
, mint_first_seen AS (
  SELECT mint, MIN(block_time) AS t0
  FROM swaps
  GROUP BY 1
),

-- Was any top-decile wallet among the buyers in the first 10 minutes?
flagged_mints AS (
  SELECT
    mfs.mint,
    mfs.t0,
    MAX(CASE WHEN r.fit_decile = 1 THEN 1 ELSE 0 END) AS top_wallet_present
  FROM mint_first_seen mfs
  JOIN swaps s
    ON s.mint = mfs.mint
   AND s.side = 'BUY'
   AND s.block_time <= mfs.t0 + INTERVAL '10' minute
  LEFT JOIN ranked r ON r.trader_id = s.trader_id
  CROSS JOIN params p
  WHERE mfs.t0 >= p.hold_start AND mfs.t0 < p.hold_end
  GROUP BY 1, 2
),

-- VWAP price in a window, used for both entry and exit marks.
priced AS (
  SELECT
    fm.mint,
    fm.top_wallet_present,
    SUM(CASE WHEN s.block_time BETWEEN fm.t0 + INTERVAL '10' minute
                                   AND fm.t0 + INTERVAL '12' minute
             THEN s.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN s.block_time BETWEEN fm.t0 + INTERVAL '10' minute
                                              AND fm.t0 + INTERVAL '12' minute
                        THEN s.token_amount ELSE 0 END), 0)      AS entry_px,
    SUM(CASE WHEN s.block_time BETWEEN fm.t0 + INTERVAL '70' minute
                                   AND fm.t0 + INTERVAL '72' minute
             THEN s.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN s.block_time BETWEEN fm.t0 + INTERVAL '70' minute
                                              AND fm.t0 + INTERVAL '72' minute
                        THEN s.token_amount ELSE 0 END), 0)      AS exit_px
  FROM flagged_mints fm
  JOIN swaps s ON s.mint = fm.mint
  GROUP BY 1, 2
)

SELECT
  top_wallet_present,
  COUNT(*)                                                   AS mints,
  SUM(CASE WHEN exit_px IS NULL THEN 1 ELSE 0 END)           AS censored_no_exit_price,
  AVG(exit_px / NULLIF(entry_px, 0) - 1)                     AS mean_fwd_return,
  APPROX_PERCENTILE(exit_px / NULLIF(entry_px, 0) - 1, 0.5)  AS median_fwd_return,
  STDDEV(exit_px / NULLIF(entry_px, 0) - 1)                  AS sd_fwd_return
FROM priced
WHERE entry_px IS NOT NULL
GROUP BY 1;

-- DECISION RULE, frozen before running:
--   The flagged group must beat the unflagged group by more than 2.69%
--   on a day-clustered 95% lower bound, in the holdout window, to be worth
--   building. Point estimates do not count -- Phase B had 81 tradable cells
--   with positive point estimates and zero that survived a lower bound.
--
-- CENSORING: censored_no_exit_price is the column that killed the Phase B
--   bonding-curve thesis at 94%. Watch it here. If it exceeds ~50% in either
--   group, the means are survivor-conditioned and the comparison is not valid
--   until carry-forward is applied.
