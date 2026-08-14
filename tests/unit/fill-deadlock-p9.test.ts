import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  insertShadowMark,
  fillCandidatesSince,
  observationById,
  triggerShadowExit,
  blockShadowExit,
  openShadowPositions,
} from '../../packages/storage/src/observation-repo.js';
import { resolveFill, FROZEN_FILL_LATENCY_MS } from '../../packages/domain/src/fill-latency.js';

/**
 * P19 items 14–17 — the later-fill deadlock, and the observation identity.
 *
 * The corpus at `1c499cd` had 169 trajectories in AWAITING_FILL_OBSERVATION for
 * up to 4.6 hours, each with ~96 later observations recorded as "not
 * effect-valid, unpriced", and **not one completed trajectory**. The cause was
 * an ordering, not a threshold:
 *
 *     resolveFill needs an effect-valid candidate
 *       -> the loop simulates nothing
 *       -> blocked
 *       -> the loop simulates something ELSE
 *
 * It asked for a thing it never produced. These tests fix the order in place and
 * fix the identity the old code got wrong: it simulated the current mark and
 * booked an older candidate.
 */

const NOW = 1_760_000_000_000;
const LATER = NOW + FROZEN_FILL_LATENCY_MS + 1_000;

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'p9-'));
  return { dir, db: openDb({ path: join(dir, 'x.db'), skipBackup: true }) };
}

