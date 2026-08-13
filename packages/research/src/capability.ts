import { createHash } from 'node:crypto';
import type { DatabaseSync as Db } from 'node:sqlite';

/**
 * P5 — capability strata.
 *
 * A single failed offline parity run on a stable pair through one AMM does not
 * establish that Pump routes cannot be simulated. It establishes that THAT
 * route could not be. Treating one venue's failure as a property of the whole
 * simulator holds the entire project hostage to the least tractable AMM in the
 * sample, which is exactly backwards: the venues worth proving first are the
 * ones the strategy actually trades.
 *
 * A route is eligible for an evidence class only if its FINGERPRINT has passed
 * parity — not the simulator in general, and not "AMMs" in general.
 */

export type EvidenceClass = 'STRUCTURAL_ONLY' | 'JIT_EFFECT_VALID' | 'OFFLINE_REPRODUCIBLE' | 'CONFIRMATORY';

export interface CapabilityRow {
  readonly fingerprint: string;
  /** The human-readable parts the fingerprint hashes. */
  readonly routeLabels: string;
  readonly topLevelPrograms: readonly string[];
  readonly tokenPrograms: readonly string[];
  readonly lookupTables: number;
  readonly observations: number;
  readonly jitOk: number;
  readonly jitFailed: number;
  readonly offlineOk: number;
  readonly offlineFailed: number;
  readonly effectOk: number;
  readonly supportedEvidenceClass: EvidenceClass;
  readonly failureReason: string | null;
}

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

/**
 * A stable identity for "a route of this shape".
 *
 * Deliberately NOT the mint. Two different tokens on the same pool program,
 * with the same token program and the same table structure, are the same
 * capability question; a fingerprint per mint would make every token its own
 * unproven venue and nothing would ever accumulate evidence.
 */
