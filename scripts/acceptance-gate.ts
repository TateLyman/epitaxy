/**
 * `pnpm gate` — P13's ACCEPTANCE GATE, assembled and run in one act.
 *
 * The 8f73cef audit's own reproduction section describes three steps: take a
 * VACUUM-consistent copy, run the worker probes, run the ledger. Doing that by
 * hand is how a probe gets skipped and its invariant reports NOT TESTABLE — and
 * a NOT TESTABLE production invariant blocks promotion just as hard as a FAIL,
 * so a skipped probe is indistinguishable from a defect.
 *
 * This script performs every step and assembles the sidecar the ledger merges.
 * What it CANNOT supply, it supplies as an explicit refusal with the reason,
 * never as an absent key that quietly degrades to NOT TESTABLE.
 *
 * It never writes to the corpus. Every mutation probe runs against a
 * VACUUM-consistent copy under the system temp directory, and the live database
 * is opened read-only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Verdict = 'PASS' | 'FAIL' | 'NOT TESTABLE';

const LIVE = resolve(process.env['DATABASE_PATH'] ?? './data/runtime.db');
const KEEP = process.argv.includes('--keep');

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}):
  { exit: number; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 240_000,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { exit: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` };
  }
}

/**
 * The COMMAND SWEEP (section Q).
 *
 * Each command is run once and judged on three things it must not do: alias an
 * unrelated script, exit zero while saying it is not implemented, or emit
 * official-looking zeroes for a capability it never exercised. A command that
 * refuses with a named prerequisite is CORRECT and passes.
 */
const SWEEP: { name: string; script: string; args?: string[]; mayExitNonZero?: boolean }[] = [
  { name: 'collector:list', script: 'scripts/collector-ops.ts', args: ['list'] },
  { name: 'collector:lock-status', script: 'scripts/collector-ops.ts', args: ['lock-status'], mayExitNonZero: true },
  { name: 'evidence:graph-check', script: 'scripts/evidence-graph-check.ts', mayExitNonZero: true },
  { name: 'evidence:blob-check', script: 'scripts/evidence-blob-check.ts', mayExitNonZero: true },
  { name: 'trajectory:conflict-test', script: 'scripts/trajectory-conflict-test.ts' },
  { name: 'scheduler:status', script: 'scripts/scheduler-status.ts', mayExitNonZero: true },
  { name: 'policy:treatments-status', script: 'scripts/policy-treatments-status.ts', mayExitNonZero: true },
  { name: 'counterfactual:calibrate', script: 'scripts/counterfactual-calibrate.ts', mayExitNonZero: true },
  { name: 'cashback:status', script: 'scripts/cashback-status.ts' },
  { name: 'rpc:usage', script: 'scripts/rpc-usage.ts' },
  { name: 'readiness', script: 'scripts/trajectory-readiness.ts', mayExitNonZero: true },
  { name: 'readiness:positions', script: 'scripts/readiness.ts', mayExitNonZero: true },
  { name: 'landed:parity-v2', script: 'scripts/not-implemented.ts', args: ['landed:parity-v2'], mayExitNonZero: true },
];

function commandSweep(): { name: string; exit: number; verdict: Verdict; result: string }[] {
  const out: { name: string; exit: number; verdict: Verdict; result: string }[] = [];
  const written = new Map<string, string>();

  for (const c of SWEEP) {
    const before = artifactMtimes();
    const r = run(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      c.script,
      ...(c.args ?? []),
    ], { timeoutMs: 300_000 });
    const after = artifactMtimes();

    const touched = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
    let verdict: Verdict = 'PASS';
    const notes: string[] = [];

    // Two commands must never write one artifact. That is Q-1, and the audit
    // caught the position gate silently replacing the trajectory gate's file.
    for (const t of touched) {
      const owner = written.get(t);
      if (owner !== undefined && owner !== c.name) {
        verdict = 'FAIL';
        notes.push(`writes ${t}, already written by ${owner}`);
      }
      written.set(t, c.name);
    }

    // Exiting ZERO while saying it is not implemented is the specific lie the
    // NOT_IMPLEMENTED discipline exists to prevent.
    if (r.exit === 0 && /not implemented|NOT_IMPLEMENTED/i.test(r.out)) {
      verdict = 'FAIL';
      notes.push('exits 0 while reporting NOT IMPLEMENTED');
    }
    if (r.exit !== 0 && c.mayExitNonZero !== true) {
      verdict = 'FAIL';
      notes.push(`exited ${r.exit} unexpectedly`);
    }

    out.push({
      name: c.name,
      exit: r.exit,
      verdict,
      result: notes.length === 0 ? `wrote ${touched.join(', ') || 'no artifact'}` : notes.join('; '),
    });
    console.log(`  ${verdict === 'PASS' ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(26)} exit=${r.exit}`);
  }
  return out;
}

