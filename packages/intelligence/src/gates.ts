import type { GateConfig } from '../../domain/src/config.js';
import type { GateResult, RoundTrip } from '../../domain/src/types.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';

/**
 * Two-layer safety engine.
 *
 * Layer 1 — HARD VETOES: conditions under which we will not enter, ever.
 * Layer 2 — SOFT RISK: graded concerns that reduce score and size.
 *
 * These are deliberately NOT collapsed into one number. A single "rug score"
 * destroys the ability to measure which specific filter earned its keep, and
 * observe mode exists precisely to measure that.
 */

function veto(gate: string, passed: boolean, reason: string, detail: string): GateResult {
  return { gate, severity: 'hard_veto', passed, reason, detail: detail.slice(0, 200), riskContribution: passed ? 0 : 1 };
}

function soft(gate: string, risk: number, reason: string, detail: string): GateResult {
  const clamped = Math.max(0, Math.min(1, risk));
  return {
    gate,
    severity: 'soft_risk',
    passed: clamped < 1,
    reason,
    detail: detail.slice(0, 200),
    riskContribution: clamped,
  };
}

export interface GateInputs {
  readonly info: MintInformation;
  readonly nowUtcMs: number;
  /** Age of the underlying data at decision time, per source. */
  readonly sourceAgeMs: number;
  readonly roundTrip: RoundTrip | null;
  readonly config: GateConfig;
}

/**
 * Cheap gates: everything computable WITHOUT spending a quote.
 *
 * This split matters economically. The keyless Jupiter budget is ~30 requests
 * per minute total, so a round-trip quote (2 requests) is the scarcest
 * resource we have. Anything rejectable for free must be rejected for free.
 */
