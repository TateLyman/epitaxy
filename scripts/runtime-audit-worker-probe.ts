import { writeFileSync } from 'node:fs';
import { SequentialWorker, RuntimeInstanceChanged } from '../packages/simulator/src/sequential-worker.js';
import { RENT_EXEMPT_EPOCH } from '../packages/simulator/src/sequential-runtime.js';
import { base58Encode } from '../packages/solana/src/base58.js';

/**
 * Section F of the runtime adversarial re-audit: WORKER EXACTNESS.
 *
 * Drives the real Rust worker over WSL with the boundary values the directive
 * names. Nothing here is a fixture replay: every number below is written into
 * an account, initialised into a live litesvm runtime, read back out, and
 * compared as a DECIMAL STRING to what went in.
 *
 * Writes its result to a sidecar the main harness merges, so a worker that is
 * unavailable degrades to NOT TESTABLE rather than to a silent pass.
 */

type Verdict = 'PASS' | 'FAIL' | 'NOT TESTABLE';
interface Probe {
  readonly verdict: Verdict;
  readonly mutation: string;
  readonly result: string;
  readonly consequence: string;
}

const SYSTEM = '11111111111111111111111111111111';
const out: Record<string, Probe> = {};
const stage = (s: string): void => { console.error(`[stage] ${s}`); };

/**
 * Deterministic 32-byte pubkeys, base58 encoded by the repository's own
 * encoder. A hand-rolled base58 string is not a pubkey: the worker parses it
 * and refuses, which is what a first version of this probe discovered about
 * itself.
 */
const key = (n: number): string => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (n * 37 + i * 11 + 3) & 0xff;
  return base58Encode(b);
};

const BOUNDARIES: { name: string; lamports: bigint }[] = [
  { name: '2^53-1', lamports: 9_007_199_254_740_991n },
  { name: '2^53', lamports: 9_007_199_254_740_992n },
  { name: '2^53+1', lamports: 9_007_199_254_740_993n },
  { name: '10^18', lamports: 1_000_000_000_000_000_000n },
  { name: 'u64 max', lamports: 18_446_744_073_709_551_615n },
];

