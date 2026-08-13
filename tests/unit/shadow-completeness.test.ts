import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';

/**
 * §12.2 — the database refuses a duplicate book/episode pair.
 *
 * P8: everything else that was in this file read `apps/engine/src/paper.ts` as
 * a string and asserted on substrings. Those were behavioural claims made
 * structurally, and a claim made that way passes against an implementation that
 * contains the phrase and the defect. They are gone; the behaviour is executed
 * in tests/unit/paper-core.test.ts.
 *
 * What survives is a fact about the SCHEMA, and it is now read from a real
 * database rather than from the source that is supposed to create one. If the
 * migration were ever reordered or silently skipped, a source-string check
 * would still pass and this will not.
 */

describe('§12.2 dedup does not depend on the engine getting it right', () => {
  it('the unique index exists in a freshly migrated database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
    try {
      const db = openDb({ path: join(dir, 'test.db'), skipBackup: true });
      const idx = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_shadow_episode'")
        .get() as { sql: string } | undefined;
      expect(idx, 'the unique index must exist, not merely be written in a migration string').toBeDefined();
      expect(idx?.sql).toContain('shadow_positions');
      expect(idx?.sql).toContain('book');
      expect(idx?.sql).toContain('signal_episode_id');

      // And it actually refuses. An index nobody has inserted through twice is
      // an index nobody has tested.
      let seq = 0;
      const insert = (book: string, episode: string): void => {
        db.prepare(
          `INSERT INTO shadow_positions
             (shadow_position_id,book,mint,state,notional_lamports,token_amount,cost_lamports,
              realized_lamports,opened_utc_ms,strategy_version,signal_episode_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          `${book}-${episode}-${seq++}`,
          book,
          'Mint1',
          'POSITION_OPEN',
          '20000000',
          '1',
          '1',
          '0',
          1,
          'v1',
          episode,
        );
      };
      insert('alpha_shadow', 'ep-1');
      expect(() => insert('alpha_shadow', 'ep-1')).toThrow();
      // A different book on the same episode is exactly what the design wants.
      expect(() => insert('canary_shadow', 'ep-1')).not.toThrow();
      db.close();
    } finally {
      // Windows holds SQLite's -wal and -shm open briefly after close, so
      // removing the directory races and EPERMs. A leftover temp directory is
      // harmless; failing here would be noise about the harness, not the code.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS will reclaim it */
      }
    }
  });
});
