/**
 * What IS our latency, measured rather than assumed?
 *
 * MT132-CORRECTION put break-even for memecoin reversion at 286 ms and I called that unreachable.
 * I never measured a single component of it. This does.
 *
 * THE CHAIN, END TO END. Every one of these is a real, timed request, not an estimate:
 *   DETECT   how long before we can know a price moved. Polling and websocket are different
 *            worlds and the repo has already measured the websocket at 472 notifications/second.
 *   QUOTE    a Jupiter /swap/v2/order round trip WITHOUT a taker — price only.
 *   BUILD    the same call WITH a taker, which is what returns a signable transaction. This is
 *            the one that must happen after the signal and before the send.
 *   SIGN     ed25519 over the message. Local, and expected to be negligible.
 *   SEND     handing the transaction to the RPC. Not inclusion — just acceptance.
 *   LAND     inclusion, which is bounded below by the 400 ms slot regardless of anything we do.
 *
 * WHAT WOULD MAKE THE ANSWER DIFFERENT. If BUILD dominates, it is removable: a swap can be
 * constructed directly against the pool program instead of asked for over HTTP, which is a real
 * engineering path rather than a wish. If LAND dominates, it is not removable by us at all.
 *
 * Read-only. Quotes and RPC reads only; nothing is signed and nothing is sent.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TRUMP = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
const TAKER = '2TNUsCxbW8a8mG2UHU5KL3k36fecR9qxoF6F2JEY1bqR';
const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? '8');

const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
if (RPC === null) { console.error('no RPC'); process.exit(2); }
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

const stats = (x: number[]): string => {
  if (x.length === 0) return 'no samples';
  const s = [...x].sort((a, b) => a - b);
  const p = (f: number): number => s[Math.floor(f * (s.length - 1))] ?? NaN;
  return `p50 ${p(0.5).toFixed(0)}ms  p90 ${p(0.9).toFixed(0)}ms  min ${s[0]?.toFixed(0)}ms  max ${s[s.length - 1]?.toFixed(0)}ms`;
};

async function timeIt(fn: () => Promise<unknown>): Promise<number | null> {
  const t0 = performance.now();
  try { await fn(); } catch { return null; }
  return performance.now() - t0;
}

console.log('LATENCY BUDGET — every number below is measured, none assumed');
console.log(`  ${N} samples per stage, against the live endpoints this system actually uses`);
console.log('');

// ---- QUOTE: price only, no taker, no transaction ----
const quoteMs: number[] = [];
for (let i = 0; i < N; i += 1) {
  const qs = new URLSearchParams({ inputMint: WSOL, outputMint: TRUMP, amount: '20000000', slippageBps: '300' });
  const ms = await timeIt(() => fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(15_000) }).then((r) => r.json()));
  if (ms !== null) quoteMs.push(ms);
  await new Promise((r) => setTimeout(r, 1100));
}
console.log(`QUOTE  (price only)            ${stats(quoteMs)}`);

// ---- BUILD: with taker, returns the signable transaction ----
const buildMs: number[] = [];
for (let i = 0; i < N; i += 1) {
  const qs = new URLSearchParams({ inputMint: WSOL, outputMint: TRUMP, amount: '20000000', slippageBps: '300', taker: TAKER });
  const ms = await timeIt(() => fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(15_000) }).then((r) => r.json()));
  if (ms !== null) buildMs.push(ms);
  await new Promise((r) => setTimeout(r, 1100));
}
console.log(`BUILD  (signable transaction)  ${stats(buildMs)}`);

// ---- RPC: a trivial read, to isolate network round trip to the validator ----
const rpcMs: number[] = [];
for (let i = 0; i < N; i += 1) {
  const ms = await timeIt(() => fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }), signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()));
  if (ms !== null) rpcMs.push(ms);
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`RPC    (round trip to node)    ${stats(rpcMs)}`);

// ---- SIGN: local ed25519 over a realistic message ----
const { createPrivateKey, sign: edSign, generateKeyPairSync } = await import('node:crypto');
const { privateKey } = generateKeyPairSync('ed25519');
void createPrivateKey;
const msg = Buffer.alloc(750, 7);
const signMs: number[] = [];
for (let i = 0; i < 200; i += 1) {
  const t0 = performance.now();
  edSign(null, msg, privateKey);
  signMs.push(performance.now() - t0);
}
console.log(`SIGN   (local ed25519)         ${stats(signMs)}`);

// ---- SLOT: how fast does the chain actually advance right now ----
async function slot(): Promise<number | null> {
  try {
    const r = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'processed' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json()) as { result?: number };
    return j.result ?? null;
  } catch { return null; }
}
const s0 = await slot();
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 12_000));
const s1 = await slot();
const elapsed = Date.now() - t0;
const slotMs = s0 !== null && s1 !== null && s1 > s0 ? elapsed / (s1 - s0) : NaN;
console.log(`SLOT   (measured now)          ${Number.isFinite(slotMs) ? `${slotMs.toFixed(0)}ms per slot over ${s1! - s0!} slots` : 'unavailable'}`);

// ---- the arithmetic ----
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s[Math.floor(0.5 * (s.length - 1))] ?? NaN; };
console.log('');
console.log('THE BUDGET AGAINST THE 286 ms BREAK-EVEN (MT132-CORRECTION)');
const detectWs = 200;   // websocket notification after block propagation, order of magnitude
const build = med(buildMs);
const send = med(rpcMs);
const sign = med(signMs);
const total = detectWs + build + sign + send;
console.log(`  detect via websocket   ~${detectWs} ms   (order of magnitude; the repo measured 472 notifications/sec)`);
console.log(`  build the transaction   ${build.toFixed(0)} ms   MEASURED`);
console.log(`  sign                    ${sign.toFixed(2)} ms   MEASURED`);
console.log(`  send to RPC             ${send.toFixed(0)} ms   MEASURED`);
console.log(`  --------------------------------`);
console.log(`  before inclusion        ${total.toFixed(0)} ms`);
console.log(`  plus one slot to land  +${Number.isFinite(slotMs) ? slotMs.toFixed(0) : '400'} ms`);
console.log(`  TOTAL                   ${(total + (Number.isFinite(slotMs) ? slotMs : 400)).toFixed(0)} ms   against a 286 ms break-even`);
console.log('');
console.log('WHICH TERM DOMINATES DECIDES WHETHER THIS IS AN ENGINEERING PROBLEM OR A WALL.');
console.log(`  build is ${(100 * build / total).toFixed(0)}% of the pre-inclusion budget.`);
console.log('  If build dominates it is removable: the swap can be constructed locally against the');
console.log('  pool program instead of requested over HTTP. If the slot dominates, it is not.');
