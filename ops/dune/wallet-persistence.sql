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
-- THE BASE BLOCK BETWEEN THE >>> MARKERS IS WRITTEN ONCE AND COMPOSED INTO EVERY
-- QUERY BY `pnpm dune:assemble`. Dune runs one statement at a time and cannot
-- share a CTE across queries, so v1 said "prepend the shared base" — the kind of
-- step that silently gets done differently twice — and v2 wrote it out four times,
-- which traded that for four copies that can drift. Neither is acceptable when the
-- corpus is this expensive to scan: edit this ONE copy and re-run the assembler.
-- The generated files under ops/dune/generated/ are derived and committed.
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
    /* PHASE C SELECTIVITY, MT080. top_fraction = 0.10 is 21,123 wallets and a
       decile cannot be mostly skill: published all-time base rates put roughly
       0.4% of pump.fun wallets above $10,000 realised and about 0.002% above $1M.
       These two cuts admit 212 and 2,113 wallets. Availability-driven, chosen from
       external base rates before any copier return existed, and they cost
       something real - the per-cell n falls by two orders of magnitude, which
       makes MT079's power condition binding rather than a formality. 0.10 is not
       re-run; it stands as reported in H1. */
    0.001 AS frac_tight,
    0.01  AS frac_mid,
    /* PHASE C LAG SWEEP. The copier's entry window is [T+L, T+L+entry_window_s)
       on the wallet's buy at T; the exit is [T+exit_at_s, T+exit_at_s+exit_window_s).
       The 60-minute exit is the Phase B convention and is deliberately NOT a new
       horizon: this phase introduces a new estimand and changing both at once
       would make the two incomparable. */
    60   AS entry_window_s,
    3600 AS exit_at_s,
    60   AS exit_window_s,
    /* EXIT WINDOW SENSITIVITY. A 60-second window with no trade in it does not
       prove a position was unexitable - it proves nothing traded in that
       particular minute, and H2 became undecidable on exactly this ambiguity. The
       wide window is 5 minutes from the same t+3600s horizon, so the HORIZON is
       unchanged and only the granularity moves. It is a sensitivity and never the
       primary: MT079 is decided on the 60-second window. */
    300  AS exit_wide_window_s,
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
    r.rank_by_median <= CEIL((SELECT top_fraction FROM params) * r.wallets_qualifying) AS top_by_median,
    -- MT080's sharper cuts, added for Phase C. The 0.10 flags above are untouched
    -- so that queries 1 to 4 keep returning exactly what H1 and H2 reported: a
    -- sharper cut is a new arm, not a retrospective edit of a test that has run.
    -- 0.001 is a strict subset of 0.01, which is a strict subset of 0.10, so a
    -- position can appear in more than one arm. The arms are reported separately
    -- and are never summed.
    r.rank_by_mean   <= CEIL((SELECT frac_tight FROM params) * r.wallets_qualifying) AS top_mean_001,
    r.rank_by_median <= CEIL((SELECT frac_tight FROM params) * r.wallets_qualifying) AS top_median_001,
    r.rank_by_mean   <= CEIL((SELECT frac_mid FROM params) * r.wallets_qualifying)   AS top_mean_01,
    r.rank_by_median <= CEIL((SELECT frac_mid FROM params) * r.wallets_qualifying)   AS top_median_01
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

-- ############################################################################
-- QUERY 5 — PHASE C, THE COPIER'S PRICE AS A FUNCTION OF LAG
--
-- H1 measured the WALLET's realised return, which is SELECTION (they chose a
-- mint that appreciated - transferable) plus EXECUTION (their fill, their sizing,
-- their exit - not transferable). A copier inherits the first and forfeits the
-- second, so H1 is an UPPER BOUND on a copy strategy and says nothing about its
-- value. This query measures the copier's own return directly, at six lags, on
-- the same wallet buys H1 already validated, and pairs it position by position
-- with the wallet's own return so the ratio is computable.
--
-- The ratio is the estimand. The level is secondary.
--
-- FOUR THINGS IT DELIBERATELY DOES NOT DO
--
--   1. It does not apply the cost floor here. The floor is applied offline, in
--      scripts/phase-c-lag-sweep.ts, because MT079 requires it on the COPIER side
--      only (that trade is ours) and never on the wallet side (the AMM fee and
--      the impact are already inside the on-chain amounts, per MT075), and
--      because the tier-sensitivity of the floor should not cost a re-run.
--   2. It does not filter censored or unenterable positions. They are returned as
--      counts. That convention is what surfaced the unmarkability gradient in H1.
--   3. It does not pool the fit-mean and fit-median cohorts. They are different
--      populations - +39.09% at a 36.7% win rate against +2.43% at 53.6% - and a
--      36.7% win rate paying +39% is tail capture, which is mostly EXIT skill.
--      Pooling them averages two mechanisms into one uninterpretable number.
--   4. It does not compute an interval. Day-clustered intervals come from
--      clusterBootstrapAggregated offline, the same machinery H1 used.
--
-- WHY ONE PASS OVER THE TAPE AND THEN AN UNNEST, rather than six joins: the trade
-- join is the expensive half, the six entry windows are all inside [T+2s,
-- T+3660s), and computing twelve conditional aggregates in one pass costs one
-- scan instead of six. The UNNEST that follows turns the wide row into six long
-- rows for free.
-- ############################################################################

--#Q5 needs=BASE,RANK
,
lag_grid AS (
  -- MT079's frozen lag set. 2s is about as fast as a public-mempool copier could
  -- plausibly be; 300s is included to show the curve flat rather than to propose
  -- it as a strategy.
  SELECT * FROM (VALUES (2), (5), (15), (30), (60), (300)) AS t(lag_s)
),

/* THE WALLET'S OWN ENTRY PRICE, from the legs of its first buy.

   This is what makes the ratio a ratio of like things. The directive's
   wallet_return is the wallet's realised return over the WHOLE position - its own
   exit, whenever it took it, with a carry-forward mark if it never did - while
   copier_return is a fixed 60-minute round trip. Dividing one by the other
   compares two different holding periods and answers no clean question.

   With the wallet's entry price in hand, the same 60-minute exit can be applied to
   BOTH sides, and then the decomposition the directive asks for is exact:

     wallet_ret_60m  = exit / THEIR price  - 1     selection, at their fill
     copier_ret(L)   = exit / OUR price(L) - 1     selection, at our fill
     ratio           = copier_ret / wallet_ret_60m the share of the same
                                                   appreciation a copier keeps

   Both are reported. The specified ratio against the wallet's realised return is
   reported too, and labelled for what it is. */
first_buy_px AS (
  SELECT
    w.trader_id,
    w.mint,
    w.block_time                                          AS t0,
    SUM(w.sol_amount) / NULLIF(SUM(w.token_amount), 0)     AS wallet_entry_px,
    SUM(w.sol_amount)                                      AS first_buy_sol
  FROM windowed w
  WHERE w.side = 'BUY' AND w.window_tag = 'HOLD'
  GROUP BY 1, 2, 3
),

copy_entries AS (
  SELECT
    CAST(pp.first_buy AS DATE)      AS utc_day,
    pp.trader_id,
    pp.mint,
    pp.first_buy                    AS t0,
    pp.entry_project,
    pp.sol_in,
    pp.is_closed,
    -- The wallet's own return, net of OUR fixed cost only. MT075: subtracting the
    -- full 2.69% floor here would double count 2.63 of those points.
    pp.ret_carryfwd - pp.fixed_cost_fraction AS wallet_ret,
    pp.unmarkable,
    fbp.wallet_entry_px,
    fbp.first_buy_sol,
    -- TRUNCATION IS NOT DEATH. A buy in the last 61 minutes of the holdout window
    -- has no exit mark because the WINDOW ends, not because the token did, and
    -- counting it as a -100% censored position would manufacture a loss out of a
    -- boundary. Flagged, excluded from both treatments, and counted.
    date_add('second', (SELECT exit_at_s + exit_window_s FROM params), pp.first_buy)
      > (SELECT hold_end FROM params)        AS exit_truncated,
    f.top_mean_001,
    f.top_median_001,
    f.top_mean_01,
    f.top_median_01
  FROM position_pnl pp
  JOIN flagged f ON f.trader_id = pp.trader_id
  LEFT JOIN first_buy_px fbp
    ON fbp.trader_id = pp.trader_id AND fbp.mint = pp.mint AND fbp.t0 = pp.first_buy
  WHERE pp.window_tag = 'HOLD'
    AND NOT pp.external_inflow
    AND NOT pp.below_min_size
    -- 0.01 is the superset of 0.001, so this admits every arm in one pass.
    AND (f.top_mean_01 OR f.top_median_01)
),

/* ONE PASS OVER THE TAPE.

   Every price here is a VWAP of OTHER traders' fills in a 60-second window - the
   copier's own order is not in it, and could not be. That is the honest reading
   of a public tape and it is also the limit of what this measures: our own impact
   beyond what the 2.69% floor already contains is not in these numbers, and it is
   worst exactly where a copier operates. Stated in MT079 before the run.

   The entry window starts at T+L, so it never overlaps the wallet's own buy at T.
   Other copiers' fills ARE in it, which is the crowding that already exists in
   the tape and should be there. */
