import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import {
  openCollectorSession,
  closeCollectorSession,
  heartbeat,
  countResource,
  recordSubscription,
  recordUnsubscribe,
  queueUrgentMark,
  pendingUrgent,
  consumeUrgent,
  sessionSpans,
  counterTotals,
  wssCoverage,
} from '../../packages/storage/src/collector-telemetry.js';
import { LiveMigrationLane } from '../../apps/collector/src/live-lane.js';
import { wsUrlFromHttp, resolveEndpoints } from '../../packages/domain/src/config.js';
import { buildBottleneckReport } from '../../packages/research/src/bottleneck.js';
import { subscriptionFor, assertUnwatchesExactly, UnwatchMismatch } from '../../packages/pipeline/src/vault-watch.js';

/**
 * The directive's P8, P11 and P13 wiring: items 41–43, 52–54 and 56.
 *
 * The modules these exercise were all built and unit-tested before this
 * commit — and none of them ran. That is the finding this whole directive is
 * about: a component exists, a proof script completes, tests pass, and the
 * running collector still produces none of the claimed evidence.
 */

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'live-lane-'));
  return openDb({ path: join(dir, 'runtime.db'), skipBackup: true });
}

const session = (db: ReturnType<typeof freshDb>, nowMs: number) =>
  openCollectorSession(db, {
    mode: 'observe',
    sourceCommit: 'abc1234',
    dirty: false,
    pid: 1,
    endpoint: 'example.invalid',
    nowMs,
  });

const MIGRATION_LOGS = [
  'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
  'Program log: Instruction: CreatePool',
  'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
];
const TRADE_LOGS = [
  'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
  'Program log: Instruction: Buy',
  'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
];

const lane = (db: ReturnType<typeof freshDb>, sessionId: string) =>
  new LiveMigrationLane({
    wsUrl: 'wss://example.invalid',
    programs: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
    // Never connected in these tests: what is under test is the ADMISSION rule,
    // and a socket would only add a way for the test to be flaky.
    rpc: { getTransactionInstructions: async () => null, getAccountRaw: async () => ({ owner: '', dataBase64: '', lamports: 0n }) },
    db,
    sessionId,
    persist: () => {},
  });

describe('41/43 — the live lane admits current migrations, and only migrations', () => {
  it('queues a migration the chain just named, with no history paging', () => {
    // The whole point of P8. The recovery lane only reaches a pool once a
    // screening happened to mention its mint, which is structurally late for a
    // strategy whose premise is the first hour.
    const db = freshDb();
    const s = session(db, 1_000);
    const l = lane(db, s.sessionId);
    expect(l.offer({ signature: 'sig1', slot: 10, logs: MIGRATION_LOGS, err: null, receivedUtcMs: 1_000 })).toBeNull();
    expect(l.pending).toBe(1);
    db.close();
  });

  it('41 — a FAILED transaction is excluded, because nothing migrated', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    const l = lane(db, s.sessionId);
    const why = l.offer({ signature: 'sig1', slot: 10, logs: MIGRATION_LOGS, err: 'InstructionError', receivedUtcMs: 1 });
    expect(why).toContain('nothing migrated');
    expect(l.pending).toBe(0);
    db.close();
  });

  it('ignores a trade, which outnumbers migrations by orders of magnitude', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    const l = lane(db, s.sessionId);
    expect(l.offer({ signature: 'sig1', slot: 10, logs: TRADE_LOGS, err: null, receivedUtcMs: 1 })).toContain(
      'not a migration',
    );
    db.close();
  });

  it('42 — the same signature twice stays ONE queued item', () => {
    // Distinct EVENTS in one transaction stay distinct, and that is
    // `decodeMigrations`' job on the bytes. Distinct DELIVERIES of one
    // signature are the socket repeating itself, and must not double the work.
    const db = freshDb();
    const s = session(db, 1_000);
    const l = lane(db, s.sessionId);
    l.offer({ signature: 'sig1', slot: 10, logs: MIGRATION_LOGS, err: null, receivedUtcMs: 1 });
    expect(l.offer({ signature: 'sig1', slot: 10, logs: MIGRATION_LOGS, err: null, receivedUtcMs: 2 })).toBe(
      'already queued',
    );
    expect(l.pending).toBe(1);
    db.close();
  });

  it('drops a processed sighting that is absent at confirmed, rather than trusting it', async () => {
    // The fake RPC returns null for every signature: seen at processed, gone at
    // confirmed. The correct outcome is NO candidate, not a candidate with a
    // caveat.
    const db = freshDb();
    const s = session(db, 1_000);
    const l = lane(db, s.sessionId);
    l.offer({ signature: 'sig1', slot: 10, logs: MIGRATION_LOGS, err: null, receivedUtcMs: 1 });
    const r = await l.drain(10);
    expect(r.fetched).toBe(1);
    expect(r.recorded).toBe(0);
    expect(Object.keys(r.refusals).join(' ')).toContain('dropped');
    db.close();
  });
});

