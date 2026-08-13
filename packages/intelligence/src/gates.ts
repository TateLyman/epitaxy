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
  /**
   * Age of the underlying data at decision time. NULL when the provider gave
   * no timestamp -- never 0, which would be the most favourable possible value
   * derived from the absence of information.
   */
  readonly sourceAgeMs: number | null;
  /** True in modes that can lose money. Unknowns are refused there. */
  readonly capitalAtRisk?: boolean;
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
  const capitalAtRisk = input.capitalAtRisk === true;
  const out: GateResult[] = [];

  // --- Data freshness. A stale snapshot may not drive a decision. ----------
  //
  // §7.6 — an ABSENT source timestamp is not age zero.
  //
  // `cycle.ts` computed `nowUtcMs - (parseUtc(info.updatedAt) ?? nowUtcMs)`,
  // so a token whose provider record carried no `updatedAt` scored as PERFECTLY
  // FRESH — the single most favourable value available — on the strength of a
  // missing field. That is the absence-becomes-zero defect this project has
  // now removed from impact, from transfer fees, and from holder ownership.
  //
  // Unknown is its own state. It passes the hard veto in modes that risk
  // nothing, carries soft risk, and is refused outright where capital is at
  // stake.
  if (sourceAgeMs === null) {
    out.push(
      capitalAtRisk
        ? veto('data_freshness', false, 'source_age_unknown', 'provider reported no updatedAt; freshness is unknown')
        : soft('data_freshness_unknown', 0.25, 'source_age_unknown', 'provider reported no updatedAt'),
    );
  } else {
    out.push(
      veto(
        'data_freshness',
        sourceAgeMs <= config.maxSourceAgeMs,
        'stale_source',
        `source age ${sourceAgeMs}ms > ${config.maxSourceAgeMs}ms`,
      ),
    );
  }

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
  //     unilaterally, and does so routinely.
  //
  //     Measured 2026-08-11: this field is absent for 81% of tokens in the
  //     strategy's age window (n=3561). Treating absence as "the dev holds
  //     everything" rejected the entire target population — the same mistake
  //     already corrected for organicScore. Absence of a provider field is a
  //     fact about the provider, not about the token, and is graded as risk.
  //     A value that is present and bad remains an unconditional refusal.
  const devPct = audit.devBalancePercentage ?? null;
  if (devPct !== null) {
    out.push(
      veto(
        'dev_balance',
        devPct <= config.maxDevBalancePct,
        'dev_holds_too_much',
        `dev balance ${devPct}% > ${config.maxDevBalancePct}%`,
      ),
    );
  } else {
    out.push(soft('dev_balance_unavailable', 0.2, 'dev_balance_unavailable', 'provider reported no dev balance'));
  }

  // --- Top-holder concentration, provider-reported.
  //     This is a pre-filter only. It counts the liquidity pool as a holder,
  //     which for a bonding-curve launch is most of the supply, so it cannot
  //     by itself distinguish "one whale owns it" from "it has not migrated
  //     yet". The authoritative measurement is on-chain; see
  //     evaluateConcentrationGate.
  const topPct = audit.topHoldersPercentage ?? null;
  if (topPct !== null) {
    out.push(
      soft(
        'provider_top_holders',
        topPct > config.maxTopHolderPct ? 0.3 : 0,
        'provider_concentration_high',
        `provider top holders ${topPct}% > ${config.maxTopHolderPct}%`,
      ),
    );
  } else {
    out.push(soft('top_holders_unavailable', 0.15, 'top_holders_unavailable', 'provider reported no top-holder share'));
  }

  // --- Real trading activity, as a precondition for momentum. -------------
  const s5 = info.stats5m ?? {};
  const buys5 = s5.numBuys ?? 0;
  out.push(
    veto('min_buys_5m', buys5 >= config.minBuyCount5m, 'insufficient_flow', `5m buys ${buys5} < ${config.minBuyCount5m}`),
  );
  /**
   * P17 -- a missing net-buyer count stays MISSING. It is not gross buys.
   *
   * This gate used to fall back to `buys5` when `numNetBuyers` was absent, and
   * the two are not the same quantity. Gross buys counts buy transactions; net
   * buyers counts distinct buyers less sellers. A wash trader running a
   * hundred round trips through two wallets produces an enormous gross buy
   * count and a net buyer count near zero.
   *
   * So the substitution handed the anti-wash gate the one number wash trading
   * inflates, and it did so precisely when the honest number was unavailable.
   *
   * Absence does not hard-veto -- that would reject the entire young-token
   * window the strategy is defined over -- and it is not treated as satisfied
   * either. It is charged as soft risk, which is the same contract the impact
   * and top-holder gates use.
   */
  const netBuyers = s5.numNetBuyers ?? null;
  if (netBuyers === null) {
    out.push(
      soft(
        'net_buyers_unavailable',
        0.25,
        'net_buyers_unknown',
        'provider reported no numNetBuyers; gross buys is a different quantity and is not substituted',
      ),
    );
  } else {
    out.push(
      veto(
        'min_net_buyers_5m',
        netBuyers >= config.minNetBuyers5m,
        'insufficient_net_buyers',
        `5m net buyers ${netBuyers} < ${config.minNetBuyers5m}`,
      ),
    );
  }

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

  // §P14 / §20 — no `Math.abs` on a signed market variable.
  //
  // This was the last surviving instance in the tree. The exit path had it
  // removed twice; the ENTRY gate kept it, so a favourable +500bps move and an
  // adverse -500bps move were the same number to the gate that decides whether
  // to buy. `adverseBps` is already non-negative by construction and is the
  // only field a cap may read; see packages/domain/src/impact.ts.
  const reading = roundTrip.buy.impact;
  const adverseBps = reading.adverseBps;
  out.push(
    veto(
      'price_impact',
      // An UNKNOWN impact does not satisfy the cap and does not breach it. It
      // means the provider said nothing, which is a fact about the provider --
      // so it passes here and is charged as soft risk below, rather than being
      // silently read as a perfect 0.
      adverseBps === null || adverseBps <= config.maxPriceImpactBps,
      'excessive_impact',
      `buy adverse impact ${adverseBps === null ? 'unknown' : adverseBps.toFixed(0)}bps > ${config.maxPriceImpactBps}bps`,
    ),
  );
  if (adverseBps === null) {
    out.push(
      soft('impact_unavailable', 0.2, 'impact_unknown', `impact unreadable: ${reading.status}`),
    );
  }

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

