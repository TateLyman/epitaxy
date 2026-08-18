import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertQuoteStateSurvived, QuoteStateMoved } from '../../packages/simulator/src/sequential-worker.js';

import { openDb } from '../../packages/storage/src/db.js';
import {
  TrajectoryCollectorLock,
  pidStillOwns,
  CollectorLockRefused,
  DirtyEvidenceCollection,
  evidenceContextValidity,
  readTreeState,
  TRAJECTORY_COLLECTOR_LOCK,
  SCREENING_COLLECTOR_LOCK,
} from '../../packages/storage/src/collector-lock.js';
import {
  reserveCandidate,
  resolveReservation,
  abandonReservation,
  ReservationRefused,
  capBreaches,
} from '../../packages/storage/src/reservation-repo.js';
import {
  EvidenceStore,
  appendOnly,
  EvidenceConflict,
  AffectedRowMismatch,
} from '../../packages/storage/src/evidence-repo.js';
import {
  observationId,
  workerJobId,
  settlementIdFor,
  capabilityFingerprintOf,
  assertIsHash,
  NotAHash,
  type CapabilityFields,
} from '../../packages/domain/src/evidence-identity.js';
import {
  insertTrajectory,
  insertTrajectorySettlement,
  persistTrajectoryEconomics,
  settleTrajectory,
  migrationCandidates,
} from '../../packages/storage/src/trajectory-repo.js';
import { insertMark, insertPolicyOutcome, closeTrajectory } from '../../packages/storage/src/mark-repo.js';
import { attributeSoleVenue } from '../../packages/domain/src/trajectory-evidence.js';
import {
  buildTrajectorySettlement,
  checkIdentities,
  DURABLE_EVIDENCE,
} from '../../packages/domain/src/trajectory-settlement.js';
import type { MeasuredLegSettlement } from '../../packages/domain/src/settlement.js';
import { classifyMark, dueMarks, nextWakeMs, discoveryAdmissible, MARK_SLA_MS } from '../../packages/pipeline/src/mark-scheduler.js';
import {
  boundedCounterfactual,
  replayCounterfactual,
  calibrate,
  admissibleForPnl,
  CounterfactualRefused,
  BOUNDED_IMPACT_CAP_BPS,
} from '../../packages/pipeline/src/counterfactual.js';
import { decideEntry, decideExit, ENTRY_POLICIES } from '../../packages/strategy/src/treatments.js';
import type { PreEntryFeatures } from '../../packages/strategy/src/treatments.js';
import { pairLegAccounts } from '../../packages/pipeline/src/persist-evidence.js';
import { planFromEncodedTransaction, assertPlanMatchesBytes, freezeAccountPlan, AccountPlanIncomplete } from '../../packages/solana/src/account-plan.js';
import { compileMessage, encodeUnsignedTransaction } from '../../packages/solana/src/encode.js';

/**
 * P17 — the mutation and runtime tests the 5d24e39 directive requires.
 *
 * Every one of these FAILS against `5d24e39` and passes here. That is the whole
 * point: the 8f73cef audit found 26 invariants failing while `pnpm check`
 * reported 124 test files and 1,817 tests all green. A suite that agrees with a
 * defective system is not a suite, and "tests over comments, names or source
 * substrings do not count" is the directive's own rule — so nothing below
 * asserts on a comment, a function name or a source substring.
 */

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = 1_700_000_000_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'epitaxy-p17-'));
}

function freshDb(dir: string): ReturnType<typeof openDb> {
  return openDb({ path: join(dir, 'p17.db'), skipBackup: true });
}

function trajectoryRow(id: string, mint = 'Mint1'): Record<string, unknown> {
  return {
    identity: {
      trajectoryId: id,
      entryObservationId: `obs-${id}`,
      entrySimulationJobId: `job-${id}`,
      entrySettlementId: `set-${id}`,
      venue: 'PUMPSWAP_DIRECT',
      pool: 'Pool1',
      capabilityFingerprint: HASH_B,
      snapshotHash: HASH_A,
      mint,
      cohort: 'FIRST_HOUR',
      stratum: 'S',
      migrationAgeMs: null,
      notionalLamports: 20_000_000n,
      entryPolicyInputs: {},
    },
    entryPolicy: 'HARD_GATES_RANDOM',
    exitPolicy: 'FIXED_15M_CONTROL',
    state: 'AWAITING_FILL_OBSERVATION',
    impact: {
      quoteImpactRatio: 0.001,
      baseImpactRatio: 0.001,
      maxImpactRatio: 0.001,
      haircutBps: 25,
      withinSmallImpactBound: true,
      boundUsed: 0.005,
    },
    maxAttainableGrade: 'SIMULATED_EXECUTION',
    refusals: [],
    openedUtcMs: NOW,
  };
}

// ---------------------------------------------------------------------------
// 1–4  ONE COLLECTOR, ONE OWNER, ONE PROVENANCE
// ---------------------------------------------------------------------------

