import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../domain/src/config.js';
import type { DecisionSnapshot, RoundTrip, ScreeningOutcome } from '../../domain/src/types.js';
import { capitalAtRisk } from '../../domain/src/types.js';
import { TOKEN_2022_PROGRAM } from '../../solana/src/pda.js';

/** The mint's decoded Token-2022 behaviour, as the gates read it. */
export interface Token2022Facts {
  readonly hasMoneyCriticalBehaviour: boolean;
  readonly hasUnknownExtension: boolean;
  readonly transferFeeBps: number | null;
  readonly detail: string;
}
import type { MintInformation } from '../../adapters/src/jupiter/schemas.js';
import type { MintFacts } from '../../intelligence/src/mintfacts.js';
// P17 -- the entity reading enters the concentration decision through
// ConcentrationInput. Imported here so the module has a production caller
// and so the type of what the gate expects is stated once.
import type { ConcentrationReading } from '../../intelligence/src/entity.js';
export type { ConcentrationReading };
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
  /**
   * P14 — the mint's own Token-2022 behaviour, decoded from its account.
   *
   * `evaluateCheapGates` has read this since it was written and no caller ever
   * supplied it, so `token2022_money_critical` could not fire. A gate whose
   * input is never provided is a gate that does not exist.
   *
   * Null means the mint was not read. In a capital mode that is itself a
   * refusal below: unknown money-critical behaviour is not absent behaviour.
   */
  token2022: Token2022Facts | null = null,
  /**
   * P9 — which cohort's window to screen under. Null keeps the global one,
   * which is correct for a caller that has not assigned a cohort.
   */
  cohortAgeBounds: { fromMs: number; toMs: number } | null = null,
): { gates: ReturnType<typeof evaluateCheapGates>; deservesQuote: boolean } {
  const atRisk = capitalAtRisk(config.mode);
  const gates = evaluateCheapGates({
    info,
    nowUtcMs,
    sourceAgeMs,
    config: config.gates,
    chainFacts,
    capitalAtRisk: atRisk,
    token2022,
    cohortAgeBounds,
  });

  /**
   * A capital mode may not trade a mint it did not read.
   *
   * The Token-2022 gate can only refuse behaviour it was told about. Silence
   * is the one answer that must not pass, because every money-critical
   * extension — transfer hook, permanent delegate, pausable, non-transferable,
   * default-frozen — presents as silence when nobody looked.
   */
  const unread = atRisk && token2022 === null && info.tokenProgram === TOKEN_2022_PROGRAM;
  const all = unread
    ? [
        ...gates,
        {
          gate: 'token2022_unread',
          severity: 'hard_veto' as const,
          passed: false,
          reason: 'token2022_unread',
          detail: 'a Token-2022 mint was not decoded; unknown money-critical behaviour is not absent behaviour',
          riskContribution: 1,
        },
      ]
    : gates;

  return { gates: all, deservesQuote: summarize(all).passedHardGates };
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
  // P14 — the same derivation as the cheap layer. Two copies drift.
  const atRisk = capitalAtRisk(config.mode);
  const concentrationGates = deservesQuote
    ? evaluateConcentrationGate(concentration, config.gates, atRisk)
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
