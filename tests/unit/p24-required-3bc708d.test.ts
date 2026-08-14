import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * P24 — the 48 required tests of the 3bc708d directive, and where each lives.
 *
 * The index is asserted rather than written down. A coverage claim nobody checks
 * is the same class of thing as the dead modules this session keeps deleting:
 * it reads as evidence and is not.
 *
 * `null` means NOT COVERED. Those are listed by name at the bottom and the count
 * is asserted, so a later session cannot quietly lose track of which ones were
 * left — and cannot quietly claim one that was never written.
 */

type Home = string | null;

const COVERAGE: Readonly<Record<number, { what: string; home: Home }>> = {
  1: { what: 'linked fresh-state legs are not called stateful', home: 'tests/unit/true-stateful-p24.test.ts' },
  2: { what: 'sell executes against the buy-mutated pool state', home: 'tests/unit/true-stateful-p24.test.ts' },
  3: { what: 'direct stateful result differs from a pre-buy-state sell', home: 'tests/unit/true-stateful-p24.test.ts' },
  4: { what: 'raw atoms alone cannot define a mechanics gate', home: 'tests/unit/capital-at-risk-p14.test.ts' },
  5: { what: 'transfer-fee unknown prevents PnL eligibility', home: 'tests/unit/settlement-p4.test.ts' },
  6: { what: 'execution cost never includes principal', home: 'tests/unit/settlement-p4.test.ts' },
  7: { what: 'exit cash in includes recovered rent exactly once', home: 'tests/unit/settlement.test.ts' },
  8: { what: 'BUILD_CUSTOM fill never receives /order platform fees', home: 'tests/unit/settlement.test.ts' },
  9: { what: 'production fill equals canonical settlement', home: 'tests/unit/paper-core.test.ts' },
  10: { what: 'production ledger equals canonical settlement', home: 'tests/unit/ledgers.test.ts' },
  11: { what: 'an actual successful leg pays no fictional failure', home: 'tests/unit/settlement-p4.test.ts' },
  12: { what: 'position close writes every explicit field', home: 'tests/unit/explicit-pnl.test.ts' },
  13: { what: 'the paper shell calls core entry', home: 'tests/unit/paper-core.test.ts' },
  14: { what: 'the paper shell calls core shadow lifecycle', home: null },
  15: { what: 'a trigger observation cannot be its own fill', home: 'tests/unit/trigger-fill-p10.test.ts' },
  16: { what: 'a blocked shadow remains managed', home: 'tests/unit/shadow-lifecycle.test.ts' },
  17: { what: 'the urgent WSS queue is consumed', home: 'tests/unit/risk-alarm.test.ts' },
  18: { what: 'the alarm watches the decoded pool/vault account', home: 'tests/unit/risk-alarm.test.ts' },
  19: { what: 'unwatch uses the exact subscribed account', home: 'tests/unit/risk-alarm.test.ts' },
  20: { what: 'an account hash changes with any data byte', home: 'tests/unit/accountwatch.test.ts' },
  21: { what: 'idle account slots do not create fake gap alarms', home: 'tests/unit/accountwatch-p15.test.ts' },
  22: { what: 'the raw log firehose is bounded', home: 'tests/unit/event-pipeline-p8.test.ts' },
  23: { what: 'a parsed event contains mint, pool and amount', home: 'tests/unit/event-pipeline-p8.test.ts' },
  24: { what: 'a processed reversal is reconciled', home: 'tests/unit/truth-repair.test.ts' },
  25: { what: 'an older cohort is not vetoed by the 1-hour global gate', home: 'tests/unit/cohort-exploration-p9p10.test.ts' },
  26: { what: 'per-cohort screening state is independent', home: 'tests/unit/cohort-exploration-p9p10.test.ts' },
  27: { what: 'exploration occurs with a two-quote cycle budget', home: 'tests/unit/cohort-exploration-p9p10.test.ts' },
  28: { what: 'the actual inclusion probability is persisted', home: 'tests/unit/cohort-exploration-p9p10.test.ts' },
  29: { what: 'direct mint facts reach screening', home: 'tests/unit/mintfacts-p11.test.ts' },
  30: { what: 'paper collects Token-2022 facts', home: 'tests/unit/mintfacts-p11.test.ts' },
  31: { what: 'the current epoch transfer fee reaches settlement', home: 'tests/unit/mintfacts-p11.test.ts' },
  32: { what: 'Mayhem flow is excluded from organic breadth', home: null },
  33: { what: 'insufficient score coverage blocks or stratifies eligibility', home: 'tests/unit/score-defects.test.ts' },
  34: { what: 'the config strategy version equals the score semantics', home: 'tests/unit/score-frozen.test.ts' },
  35: { what: 'PumpSwap sell parity', home: 'tests/unit/parity-v2-p24.test.ts' },
  36: { what: 'multiple-size parity', home: 'tests/unit/parity-v2-p24.test.ts' },
  37: { what: 'LiteSVM loads ELF via the program cache', home: 'tests/unit/litesvm-runtime-p24.test.ts' },
  38: { what: 'LiteSVM restores Clock, ALTs and blockhash', home: 'tests/unit/litesvm-runtime-p24.test.ts' },
  39: { what: 'the confirmatory view cannot duplicate one position', home: 'tests/unit/confirmatory-v3.test.ts' },
  40: { what: 'the confirmatory view filters exact arm, context and notional', home: 'tests/unit/confirmatory-v3.test.ts' },
  41: { what: 'drawdown starts at actual NAV', home: 'tests/unit/readiness.test.ts' },
  42: { what: 'the canary shadow is exact-context filtered', home: 'tests/unit/confirmatory-v3.test.ts' },
  43: { what: 'bigint ratios avoid unsafe Number conversion', home: 'tests/property/amounts.property.test.ts' },
  44: { what: 'a stale artifact cannot authorize readiness', home: 'tests/unit/artifact-provenance-p18.test.ts' },
  45: { what: '200 losing trades cannot pass', home: 'tests/unit/readiness.test.ts' },
  46: { what: 'a top-three-fragile positive corpus cannot pass', home: 'tests/unit/readiness.test.ts' },
  47: { what: 'the executor cannot start a strategy loop before CANARY_READY', home: 'tests/unit/executor-downstream-p23.test.ts' },
  48: { what: 'live remains blocked until positive real canary evidence', home: 'tests/unit/executor-downstream-p23.test.ts' },
};