copy_px AS (
  SELECT
    e.utc_day, e.trader_id, e.mint, e.t0, e.entry_project, e.sol_in, e.is_closed,
    e.wallet_ret, e.unmarkable, e.exit_truncated, e.wallet_entry_px, e.first_buy_sol,
    e.top_mean_001, e.top_median_001, e.top_mean_01, e.top_median_01,
    ARRAY[
      SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t0)
                AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t0)
                           AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t0)
                AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t0)
                           AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t0)
                AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t0)
                           AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t0)
                AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t0)
                           AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t0)
                AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t0)
                           AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t0)
                AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t0)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t0)
                           AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t0)
                          THEN w.token_amount ELSE 0 END), 0)
    ]                                                             AS entry_px_by_lag,
    SUM(CASE WHEN w.block_time >= date_add('second', (SELECT exit_at_s FROM params), e.t0)
              AND w.block_time <  date_add('second', (SELECT exit_at_s + exit_window_s FROM params), e.t0)
             THEN w.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', (SELECT exit_at_s FROM params), e.t0)
                         AND w.block_time <  date_add('second', (SELECT exit_at_s + exit_window_s FROM params), e.t0)
                        THEN w.token_amount ELSE 0 END), 0)        AS exit_px,
    -- SENSITIVITY, never the primary: same horizon, 5-minute window.
    SUM(CASE WHEN w.block_time >= date_add('second', (SELECT exit_at_s FROM params), e.t0)
              AND w.block_time <  date_add('second', (SELECT exit_at_s + exit_wide_window_s FROM params), e.t0)
             THEN w.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', (SELECT exit_at_s FROM params), e.t0)
                         AND w.block_time <  date_add('second', (SELECT exit_at_s + exit_wide_window_s FROM params), e.t0)
                        THEN w.token_amount ELSE 0 END), 0)        AS exit_px_wide,
    COUNT(*)                                                      AS tape_legs
  FROM copy_entries e
  JOIN windowed w
    ON w.mint = e.mint
   AND w.block_time >= date_add('second', 2, e.t0)
   AND w.block_time <  date_add('second', (SELECT exit_at_s + exit_wide_window_s FROM params), e.t0)
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
),

-- Wide to long: six rows per position, one per lag, at the cost of no extra scan.
copy_long AS (
  SELECT
    c.utc_day, c.trader_id, c.mint, c.entry_project, c.sol_in, c.is_closed,
    c.wallet_ret, c.unmarkable, c.exit_truncated, c.exit_px, c.exit_px_wide,
    c.wallet_entry_px, c.first_buy_sol, c.tape_legs,
    c.top_mean_001, c.top_median_001, c.top_mean_01, c.top_median_01,
    u.lag_s,
    u.entry_px
  FROM copy_px c
  CROSS JOIN UNNEST(ARRAY[2, 5, 15, 30, 60, 300], c.entry_px_by_lag) AS u(lag_s, entry_px)
),

-- The four arms, reported separately and never summed. A position in the 0.001
-- arm is also in the 0.01 arm by construction.
arms AS (
  SELECT * FROM (VALUES
    ('MEAN',   0.001),
    ('MEDIAN', 0.001),
    ('MEAN',   0.01),
    ('MEDIAN', 0.01)
  ) AS t(rank_stat, top_fraction)
)

SELECT
  c.utc_day,
  a.rank_stat,
  a.top_fraction,
  c.entry_project,
  c.lag_s,
  -- COVERAGE. n_no_entry_px is not a loss and not a censoring: it is a position
  -- the copier could not have entered at all, because nobody traded the mint in
  -- its 60-second entry window. A strategy that can only enter a fraction of the
  -- buys it follows has that fraction as a hard ceiling on its deployment, and
  -- burying it inside a mean would hide the single most operationally relevant
  -- number in this table.
  COUNT(*)                                                        AS n_all,
  COUNT_IF(c.entry_px IS NULL OR c.entry_px <= 0)                 AS n_no_entry_px,
  COUNT_IF(c.exit_truncated)                                      AS n_exit_truncated,
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NULL) AS n_censored,
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL) AS n,
  -- The copier's GROSS return. The floor is subtracted offline, per MT079.
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
           THEN c.exit_px / c.entry_px - 1e0 ELSE 0e0 END)        AS sum_copier_ret,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
           THEN POWER(c.exit_px / c.entry_px - 1e0, 2) ELSE 0e0 END) AS sum_copier_ret_sq,
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px > c.entry_px)   AS n_positive_copier,
  APPROX_PERCENTILE(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                         THEN c.exit_px / c.entry_px - 1e0 END, 0.5) AS median_copier_ret,
  -- THE WALLET SIDE, ON EXACTLY THE SAME POSITIONS. A ratio whose numerator and
  -- denominator are computed over different sets is not a ratio of anything.
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
           AND c.wallet_ret IS NOT NULL)                          AS n_paired,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_ret IS NOT NULL THEN c.wallet_ret ELSE 0e0 END) AS sum_wallet_ret_paired,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_ret IS NOT NULL THEN c.exit_px / c.entry_px - 1e0 ELSE 0e0 END)
                                                                  AS sum_copier_ret_paired,
  -- HORIZON-MATCHED PAIR. Same positions, same t+3600s exit, the only difference
  -- being whose entry price is in the denominator: theirs, or ours at lag L. This
  -- is the decomposition the phase exists to produce, and it is the only form of
  -- the ratio in which numerator and denominator answer the same question.
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
           AND c.wallet_entry_px > 0)                             AS n_matched,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_entry_px > 0 THEN c.exit_px / c.wallet_entry_px - 1e0 ELSE 0e0 END)
                                                                  AS sum_wallet_ret_60m,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_entry_px > 0 THEN POWER(c.exit_px / c.wallet_entry_px - 1e0, 2) ELSE 0e0 END)
                                                                  AS sum_wallet_ret_60m_sq,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_entry_px > 0 THEN c.exit_px / c.entry_px - 1e0 ELSE 0e0 END)
                                                                  AS sum_copier_ret_matched,
  -- The slippage a copier eats on entry alone: our VWAP against their fill.
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
                AND c.wallet_entry_px > 0 THEN c.entry_px / c.wallet_entry_px - 1e0 ELSE 0e0 END)
                                                                  AS sum_entry_slippage,
  -- WIDE EXIT WINDOW, the censoring sensitivity. Same horizon, 5 minutes instead
  -- of 60 seconds. If most of the censoring is window granularity rather than
  -- illiquidity, n_wide is much larger than n and the two treatments converge.
  COUNT_IF(NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px_wide IS NOT NULL) AS n_wide,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px_wide IS NOT NULL
           THEN c.exit_px_wide / c.entry_px - 1e0 ELSE 0e0 END)   AS sum_copier_ret_wide,
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px_wide IS NOT NULL
           THEN POWER(c.exit_px_wide / c.entry_px - 1e0, 2) ELSE 0e0 END) AS sum_copier_ret_wide_sq,
  -- Size and liquidity, for the record: a copier's feasible notional is bounded
  -- by what actually traded in its entry window.
  SUM(CASE WHEN NOT c.exit_truncated AND c.entry_px > 0 AND c.exit_px IS NOT NULL
           THEN c.sol_in ELSE 0e0 END)                            AS sum_wallet_sol_in,
  APPROX_PERCENTILE(CASE WHEN c.entry_px > 0 AND c.wallet_entry_px > 0
                         THEN c.entry_px / c.wallet_entry_px - 1e0 END, 0.5) AS median_entry_slippage,
  APPROX_PERCENTILE(c.tape_legs, 0.5)                             AS median_tape_legs,
  COUNT(DISTINCT c.trader_id)                                     AS wallets_in_cell
FROM copy_long c
CROSS JOIN arms a
WHERE (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.001 AND c.top_mean_001)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.001 AND c.top_median_001)
   OR (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.01  AND c.top_mean_01)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.01  AND c.top_median_01)
GROUP BY 1, 2, 3, 4, 5
ORDER BY 2, 3, 4, 5, 1;

--#END

-- ############################################################################
-- QUERY 6 — PHASE C §4, ROTATION OR DEATH
--
-- Deciles 1-2 of the H1 ranking vanish at 36.7-46.6% against 8.6-13% at deciles
-- 7-9, and `stopped`, `rotated to a fresh address` and `blew up` are one column.
-- H1 passed, so ADDRESS persistence is established; this asks whether the thing
-- that persists is an address or an operator.
--
-- It cuts two ways and both matter:
--   - if much of the vanishing is rotation, H1's estimate is conditioned on a
--     non-random survivor set;
--   - and separately, any live copy list decays to nothing within weeks, which
--     governs everything downstream of a positive Phase C result.
--
-- THE TEST. For every vanished top-cohort wallet, follow its outbound native-SOL
-- transfers and ask whether the recipient then traded pump tokens:
--
--   funds moved to an address that subsequently traded   -> ROTATION
--   funds dispersed, or the recipient never traded       -> STOPPED_OR_BLEW_UP
--
-- WHAT IT CANNOT SEE, stated before the numbers: a rotation funded from a third
-- address rather than from the vanished one, a rotation through a CEX or a mixer,
-- an operator running many addresses concurrently rather than sequentially, and a
-- transfer whose recipient trades on a venue outside `project IN (pumpdotfun,
-- pumpswap)`. Every one of those makes this an UNDERCOUNT of rotation, so the
-- rotation share here is a floor and the STOPPED_OR_BLEW_UP share is a ceiling.
-- ############################################################################

--#Q6 needs=BASE,RANK
,
-- The vanished: flagged in the fit window, zero qualifying holdout positions.
vanished AS (
  SELECT
    ha.trader_id,
    ha.fit_decile,
    ha.top_by_mean,
    ha.top_by_median,
    ha.mean_ret_fit,
    ha.median_ret_fit
  FROM holdout_activity ha
  WHERE ha.n_hold = 0
),