describe('52 — the vault subscription stores what it subscribed', () => {
  const SET = {
    baseVault: 'BaseVault11111111111111111111111111111111',
    quoteVault: 'QuoteVault1111111111111111111111111111111',
    poolState: 'PoolPda111111111111111111111111111111111',
    feeConfig: 'FeeConfig11111111111111111111111111111111',
    mint: 'Mint111111111111111111111111111111111111',
    creatorOrCashbackAccumulator: null,
  };

  it('records each address under its own kind, so a pool PDA is never a vault', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    const sub = subscriptionFor('traj-1', SET, 1_000);
    for (const a of sub.addresses) {
      recordSubscription(db, s.sessionId, {
        kind: a === SET.baseVault || a === SET.quoteVault ? 'vault' : 'pool_context',
        address: a,
        trajectoryId: 'traj-1',
        nowMs: 1_000,
      });
    }
    const byKind = wssCoverage(db).byKind;
    expect(byKind.find((k) => k.kind === 'vault')?.open).toBe(2);
    // The pool PDA, the fee config and the mint are watched for CHANGE and
    // never decoded as balances. That separation is P11's first item.
    expect(byKind.find((k) => k.kind === 'pool_context')?.open).toBe(3);
    db.close();
  });

  it('unsubscribes by the STORED addresses, and a re-derivation that drifted is caught', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    const sub = subscriptionFor('traj-1', SET, 1_000);
    for (const a of sub.addresses) {
      recordSubscription(db, s.sessionId, { kind: 'vault', address: a, trajectoryId: 'traj-1', nowMs: 1_000 });
    }
    recordUnsubscribe(db, s.sessionId, sub.addresses, 2_000);
    expect(wssCoverage(db).openSubscriptions).toBe(0);

    // A derivation that changed between subscribe and unsubscribe leaks the old
    // address silently, and a leaked subscription is indistinguishable from an
    // account that simply went quiet.
    expect(() => assertUnwatchesExactly(sub, [SET.baseVault])).toThrow(UnwatchMismatch);
    db.close();
  });
});

describe('53 — the urgent queue is drained, not merely filled', () => {
  it('serves an urgent trajectory ahead of the others', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    queueUrgentMark(db, s.sessionId, {
      trajectoryId: 'traj-2',
      address: 'BaseVault11111111111111111111111111111111',
      before: 1_000_000n,
      after: 500_000n,
      nowMs: 1_000,
    });
    const pending = pendingUrgent(db, s.sessionId);
    expect(pending.map((p) => p.trajectory_id)).toEqual(['traj-2']);

    // The ordering the collector applies: urgent first, nothing duplicated.
    const open = ['traj-1', 'traj-2', 'traj-3'];
    const urgent = new Set(pending.map((p) => p.trajectory_id));
    const order = [...open.filter((t) => urgent.has(t)), ...open.filter((t) => !urgent.has(t))];
    expect(order).toEqual(['traj-2', 'traj-1', 'traj-3']);
    db.close();
  });

  it('marks it consumed, so the same move does not jump the queue forever', () => {
    const db = freshDb();
    const s = session(db, 1_000);
    queueUrgentMark(db, s.sessionId, {
      trajectoryId: 'traj-2',
      address: 'BaseVault11111111111111111111111111111111',
      before: 1_000_000n,
      after: 500_000n,
      nowMs: 1_000,
    });
    consumeUrgent(db, s.sessionId, 'traj-2', 1_500);
    expect(pendingUrgent(db, s.sessionId)).toEqual([]);
    const c = wssCoverage(db);
    expect(c.urgentQueued).toBe(1);
    expect(c.urgentConsumed).toBe(1);
    db.close();
  });
});

