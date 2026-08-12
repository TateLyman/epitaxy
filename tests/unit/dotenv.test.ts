import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDotEnv,
  loadDotEnvOnce,
  resetDotEnvForTests,
  DotEnvError,
} from '../../packages/domain/src/dotenv.js';

/**
 * O031: `.env` was documented, git-ignored, secretscan-guarded and
 * doctor-checked, and read by nothing. These tests cover the module that
 * closed it, with emphasis on the two properties that make it safe to point at
 * a file full of live credentials: ambient variables win, and a malformed line
 * stops the process instead of half-loading.
 */

const dirs: string[] = [];
function envDir(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'dotenv-'));
  dirs.push(d);
  writeFileSync(join(d, '.env'), contents, 'utf8');
  return d;
}

afterEach(() => {
  resetDotEnvForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseDotEnv', () => {
  it('parses plain assignments', () => {
    expect(parseDotEnv('A=1\nB=two')).toEqual(new Map([['A', '1'], ['B', 'two']]));
  });

  it('ignores blank lines and comments', () => {
    expect(parseDotEnv('\n# a comment\n\nA=1\n   # indented\n')).toEqual(new Map([['A', '1']]));
  });

  it('accepts the export prefix', () => {
    expect(parseDotEnv('export A=1')).toEqual(new Map([['A', '1']]));
  });

  it('strips exactly one layer of matching quotes', () => {
    const m = parseDotEnv(`A="1"\nB='2'\nC=""3""\nD="mismatched'`);
    expect(m.get('A')).toBe('1');
    expect(m.get('B')).toBe('2');
    expect(m.get('C')).toBe('"3"');
    expect(m.get('D')).toBe(`"mismatched'`);
  });

  it('does NOT treat # as a trailing comment in an unquoted value', () => {
    // A `#` is legal inside a credential. Eating it would truncate the key and
    // surface later as a confusing 401 rather than as a parse error.
    expect(parseDotEnv('K=abc#def').get('K')).toBe('abc#def');
  });

  it('keeps = characters inside a value', () => {
    expect(parseDotEnv('K=a=b=c').get('K')).toBe('a=b=c');
  });

  it('rejects a malformed line rather than skipping it', () => {
    // Half-loading a secrets file is the failure this module exists to prevent.
    expect(() => parseDotEnv('A=1\nthis is not an assignment\nB=2')).toThrow(DotEnvError);
    expect(() => parseDotEnv('A=1\nnope\n')).toThrow(/line 2/);
  });

  it('rejects a leading = with no key', () => {
    expect(() => parseDotEnv('=value')).toThrow(DotEnvError);
  });

  it('rejects an invalid variable name', () => {
    expect(() => parseDotEnv('9BAD=1')).toThrow(/invalid variable name/);
    expect(() => parseDotEnv('has-dash=1')).toThrow(/invalid variable name/);
  });

  it('handles CRLF line endings', () => {
    // The repository is developed on Windows; this is not hypothetical.
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual(new Map([['A', '1'], ['B', '2']]));
  });
});

describe('loadDotEnvOnce', () => {
  const KEY = 'DOTENV_TEST_ONLY_VAR';
  const OTHER = 'DOTENV_TEST_ONLY_OTHER';
  afterEach(() => {
    delete process.env[KEY];
    delete process.env[OTHER];
  });

  it('sets a variable that is not already present and returns its name', () => {
    delete process.env[KEY];
    const set = loadDotEnvOnce(envDir(`${KEY}=from-file`));
    expect(set).toEqual([KEY]);
    expect(process.env[KEY]).toBe('from-file');
  });

  it('never overwrites an ambient variable', () => {
    // Deliberately unlike process.loadEnvFile(), which does the opposite. A
    // stale .env on an operator's disk must not override what a deployment set.
    process.env[KEY] = 'from-ambient';
    const set = loadDotEnvOnce(envDir(`${KEY}=from-file`));
    expect(process.env[KEY]).toBe('from-ambient');
    expect(set).toEqual([]);
  });

  it('treats an empty assignment as not configured', () => {
    delete process.env[KEY];
    loadDotEnvOnce(envDir(`${KEY}=`));
    expect(process.env[KEY]).toBeUndefined();
  });

  it('returns names only, never values', () => {
    delete process.env[KEY];
    const set = loadDotEnvOnce(envDir(`${KEY}=super-secret-value`));
    expect(set).toEqual([KEY]);
    expect(JSON.stringify(set)).not.toContain('super-secret-value');
  });

  it('is idempotent — a second call is a no-op even against a different dir', () => {
    delete process.env[KEY];
    delete process.env[OTHER];
    expect(loadDotEnvOnce(envDir(`${KEY}=one`))).toEqual([KEY]);
    expect(loadDotEnvOnce(envDir(`${OTHER}=two`))).toEqual([KEY]);
    expect(process.env[OTHER]).toBeUndefined();
  });

  it('is a no-op when no .env exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'dotenv-none-'));
    dirs.push(d);
    expect(loadDotEnvOnce(d)).toEqual([]);
  });

  it('propagates a malformed file as a hard error', () => {
    expect(() => loadDotEnvOnce(envDir('A=1\ngarbage line\n'))).toThrow(DotEnvError);
  });
});