/* Outbound native SOL. `amount_display` is SOL, not lamports.

   The 0.05 SOL floor is about SIGNAL, not size: a wallet closing token accounts
   and paying fees emits a long tail of dust transfers, and a rotation moves a
   working balance. It is declared here rather than tuned, and the count below the
   floor is returned so the choice is visible. */
outflows AS (
  SELECT
    t.from_owner                  AS trader_id,
    t.to_owner                    AS successor,
    SUM(t.amount_display)         AS sol_moved,
    MIN(t.block_time)             AS first_move,
    COUNT(*)                      AS n_transfers
  FROM tokens_solana.sol_transfers t
  JOIN vanished v ON v.trader_id = t.from_owner
  CROSS JOIN params p
  WHERE t.block_date >= DATE '2026-07-08'
    AND t.block_date <= p.hold_end_date
    AND t.block_time <  p.hold_end
    AND t.to_owner <> t.from_owner
    AND t.amount_display >= 0.05
  GROUP BY 1, 2
),

-- Dust, counted rather than assumed negligible.
outflow_dust AS (
  SELECT t.from_owner AS trader_id, COUNT(*) AS n_dust_transfers
  FROM tokens_solana.sol_transfers t
  JOIN vanished v ON v.trader_id = t.from_owner
  CROSS JOIN params p
  WHERE t.block_date >= DATE '2026-07-08'
    AND t.block_date <= p.hold_end_date
    AND t.block_time <  p.hold_end
    AND t.to_owner <> t.from_owner
    AND t.amount_display < 0.05
  GROUP BY 1
),

/* Did the recipient trade AFTER receiving?

   `block_time > first_move` is what makes this a succession test rather than a
   correlation: an address that was already trading before the transfer is not a
   fresh identity, and it is counted separately as ACTIVE_RECIPIENT. */
successors AS (
  SELECT
    o.trader_id,
    o.successor,
    o.sol_moved,
    o.first_move,
    MIN(CASE WHEN w.block_time > o.first_move THEN w.block_time END)  AS first_trade_after,
    MIN(w.block_time)                                                AS first_trade_ever,
    COUNT(CASE WHEN w.block_time > o.first_move THEN 1 END)           AS legs_after
  FROM outflows o
  LEFT JOIN windowed w ON w.trader_id = o.successor
  GROUP BY 1, 2, 3, 4
),

classified AS (
  SELECT
    v.trader_id,
    v.fit_decile,
    v.top_by_mean,
    v.top_by_median,
    COALESCE(SUM(s.sol_moved), 0)                                    AS sol_out_total,
    COUNT(s.successor)                                               AS n_recipients,
    COUNT(CASE WHEN s.legs_after > 0 THEN 1 END)                     AS n_trading_recipients,
    COUNT(CASE WHEN s.legs_after > 0 AND s.first_trade_ever > s.first_move THEN 1 END)
                                                                     AS n_fresh_recipients,
    MAX(CASE WHEN s.legs_after > 0 THEN s.sol_moved END)              AS largest_trading_transfer,
    COALESCE(MAX(d.n_dust_transfers), 0)                             AS n_dust_transfers
  FROM vanished v
  LEFT JOIN successors s   ON s.trader_id = v.trader_id
  LEFT JOIN outflow_dust d ON d.trader_id = v.trader_id
  GROUP BY 1, 2, 3, 4
)

SELECT
  CASE WHEN top_by_mean AND top_by_median THEN 'TOP_BOTH'
       WHEN top_by_mean                   THEN 'TOP_MEAN_ONLY'
       WHEN top_by_median                 THEN 'TOP_MEDIAN_ONLY'
       ELSE 'REST_NEITHER' END                                       AS cohort,
  fit_decile,
  COUNT(*)                                                           AS vanished_wallets,
  -- The classification. FRESH is the strong form: the recipient had never traded
  -- before the transfer, so it is a new identity rather than an existing one.
  COUNT_IF(n_fresh_recipients > 0)                                   AS rotation_fresh,
  COUNT_IF(n_trading_recipients > 0 AND n_fresh_recipients = 0)      AS rotation_to_active,
  COUNT_IF(n_recipients > 0 AND n_trading_recipients = 0)            AS moved_to_non_trader,
  COUNT_IF(n_recipients = 0)                                         AS no_outflow_at_all,
  -- Size, because a 0.06 SOL transfer to a fresh address that trades once is not
  -- the same evidence as 40 SOL to an address that then trades hundreds of times.
  APPROX_PERCENTILE(sol_out_total, 0.5)                              AS median_sol_out,
  APPROX_PERCENTILE(CASE WHEN n_fresh_recipients > 0 THEN largest_trading_transfer END, 0.5)
                                                                     AS median_rotation_size,
  SUM(n_recipients)                                                  AS total_recipients,
  SUM(n_dust_transfers)                                              AS total_dust_transfers
FROM classified
GROUP BY 1, 2
ORDER BY 1, 2;

--#END

-- ############################################################################
-- QUERY 7 — PHASE D, THE PAIRED ROUND-TRIP COPY
--
-- Phase C asked what a copier earns if it buys L seconds behind the wallet and
-- sells at a fixed t+3600s. 46% of followable positions had no price in that exit
-- window, because it demanded a trade at an arbitrary wall-clock instant on mints
-- nobody was trading, and the two defensible treatments of that gap disagreed in
-- sign.
--
-- This anchors BOTH legs on trades the wallet itself executed:
--
--   copier_entry_px(L) = VWAP on M in [T_buy  + L, T_buy  + L + 60s)
--   copier_exit_px(L)  = VWAP on M in [T_sell + L, T_sell + L + 60s)
--
-- Coverage becomes a property of the construction rather than of someone else's
-- activity, and the ratio becomes two round trips over the same legs differing
-- only in price. Phase C's -7.5 divided a 60-minute return by a whole-position
-- one; this one is interpretable.
--
-- T_SELL IS THE WALLET'S FIRST SELL, NOT ITS LAST. A copier reacts to the first
-- sell it can observe; using the last would credit it with scaling out on
-- information it does not have at the decision point. The wallet's own realised
-- return - which DOES include every later sell and the residual mark - is
-- reported beside its first-sell-only return, so the value of the scaling-out the
-- copier forgoes is visible rather than assumed away.
--
-- THREE COUNTED CATEGORIES, NEVER A WHERE CLAUSE (directive 1.3): positions the
-- wallet never closed have no T_sell, and a copier following it would also still
-- be holding, so they are genuinely OPEN rather than missing. They are counted,
-- and the estimate is reported both excluding them and entering them at -100%.
--
-- THE SIZING ARM (MT084). Reserves are not in dex_solana.trades, so the depth gate
-- is applied to the wallet's OWN MEASURED IMPACT: its fill price against the VWAP
-- of the 60 seconds before its buy. For a constant-product pool a trade of size x
-- against reserve X moves the price by about 2x/X, so X in {1%, 3%, 10%} maps to
-- impact thresholds of {2%, 6%, 20%}. Positions with no prior trade in that minute
-- have no measurable impact and are counted as not-evaluable rather than silently
-- kept or dropped. The proxy over-declines rather than under-declines, which is the
-- safe direction for a cost claim and the unsafe one for a selection claim, so the
-- decline rate is reported at every threshold.
--
-- TWO SCANS, NOT SEVEN. The six entry windows all lie inside [T_buy - 60s, T_buy +
-- 360s) and the six exit windows inside [T_sell, T_sell + 360s), so each side is
-- one pass with conditional aggregates and the wide row is unnested to six long
-- rows for free. The pre-trade window for the impact proxy rides along in the
-- entry scan.
-- ############################################################################

--#Q7 needs=BASE,RANK
,
/* The wallet's OWN fill prices, per leg-timestamp.

   Grouped by block_time because a wallet can have several legs in one instant
   across transactions, and their volume-weighted average IS the price it got. */
own_buy_px AS (
  SELECT
    w.trader_id,
    w.mint,
    w.block_time                                        AS t_buy,
    SUM(w.sol_amount) / NULLIF(SUM(w.token_amount), 0)  AS wallet_buy_px
  FROM windowed w
  WHERE w.side = 'BUY' AND w.window_tag = 'HOLD'
  GROUP BY 1, 2, 3
),

own_first_sell AS (
  SELECT w.trader_id, w.mint, MIN(w.block_time) AS t_sell
  FROM windowed w
  WHERE w.side = 'SELL' AND w.window_tag = 'HOLD'
  GROUP BY 1, 2
),

own_sell_px AS (
  SELECT
    w.trader_id,
    w.mint,
    w.block_time                                        AS t_sell,
    SUM(w.sol_amount) / NULLIF(SUM(w.token_amount), 0)  AS wallet_sell_px
  FROM windowed w
  WHERE w.side = 'SELL' AND w.window_tag = 'HOLD'
  GROUP BY 1, 2, 3
),

