import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Refuses to let a credential reach the repository.
 *
 * This runs as part of `pnpm check`, before anything is committed. It is
 * deliberately biased toward false positives: a spurious failure costs a few
 * seconds, whereas a leaked signer key costs the whole wallet. Findings are
 * reported by location and rule only — the matched text is never printed,
 * because a scanner that echoes secrets into CI logs has merely moved the leak.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'data', '.vscode']);
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sh', '.env', '.txt', '.csv']);

interface Rule {
  readonly id: string;
  readonly re: RegExp;
  readonly why: string;
}

const RULES: Rule[] = [
  // A 64-byte ed25519 secret key as exported by the Solana CLI: a JSON array of
  // 64 small integers. This is the single highest-severity pattern in a Solana
  // repository, since it IS the wallet.
  { id: 'solana_keypair_array', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/, why: 'looks like a 64-byte ed25519 secret key array' },
  { id: 'base58_secret_key', re: /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/, why: 'base58 string long enough to be a 64-byte secret key' },
  { id: 'private_key_pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: 'PEM private key block' },
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key id' },
  { id: 'generic_api_key_assignment', re: /(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, why: 'hardcoded credential assignment' },
  { id: 'helius_url_with_key', re: /https?:\/\/[^\s'"]*helius[^\s'"]*api[_-]?key=[A-Za-z0-9-]{8,}/i, why: 'RPC URL with an embedded api key' },
  { id: 'rpc_url_with_key', re: /https?:\/\/[^\s'"]+\/(?:v\d\/)?[0-9a-f]{32}\b/i, why: 'RPC URL with an embedded key path segment' },
  { id: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9_\-.]{24,}/, why: 'hardcoded bearer token' },
];

/**
 * Lines that intentionally describe a secret's shape — rule definitions, docs,
 * and placeholders — are not themselves secrets. The allowance is narrow and
 * explicit so it cannot quietly cover real code.
 */
const ALLOW = [
  /pragma:\s*allowlist[- ]secret/i,
  /^\s*\{\s*id:\s*'/,           // a rule definition in this file
  /YOUR_[A-Z_]+_HERE/,
  /<[a-z-]+>/i,                  // <your-key> style placeholders
  /example|placeholder|dummy|redacted|xxxx/i,
];

/**
 * A 64-byte ed25519 signature and a 64-byte ed25519 secret key are the same
 * length and the same alphabet, so no pattern can tell them apart. The only
 * honest discriminator is context, so the exception is scoped to exactly one:
 * a `signature` field inside a captured mainnet fixture, which by construction
 * holds already-public, already-confirmed transaction data.
 *
 * Deliberately narrow. It does not apply outside tests/fixtures, and it does
 * not apply to any other field name.
 */
function isPublicFixtureSignature(file: string, line: string): boolean {
  const normalized = file.split(sep).join('/');
  return normalized.startsWith('tests/fixtures/') && /^\s*"signature":\s*"[1-9A-HJ-NP-Za-km-z]+",?\s*$/.test(line);
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly why: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.size < 2_000_000) {
      const dot = name.lastIndexOf('.');
      const ext = dot === -1 ? '' : name.slice(dot);
      if (SCAN_EXT.has(ext) || name.startsWith('.env')) out.push(full);
    }
  }
  return out;
}

function scan(file: string): Finding[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const findings: Finding[] = [];
  const rel = relative(process.cwd(), file);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (ALLOW.some((a) => a.test(line))) continue;
    if (isPublicFixtureSignature(rel, line)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push({ file: relative(process.cwd(), file), line: i + 1, rule: rule.id, why: rule.why });
      }
    }
  }
  return findings;
}

function gitTracked(): Set<string> {
  try {
    const out = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 20_000_000 });
    return new Set(out.split(/\r?\n/).filter(Boolean).map((p) => p.split('/').join(sep)));
  } catch {
    return new Set();
  }
}

function main(): void {
  const files = walk(process.cwd());
  const findings = files.flatMap(scan);

  // A .env that git is tracking is a leak regardless of its contents today,
  // because the next credential written into it is committed automatically.
  const tracked = gitTracked();
  const trackedEnv = [...tracked].filter((p) => {
    const base = p.split(sep).pop() ?? '';
    return base.startsWith('.env') && base !== '.env.example';
  });

  for (const f of findings) {
    console.error(`LEAK  ${f.file}:${f.line}  [${f.rule}] ${f.why}`);
  }
  for (const p of trackedEnv) {
    console.error(`LEAK  ${p}  [tracked_env_file] an env file is tracked by git; it must be ignored`);
  }

  const total = findings.length + trackedEnv.length;
  console.log(`\nscanned ${files.length} files, ${total} finding(s)`);

  if (total > 0) {
    console.error('\nsecretscan FAILED. Remove the credential, rotate it, and re-run.');
    process.exitCode = 1;
  } else {
    console.log('secretscan clean');
  }
}

main();