export function evaluateCheapGates(input: Omit<GateInputs, 'roundTrip'>): GateResult[] {
  const { info, nowUtcMs, sourceAgeMs, config } = input;
  const out: GateResult[] = [];

  // --- Data freshness. A stale snapshot may not drive a decision. ----------
  out.push(
    veto(
      'data_freshness',
      sourceAgeMs <= config.maxSourceAgeMs,
      'stale_source',
      `source age ${sourceAgeMs}ms > ${config.maxSourceAgeMs}ms`,
    ),
  );

  // --- Token program allowlist. Unknown program = we cannot reason. --------
  const program = info.tokenProgram ?? 'unknown';
  out.push(
    veto(
      'token_program_allowlist',
      config.allowedTokenPrograms.includes(program),
      'unknown_token_program',
      `token program ${program} not in allowlist`,
    ),
  );

  // --- Authorities. Retained mint authority means supply can be inflated
  //     under us; freeze authority means our exit can be disabled. ----------
  const audit = info.audit ?? {};
  if (config.requireMintAuthorityDisabled) {
    out.push(
      veto(
        'mint_authority_disabled',
        audit.mintAuthorityDisabled === true,
        'mint_authority_live',
        `mintAuthorityDisabled=${String(audit.mintAuthorityDisabled)}`,
      ),
    );
  }
  if (config.requireFreezeAuthorityDisabled) {
    out.push(
      veto(
        'freeze_authority_disabled',
        audit.freezeAuthorityDisabled === true,
        'freeze_authority_live',
        `freezeAuthorityDisabled=${String(audit.freezeAuthorityDisabled)}`,
      ),
    );
  }

  // --- Age window. Too young = not enough evidence to detect fake flow.
  //     Too old = the launch/migration event we are trading has passed. -----
  const createdMs = parseUtc(info.firstPool?.createdAt ?? info.createdAt ?? null);
  const ageMs = createdMs === null ? null : nowUtcMs - createdMs;
  out.push(
    veto(
      'min_token_age',
      ageMs !== null && ageMs >= config.minTokenAgeMs,
      'too_young',
      `age ${ageMs ?? 'unknown'}ms < ${config.minTokenAgeMs}ms`,
    ),
  );
  out.push(
    veto(
      'max_token_age',
      ageMs !== null && ageMs <= config.maxTokenAgeMs,
      'too_old',
      `age ${ageMs ?? 'unknown'}ms > ${config.maxTokenAgeMs}ms`,
    ),
  );

  // --- Liquidity floor. Without exit liquidity the position is a donation. -
  const liq = info.liquidity ?? null;
  out.push(
    veto(
      'min_liquidity',
      liq !== null && liq >= config.minLiquidityUsd,
      'insufficient_liquidity',
      `liquidity $${liq ?? 'unknown'} < $${config.minLiquidityUsd}`,
    ),
  );

  // --- Holder count. ------------------------------------------------------
  const holders = info.holderCount ?? null;
  out.push(
    veto(
      'min_holders',
      holders !== null && holders >= config.minHolderCount,
      'too_few_holders',
      `holders ${holders ?? 'unknown'} < ${config.minHolderCount}`,
    ),
  );

  // --- Creator inventory. A dev holding a large share can end the trade
  //     unilaterally, and does so routinely. ------------------------------
  const devPct = audit.devBalancePercentage ?? null;
  out.push(
    veto(
      'dev_balance',
      devPct === null ? false : devPct <= config.maxDevBalancePct,
      'dev_holds_too_much',
      `dev balance ${devPct ?? 'unknown'}% > ${config.maxDevBalancePct}%`,
    ),
  );

  // --- Top-holder concentration (raw; entity clustering refines this). -----
  const topPct = audit.topHoldersPercentage ?? null;
  out.push(
    veto(
      'top_holder_concentration',
      topPct === null ? false : topPct <= config.maxTopHolderPct,
      'concentrated_ownership',
      `top holders ${topPct ?? 'unknown'}% > ${config.maxTopHolderPct}%`,
    ),
  );

  // --- Real trading activity, as a precondition for momentum. -------------
  const s5 = info.stats5m ?? {};
  const buys5 = s5.numBuys ?? 0;
  out.push(
    veto('min_buys_5m', buys5 >= config.minBuyCount5m, 'insufficient_flow', `5m buys ${buys5} < ${config.minBuyCount5m}`),
  );
  const netBuyers = s5.numNetBuyers ?? null;
  out.push(
    veto(
      'min_net_buyers_5m',
      netBuyers === null ? buys5 >= config.minNetBuyers5m : netBuyers >= config.minNetBuyers5m,
      'insufficient_net_buyers',
      `5m net buyers ${netBuyers ?? `~${buys5}`} < ${config.minNetBuyers5m}`,
    ),
  );

  // --- Provider's own organic-flow estimate. Used as a gate but never as
  //     the sole gate: it is a third-party model, not chain truth.
  //
  //     Measured 2026-08-11: organicScore is 0 for EVERY token under ~1h old
  //     (n=461, zero exceptions). The provider has simply not computed it yet.
  //     Absence of a reputation score is a data-availability fact, not evidence
  //     of a bad token, so it must not hard-veto — otherwise this gate silently
  //     rejects 100% of the window the strategy is defined over. A score that
  //     HAS been computed and is low remains a hard veto.
  const organic = info.organicScore ?? null;
  const organicScored = organic !== null && organic > 0;
  if (organicScored) {
    out.push(
      veto(
        'min_organic_score',
        organic >= config.minOrganicScore,
        'low_organic_score',
        `organicScore ${organic} < ${config.minOrganicScore}`,
      ),
    );
  } else {
    out.push(
      soft(
        'organic_score_unavailable',
        0.25,
        'organic_score_unavailable',
        `organicScore ${organic ?? 'null'} — not yet computed for this age`,
      ),
    );
  }

  // --- Explicit third-party suspicion flag. -------------------------------
  if (audit.isSus === true) {
    out.push(veto('provider_sus_flag', false, 'provider_flagged_suspicious', 'audit.isSus = true'));
  }

  // ===================== SOFT RISK =======================================

  // Wash-activity proxy: high gross volume with very few distinct traders is
  // the classic signature of a small cluster trading with itself.
  const traders5 = s5.numTraders ?? null;
  const totalTx5 = (s5.numBuys ?? 0) + (s5.numSells ?? 0);
  if (traders5 !== null && traders5 > 0 && totalTx5 > 0) {
    const txPerTrader = totalTx5 / traders5;
    out.push(
      soft(
        'wash_tx_per_trader',
        normalize(txPerTrader, 3, 12),
        'high_tx_per_trader',
        `${txPerTrader.toFixed(1)} tx per trader in 5m`,
      ),
    );
  }

  // One-sided flow with no sells often means selling is not actually possible.
  const buyVol = s5.buyVolume ?? 0;
  const sellVol = s5.sellVolume ?? 0;
  if (buyVol > 0 && sellVol === 0 && (s5.numBuys ?? 0) > 10) {
    out.push(soft('no_sells_observed', 0.8, 'zero_sell_volume', 'buys present but zero sell volume in 5m'));
  }

  // Volume-to-liquidity: extreme churn relative to depth is unsustainable and
  // usually signals a coordinated push rather than genuine demand.
  if (liq !== null && liq > 0) {
    const volToLiq = (buyVol + sellVol) / liq;
    out.push(
      soft('volume_to_liquidity', normalize(volToLiq, 2, 10), 'extreme_churn', `5m volume/liquidity = ${volToLiq.toFixed(2)}`),
    );
  }

  // Vertical price moves are where retail buys the top.
  const chg5 = s5.priceChange ?? null;
  if (chg5 !== null) {
    out.push(
      soft('price_exhaustion', normalize(chg5, 40, 200), 'vertical_move', `5m price change ${chg5.toFixed(1)}%`),
    );
  }

  // Liquidity should grow with price. When it does not, the exit is thinning
  // exactly as the position becomes worth exiting.
  const liqChg = s5.liquidityChange ?? null;
  if (chg5 !== null && liqChg !== null && chg5 > 20 && liqChg < 0) {
    out.push(soft('liquidity_diverging', 0.7, 'price_up_liquidity_down', `price +${chg5.toFixed(0)}% liq ${liqChg.toFixed(0)}%`));
  }

  // Holder growth should accompany price. Price without holders is a few
  // wallets passing the token between themselves.
  const holderChg = s5.holderChange ?? null;
  if (chg5 !== null && holderChg !== null && chg5 > 30 && holderChg <= 0) {
    out.push(soft('price_without_holders', 0.75, 'no_holder_growth', `price +${chg5.toFixed(0)}% holders ${holderChg}`));
  }

  return out;
}

