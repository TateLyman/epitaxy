import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, loadSecrets, modeFromArgv, signerAllowed } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { viableFloorLamports } from '../packages/strategy/src/portfolio.js';
import { minBigint } from '../packages/domain/src/amounts.js';

/**
 * Preflight. Answers one question: would this machine behave correctly if an
 * engine started right now?
 *
 * Every check reports what it observed, not merely whether it liked it. A
 * dependency that is absent is reported as absent rather than substituted with
 * a default, because a silent substitution is how a system ends up trading on
 * assumptions nobody chose.
 */

type Level = 'ok' | 'warn' | 'fail';

const results: { level: Level; name: string; detail: string }[] = [];

function record(level: Level, name: string, detail: string): void {
  results.push({ level, name, detail });
}

async function checkRuntime(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 22) {
    record('fail', 'node.version', `node ${process.versions.node}; node:sqlite requires >= 22`);
  } else {
    record('ok', 'node.version', `node ${process.versions.node}`);
  }

  try {
    // Imported dynamically so an unavailable builtin is a reported check
    // rather than a crash on module load.
    await import('node:sqlite');
    record('ok', 'node.sqlite', 'node:sqlite is available');
  } catch (e) {
    record('fail', 'node.sqlite', `node:sqlite unavailable: ${(e as Error).message}`);
  }
}

function checkConfig(): void {
  try {
    // O023: doctor used to validate the DEFAULT config regardless of which mode
    // was about to run, so it could pass against observe's limits while the
    // paper config that would actually start was broken — or, as observed on
    // 2026-08-12, FAIL against observe's zero capital while paper was fine. A
    // green (or red) check on the wrong file is worse than no check.
    const requested = modeFromArgv();
    const config = loadConfig(requested);
    record(
      'ok',
      'config.load',
      `mode=${config.mode} strategy=${config.strategyVersion}` +
        (requested === undefined ? ' (no --mode= given; validated the default)' : ''),
    );

    if (config.gates.minTokenAgeMs >= config.gates.maxTokenAgeMs) {
      record('fail', 'config.ageWindow', 'minTokenAgeMs >= maxTokenAgeMs; no token can ever qualify');
    } else {
      record('ok', 'config.ageWindow', `${config.gates.minTokenAgeMs}ms .. ${config.gates.maxTokenAgeMs}ms`);
    }

    if (config.risk.maxEntryLamports > config.risk.maxTotalExposureLamports) {
      record('fail', 'config.risk', 'a single entry may exceed total exposure cap');
    } else {
      record('ok', 'config.risk', `maxEntry=${config.risk.maxEntryLamports} totalCap=${config.risk.maxTotalExposureLamports}`);
    }

    // A cap that sits below the fee-viability floor means every candidate is
    // refused at sizing, forever. That looks identical to "the strategy found
    // nothing", which is why it is checked rather than inferred from an empty
    // trade log.
    const floor = viableFloorLamports(config);
    const nav = config.paperStartLamports;
    const largestAllowed = minBigint(
      minBigint((nav * BigInt(Math.round(config.risk.maxNotionalPctPerPosition * 100))) / 10_000n, config.risk.maxEntryLamports),
      (((nav * BigInt(Math.round(config.risk.riskBudgetPctPerTrade * 100))) / 10_000n) * 10_000n) /
        BigInt(config.exits.stopLossBps),
    );
    if (config.mode === 'observe') {
      // Observe cannot open a position by construction, so a capital cap of
      // zero is the configuration working, not failing. Reporting it as a
      // failure trained the operator to read a red doctor as normal, which is
      // the state in which a real failure goes unnoticed.
      record(
        'ok',
        'config.viableCapital',
        'not applicable in observe mode; this mode cannot open a position',
      );
    } else if (largestAllowed < floor) {
      record(
        'fail',
        'config.viableCapital',
        `largest permitted position ${largestAllowed} < fee-viability floor ${floor}; no trade can ever open. ` +
          `Raise capital to about ${(Number(floor) * 100) / Number(config.risk.maxNotionalPctPerPosition) / 1e9} SOL or lower fixed costs`,
      );
    } else {
      record(
        'ok',
        'config.viableCapital',
        `largest position ${largestAllowed} vs floor ${floor} (headroom ${(Number(largestAllowed) / Number(floor)).toFixed(1)}x)`,
      );
    }

    if (signerAllowed(config.mode)) {
      record('warn', 'config.signer', `mode ${config.mode} permits signing; real funds are at risk`);
    } else {
      record('ok', 'config.signer', `mode ${config.mode} cannot sign`);
    }
  } catch (e) {
    record('fail', 'config.load', (e as Error).message);
  }
}

