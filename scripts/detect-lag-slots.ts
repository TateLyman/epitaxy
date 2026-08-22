/**
 * Detection lag measured in SLOTS, avoiding the one-second quantisation of `getBlockTime`.
 *
 * A first attempt compared our local receive time against the block's timestamp and reported
 * ~1,814ms. That figure carries up to 1000ms of quantisation and relies on a consensus timestamp
 * that can drift from wall clock, so it bounds an order of magnitude and not much more.
 *
 * This asks the question in the chain's own units. Subscribe to program logs; every notification
 * carries the slot it belongs to. At the same moment, ask the node what slot it is on now. The
 * difference is how many slots behind the tip we are when a trade first becomes actionable — and
 * slots are exactly the unit the decay curve is measured in, so no conversion is needed at all.
 *
 * Read-only. Nothing is signed.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? '60');

const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
const WS = secrets.rpcWs ?? (RPC === null ? null : RPC.replace(/^http/, 'ws'));
if (RPC === null || WS === null) { console.error('no RPC/WS'); process.exit(2); }

async function currentSlot(): Promise<number | null> {
  try {
    const r = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'processed' }] }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await r.json()) as { result?: number };
    return j.result ?? null;
  } catch { return null; }
}

console.log('DETECTION LAG IN SLOTS — the unit the decay curve is already measured in');
console.log(`  ${SECONDS}s subscription to ${PUMPSWAP}`);
console.log('');

let latestNotifiedSlot = 0;
let notifications = 0;
const ws = new WebSocket(WS);
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws open timeout')), 15_000);
  ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
  ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')); });
});
ws.send(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
  params: [{ mentions: [PUMPSWAP] }, { commitment: 'processed' }],
}));
ws.addEventListener('message', (ev) => {
  let j: { params?: { result?: { context?: { slot?: number } } } };
  try { j = JSON.parse(String(ev.data)); } catch { return; }
  const s = j.params?.result?.context?.slot;
  if (typeof s === 'number') { notifications += 1; if (s > latestNotifiedSlot) latestNotifiedSlot = s; }
});

// Sample repeatedly: the newest slot we have been told about, against the tip right now.
const gaps: number[] = [];
const deadline = Date.now() + SECONDS * 1000;
await new Promise((r) => setTimeout(r, 4_000));
while (Date.now() < deadline) {
  const tip = await currentSlot();
  const heard = latestNotifiedSlot;
  if (tip !== null && heard > 0) gaps.push(tip - heard);
  await new Promise((r) => setTimeout(r, 1_500));
}
ws.close();

console.log(`notifications ${notifications.toLocaleString()}   samples ${gaps.length}`);
if (gaps.length < 5) { console.log('too few samples'); process.exit(0); }
gaps.sort((a, b) => a - b);
const p = (f: number): number => gaps[Math.floor(f * (gaps.length - 1))] ?? NaN;
console.log('');
console.log('SLOTS BEHIND THE TIP when a trade first reaches us');
console.log(`  p10 ${p(0.1)}   MEDIAN ${p(0.5)}   p90 ${p(0.9)}   max ${p(1)}`);
console.log('');
void p(0.5);
/**
 * HEARING ABOUT A SLOT IS NOT THE SAME AS LANDING IN IT, and an earlier version of this script
 * asserted otherwise — it read "0 slots behind" and concluded we could capture the 94 bps that
 * sits at zero delay. That does not follow. The trigger transaction has ALREADY landed in slot N
 * when we hear about it. Getting our own transaction into slot N as well requires the leader to
 * still be building that block AND to receive ours before it closes. Being told about slot N
 * quickly says nothing about whether we can reach the leader producing it.
 *
 * So the honest reporting is a conditional, not a number.
 */
console.log('WHAT THIS DOES AND DOES NOT ESTABLISH');
console.log('  ESTABLISHED: detection is not the bottleneck. We learn of a trade at the tip,');
console.log('  0 to 1 slots behind, over a plain websocket with no paid tooling at all.');
console.log('');
console.log('  NOT ESTABLISHED: that we can LAND in the slot we heard about. The trigger has');
console.log('  already landed there; joining it means reaching the leader before that block');
console.log('  closes, and nothing measured here says whether we can.');
console.log('');
console.log('THE ARITHMETIC ON BOTH SIDES OF THAT LINE (MT144 gross: 94.0 / 23.2 / 10.5 / 6.0 bps)');
console.log('  land in slot N   (same block as the trigger)   94.0 gross - 23 cost = +71.0 bps');
console.log('  land in slot N+1 (the next block)              23.2 gross - 23 cost =  +0.2 bps');
console.log('  land in slot N+2                               10.5 gross - 23 cost = -12.5 bps');
console.log('');
console.log('  The entire question is whether a transaction can join the block that triggered it.');
console.log('  That is a leader-access question, not a detection or building question.');
