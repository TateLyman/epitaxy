-- ============================================================================
-- EPITAXY — WALLET PERSISTENCE TEST, v2 (Dune / Trino SQL)
--
-- Corrected from the delivered v1. Every change is listed with its reason in
-- docs/WALLET_PERSISTENCE_REVIEW.md; the four that change an ANSWER rather than
-- a style are:
--
--   D1  v1 aggregated each (wallet, mint) position over the WHOLE span, so a
--       fit-window ranking was computed partly from holdout-window sells and
--       from a carry-forward mark taken up to two months after fit_end. The fit
--       ranking saw the future. Positions are now aggregated inside a window,
--       with sells truncated at the window edge and the residual marked at a
--       price observed before that edge.
--   D2  v1 said to subtract the 2.69% round-trip cost floor from wallet
--       returns. For a wallet's OWN realised return that double counts: the
--       AMM fee and the impact are already inside the on-chain amounts. What is
--       missing is the fixed cost — base fee plus priority fee, 12,094 lamports
--       a round trip, about 6 bps on a 0.02 SOL position. The full floor DOES
--       apply to query 4, where we would be the one trading.
--   D3  v1's query 4 decision rule required the flagged group to beat the
--       unflagged group BY MORE THAN the cost floor. The floor cancels in a
--       difference — both groups pay it. The difference must clear zero and the
--       flagged group's own LEVEL must clear the floor. Two tests, not one.
--   D4  a position that buys on the bonding curve and sells on the AMM is one
--       economic position. v1 would have been keyed correctly, but nothing
--       recorded WHERE the entry happened — and Phase B established that this
--       apparatus can only enter the AMM side. Every output now carries
--       entry_project, so the pumpswap-only slice can be read on its own.
--
-- Everything here is DEVELOPMENT_RECONSTRUCTED. Nothing is evidence.
-- All returns are GROSS of our own execution costs. See D2 for what to subtract.
--
-- SCHEMA CAUTION: Dune's Solana DEX columns change. Verify names in the schema
-- explorer before running. Columns assumed:
--   block_time, project, trader_id, tx_id,
--   token_bought_mint_address, token_sold_mint_address,
--   token_bought_amount, token_sold_amount
--
-- THE BASE BLOCK BETWEEN THE >>> MARKERS IS IDENTICAL IN ALL FOUR QUERIES.
-- Dune runs one statement at a time and cannot share a CTE across queries, so
-- it is repeated rather than assembled by hand — v1's "prepend the shared base"
-- instruction is the kind of step that silently gets done differently twice.
-- If you edit it, edit all four copies.
-- ============================================================================


-- ############################################################################
-- QUERY 1 — POSITION RECONSTRUCTION SANITY CHECK
--
-- Run first. If the closed share is implausible, the external-inflow share is
-- large, or the returns are absurd, the schema assumptions are wrong and
-- nothing downstream means anything.
-- ############################################################################

--#BASE
-- >>> BASE v2: composed into every query by scripts/dune-assemble.ts >>>
WITH params AS (
  SELECT
    TIMESTAMP '2026-05-01 00:00:00' AS lookback_start,  -- only for mint first-seen
    TIMESTAMP '2026-06-01 00:00:00' AS fit_start,
    TIMESTAMP '2026-07-15 00:00:00' AS fit_end,
    TIMESTAMP '2026-07-16 00:00:00' AS hold_start,
    TIMESTAMP '2026-08-15 00:00:00' AS hold_end,
    'So11111111111111111111111111111111111111112' AS wsol,
    20    AS min_positions_fit,   -- frozen before looking at any return
    0.10  AS top_fraction,        -- top decile. FROZEN. Do not tune.
    -- D2: the part of OUR cost that is NOT already inside an on-chain amount.
    -- 2 x (5,000 base + 1,047 priority) lamports, measured in D70B4A9A §1.1.
    0.000012094 AS fixed_cost_sol,
    -- The tier-0 round-trip floor, for query 4 only, where we do the trading.
    0.0269 AS round_trip_floor,
    /* MINIMUM POSITION SIZE. Frozen 2026-08-19, before query 2 ran, after query 1
       showed the mean was not estimable without it.
       ret = (sol_out + residual - sol_in) / sol_in is a ratio with an unbounded
       denominator: query 1 measured a median sol_in of 0.0214 SOL on holdout
       pumpswap positions, and the dust tail below that drove mean_carryfwd to
       +36.26 with an SD of 22,566 while the MEDIAN sat at a sane -0.2567. The
       same denominator made `mean_net_of_our_fixed_cost` -11.16, because
       12,094 lamports over a 1e-6 SOL position is a cost fraction of 12.
       0.01 SOL is not fitted to anything here: it is the notional at which
       D70B4A9A measured this system's own cost floor to be minimised, and below
       it our fixed costs alone exceed 13 bps of notional. No return was consulted
       to choose it. The excluded count is reported so the exclusion is visible. */
    0.01 AS min_sol_in,
    /* MARK LIQUIDITY. Frozen 2026-08-19 with min_sol_in, for the reason set out
       at edge_vwap: a mark from a final hour with one dust trade in it is not a
       price. 5 trades and 1 SOL are about OBSERVABILITY and reference no return. */
    5    AS mark_min_trades,
    1.0  AS mark_min_sol,
    -- PARTITION BOUNDS. `dex_solana.trades` is partitioned on block_date, and a
    -- predicate on block_time alone does not prune partitions — it reads them and
    -- then filters. These must agree with the timestamps above; they are declared
    -- here rather than inlined so that a reader can see the two side by side.
    -- Verified against information_schema on 2026-08-19: block_date is a date and
    -- block_month a date, both present.
    DATE '2026-05-01' AS lookback_start_date,
    DATE '2026-06-01' AS fit_start_date,
    DATE '2026-08-15' AS hold_end_date
),

