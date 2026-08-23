/**
 * What has the short side of a perpetual actually been paid, and does it clear the cost of holding?
 *
 * Six routes are closed and every one of them searched for an EDGE - a situation where somebody is
 * wrong and we are right. That is why they closed: a mistake, once found, is competed away until it
 * pays nothing. Funding is a different object. A perpetual has no expiry, so a periodic payment pins
 * it to spot, and when leveraged longs dominate the longs pay the shorts. Holding spot and shorting
 * the perp is delta-neutral - the price can do anything - and the funding accrues regardless.
 *
 * NOBODY HAS TO BE WRONG FOR THIS TO PAY, which is the whole reason it is worth measuring. It is
 * compensation for taking the other side of leveraged demand and for carrying liquidation risk. That
 * makes it a fee for a service rather than an inefficiency, and services do not get arbitraged to
 * zero the way mistakes do. They get competed down to the cost of providing them, which is a floor
 * rather than zero.
 *
 * THE HEADLINE APR IS NOT THE ANSWER AND MUST NOT BE REPORTED ALONE. Three things decide whether this
 * is real money for an account of a given size, and only the first is what the marketing quotes:
 *
 *   THE AVERAGE RATE, annualised. This is the number everyone cites and it is the least interesting.
 *
 *   THE SIGN DISTRIBUTION AND ITS PERSISTENCE. Funding goes negative in choppy or bearish regimes,
 *   and then the position PAYS instead of collecting. A strategy that yields 15% on average while
 *   bleeding for six weeks at a time is a different proposition from one that never bleeds, and the
 *   average cannot tell them apart. The worst sustained drawdown in cumulative funding is reported
 *   for exactly this reason.
 *
 *   THE COST OF GETTING IN AND OUT, which is fixed and therefore decides the MINIMUM VIABLE CAPITAL.
 *   Both legs pay fees twice. Below some account size the round trip costs more than the funding it
 *   collects, and no yield figure can rescue it. That threshold is the number that actually answers
 *   whether this is available to us.
 *
 * Data comes from Hyperliquid, whose funding settles HOURLY and whose API is open, with OKX as an
 * independent cross-check on eight-hour settlement. Binance and Bybit are geo-blocked from here and
 * are not used, rather than being silently dropped.
 *
 * Reads public market data. Signs nothing, sends nothing, spends nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const COINS = (arg('coins') ?? 'SOL,BTC,ETH').split(',').filter((s) => s.length > 0);
const DAYS = Number(arg('days') ?? '180');
/** Round-trip cost of establishing and unwinding both legs, in basis points of notional. */
const ROUND_TRIP_BPS = Number(arg('round-trip-bps') ?? '67');
const OUT = 'data/funding';

interface Point { t: number; rate: number }

/** Hyperliquid settles hourly and returns at most 500 rows per call, so it must be walked forward. */
async function hyperliquid(coin: string, days: number): Promise<Point[]> {
  const end = Date.now();
  let cursor = end - days * 86_400_000;
  const out: Point[] = [];
  for (let page = 0; page < 40; page += 1) {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin, startTime: cursor, endTime: end }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) break;
    const rows = (await res.json()) as { time: number; fundingRate: string }[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push({ t: r.time, rate: Number(r.fundingRate) });
    const last = rows[rows.length - 1];
    if (last === undefined || last.time <= cursor) break;
    cursor = last.time + 1;
    if (cursor >= end) break;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  const seen = new Set<number>();
  return out.filter((p) => (seen.has(p.t) ? false : (seen.add(p.t), true))).sort((a, b) => a.t - b.t);
}

/** OKX settles every eight hours; used only as an independent check on the level. */
async function okx(inst: string): Promise<Point[]> {
  const out: Point[] = [];
  let before: string | null = null;
  for (let page = 0; page < 12; page += 1) {
    const u = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100${before === null ? '' : `&after=${before}`}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) break;
    const j = (await res.json()) as { data?: { fundingRate: string; fundingTime: string }[] };
    const rows = j.data ?? [];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ t: Number(r.fundingTime), rate: Number(r.fundingRate) });
    before = rows[rows.length - 1]?.fundingTime ?? null;
    if (before === null) break;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return out.sort((a, b) => a.t - b.t);
}

