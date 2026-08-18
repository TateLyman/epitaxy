/**
 * One way to write an artifact, so every artifact carries the same provenance.
 *
 * The 8f73cef audit found two different scripts writing `artifacts/readiness.json`
 * (Q-1), and status commands emitting official-looking zero-filled reports for
 * capabilities they never exercised. Both are the same defect: an artifact that
 * does not say WHO wrote it, from WHAT commit, over WHAT tree state, and whether
 * the capability actually RAN.
 *
 * So every artifact written through here carries:
 *   - the writing script's own filename (a second writer is then visible in the
 *     file itself, not only in a code review);
 *   - the source commit and whether the tree was dirty at write time;
 *   - the UTC instant.
 *
 * And a capability that did not run must be recorded as NOT_RUN with a reason
 * rather than as zeros. Zeros read as a measurement. `status: 'NOT_RUN'` does not.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export interface Provenance {
  readonly writer: string;
  readonly sourceCommit: string;
  readonly treeDirty: boolean;
  readonly dirtyFiles: number;
  readonly writtenUtc: string;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch {
    return '';
  }
}

export function provenance(writer?: string): Provenance {
  const status = git(['status', '--short']);
  const dirtyFiles = status.length === 0 ? 0 : status.split('\n').filter((l) => l.trim().length > 0).length;
  return {
    writer: writer ?? basename(process.argv[1] ?? 'unknown'),
    sourceCommit: git(['rev-parse', 'HEAD']) || 'unknown',
    treeDirty: dirtyFiles > 0,
    dirtyFiles,
    writtenUtc: new Date().toISOString(),
  };
}

/**
 * Write `artifacts/<name>`, stamped. Returns the resolved path.
 *
 * `name` must be a bare filename. Every artifact in this repository is owned by
 * exactly ONE script; passing a path would make it easy to reintroduce Q-1.
 */
export function writeArtifact(name: string, body: Record<string, unknown>): string {
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`writeArtifact takes a bare filename, got ${name}`);
  }
  const path = resolve('artifacts', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...body, provenance: provenance() }, null, 2)}\n`);
  return path;
}

/**
 * P18 — the research context every profit-discovery artifact must name.
 *
 * `provenance()` answers "who wrote this, from what commit". It does not answer
 * "which experiment is this about", and an artifact that cannot say which
 * contract, context and window it measured is unusable the moment a second
 * window exists — which is exactly the situation this phase creates.
 *
 * Read from the database rather than passed in, so two scripts reporting on the
 * same window cannot disagree about which window it was.
 */
export interface ResearchContext {
  readonly contract: string | null;
  readonly contractHash: string | null;
  readonly evidenceContextId: string | null;
  readonly windowId: string | null;
  readonly featureVersions: Readonly<Record<string, string>>;
  readonly sampleQuery: string;
}

export interface ContextDb {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown };
}

export function researchContext(db: ContextDb, sampleQuery: string, featureVersions: Record<string, string> = {}): ResearchContext {
  let contract: { contract_id: string; contract_hash: string; evidence_context_id: string; window_id: string | null } | undefined;
  try {
    contract = db
      .prepare(
        `SELECT contract_id, contract_hash, evidence_context_id, window_id
           FROM experiment_contracts
          ORDER BY frozen_utc_ms DESC
          LIMIT 1`,
      )
      .get() as typeof contract;
  } catch {
    contract = undefined;
  }
  return {
    contract: contract?.contract_id ?? null,
    contractHash: contract?.contract_hash ?? null,
    evidenceContextId: contract?.evidence_context_id ?? null,
    windowId: contract?.window_id ?? null,
    featureVersions,
    sampleQuery,
  };
}

/**
 * The artifact for a capability that was NOT exercised.
 *
 * Never emit zeros for this case. A consumer cannot distinguish "measured zero"
 * from "never ran" once the reason is gone.
 */
export function writeNotRun(name: string, reason: string, extra: Record<string, unknown> = {}): string {
  return writeArtifact(name, { status: 'NOT_RUN', reason, ...extra });
}