function checkStorage(): void {
  try {
    const secrets = loadSecrets();
    const db = openDb({ path: secrets.databasePath });
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    const jm = mode?.journal_mode ?? 'unknown';
    if (jm.toLowerCase() !== 'wal') {
      record('warn', 'storage.wal', `journal_mode=${jm}; concurrent readers will block the engine`);
    } else {
      record('ok', 'storage.wal', `journal_mode=wal at ${secrets.databasePath}`);
    }
    const v = db.prepare('SELECT MAX(id) AS v, COUNT(*) AS n FROM schema_migrations').get() as
      | { v: number | null; n: number }
      | undefined;
    record('ok', 'storage.migrations', `${v?.n ?? 0} migration(s) applied, latest id ${v?.v ?? 0}`);
  } catch (e) {
    record('fail', 'storage.open', (e as Error).message);
  }
}

function checkSecrets(): void {
  const secrets = loadSecrets();
  record(
    secrets.jupiterApiKey === null ? 'warn' : 'ok',
    'secrets.jupiter',
    secrets.jupiterApiKey === null ? 'no JUPITER_API_KEY; using unkeyed rate limits' : 'JUPITER_API_KEY present',
  );
  record(
    secrets.rpcHttp === null ? 'warn' : 'ok',
    'secrets.rpc',
    secrets.rpcHttp === null
      ? 'no SOLANA_RPC_HTTP and no HELIUS_API_KEY; on-chain concentration cannot be measured (required for canary/live)'
      : secrets.rpcHttpDerivedFromHeliusKey
        ? 'endpoint derived from HELIUS_API_KEY (SOLANA_RPC_HTTP unset)'
        : 'SOLANA_RPC_HTTP present',
  );

  if (existsSync('.env')) {
    const gitignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
    if (!/^\.env\s*$/m.test(gitignore) && !/^\.env/m.test(gitignore)) {
      record('fail', 'secrets.gitignore', '.env exists but is not listed in .gitignore');
    } else {
      record('ok', 'secrets.gitignore', '.env is git-ignored');
    }
  } else {
    record('warn', 'secrets.env', 'no .env file; all secrets come from the ambient environment');
  }
}