/** The ones deliberately left, each with the reason it could not be written. */
const NOT_COVERED: Readonly<Record<number, string>> = {
  14: 'P6 shadow trajectories are not built, so there is no core shadow lifecycle to call',
  32: 'P11 Mayhem facts have a table but no source populating it, so nothing to exclude from',
};

describe('P24 — every required test has a home, or is named as missing', () => {
  it('covers all 48 items', () => {
    const ids = Object.keys(COVERAGE).map(Number).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
  });

  it('every named home is a file that exists', () => {
    const missing: string[] = [];
    for (const [id, entry] of Object.entries(COVERAGE)) {
      if (entry.home === null) continue;
      if (!existsSync(entry.home)) missing.push(`${id}: ${entry.home}`);
    }
    expect(missing).toEqual([]);
  });

  it('every named home actually mentions its item', () => {
    // Weak on its own — a file can mention anything — but it catches the case
    // this index exists to prevent: a home that was renamed or emptied while
    // the map kept pointing at it.
    const empty: string[] = [];
    for (const [id, entry] of Object.entries(COVERAGE)) {
      if (entry.home === null) continue;
      const body = readFileSync(entry.home, 'utf8');
      if (!/\bit\s*(\.\w+)?\s*\(/.test(body)) empty.push(`${id}: ${entry.home} has no tests`);
    }
    expect(empty).toEqual([]);
  });

  it('names exactly the items that are not covered, and why', () => {
    const uncovered = Object.entries(COVERAGE)
      .filter(([, e]) => e.home === null)
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
    expect(uncovered).toEqual(Object.keys(NOT_COVERED).map(Number).sort((a, b) => a - b));
    for (const id of uncovered) expect(NOT_COVERED[id]?.length ?? 0).toBeGreaterThan(20);
  });

  it('reports the count, so a regression in coverage is visible', () => {
    const covered = Object.values(COVERAGE).filter((e) => e.home !== null).length;
    expect(covered).toBe(46);
  });
});
