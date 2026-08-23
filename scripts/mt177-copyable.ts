/**
 * MT177 — is the persistent winner cohort copyable, or is it just the people who launched the token?
 *
 * MT176 found real persistence: ranking wallets by realised profit in block D predicts their profit
 * in block E, out of sample, at a Spearman rank correlation of 0.1957, with the top decile averaging
 * +0.553 SOL in the later period against -4.003 for the bottom. That is the first positive signal in
 * this programme, and it is worth exactly nothing until one question is answered.
 *
 * MT175 SHOWED THE VERY TOP OF THE DISTRIBUTION IS NOT TRADING. The ten most profitable wallets
 * entered 52.3% of their positions in the pool's OWN FIRST SLOT, against 0.0% to 0.2% for the middle
 * and bottom of the ranking. MT169 established what that seat is: the first two trades of a pool
 * share a single transaction 59.9% of the time, so those wallets are not racing into the pool, they
 * are bundled with its creation. That is the issuer's position. It cannot be copied by anyone who is
 * not the issuer, no matter how fast they are or how accurately they predict.
 *
 * So the persistence MT176 measured could be either of two completely different things:
 *
 *   A BEHAVIOUR, practised by wallets buying on the open market after the pool opens, which someone
 *   else could in principle learn or follow.
 *
 *   A POSITION, held by wallets that were in the launch bundle, which persists across periods for the
 *   mundane reason that the same people keep launching tokens.
 *
 * These are indistinguishable in an aggregate profit ranking and they have opposite implications. So
 * this splits the period-one top decile by the share of its positions entered in the pool's birth
 * slot, and asks what each group earns in period two. If the persistence survives among wallets that
 * never touch the birth slot, there is a behaviour worth studying. If it collapses to the bundled
 * group, then the winners are the issuers, "copy the winners" means "be the issuer", and the route is
 * closed for the same reason MT169 closed the last one.
 *
 * Only pools whose CreatePoolEvent falls inside the period are classified, because entry timing
 * against a pool we did not watch open is not a measurement.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const P1 = (arg('p1') ?? 'D0,D1,D2,D3,D4,D5,D6,D7').split(',').filter((s) => s.length > 0);
const P2 = (arg('p2') ?? 'E').split(',').filter((s) => s.length > 0);
const MIN_CLOSED = Number(arg('min-closed') ?? '3');
/** A position counts as launch-bundled if its first buy lands within this many slots of pool birth. */
const BUNDLE_SLOTS = Number(arg('bundle-slots') ?? '0');
const CACHE = 'data/trade-cache';

const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; createdSlot?: number };
    if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot);
  } catch { /* skip */ }
}

interface Leg { qIn: number; qOut: number; bIn: number; bOut: number; firstBuySlot: number }
interface P { pnl: number; closed: number; atBirth: number; classified: number }

async function period(windows: string[]): Promise<{ per: Map<string, P>; aggregate: number; trades: number }> {
  const legs = new Map<string, Leg>();
  let trades = 0;
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) { console.log(`  missing ${f}`); continue; }
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
      try { r = JSON.parse(line) as typeof r; } catch { continue; }
      const user = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
      if (user === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
      trades += 1;
      const k = `${user}|${r[0]}`;
      let g = legs.get(k);
      if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0, firstBuySlot: -1 }; legs.set(k, g); }
      if (r[5] === 1) { g.qIn += uq; g.bIn += base; if (g.firstBuySlot < 0) g.firstBuySlot = r[1]; }
      else { g.qOut += uq; g.bOut += base; }
    }
    rl.close();
  }
  const per = new Map<string, P>();
  let aggregate = 0;
  for (const [k, g] of legs) {
    const bar = k.indexOf('|');
    const user = k.slice(0, bar); const pool = k.slice(bar + 1);
    /** Only inventory whose purchase and sale were both observed. MT175's control. */
    const matched = Math.min(g.bIn, g.bOut);
    const realised = matched <= 0 ? 0 : g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
    aggregate += realised;
    let p = per.get(user);
    if (p === undefined) { p = { pnl: 0, closed: 0, atBirth: 0, classified: 0 }; per.set(user, p); }
    p.pnl += realised;
    if (g.bIn > 0 && g.bOut > 0) {
      p.closed += 1;
      const born = poolBorn.get(pool);
      /** Entry timing against a pool we did not watch open is not a measurement. */
      if (born !== undefined && g.firstBuySlot >= born) {
        p.classified += 1;
        if (g.firstBuySlot - born <= BUNDLE_SLOTS) p.atBirth += 1;
      }
    }
  }
  return { per, aggregate, trades };
}

console.log('MT177 — is the persistent cohort a behaviour or the issuer\'s position?');
const a = await period(P1);
const b = await period(P2);
const SOL = (x: number): string => (x / 1e9).toFixed(3);
console.log(`  period 1 ${P1.join(',')}: ${a.trades.toLocaleString()} trades, aggregate ${SOL(a.aggregate)} SOL`);
console.log(`  period 2 ${P2.join(',')}: ${b.trades.toLocaleString()} trades, aggregate ${SOL(b.aggregate)} SOL`);
if (a.aggregate > 0 || b.aggregate > 0) { console.log('  REFUSED: positive aggregate means the accounting is wrong.'); process.exit(1); }

const cohort = [...a.per.entries()].filter(([, p]) => p.closed >= MIN_CLOSED).sort((x, y) => y[1].pnl - x[1].pnl);
const top = cohort.slice(0, Math.floor(cohort.length / 10));
console.log('');
console.log(`  period-1 top decile: ${top.length.toLocaleString()} wallets`);
const classified = top.filter(([, p]) => p.classified >= MIN_CLOSED);
console.log(`  of those, ${classified.length.toLocaleString()} have >=${MIN_CLOSED} positions in pools we watched open, so their entry timing is measurable`);
console.log('');

const med = (arr: number[]): number => { if (arr.length === 0) return NaN; const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const mean = (arr: number[]): number => (arr.length === 0 ? NaN : arr.reduce((x, y) => x + y, 0) / arr.length);

console.log(`  Split by the share of period-1 positions entered within ${BUNDLE_SLOTS} slot(s) of the pool's birth.`);
console.log('');
console.log('  birth-slot share      n    p1 mean SOL   p2 mean SOL   p2 median   p2 %positive');
const BANDS: [string, number, number][] = [
  ['none (0%)', -0.0001, 0.0001],
  ['1-5%', 0.0001, 0.05],
  ['5-25%', 0.05, 0.25],
  ['25-50%', 0.25, 0.50],
  ['over 50%', 0.50, 1.01],
];
for (const [label, lo, hi] of BANDS) {
  const grp = classified.filter(([, p]) => { const s = p.atBirth / p.classified; return s > lo && s <= hi; });
  if (grp.length === 0) { console.log(`  ${label.padEnd(18)} ${String(0).padStart(6)}   (none)`); continue; }
  const p1 = grp.map(([, p]) => p.pnl);
  const p2 = grp.map(([u]) => b.per.get(u)?.pnl ?? 0);
  console.log(
    `  ${label.padEnd(18)} ${String(grp.length).padStart(6)}  ${SOL(mean(p1)).padStart(12)}  ${SOL(mean(p2)).padStart(12)}  ` +
    `${SOL(med(p2)).padStart(10)}  ${(100 * p2.filter((x) => x > 0).length / p2.length).toFixed(1).padStart(11)}%`,
  );
}
console.log('');
console.log('  If the "none" row holds a positive period-2 mean, there is a behaviour worth studying.');
console.log('  If only the high-share rows do, the winners are the issuers and there is nothing to copy.');