legs AS (
  SELECT
    t.block_time,
    t.trader_id,
    t.tx_id,
    t.project,
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
         ELSE t.token_bought_amount END                 AS token_amount,
    -- D1: which window this LEG belongs to. A leg outside both is dropped.
    CASE
      WHEN t.block_time >= p.fit_start  AND t.block_time < p.fit_end  THEN 'FIT'
      WHEN t.block_time >= p.hold_start AND t.block_time < p.hold_end THEN 'HOLD'
    END                                                 AS window_tag
  FROM dex_solana.trades t
  CROSS JOIN params p
  WHERE t.project IN ('pumpdotfun', 'pumpswap')
    -- Partition prune first, then the exact instant.
    AND t.block_date >= p.fit_start_date
    AND t.block_date <= p.hold_end_date
    AND t.block_time >= p.fit_start
    AND t.block_time <  p.hold_end
    AND (t.token_bought_mint_address = p.wsol OR t.token_sold_mint_address = p.wsol)
    -- ...but not BOTH. A WSOL/WSOL row makes `mint` resolve to WSOL, which then
    -- carries a mark of about 1 SOL per "token" and a residual of WSOL held.
    -- One of the twelve largest returns in the FIT pumpswap tail was exactly
    -- this, marked at 1.0100 SOL per unit.
    AND NOT (t.token_bought_mint_address = p.wsol AND t.token_sold_mint_address = p.wsol)
    AND t.token_bought_amount > 0
    AND t.token_sold_amount   > 0
),

windowed AS (SELECT * FROM legs WHERE window_tag IS NOT NULL),

-- D1 + v1 bug: a mark taken from a single trade at an unspecified tiebreak.
-- VWAP over the last hour of the window, per mint, per window. A window with no
-- trade in its final hour falls back to its own last trade, tie-broken on tx_id
-- so the answer is deterministic.
window_edge AS (
  SELECT w.window_tag,
         CASE WHEN w.window_tag = 'FIT' THEN p.fit_end ELSE p.hold_end END AS edge
  FROM (SELECT DISTINCT window_tag FROM windowed) w
  CROSS JOIN params p
),

/*
   A MARK IS A MEASUREMENT AND AN UNMEASURABLE ONE IS NOT A VALUE.

   The first run of query 1 returned mean_carryfwd = +37.91 with an SD of 21,827
   on FIT pumpswap while the median sat at -0.2334. The diagnostic (12 largest
   returns, every component) attributed all of it to the residual MARK: positions
   that paid 2.8e-11 SOL a token and were marked at 0.00064, or paid 1.1e-7 and
   were marked at 3.39 — six to seven orders of magnitude apart inside one window,
   which is not a price move. The same wrong mark recurred across five positions,
   so it is per-mint, and it comes from a final hour with almost nothing in it.

   So the mark window must be liquid to produce a mark: at least
   `mark_min_trades` trades and `mark_min_sol` of volume. These are availability
   thresholds, not tuning knobs — they are about whether a price was observed at
   all, and they are deliberately NOT a bound on how far the price may have moved.
   A cap on the move would discard exactly the genuine winners this project has
   repeatedly found to be the whole tail.
*/
edge_vwap AS (
  SELECT
    w.window_tag,
    w.mint,
    SUM(w.sol_amount)   AS sol_sum,
    SUM(w.token_amount) AS tok_sum,
    COUNT(*)            AS mark_trades
  FROM windowed w
  JOIN window_edge e ON e.window_tag = w.window_tag
  WHERE w.block_time >= e.edge - INTERVAL '60' MINUTE
  GROUP BY 1, 2
  HAVING SUM(w.token_amount) > 0
     AND COUNT(*) >= (SELECT mark_min_trades FROM params)
     AND SUM(w.sol_amount) >= (SELECT mark_min_sol FROM params)
),