rt_base AS (
  SELECT
    CAST(pp.first_buy AS DATE)                AS utc_day,
    pp.trader_id,
    pp.mint,
    pp.entry_project,
    pp.first_buy                              AS t_buy,
    fs.t_sell,
    pp.sol_in,
    pp.is_closed,
    bp.wallet_buy_px,
    sp.wallet_sell_px,
    -- The wallet's own return over the SAME TWO LEGS the copier trades, so the
    -- ratio isolates price and nothing else.
    sp.wallet_sell_px / NULLIF(bp.wallet_buy_px, 0) - 1e0     AS wallet_ret_legs,
    -- Its full realised return: every sell, plus the residual at the window-edge
    -- mark. MT075 - only OUR fixed cost is subtracted, never the full floor.
    pp.ret_carryfwd - pp.fixed_cost_fraction                  AS wallet_ret_realised,
    f.top_mean_001,
    f.top_median_001,
    f.top_mean_01,
    f.top_median_01
  FROM position_pnl pp
  JOIN flagged f       ON f.trader_id = pp.trader_id
  LEFT JOIN own_buy_px bp
    ON bp.trader_id = pp.trader_id AND bp.mint = pp.mint AND bp.t_buy = pp.first_buy
  LEFT JOIN own_first_sell fs
    ON fs.trader_id = pp.trader_id AND fs.mint = pp.mint
  LEFT JOIN own_sell_px sp
    ON sp.trader_id = pp.trader_id AND sp.mint = pp.mint AND sp.t_sell = fs.t_sell
  WHERE pp.window_tag = 'HOLD'
    AND NOT pp.external_inflow
    AND NOT pp.below_min_size
    -- 0.01 is the superset of 0.001, so one pass serves both arms.
    AND (f.top_mean_01 OR f.top_median_01)
),

-- SCAN 1: the entry side, plus the pre-trade price the impact proxy needs.
entry_side AS (
  SELECT
    e.trader_id,
    e.mint,
    e.t_buy,
    ARRAY[
      SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t_buy)
                AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t_buy)
                           AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t_buy)
                AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t_buy)
                           AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t_buy)
                AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t_buy)
                           AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t_buy)
                AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t_buy)
                           AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t_buy)
                AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t_buy)
                           AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t_buy)
                AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t_buy)
                           AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_buy)
                          THEN w.token_amount ELSE 0 END), 0)
    ]                                                                     AS entry_px_by_lag,
    -- The 60 seconds BEFORE the wallet's buy: the price it moved away from.
    SUM(CASE WHEN w.block_time >= date_add('second', -(SELECT entry_window_s FROM params), e.t_buy)
              AND w.block_time <  e.t_buy
             THEN w.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', -(SELECT entry_window_s FROM params), e.t_buy)
                         AND w.block_time <  e.t_buy
                        THEN w.token_amount ELSE 0 END), 0)                AS pre_px
  FROM rt_base e
  JOIN windowed w
    ON w.mint = e.mint
   AND w.block_time >= date_add('second', -(SELECT entry_window_s FROM params), e.t_buy)
   AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_buy)
  GROUP BY 1, 2, 3
),

-- SCAN 2: the exit side, anchored on the wallet's first sell.
exit_side AS (
  SELECT
    e.trader_id,
    e.mint,
    e.t_sell,
    ARRAY[
      SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t_sell)
                AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 2, e.t_sell)
                           AND w.block_time <  date_add('second', 2 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t_sell)
                AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 5, e.t_sell)
                           AND w.block_time <  date_add('second', 5 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t_sell)
                AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 15, e.t_sell)
                           AND w.block_time <  date_add('second', 15 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t_sell)
                AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 30, e.t_sell)
                           AND w.block_time <  date_add('second', 30 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t_sell)
                AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 60, e.t_sell)
                           AND w.block_time <  date_add('second', 60 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t_sell)
                AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 300, e.t_sell)
                           AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_sell)
                          THEN w.token_amount ELSE 0 END), 0)
    ]                                                                     AS exit_px_by_lag
  FROM rt_base e
  JOIN windowed w
    ON w.mint = e.mint
   AND w.block_time >= e.t_sell
   AND w.block_time <  date_add('second', 300 + (SELECT entry_window_s FROM params), e.t_sell)
  WHERE e.t_sell IS NOT NULL
  GROUP BY 1, 2, 3
),

joined AS (
  SELECT
    b.*,
    en.entry_px_by_lag,
    en.pre_px,
    -- COALESCE, because an open position has no exit array and UNNEST of a NULL
    -- array yields NO ROWS: without this the third counted category would silently
    -- vanish, which is exactly the failure this phase exists to avoid.
    COALESCE(ex.exit_px_by_lag, ARRAY[
      CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE),
      CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)
    ]) AS exit_px_by_lag
  FROM rt_base b
  LEFT JOIN entry_side en ON en.trader_id = b.trader_id AND en.mint = b.mint AND en.t_buy = b.t_buy
  LEFT JOIN exit_side  ex ON ex.trader_id = b.trader_id AND ex.mint = b.mint AND ex.t_sell = b.t_sell
),

rt_long AS (
  SELECT
    j.utc_day, j.trader_id, j.mint, j.entry_project, j.t_sell, j.sol_in, j.is_closed,
    j.wallet_buy_px, j.wallet_sell_px, j.wallet_ret_legs, j.wallet_ret_realised, j.pre_px,
    j.top_mean_001, j.top_median_001, j.top_mean_01, j.top_median_01,
    u.lag_s,
    u.entry_px,
    u.exit_px,
    -- The impact proxy, MT084. NULL when there was no trade in the prior minute.
    j.wallet_buy_px / NULLIF(j.pre_px, 0) - 1e0                          AS own_impact
  FROM joined j
  CROSS JOIN UNNEST(ARRAY[2, 5, 15, 30, 60, 300], j.entry_px_by_lag, j.exit_px_by_lag)
    AS u(lag_s, entry_px, exit_px)
),

arms AS (
  SELECT * FROM (VALUES
    ('MEAN',   0.001),
    ('MEDIAN', 0.001),
    ('MEAN',   0.01),
    ('MEDIAN', 0.01)
  ) AS t(rank_stat, top_fraction)
)

SELECT
  c.utc_day,
  a.rank_stat,
  a.top_fraction,
  c.entry_project,
  c.lag_s,
  -- ===== COVERAGE, reported before any return (directive 1.2) =====
  COUNT(*)                                                              AS n_followable,
  COUNT_IF(c.t_sell IS NULL)                                            AS n_open,
  COUNT_IF(c.t_sell IS NOT NULL)                                        AS n_with_sell,
  COUNT_IF(c.entry_px > 0)                                              AS n_entry_priced,
  COUNT_IF(c.t_sell IS NOT NULL AND c.exit_px > 0)                      AS n_exit_priced,
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0)                            AS n_both,
  COUNT_IF(c.entry_px > 0 AND c.t_sell IS NULL)                         AS n_open_entry_priced,
  COUNT_IF(c.pre_px IS NULL OR c.pre_px <= 0)                           AS n_gate_not_evaluable,
  -- ===== CLOSED-ONLY: the estimation set =====
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0, c.exit_px / c.entry_px - 1e0, 0e0))            AS sum_ret,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0, POWER(c.exit_px / c.entry_px - 1e0, 2), 0e0))  AS sum_ret_sq,
  COUNT_IF(c.entry_px > 0 AND c.exit_px > c.entry_px)                                     AS n_positive,
  APPROX_PERCENTILE(IF(c.entry_px > 0 AND c.exit_px > 0, c.exit_px / c.entry_px - 1e0, NULL), 0.5)
                                                                                          AS median_ret,
  -- ===== THE WALLET, ON EXACTLY THE SAME POSITIONS =====
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_legs IS NOT NULL)            AS n_legs_paired,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_legs IS NOT NULL, c.wallet_ret_legs, 0e0))
                                                                                          AS sum_wallet_legs,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_legs IS NOT NULL, c.exit_px / c.entry_px - 1e0, 0e0))
                                                                                          AS sum_ret_on_legs,
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_realised IS NOT NULL)        AS n_realised_paired,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_realised IS NOT NULL, c.wallet_ret_realised, 0e0))
                                                                                          AS sum_wallet_realised,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_ret_realised IS NOT NULL, c.exit_px / c.entry_px - 1e0, 0e0))
                                                                                          AS sum_ret_on_realised,
  -- ===== SLIPPAGE ON EACH LEG SEPARATELY =====
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_buy_px > 0, c.entry_px / c.wallet_buy_px - 1e0, 0e0))
                                                                                          AS sum_entry_slip,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.wallet_sell_px > 0, c.exit_px / c.wallet_sell_px - 1e0, 0e0))
                                                                                          AS sum_exit_slip,
  APPROX_PERCENTILE(IF(c.entry_px > 0 AND c.wallet_buy_px > 0, c.entry_px / c.wallet_buy_px - 1e0, NULL), 0.5)
                                                                                          AS median_entry_slip,
  APPROX_PERCENTILE(IF(c.exit_px > 0 AND c.wallet_sell_px > 0, c.exit_px / c.wallet_sell_px - 1e0, NULL), 0.5)
                                                                                          AS median_exit_slip,
  -- ===== THE SIZING ARM, MT084: kept when own impact <= 2x/X =====
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.02) AS n_g1,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.02,
         c.exit_px / c.entry_px - 1e0, 0e0))                                              AS sum_g1,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.02,
         POWER(c.exit_px / c.entry_px - 1e0, 2), 0e0))                                    AS sum_g1_sq,
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.06) AS n_g3,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.06,
         c.exit_px / c.entry_px - 1e0, 0e0))                                              AS sum_g3,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.06,
         POWER(c.exit_px / c.entry_px - 1e0, 2), 0e0))                                    AS sum_g3_sq,
  COUNT_IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.20) AS n_g10,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.20,
         c.exit_px / c.entry_px - 1e0, 0e0))                                              AS sum_g10,
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0 AND c.own_impact IS NOT NULL AND c.own_impact <= 0.20,
         POWER(c.exit_px / c.entry_px - 1e0, 2), 0e0))                                    AS sum_g10_sq,
  APPROX_PERCENTILE(c.own_impact, 0.5)                                                    AS median_own_impact,
  -- ===== SIZE AND POPULATION =====
  SUM(IF(c.entry_px > 0 AND c.exit_px > 0, c.sol_in, 0e0))                                AS sum_sol_in,
  COUNT(DISTINCT c.trader_id)                                                             AS wallets_in_cell
