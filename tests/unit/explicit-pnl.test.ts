import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../packages/storage/src/db.js';
import { insertPosition, updatePosition } from '../../packages/storage/src/repo.js';
import type { Position } from '../../packages/domain/src/types.js';

/**
 * P9 — the explicit economics, against a real SQLite database.
 *
 * Migration 22 added three columns and no writer populated them. A test that
 * asserted the columns EXIST would have passed throughout. These assert the
 * values arrive.
 */
function db() {
  const dir = mkdtempSync(join(tmpdir(), 'pnl-'));
  const d = openDb({ path: join(dir, 'x.db') });
  migrate(d);
  return { d, dir };
}

const BASE: Position = {
  positionId: 'p1',
  mint: 'MintA',
  state: 'POSITION_OPEN',
  tokenAmount: 16_227_715_590n,
  costLamports: 24_087_331n,
  realizedLamports: 0n,
  openedUtcMs: 1,
  closedUtcMs: null,
  strategyVersion: 'v1',
  simulated: true,
};

describe('P9 — production writes the explicit PnL fields', () => {
  it('writes the entry economics at open, and NULL for what is undetermined', () => {
    const { d, dir } = db();
    try {
      insertPosition(d, {
        ...BASE,
        executionCostLamports: 24_087_331n,
        entryCashOutLamports: 24_087_331n,
        lockedRentLamports: 4_078_560n,
        grossProceedsLamports: null,
        netPnlLamports: null,
        exitCashInLamports: null,
        residualTokenAtoms: null,
      });
      const r = d
        .prepare(
          `SELECT execution_cost_lamports c, entry_cash_out_lamports eo, locked_rent_lamports lr,
                  exit_cash_in_lamports ei, net_pnl_lamports np, residual_token_atoms ra
           FROM positions WHERE position_id='p1'`,
        )
        .get() as Record<string, string | null>;

      expect(r.c).toBe('24087331');
      expect(r.eo).toBe('24087331');
      expect(r.lr).toBe('4078560');
      // Undetermined, not zero. An open position has realised no exit.
      expect(r.ei).toBeNull();
      expect(r.np).toBeNull();
      expect(r.ra).toBeNull();
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles the identity at close: net = cash in - cash out', () => {
    const { d, dir } = db();
    try {
      insertPosition(d, { ...BASE, executionCostLamports: 24_087_331n, entryCashOutLamports: 24_087_331n });
      updatePosition(d, 'p1', {
        state: 'POSITION_CLOSED',
        closedUtcMs: 2,
        executionCostLamports: 24_087_331n,
        entryCashOutLamports: 24_087_331n,
        exitCashInLamports: 15_202_728n,
        grossProceedsLamports: 15_202_728n,
        netPnlLamports: 15_202_728n - 24_087_331n,
        lockedRentLamports: 4_078_560n,
        residualTokenAtoms: 0n,
      });
      const r = d
        .prepare(
          `SELECT entry_cash_out_lamports eo, exit_cash_in_lamports ei, net_pnl_lamports np,
                  locked_rent_lamports lr, residual_token_atoms ra
           FROM positions WHERE position_id='p1'`,
        )
        .get() as { eo: string; ei: string; np: string; lr: string; ra: string };

      // The invariant is checkable from the row itself rather than trusted.
      expect(BigInt(r.np)).toBe(BigInt(r.ei) - BigInt(r.eo));
      expect(r.np).toBe('-8884603');
      // Rent is identified SEPARATELY. Netting it into either side is how a
      // 363 bps round trip reads as 3,688.
      expect(r.lr).toBe('4078560');
      // Zero here is a measurement: the exit sold the whole balance.
      expect(r.ra).toBe('0');
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes an unobserved residual from a residual of zero', () => {
    const { d, dir } = db();
    try {
      insertPosition(d, { ...BASE, positionId: 'p2' });
      // No residual supplied: the column stays NULL rather than becoming 0.
      updatePosition(d, 'p2', { state: 'POSITION_CLOSED', netPnlLamports: -1n });
      const r = d
        .prepare("SELECT residual_token_atoms ra, net_pnl_lamports np FROM positions WHERE position_id='p2'")
        .get() as Record<string, string | null>;
      expect(r.ra).toBeNull();
      expect(r.np).toBe('-1');
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
