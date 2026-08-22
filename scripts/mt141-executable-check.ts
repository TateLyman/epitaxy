/**
 * MT141 — is the 20-second reversion in prices we could trade at, or only in the feed?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT141 before this file existed, including the
 * prediction that it comes back near zero.
 *
 * MT140 passed all three of its frozen tests on a third non-overlapping tape: +32.1 bps after
 * cost, the lookback gradient intact, reversion beating momentum 26 cells to 1. But that tape is
 * `price/v3`, an aggregate USD price on an ~8 second refresh that nobody can trade at. If it LAGS
 * the true price, a measured dip is partly a move that already happened and the recovery is the
 * feed catching up — an artifact that is STRONGEST AT THE SHORTEST LOOKBACK and therefore
 * reproduces the exact gradient MT140 reported as evidence FOR the hypothesis.
 *
 * Two stories, same data. They differ on one thing: whether the pattern exists in executable price.
 *
 * NO COST MODEL ENTERS ANYWHERE, which is the cleanest property of this design. Entry is the BUY
 * quote — what we would actually pay — and exit is the SELL quote — what we would actually
 * receive. The spread is crossed inside the measurement. On the aggregate tape a 17.3 bps cost had
 * to be subtracted, and that figure rested on four live rounds; here nothing is assumed.
 *
 * A SECOND, INDEPENDENT TEST IS RUN: the lead-lag between the two feeds, measured on tapes
 * collected simultaneously. If `price/v3` lags executable price, that is the artifact directly
 * observed rather than inferred, and it would explain MT140 without any reversion existing at all.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const EXEC = arg('exec') ?? 'data/executable-tape.jsonl';
const FEED = arg('feed') ?? 'data/tape-parallel.jsonl';
/** MT140 primary, unchanged. The only thing that differs is the price source. */
const TRIGGER_BPS = Number(arg('trigger') ?? '25');
const LOOKBACK_S = Number(arg('lookback') ?? '20');
const HORIZON_S = Number(arg('horizon') ?? '60');

interface Q { ts: number; buy: number; sell: number }
const exec = new Map<string, Q[]>();
const syms = new Map<string, string>();

