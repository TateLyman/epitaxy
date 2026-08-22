/**
 * How many slots pass between us sending a transaction and it landing?
 *
 * This is the question Jito is actually relevant to, and it can be answered from trades already
 * made rather than new ones. `artifacts/live-trades.jsonl` records the local time of every `sent`
 * event; the chain records the slot each signature landed in. The gap between them is our real
 * submission-to-inclusion latency, in the unit the decay curve uses.
 *
 * WHY IT DECIDES THE JITO QUESTION. MT145 established that we learn of a trade at the tip — median
 * one slot AHEAD of what a getSlot round trip reports. So when a trigger lands early in slot N we
 * may still be inside slot N when we could submit. Whether we can JOIN that block then depends
 * entirely on submission-to-inclusion:
 *
 *   If we routinely land in the slot we submitted during, same-block backrunning is physically
 *   open and the 94 bps at zero delay is reachable.
 *   If we routinely land one or more slots later, it is not, and no bundle service changes that —
 *   a bundle cannot be inserted into a block that has already been produced.
 *
 * Read-only. Looks up signatures we already sent; signs nothing and sends nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadSecrets } from '../packages/domain/src/config.js';

const LOG = 'artifacts/live-trades.jsonl';
const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
if (RPC === null) { console.error('no RPC'); process.exit(2); }
if (!existsSync(LOG)) { console.error(`no ${LOG}`); process.exit(2); }

interface Sent { ts: number; sig: string; label: string }
const sent: Sent[] = [];
const rl = createInterface({ input: createReadStream(LOG, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  let r: { ts?: string; event?: string; signature?: string; label?: string };
  try { r = JSON.parse(line); } catch { continue; }
  if (r.event !== 'sent' || r.signature === undefined || r.ts === undefined) continue;
  sent.push({ ts: Date.parse(r.ts), sig: r.signature, label: (r.label ?? '').trim() });
}
rl.close();

console.log(`SUBMISSION TO INCLUSION — measured on ${sent.length} transactions we already sent`);
console.log('');

async function rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const r = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json()) as { result?: T };
    return j.result ?? null;
  } catch { return null; }
}

/**
 * The slot the chain was on at a past wall-clock instant, recovered from block times. Solana
 * block times have one-second resolution, which is coarse — but we are measuring a gap of a few
 * slots at 377ms each, so a one-second uncertainty is stated rather than hidden.
 */
const rows: { label: string; landed: number; blockTimeMs: number; sentTs: number }[] = [];
for (const s of sent) {
  const tx = await rpcCall<{ slot?: number; blockTime?: number }>(
    'getTransaction', [s.sig, { maxSupportedTransactionVersion: 0, encoding: 'json' }],
  );
  if (tx?.slot === undefined) { console.log(`  ${s.label.padEnd(5)} ${s.sig.slice(0, 12)}  not found`); continue; }
  const bt = typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : NaN;
  rows.push({ label: s.label, landed: tx.slot, blockTimeMs: bt, sentTs: s.ts });
  const delta = Number.isFinite(bt) ? ((bt - s.ts) / 1000).toFixed(1) : 'n/a';
  console.log(`  ${s.label.padEnd(5)} slot ${tx.slot}   sent->blockTime ${delta}s`);
  await new Promise((r) => setTimeout(r, 250));
}

if (rows.length === 0) { console.log('no transactions resolved'); process.exit(0); }
const deltas = rows.map((r) => (r.blockTimeMs - r.sentTs) / 1000).filter(Number.isFinite);
deltas.sort((a, b) => a - b);
const p = (f: number): number => deltas[Math.floor(f * (deltas.length - 1))] ?? NaN;
console.log('');
console.log(`SECONDS FROM SEND TO BLOCK TIME   n=${deltas.length}   p10 ${p(0.1).toFixed(1)}s   median ${p(0.5).toFixed(1)}s   p90 ${p(0.9).toFixed(1)}s`);
console.log('  block times have one-second resolution, so read these as seconds, not milliseconds');
console.log('');
const medSlots = p(0.5) * 1000 / 377;
console.log(`  median is about ${medSlots.toFixed(1)} slots of submission-to-inclusion latency`);
console.log('');
console.log('WHAT THIS SAYS ABOUT SAME-BLOCK BACKRUNNING (MT144 gross: 94.0 / 23.2 / 10.5 / 6.0)');
if (medSlots < 1.2) {
  console.log('  We land within about a slot of sending. Same-block is at least ARGUABLE, and a');
  console.log('  direct-to-leader path is worth testing, because the 94 bps at zero delay is real.');
} else {
  console.log(`  We land ~${medSlots.toFixed(1)} slots after sending. The trigger block is long closed by then.`);
  console.log('  A bundle cannot be inserted into a block already produced, so Jito does not reach');
  console.log('  the 94 bps rung. It would improve RELIABILITY of landing in N+1, which is the');
  console.log('  +0.2 bps rung we can already reach without it.');
}