FROM rt_long c
CROSS JOIN arms a
WHERE (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.001 AND c.top_mean_001)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.001 AND c.top_median_001)
   OR (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.01  AND c.top_mean_01)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.01  AND c.top_median_01)
GROUP BY 1, 2, 3, 4, 5
ORDER BY 2, 3, 4, 5, 1;

--#END

-- ############################################################################
-- QUERY 8 — PHASE E, MIRROR THE FRACTION, NOT THE EVENT
--
-- Phase D found the dominant loss is not slippage. A copier that treats the first
-- observed sell as a full exit forfeits 3 to 6 times its own return before paying a
-- basis point, because the wallet keeps selling after it. This mirrors the SHAPE of
-- the exit instead:
--
--   fraction_k  = tokens_sold_k / tokens_held_before_k        (wallet's own legs)
--   the copier sells fraction_k of ITS OWN remaining at T_k + L
--
-- NO LOOKAHEAD, AND IT IS ASSERTED ELSEWHERE. fraction_k is a function of the tape
-- up to T_k - cumulative buys minus cumulative sells - so a live copier could
-- compute it. The arithmetic is duplicated in
-- packages/research/src/proportional-exit.ts precisely so the property can be tested
-- against every prefix of a leg sequence, which a SQL window function cannot be
-- interrogated about. The two implementations agree except for one deliberate
-- difference: the fraction is clamped at 1 - 1e-9 here so that LN(1 - fraction) is
-- finite, where the module clamps at 1 exactly. A full exit therefore leaves 1e-9
-- of the position behind in this query and none in the module.
--
-- THE CONTROL IS PHASE D, ON THE SAME POSITIONS. `bin_*` below is the binary
-- first-sell exit computed over the identical set at the identical lags, so the
-- proportional-minus-binary difference in MT087 condition 5 is paired rather than
-- two separate studies compared by eye.
--
-- WHAT MULTI-LEG EXIT ACTUALLY COSTS. The venue fee and the price impact are
-- proportional to leg value, so splitting one exit into K legs does not multiply
-- them. What it multiplies is the per-transaction base-plus-priority fee. That is
-- charged as (priced legs - 1) x half the fixed cost, per position, and it is the
-- only extra cost of extra legs this data supports.
--
-- THREE LAGS, ONE VENUE, 60-SECOND WINDOWS. Phase C established the decay knee is
-- in minutes and Phase B established the curve is not enterable, so the grid is cut
-- deliberately rather than for cost - though it is also much cheaper than Phase D's
-- 360-second windows.
-- ############################################################################

--#Q8 needs=BASE,RANK
,
e_pos AS (
  SELECT
    CAST(pp.first_buy AS DATE)                                AS utc_day,
    pp.trader_id,
    pp.mint,
    pp.first_buy                                              AS t_buy,
    pp.sol_in,
    pp.is_closed,
    pp.ret_carryfwd - pp.fixed_cost_fraction                  AS wallet_ret_realised,
    -- The extra fixed cost of one additional sell leg, as a fraction of the entry
    -- notional: half a round trip's base-plus-priority fee over what was deployed.
    (SELECT fixed_cost_sol FROM params) / 2e0 / NULLIF(pp.sol_in, 0) AS extra_leg_cost,
    f.top_mean_001,
    f.top_median_001,
    f.top_mean_01,
    f.top_median_01
  FROM position_pnl pp
  JOIN flagged f ON f.trader_id = pp.trader_id
  WHERE pp.window_tag = 'HOLD'
    AND pp.entry_project = 'pumpswap'
    AND NOT pp.external_inflow
    AND NOT pp.below_min_size
    AND (f.top_mean_01 OR f.top_median_01)
),

-- One row per (position, instant, side): legs in the same instant across several
-- transactions are one decision at one volume-weighted price.
e_legs AS (
  SELECT
    w.trader_id,
    w.mint,
    w.block_time,
    w.side,
    SUM(w.token_amount) AS tok,
    SUM(w.sol_amount)   AS sol
  FROM windowed w
  JOIN e_pos p ON p.trader_id = w.trader_id AND p.mint = w.mint
  WHERE w.window_tag = 'HOLD'
  GROUP BY 1, 2, 3, 4
),

/* The wallet's holding BEFORE each leg.

   A buy and a sell in the same instant are ordered buy-first, so tokens bought in
   that instant are available to the sell that follows it. Without that tiebreak a
   same-instant pair would produce a fraction above 1 and be clamped, silently
   turning a partial exit into a full one. */
e_seq AS (
  SELECT
    l.*,
    SUM(CASE WHEN l.side = 'BUY' THEN l.tok ELSE -l.tok END) OVER (
      PARTITION BY l.trader_id, l.mint
      ORDER BY l.block_time, CASE WHEN l.side = 'BUY' THEN 0 ELSE 1 END
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS held_before
  FROM e_legs l
),

e_sells AS (
  SELECT
    s.trader_id,
    s.mint,
    s.block_time                                       AS t_sell,
    s.tok                                              AS tok_sold,
    s.sol / NULLIF(s.tok, 0)                           AS wallet_sell_px,
    s.held_before,
    LEAST(GREATEST(s.tok / NULLIF(s.held_before, 0), 0e0), 1e0 - 1e-9) AS fraction
  FROM e_seq s
  WHERE s.side = 'SELL'
    AND s.held_before > 0
),

/* The copier's remaining before each leg: the running product of (1 - fraction).

   Trino has no PRODUCT window, so it is EXP of the running SUM of LN. The clamp
   above keeps the logarithm finite; without it a full exit would be LN(0). */
e_mirror AS (
  SELECT
    s.*,
    EXP(COALESCE(SUM(LN(1e0 - s.fraction)) OVER (
      PARTITION BY s.trader_id, s.mint
      ORDER BY s.t_sell
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0e0))                                           AS remaining_before,
    ROW_NUMBER() OVER (PARTITION BY s.trader_id, s.mint ORDER BY s.t_sell) AS leg_index
  FROM e_sells s
),

-- The wallet's own fill price at the position's first buy, for the entry slippage
-- and for MT088's conviction measure.
e_buy_px AS (
  SELECT
    l.trader_id,
    l.mint,
    l.block_time                     AS t_buy,
    l.sol / NULLIF(l.tok, 0)         AS wallet_buy_px
  FROM e_legs l
  WHERE l.side = 'BUY'
),

-- SCAN 1: the entry side. Three lag windows all inside [t_buy - 60s, t_buy + 120s),
-- plus the pre-trade minute the conviction measure needs.
e_entry AS (
  SELECT
    p.trader_id,
    p.mint,
    p.t_buy,
    ARRAY[
      SUM(CASE WHEN w.block_time >= date_add('second', 2, p.t_buy)
                AND w.block_time <  date_add('second', 62, p.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 2, p.t_buy)
                           AND w.block_time <  date_add('second', 62, p.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 15, p.t_buy)
                AND w.block_time <  date_add('second', 75, p.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 15, p.t_buy)
                           AND w.block_time <  date_add('second', 75, p.t_buy)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 60, p.t_buy)
                AND w.block_time <  date_add('second', 120, p.t_buy)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 60, p.t_buy)
                           AND w.block_time <  date_add('second', 120, p.t_buy)
                          THEN w.token_amount ELSE 0 END), 0)
    ]                                                  AS entry_px_by_lag,
    SUM(CASE WHEN w.block_time >= date_add('second', -60, p.t_buy)
              AND w.block_time <  p.t_buy
             THEN w.sol_amount ELSE 0 END)
      / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', -60, p.t_buy)
                         AND w.block_time <  p.t_buy
                        THEN w.token_amount ELSE 0 END), 0) AS pre_px
  FROM e_pos p
  JOIN windowed w
    ON w.mint = p.mint
   AND w.block_time >= date_add('second', -60, p.t_buy)
   AND w.block_time <  date_add('second', 120, p.t_buy)
  GROUP BY 1, 2, 3
),

-- SCAN 2: the exit side, one 60-second window per lag per SELL LEG.
e_exit AS (
  SELECT
    m.trader_id,
    m.mint,
    m.t_sell,
    m.leg_index,
    m.fraction,
    m.remaining_before,
    m.wallet_sell_px,
    ARRAY[
      SUM(CASE WHEN w.block_time >= date_add('second', 2, m.t_sell)
                AND w.block_time <  date_add('second', 62, m.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 2, m.t_sell)
                           AND w.block_time <  date_add('second', 62, m.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 15, m.t_sell)
                AND w.block_time <  date_add('second', 75, m.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 15, m.t_sell)
                           AND w.block_time <  date_add('second', 75, m.t_sell)
                          THEN w.token_amount ELSE 0 END), 0),
      SUM(CASE WHEN w.block_time >= date_add('second', 60, m.t_sell)
                AND w.block_time <  date_add('second', 120, m.t_sell)
               THEN w.sol_amount ELSE 0 END)
        / NULLIF(SUM(CASE WHEN w.block_time >= date_add('second', 60, m.t_sell)
                           AND w.block_time <  date_add('second', 120, m.t_sell)
                          THEN w.token_amount ELSE 0 END), 0)
    ]                                                  AS exit_px_by_lag
  FROM e_mirror m
  JOIN windowed w
    ON w.mint = m.mint
   AND w.block_time >= date_add('second', 2, m.t_sell)
   AND w.block_time <  date_add('second', 120, m.t_sell)
  GROUP BY 1, 2, 3, 4, 5, 6, 7
),

