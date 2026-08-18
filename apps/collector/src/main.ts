import {
  loadConfig,
  loadSecrets,
  signerAllowed,
  killSwitchEngaged,
  modeFromArgv,
} from '../../../packages/domain/src/config.js';
import { openDb, ProcessLock } from '../../../packages/storage/src/db.js';
import { counters, recordHealth, recordSourceHealth, rejectionBreakdown } from '../../../packages/storage/src/repo.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { JupiterClient } from '../../../packages/adapters/src/jupiter/client.js';
import { SourceFetchError } from '../../../packages/adapters/src/http.js';
import { researchRpc } from '../../../packages/solana/src/endpoint.js';
import { SolanaRpc } from '../../../packages/solana/src/rpc.js';
import { emptyStats, runCycle } from '../../../packages/pipeline/src/cycle.js';
import { tokenAgeMs } from '../../../packages/strategy/src/screen.js';
import { logger, sanitizeExternal } from '../../../packages/observability/src/log.js';

/**
 * Observe mode.
 *
 * Discovers, screens, and RECORDS. It never opens a position, never constructs
 * a signer, and never calls a Jupiter endpoint that can return a signable
 * transaction (quotes are requested without `taker`).
 *
 * Its product is a dataset: every candidate, every gate decision, and — the
 * part that actually matters — every REJECT, so that later analysis can ask
 * whether each filter earned its place or merely felt prudent.
 */

const log = logger.child({ app: 'collector' });

/**
 * The current epoch, cached for an epoch's worth of time.
 *
 * Refreshed on a timer rather than per cycle: an epoch is roughly two days and
 * asking every ten seconds spends a call to learn a number that did not move.
 * Null when it could not be read, and null means the fee decoder takes the
 * worst of the mint's two schedules — the safe direction.
 */
