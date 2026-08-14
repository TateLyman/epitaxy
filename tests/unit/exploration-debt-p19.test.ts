import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { allocate } from '../../packages/strategy/src/exploration.js';

/**
 * P19 item 22 — exploration debt persists across production cycles.
 *
 * `allocate()` has accepted a carried remainder and returned the next one since
 * it was written. `runCycle()` passed neither, so every cycle recomputed the
 * entitlement from zero — and with a budget of 2, `floor(2 * 0.25)` is 0. The
 * exploration arm the design calls 25% ran exactly never, on any cycle, ever.
 *
 * The allocator was never the problem. The state was.
 */

const CANDIDATES = Array.from({ length: 12 }, (_, i) => ({
  item: `c${i}`,
  stratum: i % 2 === 0 ? 'AGE_2M_60M' : 'AGE_1H_5H',
  rank: 100 - i,
}));

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'debt-'));
  return { dir, db: openDb({ path: join(dir, 'x.db'), skipBackup: true }) };
}

describe('P19 item 22 — the entitlement survives the cycle', () => {
  it('a two-quote budget explores nothing on one cycle, which is the defect', () => {
    const a = allocate(CANDIDATES, 2, 1234, 0);
    expect(a.filter((x) => x.arm === 'explore').length).toBe(0);
  });

  it('and explores once the carried remainder reaches a whole slot', () => {
    // Four cycles of two quotes at 25% is one exploration slot between them.
    let debt = 0;
    let explored = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      const a = allocate(CANDIDATES, 2, 1234 + cycle, debt);
      explored += a.filter((x) => x.arm === 'explore').length;
      debt = (a as { nextDebt?: number }).nextDebt ?? 0;
    }
    expect(explored).toBeGreaterThan(0);
  });

  it('the remainder round-trips through the database', () => {
    // The whole finding: a debt that is not persisted is not a debt.
    const { dir, db } = tmpDb();
    try {
      const write = (v: number): void => {
        db.prepare(
          `INSERT INTO exploration_debt (strategy_version, stratum, debt, updated_utc_ms)
           VALUES (?,?,?,?)
           ON CONFLICT(strategy_version, stratum) DO UPDATE SET debt = excluded.debt`,
        ).run('v0.6.0', 'ALL', v, Date.now());
      };
      const read = (): number =>
        (
          db
            .prepare('SELECT debt FROM exploration_debt WHERE strategy_version = ? AND stratum = ?')
            .get('v0.6.0', 'ALL') as { debt: number } | undefined
        )?.debt ?? 0;

      expect(read()).toBe(0);
      write(0.5);
      expect(read()).toBe(0.5);
      write(0.75);
      expect(read()).toBe(0.75);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is keyed by strategy version, so an entitlement does not cross scorers', () => {
    // An entitlement earned under one scorer is not owed under another.
    const { dir, db } = tmpDb();
    try {
      const put = (version: string, v: number): void => {
        db.prepare(
          `INSERT INTO exploration_debt (strategy_version, stratum, debt, updated_utc_ms) VALUES (?,?,?,?)`,
        ).run(version, 'ALL', v, Date.now());
      };
      put('v0.6.0', 0.75);
      put('v0.7.0', 0.0);
      const rows = db.prepare('SELECT strategy_version, debt FROM exploration_debt ORDER BY 1').all() as {
        strategy_version: string;
        debt: number;
      }[];
      expect(rows).toEqual([
        { strategy_version: 'v0.6.0', debt: 0.75 },
        { strategy_version: 'v0.7.0', debt: 0 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never lets the debt buy more than the budget', () => {
    // A carried remainder accelerates exploration; it must not overrun the
    // cycle's own quote budget.
    const a = allocate(CANDIDATES, 2, 99, 10);
    expect(a.length).toBeLessThanOrEqual(2);
  });
});
