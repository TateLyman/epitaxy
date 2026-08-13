import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import {
  claimSignalEpisode,
  bindEpisode,
  episodeStats,
  openShadowPosition,
  EPISODE_COOLDOWN_MS,
} from '../../packages/storage/src/observation-repo.js';

/**
 * §9.2 — one signal is one episode.
 *
 * Discovery rescreens the same mint every cycle. Each rescreen used to open its
 * own shadow position, so a token eligible for ten minutes became dozens of
 * "trades" that were the same trade observed repeatedly. Any statistic over
 * that corpus counts one opinion many times and understates its own standard
 * error — which is the failure mode a shadow book exists to remove, not create.
 */

const dir = mkdtempSync(join(tmpdir(), 'episode-'));
let db: Db;
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

beforeEach(() => {
  db = openDb({ path: join(dir, `e${++n}.db`), skipBackup: true });
});

const T0 = Date.UTC(2026, 7, 13, 12, 0, 0);
const MINT = 'MintAAA';

describe('a rescreen is the same episode', () => {
  it('the first claim is new', () => {
    expect(claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx').isNew).toBe(true);
  });

  it('a claim thirty seconds later is NOT new', () => {
    claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    const again = claimSignalEpisode(db, MINT, 'alpha_shadow', T0 + 30_000, 'ctx');
    expect(again.isNew).toBe(false);
  });

  it('every rescreen inside the window returns the SAME episode id', () => {
    const first = claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    for (const offset of [10_000, 60_000, 300_000]) {
      const c = claimSignalEpisode(db, MINT, 'alpha_shadow', T0 + offset, 'ctx');
      expect(c.isNew).toBe(false);
      expect(c.signalEpisodeId).toBe(first.signalEpisodeId);
    }
  });

  it('counts the rescreens it absorbed, so the defect size is measured', () => {
    claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    for (let i = 1; i <= 20; i++) claimSignalEpisode(db, MINT, 'alpha_shadow', T0 + i * 10_000, 'ctx');
    const s = episodeStats(db);
    expect(s.episodes).toBe(1);
    // 20 positions that would have been opened, and were not.
    expect(s.rescreensAbsorbed).toBe(20);
    expect(s.maxScreeningsPerEpisode).toBe(21);
  });
});

describe('a genuinely new opportunity is a new episode', () => {
  it('after the cooldown, the same mint is claimable again', () => {
    const first = claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    const later = claimSignalEpisode(db, MINT, 'alpha_shadow', T0 + EPISODE_COOLDOWN_MS * 2, 'ctx');
    expect(later.isNew).toBe(true);
    expect(later.signalEpisodeId).not.toBe(first.signalEpisodeId);
  });

  it('the two books claim independently', () => {
    expect(claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx').isNew).toBe(true);
    // canary_shadow has its own notional and its own book; a signal entering
    // one must not consume the other's claim.
    expect(claimSignalEpisode(db, MINT, 'canary_shadow', T0, 'ctx').isNew).toBe(true);
  });

  it('different mints never collide', () => {
    expect(claimSignalEpisode(db, 'MintAAA', 'alpha_shadow', T0, 'ctx').isNew).toBe(true);
    expect(claimSignalEpisode(db, 'MintBBB', 'alpha_shadow', T0, 'ctx').isNew).toBe(true);
  });
});

describe('the claim is idempotent across a restart', () => {
  it('the same rescreen after a crash lands in the same bucket and is still refused', () => {
    const path = join(dir, `restart${++n}.db`);
    const a = openDb({ path, skipBackup: true });
    const first = claimSignalEpisode(a, MINT, 'alpha_shadow', T0, 'ctx');
    a.close();

    // A different connection is the restart. The bucket is derived from wall
    // time rather than from stored state, so it survives the process.
    const b = openDb({ path, skipBackup: true });
    const again = claimSignalEpisode(b, MINT, 'alpha_shadow', T0 + 5_000, 'ctx');
    expect(again.isNew).toBe(false);
    expect(again.signalEpisodeId).toBe(first.signalEpisodeId);
    b.close();
  });
});

describe('the database refuses a duplicate even if the code tries', () => {
  /**
   * The claim check is the defence; this is the backstop. A future caller that
   * forgets to check `isNew` must fail loudly rather than quietly producing two
   * positions for one signal — the previous defence was that nobody had written
   * the code to duplicate, which is not a defence.
   */
  it('two shadow positions cannot share one episode in one book', () => {
    const episode = claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    const base = {
      book: 'alpha_shadow' as const,
      mint: MINT,
      state: 'POSITION_OPEN',
      notionalLamports: 20_000_000n,
      tokenAmount: 1_000n,
      costLamports: 20_500_000n,
      entryObservationId: null,
      openedUtcMs: T0,
      portfolioRefusal: 'size_below_viable',
      strategyVersion: 'v-test',
      contextHash: 'ctx',
    };
    const one = openShadowPosition(db, base);
    bindEpisode(db, one, episode.signalEpisodeId, 'obs-sell', 120);

    const two = openShadowPosition(db, base);
    expect(() => bindEpisode(db, two, episode.signalEpisodeId, 'obs-sell', 120)).toThrow();
  });

  it('the same episode id in a DIFFERENT book is fine', () => {
    const alpha = claimSignalEpisode(db, MINT, 'alpha_shadow', T0, 'ctx');
    const canary = claimSignalEpisode(db, MINT, 'canary_shadow', T0, 'ctx');
    const mk = (book: 'alpha_shadow' | 'canary_shadow') =>
      openShadowPosition(db, {
        book,
        mint: MINT,
        state: 'POSITION_OPEN',
        notionalLamports: 20_000_000n,
        tokenAmount: 1_000n,
        costLamports: 20_500_000n,
        entryObservationId: null,
        openedUtcMs: T0,
        portfolioRefusal: null,
        strategyVersion: 'v-test',
        contextHash: 'ctx',
      });
    bindEpisode(db, mk('alpha_shadow'), alpha.signalEpisodeId, null, null);
    expect(() => bindEpisode(db, mk('canary_shadow'), canary.signalEpisodeId, null, null)).not.toThrow();
  });
});
