/**
 * MT119 — the deep-and-fast cell, tested on days that did not exist in the analysis that found it.
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT119, including the expectation that it
 * FAILS, written before the six fresh windows were decoded.
 *
 * THE CELL, carried over UNCHANGED and not re-tunable: WSOL pool, effective quote reserve above
 * 120 SOL, pre-trigger median inter-trade gap below 1 second, a down-move larger than 5% of
 * quote reserves, entered at a 2 SECOND delay and held 15 seconds, priced at 0.02 SOL through
 * the same fee and virtual-reserve model as MT117 and MT118.
 *
 * DECISION RULE, frozen. Survives only if ALL FOUR hold:
 *   (1) median net is positive
 *   (2) positive share exceeds 50%
 *   (3) positive on at least 4 of the 6 days, so one day cannot carry it
 *   (4) the SLOW-arrival control in the same deep pools stays NEGATIVE — if everything is
 *       positive on these days then the days are doing the work, not the condition
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const CACHE = 'data/trade-cache';
const IMPACT_BAR = 0.05;
const DELAY_S = 2;
const HOLD_S = 15;
const NOTIONAL = 20_000_000n;
const DEPTH_SOL = 120;
const FAST_GAP_S = 1;
const V_CANDIDATES = [0n, 17_584_500_000n];
/** Windows 13..18 — six UTC days pulled AFTER MT118 reported. */
const HOLDOUT = [13, 14, 15, 16, 17, 18];

interface Ev { slot: number; ts: number; tx: number; addr: string; side: string; b: bigint; q: bigint; quote: bigint; user: bigint }
interface Obs { gapS: number; depthSol: number; ret: number; day: string }

function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null; let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined || a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v);
      const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1; if (k1 < k0) bad += 1;
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

const obs: Obs[] = [];
let triggers = 0;
console.log('MT119 — the deep-and-fast cell on six days never queried\n');

