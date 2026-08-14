import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../packages/storage/src/db.js';
import {
  claimSignalEpisode,
  closeSignalEpisode,
  EPISODE_COOLDOWN_MS,
} from '../../packages/storage/src/observation-repo.js';

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'ep-'));
  const d = openDb({ path: join(dir, 'x.db') });
  migrate(d);
  return { d, dir };
}

/** 2026-08-13T14:59:00Z and 14:01, 15:01 — real wall-clock instants. */
const AT_1401 = Date.UTC(2026, 7, 13, 14, 1, 0);
const AT_1459 = Date.UTC(2026, 7, 13, 14, 59, 0);
const AT_1501 = Date.UTC(2026, 7, 13, 15, 1, 0);

describe('P11 — an episode is durable state, not a wall-clock bucket', () => {
  it('treats 14:59 and 15:01 as ONE episode', () => {
    // THE defect. `floor(now / 15 minutes)` puts these two minutes apart in
    // different buckets, so the second opened a second position on the same
    // signal. Which side of the boundary a signal falls on has no relationship
    // to whether it is the same trade.
    const { d, dir } = db();
    try {
      const a = claimSignalEpisode(d, 'MintA', 'primary', AT_1459, null);
      const b = claimSignalEpisode(d, 'MintA', 'primary', AT_1501, null);
      expect(a.isNew).toBe(true);
      expect(b.isNew).toBe(false);
      expect(b.signalEpisodeId).toBe(a.signalEpisodeId);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not merge 14:01 and 14:59 merely because they shared a bucket', () => {
    // The same defect in the other direction: fifty-eight minutes apart, one
    // bucket, and the second screening was refused as a duplicate. Here the
    // first episode is CLOSED, so the cooldown decides — and it has elapsed.
    const { d, dir } = db();
    try {
      const a = claimSignalEpisode(d, 'MintA', 'primary', AT_1401, null);
      closeSignalEpisode(d, a.signalEpisodeId, AT_1401 + 60_000);
      const b = claimSignalEpisode(d, 'MintA', 'primary', AT_1459, null);
      expect(b.isNew).toBe(true);
      expect(b.signalEpisodeId).not.toBe(a.signalEpisodeId);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an OPEN episode as one episode however long it runs', () => {
    const { d, dir } = db();
    try {
      const a = claimSignalEpisode(d, 'MintA', 'primary', AT_1401, null);
      // Hours later, still open: still the same trade.
      const b = claimSignalEpisode(d, 'MintA', 'primary', AT_1401 + 6 * 3_600_000, null);
      expect(b.isNew).toBe(false);
      expect(b.signalEpisodeId).toBe(a.signalEpisodeId);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the cooldown after a close before a new episode starts', () => {
    const { d, dir } = db();
    try {
      const a = claimSignalEpisode(d, 'MintA', 'primary', AT_1401, null);
      closeSignalEpisode(d, a.signalEpisodeId, AT_1401 + 1_000);
      // One second short of the cooldown: still the same episode.
      const tooSoon = claimSignalEpisode(d, 'MintA', 'primary', AT_1401 + EPISODE_COOLDOWN_MS - 1_000, null);
      expect(tooSoon.isNew).toBe(false);

      // That rescreen EXTENDS the cooldown, because the cooldown runs from
      // last seen rather than from the close. A mint that keeps signalling is
      // one episode for as long as it keeps signalling — the quiet period is
      // what separates two trades, not the elapsed time since a close.
      const stillSame = claimSignalEpisode(d, 'MintA', 'primary', AT_1401 + EPISODE_COOLDOWN_MS + 1_000, null);
      expect(stillSame.isNew).toBe(false);

      // A genuine gap does start a new one.
      const later = claimSignalEpisode(d, 'MintA', 'primary', AT_1401 + 3 * EPISODE_COOLDOWN_MS, null);
      expect(later.isNew).toBe(true);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent across a restart, because it reads the row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-'));
    const path = join(dir, 'x.db');
    try {
      const d1 = openDb({ path });
      migrate(d1);
      const a = claimSignalEpisode(d1, 'MintA', 'primary', AT_1459, null);
      d1.close();

      // A crash here. The claim must not be re-granted on the way back up.
      const d2 = openDb({ path });
      const b = claimSignalEpisode(d2, 'MintA', 'primary', AT_1501, null);
      expect(b.isNew).toBe(false);
      expect(b.signalEpisodeId).toBe(a.signalEpisodeId);
      d2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two books independent', () => {
    const { d, dir } = db();
    try {
      const a = claimSignalEpisode(d, 'MintA', 'primary', AT_1459, null);
      const b = claimSignalEpisode(d, 'MintA', 'challenger', AT_1459, null);
      expect(b.isNew).toBe(true);
      expect(b.signalEpisodeId).not.toBe(a.signalEpisodeId);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
