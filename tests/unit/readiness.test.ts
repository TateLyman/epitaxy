import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../packages/storage/src/db.js';
import { insertObservation } from '../../packages/storage/src/observation-repo.js';
import { buildReadiness, CANARY_GATES } from '../../packages/research/src/readiness.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P18 — the readiness gate, executed against corpora built to break it.
 *
 * The gate this replaces could pass after 200 losing trades: it counted
 * positions whose legs said `SIMULATED_OK` and never asked what they earned.
 * The first test states exactly that scenario.
 */

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;

let dir: string;
let db: DatabaseSync;

/**
 * Insert one CONFIRMATORY position: both legs effect-verified, one family,
 * reproducible, clean commit. Everything the strictest clause asks for, so a
 * test that fails does so on economics and not on paperwork.
 */
/**
 * One confirmatory position.
 *
 * P13 — `realizedLamports` here is GROSS proceeds, and the net PnL is written
 * explicitly. That is the whole repair: the readiness gate used to compute
 * `realized - cost` against a column that already held the net, subtracting the
 * principal a second time, so a winning position scored as a large loss.
 */
function trade(i: number, costLamports: bigint, realizedLamports: bigint, dayOffset = 0, mint = `Mint${i}`): void {
  const ctx = 'ctx-1';
  const entry = `obs-e-${i}`;
  const exit = `obs-x-${i}`;
  const obs = (id: string, side: 'buy' | 'sell'): void => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    // Built through the REAL writer. A fixture assembled by hand drifts from
    // the schema the engine actually writes, and then the test is describing a
    // row that never existed.
    insertObservation(
      db,
      {
        observationId: id,
        family: 'BUILD_CUSTOM',
        mint,
        side,
        inputMint: side === 'buy' ? WSOL : mint,
        outputMint: side === 'buy' ? mint : WSOL,
        requestedAmount: 20_000_000n,
        expectedOutput: 1_000_000n,
        minimumOutput: 990_000n,
        slippageBps: 300,
        platformFeeBps: 0,
        platformFeeAmount: null,
        platformFeeMint: null,
        signatureFeeLamports: 5_000n,
        prioritizationFeeLamports: 100_000n,
        rentFeeLamports: 0n,
        broadcasterTipLamports: 0n,
        routePlanHash: 'rp',
        routeLabels: ['Pump.fun Amm'],
        instructionSetHash: 'ish',
        instructionCount: 6,
        computeUnitLimit: 200_000,
        transactionBytes: 900,
        blockhash: 'BH',
        lastValidBlockHeight: 400,
        expireAt: T0 + 60_000,
        contextSlot: 438_000_000,
        instructionPolicy: 'PASS',
        transactionPolicy: 'PASS',
        simulation: 'SIMULATED_OK',
        simulationEffect: 'SIMULATED_EFFECT_OK',
        policyDetail: null,
        simulationDetail: null,
        requestedUtcMs: T0 + dayOffset * DAY,
        receivedUtcMs: T0 + dayOffset * DAY,
        latencyMs: 100,
        endpoint: '/swap/v1/build',
        requestId: null,
        rawPayloadHash: 'rph',
        contextHash: ctx,
      } as never,
      {
        positionId: null,
        shadowPositionId: null,
        purpose: side === 'buy' ? 'entry' : 'exit',
        failure: null,
        impactStatus: 'ABSENT',
        impactRawString: null,
        adverseImpactBps: null,
        writableAccounts: [],
        lookupTables: [],
        assembled: null,
      },
    );
    db.prepare(
      `UPDATE execution_observations
         SET simulation_effect = 'SIMULATED_EFFECT_OK',
             -- P14: the view requires the EXACT bytes to have been retained.
             -- A confirmatory position that cannot produce the transaction it
             -- was built from is not reproducible, whatever else is right.
             exact_transaction_blob = 'blob-hash'
       WHERE observation_id = ?`,
    ).run(id);
    db.prepare(
      `INSERT INTO simulation_jobs
         (job_id,request_hash,execution_observation_id,mode,status,requested_utc_ms,
          confirmatory,validity,simulated_effect_ok,account_coverage_ok)
       VALUES (?,?,?,'CONFIRMATORY_OFFLINE','SIMULATED_OK',?,1,'VALID_CONFIRMATORY',1,1)`,
    ).run(`job-${id}`, `rh-${id}`, id, T0);
  };

  obs(entry, 'buy');
  obs(exit, 'sell');
  db.prepare(
    `INSERT INTO positions
       (position_id,mint,state,token_amount,cost_lamports,realized_lamports,net_pnl_lamports,
        execution_cost_lamports,opened_utc_ms,
        closed_utc_ms,strategy_version,simulated,context_hash,entry_observation_id,exit_observation_id)
     VALUES (?,?, 'CLOSED','0',?,?,?,?,?,?,'v1',1,?,?,?)`,
  ).run(
    `pos-${i}`,
    mint,
    costLamports.toString(),
    realizedLamports.toString(),
    // The net, stated rather than derived.
    (realizedLamports - costLamports).toString(),
    // What it cost to EXECUTE: base fee, priority fee, unrecovered rent. A 2x
    // stress doubles THIS, not the principal.
    '13000',
    T0 + dayOffset * DAY,
    T0 + dayOffset * DAY + 3_600_000,
    ctx,
    entry,
    exit,
  );
}

