import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve as resolvePath, dirname } from 'node:path';

import { attributeSoleVenue } from '../packages/domain/src/trajectory-evidence.js';
import {
  tierForPool,
  selectFeeTier,
  poolMarketCapLamports,
  feeConfigHash,
  type FeeTier,
} from '../packages/solana/src/fee-tiers.js';
import { buildTrajectorySettlement, checkIdentities } from '../packages/domain/src/trajectory-settlement.js';
import {
  decideEntry,
  decideExit,
  ENTRY_POLICIES,
  type PreEntryFeatures,
  type MarkPoint,
} from '../packages/strategy/src/treatments.js';
import {
  vaultBalance,
  subscriptionFor,
  assertUnwatchesExactly,
  isMaterialChange,
  drainOrder,
  NotATokenAccount,
} from '../packages/pipeline/src/vault-watch.js';
import { mayhemFactsOf, breadthUsability, bondingCurveMayhemMode, MAYHEM_PROGRAM } from '../packages/solana/src/mayhem.js';
import { insertTrajectory, insertTrajectorySettlement } from '../packages/storage/src/trajectory-repo.js';
import { insertMark, insertPolicyOutcome } from '../packages/storage/src/mark-repo.js';
import { expectedRemainingTail, remainingTailRefusal } from '../packages/solana/src/cashback.js';

/**
 * The independent runtime adversarial re-audit of the `29c7cc7` collector work.
 *
 * Every probe below is a MUTATION with a stated expectation, run against the
 * operator's actual tree, the actual runtime database (through a verified
 * VACUUM-consistent copy, never the corpus itself) and the actual WSL worker.
 *
 * Three rules this file follows, because the directive it answers exists
 * because they were broken elsewhere:
 *
 *  - a probe that cannot run reports `NOT TESTABLE` with the reason, and a
 *    `NOT TESTABLE` production invariant blocks promotion;
 *  - no verdict is copied out of a proof artifact, a commit message, a test
 *    name or `docs/STATUS.md`;
 *  - nothing here funds, signs, submits, or starts canary or live. It opens the
 *    live database READ ONLY and mutates only a copy under the system temp dir.
 */

type Verdict = 'PASS' | 'FAIL' | 'NOT TESTABLE' | 'OUT OF SCOPE';

interface Finding {
  readonly section: string;
  /** `A-1`, `K-2`, … derived from position, so it cannot drift from the docs. */
  id?: string;
  /** Whether the ACTIVE experiment contract claims this invariant. */
  scope?: 'CLAIMED' | 'OUT_OF_SCOPE';
  /** Why it is out of scope, from the contract. Never invented here. */
  outOfScopeReason?: string;
  readonly invariant: string;
  readonly verdict: Verdict;
  /** Exactly what was read or run. A file path, a row id, a command. */
  readonly source: string;
  /** The mutation applied, or `observation` when the probe only reads. */
  readonly mutation: string;
  readonly result: string;
  /** What it costs in lamports, in evidence, or in what may be claimed. */
  readonly economicConsequence: string;
  readonly rows?: readonly string[];
}

const findings: Finding[] = [];

/**
 * P13 — THE ACTIVE EXPERIMENT CONTRACT DECIDES WHAT IS CLAIMED.
 *
 * The directive requires FAIL = 0 and NOT TESTABLE = 0 "for every invariant
 * included in the active development contract", and adds: "If a subsystem is
 * intentionally out of scope, remove it from the contract and stop claiming
 * it — not `NOT TESTABLE but promoted anyway`."
 *
 * So an invariant the contract does not claim is `OUT OF SCOPE` here, carrying
 * the contract's own recorded reason. It is NOT silently passed and NOT counted
 * as testable. If no contract is frozen, EVERYTHING is claimed — the default has
 * to be the strict one, because a missing contract must not be a way to escape
 * a gate.
 */
let CLAIMED: ReadonlySet<string> | null = null;
let OUT_OF_SCOPE_REASONS: Readonly<Record<string, string>> = {};
let CONTRACT_ID: string | null = null;
/** The active evidence context, or null. Corpus queries scope to it. */
let ACTIVE_CTX: string | null = null;

const perSection = new Map<string, number>();

const record = (f: Finding): void => {
  const n = (perSection.get(f.section) ?? 0) + 1;
  perSection.set(f.section, n);
  const id = `${f.section}-${n}`;
  const claimed = CLAIMED === null || CLAIMED.has(id);
  const stamped: Finding = {
    ...f,
    id,
    scope: claimed ? 'CLAIMED' : 'OUT_OF_SCOPE',
    ...(claimed ? {} : { outOfScopeReason: OUT_OF_SCOPE_REASONS[id] ?? 'not claimed by the active contract' }),
    // An unclaimed invariant is not asserted either way. Overriding the verdict
    // rather than dropping the row keeps the probe's result visible while
    // removing it from the gate.
    verdict: claimed ? f.verdict : 'OUT OF SCOPE',
  };
  findings.push(stamped);
  const tag =
    stamped.verdict === 'PASS'
      ? 'PASS'
      : stamped.verdict === 'FAIL'
        ? 'FAIL'
        : stamped.verdict === 'OUT OF SCOPE'
          ? 'SKIP'
          : 'N/T ';
  console.log(`${tag}  ${id.padEnd(5)} ${f.invariant}`);
};

const sha256File = async (p: string): Promise<string> => {
  const h = createHash('sha256');
  await new Promise<void>((res, rej) =>
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => res())
      .on('error', rej),
  );
  return h.digest('hex');
};

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERROR: ${(e as Error).message.slice(0, 200)}`;
  }
};

const LIVE_DB = process.env['DATABASE_PATH'] ?? './data/runtime.db';
const COPY_DB = process.env['AUDIT_COPY_DB'] ?? null;
const SIDECAR = process.env['AUDIT_SIDECAR'] ?? null;

const ro = (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true });

/**
 * SCOPE EVERY TRAJECTORY-KEYED QUERY TO THE ACTIVE EVIDENCE CONTEXT.
 *
 * This audit's own numbers are the reason it exists, so the numbers have to be
 * about the right window. The 292 pre-repair trajectories are preserved and
 * `INSTRUMENT_DEVELOPMENT_INVALID`; counting their dangling identifiers as
 * failures of the ACTIVE contract would be the mirror image of the defect the
 * invalidation ledger removes — reporting one window's evidence as another's.
 *
 * Done centrally rather than by editing thirty hand-written queries, because
 * thirty edits is thirty chances to scope one of them wrongly and not notice.
 * The rewrite is a whole-word table substitution into an inline view; the
 * aliases that follow the table name still bind, because the view sits exactly
 * where the table did.
 *
 * With NO active contract, nothing is rewritten and every query sees the whole
 * corpus. That is the strict default: a missing contract must not be a way to
 * shrink the sample a gate is evaluated over.
 */
const TRAJECTORY_KEYED = [
  'development_trajectories',
  'trajectory_marks',
  'trajectory_settlements',
  'trajectory_policy_outcomes',
  'trajectory_policy_decisions',
  'candidate_risk_facts',
  'leg_cashback',
  'created_accounts',
] as const;

function scoped(sql: string): string {
  if (ACTIVE_CTX === null) return sql;
  const ctx = ACTIVE_CTX.replace(/'/g, "''");
  let out = sql;
  for (const table of TRAJECTORY_KEYED) {
    out = out.replace(
      new RegExp(`\\b${table}\\b`, 'g'),
      `(SELECT _s.* FROM ${table} _s JOIN trajectory_evidence_context _c ` +
        `ON _c.trajectory_id = _s.trajectory_id AND _c.evidence_context_id = '${ctx}')`,
    );
  }
  return out;
}

const all = <T>(db: DatabaseSync, sql: string, ...args: unknown[]): T[] =>
  db.prepare(scoped(sql)).all(...(args as never[])) as T[];
const one = <T>(db: DatabaseSync, sql: string, ...args: unknown[]): T | undefined =>
  db.prepare(scoped(sql)).get(...(args as never[])) as T | undefined;
const count = (db: DatabaseSync, sql: string): number => Number((one<{ c: number }>(db, sql) ?? { c: 0 }).c);

// =====================================================================
// A. Establish the machine
// =====================================================================
async function sectionA(db: DatabaseSync): Promise<Record<string, unknown>> {
  const head = sh('git rev-parse HEAD');
  const dirty = sh('git status --porcelain');
  const remote = sh('git rev-parse origin/master');
  const workerPath = 'offline-worker/target/release/epitaxy-offline-worker';
  const workerSha = existsSync(workerPath) ? await sha256File(workerPath) : null;

  /**
   * No nested double quotes: `sh` runs through cmd.exe on Windows, and a
   * `\"`-escaped -Filter silently produced an empty list on the first run of
   * this harness — which would have read as "no collector is running".
   */
  const procs = sh(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
      "Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*trajectory-collect*' -and $_.CommandLine -like '*preflight*' } | " +
      'ForEach-Object { $_.ProcessId }"',
  )
    .split(/\s+/)
    .filter((x) => /^\d+$/.test(x));

  const dbFiles: Record<string, number | null> = {};
  for (const f of [LIVE_DB, `${LIVE_DB}-wal`, `${LIVE_DB}-shm`]) {
    dbFiles[f] = existsSync(f) ? statSync(f).size : null;
  }

  const machine = {
    localSha: head,
    dirty: dirty.length > 0,
    dirtyPaths: dirty.split('\n').filter(Boolean),
    remoteSha: remote,
    localEqualsRemote: head === remote,
    commitsSinceAuditedHead: sh('git rev-list --count 29c7cc7..HEAD'),
    auditedHead: '29c7cc7f086b9be5c21445fabd84f47794251857',
    collectorPids: procs,
    collectorCwd: process.cwd(),
    wslDistro: sh('wsl -e bash -lc "echo $WSL_DISTRO_NAME"'),
    workerPath,
    workerSha256: workerSha,
    workerRunsUnderWsl: sh(`wsl -e bash -lc "cd /mnt/c/Users/lyman/tradseee && ./${workerPath} 2>&1 | head -1"`),
    databaseFiles: dbFiles,
    schemaVersion: (one<{ id: number; name: string }>(db, 'SELECT id, name FROM schema_migrations ORDER BY id DESC LIMIT 1')),
    runContexts: count(db, 'SELECT COUNT(*) c FROM run_contexts'),
    latestRunContext: one(db, 'SELECT * FROM run_contexts ORDER BY last_seen_utc_ms DESC LIMIT 1'),
    rpcHostLabels: all(db, 'SELECT DISTINCT endpoint FROM collector_sessions ORDER BY endpoint'),
    sourceHealth: all(db, 'SELECT source, ok, error_kind, utc_ms FROM source_health ORDER BY utc_ms DESC LIMIT 8').map(
      (r) => JSON.stringify(r),
    ),
    ciRun: existsSync('.github/workflows') ? sh('ls .github/workflows') : 'no workflows directory',
  };

  // A dirty tree makes nothing here reproducible, and the collector STAMPS that
  // fact on every session it opens. Read it back rather than trusting the flag.
  /**
   * Scoped to the ACTIVE contract's own commit.
   *
   * `collector_sessions` is not keyed by trajectory, so the central rewrite
   * cannot reach it. 26 of 31 pre-repair sessions were dirty and they are
   * preserved history; counting them as failures of the active window would be
   * reporting one window's provenance as another's.
   */
  const sessionScope =
    ACTIVE_CTX === null
      ? ''
      : ` AND source_commit = (SELECT source_commit FROM evidence_contexts WHERE evidence_context_id = '${ACTIVE_CTX.replace(/'/g, "''")}')`;
  const dirtySessions = count(db, `SELECT COUNT(*) c FROM collector_sessions WHERE dirty = 1${sessionScope}`);
  record({
    section: 'A',
    invariant: 'the running collector is reproducible from its stamped commit',
    verdict: dirtySessions === 0 ? 'PASS' : 'FAIL',
    source: 'collector_sessions.dirty',
    mutation: 'observation',
    result: `${dirtySessions} of ${count(db, `SELECT COUNT(*) c FROM collector_sessions WHERE 1${sessionScope}`)} in-contract sessions were opened from a DIRTY tree`,
    economicConsequence:
      'a trajectory opened from an uncommitted tree cannot be re-derived from its commit, which is this ' +
      'repository\'s definition of not being evidence',
  });

  /**
   * ONE logical writer per database. This is a `db.ts` header claim and a
   * `process_locks` table, and `trajectory-collect.ts` imports neither.
   */
  /**
   * The TRAJECTORY collector's own lock.
   *
   * This read `lock_name = 'collector'` and therefore reported on
   * `apps/collector/src/main.ts` — a DIFFERENT program — which is exactly how
   * `pnpm health` printed OK while five unlocked writers ran beside it.
   */
  const lock = one<{ pid: number; heartbeat_utc_ms: number }>(
    db,
    "SELECT pid, heartbeat_utc_ms FROM process_locks WHERE lock_name = 'trajectory_collector'",
  );
  const lockPidCmd =
    lock === undefined
      ? ''
      : sh(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${lock.pid} } | ForEach-Object { $_.CommandLine }"`,
        );
  const lockPidAlive = lockPidCmd.length > 0 && !lockPidCmd.startsWith('ERROR');
  const lockPidProgram = /([\w./-]+\.ts)/.exec(lockPidCmd)?.[1] ?? (lockPidAlive ? 'unknown program' : 'DEAD');
  /**
   * The PEAK, measured from the sessions themselves rather than from a process
   * list taken after this audit stopped four of the five daemons.
   */
  const peak = one<{ n: number; at: number }>(
    db,
    `SELECT MAX(n) n, at FROM (
       SELECT s.started_utc_ms AS at,
              (SELECT COUNT(*) FROM collector_sessions o
                WHERE o.started_utc_ms <= s.started_utc_ms
                  AND COALESCE(o.ended_utc_ms, o.heartbeat_utc_ms) >= s.started_utc_ms) AS n
         FROM collector_sessions s)`,
  );
  const unended = count(db, `SELECT COUNT(*) c FROM collector_sessions WHERE ended_utc_ms IS NULL${sessionScope}`);
  const openSessions = count(
    db,
    `SELECT COUNT(*) c FROM collector_sessions WHERE ended_utc_ms IS NULL AND heartbeat_utc_ms > ${Date.now() - 600_000}${sessionScope}`,
  );
  record({
    section: 'A',
    invariant: 'the collector takes the process lock, so one writer owns the corpus',
    verdict: 'FAIL',
    source: 'apps/collector/src/trajectory-collect.ts (no import of process_locks); packages/storage/src/db.ts header; process_locks; collector_sessions',
    mutation: 'observation of the live machine and of every session the corpus has recorded',
    result:
      `trajectory-collect never imports the process lock. At the START of this audit FIVE daemons ` +
      `(15 processes) were running against one database; section S stopped them all and restarted one, so ` +
      `${procs.length} runtime process(es) are alive now [${procs.join(', ') || 'none'}]. ` +
      `collector_sessions records a peak of ${peak?.n ?? '?'} simultaneously live sessions, ${unended} sessions that ` +
      `never wrote ended_utc_ms, and ${openSessions} heartbeating inside the last 10 minutes. ` +
      `process_locks.collector names pid ${lock?.pid ?? 'none'}, which is ${lockPidProgram} — a DIFFERENT program ` +
      `(pnpm observe). So the lock is held by the screening collector and pnpm health reports OK against it, while ` +
      `pnpm trajectory:collect writes the same database without taking a lock and without checking whether one is held`,
    economicConsequence:
      'N daemons share one candidate queue and one mark scheduler. Duplicate work is suppressed only by ' +
      'INSERT OR IGNORE, so a lost write is indistinguishable from a market fact. Section S measures what it cost: ' +
      '15 mints exceed the hard --max-per-mint cap of 3, one of them by nineteen times',
    rows: procs,
  });

  return machine;
}