export function fingerprintOf(input: {
  routeLabels: string;
  programs: readonly string[];
  tokenPrograms: readonly string[];
  lookupTableCount: number;
  simulatorFeatureSet: string | null;
}): string {
  const canonical = JSON.stringify({
    labels: input.routeLabels.split('>').map((x) => x.trim()).filter(Boolean).sort(),
    programs: [...new Set(input.programs)].sort(),
    tokenPrograms: [...new Set(input.tokenPrograms)].sort(),
    // Bucketed, not exact. One table versus two is a structural difference in
    // address resolution; seven versus eight is not.
    tables: input.lookupTableCount === 0 ? 'none' : input.lookupTableCount === 1 ? 'one' : 'many',
    features: input.simulatorFeatureSet ?? 'unknown',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Where the PROGRAM identities come from.
 *
 * Not the static key list. A v0 message's static keys carry the pools, vaults,
 * mints and ATAs of the specific trade alongside the programs, so hashing them
 * gives one fingerprint per token and nothing ever accumulates evidence: 1,899
 * Pump.fun observations became 1,899 unproven venues.
 *
 * The exact transaction blob names the program each instruction invokes. That
 * is the fact, and it is read rather than inferred. When no blob was captured
 * the fingerprint falls back to the route labels alone, and says so, because a
 * fingerprint built from a guess would be a capability claim built from a guess.
 */
export interface ProgramSource {
  programsFor(observationId: string, blobHash: string | null): readonly string[] | null;
}

interface Raw {
  observation_id: string;
  exact_transaction_blob: string | null;
  route_labels: string | null;
  static_account_keys: string | null;
  lookup_tables: string | null;
  simulation_effect: string | null;
  status: string | null;
  mode: string | null;
  simulated_effect_ok: number | null;
  simulator_feature_set: string | null;
  validity: string | null;
}

export function buildCapabilityMatrix(db: Db, source?: ProgramSource): CapabilityRow[] {
  let rows: Raw[] = [];
  try {
    rows = db
      .prepare(
        `SELECT o.observation_id, o.exact_transaction_blob, o.route_labels, o.static_account_keys, o.lookup_tables,
                o.simulation_effect, s.status, s.mode, s.simulated_effect_ok,
                s.simulator_feature_set, s.validity
         FROM execution_observations o
         LEFT JOIN simulation_jobs s ON s.execution_observation_id = o.observation_id`,
      )
      .all() as unknown as Raw[];
  } catch {
    return [];
  }

  const groups = new Map<string, { row: Raw[]; labels: string; programs: string[]; tokenPrograms: string[]; tables: number }>();

  for (const r of rows) {
    let keys: string[] = [];
    try {
      keys = JSON.parse(r.static_account_keys ?? '[]') as string[];
    } catch {
      keys = [];
    }
    let tables: string[] = [];
    try {
      tables = JSON.parse(r.lookup_tables ?? '[]') as string[];
    } catch {
      tables = [];
    }
    const tokenPrograms = keys.filter((k) => TOKEN_PROGRAMS.has(k));

    // The programs the transaction actually invokes, read from the captured
    // bytes. Null means no blob was captured, and the fingerprint then rests on
    // the route labels alone rather than on the per-trade account soup.
    const invoked = source?.programsFor(r.observation_id, r.exact_transaction_blob) ?? null;
    const programs = invoked === null ? [] : [...invoked];

    const fp = fingerprintOf({
      routeLabels: r.route_labels ?? '',
      programs,
      tokenPrograms,
      lookupTableCount: tables.length,
      simulatorFeatureSet: r.simulator_feature_set,
    });
    const g = groups.get(fp) ?? {
      row: [],
      labels: r.route_labels === null || r.route_labels === '' ? '(no labels)' : r.route_labels,
      programs,
      tokenPrograms,
      tables: tables.length,
    };
    g.row.push(r);
    groups.set(fp, g);
  }

  const out: CapabilityRow[] = [];
  for (const [fingerprint, g] of groups) {
    const seen = new Set(g.row.map((r) => r.observation_id));
    const jit = g.row.filter((r) => r.mode === 'DEVELOPMENT_JIT');
    const offline = g.row.filter((r) => r.mode === 'CONFIRMATORY_OFFLINE');
    const jitOk = jit.filter((r) => r.status === 'SIMULATED_OK').length;
    const jitFailed = jit.filter((r) => r.status === 'SIMULATION_FAILED').length;
    const offlineOk = offline.filter((r) => r.status === 'SIMULATED_OK').length;
    const offlineFailed = offline.filter((r) => r.status === 'SIMULATION_FAILED').length;
    const effectOk = g.row.filter((r) => r.simulated_effect_ok === 1).length;
    // Only jobs written after the P2 repair say anything at all.
    const valid = g.row.filter((r) => r.validity !== null && r.validity !== 'INSTRUMENT_DEVELOPMENT');

    let cls: EvidenceClass = 'STRUCTURAL_ONLY';
    let reason: string | null = null;
    if (valid.length === 0) {
      reason =
        'every simulation of this fingerprint predates the leg-shaped request; those jobs measured the instrument';
    } else if (effectOk === 0) {
      reason = 'no run of this fingerprint has passed economic effect verification';
    } else if (offlineOk === 0) {
      cls = 'JIT_EFFECT_VALID';
      reason = 'effect-verified under JIT only; no offline replay has reproduced it';
    } else if (offlineFailed > 0) {
      cls = 'JIT_EFFECT_VALID';
      reason = `${offlineFailed} offline replay(s) of this fingerprint failed; reproducibility is not established`;
    } else {
      cls = 'OFFLINE_REPRODUCIBLE';
      reason = 'reproducible offline; CONFIRMATORY additionally requires a preregistered context and a clean commit';
    }

    out.push({
      fingerprint,
      routeLabels: g.labels,
      topLevelPrograms: g.programs.slice(0, 8),
      tokenPrograms: g.tokenPrograms,
      lookupTables: g.tables,
      observations: seen.size,
      jitOk,
      jitFailed,
      offlineOk,
      offlineFailed,
      effectOk,
      supportedEvidenceClass: cls,
      failureReason: reason,
    });
  }

  return out.sort((a, b) => b.observations - a.observations);
}
