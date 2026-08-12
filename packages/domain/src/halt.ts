import { existsSync, readFileSync } from 'node:fs';

/**
 * Halt modes.
 *
 * `pnpm kill` used to mean one thing: SIGTERM the engine. The engine shut down
 * cleanly, released its lock, and left any open position sitting on the chain
 * with nobody watching it. That is the single worst moment to stop paying
 * attention — a halt is usually declared *because* something is wrong, which is
 * exactly when an open position most needs its exit managed.
 *
 * So stopping is separated from going flat:
 *
 *  - `HALT_NEW_ENTRIES`    keep running, keep marking, take no new position.
 *  - `EXIT_ONLY`           as above, and actively work open positions out.
 *  - `TERMINATE_WHEN_FLAT` as above, and exit the process once none remain.
 *  - `EMERGENCY_RECONCILE` stop now regardless of exposure, and record that a
 *                          position may be unmanaged. Deliberately the loudest
 *                          and least convenient option.
 *
 * A bare halt file means `TERMINATE_WHEN_FLAT`: entries stop immediately, exits
 * continue, and the process leaves when it owes nothing. An operator who writes
 * `KILL` with no further thought gets the behaviour that cannot orphan money.
 * Abandoning a position requires typing the word EMERGENCY_RECONCILE.
 */
export const HALT_MODES = ['HALT_NEW_ENTRIES', 'EXIT_ONLY', 'TERMINATE_WHEN_FLAT', 'EMERGENCY_RECONCILE'] as const;
export type HaltMode = (typeof HALT_MODES)[number];

export interface Halt {
  readonly path: string;
  readonly mode: HaltMode;
  /** True when the file named no mode, or named one we do not recognise. */
  readonly defaulted: boolean;
  readonly rawLabel: string | null;
}

/** Safest interpretation of an unreadable or unlabelled halt file. */
const DEFAULT_MODE: HaltMode = 'TERMINATE_WHEN_FLAT';

function parseMode(body: string): { mode: HaltMode; defaulted: boolean; rawLabel: string | null } {
  // First non-empty, non-comment line, upper-cased. Bounded before use: the
  // file is operator input, and an unbounded read has no business reaching a
  // log line.
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));

  if (line === undefined) return { mode: DEFAULT_MODE, defaulted: true, rawLabel: null };

  const label = line.slice(0, 32).toUpperCase();
  const match = HALT_MODES.find((m) => m === label);
  return match === undefined
    ? { mode: DEFAULT_MODE, defaulted: true, rawLabel: label }
    : { mode: match, defaulted: false, rawLabel: label };
}

/**
 * Reads the halt state, if any.
 *
 * Any failure to READ an existing halt file still halts. A file we cannot parse
 * is not evidence that trading may continue; it is evidence that something is
 * wrong with the thing that tells us to stop.
 */
export function haltState(paths: readonly string[]): Halt | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let body = '';
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      return { path, mode: DEFAULT_MODE, defaulted: true, rawLabel: null };
    }
    const { mode, defaulted, rawLabel } = parseMode(body);
    return { path, mode, defaulted, rawLabel };
  }
  return null;
}

/** Whether this mode permits opening a new position. Nothing does. */
export function entriesAllowed(_mode: HaltMode): boolean {
  return false;
}

/** Whether the engine should keep working open positions toward an exit. */
export function exitManagementActive(mode: HaltMode): boolean {
  return mode !== 'EMERGENCY_RECONCILE';
}

/** Whether the process may leave, given what it still holds. */
export function mayTerminate(mode: HaltMode, openPositions: number): boolean {
  if (mode === 'EMERGENCY_RECONCILE') return true;
  if (mode === 'TERMINATE_WHEN_FLAT') return openPositions === 0;
  // HALT_NEW_ENTRIES and EXIT_ONLY keep the process alive so a human can watch.
  return false;
}