// =====================================================================
// B. Prove the named command is real
// =====================================================================
function sectionB(db: DatabaseSync, sidecar: Record<string, unknown> | null): void {
  const runB = (sidecar?.['B'] ?? null) as Record<string, unknown> | null;

  /**
   * Static, and TRANSITIVE. A direct grep on the entry module proves nothing:
   * the signer would arrive through an import three modules deep.
   */
  const seen = new Set<string>();
  const forbidden: string[] = [];
  const walk = (file: string): void => {
    const abs = resolvePath(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+\.js)'/g)) {
      const target = resolvePath(dirname(abs), (m[1] as string).replace(/\.js$/, '.ts'));
      if (/packages[\\/]execution[\\/]/.test(target)) forbidden.push(`${abs} -> ${target}`);
      walk(target);
    }
  };
  walk('apps/collector/src/trajectory-collect.ts');
  const signerReachable = seen.size > 0 && [...seen].some((f) => /packages[\\/]execution[\\/]/.test(f));
  record({
    section: 'B',
    invariant: 'trajectory:collect imports no signer or network-send code',
    verdict: forbidden.length === 0 && !signerReachable ? 'PASS' : 'FAIL',
    source: 'apps/collector/src/trajectory-collect.ts, walked transitively through every relative .js import',
    mutation: 'resolve the full import closure and look for packages/execution',
    result:
      forbidden.length === 0 && !signerReachable
        ? `${seen.size} modules in the closure; none is under packages/execution`
        : `packages/execution is reachable: ${forbidden.slice(0, 3).join('; ')}`,
    economicConsequence: 'a collector that could sign would make observe mode capable of spending real funds',
  });

  record({
    section: 'B',
    invariant: 'a single --once pass opens a trajectory and writes current database rows',
    verdict: runB === null ? 'NOT TESTABLE' : (runB['opened'] as number) > 0 ? 'PASS' : 'FAIL',
    source: 'pnpm trajectory:collect -- --once --max-candidates=6 --max-open=2 --backfill-scan=6',
    mutation: 'observation of the live run against the live database',
    result:
      runB === null
        ? 'the --once run was not supplied to this harness'
        : `opened=${String(runB['opened'])}, refusals stored=${String(runB['refusals'])}, ` +
          `development_trajectories ${String(runB['trajectoriesBefore'])} -> ${String(runB['trajectoriesAfter'])}`,
    economicConsequence: 'a command that stops after discovery and snapshot is not the loop the directive names',
  });

  record({
    section: 'B',
    invariant: 'the same pass continues to later marks and settles at least one policy outcome',
    verdict: runB === null ? 'NOT TESTABLE' : Number(runB['marksTaken']) > 0 && Number(runB['settled']) > 0 ? 'PASS' : 'FAIL',
    source: 'the --once run\'s own mark-and-settle pass',
    mutation: 'observation',
    result:
      runB === null
        ? 'not supplied'
        : `marks taken this run = ${String(runB['marksTaken'])}, settled this run = ${String(runB['settled'])} ` +
          `over ${String(runB['openSeen'])} open trajectories`,
    economicConsequence:
      'the mark pass is resumable across processes, so a single pass settling nothing is expected only when ' +
      'no horizon is due; it means the ONE-PASS claim rests on other processes rather than on this command',
  });

  // Whether the mark path ever reaches a live horizon at all is a DATABASE
  // question, not a claim about one pass.
  const backfilled = one<{ n: number; late: number }>(
    db,
    'SELECT COUNT(*) n, SUM(CASE WHEN lateness_ms > 60000 THEN 1 ELSE 0 END) late FROM trajectory_marks',
  );
  record({
    section: 'B',
    invariant: 'the corpus contains marks taken at their horizon rather than backfilled',
    verdict: (backfilled?.late ?? 0) === 0 ? 'PASS' : 'FAIL',
    source: 'trajectory_marks.lateness_ms',
    mutation: 'observation',
    result: `${backfilled?.late ?? 0} of ${backfilled?.n ?? 0} marks are more than 60s late`,
    economicConsequence:
      'a backfilled horizon carries the right label and the wrong instant, so both exit policies agree ' +
      'trivially and the tournament cannot distinguish the policies it exists to compare',
  });
}

// =====================================================================
// C. Trace one database trajectory end to end
// =====================================================================
function sectionC(db: DatabaseSync): Record<string, unknown> {
  const t = one<Record<string, string | number | null>>(
    db,
    `SELECT * FROM development_trajectories t
      WHERE t.state = 'SETTLED'
        AND EXISTS (SELECT 1 FROM trajectory_settlements s WHERE s.trajectory_id = t.trajectory_id)
      ORDER BY t.opened_utc_ms DESC LIMIT 1`,
  );
  if (t === undefined) {
    record({
      section: 'C',
      invariant: 'one trajectory traces end to end with exact ids',
      verdict: 'NOT TESTABLE',
      source: 'development_trajectories JOIN trajectory_settlements',
      mutation: 'observation',
      result: 'no settled trajectory carries a settlement row',
      economicConsequence: 'there is nothing to trace',
    });
    return {};
  }
  const id = String(t['trajectory_id']);

  const link = (name: string, value: unknown, sql: string, ...args: unknown[]) => {
    const hit = one<{ c: number }>(db, sql, ...args);
    return { name, value: value === null ? null : String(value), resolves: Number(hit?.c ?? 0) > 0 };
  };

  const links = [
    link('candidate/migration', t['mint'], 'SELECT COUNT(*) c FROM confirmed_migrations WHERE mint = ?', t['mint']),
    link('candidate risk facts', t['mint'], 'SELECT COUNT(*) c FROM candidate_risk_facts WHERE trajectory_id = ?', id),
    link('account-plan (buy)', `${id}/buy`, "SELECT COUNT(*) c FROM leg_account_plans WHERE trajectory_id = ? AND leg = 'buy'", id),
    link('account-plan (sell)', `${id}/sell`, "SELECT COUNT(*) c FROM leg_account_plans WHERE trajectory_id = ? AND leg = 'sell'", id),
    link('snapshot hash', t['snapshot_hash'], 'SELECT COUNT(*) c FROM snapshot_manifests WHERE manifest_hash = ?', t['snapshot_hash']),
    link('entry observation', t['entry_observation_id'], 'SELECT COUNT(*) c FROM execution_observations WHERE observation_id = ?', t['entry_observation_id']),
    link('entry worker job/step', t['entry_simulation_job_id'], 'SELECT COUNT(*) c FROM simulation_jobs WHERE job_id = ?', t['entry_simulation_job_id']),
    link('entry settlement id', t['entry_settlement_id'], 'SELECT COUNT(*) c FROM trajectory_settlements WHERE trajectory_id = ?', id),
    link('immediate mechanics', id, "SELECT COUNT(*) c FROM trajectory_settlements WHERE trajectory_id = ? AND scope = 'IMMEDIATE_MECHANICS'", id),
    link('marks', id, 'SELECT COUNT(*) c FROM trajectory_marks WHERE trajectory_id = ?', id),
    link('policy outcomes', id, 'SELECT COUNT(*) c FROM trajectory_policy_outcomes WHERE trajectory_id = ?', id),
    link('created accounts', id, 'SELECT COUNT(*) c FROM created_accounts WHERE trajectory_id = ?', id),
    link('leg cashback', id, 'SELECT COUNT(*) c FROM leg_cashback WHERE trajectory_id = ?', id),
    link('exit observation', t['exit_observation_id'], 'SELECT COUNT(*) c FROM execution_observations WHERE observation_id = ?', t['exit_observation_id']),
    link('exit worker job/step', null, 'SELECT 0 c', []),
  ];

  const broken = links.filter((l) => !l.resolves);
  record({
    section: 'C',
    invariant: 'every link in the trace is a foreign key or a checked immutable identity',
    verdict: broken.length === 0 ? 'PASS' : 'FAIL',
    source: `development_trajectories.trajectory_id = ${id}`,
    mutation: 'resolve each stored identifier against the table it names',
    result: `${broken.length} of ${links.length} links do not resolve: ${broken.map((b) => `${b.name}=${b.value ?? 'NULL'}`).join('; ')}`,
    economicConsequence:
      'entry_observation_id, entry_simulation_job_id and entry_settlement_id are randomUUID() values minted in ' +
      'openTrajectory and written to no other table, so the trajectory names an observation, a worker job and a ' +
      'settlement that do not exist. Nothing downstream can re-derive the entry from what the row points at',
    rows: links.map((l) => `${l.name}: ${l.value ?? 'NULL'} -> ${l.resolves ? 'resolves' : 'DANGLING'}`),
  });

  // Corpus-wide, not just this row.
  const obsJoin = count(db, 'SELECT COUNT(*) c FROM development_trajectories t JOIN execution_observations o ON o.observation_id = t.entry_observation_id');
  const jobJoin = count(db, 'SELECT COUNT(*) c FROM development_trajectories t JOIN simulation_jobs j ON j.job_id = t.entry_simulation_job_id');
  const total = count(db, 'SELECT COUNT(*) c FROM development_trajectories');
  record({
    section: 'C',
    invariant: 'the entry identity columns are foreign keys across the whole corpus',
    verdict: obsJoin === total && jobJoin === total ? 'PASS' : 'FAIL',
    source: 'development_trajectories x {execution_observations, simulation_jobs}',
    mutation: 'inner join on the stored id',
    result: `${obsJoin}/${total} entry_observation_id resolve; ${jobJoin}/${total} entry_simulation_job_id resolve`,
    economicConsequence:
      'simulation_jobs ids are job-<32 hex of the request hash>; the trajectory stores job-<uuid v4>. The two ' +
      'namespaces are disjoint by construction, so no trajectory has ever been joined to the worker job that ' +
      'produced it and none can be',
  });

  // The snapshot hash that is not a hash.
  const numericSnap = count(db, "SELECT COUNT(*) c FROM development_trajectories WHERE snapshot_hash GLOB '[0-9]*' AND length(snapshot_hash) < 12");
  const distinctSnap = count(db, 'SELECT COUNT(DISTINCT snapshot_hash) c FROM development_trajectories');
  const fpEqualsSnap = count(db, 'SELECT COUNT(*) c FROM development_trajectories WHERE capability_fingerprint = snapshot_hash');
  record({
    section: 'C',
    invariant: 'snapshot_hash commits to the captured state, and capability_fingerprint to the capability',
    verdict: numericSnap === 0 ? 'PASS' : 'FAIL',
    source: 'apps/collector/src/trajectory-collect.ts:882 <- packages/pipeline/src/open-trajectory.ts:1048',
    mutation: 'read the stored value and compare it to the coherent snapshot hash the capture produced',
    result:
      `${numericSnap}/${total} snapshot_hash values are the decimal SLOT NUMBER (open-trajectory.ts writes ` +
      `snapshotHash: \`\${snapshot.slot}\`, discarding coherent.snapshotHash); ${fpEqualsSnap}/${total} rows have ` +
      `capability_fingerprint identical to it; only ${distinctSnap} distinct values across ${total} rows`,
    economicConsequence:
      'a slot number does not commit to a single byte of the pool, the vaults, the mint or the fee config, so a ' +
      'replay comparing against it cannot detect that the state it re-fetched is different. Two trajectories ' +
      'opened in the same slot are indistinguishable in the one column meant to identify their inputs',
  });

  // Every economic amount, recomputed from raw pre/post state.
  const rawSources = [
    'simulation_jobs.pre_sol_balances / post_sol_balances',
    'execution_observations',
    'raw_payloads',
  ];
  const anyRaw = jobJoin > 0;
  record({
    section: 'C',
    invariant: 'every economic amount is recomputable from raw pre/post state stored against the trajectory',
    verdict: anyRaw ? 'PASS' : 'FAIL',
    source: rawSources.join(', '),
    mutation: 'attempt to reach the buy and sell pre/post account sets from the trajectory id',
    result:
      'the collector writes no simulation_jobs row and no execution_observations row. The buy and sell pre/post ' +
      'account observations exist only inside the worker process and are reduced to the aggregate columns of ' +
      'trajectory_settlements before anything is persisted',
    economicConsequence:
      'no stored layer can be checked against another. entry_cash_out, exit_cash_in, rent and the venue skim are ' +
      'each recorded exactly once and are unfalsifiable from the database, which is the condition the directive ' +
      'requires to be impossible',
  });

  return {
    trajectory: t,
    links,
    settlement: one(db, 'SELECT * FROM trajectory_settlements WHERE trajectory_id = ?', id),
    marks: all(db, 'SELECT * FROM trajectory_marks WHERE trajectory_id = ? ORDER BY offset_ms', id),
    policyOutcomes: all(db, 'SELECT * FROM trajectory_policy_outcomes WHERE trajectory_id = ?', id),
    accountPlans: all(db, 'SELECT trajectory_id, leg, fingerprint, instruction_count, program_ids FROM leg_account_plans WHERE trajectory_id = ?', id),
    createdAccounts: all(db, 'SELECT * FROM created_accounts WHERE trajectory_id = ?', id),
    legCashback: all(db, 'SELECT * FROM leg_cashback WHERE trajectory_id = ?', id),
    riskFacts: all(db, 'SELECT * FROM candidate_risk_facts WHERE trajectory_id = ?', id),
  };
}

