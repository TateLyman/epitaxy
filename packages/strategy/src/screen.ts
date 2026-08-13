import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../domain/src/config.js';
import type { DecisionSnapshot, RoundTrip, ScreeningOutcome } from '../../domain/src/types.js';
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import type { MintFacts } from '../../intelligence/src/mintfacts.js';
import {
  evaluateCheapGates,
  evaluateConcentrationGate,
  evaluateQuoteGates,
  parseUtc,
  summarize,
  type ConcentrationInput,
} from '../../intelligence/src/gates.js';
import { extractFeatures, opportunityScore } from './score.js';
import { sanitizeExternal } from '../../observability/src/log.js';

/**
 * The single screening path. Observe, paper, and replay all run THIS function,
 * so a decision cannot differ between modes. The only thing that varies is
 * whether `measureRoundTrip` is actually called or replayed from storage.
 */

export interface ScreenResult {
  readonly snapshot: DecisionSnapshot;
  readonly outcome: ScreeningOutcome;
  readonly roundTrip: RoundTrip | null;
  /** True when the cheap layer passed and a quote is worth spending. */
  readonly deservesQuote: boolean;
}

export function tokenAgeMs(info: MintInformation, nowUtcMs: number): number | null {
  const created = parseUtc(info.firstPool?.createdAt) ?? parseUtc(info.createdAt);
  return created === null ? null : nowUtcMs - created;
}

/** Phase 1: free. Rejects the overwhelming majority without spending a quote. */
export function screenCheap(
  info: MintInformation,
  config: AppConfig,
  nowUtcMs: number,
  sourceAgeMs: number | null,
  /**
   * P17 — the chain's own answer about mint and freeze authority.
   *
   * Null means it was not read, which the gate reports as a provider-sourced
   * verdict rather than treating as safe. Reading it costs an RPC call, so the
   * caller decides; what the caller may not do is pass a guess.
   */
  chainFacts: MintFacts | null = null,
): { gates: ReturnType<typeof evaluateCheapGates>; deservesQuote: boolean } {
  const gates = evaluateCheapGates({ info, nowUtcMs, sourceAgeMs, config: config.gates, chainFacts });
  return { gates, deservesQuote: summarize(gates).passedHardGates };
}

/** Phase 2: combines the cheap layer with an optional measured round trip. */
export function finalizeScreen(
  info: MintInformation,
  config: AppConfig,
  nowUtcMs: number,
  cheapGates: ReturnType<typeof evaluateCheapGates>,
  roundTrip: RoundTrip | null,
  slot: number | null,
  concentration: ConcentrationInput | null = null,
  /**
   * Age of the token feed at decision time. Null when the provider gave no
   * timestamp.
   *
   * REQUIRED, deliberately. It was briefly a defaulted parameter, and the
   * default disagreed with the value `screenCheap` had actually used: the gates
   * saw a number, the snapshot recorded null, and replay reported the resulting
   * score difference as a divergence. It was right to. A snapshot that records
   * an input the decision never saw is not a snapshot of that decision, so
   * every caller now has to pass the same value it gave the cheap gates.
   */
  sourceAgeMs: number | null,
): ScreenResult {
  const cheapSummary = summarize(cheapGates);
  const deservesQuote = cheapSummary.passedHardGates;

  // Quote gates only run when the cheap layer earned them. Otherwise the
  // absence of a quote must not be recorded as a quote failure.
  const quoteGates = deservesQuote ? evaluateQuoteGates(roundTrip, config.gates) : [];
  // Modes that commit real capital refuse an unmeasurable holder distribution;
  // modes that only observe record it as risk and carry on.
  const capitalAtRisk = config.mode === 'canary' || config.mode === 'live';
  const concentrationGates = deservesQuote
    ? evaluateConcentrationGate(concentration, config.gates, capitalAtRisk)
    : [];
  const gates = [...cheapGates, ...quoteGates, ...concentrationGates];
  const summary = summarize(gates);

  const ageMs = tokenAgeMs(info, nowUtcMs);
  const { score, components } = opportunityScore(info, roundTrip, summary.softRiskScore, ageMs);

  const snapshot: DecisionSnapshot = {
    snapshotId: randomUUID(),
    mint: info.id,
    takenUtcMs: nowUtcMs,
    takenMonotonicMs: Math.round(performance.now()),
    slot,
    tokenAgeMs: ageMs,
    features: extractFeatures(info, roundTrip, ageMs),
    rawInputs: {
      symbol: sanitizeExternal(info.symbol ?? '', 32),
      name: sanitizeExternal(info.name ?? '', 64),
      launchpad: sanitizeExternal(info.launchpad ?? '', 32),
      dev: info.dev ?? null,
      decimals: info.decimals,
      tokenProgram: info.tokenProgram ?? null,
      audit: info.audit ?? null,
      stats5m: info.stats5m ?? null,
      buyQuoteId: roundTrip?.buy.quoteId ?? null,
      sellQuoteId: roundTrip?.sell?.quoteId ?? null,
      // The authoritative on-chain holder distribution the gates actually saw.
      //
      // Omitting it made the decision non-re-derivable: replay had no way to
      // know a measurement had been taken, so it re-decided against null, got
      // `holder_concentration_unavailable` instead of `holder_concentration`,
      // and produced a different soft-risk mean and sometimes a different hard
      // veto. That is the snapshot being incomplete, which the invariant says
      // is a defect, and it is fixed here rather than by teaching replay to
      // skip the rows it cannot reproduce.
      //
      // `null` means measured-and-unavailable. A MISSING key means the
      // snapshot predates this capture; replay distinguishes the two and
      // refuses to treat the second as verified.
      concentration:
        concentration === null
          ? null
          : {
              topWalletPct: concentration.topWalletPct,
              topTenWalletPct: concentration.topTenWalletPct,
              programControlledPct: concentration.programControlledPct,
            },
    },
    freshnessMs: {
      // Null, not zero and not -1. A snapshot that cannot say "we did not know"
      // cannot be replayed into the same decision, and replay is the only
      // mechanism that catches a strategy change nobody wrote down.
      jupiter_tokens: sourceAgeMs,
      quote: roundTrip ? nowUtcMs - roundTrip.buy.receivedUtcMs : null,
    },
  };

  const eligible = summary.passedHardGates && score >= config.minOpportunityScore;

  const outcome: ScreeningOutcome = {
    mint: info.id,
    snapshotId: snapshot.snapshotId,
    evaluatedUtcMs: nowUtcMs,
    gates,
    hardVetoes: summary.hardVetoes,
    softRiskScore: summary.softRiskScore,
    opportunityScore: score,
    scoreComponents: components,
    eligible,
    strategyVersion: config.strategyVersion,
  };

  return { snapshot, outcome, roundTrip, deservesQuote };
}
