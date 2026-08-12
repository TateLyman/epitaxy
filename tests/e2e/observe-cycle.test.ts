import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ProcessLock } from '../../packages/storage/src/db.js';
import type { Db } from '../../packages/storage/src/db.js';
import { loadConfig, signerAllowed } from '../../packages/domain/src/config.js';
import type { AppConfig, Secrets } from '../../packages/domain/src/config.js';
import { runCycle } from '../../packages/pipeline/src/cycle.js';
import { counters } from '../../packages/storage/src/repo.js';
import { replayAll, snapshotRows } from '../../packages/research/src/replay.js';
import { evaluateGates } from '../../packages/execution/src/gates.js';
import type { JupiterClient } from '../../packages/adapters/src/jupiter/client.js';
import type { MintInformation } from '../../packages/adapters/src/jupiter/schemas.js';

/**
 * End to end, observe mode.
 *
 * The unit tests each check one claim. This file checks the claim that matters
 * to an operator: that running the thing produces a durable, self-consistent
 * record and takes no position while doing it.
 *
 * The provider is a stub, but the pipeline, strategy, storage and replay are all
 * the real implementations. Nothing here touches the network — a test that
 * needed a live provider would fail for reasons unrelated to the code, and this
 * suite would stop being run.
 */

const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
let db: Db;
let config: AppConfig;
let n = 0;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked SQLite file on Windows is not a test failure.
  }
});

beforeEach(() => {
  db = openDb({ path: join(dir, `e2e-${n++}.db`) });
  config = loadConfig('observe');
});

const NOW = Date.now();

function token(i: number): MintInformation {
  return {
    id: `mint${String(i).padStart(4, '0')}`.padEnd(43, 'x'),
    name: `Token ${i}`,
    symbol: `TK${i}`,
    decimals: 9,
    dev: null,
    launchpad: 'test',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    liquidity: 1_000 + i * 3_000,
    holderCount: 100 + i * 40,
    organicScore: 40 + (i % 50),
    mcap: 300_000,
    fdv: 300_000,
    usdPrice: 0.0003,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 + (i % 20) },
    stats5m: { numBuys: 100 + i, numSells: 40, numTraders: 80 },
    createdAt: new Date(NOW - (10 + i) * 60_000).toISOString(),
    firstPool: null,
    updatedAt: null,
  } as unknown as MintInformation;
}

/**
 * A provider that answers discovery and refuses everything else. Any method a
 * cycle reaches for that is not stubbed throws, so "observe did not request a
 * quote" is asserted by construction rather than by reading the code.
 */
function stubJupiter(tokens: MintInformation[]): JupiterClient {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  return {
    recentTokens: async () => ({ tokens, latencyMs: 12, payloadHash: 'stub' }),
    // Enrichment of matured mints. Returning [] here would leave the queue with
    // nothing to screen and every assertion about screening would pass
    // vacuously, which is how the first version of this stub was wrong.
    search: async (mints: readonly string[]) => mints.flatMap((m) => {
      const hit = byId.get(m);
      return hit ? [hit] : [];
    }),
    category: async () => [],
    prices: async () => ({}),
    quote: async () => {
      throw new Error('observe must never request a signable quote');
    },
    // tryQuote never resolves to null — it always resolves to
    // { quote, providerFailure }, and cycle.ts dereferences that object
    // unguarded. Returning null here logged 'round trip failed' for every
    // mint, which read as a production defect and was a defect in this stub.
    tryQuote: async () => ({ quote: null, providerFailure: null }),
  } as unknown as JupiterClient;
}

async function cycle(tokens: MintInformation[], onEligible = (): void => {}): Promise<ReturnType<typeof runCycle>> {
  return runCycle({
    db,
    jupiter: stubJupiter(tokens),
    config,
    seen: new Set<string>(),
    cycleIndex: 1,
    rpc: null,
    onEligible,
  });
}

