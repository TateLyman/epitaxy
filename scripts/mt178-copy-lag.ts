/**
 * MT178 — what survives once you have to arrive AFTER the wallet you are copying?
 *
 * MT177 found a cohort worth taking seriously: 13,341 wallets that never touch a pool's birth slot,
 * selected purely on block D profit, going on to average +0.251 SOL in block E out of sample. They
 * are not issuers, so unlike the launch-bundled group their position is not structurally closed to
 * us. That makes "copy them" a coherent proposal for the first time in this programme.
 *
 * IT IS ALSO EXACTLY THE POINT AT WHICH THIS PROGRAMME HAS BEEN WRONG BEFORE. MT171 was a real
 * measurement of a real price series that died because the trade could not actually be made at the
 * price measured. MT169 killed the pool-opening seat the same way: the seat pays, and the second
 * person to reach it earns nothing. A leader's profit is not a follower's profit, and the gap between
 * them is not a haircut to be estimated - it is the whole question.
 *
 * SO THIS PRICES THE FOLLOWER, NOT THE LEADER. For every position the cohort takes in block E, we
 * buy at the first price actually available at least LAG slots after their buy, and sell at the first
 * price available at least LAG slots after their sell. Both legs pay the pool's own fee ladder as
 * recorded on the trade. Nothing is marked, nothing is inferred: if the tape does not contain a
 * tradeable price on either leg, the position is DROPPED rather than filled at the leader's price,
 * because filling it at their price is precisely the assumption under test.
 *
 * LAG=0 IS THE CONTROL AND IT IS NOT ACHIEVABLE. It fills the follower at the leader's own next
 * available price, which no observer could reach, and it exists only to show what the cohort's
 * positions are worth before latency is charged. The difference between LAG=0 and the higher lags is
 * the price of not being them.
 *
 * A position the leader never closes inside the window is dropped, because we would not know to sell.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const P1 = (arg('p1') ?? 'D0,D1,D2,D3,D4,D5,D6,D7').split(',').filter((s) => s.length > 0);
const P2 = (arg('p2') ?? 'E').split(',').filter((s) => s.length > 0);
const MIN_CLOSED = Number(arg('min-closed') ?? '3');
const LAGS = (arg('lags') ?? '0,1,2,5,12').split(',').map(Number);
const CACHE = 'data/trade-cache';
/**
 * TRANSACTION COST, CHARGED ON EVERY POSITION.
 *
 * The pool fee ladder is not the whole cost and leaving it at that is how MT171 flattered itself.
 * At the stake this account can actually take the flat cost is charged whether the trade wins or
 * loses: 46,000 lamports against a 0.02 SOL position is 23 bps.
 * A strategy whose mean edge is a few hundred bps lives or dies on this line.
 */
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '46000');
const NOTIONAL_SOL = Number(arg('notional') ?? '0.02');
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL_SOL;

const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; createdSlot?: number }; if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot); } catch { /* skip */ }
}

type Row = [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
async function* read(windows: string[]): AsyncGenerator<Row> {
  for (const w of windows) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      try { yield JSON.parse(line) as Row; } catch { /* skip */ }
    }
    rl.close();
  }
}

// ---- period 1: select the cohort, exactly as MT177 defined it ----
interface Leg { qIn: number; qOut: number; bIn: number; bOut: number; firstBuySlot: number }
const legs = new Map<string, Leg>();
for await (const r of read(P1)) {
  const user = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
  if (user === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
  const k = `${user}|${r[0]}`;
  let g = legs.get(k);
  if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0, firstBuySlot: -1 }; legs.set(k, g); }
  if (r[5] === 1) { g.qIn += uq; g.bIn += base; if (g.firstBuySlot < 0) g.firstBuySlot = r[1]; }
  else { g.qOut += uq; g.bOut += base; }
}
interface P { pnl: number; closed: number; atBirth: number; classified: number }
const per = new Map<string, P>();
let agg1 = 0;
for (const [k, g] of legs) {
  const bar = k.indexOf('|'); const user = k.slice(0, bar); const pool = k.slice(bar + 1);
  const matched = Math.min(g.bIn, g.bOut);
  const realised = matched <= 0 ? 0 : g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
  agg1 += realised;
  let p = per.get(user);
  if (p === undefined) { p = { pnl: 0, closed: 0, atBirth: 0, classified: 0 }; per.set(user, p); }
  p.pnl += realised;
  if (g.bIn > 0 && g.bOut > 0) {
    p.closed += 1;
    const born = poolBorn.get(pool);
    if (born !== undefined && g.firstBuySlot >= born) { p.classified += 1; if (g.firstBuySlot === born) p.atBirth += 1; }
  }
}
legs.clear();
console.log('MT178 — the follower\'s price, not the leader\'s');
console.log(`  period 1 aggregate ${(agg1 / 1e9).toFixed(0)} SOL (must be negative)`);
if (agg1 > 0) { console.log('  REFUSED: positive aggregate.'); process.exit(1); }
const ranked = [...per.entries()].filter(([, p]) => p.closed >= MIN_CLOSED).sort((a, b) => b[1].pnl - a[1].pnl);
const decile = ranked.slice(0, Math.floor(ranked.length / 10));
/** The copyable cohort: top-decile by period-1 profit, never entering at a pool's birth slot. */
const cohort = new Set(decile.filter(([, p]) => p.classified >= MIN_CLOSED && p.atBirth === 0).map(([u]) => u));
console.log(`  cohort: ${cohort.size.toLocaleString()} open-market wallets from the period-1 top decile`);

