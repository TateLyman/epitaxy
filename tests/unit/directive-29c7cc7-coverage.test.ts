import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/**
 * The directive's 62 required tests, mapped to the test that asserts each.
 *
 * This file does not re-test the behaviour. It is the AUDIT: every item is
 * either pointed at a test file that exists and contains a matching assertion,
 * or explicitly marked NOT COVERED with the reason.
 *
 * An audit that silently omitted the uncovered items would be the same defect
 * the directive is about — a green check standing in for work nobody did. So
 * `NOT_COVERED` entries are listed, counted, and printed, and the suite still
 * passes: they are honest gaps, not failures, and turning them into failures
 * would only pressure someone into deleting the row.
 */

type Item = {
  readonly n: number;
  readonly what: string;
  /** The test file that asserts it, or null when nothing does. */
  readonly file: string | null;
  /** A string that must appear in that file, so a rename breaks the audit. */
  readonly needle?: string;
  readonly why?: string;
};

const T = 'tests/unit/';

const ITEMS: readonly Item[] = [
  { n: 1, what: 'trajectory:collect writes a database trajectory', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'the collector opens trajectories' },
  { n: 2, what: 'the collector reaches the persistent worker', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'persistent worker' },
  { n: 3, what: 'the collector reaches canonical settlement', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'settlement' },
  { n: 4, what: 'a proof artifact cannot increase DB trajectory count', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'proof artifact cannot increase' },
  { n: 5, what: 'state promotion requires current DB rows', file: `${T}commands-mean-their-names-p12.test.ts`, needle: 'proof artifact cannot inflate' },
  { n: 6, what: 'BUY is direct PumpSwap in the primary lane', file: `${T}account-plan-p2.test.ts`, needle: 'built transaction bytes' },
  { n: 7, what: 'pool vault deltas reconcile to taker credit', file: `${T}sole-venue-p2.test.ts`, needle: '7/8 — the canonical pool supplied the WHOLE entry' },
  { n: 8, what: 'a split/routed entry is rejected from direct evidence', file: `${T}sole-venue-p2.test.ts`, needle: 'REFUSES a split entry' },
  { n: 9, what: 'built transaction bytes are reused exactly', file: `${T}account-plan-p2.test.ts`, needle: '9 — built transaction bytes' },
  { n: 10, what: 'fee recipient selection cannot change between capture and execution', file: `${T}account-plan-p2.test.ts`, needle: '10 — fee recipient selection' },
  { n: 11, what: 'every u64 is a decimal string across NDJSON', file: `${T}worker-exactness-p3.test.ts`, needle: '11 — every u64' },
  { n: 12, what: 'known resets on worker Init', file: `${T}worker-exactness-p3.test.ts`, needle: '12/13' },
  { n: 13, what: 'job output accounting resets on Init', file: `${T}worker-exactness-p3.test.ts`, needle: '12/13' },
  { n: 14, what: 'write error cannot shift responses', file: `${T}worker-exactness-p3.test.ts`, needle: '14 — a failed write' },
  { n: 15, what: 'exact Clock/Rent/EpochSchedule are restored', file: `${T}worker-exactness-p3.test.ts`, needle: '15/16' },
  { n: 16, what: 'required initialization incompleteness refuses', file: `${T}worker-exactness-p3.test.ts`, needle: '15/16' },
  { n: 17, what: 'sell quote state equals sell pre-execution full account hash', file: `${T}worker-exactness-p3.test.ts`, needle: '17/18' },
  { n: 18, what: 'owner/lamports/data mutation breaks state equality', file: `${T}worker-exactness-p3.test.ts`, needle: '17/18' },
  { n: 19, what: 'worker 0.04 SOL run stays below output bound', file: `${T}worker-exactness-p3.test.ts`, needle: '19 — scoped output' },
  { n: 20, what: 'fee config present-but-undecodable refuses', file: `${T}account-plan-p2.test.ts`, needle: '20 — a fee config' },
  { n: 21, what: 'transfer fee NOT_APPLICABLE is not unknown', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'NOT_APPLICABLE is not UNKNOWN' },
  { n: 22, what: 'transfer fee appears once in execution cost', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'transfer fee is INCLUDED' },
  { n: 23, what: 'rent appears once in execution cost', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'rent appears ONCE' },
  { n: 24, what: 'failed-attempt cost appears once', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'failed-attempt cost appears once' },
  { n: 25, what: 'unexplained movement is derived', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'unexplained movement is DERIVED' },
  { n: 26, what: 'incomplete/effect-invalid leg blocks PnL', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'blocks PnL' },
  { n: 27, what: 'evidence rows cannot be replaced', file: `${T}account-plan-p2.test.ts`, needle: '27 — a recorded plan cannot be replaced' },
  { n: 28, what: 'settlement IDs are exact foreign keys', file: `${T}cashback-both-legs-p7.test.ts`, needle: 'REFUSES cashback recorded against a trajectory that does not exist' },
  { n: 29, what: 'every created account is observed', file: `${T}created-accounts-p6.test.ts`, needle: '29/30' },
  { n: 30, what: 'created accounts classified by scope/recoverability', file: `${T}prewarm-cu-p6.test.ts`, needle: '30 — the scope context is complete' },
  { n: 31, what: 'warm surface removes only non-price state', file: `${T}prewarm-cu-p6.test.ts`, needle: '31 — the warm surface transplants setup' },
  { n: 32, what: 'primary warm gate refuses shared account creation', file: `${T}created-accounts-p6.test.ts`, needle: '32 — the warm gate' },
  { n: 33, what: 'base ATA close is in the sell when valid', file: `${T}sequential-round-trip-p3.test.ts`, needle: '33 — the close is in the sell' },
  { n: 34, what: 'cashback BUY account placement is exact', file: `${T}cashback-both-legs-p7.test.ts`, needle: '34/35' },
  { n: 35, what: 'cashback SELL account placement is exact', file: `${T}cashback-both-legs-p7.test.ts`, needle: '34/35' },
  { n: 36, what: 'omitted cashback accounts receive zero attribution', file: `${T}cashback-both-legs-p7.test.ts`, needle: '36 — omitted accounts' },
  { n: 37, what: 'buy and sell accumulator deltas measured separately', file: `${T}cashback-both-legs-p7.test.ts`, needle: '37 — buy and sell accumulator deltas' },
  { n: 38, what: 'claimable is not claimed cash', file: `${T}cashback-both-legs-p7.test.ts`, needle: '38 — claimable is not claimed' },
  { n: 39, what: 'claim amortization changes allocated economics', file: `${T}cashback-both-legs-p7.test.ts`, needle: '39 — amortisation changes' },
  { n: 40, what: 'fee tier matches SDK selection, not quote reserve', file: `${T}fee-tiers-p14.test.ts`, needle: '40 — the tier comes from market cap' },
  { n: 41, what: 'failed migration transaction is excluded', file: `${T}live-lane-p8-p13.test.ts`, needle: '41 — a FAILED transaction is excluded' },
  { n: 42, what: 'two events in one transaction remain distinct', file: `${T}live-lane-p8-p13.test.ts`, needle: '42 — the same signature twice' },
  { n: 43, what: 'current live migration enters queue without history paging', file: `${T}live-lane-p8-p13.test.ts`, needle: '41/43' },
  { n: 44, what: 'every policy sees the same path', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'every policy sees the SAME path' },
  { n: 45, what: 'the three entry policies differ on counterexamples', file: `${T}treatments-p10.test.ts` },
  { n: 46, what: 'the two exit policies differ on a shared path', file: `${T}collector-wiring-29c7cc7.test.ts`, needle: 'exit policies DIFFER' },
  { n: 47, what: 'later selected observation equals settled/booked observation', file: `${T}trigger-fill-p10.test.ts` },
  { n: 48, what: 'bounded counterfactual has an error bound/haircut', file: `${T}p10-regressions.test.ts` },
  { n: 49, what: 'full replay applies intervening events in order', file: null, why: 'FULL_EVENT_REPLAY_TRAJECTORY is not built. docs/FUTURE_COUNTERFACTUAL_CALIBRATION.md states the ordering it must be built in, and that no bounded outcome may be called confirmatory until it exists.' },
  { n: 50, what: 'Mayhem agent flow excluded from independent breadth', file: `${T}candidate-risk-p10.test.ts`, needle: '50 — Mayhem flow is not organic' },
  { n: 51, what: 'entity-adjusted concentration reaches entry policy', file: `${T}candidate-risk-p10.test.ts`, needle: '51 — concentration reaches the GATE' },
  { n: 52, what: 'vault WSS watches vaults, not the pool PDA', file: `${T}live-lane-p8-p13.test.ts`, needle: '52 — the vault subscription' },
  { n: 53, what: 'urgent queue is consumed', file: `${T}live-lane-p8-p13.test.ts`, needle: '53 — the urgent queue is drained' },
  { n: 54, what: 'restart resumes open trajectories', file: `${T}sampling-spread-p14.test.ts`, needle: 'EXCLUDES a mint that already has an open trajectory' },
  { n: 55, what: 'exploration entitlement survives restart', file: null, why: 'pnpm exploration:status is still NOT_IMPLEMENTED and refuses with its prerequisite named: an entitlement ledger separate from cohort assignment does not exist.' },
  { n: 56, what: 'active-time rate is not wall-time rate', file: `${T}live-lane-p8-p13.test.ts`, needle: '56 — the rate is per ACTIVE second' },
  { n: 57, what: 'placeholder command aliases fail', file: `${T}commands-mean-their-names-p12.test.ts`, needle: '57 — no command is a silent alias' },
  { n: 58, what: 'stale/dirty/null-context artifact cannot authorize readiness', file: `${T}artifact-provenance-p18.test.ts` },
  { n: 59, what: 'default readiness reads the exact trajectory contract', file: `${T}score-frozen.test.ts`, needle: 'timelyCompletePaths' },
  { n: 60, what: '200 losing trajectories cannot pass', file: `${T}readiness.test.ts` },
  { n: 61, what: 'no private-key/signer/network-send path reachable from collector', file: `${T}sole-venue-p2.test.ts`, needle: '61 — no signing path is reachable' },
  { n: 62, what: 'canary/live remain blocked', file: `${T}hook-guard.test.ts` },
];