if (!existsSync(EXEC)) { console.error(`no executable tape at ${EXEC}`); process.exit(2); }
{
  const rl = createInterface({ input: createReadStream(EXEC, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: { ts: number; mint: string; sym: string; buyPrice: number; sellPrice: number };
    try { r = JSON.parse(line); } catch { continue; }
    if (!(r.buyPrice > 0) || !(r.sellPrice > 0)) continue;
    const a = exec.get(r.mint) ?? [];
    a.push({ ts: r.ts, buy: r.buyPrice, sell: r.sellPrice });
    exec.set(r.mint, a);
    syms.set(r.mint, r.sym);
  }
  rl.close();
}
for (const a of exec.values()) a.sort((x, y) => x.ts - y.ts);

const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const stdev = (x: number[]): number => {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / (x.length - 1));
};

const spans = [...exec.values()].map((a) => ((a[a.length - 1]?.ts ?? 0) - (a[0]?.ts ?? 0)) / 60_000);
console.log('MT141 — the same rule, priced on quotes we could actually trade at');
console.log(`  prediction recorded before running: near zero or negative`);
console.log(`  rule: reversion, trigger ${TRIGGER_BPS} bps, lookback ${LOOKBACK_S}s, horizon ${HORIZON_S}s`);
console.log(`  tokens ${exec.size}, ${[...exec.values()].reduce((n, a) => n + a.length, 0)} quote pairs, ${Math.max(...spans, 0).toFixed(0)} minutes`);
console.log(`  spread crossed inside the measurement — NO cost model is applied anywhere`);
console.log('');

/** Latest observation at or before t, scanning forward from a hint. */
function at(a: Q[], t: number, from: number): number {
  let i = from;
  while (i + 1 < a.length && (a[i + 1] as Q).ts <= t) i += 1;
  const e = a[i];
  return e !== undefined && e.ts <= t ? i : -1;
}

/**
 * SIGNAL IS MEASURED ON THE MID, ENTRY AND EXIT ON THE TRADEABLE SIDES.
 * Using the buy price for the signal too would let the spread itself trigger the rule: a widening
 * spread would read as a price fall and then "revert" as it narrowed, which is a second artifact
 * on top of the one being tested.
 */
const mid = (q: Q): number => (q.buy + q.sell) / 2;

const rets: number[] = [];
const randomRets: number[] = [];
for (const [, a] of exec) {
  if (a.length < 8) continue;
  let iPast = 0; let iFwd = 0; let busyUntil = -1;
  for (let i = 0; i < a.length; i += 1) {
    const now = a[i] as Q;
    if (now.ts < busyUntil) continue;                       // non-overlapping windows only
    const ip = at(a, now.ts - LOOKBACK_S * 1000, iPast);
    if (ip < 0 || ip === i) continue;
    iPast = ip;
    const ifw = at(a, now.ts + HORIZON_S * 1000, iFwd < i ? i : iFwd);
    if (ifw <= i) continue;
    iFwd = ifw;
    const fwd = a[ifw] as Q;
    if (fwd.ts < now.ts + HORIZON_S * 1000 * 0.7) continue; // must genuinely reach the horizon

    busyUntil = now.ts + HORIZON_S * 1000;
    const past = a[ip] as Q;
    const signalBps = 1e4 * (mid(now) / mid(past) - 1);
    // Buy at the ask now, sell at the bid later. This IS the round trip, spread included.
    const net = 1e4 * (fwd.sell / now.buy - 1);
    randomRets.push(net);
    if (signalBps <= -TRIGGER_BPS) rets.push(net);
  }
}

const t = (x: number[]): number => (x.length > 1 ? mean(x) / (stdev(x) / Math.sqrt(x.length)) : NaN);
console.log('RESULT — executable prices, non-overlapping windows, no assumed cost');
console.log(`  random entry   n=${String(randomRets.length).padStart(5)}   mean ${mean(randomRets).toFixed(1).padStart(8)} bps   t ${t(randomRets).toFixed(2)}`);
console.log(`  reversion      n=${String(rets.length).padStart(5)}   mean ${mean(rets).toFixed(1).padStart(8)} bps   t ${t(rets).toFixed(2)}`);
if (rets.length >= 20 && randomRets.length >= 20) {
  console.log(`  edge over random          ${(mean(rets) - mean(randomRets)).toFixed(1)} bps`);
}
console.log('');
const verdict = rets.length < 20
  ? 'UNDERPOWERED — too few triggers to read'
  : mean(rets) > 0 && t(rets) > 2
    ? 'SURVIVES on executable prices'
    : 'DOES NOT SURVIVE on executable prices';
console.log(`VERDICT: ${verdict}`);

// ---- the direct artifact test: does the aggregate feed lag executable price? ----
if (existsSync(FEED)) {
  interface F { ts: number; p: number }
  const feed = new Map<string, F[]>();
  const rl = createInterface({ input: createReadStream(FEED, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: { ts: number; mint: string; solPrice: number };
    try { r = JSON.parse(line); } catch { continue; }
    if (!(r.solPrice > 0)) continue;
    const a = feed.get(r.mint) ?? [];
    a.push({ ts: r.ts, p: r.solPrice });
    feed.set(r.mint, a);
  }
  rl.close();
  for (const a of feed.values()) a.sort((x, y) => x.ts - y.ts);

  console.log('');
  console.log('DIRECT ARTIFACT TEST — does the aggregate feed LAG executable price?');
  console.log('  correlation of feed change over the NEXT interval against executable change over');
  console.log('  the LAST one. A lagging feed shows a POSITIVE correlation: it is still catching up.');
  console.log('  token       n   corr(feed_next, exec_prev)');
  const all: number[] = [];
  for (const [mint, ex] of exec) {
    const fd = feed.get(mint);
    if (fd === undefined || fd.length < 20 || ex.length < 8) continue;
    const xs: number[] = []; const ys: number[] = [];
    let hint = 0;
    for (let i = 1; i < ex.length; i += 1) {
      const prev = ex[i - 1] as Q; const cur = ex[i] as Q;
      const execChg = mid(cur) / mid(prev) - 1;
      // feed value at the executable timestamp, and one interval later
      let j = hint; while (j + 1 < fd.length && (fd[j + 1] as F).ts <= cur.ts) j += 1;
      hint = j;
      let k = j; const target = cur.ts + (cur.ts - prev.ts);
      while (k + 1 < fd.length && (fd[k + 1] as F).ts <= target) k += 1;
      if (k <= j) continue;
      const f0 = fd[j] as F; const f1 = fd[k] as F;
      const feedNext = f1.p / f0.p - 1;
      if (!Number.isFinite(execChg) || !Number.isFinite(feedNext)) continue;
      xs.push(execChg); ys.push(feedNext);
    }
    if (xs.length < 10) continue;
    const mx = mean(xs); const my = mean(ys);
    let num = 0; let dx = 0; let dy = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const a1 = (xs[i] as number) - mx; const b1 = (ys[i] as number) - my;
      num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
    }
    const corr = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
    if (!Number.isFinite(corr)) continue;
    all.push(corr);
    console.log(`  ${(syms.get(mint) ?? mint.slice(0, 8)).padEnd(10)} ${String(xs.length).padStart(4)}   ${corr.toFixed(3)}`);
  }
  if (all.length > 0) {
    const m = mean(all);
    console.log(`  MEAN CORRELATION ${m.toFixed(3)} across ${all.length} tokens`);
    console.log(m > 0.15
      ? '  => THE FEED LAGS. MT140 is an artifact of the price source, not a market effect.'
      : '  => no material lag detected; the feed is closer to a snapshot than to a smoothed average.');
  }
}