describe('a cycle turns discovery into a durable record', () => {
  it('banks every discovered token as a candidate', async () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(i));
    const stats = await cycle(tokens);

    expect(stats.discovered).toBe(20);
    expect(stats.newCandidates).toBe(20);
    expect(counters(db).candidates).toBe(20);
  });

  it('records a screening for every token it screened, rejects included', async () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(i));
    const stats = await cycle(tokens);

    // The rejects are the product. A pipeline that only stored its winners
    // could never answer whether a filter earned its place.
    expect(counters(db).screenings).toBe(stats.screened);
    expect(stats.screened).toBeGreaterThan(0);
  });

  it('writes a snapshot for every screening, so every decision can be re-derived', async () => {
    await cycle(Array.from({ length: 20 }, (_, i) => token(i)));

    const screenings = (db.prepare('SELECT COUNT(*) AS n FROM screenings').get() as { n: number }).n;
    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM screenings c
           LEFT JOIN decision_snapshots s ON s.snapshot_id = c.snapshot_id
           WHERE s.snapshot_id IS NULL`,
        )
        .get() as { n: number }
    ).n;

    expect(screenings).toBeGreaterThan(0);
    expect(orphans).toBe(0);
  });

  it('does not re-bank a token it has already seen', async () => {
    const tokens = Array.from({ length: 10 }, (_, i) => token(i));
    const seen = new Set<string>();
    const run = async (): Promise<void> => {
      await runCycle({
        db,
        jupiter: stubJupiter(tokens),
        config,
        seen,
        cycleIndex: 1,
        rpc: null,
        onEligible: () => {},
      });
    };
    await run();
    await run();

    expect(counters(db).candidates).toBe(10);
  });
});

describe('what a cycle produces can be replayed', () => {
  it('replays its own output with no divergence', async () => {
    await cycle(Array.from({ length: 30 }, (_, i) => token(i)));

    const summary = replayAll(db, config, snapshotRows(db, 500));
    expect(summary.replayed).toBeGreaterThan(0);
    expect(summary.threw).toBe(0);
    expect(summary.divergentSnapshots).toBe(0);
  });
});

describe('observe mode cannot take a position', () => {
  it('is structurally forbidden a signer', () => {
    expect(signerAllowed('observe')).toBe(false);
    expect(signerAllowed('paper')).toBe(false);
    expect(signerAllowed('canary')).toBe(true);
    expect(signerAllowed('live')).toBe(true);
  });

  /**
   * The strongest available statement about a mode that must never trade: after
   * a full cycle, the tables that represent capital at risk are empty. This is
   * checked against the database rather than against the code path, so a future
   * refactor that introduced a write would fail here even if it looked correct.
   */
  it('leaves every capital-bearing table empty after a full cycle', async () => {
    await cycle(Array.from({ length: 30 }, (_, i) => token(i)));

    for (const table of ['intents', 'execution_attempts', 'positions', 'fills']) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(`${table}=${n}`).toBe(`${table}=0`);
    }
  });

  it('throws rather than quoting, if a cycle ever asks for a signable quote', async () => {
    // Proves the stub above is load-bearing: the assertion in the other tests
    // rests on this method being reachable and fatal.
    await expect(stubJupiter([]).quote({} as never)).rejects.toThrow(/never request a signable quote/);
  });
});

describe('the gates refuse promotion on the evidence a fresh run has', () => {
  const secrets: Secrets = {
    heliusApiKey: null,
    jupiterApiKey: null,
    goplusToken: null,
    rpcHttp: null,
    rpcWs: null,
    rpcHttpFallback: null,
    rpcHttpDerivedFromHeliusKey: false,
    tradingKeypairPath: null,
    liveAckPath: null,
    databasePath: ':memory:',
    dataDir: './data',
  };

  it('refuses canary on an empty database and names each missing observation', async () => {
    await cycle(Array.from({ length: 20 }, (_, i) => token(i)));
    const canaryConfig = loadConfig('canary');

    const results = evaluateGates('canary', canaryConfig, secrets, db);
    const failed = results.filter((r) => !r.passed).map((r) => r.name);

    expect(failed).toContain('signer.keypair');
    expect(failed).toContain('rpc.primary');
    expect(failed).toContain('evidence.paperPositions');
    // Every failure carries both what was seen and what was needed, so the
    // refusal is auditable rather than an opinion.
    for (const r of results.filter((x) => !x.passed)) {
      expect(r.observed.length).toBeGreaterThan(0);
      expect(r.required.length).toBeGreaterThan(0);
    }
  });

  it('never returns an all-pass verdict for live without an acknowledgement file', () => {
    const liveConfig = loadConfig('live');
    const results = evaluateGates('live', liveConfig, secrets, db);
    expect(results.every((r) => r.passed)).toBe(false);
    expect(results.map((r) => r.name)).toContain('live.acknowledgement');
  });
});

describe('two engines cannot run against one database', () => {
  /**
   * The lock guards against a SECOND PROCESS, so the test has to present one.
   * A second ProcessLock inside this process is deliberately allowed through —
   * the guard compares pids, so an in-process second instance would prove
   * nothing. The row is written directly with a foreign pid and a live
   * heartbeat, which is exactly what another running engine looks like.
   */
  function foreignHolder(heartbeatAgeMs: number): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO process_locks (lock_name, pid, hostname, acquired_utc_ms, heartbeat_utc_ms, mode)
       VALUES ('engine', ?, 'other-host', ?, ?, 'observe')
       ON CONFLICT(lock_name) DO UPDATE SET pid=excluded.pid, heartbeat_utc_ms=excluded.heartbeat_utc_ms`,
    ).run(process.pid + 1, now, now - heartbeatAgeMs);
  }

  it('refuses to start while another process is heartbeating', () => {
    foreignHolder(1_000);

    const held = new ProcessLock(db, 'engine', 'observe').acquire();
    expect(held.ok).toBe(false);
    if (!held.ok) {
      expect(held.heldBy).toBe(process.pid + 1);
      expect(held.ageMs).toBeGreaterThanOrEqual(1_000);
    }
  });

  /**
   * The other half of the same decision: a lock whose holder stopped
   * heartbeating must not wedge the system forever. A crashed engine leaves its
   * row behind, and refusing to start because of a dead process would turn a
   * crash into an outage.
   */
  it('takes over a lock whose holder has stopped heartbeating', () => {
    foreignHolder(120_000);
    expect(new ProcessLock(db, 'engine', 'observe').acquire().ok).toBe(true);
  });
});