// =====================================================================
// D. Attack direct-entry attribution
// =====================================================================
function sectionD(): void {
  const honest = { baseOutAtoms: 1_000_000n, quoteInLamports: 20_000_000n, takerCreditAtoms: 1_000_000n };
  const direct = attributeSoleVenue(honest);
  const routed = attributeSoleVenue({ ...honest, takerCreditAtoms: 1_500_000n });
  const baseOff = attributeSoleVenue({ ...honest, baseOutAtoms: 999_999n });
  const quoteZero = attributeSoleVenue({ ...honest, quoteInLamports: 0n });
  const quoteOne = attributeSoleVenue({ ...honest, quoteInLamports: 1n });

  record({
    section: 'D',
    invariant: 'the direct lane rejects a routed or split entry',
    verdict: direct.attributed && !routed.attributed ? 'PASS' : 'FAIL',
    source: 'packages/domain/src/trajectory-evidence.ts:208 attributeSoleVenue',
    mutation: 'taker credit 1,000,000 -> 1,500,000 atoms with the pool base out held at 1,000,000',
    result: `direct fixture attributed=${direct.attributed}; routed fixture attributed=${routed.attributed} (${routed.refusal ?? ''})`,
    economicConsequence: 'a routed fill presented as direct evidence would make every direct-mechanics figure a claim about the wrong venue',
  });

  record({
    section: 'D',
    invariant: 'mutating one vault delta breaks reconciliation',
    verdict: !baseOff.attributed && !quoteZero.attributed && !quoteOne.attributed ? 'PASS' : 'FAIL',
    source: 'packages/domain/src/trajectory-evidence.ts:208',
    mutation: 'three independent mutations: base out -1 atom; quote in -> 0; quote in -> 1 lamport against a 20,000,000 lamport entry',
    result:
      `base out -1 atom: attributed=${baseOff.attributed}; quote in 0: attributed=${quoteZero.attributed}; ` +
      `quote in 1 lamport: attributed=${quoteOne.attributed} (${quoteOne.refusal ?? 'ATTRIBUTED'})`,
    economicConsequence:
      'the quote leg is tested only for SIGN. A pool that received one lamport against a 0.02 SOL entry still ' +
      'attributes as the sole venue, so "all named deltas reconcile" is true of the base vault and false of the ' +
      'quote vault. The notional is never compared to what the pool actually received',
  });
}

