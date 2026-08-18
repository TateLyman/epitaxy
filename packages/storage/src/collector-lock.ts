import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Db } from './db.js';
import { hostnameSafe } from './db.js';

/**
 * ONE semantic owner of the trajectory candidate queue.
 *
 * SQLite WAL gives concurrent readers and one writer at a time, which is a
 * statement about bytes. It says nothing about whether two processes may both
 * decide that mint X is under the per-mint sampling cap. The 8f73cef audit
 * measured what that costs: five daemons evaluating `COUNT(*) < maxPerMint`
 * against the same instant admitted the same mint, 15 mints exceeded a hard cap
 * of 3, and the worst produced 58 trajectories — nineteen times the cap, one
 * mint accounting for a fifth of the sample.
 *
 * TWO SEPARATE LOCK NAMES, because the audit's other finding was that both
 * programs answered to the word "collector":
 *
 *   `collector`             apps/collector/src/main.ts      — screening, `pnpm observe`
 *   `trajectory_collector`  apps/collector/src/trajectory-collect.ts
 *
 * `pnpm health` printed OK against the FIRST lock while five instances of the
 * SECOND program ran unlocked beside it. Sharing a lock name between two
 * programs is not a naming problem; it is a liveness report about the wrong
 * process.
 *
 * The database lock is the authority. The OS-level lock file below is a second
 * line of defence for the window before the database is even opened, and it
 * does not replace the first.
 */

export const TRAJECTORY_COLLECTOR_LOCK = 'trajectory_collector';
export const SCREENING_COLLECTOR_LOCK = 'collector';

/** How long without a heartbeat before an owner may be considered stale. */
export const STALE_AFTER_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export class CollectorLockRefused extends Error {
  constructor(
    readonly heldByPid: number,
    readonly heartbeatAgeMs: number,
    readonly ownerAlive: boolean,
    reason: string,
  ) {
    super(reason);
    this.name = 'CollectorLockRefused';
  }
}

export interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredUtcMs: number;
  readonly heartbeatUtcMs: number;
  readonly mode: string;
  readonly sourceCommit: string;
  readonly commandLine: string;
}

/**
 * Is `pid` a live process on this host?
 *
 * `process.kill(pid, 0)` throws ESRCH for a dead pid and EPERM for one we may
 * not signal — EPERM means it EXISTS. Treating EPERM as dead would let a
 * takeover steal a lock from a running collector owned by another user.
 */
export function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The command line of a live pid, or null when it cannot be read.
 *
 * `pidIsAlive` answers "does a process with this number exist", which is NOT
 * the question the lock asks. Measured 2026-08-17: the collector at pid 15880
 * exited, Windows handed 15880 to a `sleep`, and the lock then refused every
 * new collector with "the lock is held by live pid 15880" — forever, because a
 * lock held by a stranger is never released and the rule that a live pid may
 * not be taken over is deliberately absolute.
 *
 * PID reuse on Windows is minutes, not days. So the identity check is the
 * COMMAND LINE, which the lock already stores. A genuinely hung collector still
 * matches it and is still refused; a recycled pid does not and is treated as
 * what it is, a dead owner.
 *
 * Null on any failure — no PowerShell, no permission, an unparseable answer.
 * Null is not "recycled": the caller keeps the conservative reading and refuses,
 * because an unreadable command line is not evidence that the owner is gone.
 */
