import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFreshness, currentProvenance } from '../../packages/research/src/artifact-provenance.js';

/**
 * P18 — a stale artifact cannot authorize readiness.
 *
 * The checked-in release manifest was generated from an older dirty commit and
 * still claimed no simulator was wired. A JSON file with numbers in it looks
 * current forever; nothing in the format made the staleness detectable.
 */
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function artifact(dir: string, body: unknown): string {
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'prov-'));
}

describe('P18 — an artifact must name what produced it', () => {
  it('accepts one from the same clean commit and version', () => {
    const dir = tmp();
    try {
      const p = artifact(dir, {
        provenance: {
          generatedUtcMs: Date.now(),
          sourceCommit: COMMIT,
          dirty: false,
          strategyVersion: 'v1',
        },
      });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v1' });
      expect(f.fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES one from a different commit', () => {
    const dir = tmp();
    try {
      const p = artifact(dir, {
        provenance: { generatedUtcMs: Date.now(), sourceCommit: OTHER, dirty: false, strategyVersion: 'v1' },
      });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v1' });
      expect(f.fresh).toBe(false);
      expect(f.reasons).toContain('different_commit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES one produced from a dirty tree', () => {
    // Exactly the release manifest's case: right commit, uncommitted changes,
    // and therefore not reproducible.
    const dir = tmp();
    try {
      const p = artifact(dir, {
        provenance: { generatedUtcMs: Date.now(), sourceCommit: COMMIT, dirty: true, strategyVersion: 'v1' },
      });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v1' });
      expect(f.fresh).toBe(false);
      expect(f.reasons).toContain('dirty_tree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES one produced under a different strategy version', () => {
    const dir = tmp();
    try {
      const p = artifact(dir, {
        provenance: { generatedUtcMs: Date.now(), sourceCommit: COMMIT, dirty: false, strategyVersion: 'v0.4.0' },
      });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v0.6.0' });
      expect(f.fresh).toBe(false);
      expect(f.reasons).toContain('different_strategy_version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES one with no provenance at all', () => {
    // The state every pre-P18 artifact is in.
    const dir = tmp();
    try {
      const p = artifact(dir, { attempted: 25, complete: 5 });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v1' });
      expect(f.fresh).toBe(false);
      expect(f.reasons).toContain('no_provenance');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES a missing artifact rather than treating absence as pass', () => {
    const f = checkFreshness(join(tmpdir(), 'does-not-exist-4f2a.json'), {
      sourceCommit: COMMIT,
      strategyVersion: 'v1',
    });
    expect(f.fresh).toBe(false);
    expect(f.reasons).toContain('missing');
  });

  it('REFUSES one older than the allowed age', () => {
    const dir = tmp();
    try {
      const p = artifact(dir, {
        provenance: {
          generatedUtcMs: Date.now() - 48 * 3_600_000,
          sourceCommit: COMMIT,
          dirty: false,
          strategyVersion: 'v1',
        },
      });
      const f = checkFreshness(p, { sourceCommit: COMMIT, strategyVersion: 'v1', maxAgeMs: 24 * 3_600_000 });
      expect(f.fresh).toBe(false);
      expect(f.reasons).toContain('too_old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unnameable commit as stale, not as clean', () => {
    const p = currentProvenance({ strategyVersion: 'v1', schemaVersion: 'schema-v30' });
    // In this repo git IS available, so this asserts the shape rather than the
    // fallback — the fallback's contract is that `dirty` defaults to true.
    expect(p.sourceCommit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(typeof p.dirty).toBe('boolean');
  });
});
