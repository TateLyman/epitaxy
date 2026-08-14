import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

/**
 * P18 — an artifact must say what produced it, and a stale one must not count.
 *
 * The checked-in release manifest was generated from an older dirty commit and
 * still claimed no simulator was wired. Other artifacts disagreed with the
 * report that cited them. Nothing in the format made any of that detectable:
 * a JSON file with numbers in it looks current forever.
 *
 * Every artifact carries this stamp, and readiness refuses one whose commit is
 * not the commit being assessed. A number from a different tree is a number
 * about a different system.
 */

export interface ArtifactProvenance {
  readonly generatedUtcMs: number;
  readonly sourceCommit: string;
  /** True when the tree had uncommitted changes. A dirty artifact is not reproducible. */
  readonly dirty: boolean;
  readonly strategyVersion: string;
  readonly schemaVersion: string;
  readonly contextHash: string | null;
  /** The query that selected the sample, so a reader can re-run it. */
  readonly sampleInclusionQuery: string | null;
}

export function currentProvenance(p: {
  strategyVersion: string;
  schemaVersion: string;
  contextHash?: string | null;
  sampleInclusionQuery?: string | null;
}): ArtifactProvenance {
  let sourceCommit = 'unknown';
  let dirty = true;
  try {
    sourceCommit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch {
    // No git is not "clean". An artifact that cannot name its commit is the
    // most stale kind there is.
  }
  return {
    generatedUtcMs: Date.now(),
    sourceCommit,
    dirty,
    strategyVersion: p.strategyVersion,
    schemaVersion: p.schemaVersion,
    contextHash: p.contextHash ?? null,
    sampleInclusionQuery: p.sampleInclusionQuery ?? null,
  };
}

export type StaleReason =
  | 'missing'
  | 'unreadable'
  | 'no_provenance'
  | 'different_commit'
  | 'dirty_tree'
  | 'different_strategy_version'
  | 'too_old';

export interface Freshness {
  readonly path: string;
  readonly fresh: boolean;
  readonly reasons: readonly StaleReason[];
  readonly detail: string;
}

/**
 * Whether an artifact may be used as evidence right now.
 *
 * Refuses rather than warning. A warning about a stale artifact is read once
 * and then lives in a log; a refusal is read every time it matters.
 */
export function checkFreshness(
  path: string,
  expect: { sourceCommit: string; strategyVersion: string; maxAgeMs?: number },
): Freshness {
  const reasons: StaleReason[] = [];
  const detail: string[] = [];

  if (!existsSync(path)) {
    return { path, fresh: false, reasons: ['missing'], detail: 'the artifact does not exist' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return { path, fresh: false, reasons: ['unreadable'], detail: (e as Error).message.slice(0, 120) };
  }

  // The stamp may be at the top level or nested under `provenance`.
  const prov = (parsed['provenance'] as Record<string, unknown> | undefined) ?? parsed;
  const commit = prov['sourceCommit'];
  if (typeof commit !== 'string') {
    return {
      path,
      fresh: false,
      reasons: ['no_provenance'],
      detail: 'the artifact does not name the commit that produced it',
    };
  }

  if (commit !== expect.sourceCommit) {
    reasons.push('different_commit');
    detail.push(`produced at ${commit.slice(0, 12)}, assessing ${expect.sourceCommit.slice(0, 12)}`);
  }
  if (prov['dirty'] === true) {
    reasons.push('dirty_tree');
    detail.push('produced from a tree with uncommitted changes');
  }
  const version = prov['strategyVersion'];
  if (typeof version === 'string' && version !== expect.strategyVersion) {
    reasons.push('different_strategy_version');
    detail.push(`produced under ${version}, assessing ${expect.strategyVersion}`);
  }
  const generated = prov['generatedUtcMs'];
  if (expect.maxAgeMs !== undefined && typeof generated === 'number') {
    const age = Date.now() - generated;
    if (age > expect.maxAgeMs) {
      reasons.push('too_old');
      detail.push(`${Math.round(age / 3_600_000)}h old, limit ${Math.round(expect.maxAgeMs / 3_600_000)}h`);
    }
  }

  return {
    path,
    fresh: reasons.length === 0,
    reasons,
    detail: detail.join('; ') || 'current',
  };
}