export function commandLineOfPid(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return out.length === 0 ? null : out;
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * Is the process at `pid` still the one that took this lock?
 *
 * "Unknown" is reported as `true`. The lock's whole posture is that a half
 * signal is not permission, and an unreadable command line is a half signal.
 */
export function pidStillOwns(pid: number, recordedCommandLine: string): boolean {
  if (recordedCommandLine.trim().length === 0) return true;
  const live = commandLineOfPid(pid);
  if (live === null) return true;
  // The recorded line is this repository's own argv, truncated to 500 chars,
  // and the live one comes from the OS with its own quoting. Compare on the
  // script path, which is the part that identifies the program.
  const marker = /trajectory-collect/.test(recordedCommandLine)
    ? 'trajectory-collect'
    : /collector[\\/]src[\\/]main/.test(recordedCommandLine)
      ? 'main.ts'
      : null;
  if (marker === null) return true;
  return live.includes(marker);
}

function currentCommandLine(): string {
  return [process.argv0, ...process.argv.slice(1)].join(' ').slice(0, 500);
}

interface LockRow {
  pid: number;
  hostname: string;
  acquired_utc_ms: number;
  heartbeat_utc_ms: number;
  mode: string;
  source_commit: string | null;
  command_line: string | null;
}

/**
 * The exclusive owner of the trajectory candidate queue.
 *
 * `acquire()` runs entirely inside `BEGIN IMMEDIATE`. A read-then-write across
 * two statements is exactly the race that produced 58 trajectories on one mint;
 * doing the inspection and the claim in one write transaction means two
 * processes cannot both observe "no live owner".
 */
export class TrajectoryCollectorLock {
  private timer: NodeJS.Timeout | null = null;
  private held = false;
  private fileLockFd: number | null = null;
  private fileLockPath: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      readonly mode: string;
      readonly sourceCommit: string;
      readonly staleAfterMs?: number;
      readonly lockFilePath?: string | null;
      readonly now?: () => number;
      readonly pidAlive?: (pid: number) => boolean;
      /** Injected so a test can express PID reuse without one. */
      readonly pidStillOwns?: (pid: number, recordedCommandLine: string) => boolean;
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private alive(pid: number): boolean {
    return this.opts.pidAlive ? this.opts.pidAlive(pid) : pidIsAlive(pid);
  }

  private stillOwns(pid: number, recordedCommandLine: string): boolean {
    return this.opts.pidStillOwns
      ? this.opts.pidStillOwns(pid, recordedCommandLine)
      : pidStillOwns(pid, recordedCommandLine);
  }

  /** Current owner, or null. Read-only; safe from any process. */
  owner(): LockOwner | null {
    const row = this.db
      .prepare(
        `SELECT pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode, source_commit, command_line
           FROM process_locks WHERE lock_name = ?`,
      )
      .get(TRAJECTORY_COLLECTOR_LOCK) as LockRow | undefined;
    if (!row) return null;
    return {
      pid: row.pid,
      hostname: row.hostname,
      acquiredUtcMs: row.acquired_utc_ms,
      heartbeatUtcMs: row.heartbeat_utc_ms,
      mode: row.mode,
      sourceCommit: row.source_commit ?? 'unknown',
      commandLine: row.command_line ?? '',
    };
  }

  /**
   * Take the lock, or throw.
   *
   * Refusal rules, in the order the directive states them:
   *   - a live heartbeat AND a live pid  -> refuse. Another collector owns this.
   *   - a dead pid AND a stale heartbeat -> explicit takeover, recorded.
   *   - anything else (live pid, stale heartbeat / dead pid, fresh heartbeat)
   *     -> refuse. A half-signal is not permission.
   */
  acquire(): LockOwner {
    const staleAfter = this.opts.staleAfterMs ?? STALE_AFTER_MS;
    const now = this.now();
    const me = process.pid;
    let takeoverNote: string | null = null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.owner();
      if (existing && existing.pid !== me) {
        const age = now - existing.heartbeatUtcMs;
        const ownerAlive = this.alive(existing.pid);
        const heartbeatStale = age >= staleAfter;

        if (ownerAlive && !heartbeatStale) {
          throw new CollectorLockRefused(
            existing.pid,
            age,
            true,
            `the trajectory collector lock is held by live pid ${existing.pid} ` +
              `(heartbeat ${Math.round(age / 1000)}s ago, commit ${existing.sourceCommit}). ` +
              'A second trajectory collector may not read candidates.',
          );
        }
        if (ownerAlive) {
          /**
           * A live pid with a STALE heartbeat is one of two things, and they
           * need opposite answers.
           *
           * A hung collector still runs `trajectory-collect` and must not be
           * taken from under; that is the rule and it stands. A RECYCLED pid is
           * a stranger holding a number, and refusing for it wedges the
           * apparatus permanently — the stranger will never release a lock it
           * does not know it has.
           *
           * The command line separates them. Unreadable counts as the hung
           * case, because a half signal is not permission.
           */
          if (this.stillOwns(existing.pid, existing.commandLine)) {
            throw new CollectorLockRefused(
              existing.pid,
              age,
              true,
              `pid ${existing.pid} is ALIVE but its heartbeat is ${Math.round(age / 1000)}s stale. ` +
                'A stale heartbeat from a live process is a hung collector, not an abandoned lock. ' +
                'Stop it explicitly (`pnpm collector:stop-all`) rather than taking the lock from under it.',
            );
          }
          takeoverNote =
            `pid ${existing.pid} exists but is no longer this collector — the pid was reused after the owner ` +
            `exited, and its heartbeat is ${Math.round(age / 1000)}s stale`;
        }
        if (!heartbeatStale) {
          throw new CollectorLockRefused(
            existing.pid,
            age,
            false,
            `pid ${existing.pid} is dead but its heartbeat is only ${Math.round(age / 1000)}s old ` +
              `(stale after ${Math.round(staleAfter / 1000)}s). It may still be shutting down; refusing to race it.`,
          );
        }
        // Dead pid AND stale heartbeat, or a stale heartbeat on a pid that is
        // demonstrably no longer this program. The only takeovers permitted.
        if (takeoverNote !== null) console.log(`taking over the trajectory collector lock: ${takeoverNote}`);
      }

      this.db
        .prepare(
          `INSERT INTO process_locks
             (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode, source_commit, command_line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(lock_name) DO UPDATE SET
             pid=excluded.pid, hostname=excluded.hostname,
             acquired_utc_ms=excluded.acquired_utc_ms, heartbeat_utc_ms=excluded.heartbeat_utc_ms,
             mode=excluded.mode, source_commit=excluded.source_commit, command_line=excluded.command_line`,
        )
        .run(
          TRAJECTORY_COLLECTOR_LOCK,
          me,
          hostnameSafe(),
          now,
          now,
          this.opts.mode,
          this.opts.sourceCommit,
          currentCommandLine(),
        );
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      throw e;
    }

    this.held = true;
    if (!this.opts.now) {
      this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
      this.timer.unref();
    }
    const taken = this.owner();
    if (taken === null) throw new Error('the lock row vanished immediately after it was committed');
    return taken;
  }

  /**
   * Heartbeat on a monotonic schedule.
   *
   * `WHERE pid = ?` matters: if this process lost the lock to an explicit
   * takeover, its heartbeat must NOT resurrect its own claim over the new owner.
   */
  heartbeat(): void {
    if (!this.held) return;
    try {
      this.db
        .prepare('UPDATE process_locks SET heartbeat_utc_ms = ? WHERE lock_name = ? AND pid = ?')
        .run(this.now(), TRAJECTORY_COLLECTOR_LOCK, process.pid);
    } catch {
      // Surfaced by the staleness check on the other side rather than here.
    }
  }

  /** True while this process still owns the row it wrote. */
  stillOwned(): boolean {
    const o = this.owner();
    return o !== null && o.pid === process.pid;
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.held) {
      try {
        this.db
          .prepare('DELETE FROM process_locks WHERE lock_name = ? AND pid = ?')
          .run(TRAJECTORY_COLLECTOR_LOCK, process.pid);
      } catch {
        /* best effort on shutdown */
      }
      this.held = false;
    }
    this.releaseFileLock();
  }

  /**
   * OS-level exclusive lock file — the second line of defence.
   *
   * It covers the window between process start and the database being open, and
   * it survives a database file that was moved or replaced. It does NOT replace
   * the database lock: a file lock says nothing about who owns the candidate
   * queue in a corpus that may be reached over a different path.
   */
  acquireFileLock(path?: string): { ok: true } | { ok: false; heldByPid: number } {
    const p = resolve(path ?? this.opts.lockFilePath ?? './data/trajectory-collector.pid');
    mkdirSync(dirname(p), { recursive: true });
    try {
      // 'wx' fails if the file exists. That is the exclusion.
      const fd = openSync(p, 'wx');
      writeSync(fd, `${process.pid}\n`);
      this.fileLockFd = fd;
      this.fileLockPath = p;
      return { ok: true };
    } catch {
      // It exists. Whether that means anything depends on whether its pid lives.
      let holder = 0;
      try {
        holder = Number(readFileSync(p, 'utf8').trim());
      } catch {
        holder = 0;
      }
      if (holder > 0 && holder !== process.pid && this.alive(holder)) {
        return { ok: false, heldByPid: holder };
      }
      // Stale file from a killed process. Replace it, keeping exclusivity.
      try {
        unlinkSync(p);
        const fd = openSync(p, 'wx');
        writeSync(fd, `${process.pid}\n`);
        this.fileLockFd = fd;
        this.fileLockPath = p;
        return { ok: true };
      } catch {
        return { ok: false, heldByPid: holder };
      }
    }
  }

  private releaseFileLock(): void {
    if (this.fileLockFd !== null) {
      try {
        closeSync(this.fileLockFd);
      } catch {
        /* ignore */
      }
      this.fileLockFd = null;
    }
    if (this.fileLockPath !== null && existsSync(this.fileLockPath)) {
      try {
        unlinkSync(this.fileLockPath);
      } catch {
        /* ignore */
      }
      this.fileLockPath = null;
    }
  }
}