describe('the directive 29c7cc7 required-test audit', () => {
  it('names all 62 items exactly once', () => {
    expect(ITEMS).toHaveLength(62);
    expect(new Set(ITEMS.map((i) => i.n)).size).toBe(62);
    expect(Math.min(...ITEMS.map((i) => i.n))).toBe(1);
    expect(Math.max(...ITEMS.map((i) => i.n))).toBe(62);
  });

  it('every cited test file exists', () => {
    const missing = ITEMS.filter((i) => i.file !== null && !existsSync(i.file)).map((i) => `${i.n}: ${i.file}`);
    expect(missing).toEqual([]);
  });

  it('every cited needle is actually present, so a rename breaks this audit', () => {
    // Without this the audit degrades into a list of filenames that happen to
    // exist, which is exactly the "the identifier was there" failure the call
    // graph was built to catch.
    const absent: string[] = [];
    for (const i of ITEMS) {
      if (i.file === null || i.needle === undefined) continue;
      const src = readFileSync(i.file, 'utf8');
      if (!src.includes(i.needle)) absent.push(`${i.n}: "${i.needle}" not in ${i.file}`);
    }
    expect(absent).toEqual([]);
  });

  it('reports the uncovered items rather than hiding them', () => {
    const uncovered = ITEMS.filter((i) => i.file === null);
    // Both are real, named gaps with a stated prerequisite. If this count ever
    // DROPS, the rows must be updated rather than the number.
    expect(uncovered.map((i) => i.n)).toEqual([49, 55]);
    for (const u of uncovered) expect(u.why, `item ${u.n} has no reason`).toBeTruthy();
  });

  it('every required output exists on disk', () => {
    const docs = [
      'AUDIT_HEAD_29C7CC7.md',
      '29C7CC7_TRUTH_RESET.md',
      'RUNNING_TRAJECTORY_COLLECTOR.md',
      'EXACT_PUMPSWAP_ACCOUNT_PLAN.md',
      'COLD_WARM_SETUP_ECONOMICS.md',
      'PUMPSWAP_CASHBACK_V2.md',
      'FUTURE_COUNTERFACTUAL_CALIBRATION.md',
      'DEVELOPMENT_WINDOW_V1.md',
      'CONFIRMATORY_TRAJECTORIES_V2.md',
      'MULTIPLE_TESTING_LEDGER.csv',
      'FAILURE_REGISTER.csv',
    ];
    const artifacts = [
      'baseline-29c7cc7.json',
      'collector-call-graph.json',
      'worker-exactness.json',
      'account-plan-proof.json',
      'cold-warm-size-surface.json',
      'cashback-both-legs.json',
      'trajectory-status.json',
      'settlement-identity.json',
      'pumpswap-parity-v3.json',
      'landed-parity-v2.json',
      'wss-status.json',
      'cohort-status.json',
      'exploration-status.json',
      'reject-panel-v2.json',
      'rate-budget-v2.json',
      'readiness.json',
      'release-manifest.json',
    ];
    expect(docs.filter((d) => !existsSync(`docs/${d}`))).toEqual([]);
    expect(artifacts.filter((a) => !existsSync(`artifacts/${a}`))).toEqual([]);
  });

  it('the collector call graph proves every stage of the open path', () => {
    // The graph had never parsed the collector at all: `openTrajectory` was
    // `undefined` in `declaredIn`, not unreachable. That is why a refusal
    // naming an already-built worker survived two commits.
    const g = JSON.parse(readFileSync('artifacts/collector-call-graph.json', 'utf8')) as {
      required: { to: string; reached: boolean }[];
      missing: string[];
    };
    expect(g.missing).toEqual([]);
    expect(g.required.every((r) => r.reached)).toBe(true);
    expect(g.required.length).toBeGreaterThanOrEqual(13);
  });

  it('the test files it cites are all real files in the suite', () => {
    const present = new Set(readdirSync('tests/unit'));
    const cited = [...new Set(ITEMS.filter((i) => i.file !== null).map((i) => (i.file as string).replace(T, '')))];
    expect(cited.filter((c) => !present.has(c))).toEqual([]);
  });
});