edge_last AS (
  SELECT window_tag, mint, sol_per_token
  FROM (
    SELECT
      w.window_tag,
      w.mint,
      w.sol_amount / NULLIF(w.token_amount, 0) AS sol_per_token,
      ROW_NUMBER() OVER (
        PARTITION BY w.window_tag, w.mint
        ORDER BY w.block_time DESC, w.tx_id DESC
      ) AS rn
    FROM windowed w
    WHERE w.token_amount > 0
      AND w.sol_amount >= (SELECT mark_min_sol FROM params)
  ) x
  WHERE rn = 1
),

mark_price AS (
  SELECT
    COALESCE(v.window_tag, l.window_tag) AS window_tag,
    COALESCE(v.mint, l.mint)             AS mint,
    COALESCE(v.sol_sum / NULLIF(v.tok_sum, 0), l.sol_per_token) AS sol_per_token,
    COALESCE(v.mark_trades, 1)                                  AS mark_trades
  FROM edge_vwap v
  FULL OUTER JOIN edge_last l
    ON l.window_tag = v.window_tag AND l.mint = v.mint
),

-- Where the FIRST buy happened, by row number rather than by min_by: min_by's
-- behaviour with a null sort key is one more thing that would have to be
-- verified against the engine, and this cannot be.
entry_venue AS (
  SELECT window_tag, trader_id, mint, project AS entry_project
  FROM (
    SELECT
      w.window_tag, w.trader_id, w.mint, w.project,
      ROW_NUMBER() OVER (
        PARTITION BY w.window_tag, w.trader_id, w.mint
        ORDER BY w.block_time ASC, w.tx_id ASC
      ) AS rn
    FROM windowed w
    WHERE w.side = 'BUY'
  ) x
  WHERE rn = 1
),

-- One row per (window, wallet, mint) = one position, closed at the window edge.
-- D4: keyed WITHOUT project, so a curve buy and an AMM sell stay one position;
-- entry_project records where the first buy happened.
positions AS (
  SELECT
    w.window_tag,
    w.trader_id,
    w.mint,
    MIN(CASE WHEN w.side = 'BUY'  THEN w.block_time END)          AS first_buy,
    MAX(CASE WHEN w.side = 'SELL' THEN w.block_time END)          AS last_sell,
    COUNT(DISTINCT w.project)                                     AS projects_touched,
    SUM(CASE WHEN w.side = 'BUY'  THEN w.sol_amount   ELSE 0 END) AS sol_in,
    SUM(CASE WHEN w.side = 'SELL' THEN w.sol_amount   ELSE 0 END) AS sol_out,
    SUM(CASE WHEN w.side = 'BUY'  THEN w.token_amount ELSE 0 END) AS tok_bought,
    SUM(CASE WHEN w.side = 'SELL' THEN w.token_amount ELSE 0 END) AS tok_sold,
    COUNT(*)                                                      AS n_legs,
    COUNT(DISTINCT w.tx_id)                                       AS n_txs
  FROM windowed w
  GROUP BY 1, 2, 3
  HAVING SUM(CASE WHEN w.side = 'BUY' THEN w.sol_amount ELSE 0 END) > 0
     AND MIN(CASE WHEN w.side = 'BUY' THEN w.block_time END) IS NOT NULL
),


position_pnl AS (
  SELECT
    pos.window_tag,
    pos.trader_id,
    pos.mint,
    ev.entry_project,
    pos.projects_touched,
    pos.first_buy,
    pos.last_sell,
    pos.n_legs,
    pos.n_txs,
    pos.sol_in,
    pos.sol_out,
    pos.tok_bought - pos.tok_sold                        AS tok_residual,
    -- v1 bug: a NEGATIVE residual means the wallet sold tokens it did not buy
    -- here — a transfer in, a route through a venue outside the filter, or an
    -- airdrop. Its sol_out is then partly proceeds from tokens never paid for,
    -- which overstates the return. Flagged and clamped, never silently summed.
    pos.tok_sold > 1.01 * pos.tok_bought                 AS external_inflow,
    pos.sol_in < (SELECT min_sol_in FROM params)         AS below_min_size,
    GREATEST(pos.tok_bought - pos.tok_sold, 0)
      * COALESCE(mp.sol_per_token, 0)                    AS residual_value,
    pos.tok_sold >= 0.99 * pos.tok_bought                AS is_closed,
    -- An open position whose mark is unavailable. `COALESCE(mark, 0)` used to
    -- turn that into a -100% return silently, which is the harsh half of the
    -- choice the delivered file's own comment warned about.
    mp.sol_per_token IS NULL AND pos.tok_sold < 0.99 * pos.tok_bought AS unmarkable,
    -- primary: residual marked at the window-edge price, and NULL — not a
    -- zero-marked -100% — when there is no mark to use.
    CASE
      WHEN mp.sol_per_token IS NULL AND pos.tok_sold < 0.99 * pos.tok_bought THEN NULL
      ELSE (pos.sol_out + GREATEST(pos.tok_bought - pos.tok_sold, 0) * COALESCE(mp.sol_per_token, 0)
             - pos.sol_in) / NULLIF(pos.sol_in, 0)
    END                                                  AS ret_carryfwd,
    -- sensitivity: residual worth nothing
    (pos.sol_out - pos.sol_in) / NULLIF(pos.sol_in, 0)   AS ret_zero,
    -- D2: OUR fixed cost only. The AMM fee and the impact are already inside
    -- sol_in and sol_out, so subtracting the 2.69% floor here double counts it.
    (SELECT fixed_cost_sol FROM params) / NULLIF(pos.sol_in, 0) AS fixed_cost_fraction
  FROM positions pos
  LEFT JOIN mark_price mp
    ON mp.window_tag = pos.window_tag AND mp.mint = pos.mint
  LEFT JOIN entry_venue ev
    ON ev.window_tag = pos.window_tag AND ev.trader_id = pos.trader_id AND ev.mint = pos.mint
)
-- <<< BASE v2 ends <<<
--#END
--#Q1 needs=BASE