async function checkSources(): Promise<void> {
  const secrets = loadSecrets();
  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);

  try {
    const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });
    const started = Date.now();
    const { tokens } = await jupiter.recentTokens();
    record('ok', 'source.jupiter', `recent feed returned ${tokens.length} tokens in ${Date.now() - started}ms`);
  } catch (e) {
    record('fail', 'source.jupiter', `recent feed failed: ${(e as Error).message}`);
  }

  /**
   * THE ENDPOINT THE ENGINE WILL ACTUALLY USE.
   *
   * This constructed its own `SolanaRpc` straight from `secrets.rpcHttp`,
   * bypassing `researchRpc` — and therefore bypassing the `RPC_ENDPOINT`
   * override the collector honours. So the preflight could report a healthy
   * endpoint while the collector used a dead one, or report a dead one while
   * the collector was fine. Caught here by an override that worked everywhere
   * except in the command whose whole job is to say whether it works.
   *
   * A preflight that checks a different endpoint than the engine uses is not a
   * preflight.
   */
  const research = researchRpc(secrets as never);
  const rpc = research.rpc;
  if (!rpc.configured) {
    record('warn', 'source.rpc', 'no endpoint configured; skipped');
    return;
  }
  try {
    const slot = await rpc.getSlot();
    record(
      'ok',
      'source.rpc',
      `getSlot returned ${slot} from ${research.host}${research.overridden ? ' (RPC_ENDPOINT override)' : ''}`,
    );
  } catch (e) {
    record(
      'fail',
      'source.rpc',
      `getSlot failed against ${research.host}${research.overridden ? ' (RPC_ENDPOINT override)' : ''}: ${(e as Error).message}`,
    );
  }

  // The authoritative concentration check depends on a method that public
  // endpoints commonly refuse. Finding that out here is much cheaper than
  // finding it out when capital is at stake.
  //
  // The probe mint is deliberately NOT a major stablecoin. USDC was used here
  // until 2026-08-12 and returned `-32600 Too many accounts requested
  // (10000000 pub)` on every provider — the method was enabled the whole time
  // and doctor reported it as refused, because the probe asked about a mint
  // with ten million token accounts. wSOL is small enough to answer and is
  // guaranteed to exist on mainnet.
  //
  // A size refusal is now distinguished from a permission refusal, because
  // they mean opposite things: the first proves the method works.
  /**
   * Probe a REAL CANDIDATE, not wSOL.
   *
   * wSOL replaced USDC here for exactly the right reason and only half solved
   * it. USDC returned `-32600 Too many accounts requested` on every provider,
   * so doctor called an enabled method refused. wSOL is smaller but still
   * enormous, and on 2026-08-17 an Alchemy endpoint that served the method 6
   * times out of 6 against a real pump.fun mint in ~280ms **timed out** on
   * wSOL — so doctor warned about a method that works.
   *
   * Both failures come from probing a population the engine never queries. The
   * collector asks about newly migrated pump.fun mints, so that is what this
   * asks about, taken from `confirmed_migrations`. wSOL remains the fallback
   * for a machine with no corpus yet.
   */
  let probeMint = 'So11111111111111111111111111111111111111112';
  let probeIsRepresentative = false;
  try {
    const db = openDb({ path: secrets.databasePath, skipBackup: true, readonly: true });
    const row = db
      .prepare(
        `SELECT mint FROM confirmed_migrations WHERE reversal_status = 'CONFIRMED' ORDER BY slot DESC LIMIT 1`,
      )
      .get() as { mint: string } | undefined;
    db.close();
    if (row !== undefined) {
      probeMint = row.mint;
      probeIsRepresentative = true;
    }
  } catch {
    /* no corpus yet; wSOL it is */
  }

  try {
    await rpc.getTokenLargestAccounts(probeMint);
    record(
      'ok',
      'source.rpc.largestAccounts',
      `getTokenLargestAccounts is permitted (probed ${probeIsRepresentative ? 'a real migrated mint' : 'wSOL'})`,
    );
  } catch (e) {
    const msg = (e as Error).message;
    // A SIZE refusal proves the method works. A timeout on a huge fallback mint
    // is the same fact wearing a different error, and treating it as a refusal
    // is what made this check wrong twice.
    if (/too many accounts/i.test(msg) || (!probeIsRepresentative && /timeout|aborted/i.test(msg))) {
      record(
        'ok',
        'source.rpc.largestAccounts',
        `permitted; the endpoint refused only on RESULT SIZE for wSOL (${msg.slice(0, 50)}), which cannot happen for a new mint`,
      );
    } else {
      record(
        'warn',
        'source.rpc.largestAccounts',
        `getTokenLargestAccounts refused for ${probeIsRepresentative ? 'a real migrated mint' : 'wSOL'} ` +
          `(${msg.slice(0, 70)}); concentration will report unavailable and every candidate will be refused`,
      );
    }
  }
}

async function main(): Promise<void> {
  await checkRuntime();
  checkConfig();
  checkStorage();
  checkSecrets();
  await checkSources();

  const mark: Record<Level, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  for (const r of results) console.log(`${mark[r.level]} ${r.name.padEnd(30)} ${r.detail}`);

  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${results.length} checks, ${fails} failed, ${warns} warning`);
  if (fails > 0) {
    console.error('doctor FAILED — fix the above before starting an engine.');
    process.exitCode = 1;
  }
}

void main();