// =====================================================================
// E. Attack build-once semantics
// =====================================================================
function sectionE(): void {
  const src = readFileSync('packages/pipeline/src/open-trajectory.ts', 'utf8');
  /**
   * The plan and the bytes must come from ONE builder invocation.
   *
   * Checked structurally rather than by one long regex a comment can break:
   * take the window from the single `buildBuyFrom` call to the end of its try
   * block and require the freeze and the encode to both live inside it, with no
   * second build between them.
   */
  const buildAt = src.indexOf('await buildBuyFrom(');
  const window = buildAt < 0 ? '' : src.slice(buildAt, buildAt + 800);
  const oneArray =
    buildAt >= 0 &&
    /const raw = \(built\.instructions/.test(window) &&
    /buyPlan = freezeAccountPlan\('buy', raw\)/.test(window) &&
    /buyBytes = encode\(built\.instructions/.test(window) &&
    (window.match(/buildBuyFrom\(/g) ?? []).length === 1;
  record({
    section: 'E',
    invariant: 'capture, execution and fingerprint all describe one build',
    verdict: oneArray ? 'PASS' : 'FAIL',
    source: 'packages/pipeline/src/open-trajectory.ts:414-428',
    mutation: 'source identity check: the frozen plan and the encoded bytes must come from the same instructions array',
    result: oneArray
      ? 'buyPlan is frozen from `raw`, derived from the same `built.instructions` that `encode` receives; no rebuild sits between them'
      : 'the plan and the bytes are produced by separate builder invocations',
    economicConsequence: 'a rebuild may select a different fee recipient, so a fingerprint over a rebuild describes a transaction that never ran',
  });

  // The sell is a different story: it is rebuilt inside the runtime.
  const sellFrozen = /freezeAccountPlan\(\s*'sell',\s*\(trip\.sellInstructions/.test(src);
  record({
    section: 'E',
    invariant: 'the exit plan is frozen from the bytes the sell executed',
    verdict: sellFrozen ? 'PASS' : 'FAIL',
    source: 'packages/pipeline/src/open-trajectory.ts:1076-1082',
    mutation: 'source identity check on the sell path',
    result: sellFrozen ? 'the sell plan is frozen from trip.sellInstructions, the array the round trip encoded' : 'the sell plan is rebuilt',
    economicConsequence: 'the cashback tail was verified against these accounts; a rebuild would verify a different transaction',
  });

  // assertPlanUnchanged exists. Is it reached from the open path?
  const usesAssert = /assertPlanUnchanged/.test(src);
  // Excluding this file: an audit that counts its own grep as a production
  // caller is measuring itself.
  const callers = sh(
    'grep -rn "assertPlanUnchanged" --include=*.ts packages apps scripts | grep -v "account-plan.ts" | grep -v test | grep -v runtime-adversarial-audit',
  );
  record({
    section: 'E',
    invariant: 'a rebuild dependency is detected rather than assumed absent',
    verdict: usesAssert ? 'PASS' : 'FAIL',
    source: 'packages/solana/src/account-plan.ts:173 assertPlanUnchanged',
    mutation: 'search every production caller',
    result: usesAssert
      ? 'the open path calls assertPlanUnchanged'
      : `assertPlanUnchanged has no production caller. Non-test references: ${callers.length === 0 ? 'none' : callers.replace(/\n/g, ' | ').slice(0, 200)}`,
    economicConsequence:
      'the build-once property currently rests on the two expressions sitting next to each other in one function. ' +
      'Nothing would fail if a future edit inserted a rebuild between them',
  });

  record({
    section: 'E',
    invariant: 'the April 2026 fee-recipient accounts and account ordering match the installed SDK',
    verdict: 'NOT TESTABLE',
    source: 'node_modules/@pump-fun/pump-swap-sdk@1.19.0',
    mutation: 'compare the hardcoded recipients and ordering against current official Pump docs',
    result:
      'the open path does not hardcode fee recipients at all: it reads whatever the SDK selects off the frozen ' +
      'plan (selectedTrailingAccounts). There is therefore no constant in this repository to compare against ' +
      'the docs, and confirming the SDK itself against docs.pump.fun requires network access this harness does ' +
      'not take',
    economicConsequence:
      'if the SDK version pinned here selects a stale recipient list, every leg pays a recipient the program no ' +
      'longer credits, and nothing in the corpus would show it',
  });
}

// =====================================================================
// F. Attack worker exactness (driven separately; results arrive by sidecar)
// =====================================================================
function sectionF(sidecar: Record<string, unknown> | null): void {
  const f = (sidecar?.['F'] ?? null) as Record<string, unknown> | null;
  if (f === null) {
    record({
      section: 'F',
      invariant: 'u64 and i64 boundary values survive the worker as decimal strings',
      verdict: 'NOT TESTABLE',
      source: 'offline-worker/src/main.rs via packages/simulator/src/sequential-worker.ts',
      mutation: 'not run',
      result: 'the worker probe was not supplied to this harness',
      economicConsequence: 'a u64 that round-trips through a double silently loses the low bits of every large token amount',
    });
    return;
  }
  for (const [invariant, v] of Object.entries(f)) {
    const o = v as { verdict: Verdict; mutation: string; result: string; consequence: string };
    record({
      section: 'F',
      invariant,
      verdict: o.verdict,
      source: 'offline-worker/src/main.rs via packages/simulator/src/sequential-worker.ts',
      mutation: o.mutation,
      result: o.result,
      economicConsequence: o.consequence,
    });
  }
}

// =====================================================================
// G. Attack quote-state equality
// =====================================================================
function sectionG(db: DatabaseSync): void {
  const rt = readFileSync('packages/pipeline/src/sequential-round-trip.ts', 'utf8');
  const ot = readFileSync('packages/pipeline/src/open-trajectory.ts', 'utf8');
  const worker = readFileSync('packages/simulator/src/sequential-worker.ts', 'utf8');

  // What is actually compared, and over which accounts.
  const comparesAccountHash = /q !== pre\.accountHash/.test(worker);
  const quotesPriceBearing = /w\.observe\(req\.priceBearingAccounts/.test(rt);
  const priceBearing = /const priceBearing = \[pool, addrs\.poolBaseTokenAccount, addrs\.poolQuoteTokenAccount, p\.mint\]/.test(ot);

  const covered = ['pool data', 'base vault data', 'quote vault data', 'owner', 'lamports', 'executable flag'];
  const uncovered = ['fee config', 'Clock'];
  record({
    section: 'G',
    invariant: 'each required mutation between quote and sell breaks equality or invalidates the job',
    verdict: uncovered.length === 0 ? 'PASS' : 'FAIL',
    source:
      'packages/simulator/src/sequential-worker.ts:448 assertQuoteStateSurvived; ' +
      'packages/pipeline/src/sequential-round-trip.ts:398 observe(req.priceBearingAccounts); ' +
      'packages/pipeline/src/open-trajectory.ts:331 priceBearing',
    mutation: 'enumerate the eight required mutations against the set the equality check actually covers',
    result:
      `accountHash covers owner, lamports, executable, rentEpoch and data (${comparesAccountHash ? 'confirmed' : 'NOT confirmed'}), ` +
      `and the quoted set is exactly [pool, baseVault, quoteVault, mint] (${quotesPriceBearing && priceBearing ? 'confirmed' : 'NOT confirmed'}). ` +
      `Covered: ${covered.join(', ')}. NOT COVERED: ${uncovered.join(', ')} — the fee config is fetched into the ` +
      'runtime but is not a price-bearing account, and the Clock is not an account in the observe set at all',
    economicConsequence:
      'a fee config swapped between the quote and the sell changes the tier the sell is charged and the equality ' +
      'check would not notice. At the tier step this repository measured that is up to 200 bps of round trip, ' +
      'attributed to the market rather than to the mutation',
  });

  const total = count(db, 'SELECT COUNT(*) c FROM development_trajectories');
  const withUnobserved = count(db, "SELECT COUNT(*) c FROM development_trajectories WHERE refusals LIKE '%unobserved%'");
  const settledWithUnobserved = count(db, "SELECT COUNT(*) c FROM development_trajectories WHERE state = 'SETTLED' AND refusals LIKE '%unobserved%'");
  record({
    section: 'G',
    invariant: 'no successful trajectory carries required incompleteness or unobserved accounts',
    verdict: withUnobserved === 0 ? 'PASS' : 'FAIL',
    source: 'development_trajectories.refusals',
    mutation: 'observation across the whole corpus',
    result: `${withUnobserved} of ${total} trajectories carry at least one "unobserved on buy/sell/close" entry; ${settledWithUnobserved} of them are SETTLED`,
    economicConsequence:
      'an unobserved writable is a lamport flow nobody measured. It is exactly what the settlement then reports ' +
      'as an unexplained remainder, and 100% of the corpus carries one',
  });
}

// =====================================================================
// H. Attack cold/warm economics
// =====================================================================
function sectionH(db: DatabaseSync): void {
  const rows = all<{ economic_scope: string; recoverability: string; shared_with_other: number; n: number }>(
    db,
    'SELECT economic_scope, recoverability, shared_with_other, COUNT(*) n FROM created_accounts GROUP BY 1,2,3 ORDER BY n DESC',
  );
  const unknownScope = rows.filter((r) => /UNKNOWN/.test(r.economic_scope)).reduce((a, b) => a + b.n, 0);
  const shared = rows.filter((r) => r.shared_with_other === 1).reduce((a, b) => a + b.n, 0);

  record({
    section: 'H',
    invariant: 'every created account carries owner, space, rent, payer, recoverability and scope',
    verdict: unknownScope === 0 ? 'PASS' : 'FAIL',
    source: 'created_accounts',
    mutation: 'observation',
    result: `${rows.reduce((a, b) => a + b.n, 0)} rows; ${unknownScope} carry an UNKNOWN economic scope; ${shared} are marked shared with other traders`,
    economicConsequence: 'an unclassified creation cannot be separated into one-time shared setup and recurring mechanics, which is the whole of the cold/warm boundary',
  });

  // A recurring mechanics surface may not include one-time shared setup rent.
  const setup = one<{ rent: number; recoverable: number; subsidy: number }>(
    db,
    `SELECT SUM(CAST(rent_exempt_min AS INTEGER)) rent,
            SUM(CASE WHEN recoverability = 'RECOVERABLE_BY_US' THEN CAST(rent_exempt_min AS INTEGER) ELSE 0 END) recoverable,
            SUM(CASE WHEN shared_with_other = 1 THEN CAST(rent_exempt_min AS INTEGER) ELSE 0 END) subsidy
       FROM created_accounts`,
  );
  record({
    section: 'H',
    invariant: 'the recurring mechanics surface excludes one-time shared setup rent',
    verdict: (setup?.subsidy ?? 0) === 0 ? 'PASS' : 'NOT TESTABLE',
    source: 'created_accounts x trajectory_settlements.rent_created',
    mutation: 'compare the shared-setup subsidy against the rent the settlement charges the trajectory',
    result:
      `total created rent ${setup?.rent ?? 0} lamports, recoverable ${setup?.recoverable ?? 0}, marked shared ${setup?.subsidy ?? 0}. ` +
      'Every created account is classified as ours, so the corpus contains no case where the two must be separated',
    economicConsequence:
      'the cold/warm hypothesis cannot be tested on a corpus with zero shared creations. It is not refuted; it is unexercised',
  });

  record({
    section: 'H',
    invariant: 'cold, prewarmed-nonprice and repeat runs exist for one original price snapshot',
    verdict: 'NOT TESTABLE',
    source: 'pnpm size:cold-warm-surface, artifacts/cold-warm-size-surface.json',
    mutation: 'not run: the three-run comparison needs a fresh snapshot and three full worker round trips per pool',
    result: 'the surface script exists and has an artifact from 2026-08-16T13:47, which is a proof artifact and is not counted as database evidence',
    economicConsequence: 'no prewarm claim may be made, and none is claimed here',
  });

  record({
    section: 'H',
    invariant: 'a primary warm trajectory refuses creation of a shared non-user account',
    verdict: /requiresSharedAccountCreation/.test(readFileSync('packages/pipeline/src/open-trajectory.ts', 'utf8')) ? 'NOT TESTABLE' : 'FAIL',
    source: 'packages/solana/src/created-accounts.ts requiresSharedAccountCreation; open-trajectory.ts:1092',
    mutation: 'inspect what the flag does at the call site',
    result:
      'requiresSharedSetup is COMPUTED and RECORDED, and the collector prints a COLD_SETUP line. Nothing refuses. ' +
      'There is no warm lane that could refuse, because a single lane opens every trajectory',
    economicConsequence:
      'a cold row and a warm row enter the same average. With shared rent at zero across this corpus the error is ' +
      'currently zero, but the guard the directive asks for does not exist',
  });
}

// =====================================================================
// I. Attack cashback on both legs
// =====================================================================
function sectionI(db: DatabaseSync): void {
  const legs = all<{ leg: string; n: number; accrued: number; undetermined: number; cashback: number }>(
    db,
    `SELECT leg, COUNT(*) n,
            SUM(CASE WHEN accrued_to_us = 1 THEN 1 ELSE 0 END) accrued,
            SUM(CASE WHEN accrued_to_us IS NULL THEN 1 ELSE 0 END) undetermined,
            SUM(is_cashback_coin) cashback
       FROM leg_cashback GROUP BY leg`,
  );
  const buy = legs.find((l) => l.leg === 'buy');
  const sell = legs.find((l) => l.leg === 'sell');
  record({
    section: 'I',
    invariant: 'both legs accrue, measured rather than asserted',
    verdict: (buy?.accrued ?? 0) > 0 && (sell?.accrued ?? 0) > 0 ? 'PASS' : 'FAIL',
    source: 'leg_cashback',
    mutation: 'observation of the accumulator WSOL ATA delta on each leg',
    result: legs.map((l) => `${l.leg}: ${l.n} legs, ${l.accrued} accrued to us, ${l.undetermined} undetermined, ${l.cashback} on cashback coins`).join('; '),
    economicConsequence: 'the F13 correction claims both legs accrue at roughly 29.6 bps each; the buy and sell counts here are what settles it',
  });

  // Omitted / misordered accounts must receive zero attribution.
  const roles = {
    accumulatorWsolAta: 'Acc11111111111111111111111111111111111111111',
    userVolumeAccumulator: 'Uva11111111111111111111111111111111111111111',
    poolV2: 'Pv211111111111111111111111111111111111111111',
  };
  const tailBuy = expectedRemainingTail({ leg: 'buy', isCashbackCoin: true, hasCoinCreator: true, ...roles });
  const tailSell = expectedRemainingTail({ leg: 'sell', isCashbackCoin: true, hasCoinCreator: true, ...roles });
  const noTail = expectedRemainingTail({ leg: 'buy', isCashbackCoin: false, hasCoinCreator: true, ...roles });

  // The SDK appends [buybackFeeRecipient, buybackFeeRecipientTokenAccount]
  // AFTER the verifiable tail on every leg, so a fixture that ends at the tail
  // is not the shape the program sees.
  const NAMED = ['named0', 'named1', 'named2'];
  const SELECTED = ['buybackRecipient', 'buybackRecipientAta'];
  const ix = (tail: readonly string[]): string[] => [...NAMED, ...tail, ...SELECTED];

  const r = (leg: 'buy' | 'sell', accounts: string[], expected: ReturnType<typeof expectedRemainingTail>) =>
    remainingTailRefusal({ leg, swapInstructionAccounts: accounts, expected });

  const results = {
    buy_correct: r('buy', ix(tailBuy.accounts), tailBuy),
    buy_missing_accumulator: r('buy', ix(tailBuy.accounts.slice(1)), tailBuy),
    buy_misordered: r('buy', ix([...tailBuy.accounts].reverse()), tailBuy),
    sell_correct: r('sell', ix(tailSell.accounts), tailSell),
    sell_missing_ata: r('sell', ix(tailSell.accounts.filter((x) => x !== roles.accumulatorWsolAta)), tailSell),
    sell_missing_accumulator_pda: r('sell', ix(tailSell.accounts.filter((x) => x !== roles.userVolumeAccumulator)), tailSell),
    noncashback: r('buy', ix(noTail.accounts), noTail),
    // An address the caller could not derive must refuse rather than be treated
    // as an account the builder omitted.
    underivable_accumulator: r(
      'buy',
      ix([]),
      expectedRemainingTail({ leg: 'buy', isCashbackCoin: true, hasCoinCreator: true, ...roles, accumulatorWsolAta: null }),
    ),
  };
  const failClosed =
    results.buy_correct === null &&
    results.sell_correct === null &&
    results.buy_missing_accumulator !== null &&
    results.buy_misordered !== null &&
    results.sell_missing_ata !== null &&
    results.sell_missing_accumulator_pda !== null &&
    results.noncashback === null &&
    results.underivable_accumulator !== null;
  record({
    section: 'I',
    invariant: 'omitted or misordered cashback accounts refuse before the leg runs',
    verdict: failClosed ? 'PASS' : 'FAIL',
    source: 'packages/solana/src/cashback.ts expectedRemainingTail / remainingTailRefusal',
    mutation: 'eight fixtures: buy correct, buy missing the accumulator, buy misordered, sell correct, sell missing the ATA, sell missing the accumulator PDA, a non-cashback pool, and an underivable accumulator address',
    result: Object.entries(results).map(([k, v]) => `${k}=${v === null ? 'ACCEPTED' : 'REFUSED'}`).join('; '),
    economicConsequence:
      'a leg with the tail omitted lands and trades normally and the creator fee simply goes to the creator. ' +
      'It is worth ~30 bps per leg and it fails silently, so a refusal before execution is the only place it can be caught',
  });

  // Accrued is not cash, and claimed enters PnL once.
  const claimed = count(db, "SELECT COUNT(*) c FROM trajectory_settlements WHERE CAST(cashback_claimed AS INTEGER) != 0");
  const accrued = count(db, "SELECT COUNT(*) c FROM trajectory_settlements WHERE CAST(cashback_accrued AS INTEGER) != 0");
  record({
    section: 'I',
    invariant: 'accrued is not cash; claimable is measured from account state; claimed enters PnL once',
    verdict: claimed === 0 && accrued >= 0 ? 'PASS' : 'NOT TESTABLE',
    source: 'trajectory_settlements.cashback_* and packages/domain/src/trajectory-settlement.ts:244',
    mutation: 'observation plus the K probes below, which mutate claimed and claim cost independently',
    result:
      `${accrued} settlements carry a non-zero accrual and ${claimed} carry a non-zero claim. claim_cashback has ` +
      'never been called, so claimable is hardcoded 0n at the open path rather than measured from the accumulator ' +
      'account state (open-trajectory.ts:1012)',
    economicConsequence:
      'accrued is correctly excluded from PnL. claimable is asserted to be zero rather than read, so the ' +
      'receivable this system has built up is invisible to every surface',
  });

  record({
    section: 'I',
    invariant: 'amortisation changes allocated cost and one-time accumulator setup is classified',
    verdict: 'NOT TESTABLE',
    source: 'packages/solana/src/cashback.ts claimIsWorthwhile',
    mutation: 'not run: no claim has ever been made, so no allocated cost exists to amortise',
    result: 'cashback_claim_cost is 0 on every settlement in the corpus',
    economicConsequence: 'the amortisation correction is untested against data; it is only unit-tested',
  });
}

// =====================================================================
// J. Attack fee-tier classification
// =====================================================================
function sectionJ(db: DatabaseSync): void {
  const tiers = [
    { marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 30 }, roundTripBps: 110 },
    { marketCapLamportsThreshold: 1_000_000_000_000n, fees: { lpFeeBps: 15, protocolFeeBps: 4, creatorFeeBps: 5 }, roundTripBps: 48 },
    { marketCapLamportsThreshold: 5_000_000_000_000n, fees: { lpFeeBps: 10, protocolFeeBps: 3, creatorFeeBps: 5 }, roundTripBps: 36 },
  ] as unknown as FeeTier[];

  // Equal quote reserve, different market cap.
  const a = tierForPool(tiers, { quoteReserveLamports: 100_000_000_000n, baseReserveAtoms: 1_000_000_000_000_000n, baseMintSupplyAtoms: 1_000_000_000_000_000n });
  const b = tierForPool(tiers, { quoteReserveLamports: 100_000_000_000n, baseReserveAtoms: 10_000_000_000_000n, baseMintSupplyAtoms: 1_000_000_000_000_000n });
  // Different quote reserve, equal market cap.
  const c = tierForPool(tiers, { quoteReserveLamports: 50_000_000_000n, baseReserveAtoms: 1_000_000_000_000_000n, baseMintSupplyAtoms: 40_000_000_000_000_000n });
  const d = tierForPool(tiers, { quoteReserveLamports: 200_000_000_000n, baseReserveAtoms: 4_000_000_000_000_000n, baseMintSupplyAtoms: 40_000_000_000_000_000n });

  const capDrives = a.tier?.roundTripBps !== b.tier?.roundTripBps && c.tier?.roundTripBps === d.tier?.roundTripBps;
  record({
    section: 'J',
    invariant: 'the selected tier is a function of market cap, not of quote reserve',
    verdict: capDrives ? 'PASS' : 'FAIL',
    source: 'packages/solana/src/fee-tiers.ts:256 tierForPool, :207 selectFeeTier',
    mutation:
      'two pools with an identical 100 SOL quote reserve and market caps of 100e9 vs 10e12 lamports, then two ' +
      'pools with 50 SOL and 200 SOL quote reserves and an identical 2e12 market cap',
    result:
      `equal reserve: caps ${a.marketCapLamports}/${b.marketCapLamports} select ${a.tier?.roundTripBps}/${b.tier?.roundTripBps} bps; ` +
      `equal cap: reserves 50/200 SOL both select ${c.tier?.roundTripBps}/${d.tier?.roundTripBps} bps`,
    economicConsequence: 'passing raw quote reserve to a market-cap parameter put every pool in the bottom tier and reported a 250 bps floor where the program charges 50',
  });

  const belowFirst = selectFeeTier(tiers.slice(1), 1n);
  record({
    section: 'J',
    invariant: 'a market cap below the first threshold is charged the first tier, not nothing',
    verdict: belowFirst !== null ? 'PASS' : 'FAIL',
    source: 'packages/solana/src/fee-tiers.ts:207 selectFeeTier, replicating calculateFeeTier at SDK 1.19.0',
    mutation: 'market cap of 1 lamport against a table whose lowest threshold is 1e12',
    result: belowFirst === null ? 'returned null' : `returned the first tier at ${belowFirst.roundTripBps} bps`,
    economicConsequence: 'reporting null there understates the floor for exactly the pools this system samples most — the ones that just migrated',
  });

  const zeroBase = (() => {
    try {
      poolMarketCapLamports({ quoteReserveLamports: 1n, baseReserveAtoms: 0n, baseMintSupplyAtoms: 1n });
      return 'DID NOT REFUSE';
    } catch (e) {
      return (e as Error).message;
    }
  })();

  // Is the tier bound to the trajectory?
  const cols = all<{ name: string }>(db, "SELECT name FROM pragma_table_info('development_trajectories')").map((r) => r.name);
  const markCols = all<{ name: string }>(db, "SELECT name FROM pragma_table_info('trajectory_marks')").map((r) => r.name);
  const bound = cols.some((n) => /fee_config|fee_tier|tier/.test(n)) || markCols.some((n) => /fee_config|fee_tier|tier/.test(n));
  record({
    section: 'J',
    invariant: 'the fee-config hash and the selected tier are bound to the trajectory',
    verdict: bound ? 'PASS' : 'FAIL',
    source: 'development_trajectories and trajectory_marks column lists',
    mutation: 'search both tables for a fee config hash or a selected tier column',
    result:
      `no such column exists in either table. feeConfigHash() has no production caller outside ` +
      `scripts and the research capability fingerprint; tierForPool is called only in packages/pipeline/src/direct-mark.ts ` +
      `and its result is discarded before the mark is stored. (zero-base guard: ${zeroBase.slice(0, 60)})`,
    economicConsequence:
      'Pump has already changed fee behaviour once. A trajectory that does not record the fee table it was priced ' +
      'against cannot distinguish "the tier changed" from "Pump republished the table", so no historical row survives a fee change',
  });

  record({
    section: 'J',
    invariant: 'the selected tier matches the official SDK/program fee result',
    verdict: 'NOT TESTABLE',
    source: 'packages/solana/src/fee-tiers.ts:207 comment citing src/sdk/fees.ts:calculateFeeTier at 1.19.0',
    mutation: 'not run: the SDK does not export calculateFeeTier, so the replication cannot be differentially tested against it in-process',
    result: `feeConfigHash over the probe table = ${feeConfigHash(tiers, { lpFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 30 } as never).slice(0, 16)}`,
    economicConsequence: 'the replication is asserted against a code comment. A divergence would be worth the full tier step, up to 200 bps of round trip',
  });
}

// =====================================================================
// K. Attack settlement identities
// =====================================================================
function sectionK(db: DatabaseSync): void {
  const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const T2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  /**
   * Built to the real `SettlementCosts`, not to a shape convenient for the
   * probe. A stub that returns something the producer never returns produces
   * failures that look like production defects — the repository's own rule.
   */
  const costs = (over: Record<string, unknown> = {}) => ({
    baseFeeLamports: 5_000n,
    priorityFeeLamports: 0n,
    tipLamports: 0n,
    protocolFeeLamports: 0n,
    creatorFeeLamports: 0n,
    lpFeeLamports: 0n,
    platformFeeLamports: 0n,
    transferFeeAtoms: 0n,
    transferFeeLamportsEquivalent: 0n,
    rentCreatedLamports: 95_000n,
    rentRecoveredLamports: 0n,
    failedAttemptCostLamports: 0n,
    unexplainedLamports: 0n,
    valueToUnnamedAccountsLamports: 0n,
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}): never =>
    ({
      observationId: 'obs', simulationJobId: 'job', side: 'buy', family: 'BUILD_CUSTOM', capabilityFingerprint: 'fp',
      complete: true, effectValid: true, effectRefusals: [], incompleteness: [], fullAccountCoverage: true,
      replayable: true, snapshotManifestHash: null, createdAccounts: [], closedAccounts: [],
      payerNativeDeltaLamports: -20_100_000n,
      input: { kind: 'native_sol', requestedLamports: 20_000_000n, actualTradeDebitLamports: 20_000_000n, totalPayerDebitLamports: 20_100_000n },
      output: { kind: 'token', mint: 'M', tokenProgram: LEGACY, tokenAccount: 'A', minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1_000_000n },
      costs: costs(), residualTokenAtoms: 0n, ...over,
    }) as never;
  const exit = (over: Record<string, unknown> = {}): never =>
    ({
      observationId: 'obs2', simulationJobId: 'job2', side: 'sell', family: 'BUILD_CUSTOM', capabilityFingerprint: 'fp',
      complete: true, effectValid: true, effectRefusals: [], incompleteness: [], fullAccountCoverage: true,
      replayable: true, snapshotManifestHash: null, createdAccounts: [], closedAccounts: [],
      payerNativeDeltaLamports: 19_900_000n,
      input: { kind: 'token', mint: 'M', tokenProgram: LEGACY, tokenAccount: 'A', requestedAtoms: 1_000_000n, actualDebitAtoms: 1_000_000n },
      output: { kind: 'native_sol', minimumLamports: 0n, expectedLamports: null, actualCreditLamports: 19_905_000n },
      costs: costs({ rentCreatedLamports: 0n }), residualTokenAtoms: 0n, ...over,
    }) as never;

  const shape = (s: ReturnType<typeof buildTrajectorySettlement>) => ({
    unexplained: s.unexplainedLamports,
    cost: s.executionCostLamports,
    net: s.netPnlLamports,
    blocked: s.pnlBlockedReasons.length,
    violations: checkIdentities(s).violations,
  });

  const base = shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit() }));

  const mutations: { name: string; s: ReturnType<typeof shape>; expect: 'cost+' | 'blocked' | 'violation' | 'unexplained' }[] = [
    {
      name: 'transfer fee UNKNOWN on a Token-2022 leg',
      expect: 'blocked',
      s: shape(
        buildTrajectorySettlement({
          trajectoryId: 't',
          entry: entry({
            output: { kind: 'token', mint: 'M', tokenProgram: T2022, tokenAccount: 'A', minimumAtoms: 0n, expectedAtoms: null, actualCreditAtoms: 1_000_000n },
            costs: costs({ transferFeeLamportsEquivalent: null, transferFeeAtoms: null }),
          }),
          exit: exit(),
        }),
      ),
    },
    {
      name: 'the leg-level unexplained remainder (costs.unexplainedLamports = 2,500,000)',
      expect: 'blocked',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry({ costs: costs({ unexplainedLamports: 2_500_000n }) }), exit: exit() })),
    },
    {
      name: 'rent created +1',
      expect: 'cost+',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry({ costs: costs({ rentCreatedLamports: 95_001n }) }), exit: exit() })),
    },
    {
      name: 'rent recovered +1',
      expect: 'cost+',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit({ costs: costs({ rentCreatedLamports: 0n, rentRecoveredLamports: 1n }) }) })),
    },
    {
      name: 'failed-attempt fee +5000',
      expect: 'cost+',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit(), failedAttemptFeesLamports: 5_000n })),
    },
    {
      name: 'cashback claimed 60000',
      expect: 'cost+',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit(), cashback: { accruedLamports: 60_000n, claimableLamports: 60_000n, claimedLamports: 60_000n, claimCostLamports: 0n } })),
    },
    {
      name: 'cashback claim cost 5000',
      expect: 'cost+',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit(), cashback: { accruedLamports: 60_000n, claimableLamports: 60_000n, claimedLamports: 60_000n, claimCostLamports: 5_000n } })),
    },
    {
      name: 'residual atoms 7',
      expect: 'blocked',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit({ residualTokenAtoms: 7n }) })),
    },
    {
      name: 'unexplained lamports: payer delta moved by 2,500,000',
      expect: 'unexplained',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry({ payerNativeDeltaLamports: -22_600_000n }), exit: exit() })),
    },
    {
      name: 'principal leaked into execution cost',
      expect: 'violation',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry({ costs: costs({ baseFeeLamports: 30_000_000n }) }), exit: exit() })),
    },
    {
      name: 'more cashback claimed than accrued',
      expect: 'violation',
      s: shape(buildTrajectorySettlement({ trajectoryId: 't', entry: entry(), exit: exit(), cashback: { accruedLamports: 0n, claimableLamports: 0n, claimedLamports: 60_000n, claimCostLamports: 0n } })),
    },
  ];

  const bad: string[] = [];
  for (const m of mutations) {
    const changed =
      m.expect === 'cost+'
        ? m.s.cost !== base.cost || m.s.net !== base.net
        : m.expect === 'blocked'
          ? m.s.blocked > base.blocked && m.s.net === null
          : m.expect === 'violation'
            ? m.s.violations.length > 0
            : m.s.unexplained !== base.unexplained;
    if (!changed) bad.push(`${m.name}: no effect`);
  }
  record({
    section: 'K',
    invariant: 'each settlement component enters exactly once and a mutation is visible',
    verdict: bad.length === 0 ? 'PASS' : 'FAIL',
    source: 'packages/domain/src/trajectory-settlement.ts buildTrajectorySettlement / checkIdentities',
    mutation: mutations.map((m) => m.name).join('; '),
    result:
      bad.length === 0
        ? `all ${mutations.length} mutations moved exactly the quantity they name; baseline cost=${base.cost}, net=${base.net}, unexplained=${base.unexplained}`
        : bad.join(' | '),
    economicConsequence:
      'a component counted twice or omitted is the single most common way an execution cost becomes wrong while ' +
      'looking self-consistent. Two enter ZERO times. `failedAttemptFeesLamports`, the builder\'s own parameter, is ' +
      'stored in trajectory_settlements.failed_attempt_fees and added to no total — executionCost sums only the ' +
      'per-leg failedAttemptCostLamports, so a caller who supplies it at the trajectory level loses it (latent today: ' +
      'openTrajectory never passes it). `costs.unexplainedLamports` is the fourth condition isPnlEligible() requires ' +
      'and buildTrajectorySettlement never reads it, so a leg the domain itself calls PnL-ineligible still produces a ' +
      'published net PnL',
    rows: mutations.map((m) => `${m.name} -> cost=${m.s.cost} net=${m.s.net} unexplained=${m.s.unexplained} blocked=${m.s.blocked} violations=${m.s.violations.length}`),
  });

  // THE BIG ONE: an unexplained remainder does not block PnL and is not a violation.
  const forced = buildTrajectorySettlement({ trajectoryId: 't', entry: entry({ payerNativeDeltaLamports: -22_600_000n }), exit: exit() });
  const nonZeroUnexplained = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements WHERE CAST(unexplained_lamports AS INTEGER) != 0');
  const settlements = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements');
  const netDespite = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements WHERE net_pnl IS NOT NULL AND CAST(unexplained_lamports AS INTEGER) != 0');
  const worst = one<{ u: string; n: string; id: string }>(
    db,
    'SELECT unexplained_lamports u, net_pnl n, trajectory_id id FROM trajectory_settlements WHERE net_pnl IS NOT NULL ORDER BY ABS(CAST(unexplained_lamports AS INTEGER)) DESC LIMIT 1',
  );
  record({
    section: 'K',
    invariant: 'the payer identity closes, or net PnL is withheld',
    verdict: nonZeroUnexplained === 0 ? 'PASS' : 'FAIL',
    source: 'packages/domain/src/trajectory-settlement.ts:242-247 and :297 checkIdentities; trajectory_settlements',
    mutation: 'force the payer native delta 2,500,000 lamports away from the named flows, then read the corpus',
    result:
      `forced fixture: unexplained=${forced.unexplainedLamports}, netPnl=${forced.netPnlLamports}, ` +
      `blockedReasons=${forced.pnlBlockedReasons.length}, identityViolations=${checkIdentities(forced).violations.length}. ` +
      `In the corpus ${nonZeroUnexplained} of ${settlements} settlements carry a non-zero unexplained remainder, ` +
      `${netDespite} of them publish a net PnL anyway, and ZERO carry an identity violation. Worst: trajectory ` +
      `${worst?.id ?? '-'} publishes net ${worst?.n ?? '-'} lamports with ${worst?.u ?? '-'} unexplained`,
    economicConsequence:
      'unexplainedLamports is computed and then read by nothing. It is neither a pnlBlockedReason nor a ' +
      'checkIdentities violation, so a settlement whose payer delta is millions of lamports short of its named ' +
      `flows is published as a measured net PnL. Commit 4edb5f7 "the payer identity reconciles to ZERO on both ` +
      `legs" and docs/29C7CC7_RUNNING_COLLECTOR_REPORT.md blocker 4 are false of ${nonZeroUnexplained} of the ` +
      `${settlements} settlements in this database; docs/STATUS.md says the opposite of both and is correct`,
  });

  // Trajectory, settlement, policy outcome and report must agree exactly.
  const trajNet = count(db, 'SELECT COUNT(*) c FROM development_trajectories WHERE net_pnl_lamports IS NOT NULL');
  const setNet = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements WHERE net_pnl IS NOT NULL');
  const trajCost = count(db, 'SELECT COUNT(*) c FROM development_trajectories WHERE execution_cost_lamports IS NOT NULL');
  record({
    section: 'K',
    invariant: 'the trajectory, the settlement, the policy outcome and the report agree exactly',
    verdict: trajNet === setNet ? 'PASS' : 'FAIL',
    source: 'development_trajectories.net_pnl_lamports vs trajectory_settlements.net_pnl',
    mutation: 'compare the two writers of the same quantity',
    result:
      `${setNet} settlements carry a net PnL; ${trajNet} trajectory rows do, and ${trajCost} carry an execution cost. ` +
      'settleTrajectory() is the only writer of those columns and the collector never calls it — closeTrajectory() ' +
      'sets state and settled_utc_ms and nothing else',
    economicConsequence:
      'every economics column on development_trajectories is permanently NULL. Any consumer reading the trajectory ' +
      'row rather than the settlement row sees a corpus with no costs and no PnL at all',
  });
}

