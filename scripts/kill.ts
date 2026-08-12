import { loadSecrets } from '../packages/domain/src/config.js';
import { hostnameSafe, openDb } from '../packages/storage/src/db.js';
import { recordHealth } from '../packages/storage/src/repo.js';

/**
 * Stops running engines and clears their locks.
 *
 * A lock is only removed after the owning process is confirmed dead. A "kill"
 * that force-clears a live lock would let a second engine start alongside the
 * first, and two engines sharing one ledger is exactly the state the lock
 * exists to prevent — so an unresponsive process is reported, never overridden.
 */

interface LockRow {
  lock_name: string;
  pid: number;
  hostname: string;
  mode: string;
  heartbeat_utc_ms: number;
}

/**
 * Signal 0 performs the permission and existence check without delivering a
 * signal. EPERM means the pid exists but belongs to another user, which is
 * still "alive" for our purposes.
 */
function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function terminate(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const waitMs = force ? 0 : 15_000;

  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, skipBackup: true });
  const locks = db.prepare('SELECT lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode FROM process_locks').all() as unknown as LockRow[];

  if (locks.length === 0) {
    console.log('no locks held; nothing to stop');
    return;
  }

  const local = hostnameSafe();
  const stillHeld: LockRow[] = [];

  for (const lock of locks) {
    const age = Date.now() - lock.heartbeat_utc_ms;

    // A lock written by a different machine says nothing about our pid table:
    // pid 4711 here is not the pid 4711 that took the lock there.
    if (lock.hostname !== local) {
      console.log(`SKIP  ${lock.lock_name}: held by pid ${lock.pid} on ${lock.hostname}, not this host`);
      stillHeld.push(lock);
      continue;
    }

    if (!pidAlive(lock.pid)) {
      db.prepare('DELETE FROM process_locks WHERE lock_name = ? AND pid = ?').run(lock.lock_name, lock.pid);
      console.log(`CLEAR ${lock.lock_name}: pid ${lock.pid} is gone (heartbeat ${age}ms ago), stale lock removed`);
      continue;
    }

    console.log(`STOP  ${lock.lock_name}: signalling pid ${lock.pid} (mode=${lock.mode})`);
    if (!terminate(lock.pid)) {
      console.log(`WARN  ${lock.lock_name}: could not signal pid ${lock.pid}`);
      stillHeld.push(lock);
      continue;
    }

    // The engine releases its own lock on a clean shutdown. Waiting for that is
    // what makes this safe: we observe the process exit rather than assume it.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && pidAlive(lock.pid)) {
      await sleep(250);
    }

    if (pidAlive(lock.pid)) {
      console.log(`WARN  ${lock.lock_name}: pid ${lock.pid} still alive after ${waitMs}ms; lock left in place`);
      stillHeld.push(lock);
    } else {
      db.prepare('DELETE FROM process_locks WHERE lock_name = ? AND pid = ?').run(lock.lock_name, lock.pid);
      console.log(`OK    ${lock.lock_name}: pid ${lock.pid} exited, lock cleared`);
    }
  }

  recordHealth(db, 'kill_invoked', stillHeld.length > 0 ? 'warn' : 'info', `${locks.length} lock(s), ${stillHeld.length} still held`);

  if (stillHeld.length > 0) {
    console.error(`\n${stillHeld.length} lock(s) still held. Investigate those processes before starting another engine.`);
    process.exitCode = 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main();
