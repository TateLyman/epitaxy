import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGates, liveEvidenceGates, canaryEvidenceGates } from '../../packages/execution/src/gates.js';
import { AppConfigSchema } from '../../packages/domain/src/config.js';
import { openDb } from '../../packages/storage/src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * P23/P24 items 47 and 48 — the executor stays downstream.
 *
 * The directive is explicit that this phase does not optimise broadcasters, and
 * that the executor may use the shared builder, policy decoder, settlement and
 * state machine only AFTER `CANARY_READY`. What has to hold now is weaker and
 * more important: the executor must not be able to start a strategy loop of its
 * own, and live must stay blocked on evidence rather than on intent.
 *
 * Both are asserted against what the code can DO, not against a comment saying
 * it will not.
 */

const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'exec-'));
  return { dir, db: openDb({ path: join(dir, 'x.db'), skipBackup: true }) };
}

describe('P24 item 47 — the executor cannot start a strategy loop', () => {
  it('imports no discovery or screening cycle', () => {
    // A strategy loop needs candidates. The executor has no path to them, and
    // that is a structural fact rather than a policy: it cannot decide what to
    // buy because it cannot see anything to buy.
    const sources = readdirSync('apps/executor/src').map((f) => readFileSync(join('apps/executor/src', f), 'utf8'));
    const joined = sources.join('\n');
    expect(joined).not.toMatch(/from '.*pipeline\/src\/cycle\.js'/);
    expect(joined).not.toMatch(/runCycle\s*\(/);
    expect(joined).not.toMatch(/from '.*strategy\/src\/screen\.js'/);
  });

  it('has no entry-admission path at all', () => {
    const sources = readdirSync('apps/executor/src').map((f) => readFileSync(join('apps/executor/src', f), 'utf8'));
    const joined = sources.join('\n');
    expect(joined).not.toMatch(/admitPortfolioEntry/);
    expect(joined).not.toMatch(/onEligible/);
  });
});

describe('P24 item 48 — live stays blocked until real canary evidence', () => {
  it('refuses live on an empty corpus', () => {
    const { dir, db } = tmpDb();
    try {
      const gates = liveEvidenceGates(db);
      expect(gates.length).toBeGreaterThan(0);
      expect(gates.every((g) => g.passed)).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses live even when the canary evidence gates are the only ones consulted', () => {
    // The distinction that matters: canary evidence is about PAPER results and
    // live evidence is about REAL canary fills. Passing the first has never
    // been sufficient for the second and must not become so.
    const { dir, db } = tmpDb();
    try {
      const live = liveEvidenceGates(db);
      const canary = canaryEvidenceGates(db, paper);
      expect(live.map((g) => g.name)).not.toEqual(canary.map((g) => g.name));
      expect(live.some((g) => !g.passed)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('paper mode itself produces no gate that would authorise spending', () => {
    const { dir, db } = tmpDb();
    try {
      const gates = evaluateGates('paper', paper, { paperTakerPubkey: null } as never, db);
      // Whatever paper reports, it is not a live authorisation.
      expect(gates.every((g) => g.name !== 'live_acknowledgement')).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