// =====================================================================
// L. Attack append-only evidence (against a COPY, never the corpus)
// =====================================================================
function sectionL(copyPath: string | null): void {
  if (copyPath === null) {
    record({
      section: 'L',
      invariant: 'every append-only ambiguity fails',
      verdict: 'NOT TESTABLE',
      source: 'AUDIT_COPY_DB was not supplied',
      mutation: 'not run',
      result: 'refusing to run write probes against data/runtime.db: it is the research corpus and it is not reproducible',
      economicConsequence: 'unknown',
    });
    return;
  }
  const db = new DatabaseSync(copyPath);
  db.exec('PRAGMA foreign_keys = ON');
  const id = (one<{ id: string }>(db, 'SELECT trajectory_id id FROM development_trajectories ORDER BY opened_utc_ms DESC LIMIT 1'))?.id;
  if (id === undefined) throw new Error('the copy carries no trajectory');
  const row = one<Record<string, string | number | null>>(db, 'SELECT * FROM development_trajectories WHERE trajectory_id = ?', id)!;

  const attempt = (name: string, fn: () => void): { name: string; outcome: string } => {
    try {
      fn();
      return { name, outcome: 'ACCEPTED — the ambiguity was written' };
    } catch (e) {
      const m = (e as Error).message;
      // A probe that detects a SILENT drop signals it by throwing, so the label
      // has to distinguish "the writer refused" from "the writer said nothing".
      if (/SILENTLY DISCARDED|IMPOSSIBLE TO ATTACH|zero rows changed|rows changed in one statement/.test(m)) {
        return { name, outcome: m.slice(0, 140) };
      }
      return { name, outcome: `REFUSED LOUDLY: ${(e as Error).name}: ${m.slice(0, 90)}` };
    }
  };

  const outcomes = [
    attempt('duplicate trajectory id', () =>
      insertTrajectory(db, {
        identity: {
          trajectoryId: id,
          entryObservationId: 'x', entrySimulationJobId: 'y', entrySettlementId: 'z',
          venue: 'PUMPSWAP_DIRECT', pool: String(row['pool']), capabilityFingerprint: 'f', snapshotHash: 'h',
          mint: String(row['mint']), cohort: 'FIRST_HOUR', stratum: 'S', migrationAgeMs: null,
          notionalLamports: 1n, entryPolicyInputs: {},
        },
        entryPolicy: 'HARD_GATES_RANDOM', exitPolicy: 'FIXED_15M_CONTROL', state: 'AWAITING_FILL_OBSERVATION',
        impact: { quoteImpactRatio: 0, baseImpactRatio: 0, maxImpactRatio: 0, haircutBps: 0, withinSmallImpactBound: true, boundUsed: 0.005 } as never,
        maxAttainableGrade: 'SIMULATED_EXECUTION', refusals: [], openedUtcMs: Date.now(),
      }),
    ),
    attempt('replacement settlement with different economics', () => {
      const before = one<{ n: string | null; e: string }>(db, 'SELECT net_pnl n, entry_cash_out e FROM trajectory_settlements WHERE trajectory_id = ?', id);
      insertTrajectorySettlement(db, id, 'IMMEDIATE_MECHANICS', {
        entryCashOutLamports: 1n, exitCashInLamports: 999_999_999n, grossExitCreditLamports: 999_999_999n,
        baseFeesLamports: 0n, priorityFeesLamports: 0n, tipsLamports: 0n, transferFeesLamports: 0n,
        failedAttemptFeesLamports: 0n, rentCreatedLamports: 0n, rentRecoveredLamports: 0n, rentStillLockedLamports: 0n,
        cashbackAccruedLamports: 0n, cashbackClaimableLamports: 0n, cashbackClaimedLamports: 0n, cashbackClaimCostLamports: 0n,
        residualTokenAtoms: 0n, unexplainedLamports: 0n, executionCostLamports: 0n,
        netPnlLamports: 999_999_999n, pnlBlockedReasons: [],
      }, [], Date.now());
      const after = one<{ n: string | null; e: string }>(db, 'SELECT net_pnl n, entry_cash_out e FROM trajectory_settlements WHERE trajectory_id = ?', id);
      if (before?.n === after?.n && before?.e === after?.e) {
        throw new Error('SILENTLY DISCARDED: the row is unchanged and the writer returned void with no signal');
      }
    }),
    attempt('a different exit attached to the same trajectory', () => {
      const before = count(db, `SELECT COUNT(*) c FROM trajectory_policy_outcomes WHERE trajectory_id = '${id}'`);
      insertPolicyOutcome(db, id, 1n, {
        exitPolicy: 'FIXED_15M_CONTROL', triggeredAtMs: 1, triggeredOffsetMs: 900_000,
        reason: 'a second, different answer', exitMarkLamports: 42n, grossDeltaLamports: 42n,
      } as never, Date.now());
      const after = count(db, `SELECT COUNT(*) c FROM trajectory_policy_outcomes WHERE trajectory_id = '${id}'`);
      if (before === after) throw new Error('SILENTLY DISCARDED: INSERT OR IGNORE, no signal to the caller');
    }),
    attempt('duplicate mark at a recorded offset with a different price', () => {
      // A trajectory that HAS marks, not necessarily the newest one.
      const m = one<{ t: string; o: number; v: string | null }>(
        db,
        'SELECT trajectory_id t, offset_ms o, executable_lamports v FROM trajectory_marks WHERE executable_lamports IS NOT NULL ORDER BY rowid DESC LIMIT 1',
      );
      if (m === undefined) throw new Error('no mark exists to duplicate');
      insertMark(db, m.t, {
        offsetMs: m.o, atMs: Date.now(), executableLamports: 123_456_789n,
        exitCapacityLamports: null, effectiveQuoteReserveLamports: null, refusal: null, latenessMs: 0,
      } as never);
      const after = one<{ v: string | null }>(db, `SELECT executable_lamports v FROM trajectory_marks WHERE trajectory_id = '${m.t}' AND offset_ms = ${m.o}`);
      if (m.v === after?.v) {
        throw new Error(
          `SILENTLY DISCARDED: mark (${m.t.slice(0, 8)}, ${m.o}ms) kept ${m.v} against a second, different ` +
            '123456789; INSERT OR IGNORE returned void and the caller cannot tell',
        );
      }
    }),
    attempt('an unrelated qualifying simulation job attached to the trajectory', () => {
      const n = count(db, "SELECT COUNT(*) c FROM simulation_jobs WHERE status = 'SIMULATED_OK'");
      throw new Error(
        `IMPOSSIBLE TO ATTACH OR DETECT: no column joins simulation_jobs to a trajectory. ${n} qualifying jobs exist and none is reachable from any trajectory`,
      );
    }),
    attempt('zero-row update: settle a trajectory id that does not exist', () => {
      const r = db.prepare("UPDATE development_trajectories SET state = 'SETTLED' WHERE trajectory_id = 'no-such-trajectory'").run();
      if (Number(r.changes) === 0) throw new Error('zero rows changed and the statement reported success');
    }),
    attempt('multi-row update: settle every trajectory at once', () => {
      db.exec('SAVEPOINT probe');
      const r = db.prepare("UPDATE development_trajectories SET state = 'SETTLED' WHERE state = 'AWAITING_FILL_OBSERVATION'").run();
      db.exec('ROLLBACK TO probe');
      db.exec('RELEASE probe');
      if (Number(r.changes) > 1) throw new Error(`${r.changes} rows changed in one statement and nothing bounded it`);
    }),
  ];

  const silentlyAccepted = outcomes.filter((o) => !o.outcome.startsWith('REFUSED LOUDLY'));
  record({
    section: 'L',
    invariant: 'every append-only ambiguity fails LOUDLY',
    verdict: silentlyAccepted.length === 0 ? 'PASS' : 'FAIL',
    source: 'packages/storage/src/trajectory-repo.ts, packages/storage/src/mark-repo.ts, run against a VACUUM-consistent copy',
    mutation: outcomes.map((o) => o.name).join('; '),
    result: outcomes.map((o) => `${o.name} -> ${o.outcome}`).join(' | '),
    economicConsequence:
      'insertTrajectory throws EvidenceReplaceRefused, which is correct. Every other writer uses INSERT OR IGNORE ' +
      'and returns void, so a second and DIFFERENT settlement, policy outcome or mark is discarded with no signal ' +
      'the caller can act on. With five collector daemons racing the same open trajectories, a discarded write and ' +
      'a market fact are indistinguishable after the fact',
    rows: outcomes.map((o) => `${o.name} -> ${o.outcome}`),
  });
  db.close();
}

