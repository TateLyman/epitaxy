import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
  SIMULATION_PROTOCOL_VERSION,
  type SimulatorIdentity,
} from '../../../packages/simulator/src/protocol.js';

/**
 * What exactly is this daemon?
 *
 * Every field here has to be pinned into a confirmatory observation, because a
 * simulation result is only meaningful relative to the thing that produced it.
 * A different Surfpool build, a different feature set, or a source tree that
 * does not match its commit all make a run unreproducible, and unreproducible
 * is not evidence.
 *
 * Computed once at startup and cached: hashing a 40 MB native binary on every
 * request would dominate the latency budget the mark cadence has to fit in.
 */

let cached: SimulatorIdentity | null = null;

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Hash the native binary actually loaded, found rather than assumed.
 *
 * The platform package name is derived from the running platform, so a daemon
 * that somehow loaded a different architecture's binary reports a different
 * hash instead of a confident wrong one.
 */
function surfpoolBinaryHash(): { hash: string | null; path: string | null } {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@solana/surfpool/package.json');
    const root = dirname(pkgPath);
    // The prebuilt lives in an optional platform package beside the wrapper.
    const candidates = [root, join(root, '..', '..')];
    for (const base of candidates) {
      if (!existsSync(base)) continue;
      const stack = [base];
      let guard = 0;
      while (stack.length > 0 && guard++ < 400) {
        const dir = stack.pop();
        if (dir === undefined) break;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = join(dir, e);
          if (e.endsWith('.node')) return { hash: sha256File(full), path: full };
          if (!e.includes('.') && e !== 'node_modules') stack.push(full);
        }
      }
    }
  } catch {
    /* fall through */
  }
  return { hash: null, path: null };
}

export function computeIdentity(repoRoot: string, runtime: { version: string | null; featureSet: string | null }): SimulatorIdentity {
  if (cached !== null) {
    return { ...cached, runtimeVersion: runtime.version, featureSet: runtime.featureSet };
  }

  const head = git(['rev-parse', 'HEAD'], repoRoot);
  const dirty = git(['status', '--porcelain'], repoRoot);
  const sourceSha = head === 'unknown' ? 'unknown' : dirty.length > 0 ? `${head}+dirty` : head;

  let surfpoolPackageVersion = 'unknown';
  try {
    const require = createRequire(import.meta.url);
    surfpoolPackageVersion = (require('@solana/surfpool/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    /* reported as unknown */
  }

  cached = {
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
    sourceSha,
    lockfileHash: sha256File(join(repoRoot, 'pnpm-lock.yaml')) ?? 'unknown',
    surfpoolPackageVersion,
    surfpoolBinaryHash: surfpoolBinaryHash().hash,
    nodeVersion: process.version,
    runtimeVersion: runtime.version,
    featureSet: runtime.featureSet,
    accountSnapshotSchemaVersion: ACCOUNT_SNAPSHOT_SCHEMA_VERSION,
    platform: `${process.platform}/${process.arch}`,
  };
  return cached;
}

/**
 * Refuse to run from a Windows-mounted path.
 *
 * The whole point of this daemon is that nothing it touches lives under
 * /mnt/c. A 9p mount has different locking and IO semantics, and a native SVM
 * binary executing from one is a category of problem nobody should spend an
 * evening diagnosing.
 */
export function assertLinuxFilesystem(cwd: string): void {
  const lowered = cwd.toLowerCase();
  if (lowered.startsWith('/mnt/') || lowered.includes(':\\')) {
    throw new Error(
      `refusing to run from ${cwd}: the simulator must live in the Linux filesystem under /home, ` +
        'never on a Windows mount. Clone it into ~/ and run it from there.',
    );
  }
}
