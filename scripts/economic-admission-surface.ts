/**
 * P7 — what score does a token ACTUALLY need?
 *
 * The config says `minOpportunityScore`. That is not the binding constraint.
 * Sizing maps score to notional, and a notional below the mechanics floor is
 * refused, so the effective threshold is wherever the size curve crosses that
 * floor — a number nobody wrote down and everybody assumed was the config one.
 *
 * Machine-generated, because a hand-written version goes stale the first time
 * a fee assumption moves and then misleads with authority.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { restoreLedger } from '../apps/engine/src/ledger.js';
import { sizePosition, viableFloorLamports } from '../packages/strategy/src/portfolio.js';

// The PAPER config. `loadConfig()` with no mode reads a different file with a
// different paperStartLamports, and the surface would describe a book that is
// not the one running.
const config = loadConfig('paper');
const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, readonly: true });
const ledger = restoreLedger(db, config, Date.now());

const nav = ledger.navLamports;
const riskBudget = (nav * BigInt(Math.round(config.risk.riskBudgetPctPerTrade * 10_000))) / 1_000_000n;

/**
 * The floor, from the SAME function sizing uses.
 *
 * Recomputing it here would produce a report that agrees with the code until
 * one of them changes, and then disagrees silently — which is the entire class
 * of defect this directive is about.
 */
const minViableNotional = viableFloorLamports(config);

/** The overhead the floor is derived from, reported so the floor is legible. */
const overhead =
  config.assumedSignatureFeeLamports * 2n +
  config.assumedPriorityFeeLamports * 2n +
  config.assumedBroadcasterTipLamports * 2n +
  config.assumedAtaRentLamports;

/** Walk the score axis and find where sizing first clears the floor. */
const rows: {
  score: number;
  notionalLamports: string;
  clearsMechanicsFloor: boolean;
  fixedCostFraction: number | null;
  reason: string | null;
}[] = [];

let effectiveMinScore: number | null = null;
for (let i = 0; i <= 100; i++) {
  const score = i / 100;
  let notional = 0n;
  let reason: string | null = null;
  try {
    const sized = sizePosition(
      {
        navLamports: nav,
        freeLamports: ledger.freeLamports,
        openPositions: 0,
        totalExposureLamports: 0n,
        realizedTodayLamports: 0n,
        realizedWeekLamports: 0n,
        plannedLossLamports: 0n,
        peakNavLamports: nav,
        // Null means the catastrophic floor governs, which is the state a
        // corpus with no valid completed positions is genuinely in.
        observedSevereLossBps: null,
      },
      config,
      score,
    );
    notional = sized.lamports;
    reason = sized.refusal === null ? null : `${sized.refusal}: ${sized.detail}`;
  } catch (e) {
    reason = (e as Error).message.slice(0, 80);
  }
  const clears = notional >= minViableNotional && notional > 0n;
  if (clears && effectiveMinScore === null) effectiveMinScore = score;
  rows.push({
    score,
    notionalLamports: notional.toString(),
    clearsMechanicsFloor: clears,
    fixedCostFraction: notional === 0n ? null : Number(overhead) / Number(notional),
    reason,
  });
}

const surface = {
  generatedUtcMs: Date.now(),
  strategyVersion: config.strategyVersion,
  nav: { lamports: nav.toString(), sol: Number(nav) / 1e9 },
  riskBudgetPerTrade: {
    pct: config.risk.riskBudgetPctPerTrade,
    lamports: riskBudget.toString(),
    sol: Number(riskBudget) / 1e9,
  },
  // A memecoin can go to zero, so the sizing floor assumes it does.
  catastrophicLossFraction: 1,
  assumptions: {
    signatureFeeLamports: config.assumedSignatureFeeLamports.toString(),
    priorityFeeLamports: config.assumedPriorityFeeLamports.toString(),
    broadcasterTipLamports: config.assumedBroadcasterTipLamports.toString(),
    ataRentLamports: config.assumedAtaRentLamports.toString(),
    // P6 — charged on realised legs at probability 1 on every SUCCESS, which
    // fabricated one failure per success. Realised labels now charge zero.
    failedAttemptLamports_prospectiveOnly: config.assumedFailedAttemptLamports.toString(),
    roundTripOverheadLamports: overhead.toString(),
  },
  mechanicsFloor: {
    minViableNotionalLamports: minViableNotional.toString(),
    minViableNotionalSol: Number(minViableNotional) / 1e9,
  },
  configuredMinOpportunityScore: config.minOpportunityScore,
  /**
   * The number that actually decides. If it exceeds the configured minimum,
   * the configured minimum is decorative and every discussion of "lowering the
   * score threshold" is about the wrong lever.
   */
  effectiveMinOpportunityScore: effectiveMinScore,
  configuredThresholdIsBinding:
    effectiveMinScore === null ? null : effectiveMinScore <= config.minOpportunityScore,
  scoreToSize: rows,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/economic-admission-surface.json', JSON.stringify(surface, null, 2));

console.log(`NAV                      ${surface.nav.sol} SOL`);
console.log(`risk budget per trade    ${surface.riskBudgetPerTrade.sol} SOL (${config.risk.riskBudgetPctPerTrade})`);
console.log(`round-trip overhead      ${Number(overhead) / 1e9} SOL`);
console.log(`min viable notional      ${surface.mechanicsFloor.minViableNotionalSol} SOL`);
console.log(`configured min score     ${surface.configuredMinOpportunityScore}`);
console.log(`EFFECTIVE min score      ${effectiveMinScore ?? 'unreachable at any score'}`);
console.log(
  surface.configuredThresholdIsBinding === true
    ? 'the configured threshold IS the binding constraint'
    : 'the configured threshold is DECORATIVE; mechanics decide',
);
console.log('artifacts/economic-admission-surface.json');
db.close();