leg_long AS (
  SELECT
    e.trader_id, e.mint, e.leg_index, e.fraction, e.remaining_before, e.wallet_sell_px,
    u.lag_s,
    u.exit_px,
    e.remaining_before * e.fraction                    AS weight
  FROM e_exit e
  CROSS JOIN UNNEST(ARRAY[2, 15, 60], e.exit_px_by_lag) AS u(lag_s, exit_px)
),

pos_wide AS (
  SELECT
    p.*,
    en.entry_px_by_lag,
    en.pre_px,
    bp.wallet_buy_px
  FROM e_pos p
  LEFT JOIN e_entry en ON en.trader_id = p.trader_id AND en.mint = p.mint AND en.t_buy = p.t_buy
  LEFT JOIN e_buy_px bp ON bp.trader_id = p.trader_id AND bp.mint = p.mint AND bp.t_buy = p.t_buy
),

pos_long AS (
  SELECT
    pw.utc_day, pw.trader_id, pw.mint, pw.sol_in, pw.is_closed, pw.wallet_ret_realised,
    pw.extra_leg_cost, pw.pre_px, pw.wallet_buy_px,
    pw.top_mean_001, pw.top_median_001, pw.top_mean_01, pw.top_median_01,
    u.lag_s,
    u.entry_px,
    pw.wallet_buy_px / NULLIF(pw.pre_px, 0) - 1e0       AS own_impact
  FROM pos_wide pw
  CROSS JOIN UNNEST(ARRAY[2, 15, 60],
    COALESCE(pw.entry_px_by_lag, ARRAY[CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)])
  ) AS u(lag_s, entry_px)
),

/* One row per (position, lag): the proportional round trip, the binary control on
   the same position, and the counts that say how much of each was mirrorable. */
pos_metrics AS (
  SELECT
    pl.utc_day, pl.trader_id, pl.mint, pl.lag_s, pl.sol_in, pl.is_closed,
    pl.wallet_ret_realised, pl.extra_leg_cost, pl.own_impact, pl.entry_px, pl.wallet_buy_px,
    pl.pre_px,
    pl.top_mean_001, pl.top_median_001, pl.top_mean_01, pl.top_median_01,
    COUNT(ll.leg_index)                                                    AS legs_total,
    COUNT(ll.leg_index) FILTER (WHERE ll.exit_px > 0)                      AS legs_priced,
    COALESCE(SUM(ll.weight) FILTER (WHERE ll.exit_px > 0), 0e0)            AS w_sold,
    COALESCE(SUM(ll.weight * ll.exit_px) FILTER (WHERE ll.exit_px > 0), 0e0) AS proceeds_tok,
    -- The binary control: the FIRST leg the copier could actually price.
    MIN_BY(ll.exit_px, ll.leg_index) FILTER (WHERE ll.exit_px > 0)         AS first_priced_px,
    -- The wallet's own first sell, for the recovered-fraction question.
    MIN_BY(ll.wallet_sell_px, ll.leg_index)                               AS wallet_first_sell_px,
    -- Weighted exit slippage: our VWAP against the wallet's fill on the same leg.
    COALESCE(SUM(ll.weight * (ll.exit_px / NULLIF(ll.wallet_sell_px, 0) - 1e0))
             FILTER (WHERE ll.exit_px > 0 AND ll.wallet_sell_px > 0), 0e0) AS exit_slip_weighted,
    COALESCE(SUM(ll.weight) FILTER (WHERE ll.exit_px > 0 AND ll.wallet_sell_px > 0), 0e0)
                                                                           AS exit_slip_weight_base
  FROM pos_long pl
  LEFT JOIN leg_long ll
    ON ll.trader_id = pl.trader_id AND ll.mint = pl.mint AND ll.lag_s = pl.lag_s
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
),

scored AS (
  SELECT
    m.*,
    (SELECT round_trip_floor FROM params)
      + GREATEST(m.legs_priced - 1, 0) * m.extra_leg_cost                  AS cost_charged,
    -- PROPORTIONAL, residual worthless: everything not liquidated is a total loss.
    m.proceeds_tok / NULLIF(m.entry_px, 0) - 1e0
      - (SELECT round_trip_floor FROM params)
      - GREATEST(m.legs_priced - 1, 0) * m.extra_leg_cost                  AS prop_dead,
    -- PROPORTIONAL, renormalised over the share that could be mirrored.
    CASE WHEN m.w_sold > 0 THEN
      m.proceeds_tok / NULLIF(m.entry_px * m.w_sold, 0) - 1e0
        - (SELECT round_trip_floor FROM params)
        - GREATEST(m.legs_priced - 1, 0) * m.extra_leg_cost
    END                                                                    AS prop_mirrored,
    -- BINARY control, same position, same lag. One leg, so no extra-leg cost.
    CASE WHEN m.first_priced_px > 0 THEN
      m.first_priced_px / NULLIF(m.entry_px, 0) - 1e0 - (SELECT round_trip_floor FROM params)
    END                                                                    AS bin_return,
    -- The wallet's own first-sell return, for the recovered-fraction question.
    m.wallet_first_sell_px / NULLIF(m.wallet_buy_px, 0) - 1e0              AS wallet_first_sell_ret,
    GREATEST(m.own_impact, 0e0)                                            AS conviction_weight
  FROM pos_metrics m
),

arms AS (
  SELECT * FROM (VALUES
    ('MEAN',   0.001),
    ('MEDIAN', 0.001),
    ('MEAN',   0.01),
    ('MEDIAN', 0.01)
  ) AS t(rank_stat, top_fraction)
)

SELECT
  s.utc_day,
  a.rank_stat,
  a.top_fraction,
  s.lag_s,
  -- ===== COVERAGE, before any return =====
  COUNT(*)                                                              AS n_followable,
  COUNT_IF(s.entry_px > 0)                                              AS n_entry_priced,
  COUNT_IF(s.is_closed)                                                 AS n_wallet_closed,
  COUNT_IF(s.entry_px > 0 AND s.legs_priced > 0)                        AS n_any_priced_leg,
  COUNT_IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0)             AS n_paired,
  SUM(s.legs_total)                                                     AS legs_total,
  SUM(s.legs_priced)                                                    AS legs_priced,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, s.w_sold, 0e0)) AS sum_w_sold_paired,
  COUNT_IF(s.pre_px IS NULL OR s.pre_px <= 0)                           AS n_conviction_not_evaluable,
  -- ===== PROPORTIONAL, closed-only (the paired set) =====
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, s.prop_mirrored, 0e0))                 AS sum_prop_closed,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, POWER(s.prop_mirrored, 2), 0e0))       AS sum_prop_closed_sq,
  COUNT_IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.prop_mirrored > 0)              AS n_prop_closed_positive,
  APPROX_PERCENTILE(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, s.prop_mirrored, NULL), 0.5)
                                                                                                 AS median_prop_closed,
  -- ===== BINARY control, IDENTICAL positions =====
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, COALESCE(s.bin_return, -1e0 - (SELECT round_trip_floor FROM params)), 0e0))
                                                                                                 AS sum_bin_closed,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, POWER(COALESCE(s.bin_return, -1e0 - (SELECT round_trip_floor FROM params)), 2), 0e0))
                                                                                                 AS sum_bin_closed_sq,
  -- ===== BOTH, residual worthless, over every entry-priced position =====
  COUNT_IF(s.entry_px > 0)                                                                       AS n_dead,
  SUM(IF(s.entry_px > 0, s.prop_dead, 0e0))                                                      AS sum_prop_dead,
  SUM(IF(s.entry_px > 0, POWER(s.prop_dead, 2), 0e0))                                            AS sum_prop_dead_sq,
  SUM(IF(s.entry_px > 0, COALESCE(s.bin_return, -1e0 - (SELECT round_trip_floor FROM params)), 0e0))
                                                                                                 AS sum_bin_dead,
  -- ===== THE WALLET, same positions =====
  COUNT_IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.wallet_ret_realised IS NOT NULL) AS n_wallet_realised,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.wallet_ret_realised IS NOT NULL, s.wallet_ret_realised, 0e0))
                                                                                                 AS sum_wallet_realised,
  COUNT_IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.wallet_first_sell_ret IS NOT NULL) AS n_wallet_first,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.wallet_first_sell_ret IS NOT NULL, s.wallet_first_sell_ret, 0e0))
                                                                                                 AS sum_wallet_first_sell,
  -- ===== SLIPPAGE PER LEG =====
  SUM(IF(s.entry_px > 0 AND s.wallet_buy_px > 0, s.entry_px / s.wallet_buy_px - 1e0, 0e0))        AS sum_entry_slip,
  COUNT_IF(s.entry_px > 0 AND s.wallet_buy_px > 0)                                               AS n_entry_slip,
  SUM(s.exit_slip_weighted)                                                                      AS sum_exit_slip_weighted,
  SUM(s.exit_slip_weight_base)                                                                   AS sum_exit_slip_base,
  APPROX_PERCENTILE(IF(s.entry_px > 0 AND s.wallet_buy_px > 0, s.entry_px / s.wallet_buy_px - 1e0, NULL), 0.5)
                                                                                                 AS median_entry_slip,
  -- ===== MT088, THE INVERTED SIZE ARM =====
  COUNT_IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.own_impact >= 0.06)              AS n_conv_gated,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.own_impact >= 0.06, s.prop_mirrored, 0e0))
                                                                                                 AS sum_conv_gated,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.own_impact >= 0.06, POWER(s.prop_mirrored, 2), 0e0))
                                                                                                 AS sum_conv_gated_sq,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.own_impact >= 0.06, COALESCE(s.bin_return, -1e0 - (SELECT round_trip_floor FROM params)), 0e0))
                                                                                                 AS sum_conv_gated_bin,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.conviction_weight > 0, s.conviction_weight, 0e0))
                                                                                                 AS sum_conviction_weight,
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0 AND s.conviction_weight > 0, s.conviction_weight * s.prop_mirrored, 0e0))
                                                                                                 AS sum_conviction_weighted_ret,
  APPROX_PERCENTILE(s.own_impact, 0.5)                                                           AS median_own_impact,
  -- ===== SIZE AND POPULATION =====
  SUM(IF(s.entry_px > 0 AND s.is_closed AND s.w_sold > 0, s.sol_in, 0e0))                        AS sum_sol_in,
  COUNT(DISTINCT s.trader_id)                                                                    AS wallets_in_cell