SELECT
  window_tag,
  entry_project,
  COUNT(*)                                                        AS positions_all,
  SUM(CASE WHEN below_min_size THEN 1 ELSE 0 END)                 AS below_min_size,
  AVG(CASE WHEN below_min_size THEN 1e0 ELSE 0e0 END)             AS below_min_size_share,
  COUNT_IF(NOT below_min_size)                                    AS positions,
  COUNT(DISTINCT CASE WHEN NOT below_min_size THEN trader_id END) AS wallets,
  COUNT(DISTINCT CASE WHEN NOT below_min_size THEN mint END)      AS mints,
  -- Every share below is a DOUBLE. As decimal literals these came back
  -- quantised to one decimal place, because Trino's AVG over decimal(2,1)
  -- returns decimal(38,1): closed_share read exactly '0.9' on 24,009,833 rows.
  AVG(CASE WHEN is_closed        AND NOT below_min_size THEN 1e0 ELSE 0e0 END) AS closed_share,
  AVG(CASE WHEN external_inflow  AND NOT below_min_size THEN 1e0 ELSE 0e0 END) AS external_inflow_share,
  AVG(CASE WHEN unmarkable       AND NOT below_min_size THEN 1e0 ELSE 0e0 END) AS unmarkable_share,
  AVG(CASE WHEN projects_touched > 1 AND NOT below_min_size THEN 1e0 ELSE 0e0 END) AS spans_both_venues_share,
  -- The statistics, on positions at or above the frozen minimum.
  APPROX_PERCENTILE(CASE WHEN NOT below_min_size THEN ret_carryfwd END, 0.10) AS p10,
  APPROX_PERCENTILE(CASE WHEN NOT below_min_size THEN ret_carryfwd END, 0.50) AS median,
  APPROX_PERCENTILE(CASE WHEN NOT below_min_size THEN ret_carryfwd END, 0.90) AS p90,
  AVG(CASE WHEN NOT below_min_size THEN ret_carryfwd END)         AS mean_carryfwd,
  AVG(CASE WHEN NOT below_min_size THEN ret_zero END)             AS mean_zero_marked,
  AVG(CASE WHEN NOT below_min_size THEN ret_carryfwd - fixed_cost_fraction END) AS mean_net_of_our_fixed_cost,
  STDDEV(CASE WHEN NOT below_min_size THEN ret_carryfwd END)      AS sd,
  APPROX_PERCENTILE(CASE WHEN NOT below_min_size THEN sol_in END, 0.50) AS median_sol_in,
  -- And the same mean over EVERYTHING, so the effect of the minimum is visible
  -- in the same row rather than inferred between two runs.
  AVG(ret_carryfwd)                                               AS mean_carryfwd_unfiltered,
  STDDEV(ret_carryfwd)                                            AS sd_unfiltered
FROM position_pnl
WHERE NOT external_inflow
GROUP BY 1, 2
ORDER BY 1, 2;

-- WHAT WOULD INVALIDATE EVERYTHING BELOW:
--   * closed_share near 0 or near 1        -> the side classification is wrong
--   * external_inflow_share above ~0.2     -> the WSOL-only filter is dropping
--                                             a leg type that matters
--   * median far from roughly -0.03        -> our own executable marks put the
--                                             median hour-old position at -2.7%
--                                             (the cost floor). A median of +0.5
--                                             or -0.9 means this is not the same
--                                             quantity.
--   * spans_both_venues_share large        -> read the pumpswap slice separately;
--                                             see D4.


-- ############################################################################
-- QUERY 2 — RANK ON THE FIT WINDOW, WITH DISAPPEARANCE ACCOUNTING
--
-- Ranked on MEAN return per position, and on MEDIAN beside it. A heavy-tailed
-- distribution ranked on the mean selects wallets with one huge winner, which is
-- variance and not skill; if the two rankings disagree, that is the finding.
-- ############################################################################