function context(): void {
  db.prepare(
    `INSERT INTO run_contexts
       (context_hash,source_commit,strategy_version,strategy_config_hash,risk_policy_hash,
        schema_version,paper_engine_version,quote_adapter_version,data_regime_id,mode,
        first_seen_utc_ms,last_seen_utc_ms)
     VALUES ('ctx-1','abc123def','v1','sch','rph','schema-v18','pe','qa','dr','paper',?,?)`,
  ).run(T0, T0);
}

const run = (): ReturnType<typeof buildReadiness> => buildReadiness(db, 'abc123def', 'v1', T0 + 40 * DAY);
const gateOf = (id: string): { pass: boolean; observed: string } => {
  const r = run().gates.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no gate ${id}`);
  return r;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'readiness-'));
  db = openDb({ path: join(dir, 'r.db'), skipBackup: true });
  context();
});

afterEach(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds -wal briefly; the OS reclaims it */
  }
});

describe('P18 — profitability is a gate, not a footnote', () => {
  it('FAILS on 200 consistently losing trades', () => {
    // The exact scenario the old gate passed. Two hundred completed positions,
    // every one of them properly observed, policy-checked, effect-verified and
    // reproducible — and every one of them losing 10%.
    for (let i = 0; i < 200; i += 1) trade(i, 20_000_000n, 18_000_000n, i % 30);
    const r = run();
    expect(r.confirmatoryTrades).toBe(200);
    // The sample gate is satisfied. That was the whole problem.
    expect(gateOf('sample.validCompletedPositions').pass).toBe(true);
    expect(gateOf('pnl.netPositive').pass).toBe(false);
    expect(gateOf('pnl.expectedLogGrowth').pass).toBe(false);
    expect(gateOf('pnl.profitFactor').pass).toBe(false);
    expect(r.verdict).toBe('NOT_READY');
  });

  it('FAILS an empty corpus rather than abstaining', () => {
    const r = run();
    expect(r.confirmatoryTrades).toBe(0);
    // Not "unknown", not "skipped". A gate that abstains on a thin sample
    // abstains exactly when the decision is most dangerous.
    //
    // Every gate that makes a claim ABOUT THE EVIDENCE fails. The handful that
    // assert an absence -- no blocked exits, no unresolved reconciliation --
    // are legitimately true of an empty corpus and are not counted here.
    const claims = r.gates.filter(
      (x) => x.id.startsWith('sample.') || x.id.startsWith('pnl.') || x.id.startsWith('risk.') ||
             x.id.startsWith('robustness.') || x.id.startsWith('concentration.') ||
             x.id.startsWith('stress.') || x.id.startsWith('shadow.'),
    );
    expect(claims.length).toBeGreaterThan(10);
    expect(claims.filter((x) => x.pass)).toEqual([]);
    expect(r.verdict).toBe('NOT_READY');
  });

  it('does NOT count a development JIT position as confirmatory', () => {
    trade(1, 20_000_000n, 30_000_000n);
    db.prepare("UPDATE simulation_jobs SET confirmatory = 0, validity = 'VALID_DEVELOPMENT'").run();
    const r = run();
    // Real evidence about the strategy. Never sufficient for canary: a JIT run
    // fetches its own state from a moving chain, so the same transaction run
    // twice is two experiments.
    expect(r.confirmatoryTrades).toBe(0);
    expect(r.validDevelopmentTrades).toBe(1);
  });

  it('does NOT count a position whose leg effect was never verified', () => {
    trade(1, 20_000_000n, 30_000_000n);
    db.prepare("UPDATE execution_observations SET simulation_effect = 'NOT_VERIFIED' WHERE side = 'sell'").run();
    expect(run().confirmatoryTrades).toBe(0);
  });

  it('does NOT count a position built on a dirty commit', () => {
    trade(1, 20_000_000n, 30_000_000n);
    db.prepare("UPDATE run_contexts SET source_commit = 'abc123def+dirty'").run();
    expect(run().confirmatoryTrades).toBe(0);
  });

  it('refuses a result carried by one trade', () => {
    // 39 small losses and one enormous winner. Net positive, profit factor
    // fine, and the whole conclusion rests on a single token.
    for (let i = 0; i < 39; i += 1) trade(i, 20_000_000n, 19_000_000n, i % 25);
    trade(99, 20_000_000n, 400_000_000n, 26);
    expect(gateOf('pnl.netPositive').pass).toBe(true);
    expect(gateOf('robustness.exTop1').pass).toBe(false);
    expect(gateOf('concentration.noTradeOverTenPercent').pass).toBe(false);
  });

  it('refuses a result carried by one day', () => {
    for (let i = 0; i < 30; i += 1) trade(i, 20_000_000n, 19_500_000n, i);
    for (let i = 100; i < 110; i += 1) trade(i, 20_000_000n, 45_000_000n, 31);
    expect(gateOf('pnl.netPositive').pass).toBe(true);
    expect(gateOf('robustness.exBestDay').pass).toBe(false);
    expect(gateOf('concentration.noDayOverTwentyFivePercent').pass).toBe(false);
  });

  it('refuses a thin edge that dies under doubled costs', () => {
    // An edge of 10,000 lamports per trade against 13,000 of execution cost.
    // Doubling the cost removes 13,000 more and the edge is gone.
    //
    // The stress doubles the COST, not the principal. Subtracting the whole
    // 20,000,000 basis a second time was a test no strategy could pass, which
    // is not a conservative test but a broken one: a stress that always fails
    // carries no information about robustness.
    for (let i = 0; i < 250; i += 1) trade(i, 20_000_000n, 20_010_000n, i % 30);
    expect(gateOf('pnl.netPositive').pass).toBe(true);
    expect(gateOf('stress.doubleCosts').pass).toBe(false);
  });

  it('a genuinely robust edge SURVIVES doubled costs', () => {
    // The other half, and the one the old implementation could never show:
    // 2,000,000 of edge against 13,000 of cost is not troubled by another
    // 13,000. If this cannot pass, the gate is a wall.
    for (let i = 0; i < 250; i += 1) trade(i, 20_000_000n, 22_000_000n, i % 30);
    expect(gateOf('pnl.netPositive').pass).toBe(true);
    expect(gateOf('stress.doubleCosts').pass).toBe(true);
  });

  it('P13 — net PnL is read, not re-derived from gross', () => {
    // A position that cost 20,000,000 and returned 21,000,000 gross made
    // 1,000,000. The old computation scored it as a 19,000,000 LOSS.
    trade(1, 20_000_000n, 21_000_000n);
    const r = run();
    expect(r.confirmatoryTrades).toBe(1);
    expect(gateOf('pnl.netPositive').observed).toContain('1000000');
  });

  it('refuses when the edge stopped working recently', () => {
    for (let i = 0; i < 200; i += 1) trade(i, 20_000_000n, 26_000_000n, i % 25);
    for (let i = 500; i < 560; i += 1) trade(i, 20_000_000n, 8_000_000n, 26 + (i % 4));
    expect(gateOf('robustness.recent50').pass).toBe(false);
  });

  it('refuses a sample drawn from too few DISTINCT calendar days', () => {
    for (let i = 0; i < 250; i += 1) trade(i, 20_000_000n, 30_000_000n, i % 3);
    // A memecoin regime lasts days. Three days is one regime.
    expect(gateOf('sample.calendarDays').pass).toBe(false);
    expect(run().verdict).toBe('NOT_READY');
  });

  it('P13 — counts distinct UTC days, not elapsed span', () => {
    // Two trades 30 days apart span 30 days and observe two. The old gate
    // passed on the span, which is one regime observed twice.
    trade(1, 20_000_000n, 30_000_000n, 0);
    trade(2, 20_000_000n, 30_000_000n, 30);
    const gate = gateOf('sample.calendarDays');
    expect(gate.pass).toBe(false);
    expect(gate.observed).toContain('2 distinct');
  });

  it('counts a total loss as catastrophic and holds the incidence down', () => {
    for (let i = 0; i < 200; i += 1) trade(i, 20_000_000n, 30_000_000n, i % 25);
    for (let i = 900; i < 930; i += 1) trade(i, 20_000_000n, 0n, i % 25);
    // 30/230 is 13%, well past the frozen 2%.
    expect(gateOf('risk.catastrophicIncidence').pass).toBe(false);
  });

  it('reports every failing gate as a blocker with what it required', () => {
    const r = run();
    expect(r.blockers.length).toBe(r.gates.filter((x) => !x.pass).length);
    expect(r.blockers[0]).toMatch(/observed .*, requires /);
  });

  it('keeps its thresholds frozen and named', () => {
    // A threshold changed after looking at the corpus goes in the ledger before
    // the change lands. Pinning them here makes a silent edit a test failure.
    expect(CANARY_GATES.minValidPositions).toBe(200);
    expect(CANARY_GATES.minCalendarDays).toBe(21);
    expect(CANARY_GATES.minProfitFactor).toBe(1.25);
    expect(CANARY_GATES.maxDrawdownBps).toBe(2_000);
  });
});
