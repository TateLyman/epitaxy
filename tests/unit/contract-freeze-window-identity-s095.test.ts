import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';

/**
 * S095 — two windows over identical content must mint DIFFERENT contracts.
 *
 * `contractId` is `contract-${sha256(body).slice(0,16)}`. Until `windowId` was
 * added to `body`, the hash covered only what the experiment measures, never
 * which window it ran in — so two `contract:freeze --apply` calls at the SAME
 * commit with DIFFERENT `--window=` values produced the IDENTICAL contract id.
 * The second call hit `ON CONFLICT(contract_id) DO NOTHING`, printed FROZEN,
 * and silently kept the first call's context and window_id.
 *
 * Measured 2026-08-18: this happened for real. A window was frozen, collected
 * under, and then demoted for operator-induced mark staleness. Re-freezing with
 * `--window=DEV_WINDOW_5D24E_R2` to get a clean context reported success while
 * leaving the row bound to the DEMOTED window — starting a collector on that
 * "fresh" contract would have written new evidence into an invalidated context.
 *
 * This spawns the real script twice against a real temporary database, because
 * the defect is in what gets hashed and what a second INSERT does under
 * ON CONFLICT — a mock of either would not have caught it.
 */
describe('S095 — a window identifies the contract it freezes', () => {
  it('freezing the same commit under two window names produces two contracts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freeze-s095-'));
    const dbPath = join(dir, 'test.db');
    try {
      // Migrate a fresh database at this path.
      openDb({ path: dbPath, skipBackup: true }).close();

      const env = { ...process.env, DATABASE_PATH: dbPath };
      // --instrument-development, because this test must run in CI and locally
      // against whatever tree state happens to exist — the defect under test
      // is about the CONTRACT ID, not about dirty-tree refusal (that is P1.3's
      // own test).
      const runFreeze = (windowArg: string): string =>
        execFileSync(
          'npx',
          ['tsx', 'scripts/contract-freeze.ts', '--apply', '--instrument-development', windowArg],
          {
            encoding: 'utf8',
            env,
            timeout: 60_000,
            shell: process.platform === 'win32',
          },
        );

      const out1 = runFreeze('--window=DEV_WINDOW_A');
      const out2 = runFreeze('--window=DEV_WINDOW_B');
      expect(out1).toMatch(/FROZEN/);
      expect(out2).toMatch(/FROZEN/);

      const db = openDb({ path: dbPath, skipBackup: true, readonly: true } as never);
      const rows = db
        .prepare('SELECT contract_id, evidence_context_id, window_id FROM experiment_contracts ORDER BY frozen_utc_ms')
        .all() as { contract_id: string; evidence_context_id: string; window_id: string | null }[];
      db.close();

      expect(rows.length).toBe(2);
      // The whole point: two DIFFERENT contract ids, not one row silently kept.
      expect(rows[0]?.contract_id).not.toBe(rows[1]?.contract_id);
      expect(rows[0]?.window_id).toBe('DEV_WINDOW_A');
      expect(rows[1]?.window_id).toBe('DEV_WINDOW_B');
      expect(rows[0]?.evidence_context_id).not.toBe(rows[1]?.evidence_context_id);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });
});
