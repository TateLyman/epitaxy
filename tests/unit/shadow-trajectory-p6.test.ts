import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  triggerShadowExit,
  blockShadowExit,
  resumeShadowExit,
  fillShadowExit,
  fillCandidatesSince,
  insertShadowMark,
  openShadowPositions,
} from '../../packages/storage/src/observation-repo.js';
import {
  assertTransition,
  canTransition,
  holdsExposure,
  IllegalShadowTransition,
} from '../../packages/domain/src/shadow-lifecycle.js';
import { resolveFill, FROZEN_FILL_LATENCY_MS } from '../../packages/domain/src/fill-latency.js';

/**
 * P6 / P24 item 14 — a shadow trigger never closes the position.
 *
 * The state machine forbidding this has existed since it was written. Its
 * transition guard even says so in words. **No production file imported it**,
 * and the shadow loop went from `decideExit` straight to `closeShadowPosition`
 * at the triggering mark's own value — a fill at the price that CAUSED the
 * decision to exit, observed before the decision existed.
 *
 * The machine-generated call graph is what found it: `manageShadowBooks` could
 * not reach `admitPortfolioExit` by any path. Nothing in the source read wrong.
 */

const NOW = 1_760_000_000_000;

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'shadow6-'));
  const db = openDb({ path: join(dir, 'x.db'), skipBackup: true });
  return { dir, db };
}