/**
 * THE CONTROL COHORT, AND IT IS NOT OPTIONAL.
 *
 * These outcomes are violently right-skewed - a median of about -470 bps against a mean of about
 * +1,570. A distribution shaped like that has a positive mean almost regardless of who is trading
 * it, because a minority of enormous winners carries a majority of small losers. So a positive mean
 * for the selected cohort is NOT evidence that selecting them accomplished anything.
 *
 * The control takes wallets from the MIDDLE of the period-1 ranking - equally active, equally real,
 * and by construction not selected for profit - and prices their period-2 positions with the exact
 * same code. If the two come out alike, the ranking carries no information and the whole exercise is
 * measuring the shape of memecoin returns rather than anyone's skill.
 */
const mid = ranked.slice(Math.floor(ranked.length * 0.45), Math.floor(ranked.length * 0.55));
const control = new Set(mid.filter(([, p]) => p.classified >= MIN_CLOSED && p.atBirth === 0).map(([u]) => u));
console.log(`  control: ${control.size.toLocaleString()} open-market wallets from the MIDDLE of the same ranking`);

// ---- period 2: the pool tape, and the cohort's positions in it ----
interface Tick { slot: number; price: number; feeBps: number }
const ticks = new Map<string, Tick[]>();
interface Pos { pool: string; buySlot: number; sellSlot: number; ctl: boolean }
const posOf = new Map<string, { buy: number; sell: number; pool: string; ctl: boolean }>();
let agg2rows = 0;
for await (const r of read(P2)) {
  const pool = r[0]; const slot = r[1];
  const b = Number(r[6]); const q = Number(r[7]);
  if (b > 0 && q > 0) {
    const t = ticks.get(pool) ?? [];
    t.push({ slot, price: q / b, feeBps: (r[10] ?? 0) + (r[11] ?? 0) + (r[12] ?? 0) });
    ticks.set(pool, t);
  }
  const user = r[13];
  if (user === undefined) continue;
  const isC = cohort.has(user); const isK = control.has(user);
  if (!isC && !isK) continue;
  agg2rows += 1;
  const k = `${user}|${pool}`;
  const p = posOf.get(k) ?? { buy: -1, sell: -1, pool, ctl: isK };
  if (r[5] === 1) { if (p.buy < 0) p.buy = slot; } else { p.sell = slot; }
  posOf.set(k, p);
}
for (const t of ticks.values()) t.sort((x, y) => x.slot - y.slot);
const positions: Pos[] = [];
for (const p of posOf.values()) { if (p.buy >= 0 && p.sell > p.buy) positions.push({ pool: p.pool, buySlot: p.buy, sellSlot: p.sell, ctl: p.ctl }); }
console.log(`  cohort trades in period 2: ${agg2rows.toLocaleString()}; round-trip positions: ${positions.length.toLocaleString()}`);
console.log('');

/** First tradeable price at or after a slot. Returns null when the tape has none. */
function priceAt(pool: string, slot: number): Tick | null {
  const t = ticks.get(pool);
  if (t === undefined) return null;
  let lo = 0; let hi = t.length - 1; let ans: Tick | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const c = t[mid] as Tick;
    if (c.slot >= slot) { ans = c; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

console.log(`  Every position the cohort opened and closed in period 2, priced for a follower.`);
console.log(`  Stake ${NOTIONAL_SOL} SOL; pool ladder from the tape plus a flat ${fixedBps.toFixed(0)} bps of transaction cost.`);
console.log('');
console.log('   lag  arm            n   median     mean    %pos   g(f=.02)  g(f=.05)  best-50-out');
for (const lag of LAGS) {
 for (const arm of [false, true]) {
  const outs: number[] = [];
  let dropped = 0;
  for (const p of positions) {
    if (p.ctl !== arm) continue;
    const inT = priceAt(p.pool, p.buySlot + lag);
    const outT = priceAt(p.pool, p.sellSlot + lag);
    if (inT === null || outT === null || outT.slot < inT.slot) { dropped += 1; continue; }
    if (!(inT.price > 0) || !(outT.price > 0)) { dropped += 1; continue; }
    /** Both legs pay the pool's own recorded charge. */
    const gross = outT.price / inT.price;
    const net = gross * (1 - inT.feeBps / 1e4) * (1 - outT.feeBps / 1e4);
    outs.push(1e4 * (net - 1) - fixedBps);
  }
  if (outs.length === 0) { continue; }
  const srt = [...outs].sort((x, y) => y - x);
  const fm = (x: number): string => (x === -Infinity ? 'RUIN' : x.toFixed(4));
  console.log(
    `  ${String(lag).padStart(4)} ${(arm ? 'CONTROL' : 'cohort ').padEnd(8)} ${String(outs.length).padStart(7)} ${q(outs, 0.5).toFixed(0).padStart(8)} ${mean(outs).toFixed(0).padStart(8)} ` +
    `${(100 * outs.filter((x) => x > 0).length / outs.length).toFixed(1).padStart(6)}% ${fm(growth(outs, 0.02)).padStart(10)} ${fm(growth(outs, 0.05)).padStart(9)} ` +
    `${fm(growth(srt.slice(50), 0.05)).padStart(11)}`,
  );
 }
 console.log('');
}
console.log('');
console.log('  lag 0 fills at a price no observer could reach and is a control, not a strategy.');
console.log('  One slot is about 0.4s; landing a transaction reliably is not faster than a few slots.');