let cachedEpoch: { value: bigint; readUtcMs: number } | null = null;
async function currentEpochOf(rpc: { configured: boolean; getEpoch(): Promise<bigint> }): Promise<bigint | null> {
  if (!rpc.configured) return null;
  const now = Date.now();
  if (cachedEpoch !== null && now - cachedEpoch.readUtcMs < 30 * 60_000) return cachedEpoch.value;
  try {
    const value = await rpc.getEpoch();
    cachedEpoch = { value, readUtcMs: now };
    return value;
  } catch {
    return cachedEpoch?.value ?? null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(modeFromArgv());
  const secrets = loadSecrets();

  if (config.mode !== 'observe') {
    throw new Error(`collector runs only in observe mode; got "${config.mode}"`);
  }
  if (signerAllowed(config.mode)) {
    throw new Error('internal invariant violated: signer must never be permitted in observe mode');
  }

  const db = openDb({ path: secrets.databasePath });
  const lock = new ProcessLock(db, 'collector', config.mode);
  const held = lock.acquire();
  if (!held.ok) {
    throw new Error(
      `another collector holds the lock (pid=${held.heldBy}, heartbeat ${held.ageMs}ms ago). ` +
        `Two collectors would double-count discovery and waste the shared quote budget.`,
    );
  }

  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const jupiter = new JupiterClient({ limiter, apiKey: secrets.jupiterApiKey });
  /**
   * THROUGH `researchRpc`, which is the module written to stop exactly this.
   *
   * This constructed `new SolanaRpc(limiter, {primary: secrets.rpcHttp, …})`
   * directly and so never read `RPC_ENDPOINT` — the override every other
   * research entry point honours. `researchRpc`'s own comment names the
   * failure: "three scripts grew an RPC_ENDPOINT override and three did not,
   * and the ones that did not silently kept using the configured provider".
   * This was one of the three that did not.
   *
   * The two halves of one system are supposed to read one chain. An operator
   * who points the trajectory collector at a working endpoint and leaves the
   * screening collector on an exhausted one gets a trajectory window with no
   * candidate supply and a screening log full of "max usage reached", and
   * nothing connects the two.
   *
   * `researchRpc` THROWS when no endpoint resolves, and observe is designed to
   * degrade without one — `runCycle` takes `rpc.configured ? rpc : null` and
   * screens on provider data alone. Turning a supported degraded mode into a
   * hard stop would be a different change from the one this is, so the absent
   * case keeps the old unconfigured client and says so.
   */
  const resolved =
    // S079 — the screening collector shares the endpoint budget with the
    // trajectory collector. It was the larger of the two spenders and neither
    // could see the other's calls.
    (process.env['RPC_ENDPOINT'] ?? secrets.rpcHttp) === null ? null : researchRpc(secrets as never, db);
  const rpc = resolved?.rpc ?? new SolanaRpc(limiter, { primary: null, fallback: null });
  const host = resolved?.host ?? 'none configured';
  const overridden = resolved?.overridden ?? false;

  log.info(
    {
      mode: config.mode,
      strategyVersion: config.strategyVersion,
      discoveryIntervalMs: config.discoveryIntervalMs,
      maxQuotesPerCycle: config.maxQuotesPerCycle,
      keyed: secrets.jupiterApiKey !== null,
      db: secrets.databasePath,
      // Host only: the configured endpoints carry API keys in their query strings.
      rpcHost: host,
      rpcOverridden: overridden,
    },
    'observe mode starting',
  );

  let stop = false;
  const shutdown = (signal: string): void => {
    if (stop) return;
    stop = true;
    log.info({ signal }, 'shutdown requested');
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const seen = new Set<string>();
  let cycle = 0;

  while (!stop) {
    const started = Date.now();
    cycle += 1;
    let stats = emptyStats();

    // Observe mode cannot spend money, but it does consume provider quota and
    // write to the shared database, so the same switch stops it.
    const killed = killSwitchEngaged();
    if (killed !== null) {
      recordHealth(db, 'kill_switch', 'critical', `KILL file at ${killed}`);
      log.error({ path: killed }, 'KILL file present — stopping');
      break;
    }

    try {
      stats = await runCycle({
        db,
        jupiter,
        config,
        seen,
        cycleIndex: cycle,
        rpc: rpc.configured ? rpc : null,
        currentEpoch: await currentEpochOf(rpc),
        onEligible: (info, result) => {
          log.info(
            {
              mint: info.id,
              symbol: sanitizeExternal(info.symbol ?? '', 16),
              score: result.outcome.opportunityScore,
              softRisk: result.outcome.softRiskScore,
              roundTripLossBps: result.roundTrip?.roundTripLossBps ?? null,
              ageMs: tokenAgeMs(info, result.outcome.evaluatedUtcMs),
              liquidityUsd: info.liquidity ?? null,
            },
            'ELIGIBLE (observe only — no position taken)',
          );
        },
      });
    } catch (e) {
      const err = e as Error;
      if (e instanceof SourceFetchError) {
        recordSourceHealth(db, e.source, false, null, e.kind);
        log.warn({ source: e.source, kind: e.kind, msg: e.message }, 'discovery failed');
      } else {
        recordHealth(db, 'cycle_error', 'warn', err.message);
        log.error({ err: err.message }, 'cycle error');
      }
    }

    lock.heartbeat();

    const c = counters(db);
    log.info(
      {
        cycle,
        ...stats,
        totalCandidates: c.candidates,
        totalScreenings: c.screenings,
        totalEligible: c.eligible,
        totalQuotes: c.quotes,
        elapsedMs: Date.now() - started,
      },
      'cycle complete',
    );

    if (cycle % 10 === 0) printBreakdown(db);

    await sleep(Math.max(1_000, config.discoveryIntervalMs - (Date.now() - started)), () => stop);
  }

  printBreakdown(db);
  lock.release();
  db.close();
  log.info('observe mode stopped cleanly');
}

function printBreakdown(db: ReturnType<typeof openDb>): void {
  const rows = rejectionBreakdown(db).slice(0, 12);
  if (rows.length === 0) return;
  log.info({ top: rows.map((r) => `${r.reason}=${r.count}`).join(' ') }, 'rejection breakdown');
}

export function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const tick = (): void => {
      if (cancelled() || waited >= ms) {
        resolve();
        return;
      }
      waited += step;
      setTimeout(tick, Math.min(step, ms - waited + step));
    };
    tick();
  });
}

main().catch((e: Error) => {
  log.error({ err: e.message, stack: e.stack }, 'collector fatal');
  process.exitCode = 1;
});