describe('56 — the rate is per ACTIVE second, never per wall second', () => {
  it('sums session spans rather than the calendar window', () => {
    // The report this replaces divided by elapsed wall time including downtime:
    // a process up for twenty minutes out of a day reported that quota was not
    // its constraint, which describes the downtime.
    const db = freshDb();
    const a = session(db, 0);
    heartbeat(db, a.sessionId, 60_000, 1);
    closeCollectorSession(db, a.sessionId, 60_000);
    const b = session(db, 3_600_000);
    closeCollectorSession(db, b.sessionId, 3_660_000);

    const spans = sessionSpans(db);
    expect(spans.activeSeconds).toBe(120);
    expect(spans.wallSeconds).toBe(3_660);
    // A duty cycle this low is the headline, not a footnote.
    expect(spans.activeSeconds / spans.wallSeconds).toBeLessThan(0.05);
    db.close();
  });

  it('MERGES overlapping sessions rather than summing them', () => {
    // Two collectors running concurrently for an hour are one active hour of
    // calendar time. Summing them reports a duty cycle above 1, which then
    // divides every rate by too large a number and understates the load.
    const db = freshDb();
    const a = session(db, 0);
    closeCollectorSession(db, a.sessionId, 60_000);
    const b = session(db, 30_000);
    closeCollectorSession(db, b.sessionId, 90_000);

    const spans = sessionSpans(db);
    expect(spans.activeSeconds).toBe(90);
    expect(spans.sessions).toBe(2);
    db.close();
  });

  it('distinguishes a session that DIED from one that exited', () => {
    const db = freshDb();
    const a = session(db, 0);
    closeCollectorSession(db, a.sessionId, 1_000);
    session(db, 2_000); // never closed
    expect(sessionSpans(db).diedWithoutClosing).toBe(1);
    db.close();
  });

  it('counts RPC by METHOD, because one total hides which call is the constraint', () => {
    const db = freshDb();
    const s = session(db, 0);
    countResource(db, s.sessionId, 'solana_rpc', { detail: 'getAccountInfo', count: 5 });
    countResource(db, s.sessionId, 'solana_rpc', { detail: 'getTransaction', count: 2, errors429: 1 });
    countResource(db, s.sessionId, 'solana_rpc', { detail: 'getAccountInfo', count: 3 });

    const totals = counterTotals(db);
    expect(totals.find((t) => t.detail === 'getAccountInfo')?.count).toBe(8);
    expect(totals.find((t) => t.detail === 'getTransaction')?.errors_429).toBe(1);
    db.close();
  });
});

describe('the socket follows the endpoint HTTP is actually using', () => {
  it('derives wss from https, carrying the API key in the query', () => {
    // Measured on 2026-08-16: with SOLANA_RPC_HTTP naming one provider and a
    // stale HELIUS_API_KEY present, HTTP went to the named provider and the
    // socket went to Helius, which closed with 1006 on every attempt. The live
    // migration lane covered nothing and reported a coverage gap that read as a
    // chain fact rather than a configuration one.
    expect(wsUrlFromHttp('https://example.quiknode.pro/abc123/')).toBe('wss://example.quiknode.pro/abc123/');
    expect(wsUrlFromHttp('https://mainnet.helius-rpc.com/?api-key=k')).toBe('wss://mainnet.helius-rpc.com/?api-key=k');
  });

  it('returns null for something that is not an http endpoint', () => {
    // A malformed endpoint is a configuration error to surface, not a socket to
    // guess at.
    expect(wsUrlFromHttp('not a url')).toBeNull();
    expect(wsUrlFromHttp('wss://already.a.socket/')).toBeNull();
  });
});

/**
 * An OBSERVED quota error outranks a modelled ratio.
 *
 * Measured on 2026-08-16: the endpoint sat at 0.9% of its 10/s limit and
 * returned `daily request limit reached` on every call. The modelled ratio said
 * rate capacity was not the constraint — true, and useless, because the account
 * had no requests left for the day. A per-second limit and a daily allowance
 * are different limits, and this report only models the first.
 */
