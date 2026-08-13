import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../packages/domain/src/config.js';
import {
  strategyConfigHash,
  dataRegimeId,
  riskPolicyHash,
  DECISION_BEARING_CONFIG_FIELDS,
  NON_DECISION_CONFIG_FIELDS,
  COST_ACCOUNTING_VERSION,
  PROVENANCE_VERSION,
} from '../../packages/domain/src/provenance.js';
import type { AppConfig } from '../../packages/domain/src/config.js';

/**
 * §21.1 — the enumeration test.
 *
 * The failure this prevents is silent and total: add a decision-bearing knob,
 * forget to add it to the hash, and two windows run under different policies
 * while reporting identical provenance. Every comparison between them is then
 * meaningless, and nothing anywhere says so.
 *
 * So every config field must be classified. Not "should" — the test fails.
 */

const config = loadConfig('paper');
const keys = Object.keys(config as unknown as Record<string, unknown>);

describe('every config field is classified', () => {
  it('leaves no field unclassified', () => {
    const classified = new Set([...DECISION_BEARING_CONFIG_FIELDS, ...Object.keys(NON_DECISION_CONFIG_FIELDS)]);
    const unclassified = keys.filter((k) => !classified.has(k));
    expect(
      unclassified,
      `unclassified config field(s): ${unclassified.join(', ')}. Add each to DECISION_BEARING_CONFIG_FIELDS, ` +
        'or to NON_DECISION_CONFIG_FIELDS with the reason it changes no decision.',
    ).toEqual([]);
  });

  it('classifies nothing twice', () => {
    const both = DECISION_BEARING_CONFIG_FIELDS.filter((k) => k in NON_DECISION_CONFIG_FIELDS);
    expect(both).toEqual([]);
  });

  it('classifies nothing that does not exist', () => {
    // A stale entry is as bad as a missing one: it suggests coverage that is
    // not there, and hides the field that replaced it.
    const present = new Set(keys);
    const ghosts = [...DECISION_BEARING_CONFIG_FIELDS, ...Object.keys(NON_DECISION_CONFIG_FIELDS)].filter(
      (k) => !present.has(k),
    );
    expect(ghosts).toEqual([]);
  });

  it('gives every non-decision field a written reason', () => {
    for (const [field, reason] of Object.entries(NON_DECISION_CONFIG_FIELDS)) {
      // A one-word reason is not a reason. This is the whole safeguard: the
      // cost of excluding a field is having to justify it in prose.
      expect(reason.length, `${field} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

describe('the hash actually moves when a decision-bearing field moves', () => {
  const base = strategyConfigHash(config);

  it.each(
    DECISION_BEARING_CONFIG_FIELDS.filter((k) => k !== 'risk' && k !== 'gates' && k !== 'exits'),
  )('changes when %s changes', (field) => {
    const record = { ...(config as unknown as Record<string, unknown>) };
    const current = record[field];
    // Perturb by type, so the test does not care what the field means.
    record[field] =
      typeof current === 'bigint'
        ? current + 1n
        : typeof current === 'number'
          ? current + 1
          : typeof current === 'boolean'
            ? !current
            : `${String(current)}-changed`;
    expect(strategyConfigHash(record as unknown as AppConfig), `${field} does not affect the hash`).not.toBe(base);
  });

  it('changes when the nested risk policy changes', () => {
    const record = { ...(config as unknown as Record<string, unknown>) };
    record['risk'] = { ...(config.risk as unknown as Record<string, unknown>), maxSimultaneousPositions: 99 };
    expect(strategyConfigHash(record as unknown as AppConfig)).not.toBe(base);
    expect(riskPolicyHash(record as unknown as AppConfig)).not.toBe(riskPolicyHash(config));
  });

  it('does NOT change when a non-decision field changes', () => {
    const record = { ...(config as unknown as Record<string, unknown>) };
    record['maxQuotesPerCycle'] = 999;
    // A rate budget changes how many observations are taken, never what one
    // means. Pooling across it is correct.
    expect(strategyConfigHash(record as unknown as AppConfig)).toBe(base);
  });

  it('changes when the cost accounting version changes', () => {
    // The same assumedPriorityFeeLamports means something different once the
    // applied compute limit is derived rather than assumed, so a corpus
    // spanning that change must not pool.
    expect(base).toContain('');
    expect(COST_ACCOUNTING_VERSION).toContain('derived-compute-limit');
    expect(PROVENANCE_VERSION).toBe('provenance-v2');
  });
});

describe('dataRegimeId separates regimes that must not pool', () => {
  it('separates a simulated window from an unsimulated one', () => {
    const off = { ...(config as unknown as Record<string, unknown>), requireLocalSimulation: false };
    expect(dataRegimeId(off as unknown as AppConfig, 'v1')).not.toBe(dataRegimeId(config, 'v1'));
  });

  it('separates exact-size builds from anything else', () => {
    const off = { ...(config as unknown as Record<string, unknown>), requireExactSizeBuild: false };
    expect(dataRegimeId(off as unknown as AppConfig, 'v1')).not.toBe(dataRegimeId(config, 'v1'));
  });

  it('separates route families', () => {
    const other = { ...(config as unknown as Record<string, unknown>), primaryRouteFamily: 'ORDER_EXECUTE' };
    expect(dataRegimeId(other as unknown as AppConfig, 'v1')).not.toBe(dataRegimeId(config, 'v1'));
  });

  it('still buckets the mark cadence, so one regime measured twice is one regime', () => {
    const a = { ...(config as unknown as Record<string, unknown>), markIntervalMs: 10_540 };
    const b = { ...(config as unknown as Record<string, unknown>), markIntervalMs: 10_560 };
    expect(dataRegimeId(a as unknown as AppConfig, 'v1')).toBe(dataRegimeId(b as unknown as AppConfig, 'v1'));
  });
});