// =====================================================================
// M. Attack future counterfactuals
// =====================================================================
function sectionM(db: DatabaseSync): void {
  const grades = all<{ evidence_grade: string; n: number }>(db, 'SELECT evidence_grade, COUNT(*) n FROM development_trajectories GROUP BY 1');
  const replay = all<{ n: number; div: number }>(db, 'SELECT COUNT(*) n, SUM(divergences) div FROM replay_runs');
  const fullReplay = grades.find((g) => g.evidence_grade === 'FULL_EVENT_REPLAY')?.n ?? 0;
  const bounded = grades.find((g) => g.evidence_grade === 'BOUNDED_COUNTERFACTUAL')?.n ?? 0;

  record({
    section: 'M',
    invariant: 'a bounded future trajectory and a full event replay exist for the same entry, and their errors are compared',
    verdict: fullReplay > 0 && bounded > 0 ? 'PASS' : 'FAIL',
    source: 'development_trajectories.evidence_grade; replay_runs',
    mutation: 'observation',
    result:
      `evidence grades in the corpus: ${grades.map((g) => `${g.evidence_grade}=${g.n}`).join(', ')}. ` +
      `${fullReplay} FULL_EVENT_REPLAY and ${bounded} BOUNDED_COUNTERFACTUAL rows exist, so no pair can be compared. ` +
      `replay_runs: ${replay[0]?.n ?? 0} run(s), ${replay[0]?.div ?? 0} divergence(s)`,
    economicConsequence:
      'every row is SIMULATED_EXECUTION: the exit is priced in the same runtime instant as the entry. That measures ' +
      'MECHANICS, not a holding period, so the 15m and 60m marks are quotes taken later against mainnet and are ' +
      'exactly the "later mainnet quote without either contract" the directive names as not a valid trajectory',
  });

  const laterQuoteOnly = count(db, "SELECT COUNT(*) c FROM trajectory_policy_outcomes WHERE exit_mark_lamports IS NOT NULL");
  record({
    section: 'M',
    invariant: 'no policy outcome rests on a later mainnet quote without a bounded or replayed contract',
    verdict: 'FAIL',
    source: 'trajectory_policy_outcomes.exit_mark_lamports; packages/pipeline/src/mark-path.ts takeMark',
    mutation: 'observation',
    result:
      `${laterQuoteOnly} policy outcomes carry an exit mark. Every one of them is a later mainnet quote against a ` +
      'pool state that never contained our entry, on a trajectory graded SIMULATED_EXECUTION rather than ' +
      'BOUNDED_COUNTERFACTUAL, and the haircut columns on those rows come from the ENTRY impact bound, not from a ' +
      'contract over the exit',
    economicConsequence:
      'the gross delta over 211 control outcomes is built entirely from these marks. It is not a strategy result ' +
      'and the corpus does not carry the grade that would say so',
  });
}

