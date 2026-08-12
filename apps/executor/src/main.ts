import { loadConfig, loadSecrets, signerAllowed } from '../../../packages/domain/src/config.js';
import type { Mode } from '../../../packages/domain/src/types.js';
import { openDb, ProcessLock } from '../../../packages/storage/src/db.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../../../packages/execution/src/rpc.js';
import { Signer } from '../../../packages/execution/src/signer.js';
import { evaluateGates } from '../../../packages/execution/src/gates.js';
import { resolveOutstanding, type ExecutorDeps } from '../../../packages/execution/src/machine.js';
import { logger } from '../../../packages/observability/src/log.js';

/**
 * Canary and live entry point.
 *
 * This process is gated OFF, and "gated off" here means something specific: not
 * that the code is commented out or behind a flag someone can flip, but that
 * the gates are evaluated against the actual database on every start and the
 * process exits when the evidence is not there. As of this writing the evidence
 * is not there, and running this command prints exactly which observations are
 * missing rather than a refusal with no content.
 *
 * The distinction matters because a disabled feature tends to rot. This path is
 * exercised every time someone runs it; what stops it is a measurement.
 */

const log = logger.child({ app: 'executor' });

function requestedMode(): Mode {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  const mode = arg?.slice('--mode='.length);
  if (mode !== 'canary' && mode !== 'live') {
    throw new Error(`executor requires --mode=canary or --mode=live; got ${mode ?? 'nothing'}`);
  }
  return mode;
}

async function main(): Promise<void> {
  const mode = requestedMode();
  const config = loadConfig(mode);
  const secrets = loadSecrets();

  // loadConfig(mode) refuses a config file whose declared mode differs from the
  // one requested, so reaching here means the command line and config/<mode>.json
  // agree — nobody is running live with a canary's risk limits.
  if (!signerAllowed(config.mode)) {
    throw new Error(`internal invariant violated: mode ${config.mode} reached the executor`);
  }

  const db = openDb({ path: secrets.databasePath });

  const gates = evaluateGates(mode, config, secrets, db);
  const failed = gates.filter((g) => !g.passed);
  console.log(`\ndeployment gates for ${mode}\n${'='.repeat(26 + mode.length)}`);
  for (const g of gates) {
    console.log(`${g.passed ? 'PASS' : 'HOLD'} ${g.name.padEnd(28)} ${g.observed}`);
    if (!g.passed) console.log(`     ${' '.repeat(28)} required: ${g.required}`);
  }
  console.log(`\n${gates.length} gates, ${failed.length} not met`);

  if (failed.length > 0) {
    console.error(
      `\n${mode} is not permitted to start. The gates above are the reason, and each one is a\n` +
        'measurement rather than an opinion. Nothing was signed and no key was loaded.',
    );
    process.exitCode = 1;
    return;
  }

  // Beyond this line the process can move real money.
  const lock = new ProcessLock(db, 'executor', mode);
  const held = lock.acquire();
  if (!held.ok) {
    throw new Error(`another executor holds the lock (pid=${held.heldBy}, heartbeat ${held.ageMs}ms ago)`);
  }

  if (secrets.tradingKeypairPath === null) {
    throw new Error('gates passed without a keypair path; refusing to continue');
  }
  const signer = Signer.fromFile(secrets.tradingKeypairPath);
  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback });

  const deps: ExecutorDeps = {
    db,
    rpc,
    signer,
    limiter,
    jupiterApiKey: secrets.jupiterApiKey,
    slippageBps: config.risk.maxSlippageBps,
    maxAttemptsPerIntent: 1,
    confirmTimeoutMs: 90_000,
    log: (event) => log.info(event),
  };

  log.warn(
    { mode, wallet: signer.publicKey, strategyVersion: config.strategyVersion },
    'executor starting — REAL FUNDS ARE AT RISK',
  );

  // Anything left in flight from a previous run is settled before a single new
  // decision is made. Trading on top of an unknown balance is how one bad
  // transaction becomes a bad afternoon.
  const stillUnresolved = await resolveOutstanding(deps);
  if (stillUnresolved > 0) {
    log.error({ stillUnresolved }, 'refusing to trade with attempts of unknown fate; run pnpm reconcile');
    process.exitCode = 1;
    return;
  }

  log.info({ wallet: signer.publicKey }, 'no outstanding attempts; execution loop is not yet wired to the strategy');
  // The entry/exit loop lands here once canary has proven the signable path.
  // It is absent rather than stubbed: a stub that appears to trade and does
  // not is worse than a gap that is visible.
  process.exitCode = 0;
}

void main().catch((e: unknown) => {
  log.error({ err: (e as Error).message }, 'executor failed to start');
  process.exitCode = 1;
});
