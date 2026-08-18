import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { reserveCandidate } from '../../packages/storage/src/reservation-repo.js';
import { insertCounterfactualMark } from '../../packages/pipeline/src/counterfactual.js';

const NOW = 1_760_000_000_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const tmp = (): string => mkdtempSync(join(tmpdir(), 'epitaxy-resv-'));
const freshDb = (dir: string): ReturnType<typeof openDb> =>
  openDb({ path: join(dir, 'resv.db'), skipBackup: true });
import { measureEntityTier, oldestSignatureOf } from '../../packages/pipeline/src/entity-tier.js';
import { entityAdjustedConcentration } from '../../packages/intelligence/src/risk-facts-order.js';

/**
 * MT047 — the entity gate compares a share of SUPPLY, because that is what its
 * limit means.
 *
 * `admitCandidate` checks two concentration figures against two limits. The raw
 * tier feeds it `held / supply.amount`. The entity tier was feeding it
 * `concentration().topEntityBps[10]`, which is a share of the holders that
 * function was handed — a different quantity, compared against a limit written
 * for the first one.
 *
 * Measured 2026-08-17: the raw share across the corpus runs 11.4% to 47.2% of
 * supply, and the entity figure was arriving at 71.0%, 74.9%, 92.5% and 97.3%.
 * The gate refused every candidate — including a 28.4 SOL pool that passed
 * depth, mint safety, mayhem and cashback, whose only refusal was
 * "entity-adjusted share 71.0% vs limit 50.0%".
 *
 * A gate that refuses 100% of the population it is defined over is measuring
 * its own units, not the risk.
 */

/** Twenty holders, each 1% of supply, none linked. */
function stubRpc(opts: {
  readonly holderAtoms: bigint;
  readonly holders: number;
  readonly supply: bigint;
  /** Wallets sharing one funder, so a cluster actually forms. */
  readonly sharedFunderCount?: number;
}) {
  const accounts = Array.from({ length: opts.holders }, (_, i) => ({
    address: `TokenAccount${i}`,
    amount: opts.holderAtoms,
  }));
  const shared = opts.sharedFunderCount ?? 0;
  return {
    getTokenLargestAccounts: async () => ({ accounts }),
    getTokenSupply: async () => ({ amount: opts.supply, decimals: 6 }),
    getTokenAccountOwners: async (tokenAccounts: readonly string[]) =>
      new Map(
        tokenAccounts.map((t) => [
          t,
          { owner: `Owner${t.replace('TokenAccount', '')}`, systemOwned: true, ownerProgram: null },
        ]),
      ),
    getSignaturesForAddress: async (address: string) => [
      { signature: `sig-${address}`, blockTime: 1, slot: 1, failed: false },
    ],
    getTransactionFeePayer: async (signature: string) => {
      const idx = Number(signature.replace('sig-TokenAccount', ''));
      // The first `shared` wallets were all funded by one payer, so they
      // collapse into a single entity and the entity figure exceeds the address
      // figure — which is the gap the tier exists to find.
      return Number.isFinite(idx) && idx < shared ? 'CommonFunder' : `Funder${idx}`;
    },
  };
}