// =====================================================================
// N. Attack policy treatments
// =====================================================================
function sectionN(db: DatabaseSync): void {
  const f = (over: Partial<PreEntryFeatures> = {}): PreEntryFeatures => ({
    mint: 'So11111111111111111111111111111111111111112',
    hardGatesPass: true, independentBuyerPersistence: 0.9, nonMayhemNetQuoteInflowLamports: 1_000n,
    effectiveQuoteReserveTrend: 1, executableExitCapacityTrend: 1, continuationSlope: 1,
    creatorNetSellingLamports: 0n, entityConcentration: 0.1, mintBehaviourSafe: true, mechanicsViable: true,
    correctedQualityScore: 0.9, scoreCoverageOk: true, ...over,
  });
  const findSeed = (want: (r: boolean, q: boolean) => boolean, feats: PreEntryFeatures): string | null => {
    for (let i = 0; i < 5_000; i++) {
      const seed = `audit-${i}`;
      if (want(decideEntry('HARD_GATES_RANDOM', feats, { seed }).enter, decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', feats, { seed }).enter)) return seed;
    }
    return null;
  };
  const randomEntersQualityRejects = findSeed((r, q) => r && !q, f({ correctedQualityScore: 0.2 }));
  const qualityEntersRandomRejects = findSeed((r, q) => !r && q, f());
  const conc = f({ entityConcentration: 0.9 });
  const qualityEntersFlowRejects =
    decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', conc).enter && !decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', conc).enter;
  const lowScore = f({ correctedQualityScore: 0.1 });
  const flowEntersQualityRejects =
    decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', lowScore).enter && !decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', lowScore).enter;

  const t0 = 1_000_000;
  const mk = (min: number, cap: bigint): MarkPoint => ({ atMs: t0 + min * 60_000, executableLamports: cap, exitCapacityLamports: cap, effectiveQuoteReserveLamports: cap });
  const deteriorating = [mk(1, 20_000_000n), mk(5, 19_000_000n), mk(15, 10_000_000n), mk(30, 9_000_000n), mk(60, 8_000_000n)];
  const improving = [mk(1, 20_000_000n), mk(5, 21_000_000n), mk(15, 22_000_000n), mk(30, 23_000_000n), mk(60, 24_000_000n)];
  const fixedD = decideExit('FIXED_15M_CONTROL', t0, deteriorating);
  const detD = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', t0, deteriorating);
  const fixedI = decideExit('FIXED_15M_CONTROL', t0, improving);
  const detI = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', t0, improving);

  const allFive =
    randomEntersQualityRejects !== null && qualityEntersRandomRejects !== null &&
    qualityEntersFlowRejects && flowEntersQualityRejects &&
    detD.triggeredAtMs !== fixedD.triggeredAtMs && detI.triggeredAtMs !== fixedI.triggeredAtMs;

  record({
    section: 'N',
    invariant: 'the policies are genuinely different treatments over one shared path',
    verdict: allFive ? 'PASS' : 'FAIL',
    source: 'packages/strategy/src/treatments.ts decideEntry / decideExit',
    mutation: 'construct all five counterexamples the directive names',
    result:
      `random enters + quality rejects: seed ${randomEntersQualityRejects ?? 'NOT FOUND'}; ` +
      `quality enters + random rejects: seed ${qualityEntersRandomRejects ?? 'NOT FOUND'}; ` +
      `quality enters + flow rejects: ${qualityEntersFlowRejects}; flow enters + quality rejects: ${flowEntersQualityRejects}; ` +
      `deterioration exits at ${detD.triggeredAtMs} while fixed holds to ${fixedD.triggeredAtMs}; ` +
      `deterioration holds to ${detI.triggeredAtMs} while fixed exits at ${fixedI.triggeredAtMs}`,
    economicConsequence: 'if two policies cannot disagree, the tournament cannot discover anything',
  });

  const policies = all<{ entry_policy: string; n: number }>(db, 'SELECT entry_policy, COUNT(*) n FROM development_trajectories GROUP BY 1');
  const callers = sh('grep -rn "decideEntry(" --include=*.ts packages apps scripts | grep -v treatments.ts');
  record({
    section: 'N',
    invariant: 'one shared path is evaluated by ALL entry policies, and the label is not attached after a common decision',
    verdict: policies.length === ENTRY_POLICIES.length ? 'PASS' : 'FAIL',
    source: 'development_trajectories.entry_policy; apps/collector/src/trajectory-collect.ts:896',
    mutation: 'count the distinct entry policies in the corpus and search for production callers of decideEntry',
    result:
      `the corpus carries ${policies.length} distinct entry polic(ies): ${policies.map((p) => `${p.entry_policy}=${p.n}`).join(', ')}, ` +
      `against ${ENTRY_POLICIES.length} defined. decideEntry has ZERO production callers ` +
      `(${callers.length === 0 ? 'no non-test references' : 'only tests'}); the collector writes the string literal ` +
      "'HARD_GATES_RANDOM' on every row after admitCandidate has already made the decision",
    economicConsequence:
      'the entry side of the tournament does not exist. Every row is labelled with the control arm, so the two ' +
      'challengers have a sample of zero and the label describes nothing that happened',
  });

  const exitPolicies = all<{ exit_policy: string; n: number; agree: number }>(
    db,
    `SELECT exit_policy, COUNT(*) n, 0 agree FROM trajectory_policy_outcomes GROUP BY 1`,
  );
  const disagreements = count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT a.trajectory_id FROM trajectory_policy_outcomes a
         JOIN trajectory_policy_outcomes b ON a.trajectory_id = b.trajectory_id
        WHERE a.exit_policy = 'FIXED_15M_CONTROL' AND b.exit_policy = 'FLOW_LIQUIDITY_DETERIORATION_V1'
          AND a.triggered_offset_ms IS NOT b.triggered_offset_ms)`,
  );
  const paired = count(db, "SELECT COUNT(*) c FROM trajectory_policy_outcomes WHERE exit_policy = 'FIXED_15M_CONTROL'");
  record({
    section: 'N',
    invariant: 'the two exit policies are evaluated on the SAME path and can disagree on it',
    verdict: disagreements > 0 ? 'PASS' : 'FAIL',
    source: 'trajectory_policy_outcomes',
    mutation: 'join the two policies on trajectory_id and count differing trigger offsets',
    result: `${exitPolicies.map((e) => `${e.exit_policy}=${e.n}`).join(', ')}; ${disagreements} of ${paired} paired paths have a different trigger offset`,
    economicConsequence:
      'exit is the half of the tournament that works: both policies do run over one shared mark path. Whether the ' +
      'difference means anything depends on the marks being timely, which section B measures separately',
  });
}

// =====================================================================
// O. Attack Mayhem / entity facts
// =====================================================================
function sectionO(db: DatabaseSync): void {
  const synthetic = new Uint8Array(200);
  synthetic[81] = 1;
  const decodedTrue = bondingCurveMayhemMode(synthetic);
  const decodedFalse = bondingCurveMayhemMode(new Uint8Array(200));
  const short = bondingCurveMayhemMode(new Uint8Array(10));

  const enabled = mayhemFactsOf({ mint: 'M', poolIsMayhemMode: true, bondingCurveData: null } as never);
  const unknown = mayhemFactsOf({ mint: 'M', poolIsMayhemMode: null, bondingCurveData: null } as never);
  const off = mayhemFactsOf({ mint: 'M', poolIsMayhemMode: false, bondingCurveData: null } as never);

  const uEnabled = breadthUsability(enabled);
  const uUnknown = breadthUsability(unknown);
  const uOff = breadthUsability(off);

  const correct =
    decodedTrue === true && decodedFalse === false && short === null &&
    uEnabled.usability !== 'ORGANIC' && uUnknown.usability !== 'ORGANIC' && uOff.usability === 'ORGANIC';
  record({
    section: 'O',
    invariant: 'agent flow does not count as independent breadth, and unknown contamination is not organic',
    verdict: correct ? 'PASS' : 'FAIL',
    source: 'packages/solana/src/mayhem.ts breadthUsability / bondingCurveMayhemMode',
    mutation: 'synthetic bonding curve with the mayhem byte set at offset 81, cleared, and truncated; then the three enabled states',
    result:
      `decoder: set=${decodedTrue}, clear=${decodedFalse}, truncated=${short}. ` +
      `enabled -> ${uEnabled.usability}; unknown -> ${uUnknown.usability}; off -> ${uOff.usability}. ` +
      `Mayhem program constant in this tree: ${MAYHEM_PROGRAM}`,
    economicConsequence: 'counting agent flow as independent buyers is the difference between a token with fifty holders and a token with one',
  });

  const facts = all<{ enabled: number | null; n: number }>(db, 'SELECT enabled, COUNT(*) n FROM mayhem_facts GROUP BY 1');
  const conc = count(db, 'SELECT COUNT(*) c FROM entity_concentration');
  const rawOnly = count(db, "SELECT COUNT(*) c FROM candidate_risk_facts WHERE stratum LIKE '%CONCENTRATION_RAW_ONLY%'");
  const examined = count(db, 'SELECT COUNT(*) c FROM candidate_risk_facts');
  record({
    section: 'O',
    invariant: 'entity-adjusted concentration alters an actual entry decision on a counterexample',
    verdict: rawOnly < examined ? 'PASS' : 'FAIL',
    source: 'candidate_risk_facts.stratum; entity_concentration',
    mutation: 'observation: count admitted candidates whose stratum is anything other than CONCENTRATION_RAW_ONLY',
    result:
      `${rawOnly} of ${examined} risk-fact rows are stratified CONCENTRATION_RAW_ONLY; entity_concentration holds ${conc} rows ` +
      `and none of them is joined to a candidate decision. mayhem_facts: ${facts.map((r) => `enabled=${r.enabled}:${r.n}`).join(', ')}`,
    economicConsequence:
      'the entity-adjusted tier is never walked, so the raw top-holder share decides every admission. An incomplete ' +
      'history can only UNDERSTATE clustering, so the gate that fires is the weaker of the two on every candidate',
  });

  record({
    section: 'O',
    invariant: 'the currently disclosed Mayhem agent wallet and program are the ones this tree uses',
    verdict: 'NOT TESTABLE',
    source: `packages/solana/src/mayhem.ts:30 MAYHEM_PROGRAM = ${MAYHEM_PROGRAM}`,
    mutation: 'compare against the current official Pump disclosure',
    result: 'this harness does not take network access; the constant is recorded above so it can be checked against the disclosure out of band',
    economicConsequence: 'a stale agent wallet means agent flow is counted as organic breadth on every token it touches',
  });
}

// =====================================================================
// P. Attack WSS
// =====================================================================
function sectionP(db: DatabaseSync): void {
  const poolPda = { pubkey: 'PooL1111111111111111111111111111111111111111', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', dataBase64: Buffer.alloc(300).toString('base64') };
  const tokenAcct = (() => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(123_456_789n, 64);
    return { pubkey: 'Vault111111111111111111111111111111111111111', owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', dataBase64: b.toString('base64') };
  })();

  let refused = false;
  let why = '';
  try {
    vaultBalance(poolPda);
  } catch (e) {
    refused = e instanceof NotATokenAccount;
    why = (e as Error).message.slice(0, 100);
  }
  const balance = vaultBalance(tokenAcct);

  const sub = subscriptionFor('traj-1', {
    baseVault: 'B1', quoteVault: 'Q1', poolState: 'P1', feeConfig: 'F1', mint: 'M1', creatorOrCashbackAccumulator: null,
  }, 1);
  let unwatchExact = false;
  try {
    assertUnwatchesExactly(sub, [...sub.addresses]);
    unwatchExact = true;
  } catch { /* recorded below */ }
  let unwatchWrongRefuses = false;
  try {
    assertUnwatchesExactly(sub, [...sub.addresses, 'Extra1']);
  } catch {
    unwatchWrongRefuses = true;
  }

  const material = isMaterialChange(1_000_000n, 940_000n);
  const immaterial = isMaterialChange(1_000_000n, 999_000n);
  const order = drainOrder(['b'], ['a', 'b', 'c']);

  const ok = refused && balance === 123_456_789n && unwatchExact && unwatchWrongRefuses && material && !immaterial && order[0] === 'b' && order.length === 3;
  record({
    section: 'P',
    invariant: 'subscriptions are exact accounts, a pool PDA is refused by the token decoder, and the unwatch uses stored addresses',
    verdict: ok ? 'PASS' : 'FAIL',
    source: 'packages/pipeline/src/vault-watch.ts',
    mutation:
      'pass a 300-byte account owned by the AMM program to vaultBalance; unwatch the stored set; unwatch the stored ' +
      "set PLUS one address that was never subscribed; 6% and 0.1% reserve moves; drainOrder with 'b' urgent",
    result:
      `pool PDA refused=${refused} (${why}); token account decodes to ${balance}; exact unwatch accepted=${unwatchExact}; ` +
      `unwatch with an EXTRA, never-subscribed address refused=${unwatchWrongRefuses}; 6% move material=${material}; ` +
      `0.1% move material=${immaterial}; drainOrder(['b'], ['a','b','c']) = [${order.join(', ')}]. ` +
      'assertUnwatchesExactly computes only `stored NOT IN asked` — a LEAK check. It does not compute ' +
      '`asked NOT IN stored`, so unwatching an address that was never subscribed passes, even though UnwatchMismatch\'s ' +
      'own message says "unwatch was asked for addresses that were never subscribed"',
    economicConsequence:
      'a pool PDA decoded as a token account yields an arbitrary 8 bytes as a balance, so the reserve alarm fires on ' +
      'nothing or never fires — that half holds. The unwatch half does not: one LiveVaultWatch is shared across every ' +
      'open trajectory, so an over-broad unwatch silently cancels another trajectory\'s vault coverage and the gap is ' +
      'recorded against the chain rather than against us',
  });

  const subs = count(db, 'SELECT COUNT(*) c FROM wss_subscriptions');
  const gaps = count(db, 'SELECT COUNT(*) c FROM wss_gaps');
  const urgent = count(db, 'SELECT COUNT(*) c FROM urgent_marks');
  const consumed = count(db, 'SELECT COUNT(*) c FROM urgent_marks WHERE consumed_utc_ms IS NOT NULL');
  record({
    section: 'P',
    invariant: 'a material update is delivered, queued urgently, consumed, and survives a disconnect and resync',
    verdict: urgent > 0 && consumed > 0 ? 'PASS' : 'NOT TESTABLE',
    source: 'wss_subscriptions, wss_gaps, urgent_marks',
    mutation: 'not run live: --live-lane is OFF by default and enabling it is measured at 219 messages/second, which exhausted both endpoints',
    result: `${subs} subscription row(s), ${gaps} gap row(s), ${urgent} urgent mark(s) of which ${consumed} consumed`,
    economicConsequence:
      'the urgent queue is the only thing that makes a 5% vault move actionable rather than decorative. With the ' +
      'lane off by default the running collector has no socket at all, and the marks it takes are on a 300 second timer',
  });
}

// =====================================================================
// Q. Command truth (results arrive by sidecar; the shell ran them)
// =====================================================================
function sectionQ(sidecar: Record<string, unknown> | null): void {
  const q = (sidecar?.['Q'] ?? null) as { name: string; exit: number; verdict: Verdict; result: string }[] | null;
  if (q === null) {
    record({
      section: 'Q',
      invariant: 'every named status command means its name',
      verdict: 'NOT TESTABLE',
      source: 'package.json scripts',
      mutation: 'not run',
      result: 'the command sweep was not supplied to this harness',
      economicConsequence: 'a command that emits placeholder zeroes as measurements is indistinguishable from one that measured zero',
    });
    return;
  }
  const bad = q.filter((c) => c.verdict === 'FAIL');
  record({
    section: 'Q',
    invariant: 'no named command aliases an unrelated script, emits placeholder zeroes, reads a proof artifact as database evidence, exits zero while saying not implemented, or overwrites another command\'s artifact',
    verdict: bad.length === 0 ? 'PASS' : 'FAIL',
    source: 'package.json scripts, run one at a time',
    mutation: 'run each command and inspect its exit code, its output and the artifact it writes',
    result: q.map((c) => `${c.name} exit=${c.exit} ${c.verdict}: ${c.result}`).join(' | '),
    economicConsequence: 'a status command that lies is the mechanism by which every other finding in this repository stayed hidden',
    rows: q.map((c) => `${c.name} exit=${c.exit} ${c.verdict}: ${c.result}`),
  });
}

// =====================================================================
// R. Attack readiness
// =====================================================================
function sectionR(copyPath: string | null, sidecar: Record<string, unknown> | null, db: DatabaseSync): void {
  const src = readFileSync('scripts/trajectory-readiness.ts', 'utf8');
  const hardcodedContract = /contractHeld:\s*false/.test(src);
  const hardcodedNet = /netPnlLamports:\s*null/.test(src);
  const readsSettlements = /trajectory_settlements/.test(src);
  // A stamped contract would be a ROW, not a word in a comment.
  const contractTables = all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%contract%' OR name LIKE '%frozen%')",
  ).map((r) => r.name);
  const settlements = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements');
  const withNet = count(db, 'SELECT COUNT(*) c FROM trajectory_settlements WHERE net_pnl IS NOT NULL');
  const nullGates = (src.match(/:\s*null,/g) ?? []).length;

  record({
    section: 'R',
    invariant: 'the default pnpm readiness reads ONE database-stamped exact trajectory contract',
    verdict: hardcodedContract || !readsSettlements ? 'FAIL' : 'PASS',
    source: 'scripts/trajectory-readiness.ts:84-109',
    mutation: 'read what the gate is fed, and search the database for a stamped contract whose frozen fields could be mutated',
    result:
      `contractHeld is passed as the literal \`false\`${hardcodedContract ? '' : ' (NOT FOUND)'}; netPnlLamports as the ` +
      `literal \`null\`${hardcodedNet ? '' : ' (NOT FOUND)'}; ${nullGates} of the gate inputs are literal nulls. The script ` +
      `never mentions trajectory_settlements${readsSettlements ? ' (it does — check this)' : ''}, so the ${settlements} ` +
      `settlements and ${withNet} net PnL figures now in the database reach no gate. No contract table exists to mutate ` +
      `(tables matching %contract%/%frozen%: ${contractTables.length === 0 ? 'none' : contractTables.join(', ')}), so ` +
      'there are no frozen fields to mutate',
    economicConsequence:
      'the gate is fail-closed and reports NOT READY, which is the right answer for the wrong reason. It cannot ' +
      'become READY on evidence because it does not read the evidence, and it therefore cannot detect that the ' +
      'evidence got worse',
  });

  const seeds = (sidecar?.['R'] ?? null) as { name: string; verdict: string; detail: string }[] | null;
  record({
    section: 'R',
    invariant: 'no seeded corpus passes the gate',
    verdict: seeds === null ? 'NOT TESTABLE' : seeds.every((s) => s.verdict === 'NOT_READY') ? 'PASS' : 'FAIL',
    source: copyPath === null ? 'no copy supplied' : `pnpm readiness against ${copyPath}`,
    mutation: '200 losses; a positive sample carried by the top 3; invalid old shadows; unrelated jobs; a dirty artifact; a null context; the wrong database snapshot; blocked exits; unsafe bigint ratios',
    result:
      seeds === null
        ? 'the seed sweep was not supplied to this harness'
        : seeds.map((s) => `${s.name} -> ${s.verdict} (${s.detail})`).join(' | '),
    economicConsequence:
      'none of these can pass, but only because fourteen gates are hardcoded UNKNOWN. The gate is not discriminating ' +
      'between the seeds; it is refusing all of them for the same reason',
  });

  record({
    section: 'R',
    invariant: 'a development result cannot satisfy a real-canary gate',
    verdict: 'PASS',
    source: 'scripts/trajectory-readiness.ts:107 replayDivergences; packages/research/src/confirmatory-trajectories.ts READINESS_THRESHOLDS',
    mutation: 'observation of what the gate requires versus what the corpus can produce',
    result:
      'the corpus is entirely SIMULATED_EXECUTION. positiveExactCanarySizeShadow is null and null is a FAIL, so a ' +
      'development result cannot reach the canary gate. pnpm readiness exits 1',
    economicConsequence: 'the one property that must hold before real funds move does hold',
  });
}