FROM scored s
CROSS JOIN arms a
WHERE (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.001 AND s.top_mean_001)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.001 AND s.top_median_001)
   OR (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.01  AND s.top_mean_01)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.01  AND s.top_median_01)
GROUP BY 1, 2, 3, 4
ORDER BY 2, 3, 4, 1;

--#END

-- ############################################################################
-- QUERY 10 — PHASE F §3, H1 AT ENTITY LEVEL
--
-- H1 has been an ADDRESS-level result since PR #58, and the entity-level re-run has
-- been deferred three times: Phase C ran out of its credit ceiling, Phase D never
-- reached it, Phase E was closed on condition 5 before it mattered. MT082 measured
-- rotation at 4.5-5.3% fresh-address and 12-16% loose, flat across deciles, and said
-- explicitly that the direction and size of any correction is UNKNOWN because a
-- successor's activity level was never measured.
--
-- This measures it. A vanished flagged wallet that sent SOL to an address which then
-- traded is stitched to that address as one entity, and the holdout positions of the
-- successor are attributed to the PREDECESSOR's cohort. Successors have no fit
-- history, so today their positions are in neither H1 cohort - they are invisible to
-- the estimate rather than pulling it in either direction.
--
-- THIS IS A CORRECTION, NOT A SECOND TEST OF H1. It re-uses H1's own window and its
-- own ranking, so it cannot confirm H1; it can only say how much the address-level
-- estimate moves when the population is defined by operator instead of by address.
-- The share of POSITIONS the successors contribute is reported beside the share of
-- wallets, because that is the quantity MT082 flagged as missing and it is what
-- decides whether the correction can matter at all.
--
-- ONE SCAN OF sol_transfers. That table is not partition-prunable by a wallet set
-- and cost 218 credits in Phase C, so the edge list and the entity panel are built
-- in a single query rather than two.
--
-- WHAT IT STILL CANNOT SEE, unchanged from MT082: a rotation funded from a third
-- address, one through a CEX or a mixer, an operator running addresses concurrently,
-- and a successor trading outside the two projects. Every one is a MISSED stitch, so
-- the correction measured here is a floor on the correction available.
-- ############################################################################

--#Q10 needs=BASE,RANK
,
vanished AS (
  SELECT ha.trader_id, ha.fit_decile, ha.top_by_mean, ha.top_by_median
  FROM holdout_activity ha
  WHERE ha.n_hold = 0
),

/* Outbound native SOL from a vanished flagged wallet. The 0.05 floor is the same
   one MT082 froze: a wallet closing token accounts emits a tail of dust, and a
   rotation moves a working balance. */
outflows AS (
  SELECT
    t.from_owner          AS predecessor,
    t.to_owner            AS successor,
    SUM(t.amount_display) AS sol_moved,
    MIN(t.block_time)     AS first_move
  FROM tokens_solana.sol_transfers t
  JOIN vanished v ON v.trader_id = t.from_owner
  CROSS JOIN params p
  WHERE t.block_date >= DATE '2026-07-08'
    AND t.block_date <= p.hold_end_date
    AND t.block_time <  p.hold_end
    AND t.to_owner <> t.from_owner
    AND t.amount_display >= 0.05
  GROUP BY 1, 2
),

/* A successor is an address that traded AFTER receiving, and that had never traded
   before receiving. The second clause is what makes it a fresh identity rather than
   an existing trader who happened to be paid. */
successor_first_trade AS (
  SELECT w.trader_id, MIN(w.block_time) AS first_trade_ever
  FROM windowed w
  GROUP BY 1
),

edges AS (
  SELECT
    o.predecessor,
    o.successor,
    o.sol_moved,
    o.first_move
  FROM outflows o
  JOIN successor_first_trade s ON s.trader_id = o.successor
  WHERE s.first_trade_ever > o.first_move
),

/* One predecessor per successor. A successor funded by two vanished wallets is
   assigned to the LARGER transfer, deterministically, rather than double counted
   into both cohorts. */
entity_map AS (
  SELECT
    e.successor,
    e.predecessor
  FROM (
    SELECT
      e.*,
      ROW_NUMBER() OVER (PARTITION BY e.successor ORDER BY e.sol_moved DESC, e.predecessor) AS rn
    FROM edges e
  ) e
  WHERE e.rn = 1
),

/* Every holdout position, attributed to an ENTITY.
   - a flagged wallet's own position keeps its own cohort;
   - a successor's position takes its predecessor's cohort;
   - anything else stays out, exactly as in H1. */
entity_positions AS (
  SELECT
    CAST(pp.first_buy AS DATE)                                  AS utc_day,
    pp.entry_project,
    pp.trader_id,
    pp.ret_carryfwd,
    pp.ret_zero,
    pp.sol_in,
    pp.is_closed,
    pp.unmarkable,
    pp.external_inflow,
    pp.below_min_size,
    NOT pp.external_inflow AND NOT pp.below_min_size AND pp.ret_carryfwd IS NOT NULL AS keep,
    COALESCE(fown.top_by_mean, fpred.top_by_mean)               AS top_by_mean,
    COALESCE(fown.top_by_median, fpred.top_by_median)           AS top_by_median,
    fown.trader_id IS NOT NULL                                  AS is_own,
    em.predecessor IS NOT NULL AND fown.trader_id IS NULL       AS is_successor
  FROM position_pnl pp
  LEFT JOIN flagged fown ON fown.trader_id = pp.trader_id
  LEFT JOIN entity_map em ON em.successor = pp.trader_id
  LEFT JOIN flagged fpred ON fpred.trader_id = em.predecessor
  WHERE pp.window_tag = 'HOLD'
    AND (fown.trader_id IS NOT NULL OR em.predecessor IS NOT NULL)
)

SELECT
  ep.utc_day,
  CASE
    WHEN ep.top_by_median AND ep.top_by_mean THEN 'TOP_BOTH'
    WHEN ep.top_by_median                    THEN 'TOP_MEDIAN_ONLY'
    WHEN ep.top_by_mean                      THEN 'TOP_MEAN_ONLY'
    ELSE 'REST_NEITHER'
  END                                                           AS cohort,
  ep.entry_project,
  -- The same columns query 3 returned, so the entity-level difference is computed by
  -- the same offline machinery and the two are comparable line for line.
  COUNT(*)                                                      AS n_all,
  COUNT_IF(ep.external_inflow)                                  AS n_external_inflow,
  COUNT_IF(ep.below_min_size)                                   AS n_below_min_size,
  COUNT_IF(ep.unmarkable)                                       AS n_unmarkable,
  COUNT(DISTINCT ep.trader_id)                                  AS wallets,
  COUNT_IF(ep.keep)                                             AS n,
  SUM(IF(ep.keep, ep.ret_carryfwd, 0e0))                        AS sum_ret,
  SUM(IF(ep.keep, ep.ret_carryfwd * ep.ret_carryfwd, 0e0))      AS sum_ret_sq,
  SUM(IF(ep.keep, ep.ret_zero, 0e0))                            AS sum_ret_zero,
  COUNT_IF(ep.keep AND ep.ret_carryfwd > 0)                     AS n_positive,
  SUM(IF(ep.keep, ep.sol_in, 0e0))                              AS sum_sol_in,
  SUM(IF(ep.keep, ep.ret_carryfwd * ep.sol_in, 0e0))            AS sum_ret_times_sol_in,
  APPROX_PERCENTILE(IF(ep.keep, ep.ret_carryfwd, NULL), 0.5)    AS median_ret,
  COUNT_IF(ep.keep AND ep.is_closed)                            AS n_closed,
  SUM(IF(ep.keep AND ep.is_closed, ep.ret_carryfwd, 0e0))       AS sum_ret_closed,
  SUM(IF(ep.keep AND ep.is_closed, ep.sol_in, 0e0))             AS sum_sol_in_closed,
  -- THE QUANTITY MT082 SAID WAS MISSING: how much of the panel is successors.
  COUNT_IF(ep.is_successor)                                     AS n_all_successor,
  COUNT_IF(ep.keep AND ep.is_successor)                         AS n_successor,
  SUM(IF(ep.keep AND ep.is_successor, ep.ret_carryfwd, 0e0))    AS sum_ret_successor,
  SUM(IF(ep.keep AND ep.is_successor, ep.ret_carryfwd * ep.ret_carryfwd, 0e0)) AS sum_ret_sq_successor,
  COUNT(DISTINCT IF(ep.is_successor, ep.trader_id, NULL))       AS wallets_successor
