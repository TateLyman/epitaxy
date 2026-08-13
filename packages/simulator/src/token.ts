import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The daemon's local auth token, read from where the supervisor put it.
 *
 * `ops/simulatord.ps1` generates it once and writes it to the user's profile
 * with an owner-only ACL. Every caller resolving it the same way means the
 * token never has to be pasted into a shell, an environment variable, a script
 * argument or a log line — all of which are places a credential ends up
 * readable by things that should not read it.
 *
 * Order: an explicit `SIMULATORD_TOKEN` wins, because CI and one-off runs need
 * to supply their own; otherwise the file; otherwise nothing, and the caller
 * fails on a 401 with a clear reason rather than on a confusing empty string.
 */
export const TOKEN_FILE = join(homedir(), '.epitaxy-simulatord-token');

export function resolveSimulatorToken(): { token: string; source: string } {
  const fromEnv = process.env['SIMULATORD_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return { token: fromEnv, source: 'SIMULATORD_TOKEN' };
  try {
    const fromFile = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (fromFile.length > 0) return { token: fromFile, source: TOKEN_FILE };
  } catch {
    /* reported below rather than thrown: an absent token is a setup fact */
  }
  return { token: '', source: 'not found' };
}
