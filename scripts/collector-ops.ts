/**
 * `pnpm collector:list` / `collector:stop-all` / `collector:lock-status`
 *
 * The 8f73cef audit opened with five trajectory-collect daemons (15 processes)
 * writing to one 7.3 GB database, while `pnpm health` printed
 * `OK engine.collector pid 24924 alive in observe` — a row about a DIFFERENT
 * program (`apps/collector/src/main.ts`, i.e. `pnpm observe`) that happened to
 * share the lock name `collector`.
 *
 * Two distinct programs sharing one lock name is how five writers looked
 * healthy. So:
 *
 *   lock `collector`             -> apps/collector/src/main.ts      (screening)
 *   lock `trajectory_collector`  -> apps/collector/src/trajectory-collect.ts
 *
 * These commands report and act on the SECOND only. Stopping the screening
 * collector because it contains the word "collector" is the mistake this file
 * exists to make impossible.
 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeArtifact } from './_artifact.js';
import { TRAJECTORY_COLLECTOR_LOCK, SCREENING_COLLECTOR_LOCK } from '../packages/storage/src/collector-lock.js';

export interface CollectorProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdUtc: string | null;
  readonly commandLine: string;
}

/** The regex that defines "a trajectory collector process". Deliberately narrow. */
const TRAJECTORY_PATTERN = 'trajectory-collect\\.ts';

export function listTrajectoryCollectors(): CollectorProcess[] {
  if (process.platform !== 'win32') return listPosix();
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${TRAJECTORY_PATTERN}' -and $_.CommandLine -notmatch 'CimInstance' } | ` +
          'Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ConvertTo-Json -Depth 3 -Compress',
      ],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    ).trim();
    if (out.length === 0) return [];
    const parsed: unknown = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      const raw = String(o['CreationDate'] ?? '');
      const ms = /\/Date\((\d+)\)\//.exec(raw)?.[1];
      return {
        pid: Number(o['ProcessId']),
        parentPid: Number(o['ParentProcessId']),
        createdUtc: ms ? new Date(Number(ms)).toISOString() : null,
        commandLine: String(o['CommandLine'] ?? ''),
      };
    });
  } catch {
    return [];
  }
}

function listPosix(): CollectorProcess[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8', timeout: 30_000 });
    return out
      .split('\n')
      .slice(1)
      .filter((l) => new RegExp(TRAJECTORY_PATTERN).test(l) && !l.includes('collector-ops'))
      .map((l): CollectorProcess | null => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m === null
          ? null
          : { pid: Number(m[1]), parentPid: Number(m[2]), createdUtc: null, commandLine: m[3] ?? '' };
      })
      .filter((x): x is CollectorProcess => x !== null);
  } catch {
    return [];
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stop(pid: number, force: boolean): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction Stop`], {
        timeout: 30_000,
        stdio: 'ignore',
      });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function openDb(): DatabaseSync | null {
  const path = resolve(process.env['DATABASE_PATH'] ?? './data/runtime.db');
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

interface LockRow {
  lock_name: string;
  pid: number;
  hostname: string;
  acquired_utc_ms: number;
  heartbeat_utc_ms: number;
  mode: string;
}

export function lockStatus(): {
  locks: (LockRow & { ageMs: number; pidAlive: boolean; program: string })[];
  sessions: unknown[];
} {
  const db = openDb();
  if (!db) return { locks: [], sessions: [] };
  try {
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM process_locks ORDER BY lock_name').all() as unknown as LockRow[];
    const locks = rows.map((r) => ({
      ...r,
      ageMs: now - r.heartbeat_utc_ms,
      pidAlive: pidAlive(r.pid),
      program:
        r.lock_name === TRAJECTORY_COLLECTOR_LOCK
          ? 'apps/collector/src/trajectory-collect.ts'
          : r.lock_name === SCREENING_COLLECTOR_LOCK
            ? 'apps/collector/src/main.ts'
            : 'unknown',
    }));
    let sessions: unknown[] = [];
    try {
      sessions = db
        .prepare(
          `SELECT session_id, started_utc_ms, ended_utc_ms, source_commit, tree_dirty
             FROM collector_sessions ORDER BY started_utc_ms DESC LIMIT 10`,
        )
        .all() as unknown[];
    } catch {
      sessions = [];
    }
    return { locks, sessions };
  } finally {
    db.close();
  }
}

function main(): void {
  const cmd = process.argv[2] ?? 'list';

  if (cmd === 'list') {
    const procs = listTrajectoryCollectors();
    console.log(`trajectory collectors: ${procs.length}`);
    for (const p of procs) console.log(`  pid ${p.pid} (parent ${p.parentPid}) started ${p.createdUtc ?? '?'}`);
    if (procs.length === 0) console.log('  none');
    process.exit(0);
  }

  if (cmd === 'stop-all') {
    const before = listTrajectoryCollectors();
    console.log(`stopping ${before.length} trajectory collector process(es)`);
    // Children first, so a parent does not respawn a killed child.
    const ordered = [...before].sort((a, b) => b.pid - a.pid);
    for (const p of ordered) {
      const ok = stop(p.pid, false);
      console.log(`  ${ok ? 'signalled' : 'could not signal'} ${p.pid}`);
    }
    const deadline = Date.now() + 10_000;
    let remaining = listTrajectoryCollectors();
    while (remaining.length > 0 && Date.now() < deadline) {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { timeout: 5_000 });
      remaining = listTrajectoryCollectors();
    }
    for (const p of remaining) {
      console.log(`  forcing ${p.pid}`);
      stop(p.pid, true);
    }
    const after = listTrajectoryCollectors();
    console.log(`remaining: ${after.length}`);
    writeArtifact('collector-stop-all.json', {
      stoppedPids: before.map((p) => p.pid),
      remainingPids: after.map((p) => p.pid),
    });
    process.exit(after.length === 0 ? 0 : 1);
  }

  if (cmd === 'lock-status') {
    const { locks, sessions } = lockStatus();
    const procs = listTrajectoryCollectors();
    const trajectoryLock = locks.find((l) => l.lock_name === TRAJECTORY_COLLECTOR_LOCK) ?? null;

    console.log(`processes matching ${TRAJECTORY_PATTERN}: ${procs.length}`);
    console.log('\nlocks:');
    for (const l of locks) {
      console.log(
        `  ${l.lock_name.padEnd(22)} pid ${String(l.pid).padEnd(7)} ${l.pidAlive ? 'ALIVE' : 'DEAD '} ` +
          `heartbeat ${Math.round(l.ageMs / 1000)}s ago  ${l.program}`,
      );
    }
    if (locks.length === 0) console.log('  none');

    // The single-owner property, stated as a verdict rather than left to the reader.
    const problems: string[] = [];
    if (procs.length > 1) problems.push(`${procs.length} trajectory collector processes are alive`);
    if (trajectoryLock && !trajectoryLock.pidAlive) problems.push('the trajectory_collector lock names a dead pid');
    if (procs.length > 0 && trajectoryLock === null)
      problems.push('a trajectory collector is running with no trajectory_collector lock row');

    const artifact = writeArtifact('collector-lock-status.json', {
      trajectoryProcesses: procs,
      locks,
      recentSessions: sessions,
      singleOwner: problems.length === 0,
      problems,
    });
    console.log(`\nsingle owner: ${problems.length === 0 ? 'YES' : 'NO'}`);
    for (const p of problems) console.log(`  ${p}`);
    console.log(`\n-> ${artifact}`);
    process.exit(problems.length === 0 ? 0 : 1);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

if (process.argv[1]?.includes('collector-ops')) main();
