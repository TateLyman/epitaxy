import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { NOT_IMPLEMENTED } from '../../scripts/not-implemented.js';

/**
 * The directive's P12 tests: 4, 5 and 57.
 *
 * F22's defect is not a missing feature. It is a command that PRODUCES OUTPUT
 * about something else and exits zero. `pnpm rate:budget-v2` ran the trajectory
 * status, `pnpm wss:status` ran the direct-signal status, and `pnpm
 * landed:parity-v2` ran a script that compares things nobody landed. Each looked
 * like a result, and a result gets pasted into a status document.
 *
 * That is the same defect class as a proof artifact standing in for a database,
 * which is what tests 4 and 5 are about.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

/** Every command the directive requires to mean its name. */
const REQUIRED = [
  'audit:state',
  'snapshot:coherent-proof',
  'worker:sequential-proof',
  'trajectory:collect',
  'trajectory:status',
  'trajectory:kernel-proof',
  'settlement:check',
  'ledger:identity',
  'cashback:surface',
  'size:trajectory-surface',
  'pumpswap:parity-v3',
  'landed:parity-v2',
  'direct-signal:status',
  'wss:status',
  'cohort:status',
  'exploration:status',
  'reject:panel-v2',
  'rate:budget-v2',
  'replay',
  'report',
  'readiness',
  'release:manifest',
];

describe('57 — no command is a silent alias for a different capability', () => {
  it('every required command exists', () => {
    const missing = REQUIRED.filter((c) => pkg.scripts[c] === undefined);
    expect(missing).toEqual([]);
  });

  it('the five known aliases now refuse instead of answering another question', () => {
    for (const entry of NOT_IMPLEMENTED) {
      const script = pkg.scripts[entry.command];
      expect(script, `${entry.command} is not wired`).toBeDefined();
      expect(script, `${entry.command} still aliases something`).toContain('not-implemented.ts');
      expect(script).toContain(entry.command);
    }
  });

  it('a NOT_IMPLEMENTED command exits NON-ZERO and names its prerequisite', () => {
    let code: number | null = null;
    let stderr = '';
    try {
      execFileSync('npx', ['tsx', 'scripts/not-implemented.ts', 'wss:status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      code = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      code = err.status ?? -1;
      stderr = err.stderr?.toString() ?? '';
    }
    // Zero would let a caller treat the refusal as a successful report.
    expect(code).toBe(1);
    expect(stderr).toContain('NOT_IMPLEMENTED');
    expect(stderr).toContain('missing prerequisite');
  }, 60_000);

  it('an unknown command is itself refused, so the stub cannot absorb typos', () => {
    let code: number | null = null;
    try {
      execFileSync('npx', ['tsx', 'scripts/not-implemented.ts', 'nope:nope'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      code = 0;
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  }, 60_000);

  it('every refusal names a concrete prerequisite, not "coming soon"', () => {
    for (const c of NOT_IMPLEMENTED) {
      expect(c.prerequisite.length).toBeGreaterThan(60);
      expect(c.capability.length).toBeGreaterThan(10);
      // The point of the entry is that a reader can tell what would have to
      // exist. A vague one is the alias problem with extra steps.
      expect(c.prerequisite).not.toMatch(/\b(TBD|TODO|coming soon|not yet)\b/i);
    }
  });
});

describe('4/5 — a proof artifact cannot inflate the database count', () => {
  const status = readFileSync('scripts/database-trajectory-status.ts', 'utf8');

  it('trajectory:status is wired to the database-only script', () => {
    expect(pkg.scripts['trajectory:status']).toBe('tsx scripts/database-trajectory-status.ts');
  });

  it('the status script has no code path that reads an artifact', () => {
    // THE assertion. Not "it currently reports zero", which a caller could
    // change: the script has no way to read a file at all.
    //
    // It DOES name `live-one-pass-trajectory.json` in prose, deliberately, so a
    // reader knows which artifact is being excluded and why. Naming a thing you
    // refuse to read is the opposite of the defect.
    expect(status).not.toMatch(/readFileSync/);
    expect(status).not.toMatch(/existsSync/);
    expect(status).not.toMatch(/JSON\.parse/);
    // It writes one artifact and reads none.
    expect(status).toMatch(/writeFileSync\('artifacts\/trajectory-status\.json'/);
  });

  it('it counts proof artifacts as zero, explicitly rather than by omission', () => {
    expect(status).toMatch(/proofArtifactsCounted: 0/);
    // Silence would be indistinguishable from having forgotten them.
    expect(status).toMatch(/instrument evidence, never a trajectory/);
  });

  it('the old position-oriented status keeps its own name', () => {
    // It answers a real question; it just is not this one. Deleting it would
    // lose the answer, and leaving it under the trajectory name was F22.
    expect(pkg.scripts['development:status']).toBe('tsx scripts/development-status.ts');
  });
});
