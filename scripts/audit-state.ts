import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb, MIGRATIONS, schemaVersion } from '../packages/storage/src/db.js';
import { strategyConfigHash, riskPolicyHash, dataRegimeId, sourceCommit } from '../packages/domain/src/provenance.js';
import { onlineBackup } from '../packages/storage/src/backup.js';

/**
 * `pnpm audit:state` — what is actually true on this machine right now.
 *
 * GitHub HEAD is not proof of the local tree, the runtime database, the WSL
 * daemon, or a process that has been running since before half of this code
 * existed. Every number here is read from the thing it describes.
 *
 * It takes a VERIFIED online backup before reporting, because the point of an
 * audit is to be able to go back to the state it describes.
 *
 * Read-only against the engine: it does not take the process lock, and the
 * counts are expected to move while it runs.
 */

const MODE = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'paper';
const secrets = loadSecrets();
const dbPath = resolve(secrets.databasePath);

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}
function wsl(cmd: string): string {
  try {
    return execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '-e', 'bash', '-lc', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
  } catch {
    return 'unreachable';
  }
}

const out: string[] = [];
const say = (s = ''): void => {
  out.push(s);
  console.log(s);
};

say(`# Local state audit`);
say();
say(`Taken at ${new Date().toISOString()} in mode \`${MODE}\`.`);
say();

