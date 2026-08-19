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

-- >>> BASE v2 (identical in Q1..Q4) >>>
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
    0.0269 AS round_trip_floor
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
    AND t.block_time >= p.fit_start
    AND t.block_time <  p.hold_end
    AND (t.token_bought_mint_address = p.wsol OR t.token_sold_mint_address = p.wsol)
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

edge_vwap AS (
  SELECT
    w.window_tag,
    w.mint,
    SUM(w.sol_amount)   AS sol_sum,
    SUM(w.token_amount) AS tok_sum
  FROM windowed w
  JOIN window_edge e ON e.window_tag = w.window_tag
  WHERE w.block_time >= e.edge - INTERVAL '60' MINUTE
  GROUP BY 1, 2
  HAVING SUM(w.token_amount) > 0
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
  ) x
  WHERE rn = 1
),

mark_price AS (
  SELECT
    COALESCE(v.window_tag, l.window_tag) AS window_tag,
    COALESCE(v.mint, l.mint)             AS mint,
    COALESCE(v.sol_sum / NULLIF(v.tok_sum, 0), l.sol_per_token) AS sol_per_token
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
    GREATEST(pos.tok_bought - pos.tok_sold, 0)
      * COALESCE(mp.sol_per_token, 0)                    AS residual_value,
    pos.tok_sold >= 0.99 * pos.tok_bought                AS is_closed,
    mp.sol_per_token IS NULL AND pos.tok_sold < 0.99 * pos.tok_bought AS unmarkable,
    -- primary: residual marked at the window-edge price
    (pos.sol_out + GREATEST(pos.tok_bought - pos.tok_sold, 0) * COALESCE(mp.sol_per_token, 0)
       - pos.sol_in) / NULLIF(pos.sol_in, 0)             AS ret_carryfwd,
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

SELECT
  window_tag,
  entry_project,
  COUNT(*)                                                       AS positions,
  COUNT(DISTINCT trader_id)                                      AS wallets,
  COUNT(DISTINCT mint)                                           AS mints,
  AVG(CASE WHEN is_closed        THEN 1.0 ELSE 0.0 END)           AS closed_share,
  AVG(CASE WHEN external_inflow  THEN 1.0 ELSE 0.0 END)           AS external_inflow_share,
  AVG(CASE WHEN unmarkable       THEN 1.0 ELSE 0.0 END)           AS unmarkable_share,
  AVG(CASE WHEN projects_touched > 1 THEN 1.0 ELSE 0.0 END)       AS spans_both_venues_share,
  APPROX_PERCENTILE(ret_carryfwd, 0.10)                          AS p10,
  APPROX_PERCENTILE(ret_carryfwd, 0.50)                          AS median,
  APPROX_PERCENTILE(ret_carryfwd, 0.90)                          AS p90,
  AVG(ret_carryfwd)                                              AS mean_carryfwd,
  AVG(ret_zero)                                                  AS mean_zero_marked,
  AVG(ret_carryfwd - fixed_cost_fraction)                         AS mean_net_of_our_fixed_cost,
  STDDEV(ret_carryfwd)                                           AS sd,
  APPROX_PERCENTILE(sol_in, 0.50)                                AS median_sol_in
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

-- >>> PASTE BASE v2 HERE (Q1 lines "WITH params AS (" .. "FROM positions pos ... )") >>>
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
    AVG(CASE WHEN pp.entry_project = 'pumpswap' THEN 1.0 ELSE 0.0 END) AS amm_entry_share
  FROM position_pnl pp
  WHERE pp.window_tag = 'FIT'
    AND NOT pp.external_inflow
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
  GROUP BY 1, 2, 3, 4, 5, 6
)

SELECT
  fit_decile,
  COUNT(*)                                                     AS wallets_in_decile,
  AVG(mean_ret_fit)                                            AS avg_fit_return,
  AVG(median_ret_fit)                                          AS avg_fit_median,
  SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END)                  AS vanished,
  1.0 * SUM(CASE WHEN n_hold = 0 THEN 1 ELSE 0 END) / COUNT(*) AS vanish_rate,
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

-- >>> PASTE BASE v2 AND THE fit_wallets / ranked / flagged CTEs FROM Q2 HERE >>>
SELECT
  CAST(pp.first_buy AS DATE)                                    AS utc_day,
  CASE WHEN f.top_by_mean THEN 'TOP_DECILE' ELSE 'REST' END      AS cohort,
  pp.entry_project,
  pp.trader_id,
  pp.mint,
  pp.first_buy,
  pp.sol_in,
  pp.is_closed,
  pp.external_inflow,
  pp.unmarkable,
  pp.ret_carryfwd,
  pp.ret_zero,
  pp.ret_carryfwd - pp.fixed_cost_fraction                       AS ret_net_of_our_fixed_cost
FROM position_pnl pp
JOIN flagged f ON f.trader_id = pp.trader_id
WHERE pp.window_tag = 'HOLD'
ORDER BY utc_day, cohort;

-- Export with external_inflow and unmarkable INCLUDED as columns and filter
-- offline, so the excluded count is visible in the same file as the result.


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

-- >>> PASTE BASE v2 AND THE fit_wallets / ranked / flagged CTEs FROM Q2 HERE >>>
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
    MAX(CASE WHEN f.top_by_mean THEN 1 ELSE 0 END)         AS top_present,
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
    CASE
      WHEN fm.top_present = 1    THEN 'TOP_PRESENT'
      WHEN fm.ranked_present = 1 THEN 'RANKED_NOT_TOP'
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

SELECT
  cohort,
  amm_at_entry,
  COUNT(*)                                                        AS mints,
  SUM(CASE WHEN exit_px IS NULL THEN 1 ELSE 0 END)                AS censored_no_exit_price,
  1.0 * SUM(CASE WHEN exit_px IS NULL THEN 1 ELSE 0 END) / COUNT(*) AS censored_share,
  AVG(exit_px / NULLIF(entry_px, 0) - 1)                          AS mean_fwd_return,
  APPROX_PERCENTILE(exit_px / NULLIF(entry_px, 0) - 1, 0.5)       AS median_fwd_return,
  STDDEV(exit_px / NULLIF(entry_px, 0) - 1)                       AS sd_fwd_return,
  -- D3: the LEVEL test. We would be the one trading here, so the full
  -- round-trip floor applies to the level even though it cancels in the
  -- difference between cohorts.
  AVG(exit_px / NULLIF(entry_px, 0) - 1) - (SELECT round_trip_floor FROM params) AS mean_net_of_floor,
  APPROX_PERCENTILE(distinct_early_buyers, 0.5)                   AS median_early_buyers
FROM priced
WHERE entry_px IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;

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
