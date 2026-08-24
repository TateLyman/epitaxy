/**
 * MT199 — is the fee toll really four times lower on graduated pools than on the bonding curve?
 *
 * External data claims the effective toll is about 174 bps on the pump.fun bonding curve against
 * about 39 bps on PumpSwap, with the volume inverted: the curve is 4.2% of Solana DEX volume and
 * PumpSwap is 32.9%. If that holds, this programme has spent its entire life trading the most
 * expensive and most contested four percent of the market, and the right response is to change the
 * population rather than to keep tuning the filter.
 *
 * IT IS AN EXTERNAL CLAIM AND IT GATES A STRATEGY CHANGE, SO IT GETS CHECKED AGAINST OUR OWN BYTES.
 * Every PumpSwap trade in the cache carries its own fee ladder as three separate basis-point fields
 * -- the LP leg, the protocol leg and the coin-creator leg -- recorded by the venue on the trade
 * itself rather than inferred. That is a better measurement than any aggregate: it is per trade, it
 * is ours, and it cannot be distorted by whatever a third party chose to include in "volume".
 *
 * The curve side needs no measurement at all. pump.fun charges a flat 1% per leg, which every
 * script in this repository already applies, so a round trip is 200 bps before price impact. The
 * only open question is what a PumpSwap round trip actually costs.
 *
 * WHAT WOULD MAKE THIS ACTIONABLE. A four-times cheaper venue is worth about 150 bps a round trip,
 * against a strategy whose measured edge is roughly 216 bps a trade. That is not a refinement, it
 * is most of the edge again. But it is only reachable if there is something to trade there, and
 * this file deliberately does NOT answer that -- it prices the toll and nothing else. A cheap venue
 * with no edge is still no edge.
 *
 * Reads the trade cache. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'E,D0,D1,D2').split(',').filter((s) => s.length > 0);
const CACHE = 'data/trade-cache';
/** pump.fun's curve fee, flat, per leg. Not measured because it is a program constant. */
const CURVE_FEE_BPS = 100;

interface Row { lp: number; proto: number; creator: number; quote: number }
const rows: Row[] = [];
let scanned = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  missing ${f}`); continue; }
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    scanned += 1;
    const lp = Number(r[10]); const proto = Number(r[11]); const creator = Number(r[12]);
    const quote = Number(r[8]);
    if (!Number.isFinite(lp) || !Number.isFinite(proto) || !Number.isFinite(creator)) continue;
    if (!(quote > 0)) continue;
    rows.push({ lp, proto, creator, quote });
  }
  rl.close();
}

console.log(`MT199 — what a PumpSwap round trip actually costs, from our own tape`);
console.log(`  ${scanned.toLocaleString()} cached trades, ${rows.length.toLocaleString()} with a readable fee ladder`);
console.log('');

const totalBps = rows.map((r) => r.lp + r.proto + r.creator);
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * Volume-weighted, because that is what an effective rate means. A simple average over trades would
 * let a swarm of dust trades at a high tier outvote the flow that actually moves value.
 */
const totalQuote = rows.reduce((a, r) => a + r.quote, 0);
const vwBps = rows.reduce((a, r) => a + (r.lp + r.proto + r.creator) * r.quote, 0) / totalQuote;

console.log('  PER-LEG CHARGED FEE on PumpSwap, basis points');
console.log(`    volume-weighted mean   ${vwBps.toFixed(1)}`);
console.log(`    unweighted mean        ${mean(totalBps).toFixed(1)}`);
console.log(`    p10 ${q(totalBps, 0.1).toFixed(0)}   p25 ${q(totalBps, 0.25).toFixed(0)}   p50 ${q(totalBps, 0.5).toFixed(0)}   p75 ${q(totalBps, 0.75).toFixed(0)}   p90 ${q(totalBps, 0.9).toFixed(0)}`);
console.log('');
console.log('  the ladder, split by leg (volume-weighted)');
for (const [name, pick] of [['lp', (r: Row) => r.lp], ['protocol', (r: Row) => r.proto], ['creator', (r: Row) => r.creator]] as [string, (r: Row) => number][]) {
  console.log(`    ${name.padEnd(10)} ${(rows.reduce((a, r) => a + pick(r) * r.quote, 0) / totalQuote).toFixed(1)} bps`);
}

/** The distinct tiers actually observed, which is what tells us whether a cheap tier is reachable. */
const tiers = new Map<string, { n: number; vol: number }>();
for (const r of rows) {
  const k = `${r.lp}/${r.proto}/${r.creator}`;
  const t = tiers.get(k) ?? { n: 0, vol: 0 };
  t.n += 1; t.vol += r.quote;
  tiers.set(k, t);
}
console.log('');
console.log('  OBSERVED FEE TIERS (lp/protocol/creator), by share of volume');
const sorted = [...tiers.entries()].sort((a, b) => b[1].vol - a[1].vol).slice(0, 8);
for (const [k, t] of sorted) {
  const sum = k.split('/').reduce((a, b) => a + Number(b), 0);
  console.log(`    ${k.padEnd(14)} total ${String(sum).padStart(4)} bps   ${((100 * t.vol) / totalQuote).toFixed(1).padStart(5)}% of volume   ${t.n.toLocaleString()} trades`);
}

console.log('');
console.log('  ROUND TRIP COMPARISON');
console.log(`    pump.fun bonding curve   ${2 * CURVE_FEE_BPS} bps   (flat 1% per leg, a program constant)`);
console.log(`    PumpSwap                 ${(2 * vwBps).toFixed(0)} bps   (measured, volume-weighted, both legs)`);
const saving = 2 * CURVE_FEE_BPS - 2 * vwBps;
console.log(`    difference               ${saving.toFixed(0)} bps per round trip in PumpSwap's favour`);
console.log('');
console.log('  Against a measured edge of roughly 216 bps a trade, a saving of this size is not a');
console.log('  refinement. But a cheaper venue is only worth reaching if there is an edge there, and');
console.log('  this file prices the toll and nothing else.');