describe('13 — the binding constraint is what was OBSERVED, not what was projected', () => {
  const base = {
    time: { activeSeconds: 1_000, wallSeconds: 2_000 },
    throughput: {
      completedTrajectories: 5,
      candidatesConsidered: 50,
      candidatesWithCanonicalPool: 10,
      candidatesWithCashbackPool: 2,
      apparatusFailures: 0,
      duplicateObservations: 0,
      workerBusySeconds: 0,
    },
    latency: { queueLagMs: [], markLagMs: [], triggerToFillMs: [] },
    limitsPerActiveSecond: { 'solana_rpc:getAccountInfo': 10 },
  };

  it('reports low per-second utilisation as NOT the constraint when nothing failed', () => {
    const r = buildBottleneckReport({
      ...base,
      resources: [{ kind: 'solana_rpc', detail: 'getAccountInfo', count: 90, errors429: 0, quotaErrors: 0 }],
    });
    expect(r.bindingConstraint).toContain('of its 10/s limit');
    expect(r.notes.join(' ')).toContain('per-second rate capacity is NOT the constraint');
  });

  it('names the DAILY QUOTA instead the moment one is actually observed', () => {
    const r = buildBottleneckReport({
      ...base,
      resources: [{ kind: 'solana_rpc', detail: 'getAccountInfo', count: 90, errors429: 0, quotaErrors: 1 }],
    });
    expect(r.bindingConstraint).toContain('DAILY QUOTA is exhausted');
    expect(r.notes.join(' ')).toContain('Backing off does not help');
  });

  it('still reports the duty cycle, because downtime is not capacity', () => {
    const r = buildBottleneckReport({
      ...base,
      time: { activeSeconds: 800, wallSeconds: 2_000 },
      resources: [],
    });
    expect(r.dutyCycle).toBe(0.4);
    expect(r.notes.join(' ')).toContain('a fact about downtime');
  });
});

/**
 * One asymmetry, found three times.
 *
 * `rpcHttp` derived from the Helius key and `rpcWs` did not, so an operator with
 * a key got HTTP and no websocket. Then an explicit `SOLANA_RPC_HTTP` sent HTTP
 * to one provider while the socket still derived from the key, so the two
 * transports pointed at different hosts and the socket closed 1006 on every
 * attempt. Then the FALLBACK: an operator who names a primary and holds a
 * working key had a second endpoint available and no way to reach it, because
 * deriving only ever happened when the primary was absent.
 *
 * Measured on 2026-08-16: the primary returned `daily request limit reached` for
 * hours while the Helius endpoint answered getSlot with HTTP 200.
 */
describe('every transport derives from the same place, or from nothing', () => {
  const r = (over: Partial<Parameters<typeof resolveEndpoints>[0]> = {}) =>
    resolveEndpoints({
      explicitHttp: null,
      explicitWs: null,
      explicitFallback: null,
      heliusApiKey: null,
      ...over,
    });

  it('derives BOTH the socket and the fallback when a primary is named and a key exists', () => {
    const e = r({ explicitHttp: 'https://example.quiknode.pro/abc/', heliusApiKey: 'k123' });
    // The socket follows the PRIMARY, because two transports on two providers
    // is the defect that closed 1006 on every attempt.
    expect(e.rpcWs).toBe('wss://example.quiknode.pro/abc/');
    // The fallback follows the KEY, because that is the second endpoint — the
    // one that answered 200 for hours while the primary refused every call.
    expect(e.rpcHttpFallback).toContain('helius-rpc.com');
    expect(e.rpcHttpDerivedFromHeliusKey).toBe(false);
  });

  it('never falls back to the endpoint it is ALREADY using', () => {
    // With no explicit primary, rpcHttp IS the Helius URL. A fallback equal to
    // the primary retries the exhausted host against itself.
    const e = r({ heliusApiKey: 'k123' });
    expect(e.rpcHttp).toContain('helius-rpc.com');
    expect(e.rpcHttpFallback).toBeNull();
    expect(e.rpcHttpDerivedFromHeliusKey).toBe(true);
  });

  it('explicit beats derived, for all three', () => {
    const e = r({
      explicitHttp: 'https://example.quiknode.pro/abc/',
      explicitWs: 'wss://named.example/socket',
      explicitFallback: 'https://named.example/rpc',
      heliusApiKey: 'k123',
    });
    expect(e.rpcHttp).toBe('https://example.quiknode.pro/abc/');
    expect(e.rpcWs).toBe('wss://named.example/socket');
    expect(e.rpcHttpFallback).toBe('https://named.example/rpc');
  });

  it('derives nothing at all with no key and no primary', () => {
    const e = r();
    expect(e.rpcHttp).toBeNull();
    expect(e.rpcWs).toBeNull();
    expect(e.rpcHttpFallback).toBeNull();
  });

  it('a named primary with NO key gets a socket and no fallback', () => {
    // There is no second endpoint to fall back to, and inventing one would be
    // worse than having none.
    const e = r({ explicitHttp: 'https://example.quiknode.pro/abc/' });
    expect(e.rpcWs).toBe('wss://example.quiknode.pro/abc/');
    expect(e.rpcHttpFallback).toBeNull();
  });
});