--#END
--#RANK needs=BASE
,
fit_wallets AS (
  SELECT
    pp.trader_id,
    COUNT(*)                                  AS n_fit,
    AVG(pp.ret_carryfwd)                      AS mean_ret_fit,
    APPROX_PERCENTILE(pp.ret_carryfwd, 0.5)   AS median_ret_fit,
    STDDEV(pp.ret_carryfwd)                   AS sd_fit,
    SUM(pp.sol_in)                            AS sol_deployed_fit,
    APPROX_PERCENTILE(pp.sol_in, 0.5)         AS median_sol_in_fit,
    AVG(CASE WHEN pp.entry_project = 'pumpswap' THEN 1e0 ELSE 0e0 END) AS amm_entry_share
  FROM position_pnl pp
  WHERE pp.window_tag = 'FIT'
    AND NOT pp.external_inflow
    AND NOT pp.below_min_size
  GROUP BY 1
  HAVING COUNT(*) >= (SELECT min_positions_fit FROM params)
),

-- top_fraction is now USED rather than declared and hardcoded as NTILE(10).
ranked AS (
  SELECT
    fw.*,
    COUNT(*) OVER ()                                           AS wallets_qualifying,
    NTILE(10) OVER (ORDER BY fw.mean_ret_fit DESC)             AS fit_decile,
    ROW_NUMBER() OVER (ORDER BY fw.mean_ret_fit DESC)          AS rank_by_mean,
    ROW_NUMBER() OVER (ORDER BY fw.median_ret_fit DESC)        AS rank_by_median
  FROM fit_wallets fw
),

flagged AS (
  SELECT
    r.*,
    r.rank_by_mean   <= CEIL((SELECT top_fraction FROM params) * r.wallets_qualifying) AS top_by_mean,
    r.rank_by_median <= CEIL((SELECT top_fraction FROM params) * r.wallets_qualifying) AS top_by_median
  FROM ranked r
),

-- Every fit wallet's holdout activity, INCLUDING wallets that vanished.
-- Disappearance is an outcome, not an exclusion.
holdout_activity AS (
  SELECT
    f.trader_id,
    f.fit_decile,
    f.top_by_mean,
    f.top_by_median,
    f.mean_ret_fit,
    f.median_ret_fit,
    COUNT(pp.mint)                                     AS n_hold,
    AVG(pp.ret_carryfwd)                               AS mean_ret_hold,
    APPROX_PERCENTILE(pp.ret_carryfwd, 0.5)            AS median_ret_hold,
    SUM(pp.sol_in)                                     AS sol_deployed_hold,
    -- position-weighted, so a 1-position wallet cannot outvote a 200-position one
    SUM(pp.ret_carryfwd * pp.sol_in) / NULLIF(SUM(pp.sol_in), 0) AS sol_weighted_ret_hold
  FROM flagged f
  LEFT JOIN position_pnl pp
    ON pp.trader_id = f.trader_id
   AND pp.window_tag = 'HOLD'
   AND NOT pp.external_inflow
   AND NOT pp.below_min_size
  GROUP BY 1, 2, 3, 4, 5, 6
)

--#END
--#Q2 needs=BASE,RANK
SELECT
  fit_decile,
  COUNT(*)                                                     AS wallets_in_decile,
  AVG(mean_ret_fit)                                            AS avg_fit_return,
  AVG(median_ret_fit)                                          AS avg_fit_median,
  SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END)                  AS vanished,
  1e0 * SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END) / COUNT(*) AS vanish_rate,
  AVG(CASE WHEN n_hold > 0 THEN mean_ret_hold END)             AS avg_holdout_return,
  AVG(CASE WHEN n_hold > 0 THEN median_ret_hold END)           AS avg_holdout_median,
  AVG(CASE WHEN n_hold > 0 THEN sol_weighted_ret_hold END)     AS avg_holdout_sol_weighted,
  SUM(n_hold)                                                  AS holdout_positions,
  SUM(CASE WHEN top_by_mean AND NOT top_by_median THEN 1 ELSE 0 END) AS top_on_mean_only
FROM holdout_activity
GROUP BY 1
ORDER BY 1;

-- READ THIS TABLE AS FOLLOWS:
--   * avg_holdout_return flat across deciles      -> no persistence. Branch closes.
--   * decile 1 above the population AND above its
--     own fixed cost (about 6 bps, not 2.69% —
--     see D2)                                     -> persistence worth testing,
--                                                    and only on a lower bound.
--   * vanish_rate rising in decile 1              -> the fit ranking is selecting
--                                                    variance, not skill.
--   * top_on_mean_only large                      -> the mean ranking and the
--                                                    median ranking disagree, so
--                                                    "top decile" is a statement
--                                                    about one outlier per wallet.
--
-- VANISHING IS THREE THINGS AND THIS COLUMN CANNOT SEPARATE THEM: stopped
-- trading, rotated to a fresh address, or blew up. Pump snipers rotate
-- constantly, and rotation reads here as a blow-up. Separating them needs the
-- funding graph (packages/intelligence/src/entity-links.ts does this on-chain
-- walk for holders already) and is a prerequisite for believing any persistence
-- result, positive or negative.


