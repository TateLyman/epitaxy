/**
 * How fast do we actually learn that a trade happened?
 *
 * MT143 budgeted "detect ~200ms" as an order of magnitude and never measured it. It is the last
 * unmeasured term in the latency chain, and it is the one the operator can most plausibly improve
 * by paying for better tooling — so it is worth a real number rather than a guess.
 *
 * THE MEASUREMENT. Subscribe to the venue's program logs over websocket. Every notification
 * carries the slot it belongs to. Ask the node, separately, for the timestamp of that slot's block.
 * The difference between our local receive time and the block time is how far behind the chain we
 * are when we first COULD act.
 *
 * WHY THIS IS THE RIGHT QUANTITY AND NOT A ROUND TRIP. A round-trip ping measures the network. This
 * measures the whole path that matters: block production, propagation to our RPC provider, their
 * processing, and delivery to us. A trigger we learn about 400ms late is one slot gone before any
 * decision is made, and no amount of fast building recovers it.
 *
 * Read-only. Subscribes and reads; nothing is signed.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? '90');

const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
const WS = secrets.rpcWs ?? (RPC === null ? null : RPC.replace(/^http/, 'ws'));
if (RPC === null || WS === null) { console.error('no RPC/WS configured'); process.exit(2); }

async function blockTimeMs(slot: number): Promise<number | null> {
  try {
    const r = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [slot] }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await r.json()) as { result?: number };
    return typeof j.result === 'number' ? j.result * 1000 : null;
  } catch { return null; }
}

console.log('DETECTION LATENCY — how far behind the chain are we when a trade first reaches us?');
console.log(`  subscribing to ${PUMPSWAP} logs for ${SECONDS}s`);
console.log('');

const seen = new Map<number, number>();   // slot -> earliest local receive time
let notifications = 0;

const ws = new WebSocket(WS);
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws open timeout')), 15_000);
  ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
  ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(String(e))); });
});
ws.send(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
  params: [{ mentions: [PUMPSWAP] }, { commitment: 'processed' }],
}));

ws.addEventListener('message', (ev) => {
  const now = Date.now();
  let j: { params?: { result?: { context?: { slot?: number } } } };
  try { j = JSON.parse(String(ev.data)); } catch { return; }
  const slot = j.params?.result?.context?.slot;
  if (typeof slot !== 'number') return;
  notifications += 1;
  if (!seen.has(slot)) seen.set(slot, now);
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));
ws.close();

console.log(`notifications ${notifications.toLocaleString()} across ${seen.size} distinct slots`);
if (seen.size < 5) { console.log('too few slots to measure'); process.exit(0); }

// Sample slots from the middle of the run so startup and shutdown do not skew it.
const slots = [...seen.keys()].sort((a, b) => a - b);
const sample = slots.slice(Math.floor(slots.length * 0.2), Math.floor(slots.length * 0.8)).slice(0, 25);
const lags: number[] = [];
for (const s of sample) {
  const bt = await blockTimeMs(s);
  const local = seen.get(s);
  if (bt === null || local === undefined) continue;
  lags.push(local - bt);
  await new Promise((r) => setTimeout(r, 120));
}

if (lags.length < 5) { console.log('could not resolve enough block times'); process.exit(0); }
lags.sort((a, b) => a - b);
const p = (f: number): number => lags[Math.floor(f * (lags.length - 1))] ?? NaN;
console.log('');
console.log('LAG FROM BLOCK TIME TO OUR RECEIPT');
console.log(`  n=${lags.length}   p10 ${p(0.1).toFixed(0)}ms   p50 ${p(0.5).toFixed(0)}ms   p90 ${p(0.9).toFixed(0)}ms   max ${p(1).toFixed(0)}ms`);
console.log('');
console.log('  NOTE: getBlockTime has one-second resolution, so these figures carry up to');
console.log('  1000ms of quantisation. They bound the order of magnitude, not the millisecond.');
console.log('');
const med = p(0.5);
console.log('AGAINST THE 377ms SLOT');
console.log(`  detection at ~${med.toFixed(0)}ms is ${(med / 377).toFixed(2)} slots`);
console.log(`  build locally (0ms) + send (40ms) => submit at ~${(med + 40).toFixed(0)}ms`);
console.log(`  that lands in slot +${Math.ceil((med + 40) / 377)} at best`);