function seedPosition(db: ReturnType<typeof openDb>, id: string, state = 'POSITION_OPEN'): void {
  db.prepare(
    `INSERT INTO shadow_positions
       (shadow_position_id, book, mint, state, notional_lamports, token_amount, cost_lamports,
        peak_value_lamports, opened_utc_ms, strategy_version)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'alpha_shadow', 'MintAAA', state, '20000000', '1000', '20000000', '20000000', NOW, 'v0.6.0');
}

describe('P6 — the machine refuses the transition the loop used to make', () => {
  it('POSITION_OPEN cannot reach POSITION_CLOSED', () => {
    expect(canTransition('POSITION_OPEN', 'POSITION_CLOSED')).toBe(false);
  });

  it('EXIT_TRIGGERED cannot reach POSITION_CLOSED, and says why', () => {
    expect(() => assertTransition('EXIT_TRIGGERED', 'POSITION_CLOSED')).toThrow(IllegalShadowTransition);
    try {
      assertTransition('EXIT_TRIGGERED', 'POSITION_CLOSED');
    } catch (e) {
      expect((e as Error).message).toMatch(/may not close at its trigger observation/);
    }
  });

  it('EXIT_BLOCKED still holds exposure', () => {
    // The tokens are still held and the rent is still locked. Treating blocked
    // as terminal releases capital into a wallet path that does not exist.
    expect(holdsExposure('EXIT_BLOCKED')).toBe(true);
    expect(holdsExposure('AWAITING_FILL_OBSERVATION')).toBe(true);
    expect(holdsExposure('POSITION_CLOSED')).toBe(false);
  });
});

describe('P6 — the trigger is persisted and the position stays open', () => {
  it('moves to AWAITING_FILL_OBSERVATION and keeps its tokens', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp1');
      triggerShadowExit(db, 'sp1', {
        triggeredUtcMs: NOW,
        observationId: 'obs-trigger',
        valueLamports: 19_000_000n,
        reason: 'stop_loss',
      });
      const row = db.prepare('SELECT * FROM shadow_positions WHERE shadow_position_id = ?').get('sp1') as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe('AWAITING_FILL_OBSERVATION');
      expect(row['closed_utc_ms']).toBeNull();
      expect(row['realized_lamports']).toBeNull();
      // The tokens are STILL HELD. A trigger is a decision, not a disposal.
      expect(row['token_amount']).toBe('1000');
      expect(row['trigger_value_lamports']).toBe('19000000');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a triggered position is still returned as managed', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp2');
      triggerShadowExit(db, 'sp2', { triggeredUtcMs: NOW, observationId: 'o', valueLamports: 1n, reason: 'r' });
      expect(openShadowPositions(db).map((r) => r.shadow_position_id)).toContain('sp2');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not trigger a position that is not open', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp3', 'POSITION_CLOSED');
      triggerShadowExit(db, 'sp3', { triggeredUtcMs: NOW, observationId: 'o', valueLamports: 1n, reason: 'r' });
      const row = db.prepare('SELECT state FROM shadow_positions WHERE shadow_position_id = ?').get('sp3') as {
        state: string;
      };
      expect(row.state).toBe('POSITION_CLOSED');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P6 — the fill is a LATER observation, chosen by rule', () => {
  it('the trigger observation is never its own fill', () => {
    const out = resolveFill(NOW, 'BUILD_CUSTOM', [
      { observationId: 'trigger', observedUtcMs: NOW, family: 'BUILD_CUSTOM', effectValid: true, executableLamports: 5n },
    ]);
    expect(out.kind).toBe('blocked');
  });

  it('an observation inside the frozen latency is not a fill', () => {
    const out = resolveFill(NOW, 'BUILD_CUSTOM', [
      {
        observationId: 'too-soon',
        observedUtcMs: NOW + FROZEN_FILL_LATENCY_MS - 1,
        family: 'BUILD_CUSTOM',
        effectValid: true,
        executableLamports: 5n,
      },
    ]);
    expect(out.kind).toBe('blocked');
  });

  it('takes the FIRST valid later observation, not the best one', () => {
    // Choosing among later observations after seeing them all is look-ahead
    // wearing a different name.
    const out = resolveFill(NOW, 'BUILD_CUSTOM', [
      {
        observationId: 'first',
        observedUtcMs: NOW + 2_000,
        family: 'BUILD_CUSTOM',
        effectValid: true,
        executableLamports: 5n,
      },
      {
        observationId: 'better',
        observedUtcMs: NOW + 9_000,
        family: 'BUILD_CUSTOM',
        effectValid: true,
        executableLamports: 500n,
      },
    ]);
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.at.observationId).toBe('first');
  });

  it('reads candidates out of the marks table, oldest first', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp4');
      insertShadowMark(db, {
        shadowPositionId: 'sp4',
        seq: 0,
        observedUtcMs: NOW + 5_000,
        observationId: 'obs-b',
        executableValueLamports: 7n,
        routeAvailable: true,
      });
      insertShadowMark(db, {
        shadowPositionId: 'sp4',
        seq: 1,
        observedUtcMs: NOW + 2_000,
        observationId: 'obs-a',
        executableValueLamports: 3n,
        routeAvailable: true,
      });
      const got = fillCandidatesSince(db, 'sp4', NOW);
      expect(got.map((c) => c.observationId)).toEqual(['obs-a', 'obs-b']);
      // No simulation job exists for either, so neither is effect-valid — and
      // an unverified observation is not a fill.
      expect(got.every((c) => !c.effectValid)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P6 — blocked is worked, not closed', () => {
  it('counts attempts and keeps the position managed', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp5');
      triggerShadowExit(db, 'sp5', { triggeredUtcMs: NOW, observationId: 'o', valueLamports: 1n, reason: 'r' });
      blockShadowExit(db, 'sp5', 'no later observation yet');
      blockShadowExit(db, 'sp5', 'still nothing');
      const row = db.prepare('SELECT * FROM shadow_positions WHERE shadow_position_id = ?').get('sp5') as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe('EXIT_BLOCKED');
      expect(row['exit_attempts']).toBe(2);
      expect(row['closed_utc_ms']).toBeNull();
      expect(openShadowPositions(db).map((r) => r.shadow_position_id)).toContain('sp5');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes without losing the trigger', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp6');
      triggerShadowExit(db, 'sp6', {
        triggeredUtcMs: NOW,
        observationId: 'obs-t',
        valueLamports: 9n,
        reason: 'take_profit',
      });
      blockShadowExit(db, 'sp6', 'nothing yet');
      resumeShadowExit(db, 'sp6');
      const row = db.prepare('SELECT * FROM shadow_positions WHERE shadow_position_id = ?').get('sp6') as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe('AWAITING_FILL_OBSERVATION');
      expect(row['triggered_utc_ms']).toBe(NOW);
      expect(row['trigger_reason']).toBe('take_profit');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P6 — the close records what the trigger price would have flattered', () => {
  it('stores the fill latency and the look-ahead bias', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp7');
      triggerShadowExit(db, 'sp7', {
        triggeredUtcMs: NOW,
        observationId: 'obs-t',
        valueLamports: 19_000_000n,
        reason: 'stop_loss',
      });
      fillShadowExit(db, 'sp7', {
        realizedLamports: -2_000_000n,
        closedUtcMs: NOW + 3_000,
        exitReason: 'stop_loss',
        diagnostic: 'NONE',
        exitObservationId: 'obs-fill',
        fillLatencyMs: 3_000,
        lookAheadBiasLamports: 1_000_000n,
      });
      const row = db.prepare('SELECT * FROM shadow_positions WHERE shadow_position_id = ?').get('sp7') as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe('POSITION_CLOSED');
      expect(row['fill_latency_ms']).toBe(3_000);
      // The number that says how much the old design was booking for free.
      expect(row['look_ahead_bias_lamports']).toBe('1000000');
      expect(row['exit_observation_id']).toBe('obs-fill');
      expect(row['token_amount']).toBe('0');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cannot close a position that was never triggered', () => {
    const { dir, db } = tmpDb();
    try {
      seedPosition(db, 'sp8');
      fillShadowExit(db, 'sp8', {
        realizedLamports: 1n,
        closedUtcMs: NOW,
        exitReason: 'x',
        diagnostic: 'NONE',
        exitObservationId: 'o',
        fillLatencyMs: 1,
        lookAheadBiasLamports: null,
      });
      const row = db.prepare('SELECT state FROM shadow_positions WHERE shadow_position_id = ?').get('sp8') as {
        state: string;
      };
      expect(row.state).toBe('POSITION_OPEN');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P5 — the call graph is generated, and the required edges hold', () => {
  const GRAPH = 'artifacts/production-call-graph.json';

  it.skipIf(!existsSync(GRAPH))('every required edge is reachable', () => {
    const g = JSON.parse(readFileSync(GRAPH, 'utf8')) as {
      required: { from: string; to: string; reached: boolean }[];
      missing: string[];
    };
    expect(g.missing).toEqual([]);
    expect(g.required.every((r) => r.reached)).toBe(true);
  });

  it.skipIf(!existsSync(GRAPH))('the shadow loop reaches the same exit admission as the portfolio', () => {
    // The edge that did not exist before P6, and the reason the shadow book was
    // measuring a different strategy from the one it was shadowing.
    const g = JSON.parse(readFileSync(GRAPH, 'utf8')) as {
      required: { from: string; to: string; reached: boolean }[];
    };
    const edge = g.required.find((r) => r.from === 'manageShadowBooks' && r.to === 'admitPortfolioExit');
    expect(edge?.reached).toBe(true);
  });

  it.skipIf(!existsSync(GRAPH))('no lifecycle function is declared in the process shell', () => {
    const g = JSON.parse(readFileSync(GRAPH, 'utf8')) as { lifecycleStillInShell: number };
    expect(g.lifecycleStillInShell).toBe(0);
  });
});