const pct = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

mkdirSync(OUT, { recursive: true });
console.log('FUNDING HISTORY — what the short side of a perpetual was actually paid');
console.log(`  round-trip cost assumed ${ROUND_TRIP_BPS} bps of notional (both legs, in and out)`);
console.log('');

for (const coin of COINS) {
  const hl = await hyperliquid(coin, DAYS);
  if (hl.length === 0) { console.log(`  ${coin}: no data`); continue; }
  writeFileSync(`${OUT}/hyperliquid-${coin}.jsonl`, hl.map((p) => JSON.stringify(p)).join('\n'));
  const spanDays = (hl[hl.length - 1]!.t - hl[0]!.t) / 86_400_000;
  const periodsPerYear = hl.length / (spanDays / 365);
  const rates = hl.map((p) => p.rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const apr = mean * periodsPerYear * 100;
  const negShare = (100 * rates.filter((r) => r < 0).length) / rates.length;

  /** Cumulative funding a short collects, and the worst peak-to-trough run inside it. */
  let cum = 0; let peak = 0; let maxDD = 0; let worstRun = 0; let run = 0;
  for (const r of rates) {
    cum += r;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    if (r < 0) { run += 1; if (run > worstRun) worstRun = run; } else run = 0;
  }
  const totalPct = cum * 100;

  console.log(`  ${coin}  (Hyperliquid, hourly)`);
  console.log(`    ${hl.length.toLocaleString()} periods over ${spanDays.toFixed(0)} days`);
  console.log(`    mean rate ${(mean * 100).toFixed(5)}% per hour  =>  ${apr.toFixed(2)}% APR to the SHORT side`);
  console.log(`    total collected over the window: ${totalPct.toFixed(2)}% of notional`);
  console.log(`    periods with NEGATIVE funding (short pays): ${negShare.toFixed(1)}%`);
  console.log(`    longest unbroken negative run: ${worstRun} hours (${(worstRun / 24).toFixed(1)} days)`);
  console.log(`    worst drawdown in cumulative funding: ${(maxDD * 100).toFixed(3)}% of notional`);
  console.log(`    rate percentiles/hr: p10 ${(pct(rates, 0.1) * 100).toFixed(5)}%  p50 ${(pct(rates, 0.5) * 100).toFixed(5)}%  p90 ${(pct(rates, 0.9) * 100).toFixed(5)}%`);
  /** The cost is fixed, so it sets a holding period below which the trade cannot pay for itself. */
  const dailyPct = apr / 365;
  const breakevenDays = dailyPct > 0 ? (ROUND_TRIP_BPS / 100) / dailyPct : Infinity;
  console.log(`    breakeven hold at that APR: ${breakevenDays.toFixed(1)} days just to cover the ${ROUND_TRIP_BPS} bps round trip`);
  console.log('');
}

for (const [coin, inst] of [['SOL', 'SOL-USDT-SWAP'], ['BTC', 'BTC-USDT-SWAP']] as [string, string][]) {
  if (!COINS.includes(coin)) continue;
  const rows = await okx(inst);
  if (rows.length === 0) continue;
  const spanDays = (rows[rows.length - 1]!.t - rows[0]!.t) / 86_400_000;
  const mean = rows.reduce((a, b) => a + b.rate, 0) / rows.length;
  const apr = mean * (rows.length / (spanDays / 365)) * 100;
  console.log(`  ${coin} cross-check (OKX, 8-hourly): ${rows.length} periods over ${spanDays.toFixed(0)} days => ${apr.toFixed(2)}% APR`);
}
console.log('');
console.log('  APR alone does not decide this. A yield that is positive on average while paying out for');
console.log('  weeks at a time is a different instrument from one that never does, and the fixed round');
console.log('  trip sets a floor on both holding period and account size.');
