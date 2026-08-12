#!/usr/bin/env node
/**
 * PreToolUse guard for Bash commands.
 *
 * Path-shaped rules live in settings.json under `permissions.deny`, which is
 * declarative and cannot fail silently. This hook exists only for the rules
 * that are shaped like command CONTENT, where a glob is trivially evaded:
 * `Bash(rm -rf *)` does not match `cd /tmp && rm -rf .`, but the regex below
 * does.
 *
 * Protocol: exit 2 with a permissionDecision on stdout blocks the call. Any
 * other exit code lets it through. A guard that crashes therefore fails OPEN,
 * so this file has no dependencies, no async work, and no I/O beyond stdin,
 * stderr and the decision log — the smallest surface that can still be wrong.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RULES = [
  // Irreversible history and filesystem operations.
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards uncommitted work'],
  [/\bgit\s+push\b[^\n]*\s(--force\b|-f\b)/, 'force push can overwrite published history'],
  [/\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*f/, 'git clean -f deletes untracked files irreversibly'],
  [/\bgit\s+branch\s+-D\b/, 'git branch -D deletes an unmerged branch'],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, 'recursive force delete'],
  [/\b(DROP|TRUNCATE)\s+TABLE\b/i, 'destructive SQL against the decision ledger'],
  [/\brm\b[^\n]*\.(db|db-wal|db-shm)\b/, 'deleting the decision ledger destroys the research corpus'],

  // Mainnet execution. These modes spend real funds and must be a human act.
  [/--mode=(canary|live)\b/, 'canary and live spend real funds — run this yourself'],
  [/\bpnpm\s+(run\s+)?(canary|live)\b/, 'canary and live spend real funds — run this yourself'],

  // The live acknowledgement is the last thing standing between the code and
  // the wallet. Creating it on the operator's behalf defeats its purpose.
  [/\.live-ack/, 'the live acknowledgement file must be created by a human, outside the repo'],

  // Secret disclosure.
  [/\b(cat|type|head|tail|less|more|bat)\b[^\n]*\.env\b/, 'reads secrets'],
  [/\b(printenv|env)\s*(\||$)/, 'prints the whole environment'],
  [/\becho\b[^\n]*\$\{?[A-Z_]*(KEY|SECRET|TOKEN|SEED|PRIVATE|MNEMONIC)/, 'prints a secret'],
  [/\b(cat|type|head|tail|xxd|od|base64)\b[^\n]*(keypair|\.key\b|\.pem\b|id\.json|wallet\.json)/, 'reads key material'],

  // Remote code execution.
  [/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/, 'piping a download into a shell'],
  [/\b(iwr|Invoke-WebRequest)\b[^\n]*\|[^\n]*iex\b/i, 'piping a download into a shell'],

  // Outbound upload of local data.
  [/\bcurl\b[^\n]*(-T|--upload-file|-F\s|--data-binary\s*@)/, 'uploads local files to a remote host'],
];

function log(decision, reason, tool) {
  try {
    const file = join(process.cwd(), 'data', 'hook-decisions.log');
    mkdirSync(dirname(file), { recursive: true });
    // The command itself is deliberately not logged: a blocked command is
    // frequently a command containing a secret.
    appendFileSync(file, `${new Date().toISOString()}\t${decision}\t${tool}\t${reason}\n`);
  } catch {
    // A guard that cannot write its log must still be able to guard.
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const tool = input.tool_name ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  for (const [pattern, reason] of RULES) {
    if (pattern.test(command)) {
      log('deny', reason, tool);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Blocked by project guard: ${reason}. See .claude/hooks/guard.mjs.`,
          },
        }),
      );
      process.exit(2);
    }
  }
  process.exit(0);
});
