/**
 * MT141, done the way a real system would have to do it.
 *
 * THE PROBLEM WITH THE PURE EXECUTABLE TAPE. Measuring a 20-second lookback needs price samples
 * closer together than 20 seconds. An executable quote costs two API calls, so eight tokens come
 * round only every ~34 seconds — the signal MT140 found cannot even be expressed on that tape.
 * Cutting to two tokens would fix the cadence and destroy the sample size.
 *
 * THE RESOLUTION IS NOT A COMPROMISE, IT IS THE ACTUAL ARCHITECTURE. A live system would watch the
 * cheap fast feed to decide WHEN to act, and pay executable prices to act. So:
 *
 *   SIGNAL comes from `price/v3`, sampled every 4 seconds — the same source MT140 used, and the
 *   same source a real system would watch, because polling executable quotes for thirty tokens at
 *   four-second cadence is not affordable at any rate limit.
 *   ENTRY AND EXIT come from real `/swap/v2/order` quotes — we BUY at the ask and SELL at the bid,
 *   both from tapes collected simultaneously with the feed.
 *
 * This is the honest question. Not "does the feed mean-revert against itself", which MT140 already
 * answered yes and which a lagging feed would answer yes to for free — but "does a dip visible in
 * the feed predict a profitable round trip at prices we can actually get". If the feed's dip is an
 * artifact of its own construction, the executable return after it will be nothing.
 *
 * NO COST MODEL IS APPLIED. The spread is crossed inside the measurement: buy at ask, sell at bid.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const EXEC = arg('exec') ?? 'data/executable-tape.jsonl';
const FEED = arg('feed') ?? 'data/tape-parallel.jsonl';
const TRIGGER_BPS = Number(arg('trigger') ?? '25');
const LOOKBACK_S = Number(arg('lookback') ?? '20');
const HORIZON_S = Number(arg('horizon') ?? '60');
/** How far an executable quote may be from the moment the signal fired before it is unusable. */
const MATCH_TOLERANCE_S = Number(arg('tolerance') ?? '20');

if (!existsSync(EXEC) || !existsSync(FEED)) { console.error('need both tapes'); process.exit(2); }

interface Q { ts: number; buy: number; sell: number }
interface F { ts: number; p: number }
const exec = new Map<string, Q[]>();
const feed = new Map<string, F[]>();
const syms = new Map<string, string>();

{
  const rl = createInterface({ input: createReadStream(EXEC, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: { ts: number; mint: string; sym: string; buyPrice: number; sellPrice: number };
    try { r = JSON.parse(line); } catch { continue; }
    if (!(r.buyPrice > 0) || !(r.sellPrice > 0)) continue;
    const a = exec.get(r.mint) ?? []; a.push({ ts: r.ts, buy: r.buyPrice, sell: r.sellPrice }); exec.set(r.mint, a);
  }
  rl.close();
}
{
  const rl = createInterface({ input: createReadStream(FEED, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: { ts: number; mint: string; sym: string; solPrice: number };
    try { r = JSON.parse(line); } catch { continue; }
    if (!(r.solPrice > 0)) continue;
    const a = feed.get(r.mint) ?? []; a.push({ ts: r.ts, p: r.solPrice }); feed.set(r.mint, a);
    syms.set(r.mint, r.sym);
  }
  rl.close();
}
for (const a of exec.values()) a.sort((x, y) => x.ts - y.ts);
for (const a of feed.values()) a.sort((x, y) => x.ts - y.ts);

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const stdev = (x: number[]): number => {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / (x.length - 1));
};
const tstat = (x: number[]): number => (x.length > 1 ? mean(x) / (stdev(x) / Math.sqrt(x.length)) : NaN);

/** Nearest executable quote to `t`, or null if none within tolerance. */
function nearestQuote(a: Q[], t: number): Q | null {
  let best: Q | null = null; let bestD = Infinity;
  for (const q of a) {
    const d = Math.abs(q.ts - t);
    if (d < bestD) { bestD = d; best = q; }
    if (q.ts > t + MATCH_TOLERANCE_S * 1000) break;
  }
  return best !== null && bestD <= MATCH_TOLERANCE_S * 1000 ? best : null;
}

const trig: number[] = [];
const rand: number[] = [];
let considered = 0;

for (const [mint, ex] of exec) {
  const fd = feed.get(mint);
  if (fd === undefined || fd.length < 20 || ex.length < 4) continue;
  let busyUntil = -1;
  for (let i = 0; i < fd.length; i += 1) {
    const now = fd[i] as F;
    if (now.ts < busyUntil) continue;
    // signal, from the feed
    let j = i; while (j > 0 && now.ts - (fd[j] as F).ts < LOOKBACK_S * 1000) j -= 1;
    if (j === i) continue;
    const past = fd[j] as F;
    const signalBps = 1e4 * (now.p / past.p - 1);

    // entry and exit, from executable quotes
    const entry = nearestQuote(ex, now.ts);
    if (entry === null) continue;
    const exit = nearestQuote(ex, now.ts + HORIZON_S * 1000);
    if (exit === null || exit.ts <= entry.ts) continue;

    busyUntil = now.ts + HORIZON_S * 1000;
    considered += 1;
    // Buy at the ask, sell at the bid. The spread is paid inside this number.
    const net = 1e4 * (exit.sell / entry.buy - 1);
    rand.push(net);
    if (signalBps <= -TRIGGER_BPS) trig.push(net);
  }
}

console.log('MT141 HYBRID — signal from the feed, fills at executable quotes');
console.log(`  prediction recorded before running: near zero or negative`);
console.log(`  rule: reversion, trigger ${TRIGGER_BPS} bps, lookback ${LOOKBACK_S}s, horizon ${HORIZON_S}s`);
console.log(`  tokens ${[...exec.keys()].filter((m) => feed.has(m)).length}, windows considered ${considered}`);
console.log(`  buy at ask, sell at bid — NO cost model applied anywhere`);
console.log('');
console.log('  arm              n      mean bps     stdev      t');
console.log(`  random     ${String(rand.length).padStart(7)}  ${mean(rand).toFixed(1).padStart(11)}  ${stdev(rand).toFixed(1).padStart(8)}  ${tstat(rand).toFixed(2).padStart(6)}`);
console.log(`  reversion  ${String(trig.length).padStart(7)}  ${mean(trig).toFixed(1).padStart(11)}  ${stdev(trig).toFixed(1).padStart(8)}  ${tstat(trig).toFixed(2).padStart(6)}`);
if (trig.length >= 20 && rand.length >= 20) {
  console.log(`  edge over random ${(mean(trig) - mean(rand)).toFixed(1)} bps`);
}
console.log('');
if (trig.length < 30) {
  console.log('VERDICT: UNDERPOWERED — fewer than 30 triggers. Not read, and not counted either way.');
} else if (mean(trig) > 0 && tstat(trig) > 2) {
  console.log('VERDICT: SURVIVES on executable fills. The signal is not a feed artifact.');
  console.log('  Even so this is ONE tape. It needs a fresh one before capital moves.');
} else {
  console.log('VERDICT: DOES NOT SURVIVE. The MT140 result does not reach executable prices,');
  console.log('  which is what a feed-construction artifact looks like from the outside.');
}