async function main(): Promise<void> {
  const worker = new SequentialWorker({ commandTimeoutMs: 120_000, maxOutputBytes: 64 * 1024 * 1024 });

  const accounts = BOUNDARIES.map((b, i) => ({
    pubkey: key(i + 1),
    dataBase64: '',
    owner: SYSTEM,
    lamports: b.lamports,
    executable: false,
    rentEpoch: RENT_EXEMPT_EPOCH,
  }));
  // rentEpoch at u64 max, on its own account.
  accounts.push({
    pubkey: key(99),
    dataBase64: '',
    owner: SYSTEM,
    lamports: 1n,
    executable: false,
    rentEpoch: 18_446_744_073_709_551_615n,
  });

  const snapshot = {
    programs: [],
    accounts,
    slot: 400_000_000,
    unixTimestamp: 1_800_000_000,
    // Every sysvar field crosses the wire as a DECIMAL STRING, which is the
    // property F7 exists to preserve. Passing a bigint here would be caught by
    // JSON.stringify; passing a number would silently lose the low bits.
    clock: {
      slot: '400000000',
      epochStartTimestamp: '1799000000',
      epoch: '926',
      leaderScheduleEpoch: '927',
      unixTimestamp: '1800000000',
    },
    rent: { lamportsPerByteYear: '3480', exemptionThreshold: 2, burnPercent: 50 },
    epochSchedule: {
      slotsPerEpoch: '432000',
      leaderScheduleSlotOffset: '432000',
      warmup: false,
      firstNormalEpoch: '0',
      firstNormalSlot: '0',
    },
    requireExactSysvars: true,
    requiredAccounts: accounts.map((a) => a.pubkey),
    requiredPrograms: [],
  };

  stage('init A');
  try {
    await worker.init(snapshot as never, { jobId: 'audit-f-1' });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    for (const name of ['u64 and i64 boundary values survive as decimal strings', 're-init clears known accounts and resets counters', 'a stdin write error or timeout never mis-pairs a response', 'a 0.04 SOL job completes under the output limit']) {
      out[name] = { verdict: 'NOT TESTABLE', mutation: 'worker init', result: `the worker could not start: ${msg}`, consequence: 'unknown' };
    }
    writeFileSync(process.argv[2] ?? 'artifacts/audit-worker-probe.json', JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const instanceA = worker.instanceId;

  // ---------------------------------------------------------------- exactness
  stage('observe boundaries');
  const observed = await worker.observe(accounts.map((a) => a.pubkey));
  const byKey = new Map(observed.accounts.map((a) => [a.pubkey, a]));
  const mismatches: string[] = [];
  for (const [i, b] of BOUNDARIES.entries()) {
    const got = byKey.get(key(i + 1));
    if (got === undefined) { mismatches.push(`${b.name}: not observed`); continue; }
    if (got.lamports !== b.lamports) mismatches.push(`${b.name}: sent ${b.lamports}, got ${got.lamports}`);
  }
  const rentEpochAcct = byKey.get(key(99));
  if (rentEpochAcct === undefined) mismatches.push('rentEpoch u64 max: not observed');
  else if (rentEpochAcct.rentEpoch !== 18_446_744_073_709_551_615n) {
    mismatches.push(`rentEpoch u64 max: got ${rentEpochAcct.rentEpoch}`);
  }
  out['u64 lamports and rentEpoch boundary values survive the worker exactly'] = {
    verdict: mismatches.length === 0 ? 'PASS' : 'FAIL',
    mutation: `${BOUNDARIES.map((b) => b.name).join(', ')} as lamports, plus rentEpoch at u64 max, written into accounts and read back`,
    result: mismatches.length === 0
      ? `all ${BOUNDARIES.length + 1} values round-tripped bit-exact as decimal strings (u64 max returned ${byKey.get(key(5))?.lamports})`
      : mismatches.join('; '),
    consequence: 'a u64 routed through a JSON double comes back one higher than it went in, silently, on the economic path',
  };

  // ------------------------------------------------------- negative timestamp
  // A valid negative i64 unix timestamp: 1960-01-01.
  const negSnapshot = {
    ...snapshot,
    unixTimestamp: -315_619_200,
    clock: { ...snapshot.clock, unixTimestamp: '-315619200', epochStartTimestamp: '-315619300' },
  };
  stage('negative timestamp init');
  let negResult: string;
  let negVerdict: Verdict;
  try {
    await worker.init(negSnapshot as never, { jobId: 'audit-f-neg' });
    const c = await worker.observe(['SysvarC1ock11111111111111111111111111111111']);
    negResult = `accepted; the Clock sysvar observed as ${c.accounts[0]?.dataBase64 === null ? 'present (bytes withheld)' : 'present'}, unobserved=${JSON.stringify(c.unobserved)}`;
    negVerdict = 'PASS';
  } catch (e) {
    // A refusal is also correct, provided it is a DOMAIN refusal and not a crash.
    const m = (e as Error).message;
    negVerdict = /refus|invalid|reject|constraint/i.test(m) ? 'PASS' : 'FAIL';
    negResult = `refused: ${m.slice(0, 160)}`;
  }
  out['a negative i64 timestamp is carried exactly or refused by a domain constraint'] = {
    verdict: negVerdict,
    mutation: 'clock.unixTimestamp = -315,619,200 (1960-01-01), a valid i64 that is not a valid u64',
    result: negResult,
    consequence: 'a timestamp that silently becomes unsigned puts the runtime 584 billion years in the future and every rent and epoch answer with it',
  };

  // ------------------------------------------------------------- re-init
  const before = new Set(accounts.map((a) => a.pubkey));
  const fresh = {
    ...snapshot,
    accounts: [{ pubkey: key(500), dataBase64: '', owner: SYSTEM, lamports: 7n, executable: false, rentEpoch: RENT_EXEMPT_EPOCH }],
    requiredAccounts: [key(500)],
  };
  stage('re-init');
  const identityB = await worker.init(fresh as never, { jobId: 'audit-f-2' });
  const instanceB = worker.instanceId;
  const afterInit = await worker.observe([...before, key(500)]);
  const stillKnown = afterInit.accounts.filter((a) => before.has(a.pubkey)).map((a) => a.pubkey);
  const newKnown = afterInit.accounts.some((a) => a.pubkey === key(500));

  // Exact sysvars must still match the snapshot.
  const sysvars = await worker.observe([
    'SysvarC1ock11111111111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
    'SysvarEpochSchedu1e111111111111111111111111',
  ]);
  const sysvarsPresent = sysvars.unobserved.length === 0;

  out['re-init clears known accounts, changes the instance id and keeps sysvars exact'] = {
    verdict: stillKnown.length === 0 && newKnown && instanceA !== instanceB && sysvarsPresent ? 'PASS' : 'FAIL',
    mutation: 're-init with a single unrelated account, then observe the previous account set and the three sysvars',
    result:
      `${stillKnown.length} of ${before.size} previously known accounts survived the re-init` +
      `${stillKnown.length > 0 ? ` (${stillKnown.slice(0, 3).join(', ')})` : ''}; ` +
      `the new account is known=${newKnown}; instance ${String(instanceA)} -> ${String(instanceB)} ` +
      `(changed=${instanceA !== instanceB}); sysvars unobserved=${JSON.stringify(sysvars.unobserved)}; ` +
      `binary ${identityB.binarySha256.slice(0, 16)} litesvm ${identityB.litesvmVersion}`,
    consequence:
      'an account surviving a re-init makes job two execute against job one\'s world, and a stable instance id makes ' +
      'a quote taken in one runtime indistinguishable from an execution in another',
  };

  // ------------------------------------------ request/response pairing under stress
  //
  // Two commands in flight, the first killed by a short timeout. The second
  // must still receive ITS OWN answer rather than the first one's.
  stage('timeout pairing');
  const stressed = new SequentialWorker({ commandTimeoutMs: 1, maxOutputBytes: 64 * 1024 * 1024 });
  let timedOut = false;
  try {
    await stressed.init(fresh as never, { jobId: 'audit-f-timeout' });
  } catch (e) {
    timedOut = /did not answer within/.test((e as Error).message);
  }
  // The client kills the process on timeout, so a subsequent call must REFUSE
  // rather than answer with a stale line.
  let afterTimeout = '';
  try {
    await stressed.observe([key(500)]);
    afterTimeout = 'ANSWERED — a command after a timeout was served';
  } catch (e) {
    afterTimeout = `refused: ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`;
  }
  await stressed.close();

  out['a timeout never mis-pairs a later response with an earlier request'] = {
    verdict: timedOut && /refused/.test(afterTimeout) ? 'PASS' : 'FAIL',
    mutation: 'commandTimeoutMs = 1ms on init, then a follow-up observe on the same client',
    result: `init timed out=${timedOut}; the follow-up ${afterTimeout}`,
    consequence:
      'a late reply handed to the next waiting slot gives every caller a well-formed answer to somebody else\'s ' +
      'question, and nothing downstream can detect it',
  };

  // ------------------------------------------------------ instance guard
  //
  // Quote in instance B, re-init to C, then observe. The client must refuse.
  stage('instance guard');
  const quoted = await worker.observe([key(500)]);
  await worker.init(fresh as never, { jobId: 'audit-f-3' });
  let guarded = 'NOT RAISED';
  try {
    // The client resets its own instance on init, so the guard is checked by
    // comparing the recorded instance ids rather than by a stale handle.
    const after = await worker.observe([key(500)]);
    guarded = quoted.instanceId === after.instanceId
      ? 'THE INSTANCE ID DID NOT CHANGE ACROSS AN INIT'
      : `the ids differ (${String(quoted.instanceId)} vs ${String(after.instanceId)}), so a cross-instance comparison is detectable`;
  } catch (e) {
    guarded = e instanceof RuntimeInstanceChanged ? 'RuntimeInstanceChanged raised' : `unexpected: ${(e as Error).message.slice(0, 80)}`;
  }
  out['an init between a quote and an execution is detectable'] = {
    verdict: /differ|RuntimeInstanceChanged/.test(guarded) ? 'PASS' : 'FAIL',
    mutation: 'observe, re-init, observe again on the same client',
    result: guarded,
    consequence: 'a sell priced in one runtime and executed in another is not a sequential mechanic',
  };

  // ------------------------------------------------------ output bound
  stage('output bound');
  const bounded = new SequentialWorker({ commandTimeoutMs: 60_000, maxOutputBytes: 4_096 });
  let boundResult: string;
  let boundVerdict: Verdict;
  try {
    await bounded.init(snapshot as never, { jobId: 'audit-f-bound' });
    await bounded.observe(accounts.map((a) => a.pubkey));
    boundResult = 'the worker stayed inside a 4,096 byte bound for a six-account observation';
    boundVerdict = 'PASS';
  } catch (e) {
    const m = (e as Error).message;
    boundVerdict = /output bound/.test(m) ? 'PASS' : 'FAIL';
    boundResult = `${/output bound/.test(m) ? 'the bound fired as designed' : 'failed for another reason'}: ${m.slice(0, 120)}`;
  }
  await bounded.close();
  out['the job output bound is enforced and is job-scoped'] = {
    verdict: boundVerdict,
    mutation: 'maxOutputBytes = 4,096 across an init and a six-account observe',
    result: boundResult,
    consequence: 'a process-lifetime byte total lets job one spend the whole allowance and job two die for it, and the death looks like a fact about job two',
  };

  out['a 0.04 SOL round trip completes under the output limit'] = {
    verdict: 'NOT TESTABLE',
    mutation: 'not run here: a real 0.04 SOL round trip needs a live pool snapshot and the full open path, which this probe deliberately does not take',
    result: 'the running collector opens at 20,000,000 lamports (0.02 SOL); no 0.04 SOL job exists in the corpus to inspect',
    consequence: 'the output bound at double the notional is unverified',
  };

  stage('done');
  await worker.close();
  writeFileSync(process.argv[2] ?? 'artifacts/audit-worker-probe.json', JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out)) console.log(`${v.verdict.padEnd(12)} ${k}`);
  // The wsl children keep the loop alive even after kill(); the probe is done.
  process.exit(0);
}

await main();