export interface TreeState {
  readonly commit: string;
  /** True when SOURCE differs from the commit. Artifacts do not count. */
  readonly dirty: boolean;
  /** Source files only — the ones that change what the code does. */
  readonly dirtyFiles: readonly string[];
  /** Modified outputs, reported but not disqualifying. */
  readonly dirtyArtifacts: readonly string[];
}

/**
 * Paths whose contents are OUTPUTS of a run, never inputs to one.
 *
 * A modified artifact does not change what the code does, so it cannot make a
 * trajectory non-re-derivable from its commit — which is the entire property
 * the dirty-tree gate protects. The 8f73cef audit drew the same line, recording
 * its own tree as `DIRTY (artifacts only)` while still treating the local SHA
 * as equal to the remote.
 *
 * Without this the gate is unusable in the one sequence it exists for:
 * `contract:freeze` writes an artifact, committing it moves HEAD, and the
 * contract it just froze names the previous commit. Every freeze would
 * invalidate itself.
 *
 * Deliberately narrow. `artifacts/` only — not `docs/`, not `data/`, not
 * anything under `packages/`, `apps/`, `scripts/`, `config/` or `tests/`.
 */
const OUTPUT_ONLY = [/^artifacts\//];

/** The source state this process is actually running, read from git, not asserted. */
export function readTreeState(cwd?: string): TreeState {
  const runRaw = (args: string[]): string => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', cwd, timeout: 30_000 });
    } catch {
      return '';
    }
  };
  const run = (args: string[]): string => runRaw(args).trim();
  /**
   * Parse the porcelain format properly, and do NOT trim the whole output.
   *
   * `git status --porcelain` emits `XY PATH`, where X is the index status and Y
   * the worktree status. For a file modified but not staged, X is a SPACE:
   *
   *     " M artifacts/experiment-contract.json"
   *
   * Trimming the output before splitting removes that leading space, so a fixed
   * `slice(3)` then eats the first character of the path and produces
   * `rtifacts/...`. Every dirty file was being reported under a mangled name,
   * and — worse — the `artifacts/` exemption could never match, so the gate
   * refused runs it was meant to allow.
   *
   * A rename arrives as `R  old -> new`; the destination is what exists now.
   */
  const status = runRaw(['status', '--porcelain']);
  const all = status
    .split('\n')
    .map((line) => {
      const m = /^(..) (.+)$/.exec(line.replace(/\r$/, ''));
      if (m === null) return null;
      const path = m[2] as string;
      const arrow = path.indexOf(' -> ');
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .filter((p): p is string => p !== null && p.length > 0);
  const dirtyArtifacts = all.filter((f) => OUTPUT_ONLY.some((r) => r.test(f)));
  const dirtyFiles = all.filter((f) => !OUTPUT_ONLY.some((r) => r.test(f)));
  return {
    commit: run(['rev-parse', 'HEAD']) || 'unknown',
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    dirtyArtifacts,
  };
}

export class DirtyEvidenceCollection extends Error {
  constructor(readonly dirtyFiles: readonly string[]) {
    super(
      `refusing to open an evidence context from a DIRTY tree (${dirtyFiles.length} modified file(s): ` +
        `${dirtyFiles.slice(0, 6).join(', ')}${dirtyFiles.length > 6 ? ', …' : ''}).\n` +
        'A trajectory opened from an uncommitted tree cannot be re-derived from its commit — 26 of 31 sessions ' +
        'in the pre-repair corpus were opened this way.\n' +
        'Commit the tree, or pass --instrument-development to write to a context permanently excluded from evidence.',
    );
    this.name = 'DirtyEvidenceCollection';
  }
}

/**
 * The gate a development-evidence collector passes before it opens a context.
 *
 * Returns the validity the context must be stamped with. A dirty run is not
 * forbidden — it is quarantined, which is the only way a developer can iterate
 * without either lying about provenance or being unable to run the thing.
 */
export function evidenceContextValidity(
  tree: TreeState,
  opts: { readonly instrumentDevelopment: boolean },
): { readonly validity: 'DEVELOPMENT_EVIDENCE' | 'INSTRUMENT_DEVELOPMENT_INVALID'; readonly reason: string | null } {
  if (!tree.dirty) return { validity: 'DEVELOPMENT_EVIDENCE', reason: null };
  if (opts.instrumentDevelopment) {
    return {
      validity: 'INSTRUMENT_DEVELOPMENT_INVALID',
      reason: `opened from a dirty tree under --instrument-development (${tree.dirtyFiles.length} modified file(s))`,
    };
  }
  throw new DirtyEvidenceCollection(tree.dirtyFiles);
}
