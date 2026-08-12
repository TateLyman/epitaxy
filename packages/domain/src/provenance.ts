import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AppConfig } from './config.js';

/**
 * What produced a row.
 *
 * P2a.1 §P2.1. The measurement window that motivated this session pooled five
 * incompatible regimes into one number:
 *
 *   strategy v0.2 with v0.3;
 *   snapshots taken before O042 (concentration missing) with ones taken after;
 *   31-second marks with 10.5-second marks;
 *   a 0.06 SOL / 6% risk policy with a 0.5 SOL / 50% one;
 *   quote-only fills with build-validated fills.
 *
 * Every one of those changes what a row MEANS, and none of them was recorded on
 * the row. The result is a corpus where "average realized PnL" is an average
 * over five different experiments.
 *
 * The eight fields the directive requires are stored once in `run_contexts` and
 * referenced by a `context_hash` on each observation, rather than copied into
 * eight columns on nine tables. Same information, one write, and a report that
 * pools two regimes has to join through a key that makes the pooling visible.
 */

export const PROVENANCE_VERSION = 'provenance-v1';

export interface RunContext {
  /** sha256 of the eight fields below. The join key. */
  readonly contextHash: string;
  /** git HEAD, suffixed `+dirty` when the tree had uncommitted changes. */
  readonly sourceCommit: string;
  readonly strategyVersion: string;
  /** Hash of every config field that changes a DECISION. */
  readonly strategyConfigHash: string;
  /** Hash of the risk policy alone, so a risk change is visible on its own. */
  readonly riskPolicyHash: string;
  /** Database schema version, i.e. the highest applied migration. */
  readonly schemaVersion: string;
  readonly paperEngineVersion: string;
  readonly quoteAdapterVersion: string;
  /**
   * Coarse pooling key. Two rows with different `dataRegimeId` must never be
   * averaged together, and this is the field a report checks to refuse.
   */
  readonly dataRegimeId: string;
  readonly capturedUtcMs: number;
}

/**
 * Versions of the two components whose behaviour changes what a row means but
 * which have no other version of their own.
 *
 * Bumped by hand, deliberately. An automatic hash of the source file would
 * change on a comment edit and split the corpus for no reason; these are
 * statements about semantics, not about bytes.
 *
 * paper-engine-v3 — build-gated entries, decoupled mark cadence, rolling daily
 *   cap, four enforced risk halts, monotonic scheduling.
 * quote-adapter-v2 — impact parsed through packages/domain/src/impact.ts, with
 *   absence recorded as unknown instead of 0.
 */
export const PAPER_ENGINE_VERSION = 'paper-engine-v3';
export const QUOTE_ADAPTER_VERSION = 'quote-adapter-v2';

/** Stable JSON: keys sorted at every level, bigints as decimal strings. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Short, human-quotable prefix. Full hashes are stored; these are for logs. */
export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}

/**
 * The current commit, and whether the working tree matched it.
 *
 * A dirty tree is reported as dirty rather than silently attributed to HEAD,
 * because a row tagged with a commit that does not describe the code that
 * produced it is worse than a row with no commit at all: it invites a replay
 * that cannot possibly reproduce. Fails to `unknown` rather than throwing —
 * provenance is not worth taking the engine down for, but it is worth being
 * honest about.
 */
export function sourceCommit(cwd?: string): string {
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = run(['rev-parse', 'HEAD']);
    const dirty = run(['status', '--porcelain']).length > 0;
    return dirty ? `${head}+dirty` : head;
  } catch {
    return 'unknown';
  }
}

/**
 * Config fields that change a DECISION.
 *
 * Enumerated explicitly rather than hashing the whole config, because the whole
 * config includes paths and log levels, and a rotated log path must not split
 * the corpus. Adding a decision-bearing field without adding it here makes the
 * hash a lie, so `tests/unit/provenance.test.ts` enumerates the schema and
 * fails on anything unaccounted for.
 */
export function strategyConfigHash(config: AppConfig): string {
  return sha256Hex(
    canonicalJson({
      strategyVersion: config.strategyVersion,
      gates: config.gates,
      exits: config.exits,
      minOpportunityScore: config.minOpportunityScore,
      quoteProbeLamports: config.quoteProbeLamports,
      maxQuoteAgeMs: config.maxQuoteAgeMs,
      maxFeeFractionBps: config.maxFeeFractionBps,
      assumedNewTokenFeeBps: config.assumedNewTokenFeeBps,
      assumedPriorityFeeLamports: config.assumedPriorityFeeLamports,
      assumedSignatureFeeLamports: config.assumedSignatureFeeLamports,
      assumedAtaRentLamports: config.assumedAtaRentLamports,
      assumedRentRecoveryRate: config.assumedRentRecoveryRate,
      requireBuildableFill: config.requireBuildableFill,
      markIntervalMs: config.markIntervalMs,
      discoveryIntervalMs: config.discoveryIntervalMs,
    }),
  );
}

/** The risk policy alone, so a risk change shows up without a strategy change. */
export function riskPolicyHash(config: AppConfig): string {
  return sha256Hex(canonicalJson(config.risk));
}

/**
 * The pooling key.
 *
 * Deliberately coarser than `contextHash`: a threshold tweak inside one arm
 * should not forbid pooling with the rest of that arm, but a change of mark
 * cadence, risk policy, buildability regime, or strategy version must. The
 * mark cadence is bucketed to whole seconds so that 10.54s and 10.56s — the
 * same regime, measured twice — do not become two regimes.
 */
export function dataRegimeId(config: AppConfig, schemaVersion: string): string {
  const tuple = {
    strategyVersion: config.strategyVersion,
    markIntervalSec: Math.round(config.markIntervalMs / 1000),
    requireBuildableFill: config.requireBuildableFill,
    riskPolicyHash: riskPolicyHash(config),
    schemaVersion,
  };
  return `${config.strategyVersion}/${tuple.markIntervalSec}s/${config.requireBuildableFill ? 'build' : 'quote'}/${shortHash(
    sha256Hex(canonicalJson(tuple)),
  )}`;
}

export interface ContextOptions {
  readonly schemaVersion: string;
  /** Jupiter schema version, from packages/adapters/src/jupiter/schemas.ts. */
  readonly quoteSchemaVersion: string;
  readonly nowUtcMs: number;
  readonly cwd?: string;
}

export function buildRunContext(config: AppConfig, opts: ContextOptions): RunContext {
  const strategy = strategyConfigHash(config);
  const risk = riskPolicyHash(config);
  const commit = sourceCommit(opts.cwd);
  const regime = dataRegimeId(config, opts.schemaVersion);
  const quoteAdapter = `${QUOTE_ADAPTER_VERSION}/${opts.quoteSchemaVersion}`;

  const fields = {
    sourceCommit: commit,
    strategyVersion: config.strategyVersion,
    strategyConfigHash: strategy,
    riskPolicyHash: risk,
    schemaVersion: opts.schemaVersion,
    paperEngineVersion: PAPER_ENGINE_VERSION,
    quoteAdapterVersion: quoteAdapter,
    dataRegimeId: regime,
  };

  return {
    contextHash: sha256Hex(canonicalJson(fields)),
    ...fields,
    // Not part of the hash: two runs of identical code in the same regime share
    // a context, and stamping the clock into the key would make every restart
    // its own regime.
    capturedUtcMs: opts.nowUtcMs,
  };
}