for (const w of HOLDOUT) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  window ${w}: no cache yet`); continue; }
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number];
    try { r = JSON.parse(line); } catch { continue; }
    const a = byPool.get(r[0]) ?? [];
    a.push({ slot: r[1], ts: r[2], tx: r[3], addr: r[4], side: r[5] === 1 ? 'BUY' : 'SELL',
             b: BigInt(r[6]), q: BigInt(r[7]), quote: BigInt(r[8]), user: BigInt(r[9]) });
    byPool.set(r[0], a);
  }
  rl.close();

  for (const [, evs] of byPool) {
    if (evs.length < 40) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;
    const ch: number[] = [];
    for (const e of evs) {
      if (e.side !== 'SELL' || e.quote <= 0n || e.user <= 0n) continue;
      const c = 1e4 * (Number(e.quote) - Number(e.user)) / Number(e.quote);
      if (Number.isFinite(c) && c > 0 && c < 1000) ch.push(c);
    }
    if (ch.length < 5) continue;
    ch.sort((a, b) => a - b);
    const chargedBps = ch[Math.floor(0.5 * (ch.length - 1))] ?? NaN;
    if (!Number.isFinite(chargedBps)) continue;
    const creditedBps = Math.max(Math.min(chargedBps, 25), 1);
    const fees: PoolFeeLadder = {
      lpFeeBasisPoints: BigInt(Math.round(creditedBps)), protocolFeeBasisPoints: 0n,
      coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: BigInt(Math.round(creditedBps)),
    };

    let lastEnd = -1;
    for (let i = 1; i + 1 < evs.length; i += 1) {
      const pre = evs[i]; const post = evs[i + 1];
      if (pre === undefined || post === undefined) continue;
      if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
      const p0 = Number(pre.q + v) / Number(pre.b);
      const p1 = Number(post.q + v) / Number(post.b);
      if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
      if (!(p1 / p0 - 1 < 0)) continue;
      if (Math.abs(Number(post.q - pre.q)) / Number(pre.q) < IMPACT_BAR) continue;
      if (post.ts < lastEnd) continue;
      lastEnd = post.ts + HOLD_S + 5;
      triggers += 1;

      let entry: Ev | null = null;
      for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + DELAY_S) { entry = e; break; } }
      if (entry === null) continue;
      let exit: Ev | null = null;
      for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= entry.ts + HOLD_S) { exit = e; break; } }
      if (exit === null) continue;

      const gaps: number[] = [];
      for (let j = Math.max(1, i - 20); j <= i; j += 1) {
        const a0 = evs[j - 1]; const a1 = evs[j];
        if (a0 !== undefined && a1 !== undefined) gaps.push(a1.ts - a0.ts);
      }
      gaps.sort((x, y) => x - y);
      const gapS = gaps.length > 0 ? (gaps[Math.floor(0.5 * (gaps.length - 1))] ?? 0) : 0;

      try {
        const bf = priceBuy({ base: entry.b, quote: entry.q, virtualQuote: v }, NOTIONAL, fees);
        const sf = priceSell({ base: exit.b - bf.baseOut, quote: exit.q + (bf.reservesAfter.quote - entry.q), virtualQuote: v }, bf.baseOut, fees);
        obs.push({ gapS, depthSol: Number(post.q + v) / 1e9, ret: Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL), day: new Date(post.ts * 1000).toISOString().slice(0, 10) });
      } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
    }
  }
  byPool.clear();
  console.log(`  window ${w}: cumulative triggers ${triggers}`);
}

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

const cell = obs.filter((o) => o.depthSol > DEPTH_SOL && o.gapS < FAST_GAP_S);
const control = obs.filter((o) => o.depthSol > DEPTH_SOL && o.gapS >= FAST_GAP_S);
console.log('');
console.log(`triggers ${triggers.toLocaleString()}   priced ${obs.length.toLocaleString()}   in-cell ${cell.length.toLocaleString()}   control ${control.length.toLocaleString()}`);

const days = [...new Set(cell.map((o) => o.day))].sort();
console.log('');
console.log('THE FROZEN CELL — deep >120 SOL, arrival <1s, 2s delay, 15s hold');
console.log(`  median net        ${F(med(cell.map((o) => o.ret)))}%`);
const pos = cell.length > 0 ? cell.filter((o) => o.ret > 0).length / cell.length : NaN;
console.log(`  positive share    ${Number.isFinite(pos) ? (100 * pos).toFixed(1) : 'n/a'}%`);
console.log('');
console.log('PER DAY');
let daysPositive = 0;
for (const d of days) {
  const a = cell.filter((o) => o.day === d).map((o) => o.ret);
  const m = med(a);
  if (m > 0) daysPositive += 1;
  console.log(`  ${d}  n=${String(a.length).padStart(5)}  median ${F(m)}%  positive ${(100 * a.filter((x) => x > 0).length / Math.max(a.length, 1)).toFixed(1)}%`);
}
console.log('');
console.log(`SLOW-ARRIVAL CONTROL, same deep pools:  median ${F(med(control.map((o) => o.ret)))}%   n=${control.length}`);

const c1 = med(cell.map((o) => o.ret)) > 0;
const c2 = pos > 0.5;
const c3 = daysPositive >= 4;
const c4 = !(med(control.map((o) => o.ret)) > 0);
console.log('');
console.log('FROZEN DECISION RULE (MT119, written before these windows were decoded)');
console.log(`  (1) median net > 0 ................... ${c1 ? 'PASS' : 'FAIL'}`);
console.log(`  (2) positive share > 50% ............. ${c2 ? 'PASS' : 'FAIL'}`);
console.log(`  (3) positive on >= 4 of 6 days ....... ${c3 ? 'PASS' : 'FAIL'}  (${daysPositive}/${days.length})`);
console.log(`  (4) slow-arrival control NOT positive  ${c4 ? 'PASS' : 'FAIL'}`);
console.log('');
console.log(`  VERDICT: ${c1 && c2 && c3 && c4 ? 'SURVIVES — licenses paper mode and a full ten-cluster test, NOT capital' : 'CLOSED'}`);
console.log('  Six clusters is BELOW the MT108 ten-cluster floor. A survivor is a candidate, never a licence.');