export interface ConcentrationInput {
  readonly topWalletPct: number | null;
  readonly topTenWalletPct: number | null;
  readonly programControlledPct: number;
}

/**
 * Authoritative, on-chain holder concentration.
 *
 * Pool inventory is excluded: a bonding curve holding 90% of supply is the
 * market we trade against, not a whale waiting to dump on us. What matters is
 * how much supply sits in independent wallets that can sell into our exit.
 *
 * When the measurement could not be made, the verdict depends on what is at
 * stake. Observing an unknown costs nothing; buying into one costs everything
 * we put in, so modes that risk real capital refuse instead of guessing.
 */
export function evaluateConcentrationGate(
  facts: ConcentrationInput | null,
  config: GateConfig,
  capitalAtRisk: boolean,
  unavailableReason = 'on-chain concentration unavailable',
): GateResult[] {
  if (facts === null || facts.topTenWalletPct === null) {
    if (capitalAtRisk) {
      return [veto('holder_concentration', false, 'concentration_unknown', unavailableReason)];
    }
    return [soft('holder_concentration_unavailable', 0.3, 'concentration_unknown', unavailableReason)];
  }

  const out: GateResult[] = [
    veto(
      'holder_concentration',
      facts.topTenWalletPct <= config.maxTopHolderPct,
      'concentrated_ownership',
      `top ten wallets hold ${facts.topTenWalletPct.toFixed(1)}% > ${config.maxTopHolderPct}%`,
    ),
  ];

  if (facts.topWalletPct !== null) {
    // A single wallet large enough to move the price alone is a different risk
    // from ten wallets summing to the same share.
    out.push(
      soft(
        'single_wallet_dominance',
        normalize(facts.topWalletPct, config.maxTopHolderPct / 2, config.maxTopHolderPct),
        'single_wallet_dominant',
        `largest wallet holds ${facts.topWalletPct.toFixed(1)}%`,
      ),
    );
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

/**
 * P17 -- soft risk that a new feature cannot dilute.
 *
 * This was the MEAN of the soft contributions, and the comment defending it
 * said adding a feature would not "silently inflate everything's risk". It does
 * the opposite, and worse: adding a feature that reports NO risk at all divides
 * the same total by a larger count, so every existing risk shrinks.
 *
 * Concretely, one gate at 0.9 gives 0.9. Add a zero-risk gate and the same
 * token scores 0.45 -- the risk halved because we wrote more code.
 *
 * That is the wrong direction for a safety number. A dangerous token becomes
 * safer every time the system learns something reassuring about it, and the
 * dilution is largest exactly where the evidence is thinnest.
 *
 * The replacement is `max(primary) + bounded secondary`:
 *
 *   - the worst single risk sets the floor, and nothing can lower it;
 *   - the remaining risks add into the headroom above it, never past 1.
 *
 * Adding a zero-risk feature contributes zero and changes nothing.
 */
export function summarize(gates: readonly GateResult[]): GateSummary {
  const hardVetoes = gates.filter((g) => g.severity === 'hard_veto' && !g.passed).map((g) => g.reason);
  const softs = gates.filter((g) => g.severity === 'soft_risk');
  const contributions = softs.map((g) => Math.max(0, Math.min(1, g.riskContribution))).sort((a, b) => b - a);

  const primary = contributions[0] ?? 0;
  // Everything below the worst, expressed as a fraction of the headroom that
  // remains. Diminishing, bounded, and monotonically non-decreasing in the
  // number of real risks found.
  let headroom = 1 - primary;
  let secondary = 0;
  for (const c of contributions.slice(1)) {
    const take = headroom * c;
    secondary += take;
    headroom -= take;
  }

  const softRiskScore = Math.max(0, Math.min(1, primary + secondary));
  return { gates, hardVetoes, softRiskScore, passedHardGates: hardVetoes.length === 0 };
}