/**
 * Expensive gates: require a live executable round trip.
 * Only run these on candidates that survived the cheap layer.
 */
export function evaluateQuoteGates(roundTrip: RoundTrip | null, config: GateConfig): GateResult[] {
  const out: GateResult[] = [];

  if (roundTrip === null) {
    out.push(veto('quote_available', false, 'no_quote', 'no executable quote obtained'));
    return out;
  }

  out.push(
    veto('buy_route_exists', roundTrip.buy.outAmount > 0n, 'no_buy_route', 'buy quote returned zero output'),
  );

  // The decisive one. A buy route without a sell route is not a trade.
  out.push(veto('exit_route_exists', roundTrip.exitExists, 'no_exit_route', 'no sell route for the acquired amount'));

  const impactBps = Math.round(Math.abs(roundTrip.buy.priceImpactPct) * 10_000);
  out.push(
    veto(
      'price_impact',
      impactBps <= config.maxPriceImpactBps,
      'excessive_impact',
      `buy impact ${impactBps}bps > ${config.maxPriceImpactBps}bps`,
    ),
  );

  const rt = roundTrip.roundTripLossBps;
  out.push(
    veto(
      'round_trip_cost',
      rt !== null && rt <= config.maxRoundTripLossBps,
      'round_trip_too_expensive',
      `round trip ${rt === null ? 'unknown' : rt.toFixed(0)}bps > ${config.maxRoundTripLossBps}bps`,
    ),
  );

  if (rt !== null) {
    // Even an allowed round trip is a headwind that must be earned back.
    out.push(soft('round_trip_drag', normalize(rt, 150, 400), 'high_round_trip', `${rt.toFixed(0)}bps round trip`));
  }

  return out;
}

/** Map a value into 0..1 across [low, high], clipped at both ends. */
export function normalize(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

export function parseUtc(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export interface GateSummary {
  readonly gates: readonly GateResult[];
  readonly hardVetoes: readonly string[];
  readonly softRiskScore: number;
  readonly passedHardGates: boolean;
}

export function summarize(gates: readonly GateResult[]): GateSummary {
  const hardVetoes = gates.filter((g) => g.severity === 'hard_veto' && !g.passed).map((g) => g.reason);
  const softs = gates.filter((g) => g.severity === 'soft_risk');
  // Mean of soft contributions, so adding a new soft feature does not silently
  // inflate everything's risk.
  const softRiskScore = softs.length === 0 ? 0 : softs.reduce((a, g) => a + g.riskContribution, 0) / softs.length;
  return { gates, hardVetoes, softRiskScore, passedHardGates: hardVetoes.length === 0 };
}
