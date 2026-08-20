import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../packages/storage/src/db.js';

/**
 * Every migration must apply, in order, to an empty database.
 *
 * This exists because migration 59 did not, and nothing in the suite noticed.
 * Its SQL is a template literal and its comments contained backticks — around
 * `user` and `venue_stream_sessions` — which terminated the literal early. The
 * typechecker caught the resulting syntax error and `pnpm db:migrate` refused to
 * run, which is the system working. But the failure surfaced as four TS1005
 * errors about a missing comma, ten thousand lines away from a schema change,
 * and nothing said "migration 59 is malformed".
 *
 * The corpus is 9.4GB and is not reproducible, and every migration takes a full
 * backup before it runs. Discovering a broken migration AFTER that backup costs
 * fifteen minutes; discovering it here costs milliseconds.
 *
 * In-memory, so it touches nothing real.
 */
describe('the migration set', () => {
  it('applies cleanly, in order, to an empty database', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const m of MIGRATIONS) {
        expect(() => db.exec(m.sql), `migration ${m.id} (${m.name}) failed to apply`).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('has contiguous ids starting at 1, so an applied set cannot silently skip one', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
  });

  it('has a distinct name per id, because a duplicate name makes a failure unattributable', () => {
    const names = new Set(MIGRATIONS.map((m) => m.name));
    expect(names.size).toBe(MIGRATIONS.length);
  });

  it('produces the tables the venue tape and the watchlist arms depend on', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const m of MIGRATIONS) db.exec(m.sql);
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      for (const t of [
        'flagged_wallets',
        'wallet_flow_events',
        'wallet_signals',
        'venue_trades',
        'venue_stream_sessions',
        'venue_pools',
        'observation_watch',
      ]) {
        expect(tables.has(t), `${t} is missing after applying every migration`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('keys flagged_wallets on the experiment AND the wallet, not the wallet alone', () => {
    /**
     * Migration 56 made `address` the primary key. MT101's top-128 are by
     * construction inside MT104's decile 1, so loading the second watchlist
     * failed on the key. Two experiments following one address are two facts,
     * and collapsing them would mean either refusing the second experiment or
     * silently overwriting a FROZEN watchlist.
     */
    const db = new DatabaseSync(':memory:');
    try {
      for (const m of MIGRATIONS) db.exec(m.sql);
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='flagged_wallets'")
        .get() as { sql: string };
      expect(row.sql).toContain('PRIMARY KEY (ledger_row, address)');
    } finally {
      db.close();
    }
  });
});