describe('MT047 — the entity tier reports a share of SUPPLY', () => {
  it('twenty holders at 1% of supply each read as 10%, not as 50% of themselves', async () => {
    const r = await measureEntityTier(
      stubRpc({ holderAtoms: 1_000_000n, holders: 20, supply: 100_000_000n }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(r.refusal).toBeNull();
    // Top 10 ENTITIES of 20 unlinked holders = half of what the examined set
    // holds, and the examined set is 20% of supply.
    expect(r.clusteredShareOfExamined).toBeCloseTo(0.5, 3);
    expect(r.clusteredShare).toBeCloseTo(0.1, 3);
    expect(r.addressShare).toBeCloseTo(0.1, 3);
    // And it is admissible against a 50%-of-supply limit, which the
    // within-holders figure never could be.
    expect(r.clusteredShare).toBeLessThan(0.5);
    expect(r.clusteredShareOfExamined).not.toBeLessThan(0.5);
  });

  it('the GAP between entity and address survives the rebase — it is the point', async () => {
    const linked = await measureEntityTier(
      stubRpc({ holderAtoms: 1_000_000n, holders: 20, supply: 100_000_000n, sharedFunderCount: 8 }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(linked.refusal).toBeNull();
    // Eight wallets collapse into one entity, so the top-10 ENTITY share must
    // exceed the top-10 ADDRESS share on the same denominator.
    expect(linked.entityCount).toBeLessThan(linked.addressCount);
    expect(linked.clusteredShare).toBeGreaterThan(linked.addressShare);
    expect(linked.clusteredShareOfExamined).toBeGreaterThan(linked.addressShareOfExamined);
  });

  it('a zero supply is a refusal, never a share of zero', async () => {
    const r = await measureEntityTier(
      stubRpc({ holderAtoms: 1n, holders: 20, supply: 0n }) as never,
      { mint: 'M', poolBaseVault: null },
    );
    expect(r.refusal).toMatch(/zero supply/);
    // And a refusal must never reach the gate as a measured safe number.
    expect(entityAdjustedConcentration({ histories: r.histories, clusteredShare: r.clusteredShare }).kind).toBe(
      'HISTORY_INCOMPLETE',
    );
  });

  it('an incomplete walk still refuses, whatever the denominator', async () => {
    // A page that comes back FULL has not proved anything is older, so the walk
    // is incomplete and the share is a lower bound rather than a fact.
    const full = Array.from({ length: 1_000 }, (_, i) => ({
      signature: `s${i}`,
      blockTime: 1,
      slot: 1,
      failed: false,
    }));
    const o = await oldestSignatureOf(
      { getSignaturesForAddress: async () => full } as never,
      'A',
      2,
    );
    expect(o.reachedEarliest).toBe(false);
    expect(o.pagesWalked).toBe(2);
    expect(
      entityAdjustedConcentration({
        histories: [{ reachedEarliestSignature: false, pagesWalked: 2, links: [] }],
        clusteredShare: 0.01,
      }).kind,
    ).toBe('HISTORY_INCOMPLETE');
  });
});

describe('an abandoned window must not sterilise a mint forever', () => {
  /**
   * MEASURED 2026-08-17. This repair froze a contract at each commit as defects
   * were found, and each abandoned window took its mints out of supply
   * permanently: `reserveCandidate` refuses a mint with ANY open trajectory,
   * and an abandoned window's trajectories are never marked and never settle.
   *
   * Seven mints — every deep pool the collector had reached — were removed that
   * way, and the next window sat at zero opens for three cycles against a queue
   * of drained pools.
   *
   * The rule itself is right: two concurrent trajectories on one pool share a
   * mark path and duplicate each other exactly. That reason is about ONE
   * experiment, and the scope has to match it.
   */
  const seed = (db: ReturnType<typeof openDb>, id: string, mint: string, ctx: string): void => {
    // The context row first: trajectory_evidence_context has a foreign key to
    // it, and without this the insert below fails rather than the reservation.
    db.prepare(
      `INSERT OR IGNORE INTO evidence_contexts
         (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms,
          closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
       VALUES (?, ?, 'aaa', 0, ?, NULL, 'DEVELOPMENT_EVIDENCE', '[]', NULL, NULL)`,
    ).run(ctx, HASH_A, NOW);
    db.prepare(
      `INSERT INTO development_trajectories
         (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
          venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
          migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
          state, evidence_grade, max_attainable_grade, opened_utc_ms, refusals)
       VALUES (?, ?, ?, ?, 'PUMPSWAP_DIRECT', 'Pool1', ?, ?, ?, 'FIRST_HOUR', 'S',
               NULL, '20000000', '{}', 'HARD_GATES_RANDOM', 'FIXED_15M_CONTROL',
               'AWAITING_FILL_OBSERVATION', 'SIMULATED_EXECUTION', 'SIMULATED_EXECUTION', ?, '[]')`,
    ).run(id, `obs-${id}`, `job-${id}`, `set-${id}`, HASH_B, HASH_A, mint, NOW);
    db.prepare(
      `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
       VALUES (?, ?, ?)`,
    ).run(id, ctx, NOW);
  };

  it('an open trajectory in ANOTHER context does not block a reservation', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seed(db, 't-abandoned', 'MintA', 'ctx-abandoned');

      // Corpus-wide, which is what a caller with no context gets: refused.
      expect(() =>
        reserveCandidate(db, {
          windowId: 'W',
          mint: 'MintA',
          maxPerMint: 3,
          ownerSessionId: 's',
          nowMs: NOW,
        }),
      ).toThrow(/already has 1 open trajectory/);

      // Scoped to the live window, which holds nothing for this mint: allowed.
      const r = reserveCandidate(db, {
        windowId: 'W',
        mint: 'MintA',
        maxPerMint: 3,
        ownerSessionId: 's',
        nowMs: NOW,
        evidenceContextId: 'ctx-live',
      });
      expect(r.mint).toBe('MintA');
      db.close();
    } finally {
      // Windows keeps a handle on the SQLite file briefly after close, and an
      // EPERM here MASKS the assertions above — that is how a real constraint
      // violation once got reported as a cleanup error. The OS owns the temp
      // directory after this.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('an open trajectory in THIS context still blocks it', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seed(db, 't-live', 'MintB', 'ctx-live');
      expect(() =>
        reserveCandidate(db, {
          windowId: 'W',
          mint: 'MintB',
          maxPerMint: 3,
          ownerSessionId: 's',
          nowMs: NOW,
          evidenceContextId: 'ctx-live',
        }),
      ).toThrow(/already has 1 open trajectory\(ies\) in ctx-live/);
      db.close();
    } finally {
      // Windows keeps a handle on the SQLite file briefly after close, and an
      // EPERM here MASKS the assertions above — that is how a real constraint
      // violation once got reported as a cleanup error. The OS owns the temp
      // directory after this.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });
});

describe('a refused counterfactual is representable; a priced one outside the bound is not', () => {
  /**
   * MEASURED 2026-08-17. `boundedCounterfactual` refuses when the entry moved
   * the pool past the frozen bound, and the collector records that refusal —
   * class BOUNDED_COUNTERFACTUAL_V1, a null exit, the reason — because a mark
   * with no counterfactual row and a mark whose counterfactual was REFUSED are
   * different facts and only the second is countable.
   *
   * The table's CHECK forbade exactly that row, so the insert threw and killed
   * the mark pass mid-run. Six passes in one window died this way and the gate
   * read the crash as "0 marks over 0 open trajectories" — an apparatus failure
   * wearing the shape of an idle collector.
   *
   * The guarantee is unchanged: no PRICED bounded row outside the bound.
   */
  const seedMark = (db: ReturnType<typeof openDb>, id: string, offset: number): void => {
    db.prepare(
      `INSERT OR IGNORE INTO evidence_contexts
         (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms,
          closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
       VALUES ('ctx-cf', ?, 'aaa', 0, ?, NULL, 'DEVELOPMENT_EVIDENCE', '[]', NULL, NULL)`,
    ).run(HASH_A, NOW);
    db.prepare(
      `INSERT INTO development_trajectories
         (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
          venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
          migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
          state, evidence_grade, max_attainable_grade, opened_utc_ms, refusals)
       VALUES (?, ?, ?, ?, 'PUMPSWAP_DIRECT', 'Pool1', ?, ?, 'MintCF', 'FIRST_HOUR', 'S',
               NULL, '20000000', '{}', 'HARD_GATES_RANDOM', 'FIXED_15M_CONTROL',
               'AWAITING_FILL_OBSERVATION', 'SIMULATED_EXECUTION', 'SIMULATED_EXECUTION', ?, '[]')`,
    ).run(id, `obs-${id}`, `job-${id}`, `set-${id}`, HASH_B, HASH_A, NOW);
    db.prepare(
      `INSERT INTO trajectory_marks
         (trajectory_id, offset_ms, observed_utc_ms, executable_lamports, exit_capacity_lamports,
          effective_quote_reserve, refusal, lateness_ms, sla_status, due_utc_ms, sla_bound_ms)
       VALUES (?, ?, ?, '1', '1', '1', NULL, 0, 'ON_TIME', ?, 10000)`,
    ).run(id, offset, NOW, NOW);
  };

  const row = (over: Record<string, unknown>) => ({
    trajectoryId: 't-cf',
    offsetMs: 60_000,
    evidenceClass: 'BOUNDED_COUNTERFACTUAL_V1' as const,
    contractVersion: 'counterfactual-v1',
    entryBaseDeltaAtoms: -1n,
    entryQuoteDeltaLamports: 1n,
    observedBaseReserve: 1n,
    observedQuoteReserve: 1n,
    adjustedBaseReserve: 0n,
    adjustedQuoteReserve: 0n,
    haircutFormula: 'none',
    haircutBps: 0,
    haircutLamports: 0n,
    entryImpactBps: 900,
    counterfactualExitLamports: null as bigint | null,
    evidenceGrade: 'DEVELOPMENT' as const,
    refusal: 'IMPACT_ABOVE_BOUND: the entry moved the pool 900 bps',
    nowMs: NOW,
    ...over,
  });

  it('a REFUSAL far outside the bound is written, not thrown', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedMark(db, 't-cf', 60_000);
      expect(() => insertCounterfactualMark(db, row({}))).not.toThrow();
      const stored = db
        .prepare('SELECT refusal, counterfactual_exit_lamports x FROM counterfactual_marks WHERE trajectory_id = ?')
        .get('t-cf') as { refusal: string; x: string | null };
      expect(stored.refusal).toMatch(/IMPACT_ABOVE_BOUND/);
      expect(stored.x).toBeNull();
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('a PRICED bounded row outside the bound is still REFUSED by the schema', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedMark(db, 't-cf', 60_000);
      expect(() =>
        insertCounterfactualMark(db, row({ refusal: null, counterfactualExitLamports: 1_000n })),
      ).toThrow(/CHECK constraint failed/);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });
});

/**
 * S087 — the contract owns the window, and the window is not a label.
 *
 * `contract:freeze` defaults to DEV_WINDOW_5D24E; `trajectory:collect` defaults
 * to DEV_WINDOW_V1; nothing compared them. `windowId` seeds the entry-policy
 * randomisation (`seed: ${windowId}:${policy}`), scopes exploration
 * entitlements and namespaces every reservation, so the two defaults are two
 * different experiments.
 *
 * Measured 2026-08-18: a collector started with no `--window` opened
 * ctx-5f5a6dc3f761-DEV_WINDOW_V1 while the frozen contract owned
 * ctx-5f5a6dc3f761-DEV_WINDOW_5D24E, and a trajectory landed in a context the
 * readiness gate does not read.
 *
 * These check the storage half — that a contract can state its window and that
 * the statement survives a round trip — which is what the collector's adopt and
 * refuse both read.
 */
describe('S087 — a frozen contract states the window it owns', () => {
  const insertContract = (db: ReturnType<typeof openDb>, id: string, windowId: string | null): void => {
    db.prepare(
      `INSERT INTO evidence_contexts
         (evidence_context_id, context_hash, source_commit, tree_dirty, opened_utc_ms, validity, reasons)
       VALUES (?, ?, ?, 0, ?, 'DEVELOPMENT_EVIDENCE', '[]')`,
    ).run(`ctx-${id}`, HASH_A, 'c'.repeat(40), NOW);
    db.prepare(
      `INSERT INTO experiment_contracts
         (contract_id, evidence_context_id, frozen_utc_ms, source_commit, context_hash,
          collector_version, kernel_version, route_fingerprint, capability_fingerprint,
          notional_rule, cohort, entry_policies, exit_policies, mark_sla_ms,
          counterfactual_contract, cashback_treatment, mayhem_treatment, cost_rent_treatment,
          risk_facts, thresholds, claimed_invariants, contract_hash, window_id)
       VALUES (?, ?, ?, ?, ?, 'v', 'v', 'PUMPSWAP_DIRECT', ?, 'fixed', 'FIRST_HOUR', '[]', '[]', 10000,
               'counterfactual-v1', 'none', 'none', 'none', '[]', '{}', '[]', ?, ?)`,
    ).run(id, `ctx-${id}`, NOW, 'c'.repeat(40), HASH_A, HASH_B, HASH_B, windowId);
  };

  it('round-trips the window id the freeze stated', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertContract(db, 'contract-owns', 'DEV_WINDOW_5D24E');
      const got = db
        .prepare('SELECT window_id w FROM experiment_contracts WHERE contract_id = ?')
        .get('contract-owns') as { w: string | null };
      expect(got.w).toBe('DEV_WINDOW_5D24E');
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('a contract frozen before the column existed reads NULL, which is absence and not disagreement', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertContract(db, 'contract-legacy', null);
      const got = db
        .prepare('SELECT window_id w FROM experiment_contracts WHERE contract_id = ?')
        .get('contract-legacy') as { w: string | null };
      expect(got.w).toBeNull();
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });
});
