import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AppConfigSchema } from '../packages/domain/src/config.js';
import { strategyConfigHash, riskPolicyHash, sourceCommit } from '../packages/domain/src/provenance.js';

/**
 * What exactly is this build?
 *
 * §P15. A release manifest exists so that a claim about the system can be
 * pinned to the bytes that produced it. Every field here has been, at some
 * point in this project, the thing that made two people describe different
 * software with the same words: a dirty tree attributed to a commit, a config
 * hash that did not cover a decision-bearing field, a strategy version constant
 * that disagreed with every config file.
 *
 * Deliberately included: the DIRTY flag, the known blockers, and the replay
 * result. A manifest that lists only what passed is a marketing document.
 */

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unavailable';
  }
}

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const commit = sourceCommit();
const dirty = commit.endsWith('+dirty');

const configs = ['observe', 'paper', 'canary', 'live'].map((mode) => {
  const raw = readFileSync(`config/${mode}.json`, 'utf8');
  const parsed = AppConfigSchema.parse(JSON.parse(raw));
  return {
    mode,
    strategyVersion: parsed.strategyVersion,
    primaryRouteFamily: parsed.primaryRouteFamily,
    requireLocalSimulation: parsed.requireLocalSimulation,
    requireExactSizeBuild: parsed.requireExactSizeBuild,
    strategyConfigHash: strategyConfigHash(parsed),
    riskPolicyHash: riskPolicyHash(parsed),
    fileSha256: createHash('sha256').update(raw).digest('hex'),
  };
});

/**
 * Blockers, stated in the artifact rather than left to a reader to infer.
 *
 * These are the reasons this build cannot produce confirmatory evidence. They
 * are computed from the code and config, not typed in, so they cannot go stale
 * the way a hand-maintained list does.
 */
const blockers: string[] = [];
const paper = configs.find((c) => c.mode === 'paper');
if (paper?.requireLocalSimulation === true) {
  blockers.push(
    'requireLocalSimulation is true and no local SVM fixture is wired, so paper mode books no fills. ' +
      'This is deliberate: a mainnet simulateTransaction cannot validate either leg for an unfunded ' +
      'taker that holds none of the hypothetical tokens.',
  );
}
if (dirty) blockers.push('working tree does not match its commit; nothing built here is reproducible');
if (!existsSync('.github/workflows/ci.yml')) blockers.push('no CI workflow');

const manifest = {
  generatedUtc: new Date().toISOString(),
  source: {
    commit,
    dirty,
    branch: git(['branch', '--show-current']),
    describe: git(['describe', '--always', '--dirty']),
    remote: git(['remote', 'get-url', 'origin']),
  },
  toolchain: {
    node: process.version,
    pnpm: (() => {
      try {
        return execFileSync('pnpm', ['--version'], { encoding: 'utf8', shell: true }).trim();
      } catch {
        return 'unavailable';
      }
    })(),
    lockfileSha256: sha256('pnpm-lock.yaml'),
    packageJsonSha256: sha256('package.json'),
    tsconfigSha256: sha256('tsconfig.json'),
  },
  configs,
  programsAllowlistSha256: sha256('config/programs.mainnet.json'),
  sourceLimitsSha256: sha256('config/source-limits.json'),
  docs: {
    auditBaseline: sha256('docs/AUDIT_HEAD_3155EA.md'),
    invalidation: sha256('docs/P2B_INVALIDATION.md'),
    multipleTestingLedger: sha256('docs/MULTIPLE_TESTING_LEDGER.csv'),
  },
  knownBlockers: blockers,
  // Filled by CI or by a local run of `pnpm check`; absent means not run, which
  // is not the same as passed.
  tests: { run: false, note: 'run `pnpm check` and `pnpm replay`; results are recorded in replay_runs' },
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/release-manifest.json', JSON.stringify(manifest, null, 2));

console.log('release manifest -> artifacts/release-manifest.json\n');
console.log(`  commit        ${commit}`);
console.log(`  node          ${process.version}`);
console.log(`  lockfile      ${manifest.toolchain.lockfileSha256?.slice(0, 16) ?? 'missing'}`);
for (const c of configs) {
  console.log(`  ${c.mode.padEnd(8)}    ${c.strategyVersion}  ${c.primaryRouteFamily}  cfg=${c.strategyConfigHash.slice(0, 12)}  risk=${c.riskPolicyHash.slice(0, 12)}`);
}
console.log(`\n  known blockers: ${blockers.length}`);
for (const b of blockers) console.log(`    - ${b}`);
