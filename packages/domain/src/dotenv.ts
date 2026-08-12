import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `.env` into `process.env`, once.
 *
 * This exists because it did not. `docs/ENVIRONMENT.md` documented `.env` as
 * the place secrets go, `.gitignore` protected it, `scripts/secretscan.ts`
 * guarded it, and `pnpm doctor` checked that it was ignored — and no code path
 * in the repository ever read it. Every secret had to arrive as an ambient
 * environment variable, so a correctly-populated `.env` was inert while every
 * surrounding mechanism reported it as configured. Registered as O031.
 *
 * Three decisions worth stating, because each is a place this could go wrong:
 *
 * 1. **Ambient wins.** A variable already present in `process.env` is never
 *    overwritten. `process.loadEnvFile()` does the opposite, which is why it is
 *    not used here: a stale committed-adjacent `.env` on an operator's disk must
 *    not silently override the endpoint a deployment actually set. The file is a
 *    default, not an authority.
 *
 * 2. **A malformed line is a hard error, not a skipped line.** A secrets file
 *    that half-loads is the failure shape this whole module exists to prevent.
 *
 * 3. **Values are never logged, never returned, and never re-read.** The
 *    function reports only the NAMES it set, so a caller can say "loaded 2
 *    variables from .env" without holding any value.
 */

export class DotEnvError extends Error {}

let loaded: readonly string[] | null = null;

/** Parse dotenv text. Exported for tests; does not touch `process.env`. */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `export FOO=bar` is common enough in hand-written files to accept.
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      throw new DotEnvError(`.env line ${i + 1} is not KEY=VALUE and is not a comment`);
    }
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new DotEnvError(`.env line ${i + 1} has an invalid variable name`);
    }

    let value = body.slice(eq + 1).trim();
    // Strip one layer of matching quotes. Unquoted values keep no trailing
    // comment stripping: a `#` inside a key is legal and eating it would
    // truncate the credential, which fails as a confusing 401 rather than as
    // a parse error.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Idempotent. Returns the names of the variables this call actually set —
 * never their values.
 */
export function loadDotEnvOnce(cwd = process.cwd()): readonly string[] {
  if (loaded !== null) return loaded;
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) {
    loaded = [];
    return loaded;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new DotEnvError(`.env exists but could not be read: ${(e as Error).message}`);
  }
  const parsed = parseDotEnv(text);
  const set: string[] = [];
  for (const [k, v] of parsed) {
    if (process.env[k] !== undefined) continue; // ambient wins
    if (v === '') continue; // an empty assignment is "not configured", not ""
    process.env[k] = v;
    set.push(k);
  }
  loaded = set;
  return loaded;
}

/** Test-only. Lets a suite exercise the load path more than once. */
export function resetDotEnvForTests(): void {
  loaded = null;
}

/**
 * Test-only. Marks the load as already done without reading any file.
 *
 * Called once from `tests/setup.ts`. Without it, `loadSecrets()` — which calls
 * `loadDotEnvOnce()` — reads the operator's real `.env` during unit tests, so a
 * test asserting "no key is configured" passes on a clean checkout and fails on
 * the machine of anyone who has actually configured the system. That is a test
 * that reports the state of a developer's disk rather than the state of the
 * code, and it found nothing when it broke; it only became noisy.
 *
 * Suppressing at this level rather than deleting the file's variables keeps the
 * secret out of `process.env` entirely for the duration of the suite.
 */
export function suppressDotEnvForTests(): void {
  loaded = [];
}