// ---------------------------------------------------------------- repository
const head = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']);
say(`## Repository`);
say();
say('```');
say(`path            ${process.cwd()}`);
say(`remote          ${git(['remote', 'get-url', 'origin'])}`);
say(`branch          ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
say(`HEAD            ${head}`);
say(`dirty files     ${dirty.length === 0 ? 'none' : dirty.split('\n').length}`);
for (const line of dirty.split('\n').filter((l) => l.length > 0).slice(0, 20)) say(`                ${line}`);
say(`node            ${process.version}`);
say('```');
say();

// ------------------------------------------------------------------ database
say(`## Runtime database`);
say();
const sizes: string[] = [];
for (const suffix of ['', '-wal', '-shm']) {
  const p = dbPath + suffix;
  sizes.push(
    existsSync(p)
      ? `${p.split(/[\\/]/).pop()}  ${statSync(p).size} bytes  mtime ${statSync(p).mtime.toISOString()}`
      : `${p.split(/[\\/]/).pop()}  (absent)`,
  );
}
say('```');
for (const s of sizes) say(s);
say('```');
say();

// The backup comes FIRST, from a writable connection, so everything reported
// below describes a state we can return to.
mkdirSync('data/backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve('data/backups', `audit-${stamp}.db`);
const writable = new DatabaseSync(dbPath);
let backupLine: string;
try {
  const r = onlineBackup(writable as never, backupPath, { witnessTable: 'screenings' });
  backupLine =
    `path        ${r.path}\nbytes       ${r.bytes}\nsha256      ${r.sha256}\n` +
    `integrity   ${r.integrity}\nfk check    ${r.foreignKeyViolations} violation(s)\n` +
    `staleness   ${r.witnessTable} ${r.witnessBefore} <= ${r.witnessInBackup} <= ${r.witnessAfter} (verified)\n` +
    `elapsed     ${r.elapsedMs} ms`;
} catch (e) {
  backupLine = `FAILED: ${(e as Error).message}`;
} finally {
  writable.close();
}
say(`### Verified online backup`);
say();
say('```');
say(backupLine);
say('```');
say();

const db = openDb({ path: dbPath, readonly: true });

const applied = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as { id: number; name: string }[];
const highestApplied = applied.length === 0 ? 0 : (applied[applied.length - 1]?.id ?? 0);
const highestInCode = MIGRATIONS.reduce((a, m) => (m.id > a ? m.id : a), 0);
say(`### Schema`);
say();
say('```');
say(`applied         ${highestApplied} (${applied.length} migrations)`);
say(`in code         ${highestInCode}`);
say(
  highestApplied === highestInCode
    ? `state           up to date`
    : `state           BEHIND by ${highestInCode - highestApplied}: the live engine predates migration(s) ` +
        MIGRATIONS.filter((m) => m.id > highestApplied)
          .map((m) => `${m.id}/${m.name}`)
          .join(', '),
);
say('```');
say();

const q = <T>(sql: string, fallback: T): T => {
  try {
    return db.prepare(sql).all() as T;
  } catch {
    return fallback;
  }
};

say(`### Exposure`);
say();
say('```');
// From first principles, not from a state allowlist: anything unclosed that
// holds tokens is exposure, whatever its state is called.
const exposed = q<{ state: string; c: number; tokens: string }[]>(
  `SELECT state, COUNT(*) c, SUM(CAST(token_amount AS TEXT)) tokens FROM positions
   WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0 GROUP BY state`,
  [],
);
say(`portfolio positions holding tokens and not closed: ${exposed.length === 0 ? 'NONE' : ''}`);
for (const r of exposed) say(`  ${r.state}  ${r.c}`);
for (const r of q<{ state: string; c: number }[]>('SELECT state, COUNT(*) c FROM positions GROUP BY state', [])) {
  say(`  all portfolio positions  ${r.state}  ${r.c}`);
}
for (const r of q<{ book: string; state: string; c: number }[]>(
  'SELECT book, state, COUNT(*) c FROM shadow_positions GROUP BY book, state ORDER BY book, state',
  [],
)) {
  say(`  shadow ${r.book}  ${r.state}  ${r.c}`);
}
say('```');
say();

say(`### Corpus`);
say();
say('```');
for (const [label, sql] of [
  ['execution_observations', 'SELECT COUNT(*) c FROM execution_observations'],
  ['  simulated OK', "SELECT COUNT(*) c FROM execution_observations WHERE simulation = 'SIMULATED_OK'"],
  ['signal_episodes', 'SELECT COUNT(*) c FROM signal_episodes'],
  ['positions', 'SELECT COUNT(*) c FROM positions'],
  ['shadow_positions', 'SELECT COUNT(*) c FROM shadow_positions'],
  ['fills', 'SELECT COUNT(*) c FROM fills'],
  ['run_contexts', 'SELECT COUNT(*) c FROM run_contexts'],
  ['simulation_jobs', 'SELECT COUNT(*) c FROM simulation_jobs'],
] as [string, string][]) {
  const r = q<{ c: number }[]>(sql, [{ c: -1 }])[0];
  say(`${label.padEnd(24)} ${r === undefined || r.c < 0 ? 'TABLE ABSENT' : r.c}`);
}
for (const r of q<{ family: string; simulation: string; c: number }[]>(
  'SELECT family, simulation, COUNT(*) c FROM execution_observations GROUP BY 1,2 ORDER BY c DESC',
  [],
)) {
  say(`  ${String(r.family).padEnd(22)} ${String(r.simulation).padEnd(16)} ${r.c}`);
}
for (const r of q<{ purpose: string; c: number }[]>(
  'SELECT purpose, COUNT(*) c FROM execution_observations GROUP BY 1 ORDER BY c DESC LIMIT 12',
  [],
)) {
  say(`  purpose ${String(r.purpose).padEnd(32)} ${r.c}`);
}
say('```');
say();

// ------------------------------------------------------------------ processes
say(`## Processes`);
say();
const lock = q<{ owner: string; pid: number; heartbeat_utc_ms: number; mode: string }[]>(
  'SELECT * FROM process_locks',
  [],
);
say('```');
for (const l of lock) {
  const age = Math.round((Date.now() - Number(l.heartbeat_utc_ms)) / 1000);
  say(`engine    pid=${l.pid} mode=${l.mode ?? '?'} heartbeat ${age}s ago`);
}
if (lock.length === 0) say('engine    no process lock held');
say(`wsl       ${wsl('echo up')} distro=Ubuntu-24.04`);
say(`  sha     ${wsl('cd ~/epitaxy && git rev-parse HEAD')}`);
say(`  dirty   ${wsl('cd ~/epitaxy && git status --porcelain | wc -l')} file(s)`);
say(`  daemon  ${wsl("pgrep -f 'simulatord/src' | head -1 || echo none")}`);
say(`  node    ${wsl('node --version')}`);
say(`  disk    ${wsl('df -h /home | tail -1')}`);
say('```');
say();

// Clock offset matters: two machines timestamping one experiment is a source of
// silent disagreement, and this project keys days off UTC.
const winMs = Date.now();
const wslMs = Number(wsl('date +%s%3N') || '0');
say(`## Clocks`);
say();
say('```');
say(`windows   ${new Date(winMs).toISOString()}`);
say(`wsl       ${wslMs === 0 ? 'unreadable' : new Date(wslMs).toISOString()}`);
say(`offset    ${wslMs === 0 ? 'unknown' : `${wslMs - winMs} ms (wsl - windows)`}`);
say('```');
say();

// ------------------------------------------------------------------ simulator
say(`## Simulator`);
say();
let identity = 'unreachable';
let health = 'unreachable';
try {
  const h = await fetch('http://127.0.0.1:8787/v1/health', { signal: AbortSignal.timeout(4000) });
  health = await h.text();
  const i = await fetch('http://127.0.0.1:8787/v1/identity', {
    headers: { authorization: `Bearer ${process.env['SIMULATORD_TOKEN'] ?? 'local-dev-token-0123456789'}` },
    signal: AbortSignal.timeout(4000),
  });
  identity = await i.text();
} catch (e) {
  health = `unreachable: ${(e as Error).message}`;
}
say('```');
say(`health    ${health}`);
say(`identity  ${identity.slice(0, 600)}`);
say('```');
say();

// -------------------------------------------------------------------- config
const config = loadConfig(MODE as never);
// The project's own hashes, not an ad-hoc one. A second definition of "what
// config is this" is a second answer waiting to disagree with the first.
const configHash = strategyConfigHash(config);
say(`## Config`);
say();
say('```');
say(`mode                        ${MODE}`);
say(`strategyConfigHash          ${configHash}`);
say(`riskPolicyHash              ${riskPolicyHash(config)}`);
say(`dataRegimeId                ${dataRegimeId(config, schemaVersion(db))}`);
say(`sourceCommit                ${sourceCommit()}`);
say(`assumedPriorityFeeLamports  ${String(config.assumedPriorityFeeLamports)}`);
say(`requireLocalSimulation      ${String(config.requireLocalSimulation)}`);
say(`paperStartLamports          ${String((config as { paperStartLamports?: bigint }).paperStartLamports ?? 'n/a')}`);
say('```');
say();

mkdirSync('docs', { recursive: true });
writeFileSync('docs/AUDIT_HEAD_4890AF0.md', `${out.join('\n')}\n`);
console.log('\nwrote docs/AUDIT_HEAD_4890AF0.md');