-- ############################################################################
-- QUERY 3 — HOLDOUT PANEL FOR THE OFFLINE DAY-CLUSTERED BOOTSTRAP
--
-- Dune cannot bootstrap. Export this and run it through the same day-clustered
-- bootstrap the Phase B cell ledger used (packages/research/src/robust-stats.ts,
-- clusterBootstrap with clusterKind 'UTC_DAY').
--
-- ONE preregistered hypothesis: "top decile by fit rank beats the rest in the
-- holdout window." One test. Not one per wallet, not one per decile.
-- ############################################################################

--#END
--#Q3 needs=BASE,RANK
/*
   PER-DAY SUFFICIENT STATISTICS, not the raw panel.

   A day-clustered bootstrap of a MEAN resamples DAYS with replacement, and the
   mean over a resampled set of days is SUM(day sums) / SUM(day counts). So the
   panel it needs is (day, cohort) -> n and sum, not one row per position. The raw
   panel is ~9M holdout positions at 14 columns; Dune bills on datapoints returned
   and that export would cost more than the entire monthly allowance while
   supporting exactly the same interval on the mean.

   What is lost by aggregating: a bootstrap of the MEDIAN, and per-position
   diagnostics. Both need the raw rows. The medians are reported per day here so
   their day-to-day spread is still visible, and a raw export remains available by
   reverting this section — at a cost that must be budgeted deliberately rather
   than discovered.

   The cohort is cut on the fit MEDIAN. `top_by_mean` is also carried, so the two
   cuts can be compared on the same panel: query 1 found the mean of ret_carryfwd
   contaminated by residual marks on open pumpswap positions, and a median cut
   cannot be moved by one bad mark in a 20-position wallet.
*/
SELECT
  CAST(pp.first_buy AS DATE)                                     AS utc_day,
  -- FOUR-WAY, so BOTH decile definitions are recoverable from ONE export.
  -- MT073 froze the ranking as the MEAN with the median reported beside it, and
  -- then query 1 found the mean of ret_carryfwd contaminated by residual marks on
  -- open pumpswap positions. Cutting on the median instead is a measurement-driven
  -- deviation from a preregistered rule, and the honest way to handle it is to
  -- report the preregistered cut AND the robust cut from the same panel rather
  -- than to quietly substitute one for the other:
  --   top by mean   = TOP_BOTH + TOP_MEAN_ONLY
  --   top by median = TOP_BOTH + TOP_MEDIAN_ONLY
  CASE
    WHEN f.top_by_median AND f.top_by_mean THEN 'TOP_BOTH'
    WHEN f.top_by_median                   THEN 'TOP_MEDIAN_ONLY'
    WHEN f.top_by_mean                     THEN 'TOP_MEAN_ONLY'
    ELSE 'REST_NEITHER'
  END                                                            AS cohort,
  pp.entry_project,
  -- EVERY holdout position, then the exclusions as counts beside the estimate.
  -- The exclusions are not incidental: if the top cohort loses a different
  -- FRACTION of its positions to unmarkability than the rest does, the interval
  -- below is a comparison between two differently-selected populations and the
  -- gradient can be manufactured entirely by that selection. Filtering in the
  -- WHERE clause would hide the rate that decides whether the result is real.
  COUNT(*)                                                       AS n_all,
  COUNT_IF(pp.external_inflow)                                   AS n_external_inflow,
  COUNT_IF(pp.below_min_size)                                    AS n_below_min_size,
  COUNT_IF(pp.unmarkable)                                        AS n_unmarkable,
  COUNT(DISTINCT pp.trader_id)                                   AS wallets,
  -- The estimation set: in-scope size, own funding, and a usable mark.
  COUNT_IF(pp.keep)                                              AS n,
  SUM(IF(pp.keep, pp.ret_carryfwd, 0e0))                         AS sum_ret,
  SUM(IF(pp.keep, pp.ret_carryfwd * pp.ret_carryfwd, 0e0))       AS sum_ret_sq,
  SUM(IF(pp.keep, pp.ret_zero, 0e0))                             AS sum_ret_zero,
  COUNT_IF(pp.keep AND pp.ret_carryfwd > 0)                      AS n_positive,
  SUM(IF(pp.keep, pp.sol_in, 0e0))                               AS sum_sol_in,
  SUM(IF(pp.keep, pp.ret_carryfwd * pp.sol_in, 0e0))             AS sum_ret_times_sol_in,
  APPROX_PERCENTILE(IF(pp.keep, pp.ret_carryfwd, NULL), 0.5)     AS median_ret,
  -- CLOSED-ONLY subset, sold >= 99% of what was bought, so its return contains
  -- no mark at all. This is the subset that answers the second way the gradient
  -- could be an artifact: ranking wallets on a return that depends on a mark
  -- would rank wallets by how they EXIT, and exit style persists across windows
  -- without any skill being involved. If the difference survives here it is not
  -- a marking artifact, and if it does not survive that is the finding.
  COUNT_IF(pp.keep AND pp.is_closed)                             AS n_closed,
  SUM(IF(pp.keep AND pp.is_closed, pp.ret_carryfwd, 0e0))        AS sum_ret_closed,
  SUM(IF(pp.keep AND pp.is_closed, pp.sol_in, 0e0))              AS sum_sol_in_closed