FROM entity_positions ep
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

--#END

-- ############################################################################
-- QUERY 11 — PHASE G §1.1, COVERAGE ONLY. NO RETURNS.
--
-- Phase C's 46% gap is a property of demanding a price at t+3600s. Coverage is a
-- function of the horizon and it is measurable WITHOUT READING A SINGLE RETURN,
-- which is what makes horizon selection outcome-independent and therefore not a
-- forking path.
--
-- THIS QUERY DELIBERATELY CANNOT ANSWER "WHICH HORIZON PAYS BEST". It returns counts
-- and nothing else: no sum of returns, no mean, no price, no ratio. H* is selected
-- from its output and written to the ledger, and only then does a separate query
-- compute returns. The separation is the design, not a formality — a single query
-- returning both would put the answer in front of the person choosing the question.
--
-- H = 3600s is included solely as the anchor to Phase C and is NOT a candidate.
-- ############################################################################

--#Q11 needs=BASE,RANK
,
g_pos AS (
  SELECT
    CAST(pp.first_buy AS DATE)      AS utc_day,
    pp.trader_id,
    pp.mint,
    pp.first_buy                    AS t_buy,
    f.top_mean_001,
    f.top_median_001,
    f.top_mean_01,
    f.top_median_01
  FROM position_pnl pp
  JOIN flagged f ON f.trader_id = pp.trader_id
  WHERE pp.window_tag = 'HOLD'
    AND pp.entry_project = 'pumpswap'
    AND NOT pp.external_inflow
    AND NOT pp.below_min_size
    AND (f.top_mean_01 OR f.top_median_01)
),

/* One scan. Every entry window and every horizon window lies inside
   [t_buy + 2s, t_buy + 3720s), so the tape is joined once and the windows are
   conditional aggregates over it.

   A window is "priced" when it contains at least one trade with a positive token
   amount — the same test the earlier phases used, expressed as a count so that no
   price ever appears in this output. */
g_windows AS (
  SELECT
    p.utc_day, p.trader_id, p.mint, p.t_buy,
    p.top_mean_001, p.top_median_001, p.top_mean_01, p.top_median_01,
    -- ENTRY at each lag
    COUNT_IF(w.block_time >= date_add('second', 2, p.t_buy)
         AND w.block_time <  date_add('second', 62, p.t_buy) AND w.token_amount > 0)   AS n_entry_l2,
    COUNT_IF(w.block_time >= date_add('second', 15, p.t_buy)
         AND w.block_time <  date_add('second', 75, p.t_buy) AND w.token_amount > 0)   AS n_entry_l15,
    -- EXIT at lag 2 and each horizon
    COUNT_IF(w.block_time >= date_add('second', 122, p.t_buy)
         AND w.block_time <  date_add('second', 182, p.t_buy) AND w.token_amount > 0)  AS n_exit_l2_h120,
    COUNT_IF(w.block_time >= date_add('second', 302, p.t_buy)
         AND w.block_time <  date_add('second', 362, p.t_buy) AND w.token_amount > 0)  AS n_exit_l2_h300,
    COUNT_IF(w.block_time >= date_add('second', 602, p.t_buy)
         AND w.block_time <  date_add('second', 662, p.t_buy) AND w.token_amount > 0)  AS n_exit_l2_h600,
    COUNT_IF(w.block_time >= date_add('second', 1202, p.t_buy)
         AND w.block_time <  date_add('second', 1262, p.t_buy) AND w.token_amount > 0) AS n_exit_l2_h1200,
    COUNT_IF(w.block_time >= date_add('second', 3602, p.t_buy)
         AND w.block_time <  date_add('second', 3662, p.t_buy) AND w.token_amount > 0) AS n_exit_l2_h3600,
    -- EXIT at lag 15 and each horizon
    COUNT_IF(w.block_time >= date_add('second', 135, p.t_buy)
         AND w.block_time <  date_add('second', 195, p.t_buy) AND w.token_amount > 0)  AS n_exit_l15_h120,
    COUNT_IF(w.block_time >= date_add('second', 315, p.t_buy)
         AND w.block_time <  date_add('second', 375, p.t_buy) AND w.token_amount > 0)  AS n_exit_l15_h300,
    COUNT_IF(w.block_time >= date_add('second', 615, p.t_buy)
         AND w.block_time <  date_add('second', 675, p.t_buy) AND w.token_amount > 0)  AS n_exit_l15_h600,
    COUNT_IF(w.block_time >= date_add('second', 1215, p.t_buy)
         AND w.block_time <  date_add('second', 1275, p.t_buy) AND w.token_amount > 0) AS n_exit_l15_h1200,
    COUNT_IF(w.block_time >= date_add('second', 3615, p.t_buy)
         AND w.block_time <  date_add('second', 3675, p.t_buy) AND w.token_amount > 0) AS n_exit_l15_h3600,
    -- Truncation: a horizon that runs past the window edge is a measurement limit,
    -- not a dead token, and is excluded from both numerator and denominator.
    date_add('second', 3675, p.t_buy) > (SELECT hold_end FROM params)                  AS truncated_h3600,
    date_add('second', 1275, p.t_buy) > (SELECT hold_end FROM params)                  AS truncated_h1200
  FROM g_pos p
  JOIN windowed w
    ON w.mint = p.mint
   AND w.block_time >= date_add('second', 2, p.t_buy)
   AND w.block_time <  date_add('second', 3675, p.t_buy)
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
),

arms AS (
  SELECT * FROM (VALUES
    ('MEAN',   0.001),
    ('MEDIAN', 0.001),
    ('MEAN',   0.01),
    ('MEDIAN', 0.01)
  ) AS t(rank_stat, top_fraction)
),

horizons AS (
  SELECT * FROM (VALUES (120), (300), (600), (1200), (3600)) AS t(horizon_s)
),

lags AS (
  SELECT * FROM (VALUES (2), (15)) AS t(lag_s)
)

SELECT
  g.utc_day,
  a.rank_stat,
  a.top_fraction,
  l.lag_s,
  h.horizon_s,
  COUNT(*)                                                                  AS n_followable,
  COUNT_IF(CASE WHEN l.lag_s = 2 THEN g.n_entry_l2 > 0 ELSE g.n_entry_l15 > 0 END) AS n_entry_priced,
  COUNT_IF(
    CASE
      WHEN l.lag_s = 2 AND h.horizon_s =  120 THEN g.n_exit_l2_h120  > 0
      WHEN l.lag_s = 2 AND h.horizon_s =  300 THEN g.n_exit_l2_h300  > 0
      WHEN l.lag_s = 2 AND h.horizon_s =  600 THEN g.n_exit_l2_h600  > 0
      WHEN l.lag_s = 2 AND h.horizon_s = 1200 THEN g.n_exit_l2_h1200 > 0
      WHEN l.lag_s = 2 AND h.horizon_s = 3600 THEN g.n_exit_l2_h3600 > 0
      WHEN h.horizon_s =  120 THEN g.n_exit_l15_h120  > 0
      WHEN h.horizon_s =  300 THEN g.n_exit_l15_h300  > 0
      WHEN h.horizon_s =  600 THEN g.n_exit_l15_h600  > 0
      WHEN h.horizon_s = 1200 THEN g.n_exit_l15_h1200 > 0
      ELSE g.n_exit_l15_h3600 > 0
    END)                                                                    AS n_exit_priced,
  COUNT_IF(
    (CASE WHEN l.lag_s = 2 THEN g.n_entry_l2 > 0 ELSE g.n_entry_l15 > 0 END)
    AND
    CASE
      WHEN l.lag_s = 2 AND h.horizon_s =  120 THEN g.n_exit_l2_h120  > 0
      WHEN l.lag_s = 2 AND h.horizon_s =  300 THEN g.n_exit_l2_h300  > 0
      WHEN l.lag_s = 2 AND h.horizon_s =  600 THEN g.n_exit_l2_h600  > 0
      WHEN l.lag_s = 2 AND h.horizon_s = 1200 THEN g.n_exit_l2_h1200 > 0
      WHEN l.lag_s = 2 AND h.horizon_s = 3600 THEN g.n_exit_l2_h3600 > 0
      WHEN h.horizon_s =  120 THEN g.n_exit_l15_h120  > 0
      WHEN h.horizon_s =  300 THEN g.n_exit_l15_h300  > 0
      WHEN h.horizon_s =  600 THEN g.n_exit_l15_h600  > 0
      WHEN h.horizon_s = 1200 THEN g.n_exit_l15_h1200 > 0
      ELSE g.n_exit_l15_h3600 > 0
    END)                                                                    AS n_both_priced,
  COUNT_IF(CASE WHEN h.horizon_s = 3600 THEN g.truncated_h3600
                WHEN h.horizon_s = 1200 THEN g.truncated_h1200
                ELSE FALSE END)                                             AS n_truncated,
  COUNT(DISTINCT g.trader_id)                                               AS wallets
FROM g_windows g
CROSS JOIN arms a
CROSS JOIN horizons h
CROSS JOIN lags l
WHERE (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.001 AND g.top_mean_001)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.001 AND g.top_median_001)
   OR (a.rank_stat = 'MEAN'   AND a.top_fraction = 0.01  AND g.top_mean_01)
   OR (a.rank_stat = 'MEDIAN' AND a.top_fraction = 0.01  AND g.top_median_01)
GROUP BY 1, 2, 3, 4, 5
ORDER BY 2, 3, 4, 5, 1;

--#END
