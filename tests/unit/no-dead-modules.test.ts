import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A module that only tests import is a module that decides nothing.
 *
 * This repository's recurring defect is a field that is declared, stored,
 * listed in a schema, and read by no decision. This is that defect at module
 * scale, and it is worse: a dead module has passing tests, so it looks like
 * working capability in every report that counts files.
 *
 * Three were found this way on 2026-08-13:
 *
 *   packages/intelligence/src/mintfacts.ts     0 non-test importers
 *   packages/intelligence/src/entity.ts        0 non-test importers
 *   packages/adapters/src/accountwatch.ts      0 non-test importers
 *
 * All three are complete, tested, and consulted by nothing. They are listed
 * below as KNOWN_INERT with the phase that would wire them, so the list can
 * only shrink: a module that leaves it can never quietly return, and a NEW
 * dead module fails this test on the day it is written rather than being
 * discovered a directive later.
 */

/**
 * Modules known to decide nothing yet, and what would change that.
 *
 * Shrink this list by wiring the module. Do not grow it to make a test pass:
 * adding an entry is a statement that a decision-bearing module is inert on
 * purpose, and it belongs in the failure register too.
 */
const KNOWN_INERT: Readonly<Record<string, string>> = {};

/** Every .ts file under the source roots, excluding tests and type-only files. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) {
      sources(p, out);
      continue;
    }
    if (!p.endsWith('.ts') || p.endsWith('.d.ts')) continue;
    out.push(p);
  }
  return out;
}

const ROOTS = ['packages', 'apps'];
const ALL = ROOTS.flatMap((r) => sources(r));

/** Files that may import a module and count as "alive". Tests do not count. */
const LIVE = [...ALL, ...sources('scripts')].filter((p) => !p.includes('/tests/'));

function importersOf(modulePath: string): string[] {
  // ESM resolution here is relative with a .js suffix, so the import specifier
  // ends with the basename. Matching on the basename over-matches slightly and
  // that is the safe direction: it can only make a dead module look alive if
  // two modules share a name, and this repository has none.
  const basename = modulePath.split('/').pop()?.replace(/\.ts$/, '.js') ?? '';
  if (basename === '') return [];
  return LIVE.filter((p) => {
    if (p === modulePath) return false;
    const text = readFileSync(p, 'utf8');
    return text.includes(`/${basename}'`) || text.includes(`/${basename}"`);
  });
}

/**
 * The modules whose whole purpose is to decide something.
 *
 * Deliberately not every file: a type module or a pure helper can legitimately
 * be imported by one thing, and demanding a caller for all of them would make
 * this test noise. These are the ones that exist to change an outcome.
 */
const DECISION_BEARING = [
  'packages/intelligence/src/gates.ts',
  'packages/intelligence/src/mintfacts.ts',
  'packages/intelligence/src/entity.ts',
  'packages/adapters/src/accountwatch.ts',
  'packages/strategy/src/score.ts',
  'packages/strategy/src/exits.ts',
  'packages/strategy/src/portfolio.ts',
  'packages/strategy/src/markscheduler.ts',
  'packages/domain/src/accounting.ts',
  'packages/domain/src/evidence.ts',
  'packages/domain/src/cohort.ts',
  'packages/simulator/src/effect.ts',
  'packages/research/src/readiness.ts',
  'packages/research/src/capability.ts',
];

describe('a decision-bearing module must be consulted by something', () => {
  for (const mod of DECISION_BEARING) {
    const known = KNOWN_INERT[mod];
    it(`${mod}${known === undefined ? '' : ' (known inert)'}`, () => {
      const importers = importersOf(mod);
      if (known !== undefined) {
        // Still inert, and the reason is still recorded. When this fails
        // because the module is now wired, DELETE its KNOWN_INERT entry — that
        // is the list shrinking, which is the point.
        expect(
          importers,
          `${mod} is now imported by ${importers.join(', ')} — remove it from KNOWN_INERT`,
        ).toEqual([]);
        expect(known.length).toBeGreaterThan(10);
        return;
      }
      expect(importers.length, `${mod} is imported by no live code — it decides nothing`).toBeGreaterThan(0);
    });
  }

  it('the inert list is small and every entry names the phase that would wire it', () => {
    // Growing this list is a statement that a decision-bearing module is inert
    // on purpose. That belongs in the failure register, not in a test file.
    // Empty. Every decision-bearing module now has a live caller.
    expect(Object.keys(KNOWN_INERT).length).toBe(0);
    for (const [mod, why] of Object.entries(KNOWN_INERT)) {
      expect(why, mod).toMatch(/^P\d+ —/);
    }
  });

  it('every known-inert module is recorded in the failure register', () => {
    const register = readFileSync('docs/FAILURE_REGISTER.csv', 'utf8');
    expect(register).toContain('S051');
    // Named, so the register entry cannot drift from the list.
    for (const mod of Object.keys(KNOWN_INERT)) {
      expect(register, `${mod} must appear in the failure register`).toContain(mod.split('/').pop() ?? '');
    }
  });
});