FROM (SELECT *, NOT external_inflow AND NOT below_min_size AND ret_carryfwd IS NOT NULL AS keep
      FROM position_pnl) pp
JOIN flagged f ON f.trader_id = pp.trader_id
WHERE pp.window_tag = 'HOLD'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;


-- ############################################################################
-- QUERY 4 — THE VERSION B TEST (the one that maps onto the apparatus)
--
-- Not "can I copy the wallet" but "does a good wallet's early presence predict
-- the TOKEN's forward return." No latency requirement. This is the query that
-- becomes a screening feature if it works.
--
-- D3: the decision rule is TWO tests, not one. The cost floor cancels in the
-- difference between two groups that both pay it; it does not cancel in the
-- level. See the bottom of this file.
-- ############################################################################

--#END
--#Q4 needs=BASE,RANK
,
-- v1 bug: first-seen was computed over the sample span, so a mint that traded
-- before fit_start looked new. The lookback window exists only for this.
mint_first_seen AS (
  SELECT
    CASE WHEN t.token_bought_mint_address = p.wsol
         THEN t.token_sold_mint_address
         ELSE t.token_bought_mint_address END AS mint,
    MIN(t.block_time)                         AS t0
  FROM dex_solana.trades t
  CROSS JOIN params p
  WHERE t.project IN ('pumpdotfun', 'pumpswap')
    AND t.block_date >= p.lookback_start_date
    AND t.block_date <= p.hold_end_date
    AND t.block_time >= p.lookback_start
    AND t.block_time <  p.hold_end
    AND (t.token_bought_mint_address = p.wsol OR t.token_sold_mint_address = p.wsol)
  GROUP BY 1
),

-- Three-way, not two. v1's flag conflated "a ranked wallet bought and it was not
-- top decile" with "no ranked wallet bought at all", which makes the control
-- group a mixture of two different populations.
flagged_mints AS (
  SELECT
    mfs.mint,
    mfs.t0,
    MAX(CASE WHEN f.top_by_mean THEN 1 ELSE 0 END)         AS top_mean_present,
    MAX(CASE WHEN f.top_by_median THEN 1 ELSE 0 END)        AS top_median_present,
    MAX(CASE WHEN f.trader_id IS NOT NULL THEN 1 ELSE 0 END) AS ranked_present,
    COUNT(DISTINCT l.trader_id)                            AS distinct_early_buyers
  FROM mint_first_seen mfs
  CROSS JOIN params p
  JOIN windowed l
    ON l.mint = mfs.mint
   AND l.side = 'BUY'
   AND l.block_time <= mfs.t0 + INTERVAL '10' MINUTE
  LEFT JOIN flagged f ON f.trader_id = l.trader_id
  WHERE mfs.t0 >= p.hold_start AND mfs.t0 < p.hold_end
  GROUP BY 1, 2
),

-- VWAP in a window, for both marks. Entry starts at t0+10m so it cannot overlap
-- the flag's own observation window — that part of v1 was right and is kept.
priced AS (
  SELECT
    fm.mint,
    fm.t0,
    -- Five-way for the same reason query 3 is four-way: the preregistered flag is
    -- the mean-ranked decile, the robust flag is the median-ranked decile, and one
    -- export has to answer both. TOP_PRESENT under either definition is a union of
    -- these categories, taken offline.
    CASE
      WHEN fm.top_median_present = 1 AND fm.top_mean_present = 1 THEN 'TOP_BOTH'
      WHEN fm.top_median_present = 1 THEN 'TOP_MEDIAN_ONLY'
      WHEN fm.top_mean_present = 1   THEN 'TOP_MEAN_ONLY'
      WHEN fm.ranked_present = 1     THEN 'RANKED_NOT_TOP'
      ELSE 'NO_RANKED_WALLET'
    END                                                       AS cohort,
    fm.distinct_early_buyers,
    SUM(CASE WHEN l.block_time BETWEEN fm.t0 + INTERVAL '10' MINUTE
                                   AND fm.t0 + INTERVAL '12' MINUTE
             THEN l.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN l.block_time BETWEEN fm.t0 + INTERVAL '10' MINUTE
                                              AND fm.t0 + INTERVAL '12' MINUTE
                        THEN l.token_amount ELSE 0 END), 0)    AS entry_px,
    SUM(CASE WHEN l.block_time BETWEEN fm.t0 + INTERVAL '70' MINUTE
                                   AND fm.t0 + INTERVAL '72' MINUTE
             THEN l.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN l.block_time BETWEEN fm.t0 + INTERVAL '70' MINUTE
                                              AND fm.t0 + INTERVAL '72' MINUTE
                        THEN l.token_amount ELSE 0 END), 0)    AS exit_px,
    -- Which venue the mint was trading on at the entry mark, since only the AMM
    -- side is enterable by this apparatus.
    MAX(CASE WHEN l.block_time BETWEEN fm.t0 + INTERVAL '10' MINUTE
                                   AND fm.t0 + INTERVAL '12' MINUTE
                  AND l.project = 'pumpswap' THEN 1 ELSE 0 END) AS amm_at_entry
  FROM flagged_mints fm
  JOIN windowed l ON l.mint = fm.mint
  GROUP BY 1, 2, 3, 4
)