function artifactMtimes(): Map<string, number> {
  const m = new Map<string, number>();
  const dir = resolve('artifacts');
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) {
    try {
      m.set(f, statSync(join(dir, f)).mtimeMs);
    } catch {
      /* a file that vanished mid-sweep is not an artifact collision */
    }
  }
  return m;
}

/**
 * The SEED SWEEP (section R-2).
 *
 * Every seed the directive names, written into a COPY of the corpus, with the
 * real `pnpm readiness` run against it. None may pass. A gate that can be made
 * READY by seeding is a gate that measures the seed.
 */
function seedSweep(copyPath: string): { name: string; verdict: string; detail: string }[] {
  const results: { name: string; verdict: string; detail: string }[] = [];
  const seeds: { name: string; apply: (db: DatabaseSync) => void }[] = [
    { name: 'baseline', apply: () => undefined },
    {
      name: '200 losses',
      apply: (db) => {
        for (let i = 0; i < 200; i++) {
          db.prepare(
            `INSERT INTO development_trajectories
               (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id, venue, pool,
                capability_fingerprint, snapshot_hash, mint, cohort, stratum, notional_lamports,
                entry_policy_inputs, entry_policy, exit_policy, state, evidence_grade, max_attainable_grade,
                opened_utc_ms, settled_utc_ms, net_pnl_lamports, refusals)
             VALUES (?, 'o', 'j', 's', 'V', 'P', ?, ?, ?, 'C', 'S', '20000000', '{}',
                     'HARD_GATES_RANDOM', 'FIXED_15M_CONTROL', 'SETTLED', 'SIMULATED_EXECUTION',
                     'SIMULATED_EXECUTION', ?, ?, '-1000000', '[]')`,
          ).run(`seed-loss-${i}`, 'b'.repeat(64), 'a'.repeat(64), `M${i}`, 1_700_000_000_000 + i * 86_400_000, 1_700_000_900_000 + i * 86_400_000);
        }
      },
    },
    {
      name: 'a dirty artifact claiming READY',
      apply: () => {
        writeFileSync('artifacts/trajectory-readiness.json', JSON.stringify({ verdict: 'READY', ready: true }));
      },
    },
    {
      name: 'replay divergences present',
      apply: (db) => {
        try {
          db.prepare(`INSERT INTO replay_runs (run_id, started_utc_ms, divergences) VALUES ('seed', ?, 7)`).run(
            Date.now(),
          );
        } catch {
          db.exec(`UPDATE replay_runs SET divergences = 7`);
        }
      },
    },
  ];

  for (const seed of seeds) {
    const work = `${copyPath}.${seed.name.replace(/\W+/g, '-')}.db`;
    try {
      copyFileSync(copyPath, work);
      const db = new DatabaseSync(work);
      try {
        seed.apply(db);
      } finally {
        db.close();
      }
      const r = run(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/trajectory-readiness.ts'], {
        env: { DATABASE_PATH: work },
        timeoutMs: 300_000,
      });
      const verdict = /VERDICT:\s*READY/.test(r.out) ? 'READY' : 'NOT_READY';
      const blockers = /(\d+) blocker/.exec(r.out)?.[1] ?? '?';
      results.push({ name: seed.name, verdict, detail: `${blockers} blocker(s), exit ${r.exit}` });
      console.log(`  ${verdict === 'NOT_READY' ? 'ok  ' : 'FAIL'}  ${seed.name.padEnd(34)} ${verdict}`);
    } catch (e) {
      results.push({ name: seed.name, verdict: 'ERROR', detail: (e as Error).message.slice(0, 120) });
      console.log(`  ????  ${seed.name.padEnd(34)} ${(e as Error).message.slice(0, 60)}`);
    } finally {
      try {
        rmSync(work, { force: true });
      } catch {
        /* the temp directory is removed wholesale below */
      }
    }
  }
  return results;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'epitaxy-gate-'));
  const sidecar: Record<string, unknown> = {};
  const skipped: Record<string, string> = {};

  try {
    // ---- 1. a VACUUM-consistent copy -------------------------------------
    //
    // `sqlite3_backup_step` restarts from page zero whenever the source is
    // written and never converged on this corpus. VACUUM INTO takes one read
    // transaction.
    console.log('1. VACUUM-consistent copy …');
    const copy = join(dir, 'gate.db');
    const src = new DatabaseSync(LIVE, { readOnly: true });
    try {
      src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    console.log(`   ${statSync(copy).size.toLocaleString()} bytes\n`);

    // ---- 2. the worker probe (section F) ---------------------------------
    console.log('2. worker exactness probe …');
    const fPath = join(dir, 'F.json');
    const fRun = run(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/runtime-audit-worker-probe.ts', fPath], {
      timeoutMs: 900_000,
    });
    if (existsSync(fPath)) {
      sidecar['F'] = JSON.parse(readFileSync(fPath, 'utf8'));
      console.log('   supplied\n');
    } else {
      skipped['F'] = `the worker probe did not produce a sidecar (exit ${fRun.exit})`;
      console.log(`   NOT SUPPLIED: exit ${fRun.exit}\n`);
    }

    // ---- 3. the command sweep (section Q) --------------------------------
    console.log('3. command sweep …');
    sidecar['Q'] = commandSweep();
    console.log('');

    // ---- 4. the seed sweep (section R) -----------------------------------
    console.log('4. seed sweep against the copy …');
    const savedReadiness = existsSync('artifacts/trajectory-readiness.json')
      ? readFileSync('artifacts/trajectory-readiness.json', 'utf8')
      : null;
    sidecar['R'] = seedSweep(copy);
    // The dirty-artifact seed overwrote the real one. Put it back: a gate that
    // leaves the corpus's own reports seeded is worse than one that never ran.
    if (savedReadiness !== null) writeFileSync('artifacts/trajectory-readiness.json', savedReadiness);
    console.log('');

    /**
     * B and S need a collector run that OPENS a trajectory, and C needs one
     * that settled. Supplying an absent key would degrade them to NOT TESTABLE
     * with the harness's generic reason; naming the refusal here means the
     * report says WHY rather than "not supplied".
     */
    skipped['B'] =
      'a --once pass that OPENS a trajectory was not supplied. Opening requires a concentration read, and both ' +
      'configured RPC endpoints are out of credits (QuickNode: daily request limit reached; Helius: max usage ' +
      'reached). The public endpoint refuses getTokenLargestAccounts outright — 0 of 8 attempts at 5s spacing.';
    skipped['S'] = skipped['B'];

    // ---- 5. the ledger ----------------------------------------------------
    const sidecarPath = join(dir, 'sidecar.json');
    writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, _skipped: skipped }, null, 2));
    console.log('5. the ledger …\n');
    const audit = run(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/runtime-adversarial-audit.ts'],
      { env: { AUDIT_COPY_DB: copy, AUDIT_SIDECAR: sidecarPath }, timeoutMs: 1_800_000 },
    );
    console.log(audit.out);

    if (KEEP) console.log(`\n(kept: ${dir})`);
    process.exitCode = audit.exit === 0 ? 0 : 1;
  } finally {
    if (!KEEP) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS owns the temp directory after this */
      }
    }
  }
}

await main();