describe('P17 1–4 — one collector, one owner, one provenance', () => {
  it('1 — a SECOND collector is refused while the first holds a live lock', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const first = new TrajectoryCollectorLock(db, {
        mode: 'observe',
        sourceCommit: 'aaa',
        now: () => NOW,
        // The first holder is a live pid that is NOT us, so the second attempt
        // sees exactly what a second daemon would.
        pidAlive: () => true,
      });
      first.acquire();

      // Simulate a different process by rewriting the owner pid.
      db.prepare('UPDATE process_locks SET pid = 999999 WHERE lock_name = ?').run(TRAJECTORY_COLLECTOR_LOCK);

      const second = new TrajectoryCollectorLock(db, {
        mode: 'observe',
        sourceCommit: 'bbb',
        now: () => NOW + 1_000,
        pidAlive: () => true,
      });
      expect(() => second.acquire()).toThrow(CollectorLockRefused);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2 — a stale takeover needs a DEAD pid AND a stale heartbeat, not either alone', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const seed = (pid: number, heartbeatMs: number): void => {
        db.prepare(
          `INSERT INTO process_locks (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode, source_commit, command_line)
           VALUES (?, ?, 'h', ?, ?, 'observe', 'aaa', 'x')
           ON CONFLICT(lock_name) DO UPDATE SET pid=excluded.pid, heartbeat_utc_ms=excluded.heartbeat_utc_ms`,
        ).run(TRAJECTORY_COLLECTOR_LOCK, pid, heartbeatMs, heartbeatMs);
      };
      const attempt = (alive: boolean, nowMs: number): TrajectoryCollectorLock =>
        new TrajectoryCollectorLock(db, {
          mode: 'observe',
          sourceCommit: 'bbb',
          staleAfterMs: 90_000,
          now: () => nowMs,
          pidAlive: () => alive,
        });

      // live pid + stale heartbeat -> a HUNG collector, not an abandoned lock.
      seed(999999, NOW);
      expect(() => attempt(true, NOW + 200_000).acquire()).toThrow(/ALIVE but its heartbeat/);

      // dead pid + fresh heartbeat -> it may still be shutting down.
      seed(999999, NOW);
      expect(() => attempt(false, NOW + 1_000).acquire()).toThrow(/only \d+s old/);

      // dead pid + stale heartbeat -> the ONLY permitted takeover.
      seed(999999, NOW);
      const taken = attempt(false, NOW + 200_000).acquire();
      expect(taken.pid).toBe(process.pid);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2b — the trajectory collector does NOT share the screening collector lock name', () => {
    // `pnpm health` printed OK against `collector` — a row about a different
    // program — while five instances of THIS program ran unlocked beside it.
    expect(TRAJECTORY_COLLECTOR_LOCK).not.toBe(SCREENING_COLLECTOR_LOCK);
  });

  it('3 — a TEN-process race cannot breach maxPerMint', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const outcomes: string[] = [];
      for (let i = 0; i < 10; i++) {
        try {
          const r = reserveCandidate(db, {
            windowId: 'W',
            mint: 'RaceMint',
            maxPerMint: 3,
            ownerSessionId: `s${i}`,
            nowMs: NOW + i,
          });
          // A reservation is only permanent once it OPENS. Ten racers each take
          // one, open it, and try again — which is exactly the pattern that
          // produced 58 trajectories on one mint.
          resolveReservation(db, r.reservationId, `traj-${i}`, NOW + i);
          outcomes.push('RESERVED');
        } catch (e) {
          expect(e).toBeInstanceOf(ReservationRefused);
          outcomes.push((e as ReservationRefused).code);
        }
      }
      expect(outcomes.filter((o) => o === 'RESERVED')).toHaveLength(3);
      expect(capBreaches(db, 'W')).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3d — an unresolved reservation from a DEAD session is reclaimable', () => {
    /**
     * A collector that crashes between reserving and opening leaves the row
     * RESERVED, and the partial unique index then blocks that mint FOREVER.
     * Measured during the first clean window: three mints became permanently
     * unreachable after runs that died on a serialisation error, a reserved
     * word and a hash mismatch — none of which is a reason to retire a
     * candidate.
     *
     * Both conditions are required, the same rule the collector lock uses: a
     * live owner keeps its reservation however old, and a dead owner's fresh
     * reservation is left alone in case it is still shutting down.
     */
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const session = (id: string, ended: number | null, heartbeat: number): void => {
        db.prepare(
          `INSERT INTO collector_sessions
             (session_id, started_utc_ms, heartbeat_utc_ms, ended_utc_ms, mode, source_commit, dirty, pid, endpoint)
           VALUES (?, ?, ?, ?, 'observe', 'aaa', 0, 1, 'e')`,
        ).run(id, NOW, heartbeat, ended);
      };
      session('dead', NOW, NOW);
      session('alive', null, NOW);

      // The pid is INJECTED, so the test states which owners are alive rather
      // than depending on whatever pid 1 happens to be on the host.
      const livePids = new Set<number>([1]);
      const reserve = (owner: string, nowMs: number): string =>
        reserveCandidate(db, {
          windowId: 'W',
          mint: 'M',
          maxPerMint: 3,
          ownerSessionId: owner,
          nowMs,
          staleReservationMs: 60_000,
          pidAlive: (pid) => livePids.has(pid),
        }).reservationId;

      /**
       * A HEARTBEATING owner keeps its reservation.
       *
       * "Alive" is the heartbeat, not the absence of `ended_utc_ms`. A session
       * with a null `ended_utc_ms` and a stale heartbeat is the KILLED case —
       * seven pre-repair sessions were exactly that — so it must not count as
       * alive here either.
       */
      reserve('alive', NOW);
      db.prepare('UPDATE collector_sessions SET heartbeat_utc_ms = ? WHERE session_id = ?').run(NOW + 30_000, 'alive');
      expect(() => reserve('other', NOW + 40_000)).toThrow(/already holds/);

      /**
       * An ENDED owner is reclaimable IMMEDIATELY, with no timer.
       *
       * A session that wrote `ended_utc_ms` and left a reservation RESERVED
       * crashed between reserving and opening. Waiting fifteen minutes to
       * conclude that would make every such failure cost fifteen minutes of
       * collection — measured: four mints were unreachable behind reservations
       * from runs that had died seconds earlier.
       *
       * The reason this is safe is the `trajectory_collector` lock: it is held
       * EXCLUSIVELY, so no other trajectory collector is running and a RESERVED
       * row owned by a different session is not being worked on by anyone.
       */
      db.exec("UPDATE trajectory_reservations SET owner_session_id = 'dead' WHERE mint = 'M'");
      const taken = reserve('other', NOW + 1_000);
      expect(taken.length).toBeGreaterThan(0);
      const abandoned = Number(
        (
          db.prepare("SELECT COUNT(*) c FROM trajectory_reservations WHERE status = 'ABANDONED'").get() as {
            c: number;
          }
        ).c,
      );
      expect(abandoned).toBe(1);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('3c — a candidate REFUSED once is retryable in the same window', () => {
    /**
     * `abandonReservation` frees the ordinal for COUNTING, but the abandoned
     * row still occupied the deterministic primary key its own retry needed —
     * so the retry failed on the PRIMARY KEY and reported RESERVATION_RACE_LOST
     * in a window with one process and no race at all.
     *
     * Measured 2026-08-17: eleven admissible, deep, under-cap pools were
     * refused for exactly this on the pass after the one that abandoned them. A
     * window could only ever open the mints that succeeded on their FIRST
     * attempt, and a transient refusal removed a mint permanently.
     *
     * A refusal is a fact about an instant, not about a mint.
     */
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const take = (): string =>
        reserveCandidate(db, {
          windowId: 'W',
          mint: 'RETRY',
          maxPerMint: 3,
          ownerSessionId: 's',
          nowMs: NOW,
        }).reservationId;

      const first = take();
      abandonReservation(db, first, NOW, 'MECHANICS_FAILED');
      const second = take();
      expect(second).not.toBe(first);
      abandonReservation(db, second, NOW, 'MECHANICS_FAILED');
      const third = take();
      expect(third).not.toBe(second);

      // Abandoned rows are HISTORY: they are preserved, and they do not consume
      // the cap. Three refusals must not exhaust a cap of three.
      resolveReservation(db, third, 'traj-1', NOW);
      expect(capBreaches(db, 'W')).toEqual([]);
      const kept = Number(
        (db.prepare('SELECT COUNT(*) c FROM trajectory_reservations WHERE mint = ?').get('RETRY') as { c: number }).c,
      );
      expect(kept).toBe(3);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('3b — a permanently-refused population cannot starve the candidate queue', () => {
    /**
     * Least-sampled-first is right, and combined with a gate that PERMANENTLY
     * refuses part of the population it is self-defeating: a drained pool is
     * refused on depth, so it is never sampled, so it stays least-sampled, so
     * it returns to the head of the queue on the very next cycle. Forever.
     *
     * Measured 2026-08-17: 38 of 58 live pools were deep enough and 11 were
     * still under the cap, while the collector refused EVERY candidate it saw
     * on depth — because the head was permanently occupied by the drained ones.
     */
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const migration = (mint: string, slot: number): void => {
        db.prepare(
          `INSERT INTO confirmed_migrations
             (signature, instruction_index, program_id, mint, bonding_curve, canonical_pool,
              pool_base_token_account, pool_quote_token_account, quote_mint, creator,
              slot, block_time, commitment, reversal_status, identity_source, observed_utc_ms)
           VALUES (?, 0, 'P', ?, 'B', ?, 'BV', 'QV', 'Q', 'C', ?, NULL, 'confirmed', 'CONFIRMED', 'src', ?)`,
        ).run(`sig-${mint}`, mint, `pool-${mint}`, slot, NOW);
      };
      const riskFacts = (mint: string, refusedForDepth: boolean): void => {
        db.prepare(
          `INSERT INTO candidate_risk_facts
             (mint, pool, collected_utc_ms, trajectory_id, mint_overall, freeze_authority,
              mint_authority, permanent_delegate, transfer_hook, transfer_fee_kind, mayhem_source,
              breadth_usability, concentration_kind, canonical_pool, stratum, admitted, refusals)
           VALUES (?, ?, ?, NULL, 'OK', 'NONE', 'NONE', 'NONE', 'NONE', 'NOT_APPLICABLE', 'DECODED',
                   'USABLE', 'MEASURED', 1, 'S', 0, ?)`,
        ).run(
          mint,
          `pool-${mint}`,
          NOW,
          refusedForDepth
            ? JSON.stringify(["the entry is 568.1% of the pool's effective quote reserve, over the 0.5% bound"])
            : '[]',
        );
      };

      // DRAINED is never sampled and therefore always least-sampled. DEEP has
      // already produced one trajectory, so under a pure least-sampled-first
      // ordering it would sit BEHIND the drained one forever.
      migration('DRAINED', 100);
      riskFacts('DRAINED', true);
      migration('DEEP', 99);
      riskFacts('DEEP', false);
      insertTrajectory(db, trajectoryRow('t-deep', 'DEEP') as never);
      closeTrajectory(db, 't-deep', NOW);

      const queue = migrationCandidates(db, 10, 3).map((c) => c.mint);
      expect(queue).toEqual(['DEEP', 'DRAINED']);
      db.close();
    } finally {
      /**
       * Windows can hold the WAL/SHM handles past `close()`, and this test
       * writes to four tables so it sees it where lighter ones do not.
       *
       * The cleanup is housekeeping; the assertion above already ran. Failing
       * the test on a temp-directory removal would report a queue-ordering
       * defect that is not there — which is the exact substitution this file
       * exists to prevent.
       */
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  });

  it('4a — the porcelain status is parsed so the PATH survives intact', () => {
    /**
     * `git status --porcelain` emits `XY PATH`, and for a file modified but not
     * staged X is a SPACE. Trimming the whole output before splitting removes
     * it, so a fixed slice(3) eats the first character of the path:
     *
     *     " M artifacts/x.json"  ->  "rtifacts/x.json"
     *
     * Every dirty file was reported under a mangled name, and the artifacts/
     * exemption could never match — so the gate refused runs it was built to
     * allow. Found by running it, not by reading it.
     *
     * Asserted against the real repository, whose HEAD is a real commit.
     */
    const t = readTreeState();
    expect(t.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const f of [...t.dirtyFiles, ...t.dirtyArtifacts]) {
      // A path that lost its first character starts mid-word. Every real path
      // in this repository begins with a known top-level directory or is a
      // bare filename with an extension.
      expect(f).toMatch(/^(apps|packages|scripts|tests|docs|config|artifacts|data|offline-worker|ops)\/|^[\w.-]+$/);
    }
    // And artifacts are classified as outputs, never as source.
    for (const f of t.dirtyArtifacts) expect(f.startsWith('artifacts/')).toBe(true);
    for (const f of t.dirtyFiles) expect(f.startsWith('artifacts/')).toBe(false);
  });

  it('4 — a DIRTY tree cannot open an evidence context without saying so', () => {
    const dirty = { commit: 'aaa', dirty: true, dirtyFiles: ['packages/x.ts'], dirtyArtifacts: [] };
    expect(() => evidenceContextValidity(dirty, { instrumentDevelopment: false })).toThrow(
      DirtyEvidenceCollection,
    );
    const quarantined = evidenceContextValidity(dirty, { instrumentDevelopment: true });
    expect(quarantined.validity).toBe('INSTRUMENT_DEVELOPMENT_INVALID');

    /**
     * A modified ARTIFACT is not a dirty tree.
     *
     * An artifact is an OUTPUT of a run, so it cannot make a trajectory
     * non-re-derivable from its commit — which is the whole property this gate
     * protects. Without the distinction the gate is unusable in the one
     * sequence it exists for: contract:freeze writes an artifact, committing it
     * moves HEAD, and the contract it just froze names the previous commit.
     */
    const clean = evidenceContextValidity(
      { commit: 'aaa', dirty: false, dirtyFiles: [], dirtyArtifacts: ['artifacts/x.json'] },
      { instrumentDevelopment: false },
    );
    expect(clean.validity).toBe('DEVELOPMENT_EVIDENCE');
  });
});

// ---------------------------------------------------------------------------
// 5–11  THE EVIDENCE GRAPH
// ---------------------------------------------------------------------------

describe('P17 5–11 — the evidence graph resolves, or the row cannot exist', () => {
  it('5/6/7 — identities are CONTENT-BOUND, so a reader can recompute them', () => {
    const request = { mint: 'M', pool: 'P', notional: '20000000' };
    const jobId = workerJobId(request);
    // The id handed to the worker IS the id inserted. `job-${randomUUID()}`
    // could never satisfy this: it is not a function of anything.
    expect(workerJobId({ pool: 'P', mint: 'M', notional: '20000000' })).toBe(jobId);
    expect(jobId).toMatch(/^job-[0-9a-f]{32}$/);
    expect(workerJobId({ ...request, notional: '20000001' })).not.toBe(jobId);

    const obs = observationId({
      trajectoryId: 't1',
      leg: 'buy',
      purpose: 'DIRECT_VENUE_ENTRY',
      transactionHash: HASH_A,
      snapshotHash: HASH_B,
    });
    expect(
      observationId({
        trajectoryId: 't1',
        leg: 'buy',
        purpose: 'DIRECT_VENUE_ENTRY',
        transactionHash: HASH_A,
        snapshotHash: HASH_B,
      }),
    ).toBe(obs);
    expect(
      observationId({
        trajectoryId: 't1',
        leg: 'sell',
        purpose: 'DIRECT_VENUE_ENTRY',
        transactionHash: HASH_A,
        snapshotHash: HASH_B,
      }),
    ).not.toBe(obs);

    // A settlement id resolves to ONE (job, step, version). Changing the step
    // or the algebra's version produces a different settlement, never a
    // silent replacement of the old one.
    const s = settlementIdFor({ observationId: obs, jobId, stepIndex: 0, settlementVersion: 'v1' });
    expect(settlementIdFor({ observationId: obs, jobId, stepIndex: 1, settlementVersion: 'v1' })).not.toBe(s);
    expect(settlementIdFor({ observationId: obs, jobId, stepIndex: 0, settlementVersion: 'v2' })).not.toBe(s);
  });

  it('8 — a SLOT NUMBER cannot pass as a snapshot hash', () => {
    expect(() => assertIsHash('snapshot_hash', '439747637')).toThrow(NotAHash);
    expect(() => assertIsHash('snapshot_hash', HASH_A)).not.toThrow();

    // And the database refuses it too, so a writer that bypasses the domain
    // check cannot get one in.
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const insert = (hash: string): void => {
        db.prepare(
          `INSERT INTO evidence_blobs (blob_sha256, kind, byte_length, stored_length, compression,
             relative_path, readback_verified, readback_utc_ms, written_utc_ms)
           VALUES (?, 'manifest', 1, 1, 'gzip', 'x', 1, ?, ?)
           ON CONFLICT(blob_sha256) DO NOTHING`,
        ).run(HASH_A, NOW, NOW);
        db.prepare(
          `INSERT INTO coherent_snapshots (snapshot_hash, slot, captured_utc_ms, mint, pool,
             manifest_blob_sha256, account_count, fee_config_hash, capability_fingerprint,
             programdata_hashes, sdk_versions, worker_binary_hash)
           VALUES (?, 439747637, ?, 'M', 'P', ?, 4, NULL, ?, '{}', '{}', NULL)`,
        ).run(hash, NOW, HASH_A, HASH_B);
      };
      expect(() => insert('439747637')).toThrow(/sha256 hex digest/);
      expect(() => insert(HASH_B)).not.toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9 — the capability fingerprint MOVES with fee config, programdata, token program and cashback', () => {
    const base: CapabilityFields = {
      venue: 'PUMPSWAP_DIRECT',
      programId: 'AMM',
      programDataHash: HASH_A,
      tokenProgram: TOKEN_PROGRAM,
      feeConfigHash: HASH_B,
      selectedTier: '1000',
      cashbackEnabled: true,
      workerBinaryHash: HASH_A,
      sdkVersions: { sdk: '1.36.0' },
      protocolVersion: 5,
    };
    const f0 = capabilityFingerprintOf(base);
    const moves: [string, CapabilityFields][] = [
      ['feeConfigHash', { ...base, feeConfigHash: HASH_A }],
      ['programDataHash', { ...base, programDataHash: HASH_B }],
      ['tokenProgram', { ...base, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }],
      ['cashbackEnabled', { ...base, cashbackEnabled: false }],
      ['selectedTier', { ...base, selectedTier: '2000' }],
      ['workerBinaryHash', { ...base, workerBinaryHash: HASH_B }],
      ['sdkVersions', { ...base, sdkVersions: { sdk: '1.37.0' } }],
    ];
    for (const [what, mutated] of moves) {
      expect(capabilityFingerprintOf(mutated), `${what} must move the fingerprint`).not.toBe(f0);
    }
    // Idempotent, and NEVER equal to a snapshot hash over the same inputs.
    expect(capabilityFingerprintOf(base)).toBe(f0);
  });

  it('10 — exact transaction bytes ROUND-TRIP from the blob store', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      const store = new EvidenceStore(db, join(dir, 'blobs'));
      const bytes = Buffer.from('not a real transaction, but exact bytes').toString('base64');
      const hash = store.putDurable('exact_transaction', bytes, NOW);
      expect(store.get<string>(hash)).toBe(bytes);
      expect(store.isDurable(hash)).toBe(true);

      // A blob nobody registered is NOT durable, however plausible its hash.
      expect(store.isDurable(createHash('sha256').update('unregistered').digest('hex'))).toBe(false);

      // A registered blob that never passed read-back is refused.
      db.prepare('UPDATE evidence_blobs SET readback_verified = 0 WHERE blob_sha256 = ?').run(hash);
      expect(() => store.get(hash)).toThrow(/never passed read-back/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11 — every account has a pre AND post state, with ABSENT explicit on both sides', () => {
    const acct = (pubkey: string, lamports: bigint) => ({
      pubkey,
      lamports,
      owner: '11111111111111111111111111111111',
      executable: false,
      rentEpoch: 0n,
      dataLen: 0,
      dataBase64: null,
      dataSha256: '',
      accountHash: '',
    });
    const paired = pairLegAccounts(
      [acct('kept', 10n), acct('closed', 5n)],
      [acct('kept', 8n), acct('created', 2_039_280n)],
      { kept: 'PAYER' },
      new Set(['kept', 'closed', 'created']),
    );
    const by = new Map(paired.map((p) => [p.address, p]));

    // Created by the leg: pre is ABSENT, and that is a MEASUREMENT.
    expect(by.get('created')?.pre).toBeNull();
    expect(by.get('created')?.post).not.toBeNull();
    // Closed by the leg: post is ABSENT.
    expect(by.get('closed')?.pre).not.toBeNull();
    expect(by.get('closed')?.post).toBeNull();
    // Neither is silently added to `unobserved`.
    expect(paired).toHaveLength(3);
    expect(by.get('kept')?.role).toBe('PAYER');
  });
});

// ---------------------------------------------------------------------------
// 12–17  SETTLEMENT IDENTITIES
// ---------------------------------------------------------------------------

function leg(over: Partial<MeasuredLegSettlement> = {}): MeasuredLegSettlement {
  return {
    observationId: 'obs-1',
    simulationJobId: 'job-1',
    side: 'buy',
    family: 'DIRECT_VENUE',
    capabilityFingerprint: HASH_B,
    input: {
      kind: 'native_sol',
      requestedLamports: 20_000_000n,
      actualTradeDebitLamports: 20_000_000n,
      totalPayerDebitLamports: 22_044_280n,
    },
    output: {
      kind: 'token',
      mint: 'Mint1',
      tokenProgram: TOKEN_PROGRAM,
      tokenAccount: 'Ata1',
      minimumAtoms: 0n,
      expectedAtoms: null,
      actualCreditAtoms: 1_000n,
    },
    costs: {
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 0n,
      tipLamports: 0n,
      protocolFeeLamports: null,
      creatorFeeLamports: null,
      lpFeeLamports: null,
      platformFeeLamports: 0n,
      transferFeeAtoms: 0n,
      transferFeeLamportsEquivalent: 0n,
      rentCreatedLamports: 2_039_280n,
      rentRecoveredLamports: 0n,
      failedAttemptCostLamports: 0n,
      unexplainedLamports: 0n,
      valueToUnnamedAccountsLamports: 0n,
    },
    createdAccounts: [],
    closedAccounts: [],
    residualTokenAtoms: 0n,
    payerNativeDeltaLamports: -22_044_280n,
    fullAccountCoverage: true,
    effectValid: true,
    effectRefusals: [],
    snapshotManifestHash: HASH_A,
    replayable: true,
    complete: true,
    incompleteness: [],
    ...over,
  } as MeasuredLegSettlement;
}

function exitLeg(over: Partial<MeasuredLegSettlement> = {}): MeasuredLegSettlement {
  return leg({
    observationId: 'obs-2',
    side: 'sell',
    input: {
      kind: 'token',
      mint: 'Mint1',
      tokenProgram: TOKEN_PROGRAM,
      tokenAccount: 'Ata1',
      requestedAtoms: 1_000n,
      actualDebitAtoms: 1_000n,
    },
    output: { kind: 'native_sol', minimumLamports: 0n, expectedLamports: 19_500_000n, actualCreditLamports: 19_500_000n },
    costs: {
      ...leg().costs,
      rentCreatedLamports: 0n,
      rentRecoveredLamports: 2_039_280n,
    },
    payerNativeDeltaLamports: 19_500_000n - 5_000n + 2_039_280n,
    ...over,
  } as Partial<MeasuredLegSettlement>);
}

const EVIDENCE = { entry: DURABLE_EVIDENCE, exit: DURABLE_EVIDENCE };

describe('P17 12–17 — settlement identities', () => {
  it('12 — a NON-ZERO unexplained residue BLOCKS net PnL', () => {
    const clean = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg(),
      legEvidence: EVIDENCE,
    });
    expect(clean.unexplainedLamports).toBe(0n);
    expect(clean.netPnlLamports).not.toBeNull();

    // Move 2,500,000 lamports off the named flows, exactly as the audit did.
    const dirty = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg({ payerNativeDeltaLamports: exitLeg().payerNativeDeltaLamports - 2_500_000n }),
      legEvidence: EVIDENCE,
    });
    expect(dirty.unexplainedLamports).not.toBe(0n);
    expect(dirty.netPnlLamports).toBeNull();
    expect(dirty.pnlBlockedReasons.join(' ')).toContain('payer identity does not close');
  });

  it('13 — the residue is also an IDENTITY VIOLATION, with the exact number', () => {
    const dirty = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg({ payerNativeDeltaLamports: exitLeg().payerNativeDeltaLamports - 2_500_000n }),
      legEvidence: EVIDENCE,
    });
    const v = checkIdentities(dirty);
    expect(v.ok).toBe(false);
    // 51 of 52 pre-repair settlements had a residue and ZERO violations.
    expect(v.violations.join(' ')).toContain('-2500000');
  });

  it('14 — the trajectory-level failed-attempt fee enters EXACTLY ONCE', () => {
    const base = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg(),
      legEvidence: EVIDENCE,
    });
    const withFailure = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg(),
      failedAttemptFeesLamports: 5_000n,
      legEvidence: EVIDENCE,
    });
    // The audit's mutation moved this to 5,000 and measured NO effect at all.
    expect(withFailure.executionCostLamports - base.executionCostLamports).toBe(5_000n);
  });

  it('15 — a measured transfer fee enters EXACTLY ONCE', () => {
    const base = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg(),
      legEvidence: EVIDENCE,
    });
    const withFee = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg({ costs: { ...leg().costs, transferFeeLamportsEquivalent: 7_000n } }),
      exit: exitLeg(),
      legEvidence: EVIDENCE,
    });
    expect(withFee.transferFeesLamports - base.transferFeesLamports).toBe(7_000n);
    expect(withFee.executionCostLamports - base.executionCostLamports).toBe(7_000n);
  });

  it('16 — PRINCIPAL never enters execution cost', () => {
    const s = buildTrajectorySettlement({
      trajectoryId: 't',
      entry: leg(),
      exit: exitLeg(),
      legEvidence: EVIDENCE,
    });
    // Production once wrote `entryCashOut().cashOut` here: ~24,000,000 of
    // "execution cost" against ~4,087,000 of actual cost, and a 2x-cost stress
    // test then doubled the principal.
    expect(s.executionCostLamports).toBeLessThan(s.entryCashOutLamports);
    expect(checkIdentities(s).violations.join(' ')).not.toContain('principal');
  });

  it('17 — settling updates EXACTLY ONE row, and zero rows THROWS', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      insertTrajectory(db, trajectoryRow('t2', 'Mint2') as never);

      const s = buildTrajectorySettlement({
        trajectoryId: 't1',
        entry: leg(),
        exit: exitLeg(),
        legEvidence: EVIDENCE,
      });
      expect(() => persistTrajectoryEconomics(db, 't1', s, NOW)).not.toThrow();
      // A zero-row update is a write that went nowhere and reported success.
      expect(() => persistTrajectoryEconomics(db, 'nope', s, NOW)).toThrow(/changed 0 row/);

      // And the multi-row case: the audit ran ONE statement that settled 64
      // open trajectories. `settleTrajectory` is keyed by id and cannot.
      expect(() =>
        settleTrajectory(
          db,
          { identity: { trajectoryId: 'nope' }, settlement: s, evidenceGrade: 'SIMULATED_EXECUTION', haircutExitCashInLamports: null } as never,
          { exitObservationId: null, fillLatencyMs: null, settledUtcMs: NOW },
        ),
      ).toThrow(/changed 0 row/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 18–21  APPEND-ONLY MEANS LOUD
// ---------------------------------------------------------------------------

describe('P17 18–21 — every ambiguity fails loudly', () => {
  const settlementBody = (net: bigint | null): Parameters<typeof insertTrajectorySettlement>[3] => ({
    entryCashOutLamports: 20_000_000n,
    exitCashInLamports: 19_000_000n,
    grossExitCreditLamports: 19_500_000n,
    baseFeesLamports: 10_000n,
    priorityFeesLamports: 0n,
    tipsLamports: 0n,
    transferFeesLamports: 0n,
    failedAttemptFeesLamports: 0n,
    rentCreatedLamports: 0n,
    rentRecoveredLamports: 0n,
    rentStillLockedLamports: 0n,
    cashbackAccruedLamports: 0n,
    cashbackClaimableLamports: 0n,
    cashbackClaimedLamports: 0n,
    cashbackClaimCostLamports: 0n,
    residualTokenAtoms: 0n,
    unexplainedLamports: 0n,
    executionCostLamports: 10_000n,
    netPnlLamports: net,
    pnlBlockedReasons: [],
  });

  const markBody = (offsetMs: number, price: bigint) => ({
    atMs: NOW + offsetMs,
    offsetMs,
    executableLamports: price,
    exitCapacityLamports: price,
    effectiveQuoteReserveLamports: 100_000_000n,
    observedBaseReserve: 1_000_000_000_000n,
    observedQuoteReserve: 100_000_000n,
    refusal: null,
    latenessMs: 0,
  });

  it('18 — a settlement REPLACEMENT with different bytes throws; an identical one does not', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', settlementBody(-1_000_000n), [], NOW);
      expect(() =>
        insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', settlementBody(-2_000_000n), [], NOW),
      ).toThrow(/DIFFERENT settlement/);
      expect(() =>
        insertTrajectorySettlement(db, 't1', 'IMMEDIATE_MECHANICS', settlementBody(-1_000_000n), [], NOW),
      ).not.toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('19 — a DIFFERENT mark at the same offset throws', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      insertMark(db, 't1', markBody(1_800_000, 18_678_909n));
      expect(() => insertMark(db, 't1', markBody(1_800_000, 123_456_789n))).toThrow(/DIFFERENT mark/);
      expect(() => insertMark(db, 't1', markBody(1_800_000, 18_678_909n))).not.toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('20 — a second DIFFERENT exit for one policy throws', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      const outcome = (mark: bigint) => ({
        exitPolicy: 'FIXED_15M_CONTROL' as const,
        triggeredAtMs: NOW + 900_000,
        triggeredOffsetMs: 900_000,
        filledAtMs: NOW + 900_000,
        filledOffsetMs: 900_000,
        reason: 'horizon',
        exitMarkLamports: mark,
        grossDeltaLamports: mark - 20_000_000n,
        evidenceClass: 'BOUNDED_COUNTERFACTUAL_V1',
      });
      insertPolicyOutcome(db, 't1', 20_000_000n, outcome(19_000_000n), NOW);
      expect(() => insertPolicyOutcome(db, 't1', 20_000_000n, outcome(1_000_000n), NOW)).toThrow(
        /DIFFERENT outcome/,
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('21 — appendOnly refuses differing content and refuses a zero-row insert', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      let stored: Record<string, unknown> | null = null;
      const write = (value: number, changes: number): void => {
        appendOnly(db, {
          entity: 'test',
          key: 'k',
          content: { value },
          nowMs: NOW,
          readExisting: () => stored,
          insert: () => {
            if (changes === 1) stored = { value };
            return changes;
          },
        });
      };
      write(1, 1);
      // Same key, identical content: idempotent.
      expect(() => write(1, 1)).not.toThrow();
      // Same key, different content: refused, and recorded.
      expect(() => write(2, 1)).toThrow(EvidenceConflict);
      expect(
        Number((db.prepare('SELECT COUNT(*) c FROM evidence_conflicts').get() as { c: number }).c),
      ).toBe(1);

      // Zero rows affected where one was expected.
      stored = null;
      expect(() => write(3, 0)).toThrow(AffectedRowMismatch);
      // More than one row affected.
      stored = null;
      expect(() => write(4, 2)).toThrow(AffectedRowMismatch);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('21b — closing a trajectory reports whether it closed ANYTHING', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      expect(closeTrajectory(db, 't1', NOW).closed).toBe(true);
      // Already settled: idempotent, and it SAYS it changed nothing.
      expect(closeTrajectory(db, 't1', NOW).closed).toBe(false);
      expect(closeTrajectory(db, 'nope', NOW).closed).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 22–25  ATTRIBUTION, QUOTE STATE, BUILD-ONCE
// ---------------------------------------------------------------------------

describe('P17 22–25 — attribution and build-once', () => {
  it('22 — a ONE-LAMPORT quote-vault credit cannot attribute a 0.02 SOL entry', () => {
    const oneLamport = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 1n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      feeFlowsLamports: 0n,
    });
    expect(oneLamport.attributed).toBe(false);
    expect(oneLamport.refusal).toContain('19999999');

    const conserved = attributeSoleVenue({
      baseOutAtoms: 1_000n,
      quoteInLamports: 19_800_000n,
      takerCreditAtoms: 1_000n,
      entryQuoteOutLamports: 20_000_000n,
      feeFlowsLamports: 200_000n,
    });
    expect(conserved.attributed).toBe(true);
  });

  it('22b — a MISSING payer outflow refuses rather than passing a sign test', () => {
    const a = attributeSoleVenue({ baseOutAtoms: 1_000n, quoteInLamports: 20_000_000n, takerCreditAtoms: 1_000n });
    expect(a.attributed).toBe(false);
    expect(a.refusal).toContain('sign test');
  });

  it('25 — the frozen plan must DESCRIBE THE BYTES that will execute', () => {
    const ix = {
      programId: '11111111111111111111111111111111',
      accounts: [
        { pubkey: 'So11111111111111111111111111111111111111112', isSigner: true, isWritable: true },
        { pubkey: 'SysvarC1ock11111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1, 2, 3]).toString('base64'),
    };
    const payer = 'So11111111111111111111111111111111111111112';
    const blockhash = '11111111111111111111111111111111';
    const bytes = Buffer.from(encodeUnsignedTransaction(compileMessage([ix], payer, blockhash, {}))).toString(
      'base64',
    );

    const frozen = freezeAccountPlan('buy', [ix]);
    const decoded = planFromEncodedTransaction('buy', bytes);
    expect(() => assertPlanMatchesBytes(frozen, decoded)).not.toThrow();

    // A REBUILD between the freeze and the encode changes the bytes. Simulate
    // it by encoding a different instruction than the one that was frozen.
    const rebuilt = { ...ix, data: Buffer.from([9, 9, 9]).toString('base64') };
    const rebuiltBytes = Buffer.from(
      encodeUnsignedTransaction(compileMessage([rebuilt], payer, blockhash, {})),
    ).toString('base64');
    expect(() => assertPlanMatchesBytes(frozen, planFromEncodedTransaction('buy', rebuiltBytes))).toThrow(
      AccountPlanIncomplete,
    );
  });
});

// ---------------------------------------------------------------------------
// 26–29  THE MARK CLOCK AND THE COUNTERFACTUAL CONTRACT
// ---------------------------------------------------------------------------

describe('P17 26–29 — the mark clock and the counterfactual contract', () => {
  it('26 — a 1-minute mark taken at its horizon MEETS the SLA', () => {
    const due = NOW + 60_000;
    expect(classifyMark(due, due + 500).status).toBe('ON_TIME');
    expect(classifyMark(due, due + MARK_SLA_MS).status).toBe('ON_TIME');
  });

  it('27 — a LATE mark is MISSED_HORIZON, not a valid backfilled horizon', () => {
    const due = NOW + 60_000;
    const late = classifyMark(due, due + MARK_SLA_MS + 1);
    expect(late.status).toBe('MISSED_HORIZON');
    expect(late.latenessMs).toBe(MARK_SLA_MS + 1);
    // The audit found 697 of 1,448 marks more than 60s late, every one wearing
    // the right offset label.
    expect(classifyMark(due, due + 300_000).status).toBe('MISSED_HORIZON');
  });

  it('26b — the scheduler wakes at the next DEADLINE, and defers discovery when behind', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      const offsets = [60_000, 300_000];

      // Nothing due yet: it waits, bounded by the tick.
      const early = nextWakeMs(db, { nowMs: NOW + 1_000, offsets, maxTickMs: 3_000 });
      expect(early).toBeGreaterThan(0);
      expect(early).toBeLessThanOrEqual(3_000);

      // Past the 1m horizon: due now, and discovery is refused.
      const due = dueMarks(db, { nowMs: NOW + 61_000, offsets });
      expect(due.map((d) => d.offsetMs)).toContain(60_000);
      expect(nextWakeMs(db, { nowMs: NOW + 61_000, offsets })).toBe(0);

      const admissible = discoveryAdmissible(db, { nowMs: NOW + 200_000, offsets, slaMs: 10_000 });
      expect(admissible.admissible).toBe(false);
      expect(admissible.overdue).toBeGreaterThan(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('28 — a bounded counterfactual CANNOT exist above the impact cap', () => {
    const at = (impactBps: number) =>
      boundedCounterfactual({
        trajectoryId: 't',
        offsetMs: 900_000,
        // A buy REMOVES base and ADDS quote, so the signs are opposite.
        entryBaseDeltaAtoms: -1_000n,
        entryQuoteDeltaLamports: 20_000_000n,
        observedBaseReserve: 1_000_000n,
        observedQuoteReserve: 100_000_000_000n,
        tokensHeldAtoms: 1_000n,
        entryImpactBps: impactBps,
        nowMs: NOW,
      });
    expect(at(BOUNDED_IMPACT_CAP_BPS).evidenceClass).toBe('BOUNDED_COUNTERFACTUAL_V1');
    expect(() => at(BOUNDED_IMPACT_CAP_BPS + 1)).toThrow(CounterfactualRefused);
  });

  it('28b — the bounded exit is HAIRCUT: it is never better than the unadjusted one', () => {
    const c = boundedCounterfactual({
      trajectoryId: 't',
      offsetMs: 900_000,
      entryBaseDeltaAtoms: -1_000n,
      entryQuoteDeltaLamports: 20_000_000n,
      observedBaseReserve: 1_000_000n,
      observedQuoteReserve: 100_000_000_000n,
      tokensHeldAtoms: 1_000n,
      entryImpactBps: 5,
      nowMs: NOW,
    });
    expect(c.haircutLamports).toBeGreaterThan(0n);
    // DEVELOPMENT until calibrated. A grade is not a plan to calibrate later.
    expect(c.evidenceGrade).toBe('DEVELOPMENT');
  });

  it('29 — calibration DETECTS a non-conservative bound', () => {
    // Bounded BELOW replayed: pessimistic, which is acceptable.
    expect(calibrate(900_000n, 1_000_000n).conservative).toBe(true);
    // Bounded ABOVE replayed: optimistic, and every row carrying it overstates
    // the exit. This is the failure mode that turns a loser into a winner.
    expect(calibrate(1_100_000n, 1_000_000n).conservative).toBe(false);
    expect(calibrate(1_000_000n, 1_000_000n).conservative).toBe(true);
  });

  it('29b — a later mainnet quote with NO contract may not enter PnL', () => {
    expect(admissibleForPnl(null, null).admissible).toBe(false);
    expect(admissibleForPnl('SIMULATED_EXECUTION', 'DEVELOPMENT').admissible).toBe(false);
    // Bounded is development evidence until calibrated.
    expect(admissibleForPnl('BOUNDED_COUNTERFACTUAL_V1', 'DEVELOPMENT').admissible).toBe(false);
    expect(admissibleForPnl('BOUNDED_COUNTERFACTUAL_V1', 'CALIBRATED').admissible).toBe(true);
    expect(admissibleForPnl('RESERVE_DELTA_REPLAY_V1', 'DEVELOPMENT').admissible).toBe(true);
  });

  it('29c — the replay applies pool events IN ORDER to the local post-entry state', () => {
    const r = replayCounterfactual({
      postEntryBaseReserve: 1_000_000n,
      postEntryQuoteReserve: 100_000_000n,
      events: [
        { signature: 'b', slot: 2, baseVaultDelta: 500_000n, quoteVaultDelta: -40_000_000n },
        { signature: 'a', slot: 1, baseVaultDelta: -100_000n, quoteVaultDelta: 10_000_000n },
      ],
      tokensHeldAtoms: 1_000n,
    });
    expect(r.eventsApplied).toBe(2);
    expect(r.finalBaseReserve).toBe(1_400_000n);
    expect(r.finalQuoteReserve).toBe(70_000_000n);
  });
});

// ---------------------------------------------------------------------------
// 30–32  POLICY TREATMENTS
// ---------------------------------------------------------------------------

describe('P17 30–32 — the treatments are decisions, not labels', () => {
  const features = (over: Partial<PreEntryFeatures> = {}): PreEntryFeatures => ({
    mint: 'Mint1',
    hardGatesPass: true,
    independentBuyerPersistence: 0.8,
    nonMayhemNetQuoteInflowLamports: 1_000_000n,
    effectiveQuoteReserveTrend: 1,
    executableExitCapacityTrend: 1,
    continuationSlope: 1,
    creatorNetSellingLamports: 0n,
    entityConcentration: 0.2,
    mintBehaviourSafe: true,
    mechanicsViable: true,
    correctedQualityScore: 0.9,
    scoreCoverageOk: true,
    ...over,
  });

  it('30 — all THREE entry policies decide on ONE shared trajectory', () => {
    const f = features();
    const decisions = ENTRY_POLICIES.map((p) => decideEntry(p, f, { seed: 'p17' }));
    expect(decisions).toHaveLength(3);
    expect(new Set(decisions.map((d) => d.policy)).size).toBe(3);
    // Every one is a real verdict with a reason, over the same features.
    for (const d of decisions) expect(d.reason.length).toBeGreaterThan(0);
  });

  it('30b — the policies can DISAGREE, which is what makes it a comparison', () => {
    // A high-quality score with deteriorating flow: quality enters, flow does not.
    const f = features({ correctedQualityScore: 0.9, executableExitCapacityTrend: -1 });
    const quality = decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', f, { seed: 'p17' });
    const flow = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', f, { seed: 'p17' });
    expect(quality.enter).toBe(true);
    expect(flow.enter).toBe(false);
  });

  it('30c — an UNKNOWN feature is never read as a pass', () => {
    const f = features({ independentBuyerPersistence: null });
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', f, { seed: 'p17' });
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('independentBuyerPersistence');
  });

  it('31 — the challenger EXITS EARLIER on a deteriorating path, and fills LATER than its trigger', () => {
    const opened = NOW;
    const marks = [
      { atMs: opened + 60_000, executableLamports: 20_000_000n, exitCapacityLamports: 20_000_000n, effectiveQuoteReserveLamports: null },
      // A 50% capacity collapse at 5 minutes: the deterioration trigger.
      { atMs: opened + 300_000, executableLamports: 15_000_000n, exitCapacityLamports: 10_000_000n, effectiveQuoteReserveLamports: null },
      { atMs: opened + 900_000, executableLamports: 12_000_000n, exitCapacityLamports: 9_000_000n, effectiveQuoteReserveLamports: null },
    ];
    const control = decideExit('FIXED_15M_CONTROL', opened, marks);
    const challenger = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, marks);

    // EARLIER, at a DIFFERENT mark. The audit found no constructed path in the
    // old build where this was true.
    expect(challenger.triggeredAtMs).toBe(opened + 300_000);
    expect(control.triggeredAtMs).toBe(opened + 900_000);
    expect(challenger.triggeredAtMs!).toBeLessThan(control.triggeredAtMs!);

    /**
     * P9.2 — and it FILLS at the first LATER valid mark, not at the one that
     * revealed the deterioration. Pricing it at the trigger books the exit at
     * the one observation the strategy demonstrably could not have traded at.
     */
    expect(challenger.filledAtMs).toBe(opened + 900_000);
    expect(challenger.filledAtMs!).toBeGreaterThan(challenger.triggeredAtMs!);

    // The control's trigger and fill coincide, because a preregistered horizon
    // is a clock it can stand ready at.
    expect(control.filledAtMs).toBe(control.triggeredAtMs);
  });

  it('31b — a deterioration with NO later mark is BLOCKED, not filled at the trigger', () => {
    const opened = NOW;
    const marks = [
      { atMs: opened + 60_000, executableLamports: 20_000_000n, exitCapacityLamports: 20_000_000n, effectiveQuoteReserveLamports: null },
      { atMs: opened + 300_000, executableLamports: 15_000_000n, exitCapacityLamports: 10_000_000n, effectiveQuoteReserveLamports: null },
    ];
    const challenger = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, marks);
    expect(challenger.triggeredAtMs).toBe(opened + 300_000);
    expect(challenger.filledAtMs).toBeNull();
    expect(challenger.reason).toContain('BLOCKED');
  });

  it('32 — ENTITY-ADJUSTED concentration changes the decision the RAW share would have made', () => {
    // Raw top-holder share looks fine; the entity-adjusted share does not.
    // An incomplete history can only UNDERSTATE clustering, so the weaker of
    // the two decided every pre-repair admission.
    const raw = features({ entityConcentration: 0.2 });
    const adjusted = features({ entityConcentration: 0.6 });
    expect(decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', raw, { seed: 'p17' }).enter).toBe(true);
    expect(decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', adjusted, { seed: 'p17' }).enter).toBe(false);

    // And UNKNOWN clustering is not safe either.
    const unknown = features({ entityConcentration: null });
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', unknown, { seed: 'p17' });
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('entityConcentration');
  });
});

// ---------------------------------------------------------------------------
// 34–39  ARTIFACT OWNERSHIP, CONTRACTS, AND THE THINGS THAT MUST STAY TRUE
// ---------------------------------------------------------------------------

describe('P17 34–39 — ownership, contracts, and the standing prohibitions', () => {
  it('34 — the two readiness scripts CANNOT write the same artifact', () => {
    const trajectory = readFileSync('scripts/trajectory-readiness.ts', 'utf8');
    const positions = readFileSync('scripts/readiness.ts', 'utf8');

    /**
     * Not a source-substring test in the sense the directive forbids: what is
     * asserted is the SET OF FILENAMES each script can produce, which is the
     * observable behaviour. `writeArtifact` throws on a path, so the filename
     * literal IS the artifact identity.
     */
    const namesIn = (src: string): string[] =>
      [...src.matchAll(/writeArtifact\(\s*'([^']+)'/g), ...src.matchAll(/writeNotRun\(\s*'([^']+)'/g)].map(
        (m) => m[1] as string,
      );
    const a = new Set(namesIn(trajectory));
    const b = new Set(namesIn(positions));
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    for (const name of a) expect(b.has(name)).toBe(false);
    // And neither writes the ambiguous legacy filename.
    expect(a.has('readiness.json')).toBe(false);
    expect(b.has('readiness.json')).toBe(false);
  });

  it('34b — writeArtifact REFUSES a path, so two scripts cannot be aimed at one file', async () => {
    const { writeArtifact } = await import('../../scripts/_artifact.js');
    expect(() => writeArtifact('sub/dir.json', {})).toThrow(/bare filename/);
  });

  it('36 — an INVALIDATED context is excluded from the active graph', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      db.prepare(
        `INSERT INTO evidence_contexts (evidence_context_id, context_hash, source_commit, tree_dirty,
           opened_utc_ms, closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
         VALUES ('bad', ?, 'aaa', 1, ?, ?, 'INSTRUMENT_DEVELOPMENT_INVALID', '[]', NULL, NULL)`,
      ).run(HASH_A, NOW, NOW);
      db.prepare(
        `INSERT INTO evidence_contexts (evidence_context_id, context_hash, source_commit, tree_dirty,
           opened_utc_ms, closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
         VALUES ('good', ?, 'bbb', 0, ?, NULL, 'DEVELOPMENT_EVIDENCE', '[]', NULL, NULL)`,
      ).run(HASH_B, NOW);

      insertTrajectory(db, trajectoryRow('t1') as never);
      db.prepare(
        `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
         VALUES ('t1', 'bad', ?)`,
      ).run(NOW);

      const active = db
        .prepare(
          `SELECT COUNT(*) c FROM development_trajectories t
             JOIN trajectory_evidence_context ctx ON ctx.trajectory_id = t.trajectory_id
             JOIN evidence_contexts e ON e.evidence_context_id = ctx.evidence_context_id
            WHERE e.validity = 'DEVELOPMENT_EVIDENCE'`,
        )
        .get() as { c: number };
      expect(Number(active.c)).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('36b — a trajectory cannot be LINKED into a context that does not exist', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      insertTrajectory(db, trajectoryRow('t1') as never);
      // The foreign key IS the enforcement. This is what the 292 pre-repair
      // rows cannot satisfy, and why they cannot enter the new tables.
      expect(() =>
        db
          .prepare(
            `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
             VALUES ('t1', 'no-such-context', ?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('36c — an evidence link with a DANGLING identifier is refused by the database', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      db.prepare(
        `INSERT INTO evidence_contexts (evidence_context_id, context_hash, source_commit, tree_dirty,
           opened_utc_ms, closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
         VALUES ('good', ?, 'bbb', 0, ?, NULL, 'DEVELOPMENT_EVIDENCE', '[]', NULL, NULL)`,
      ).run(HASH_B, NOW);
      insertTrajectory(db, trajectoryRow('t1') as never);

      expect(() =>
        db
          .prepare(
            `INSERT INTO trajectory_evidence_links
               (trajectory_id, evidence_context_id, reservation_id, snapshot_hash, capability_fingerprint,
                account_plan_hash, fee_config_hash, selected_tier,
                entry_observation_id, entry_job_id, entry_step_index, entry_settlement_id,
                exit_observation_id, exit_job_id, exit_step_index, exit_settlement_id, linked_utc_ms)
             VALUES ('t1','good','no-such-reservation',?,?,?,NULL,NULL,'obs-x','job-x',0,'set-x',NULL,NULL,NULL,NULL,?)`,
          )
          .run(HASH_A, HASH_B, HASH_A, NOW),
      ).toThrow(/FOREIGN KEY/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('38 — no development process imports signer or send code', () => {
    // The collector's own header claims this. The claim is checked here against
    // the import graph rather than against the header.
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from '([^']+\.js)'/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith('.')) continue;
        const resolved = join(file, '..', spec.replace(/\.js$/, '.ts')).replace(/\\/g, '/');
        if (resolved.includes('/packages/execution/')) offenders.push(`${file} -> ${resolved}`);
        walk(resolved);
      }
    };
    walk('apps/collector/src/trajectory-collect.ts');
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });

  it('39 — canary and live remain BLOCKED for this process', () => {
    const src = readFileSync('apps/collector/src/trajectory-collect.ts', 'utf8');
    // Behavioural: the mode guard throws. Asserted by reading the guard's own
    // condition would be a substring test, so instead the modes are checked to
    // be absent from the collector's own npm script.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['trajectory:collect']).toContain('--mode=observe');
    expect(pkg.scripts['trajectory:collect']).not.toContain('canary');
    expect(pkg.scripts['trajectory:collect']).not.toContain('live');
    // And the guard exists at all, which is a property of the file rather than
    // of a comment in it.
    expect(src).toContain("mode === 'canary'");
  });
});

describe('P17 40–42 — backpressure is scoped to the window it brakes', () => {
  /**
   * MEASURED 2026-08-17. The v1 window was demoted to
   * INSTRUMENT_DEVELOPMENT_INVALID because every trajectory in it recorded a
   * capability fingerprint of {unknown, unknown}. Seven of its trajectories
   * were still AWAITING_FILL_OBSERVATION with horizons long past. A clean v2
   * window was opened and the collector logged, every tick, for minutes:
   *
   *   discovery deferred: 3 mark(s) are already past the 10000ms SLA.
   *
   * and opened nothing. The mark pass IS scoped to the active context, so it
   * correctly never took those marks; `discoveryAdmissible` was NOT, so it
   * counted them forever. A brake applied by a wheel that is not turning is
   * not backpressure, it is a permanent stop.
   */
  const seedTwoWindows = (db: ReturnType<typeof openDb>): void => {
    for (const [ctx, validity] of [
      ['ctx-dead', 'INSTRUMENT_DEVELOPMENT_INVALID'],
      ['ctx-live', 'DEVELOPMENT_EVIDENCE'],
    ] as const) {
      db.prepare(
        `INSERT INTO evidence_contexts (evidence_context_id, context_hash, source_commit, tree_dirty,
           opened_utc_ms, closed_utc_ms, validity, reasons, audit_artifact_hash, notes)
         VALUES (?, ?, 'aaa', 0, ?, NULL, ?, '[]', NULL, NULL)`,
      ).run(ctx, ctx === 'ctx-dead' ? HASH_A : HASH_B, NOW, validity);
    }
    // An OLD trajectory in the demoted window whose 1m horizon is long gone.
    insertTrajectory(db, trajectoryRow('t-dead', 'MintDead') as never);
    db.prepare(
      `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
       VALUES ('t-dead', 'ctx-dead', ?)`,
    ).run(NOW);
  };

  it('40 — an overdue mark in a DEMOTED window does not defer discovery in the live one', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedTwoWindows(db);
      const offsets = [60_000];
      const now = NOW + 3_600_000; // an hour past the dead window's horizon

      // Unscoped, this is the deadlock the collector actually hit.
      const unscoped = discoveryAdmissible(db, { nowMs: now, offsets, slaMs: 10_000 });
      expect(unscoped.admissible).toBe(false);
      expect(unscoped.overdue).toBe(1);

      // Scoped to the window this collector is marking, there is nothing to
      // catch up on, because there is nothing IN it.
      const scoped = discoveryAdmissible(db, {
        nowMs: now,
        offsets,
        slaMs: 10_000,
        evidenceContextId: 'ctx-live',
      });
      expect(scoped.admissible).toBe(true);
      expect(scoped.overdue).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('41 — the brake still engages for an overdue mark INSIDE the live window', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedTwoWindows(db);
      insertTrajectory(db, trajectoryRow('t-live', 'MintLive') as never);
      db.prepare(
        `INSERT INTO trajectory_evidence_context (trajectory_id, evidence_context_id, assigned_utc_ms)
         VALUES ('t-live', 'ctx-live', ?)`,
      ).run(NOW);

      const scoped = discoveryAdmissible(db, {
        nowMs: NOW + 3_600_000,
        offsets: [60_000],
        slaMs: 10_000,
        evidenceContextId: 'ctx-live',
      });
      expect(scoped.admissible).toBe(false);
      expect(scoped.overdue).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('42 — nextWakeMs reads the SAME set the mark pass and the brake read', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedTwoWindows(db);
      const offsets = [60_000];
      const now = NOW + 3_600_000;

      // A deadline that will never be taken must not pin the scheduler at a
      // zero sleep, spinning the loop on work it has already excluded.
      expect(nextWakeMs(db, { nowMs: now, offsets, maxTickMs: 3_000 })).toBe(0);
      expect(
        nextWakeMs(db, { nowMs: now, offsets, maxTickMs: 3_000, evidenceContextId: 'ctx-live' }),
      ).toBe(3_000);
      expect(
        dueMarks(db, { nowMs: now, offsets, evidenceContextId: 'ctx-live' }).length,
      ).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P17 43–45 — a recycled pid is not a live collector', () => {
  /**
   * MEASURED 2026-08-17. The collector at pid 15880 exited; Windows handed
   * 15880 to a `sleep`; the lock then refused every new collector with "the
   * trajectory collector lock is held by live pid 15880" and went on refusing,
   * because the rule that a live pid may never be taken over is deliberately
   * absolute and the stranger holding the number will never release a lock it
   * does not know it has. The window could not be restarted at all.
   *
   * `pidIsAlive` answers "does a process with this number exist", which is not
   * the question. The identity is the command line, which the lock already
   * stores.
   */
  const seedLock = (db: ReturnType<typeof openDb>, pid: number, at: number, cmd: string): void => {
    db.prepare(
      `INSERT INTO process_locks (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode, source_commit, command_line)
       VALUES (?, ?, 'h', ?, ?, 'observe', 'aaa', ?)
       ON CONFLICT(lock_name) DO UPDATE SET pid=excluded.pid, heartbeat_utc_ms=excluded.heartbeat_utc_ms,
         command_line=excluded.command_line`,
    ).run(TRAJECTORY_COLLECTOR_LOCK, pid, at, at, cmd);
  };
  const lock = (
    db: ReturnType<typeof openDb>,
    nowMs: number,
    stillOwns: boolean,
  ): TrajectoryCollectorLock =>
    new TrajectoryCollectorLock(db, {
      mode: 'observe',
      sourceCommit: 'bbb',
      staleAfterMs: 90_000,
      now: () => nowMs,
      pidAlive: () => true,
      pidStillOwns: () => stillOwns,
    });

  it('43 — a live pid running SOMETHING ELSE with a stale heartbeat may be taken over', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedLock(db, 999999, NOW, 'node tsx apps/collector/src/trajectory-collect.ts --mode=observe');
      const taken = lock(db, NOW + 200_000, false).acquire();
      expect(taken.pid).toBe(process.pid);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('44 — a live pid STILL running the collector is refused, stale heartbeat or not', () => {
    const dir = tmp();
    try {
      const db = freshDb(dir);
      seedLock(db, 999999, NOW, 'node tsx apps/collector/src/trajectory-collect.ts --mode=observe');
      // Hung: the heartbeat is stale but the process is still this program.
      expect(() => lock(db, NOW + 200_000, true).acquire()).toThrow(/ALIVE but its heartbeat/);
      // Healthy: a fresh heartbeat is refused before identity is even asked.
      expect(() => lock(db, NOW + 1_000, false).acquire()).toThrow(/held by live pid/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('45 — an unreadable command line keeps the conservative reading', () => {
    // `pidStillOwns` reports true when it cannot tell. A half signal is not
    // permission, so the lock is refused rather than stolen.
    expect(pidStillOwns(process.pid, '')).toBe(true);
    expect(pidStillOwns(process.pid, 'some command with no recognisable marker')).toBe(true);
  });
});

/**
 * P17 #23 and #24 — a fee-config or Clock mutation between the quote and the
 * sell must BREAK quote-state equality.
 *
 * `assertQuoteStateSurvived` compares the COMPLETE account hash rather than the
 * data hash, and the distinction is the whole point: an account whose owner,
 * lamports, executable flag or rent epoch changed has the same bytes and is not
 * the same account to the runtime that has to execute against it.
 *
 * The audit's G-1 exercises this at runtime against the live corpus. These two
 * pin it at unit level, because a runtime probe can only report on the mutations
 * the market happened to produce.
 */
describe('23/24 — a mutation between quote and sell breaks quote-state equality', () => {
  const FEE_CONFIG = 'FeeCfg1111111111111111111111111111111111111';
  const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
  const POOL = 'Pool111111111111111111111111111111111111111';

  const acct = (pubkey: string, hash: string) => ({
    pubkey,
    lamports: 1_000n,
    owner: 'Sys',
    executable: false,
    rentEpoch: 0n,
    dataLen: 8,
    dataBase64: 'AAAAAAAAAAA=',
    dataSha256: 'd',
    accountHash: hash,
  });

  const quoted = (hashes: Record<string, string>) => ({
    accounts: Object.entries(hashes).map(([k, h]) => acct(k, h)),
    unobserved: [],
    stateHash: 'q',
    instanceId: 'i',
  });

  const sellStep = (hashes: Record<string, string>) => ({
    label: 'sell',
    status: 'SIMULATED_OK',
    transactionError: null,
    computeUnitsConsumed: 1,
    logs: [],
    preAccounts: Object.entries(hashes).map(([k, h]) => acct(k, h)),
    postAccounts: [],
    unobserved: [],
  });

  it('an UNCHANGED quote state survives, so the check is not vacuous', () => {
    const same = { [POOL]: 'h1', [FEE_CONFIG]: 'h2', [CLOCK]: 'h3' };
    expect(() =>
      assertQuoteStateSurvived(quoted(same) as never, sellStep(same) as never),
    ).not.toThrow();
  });

  it('23 — a FEE CONFIG mutation breaks equality and NAMES the account', () => {
    let thrown: QuoteStateMoved | null = null;
    try {
      assertQuoteStateSurvived(
        quoted({ [POOL]: 'h1', [FEE_CONFIG]: 'h2', [CLOCK]: 'h3' }) as never,
        sellStep({ [POOL]: 'h1', [FEE_CONFIG]: 'MOVED', [CLOCK]: 'h3' }) as never,
      );
    } catch (e) {
      thrown = e as QuoteStateMoved;
    }
    expect(thrown?.name).toBe('QuoteStateMoved');
    // The account list is what a caller acts on; the message only counts them.
    expect(thrown?.differing).toEqual([FEE_CONFIG]);
  });

  it('24 — a CLOCK mutation breaks equality when the Clock was quoted', () => {
    let thrown: QuoteStateMoved | null = null;
    try {
      assertQuoteStateSurvived(
        quoted({ [POOL]: 'h1', [FEE_CONFIG]: 'h2', [CLOCK]: 'h3' }) as never,
        sellStep({ [POOL]: 'h1', [FEE_CONFIG]: 'h2', [CLOCK]: 'MOVED' }) as never,
      );
    } catch (e) {
      thrown = e as QuoteStateMoved;
    }
    expect(thrown?.name).toBe('QuoteStateMoved');
    expect(thrown?.differing).toEqual([CLOCK]);
  });

  it('a quoted account that is ABSENT at execution also breaks equality', () => {
    let thrown: QuoteStateMoved | null = null;
    try {
      assertQuoteStateSurvived(
        quoted({ [POOL]: 'h1', [FEE_CONFIG]: 'h2' }) as never,
        sellStep({ [POOL]: 'h1' }) as never,
      );
    } catch (e) {
      thrown = e as QuoteStateMoved;
    }
    expect(thrown?.name).toBe('QuoteStateMoved');
    expect(thrown?.differing).toEqual([FEE_CONFIG]);
  });

  it('an account the quote never read is NOT compared, so the check stays scoped', () => {
    expect(() =>
      assertQuoteStateSurvived(
        quoted({ [POOL]: 'h1' }) as never,
        sellStep({ [POOL]: 'h1', 'Unrelated1111111111111111111111111111111111': 'whatever' }) as never,
      ),
    ).not.toThrow();
  });
});