/*
   PER-DAY SUFFICIENT STATISTICS, for the same reason query 3 emits them: MT074's
   decision rule is "day-clustered 95% lower bounds", and a bootstrap of a mean
   over resampled days needs only each day's n and sum. The cluster is the day the
   MINT first traded, which is what makes two mints born the same hour dependent
   draws rather than independent ones.

   CENSORING IS RETURNED AS A COUNT, not filtered away. A mint with no trade at
   all in the t0+70m..t0+72m window has no exit price because nobody was still
   trading it, which is the single most informative outcome in this dataset and the
   one an AVG silently drops. Adding those back at -100% is a bound the analysis
   applies offline; it cannot be applied here, because the level test and the
   difference test need it applied differently.

   The floor subtraction that was here has moved offline too. It cancels exactly in
   a difference and it does not cancel in a level, so a single column that has
   already subtracted it can only be right for one of the two tests.
*/
SELECT
  CAST(t0 AS DATE)                                                AS utc_day,
  cohort,
  amm_at_entry,
  COUNT(*)                                                        AS mints,
  COUNT_IF(exit_px IS NULL)                                       AS n_censored,
  COUNT_IF(exit_px IS NOT NULL)                                   AS n,
  SUM(IF(exit_px IS NOT NULL, exit_px / entry_px - 1e0, 0e0))     AS sum_ret,
  SUM(IF(exit_px IS NOT NULL, POWER(exit_px / entry_px - 1e0, 2), 0e0)) AS sum_ret_sq,
  COUNT_IF(exit_px IS NOT NULL AND exit_px > entry_px)            AS n_positive,
  APPROX_PERCENTILE(IF(exit_px IS NOT NULL, exit_px / entry_px - 1e0, NULL), 0.5) AS median_ret,
  APPROX_PERCENTILE(distinct_early_buyers, 0.5)                   AS median_early_buyers
FROM priced
WHERE entry_px IS NOT NULL
  AND entry_px > 0
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

--#END
-- ============================================================================
-- DECISION RULE, frozen before running. TWO tests, both required (D3).
--
--   TEST A — the difference.  TOP_PRESENT minus NO_RANKED_WALLET must exceed
--            ZERO on a day-clustered 95% lower bound. Not 2.69%: both cohorts
--            pay the same floor and it cancels in the difference. Requiring the
--            difference to beat the floor is a test nothing could pass.
--
--   TEST B — the level.  TOP_PRESENT's own mean must exceed the round-trip floor
--            for the tier those pools are in, on a day-clustered 95% lower
--            bound. A signal that separates cohorts but leaves the better one
--            under water is a signal with nothing to trade behind it.
--
--   Point estimates do not count. In Phase B, 81 of 270 evaluable tradable
--   cells carried a positive point estimate net of cost and ZERO survived a
--   day-clustered lower bound.
--
-- STRUCTURAL CENSORING AT THE EDGE: a mint whose t0 falls in the last 72
--   minutes of the holdout window has no t0+70m..t0+72m mark inside the window
--   and is counted as censored for a reason that is about the window boundary and
--   not about the token. At a 30-day holdout that is about 0.17% of the span, so
--   it is small — but it is not zero and it is not evenly spread, because launch
--   rates are not uniform across the day.
--
-- CENSORING: censored_share above ~0.5 in either cohort means the means are
--   survivor-conditioned and the comparison is not valid until a carry-forward
--   mark is applied. For scale, Phase B's own trigger cells ran at 83% to 95%
--   censoring in the holdout window; that did not kill the finding, but it is
--   why every Phase B mean is quoted with its censored fraction beside it.
--
-- AND THE ONE THAT IS NOT IN THIS FILE AT ALL: if TEST A and TEST B both pass,
--   what has been shown is that a good wallet's early presence predicts a mid
--   price. Quote-to-land slippage and crowding are still UNKNOWN, still
--   unmeasurable from this data, and still worst exactly here — a signal whose
--   whole content is "informed money is already buying" is a signal you are
--   racing. Phase B recorded both as UNKNOWN and every figure it produced as an
--   upper bound; the same applies to every number this file returns.
-- ============================================================================