function seedShadow(db: ReturnType<typeof openDb>, id: string): void {
  db.prepare(
    `INSERT INTO shadow_positions
       (shadow_position_id, book, mint, state, notional_lamports, token_amount, cost_lamports,
        peak_value_lamports, opened_utc_ms, strategy_version)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'alpha_shadow', 'MintAAA', 'POSITION_OPEN', '20000000', '1000', '20000000', '20000000', NOW, 'v0.6.0');
}

function seedObservation(
  db: ReturnType<typeof openDb>,
  p: { id: string; family?: string; effectOk?: boolean | null },
): void {
  db.prepare(
    `INSERT INTO execution_observations
       (observation_id, received_utc_ms, requested_utc_ms, family, side, mint, purpose, endpoint,
        input_mint, output_mint, requested_amount, expected_output, minimum_output,
        instruction_set_hash, raw_payload_hash, instruction_policy, transaction_policy, simulation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    p.id,
    LATER,
    LATER,
    p.family ?? 'BUILD_CUSTOM',
    'sell',
    'MintAAA',
    'alpha_shadow_mark',
    'build',
    'MintAAA',
    'So11111111111111111111111111111111111111112',
    '1000',
    '19000000',
    '18000000',
    'ish',
    'rph',
    'PASS',
    'PASS',
    'SIMULATED_OK',
  );
  if (p.effectOk === null || p.effectOk === undefined) return;
  db.prepare(
    `INSERT INTO simulation_jobs
       (job_id, request_hash, execution_observation_id, mode, status, requested_utc_ms, simulated_effect_ok)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(`job-${p.id}`, `rh-${p.id}`, p.id, 'DEVELOPMENT_JIT', 'SIMULATED_OK', LATER, p.effectOk ? 1 : 0);
}

describe('P9 — the deadlock: a candidate must be simulated before it can be chosen', () => {
  it('an unsimulated later observation is never a fill', () => {
    // Exactly the corpus state: marks exist, nothing verified them.
    const { dir, db } = tmpDb();
    try {
      seedShadow(db, 'sp1');
      triggerShadowExit(db, 'sp1', { triggeredUtcMs: NOW, observationId: 'trig', valueLamports: 19n, reason: 'stop' });
      seedObservation(db, { id: 'obsA', effectOk: null });
      insertShadowMark(db, {
        shadowPositionId: 'sp1',
        seq: 0,
        observedUtcMs: LATER,
        observationId: 'obsA',
        executableValueLamports: 19_000_000n,
        routeAvailable: true,
      });
      const out = resolveFill(NOW, 'BUILD_CUSTOM', fillCandidatesSince(db, 'sp1', NOW));
      expect(out.kind).toBe('blocked');
      if (out.kind === 'blocked') expect(out.reason).toMatch(/not effect-valid/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('once simulated and effect-valid, the SAME observation fills', () => {
    // The escape. Nothing changed but the order.
    const { dir, db } = tmpDb();
    try {
      seedShadow(db, 'sp2');
      triggerShadowExit(db, 'sp2', { triggeredUtcMs: NOW, observationId: 'trig', valueLamports: 19n, reason: 'stop' });
      seedObservation(db, { id: 'obsA', effectOk: true });
      insertShadowMark(db, {
        shadowPositionId: 'sp2',
        seq: 0,
        observedUtcMs: LATER,
        observationId: 'obsA',
        executableValueLamports: 19_000_000n,
        routeAvailable: true,
      });
      const out = resolveFill(NOW, 'BUILD_CUSTOM', fillCandidatesSince(db, 'sp2', NOW));
      expect(out.kind).toBe('filled');
      if (out.kind === 'filled') expect(out.at.observationId).toBe('obsA');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P9 — A fails, B is valid, C is better: B is booked', () => {
  it('takes the FIRST valid candidate, not the best one', () => {
    // The directive's exact scenario. C has a better price and must not win:
    // choosing among later observations after seeing them all is look-ahead.
    const { dir, db } = tmpDb();
    try {
      seedShadow(db, 'sp3');
      triggerShadowExit(db, 'sp3', { triggeredUtcMs: NOW, observationId: 'T', valueLamports: 19n, reason: 'stop' });

      seedObservation(db, { id: 'A', effectOk: false });
      seedObservation(db, { id: 'B', effectOk: true });
      seedObservation(db, { id: 'C', effectOk: true });

      insertShadowMark(db, { shadowPositionId: 'sp3', seq: 0, observedUtcMs: LATER, observationId: 'A', executableValueLamports: 10_000_000n, routeAvailable: true });
      insertShadowMark(db, { shadowPositionId: 'sp3', seq: 1, observedUtcMs: LATER + 1_000, observationId: 'B', executableValueLamports: 19_000_000n, routeAvailable: true });
      insertShadowMark(db, { shadowPositionId: 'sp3', seq: 2, observedUtcMs: LATER + 2_000, observationId: 'C', executableValueLamports: 99_000_000n, routeAvailable: true });

      const out = resolveFill(NOW, 'BUILD_CUSTOM', fillCandidatesSince(db, 'sp3', NOW));
      expect(out.kind).toBe('filled');
      if (out.kind === 'filled') {
        expect(out.at.observationId).toBe('B');
        // And explicitly not the one that would have flattered the result.
        expect(out.at.observationId).not.toBe('C');
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the selected candidate can be loaded by its own id, so it can be booked', () => {
    // The other half of the old defect: simulate B, book A. Booking requires
    // loading the SELECTED observation rather than reusing the current mark.
    const { dir, db } = tmpDb();
    try {
      seedObservation(db, { id: 'B', effectOk: true });
      const loaded = observationById(db, 'B');
      expect(loaded?.observationId).toBe('B');
      expect(loaded?.side).toBe('sell');
      expect(loaded?.family).toBe('BUILD_CUSTOM');
      expect(observationById(db, 'does-not-exist')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cross-family candidate is refused even when effect-valid', () => {
    const { dir, db } = tmpDb();
    try {
      seedShadow(db, 'sp4');
      triggerShadowExit(db, 'sp4', { triggeredUtcMs: NOW, observationId: 'T', valueLamports: 1n, reason: 'r' });
      seedObservation(db, { id: 'X', family: 'ORDER_EXECUTE', effectOk: true });
      insertShadowMark(db, { shadowPositionId: 'sp4', seq: 0, observedUtcMs: LATER, observationId: 'X', executableValueLamports: 5n, routeAvailable: true });
      const out = resolveFill(NOW, 'BUILD_CUSTOM', fillCandidatesSince(db, 'sp4', NOW));
      expect(out.kind).toBe('blocked');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P9 — a blocked trajectory stays managed', () => {
  it('keeps its tokens, its trigger and its place in the loop', () => {
    const { dir, db } = tmpDb();
    try {
      seedShadow(db, 'sp5');
      triggerShadowExit(db, 'sp5', { triggeredUtcMs: NOW, observationId: 'T', valueLamports: 9n, reason: 'take_profit' });
      blockShadowExit(db, 'sp5', 'nothing valid yet');
      const row = db.prepare('SELECT * FROM shadow_positions WHERE shadow_position_id = ?').get('sp5') as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe('EXIT_BLOCKED');
      expect(row['token_amount']).toBe('1000');
      expect(row['triggered_utc_ms']).toBe(NOW);
      expect(row['closed_utc_ms']).toBeNull();
      expect(openShadowPositions(db).map((r) => r.shadow_position_id)).toContain('sp5');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
