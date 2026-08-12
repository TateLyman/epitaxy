import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HALT_MODES,
  haltState,
  entriesAllowed,
  exitManagementActive,
  mayTerminate,
} from '../../packages/domain/src/halt.js';

/**
 * P2a.1 §P2.3 — a halt must not abandon an open position.
 *
 * The previous behaviour was a single mode: the engine saw a KILL file, broke
 * out of its loop, released the lock and exited. Any open position was left
 * with nobody marking it or working it out — at exactly the moment a human had
 * decided something was wrong.
 */

const dir = mkdtempSync(join(tmpdir(), 'halt-'));
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

function file(body: string): string {
  const p = join(dir, `KILL${++n}`);
  writeFileSync(p, body);
  return p;
}

describe('reading the halt file', () => {
  it('is null when no halt file exists', () => {
    expect(haltState([join(dir, 'definitely-absent')])).toBeNull();
  });

  it('a bare file defaults to TERMINATE_WHEN_FLAT, the mode that cannot orphan money', () => {
    const h = haltState([file('')])!;
    expect(h.mode).toBe('TERMINATE_WHEN_FLAT');
    expect(h.defaulted).toBe(true);
  });

  it('an unrecognised label defaults, and reports what it saw', () => {
    const h = haltState([file('STOP EVERYTHING NOW')])!;
    expect(h.mode).toBe('TERMINATE_WHEN_FLAT');
    expect(h.defaulted).toBe(true);
    expect(h.rawLabel).toBe('STOP EVERYTHING NOW');
  });

  for (const mode of HALT_MODES) {
    it(`reads ${mode}`, () => {
      const h = haltState([file(mode)])!;
      expect(h.mode).toBe(mode);
      expect(h.defaulted).toBe(false);
    });
  }

  it('is case-insensitive and tolerates whitespace', () => {
    expect(haltState([file('  exit_only  \n')])!.mode).toBe('EXIT_ONLY');
  });

  it('skips comments and blank lines', () => {
    expect(haltState([file('# stopping for maintenance\n\nEXIT_ONLY\n')])!.mode).toBe('EXIT_ONLY');
  });

  it('takes the first matching path when several are configured', () => {
    const a = file('EXIT_ONLY');
    const b = file('HALT_NEW_ENTRIES');
    expect(haltState([a, b])!.path).toBe(a);
  });

  it('bounds the label, so a huge file cannot reach a log line intact', () => {
    const h = haltState([file('X'.repeat(10_000))])!;
    expect(h.rawLabel!.length).toBeLessThanOrEqual(32);
    expect(h.mode).toBe('TERMINATE_WHEN_FLAT');
  });
});

describe('what each mode permits', () => {
  it('no mode ever permits a new entry', () => {
    for (const mode of HALT_MODES) expect(entriesAllowed(mode)).toBe(false);
  });

  it('every mode except EMERGENCY_RECONCILE keeps working positions out', () => {
    expect(exitManagementActive('HALT_NEW_ENTRIES')).toBe(true);
    expect(exitManagementActive('EXIT_ONLY')).toBe(true);
    expect(exitManagementActive('TERMINATE_WHEN_FLAT')).toBe(true);
    expect(exitManagementActive('EMERGENCY_RECONCILE')).toBe(false);
  });
});

describe('a halt with an open position does not stop the engine', () => {
  /** The defect, stated as a test: one open position, halt engaged. */
  const OPEN = 1;

  it('TERMINATE_WHEN_FLAT keeps running while a position is open', () => {
    expect(mayTerminate('TERMINATE_WHEN_FLAT', OPEN)).toBe(false);
  });

  it('and stops as soon as it is flat', () => {
    expect(mayTerminate('TERMINATE_WHEN_FLAT', 0)).toBe(true);
  });

  it('HALT_NEW_ENTRIES and EXIT_ONLY stay alive even when flat, for a human to watch', () => {
    expect(mayTerminate('HALT_NEW_ENTRIES', 0)).toBe(false);
    expect(mayTerminate('EXIT_ONLY', 0)).toBe(false);
  });

  it('only EMERGENCY_RECONCILE will stop with exposure outstanding', () => {
    const canAbandon = HALT_MODES.filter((m) => mayTerminate(m, OPEN));
    expect(canAbandon).toEqual(['EMERGENCY_RECONCILE']);
  });

  it('so a bare halt file can never abandon a position', () => {
    const h = haltState([file('')])!;
    expect(mayTerminate(h.mode, OPEN)).toBe(false);
    expect(exitManagementActive(h.mode)).toBe(true);
  });
});

describe('an unreadable halt file still halts', () => {
  /**
   * A directory, not a chmod. `chmod 0o000` is a no-op on Windows, so the
   * read-error branch was never executed there and the test passed against an
   * implementation that returned null — i.e. that treated an unreadable halt
   * file as no halt at all. A directory satisfies `existsSync` and throws
   * EISDIR from `readFileSync` on every platform.
   */
  it('fails closed rather than treating a read error as no halt', () => {
    const p = join(dir, 'KILL-is-a-directory');
    mkdirSync(p, { recursive: true });
    const h = haltState([p]);
    expect(h).not.toBeNull();
    expect(h!.defaulted).toBe(true);
    expect(mayTerminate(h!.mode, 1)).toBe(false);
    expect(exitManagementActive(h!.mode)).toBe(true);
  });
});