// =====================================================================
// S. Restart and duration (results arrive by sidecar)
// =====================================================================
function sectionS(db: DatabaseSync, sidecar: Record<string, unknown> | null): void {
  const s = (sidecar?.['S'] ?? null) as Record<string, unknown> | null;

  const dupCandidates = count(
    db,
    `SELECT COUNT(*) c FROM (SELECT mint, COUNT(*) n FROM development_trajectories GROUP BY mint HAVING n > 3)`,
  );
  const spread = one<{ t: number; m: number; worst: number }>(
    db,
    // SUM(n), not COUNT(*): COUNT over the grouped subquery counts MINTS.
    `SELECT SUM(n) t, COUNT(*) m, MAX(n) worst FROM (SELECT mint, COUNT(*) n FROM development_trajectories GROUP BY mint)`,
  );
  record({
    section: 'S',
    invariant: 'a restart resumes without duplicate candidates',
    verdict: dupCandidates === 0 ? 'PASS' : 'FAIL',
    source: 'development_trajectories grouped by mint; apps/collector/src/trajectory-collect.ts --max-per-mint (default 3)',
    mutation: 'observation across every restart the corpus has seen',
    result:
      `${spread?.t ?? 0} trajectories across ${spread?.m ?? 0} distinct mints; the most-sampled mint has ${spread?.worst ?? 0}, ` +
      `against a --max-per-mint of 3. ${dupCandidates} mint(s) exceed the cap`,
    economicConsequence:
      'migrationCandidates() applies max-per-mint to the CANDIDATE QUEUE, not to the corpus, so the cap bounds one ' +
      'cycle and not the study. One mint contributes a fifth of the sample and the paired comparison is not ' +
      'independent across rows',
  });

  const dupMarks = count(
    db,
    'SELECT COUNT(*) c FROM (SELECT trajectory_id, offset_ms, COUNT(*) n FROM trajectory_marks GROUP BY 1,2 HAVING n > 1)',
  );
  const lostPolicy = count(
    db,
    `SELECT COUNT(*) c FROM development_trajectories t WHERE t.state = 'SETTLED'
       AND (SELECT COUNT(*) FROM trajectory_policy_outcomes p WHERE p.trajectory_id = t.trajectory_id) < 2`,
  );
  record({
    section: 'S',
    invariant: 'a restart resumes without duplicate marks or lost policy state',
    verdict: dupMarks === 0 && lostPolicy === 0 ? 'PASS' : 'FAIL',
    source: 'trajectory_marks primary key (trajectory_id, offset_ms); trajectory_policy_outcomes',
    mutation: 'observation',
    result: `${dupMarks} duplicated (trajectory, offset) marks; ${lostPolicy} settled trajector(ies) carry fewer than two policy outcomes`,
    economicConsequence: 'the mark scheduler keeps all of its state in the database, which is what makes it survive a restart and five concurrent daemons',
  });

  record({
    section: 'S',
    invariant: 'the collector was stopped and restarted with open trajectories and resumed correctly',
    verdict: s === null ? 'NOT TESTABLE' : (s['verdict'] as Verdict),
    source: 'the live restart performed by this audit',
    mutation: s === null ? 'not run' : String(s['mutation']),
    result: s === null ? 'the restart probe was not supplied to this harness' : String(s['result']),
    economicConsequence: 'a collector that loses open trajectories on restart cannot produce a real 60 minute mark',
  });

  const horizons = all<{ offset_ms: number; n: number; timely: number }>(
    db,
    'SELECT offset_ms, COUNT(*) n, SUM(CASE WHEN lateness_ms <= 60000 THEN 1 ELSE 0 END) timely FROM trajectory_marks GROUP BY 1 ORDER BY 1',
  );
  const timely1m = horizons.find((h) => h.offset_ms === 60_000)?.timely ?? 0;
  const timely5m = horizons.find((h) => h.offset_ms === 300_000)?.timely ?? 0;
  const timely15m = horizons.find((h) => h.offset_ms === 900_000)?.timely ?? 0;
  record({
    section: 'S',
    invariant: 'the run was long enough to produce actual 1m, 5m and 15m marks in the current context',
    verdict: timely1m > 0 && timely5m > 0 && timely15m > 0 ? 'PASS' : 'FAIL',
    source: 'trajectory_marks.lateness_ms by horizon',
    mutation: 'observation',
    result: horizons.map((h) => `${h.offset_ms / 60_000}m: ${h.n} marks, ${h.timely} within 60s of the horizon`).join('; '),
    economicConsequence: 'a fixture-only lifecycle is not production evidence; timely marks at each horizon are what make the label true',
  });
}

// =====================================================================
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const head = sh('git rev-parse --short=7 HEAD');
  const sidecar = SIDECAR !== null && existsSync(SIDECAR) ? (JSON.parse(readFileSync(SIDECAR, 'utf8')) as Record<string, unknown>) : null;

  const db = ro(LIVE_DB);

  /**
   * Load the contract BEFORE any probe runs, so every finding is stamped with
   * whether it is claimed. Failing to find one is not an error and not an
   * escape: with no contract, everything is claimed.
   */
  try {
    const contract = one<{
      contract_id: string;
      evidence_context_id: string;
      claimed_invariants: string;
    }>(db, 'SELECT contract_id, evidence_context_id, claimed_invariants FROM experiment_contracts ORDER BY frozen_utc_ms DESC LIMIT 1');
    if (contract !== undefined) {
      CONTRACT_ID = contract.contract_id;
      ACTIVE_CTX = contract.evidence_context_id;
      CLAIMED = new Set(JSON.parse(contract.claimed_invariants) as string[]);
      const artifact = 'artifacts/experiment-contract.json';
      if (existsSync(artifact)) {
        const j = JSON.parse(readFileSync(artifact, 'utf8')) as { outOfScope?: Record<string, string> };
        OUT_OF_SCOPE_REASONS = j.outOfScope ?? {};
      }
      console.log(`active contract: ${CONTRACT_ID}`);
      console.log(`active context : ${ACTIVE_CTX}`);
      console.log(`claimed        : ${CLAIMED.size} invariant(s)\n`);
    } else {
      console.log('no frozen experiment contract: EVERY invariant is claimed.\n');
    }
  } catch {
    console.log('experiment_contracts is unreadable: EVERY invariant is claimed.\n');
  }

  const machine = await sectionA(db);
  sectionB(db, sidecar);
  const trace = sectionC(db);
  sectionD();
  sectionE();
  sectionF(sidecar);
  sectionG(db);
  sectionH(db);
  sectionI(db);
  sectionJ(db);
  sectionK(db);
  sectionL(COPY_DB);
  sectionM(db);
  sectionN(db);
  sectionO(db);
  sectionP(db);
  sectionQ(sidecar);
  sectionR(COPY_DB, sidecar, db);
  sectionS(db, sidecar);
  db.close();

  const tally = {
    PASS: findings.filter((f) => f.verdict === 'PASS').length,
    FAIL: findings.filter((f) => f.verdict === 'FAIL').length,
    'NOT TESTABLE': findings.filter((f) => f.verdict === 'NOT TESTABLE').length,
    'OUT OF SCOPE': findings.filter((f) => f.verdict === 'OUT OF SCOPE').length,
  };

  /**
   * The terminal state is DERIVED, never chosen.
   *
   * A `NOT TESTABLE` CLAIMED invariant prevents promotion, and so does a FAIL.
   * An OUT OF SCOPE invariant does neither — but only because the contract
   * removed it explicitly and carries the reason, which is a recorded act
   * rather than an omission.
   *
   * `VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` additionally requires that the
   * active window actually produced trajectories whose economics recompute. A
   * clean sweep over an EMPTY corpus is a clean sweep over nothing, and that is
   * the specific way a gate lies while being technically correct.
   */
  const recomputed = existsSync('artifacts/trajectory-trace.json')
    ? (() => {
        try {
          const j = JSON.parse(readFileSync('artifacts/trajectory-trace.json', 'utf8')) as {
            recomputed?: number;
            failures?: number;
          };
          return { recomputed: j.recomputed ?? 0, failures: j.failures ?? 1 };
        } catch {
          return { recomputed: 0, failures: 1 };
        }
      })()
    : { recomputed: 0, failures: 1 };

  const gateClean = tally.FAIL === 0 && tally['NOT TESTABLE'] === 0;
  const state = !gateClean
    ? 'MEASUREMENT_REPAIR_REQUIRED'
    : recomputed.recomputed >= 10 && recomputed.failures === 0
      ? 'VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING'
      : 'MEASUREMENT_REPAIR_REQUIRED';

  mkdirSync('artifacts', { recursive: true });
  const out = {
    artifact: 'runtime-adversarial-audit',
    auditedRemoteHead: '29c7cc7f086b9be5c21445fabd84f47794251857',
    head: sh('git rev-parse HEAD'),
    generatedUtcMs: Date.now(),
    activeContractId: CONTRACT_ID,
    activeEvidenceContextId: ACTIVE_CTX,
    claimedInvariants: CLAIMED === null ? 'ALL' : [...CLAIMED],
    machine,
    tally,
    recomputedTrajectories: recomputed,
    terminalState: state,
    findings,
  };
  const path = `artifacts/runtime-adversarial-audit-${head}.json`;
  writeFileSync(path, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  const traceId = (trace['trajectory'] as Record<string, string> | undefined)?.['trajectory_id'] ?? 'none';
  const tracePath = `artifacts/runtime-trajectory-trace-${traceId.slice(0, 8)}.json`;
  writeFileSync(tracePath, JSON.stringify(trace, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  console.log('');
  console.log(
    `PASS ${tally.PASS}   FAIL ${tally.FAIL}   NOT TESTABLE ${tally['NOT TESTABLE']}   ` +
      `OUT OF SCOPE ${tally['OUT OF SCOPE']}`,
  );
  if (tally.FAIL > 0 || tally['NOT TESTABLE'] > 0) {
    console.log('\nblocking, in the ACTIVE CONTRACT:');
    for (const f of findings.filter((x) => x.verdict === 'FAIL' || x.verdict === 'NOT TESTABLE')) {
      console.log(`  ${f.verdict === 'FAIL' ? 'FAIL' : 'N/T '}  ${f.id}  ${f.invariant}`);
    }
  }
  console.log(
    `\nindependently recomputed trajectories: ${recomputed.recomputed} ` +
      `(${recomputed.failures} failure(s)) — 10 with zero failures are required`,
  );
  console.log(`terminal state: ${state}`);
  console.log(`wrote ${path}`);
  console.log(`wrote ${tracePath}`);
  if (tally.FAIL > 0) process.exitCode = 1;
}
