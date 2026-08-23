/**
 * MT175 — who actually makes money on PumpSwap, and what do they do?
 *
 * Four routes are now closed by measurement. The obvious next move is to stop proposing mechanisms
 * and instead LOOK AT THE WINNERS - but the usual way of doing that is worthless. Picking out
 * profitable wallets from a leaderboard or a thread selects on the outcome, and any behaviour common
 * to winners will also be common to the far larger set of losers who did the same thing and are
 * simply not on the leaderboard. That is survivorship bias and it is the single best documented way
 * to lose money learning from winners.
 *
 * A CENSUS DOES NOT HAVE THAT PROBLEM. The tape holds every trade by every wallet on every WSOL pool
 * in the window, so the losers are present by construction. We can therefore ask the only question
 * that matters: is there a BEHAVIOUR whose practitioners are profitable, or merely a set of wallets
 * who happened to profit? The difference is whether the top of the distribution does something the
 * bottom does not.
 *
 * ACCOUNTING. Per wallet and pool we accumulate quote paid, quote received, and base in and out,
 * using the DECODED user quote and base legs rather than anything inferred from the reserve chain.
 * That is not fussiness: MT106 recorded that deposits and withdrawals move reserves for reasons that
 * are not trades, and inferring the base leg from reserve deltas produced a venue-wide profit of
 * +1,075,843 SOL, which is arithmetically impossible. Realised profit is taken on an average-cost
 * basis, which is identical to FIFO for any position that is fully closed and differs only on
 * partial sells.
 *
 * THE AGGREGATE IS THE CONTROL AND IT IS REPORTED FIRST. Trading is very close to zero sum before
 * fees and strictly negative after them, so the sum of realised profit across all wallets must come
 * out around zero or below. If it comes out large and positive, the accounting is wrong and every
 * per-wallet number below it is worthless. This check is printed before any result so it cannot be
 * quietly skipped.
 *
 * UNSOLD INVENTORY IS NOT PROFIT and is never marked. A wallet that bought and never sold has a
 * realised profit of zero here, not a paper gain - the overwhelmingly common end state for these
 * tokens is that the bag cannot be sold for anything, and marking it at the last trade price would
 * manufacture wealth that does not exist.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? 'E').split(',').filter((s) => s.length > 0);
const CACHE = 'data/trade-cache';
/** A wallet must have closed at least this many positions before its rate is quoted. */
const MIN_CLOSED = Number(arg('min-closed') ?? '5');
const WIN_FROM = Number(arg('from') ?? '0');
const WIN_TO = Number(arg('to') ?? '999999999');

/** Per wallet-and-pool leg accumulation. */
interface Leg { qIn: number; qOut: number; bIn: number; bOut: number; firstBuySlot: number; lastSlot: number }
const legs = new Map<string, Leg>();
/** The first slot at which each pool is seen, so entry can be located in the pool's life. */
const poolFirstSlot = new Map<string, number>();

/**
 * WHERE A POOL WAS BORN, from its CreatePoolEvent.
 *
 * Without this, "how long after the pool opened did this wallet enter" is unanswerable and quietly
 * wrong. The first slot at which a pool appears in a window is the window's boundary, not the pool's
 * birth, so for any pool that already existed every wallet looks like a late entrant by exactly the
 * amount of window that preceded it. Restricting to pools actually born inside the window is the
 * only way the column means what it says.
 */
const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try {
    const r = JSON.parse(line) as { pool: string; createdSlot?: number };
    if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot);
  } catch { /* skip */ }
}
const NEW_ONLY = process.argv.includes('--new-pools-only');

let rows = 0;
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  missing ${f}`); continue; }
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    const pool = r[0]; const slot = r[1]; const buy = r[5] === 1;
    if (NEW_ONLY) { const born = poolBorn.get(pool); if (born === undefined || born < WIN_FROM || born > WIN_TO) continue; }
    const user = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
    if (user === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
    rows += 1;
    const pf = poolFirstSlot.get(pool);
    if (pf === undefined || slot < pf) poolFirstSlot.set(pool, slot);

    const k = `${user}|${pool}`;
    let g = legs.get(k);
    if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0, firstBuySlot: -1, lastSlot: slot }; legs.set(k, g); }
    g.lastSlot = slot;
    if (buy) { g.qIn += uq; g.bIn += base; if (g.firstBuySlot < 0) g.firstBuySlot = slot; }
    else { g.qOut += uq; g.bOut += base; }
  }
  rl.close();
}
console.log(`MT175 — winner census over windows ${WINDOWS.join(',')}`);
console.log(`  ${rows.toLocaleString()} trades, ${legs.size.toLocaleString()} wallet-pool positions, ${poolFirstSlot.size.toLocaleString()} pools`);

/** Per wallet: realised profit and the behaviour we want to characterise. */
interface W { pnl: number; closed: number; wins: number; pools: Set<string>; entryDelays: number[]; holds: number[]; volume: number }
const wallets = new Map<string, W>();
let aggregate = 0;

for (const [k, g] of legs) {
  const bar = k.indexOf('|');
  const user = k.slice(0, bar); const pool = k.slice(bar + 1);
  /**
   * ONLY TOKENS WE WATCHED BOTH SIDES OF ARE SCORED, and this is not a refinement - the first
   * version of this file omitted it and the aggregate control came out at +661,755 SOL, about
   * $132M of profit conjured in 0.8 days.
   *
   * The cause is that a sell is not evidence of a purchase. A wallet holding tokens bought before
   * the window opened, or bought ON THE BONDING CURVE - which is a different program and appears
   * nowhere in this tape - shows up here as proceeds with no cost basis, and every lamport of it
   * was being booked as profit. Every graduating token arrives in its pool already owned by curve
   * holders, so this is not an edge case; it is most of the volume.
   *
   * Attributing both legs proportionally to the quantity we actually observed on both sides fixes
   * it in both directions: inventory sold from outside the window contributes no phantom gain, and
   * inventory bought but not yet sold contributes no phantom loss.
   */
  const matched = Math.min(g.bIn, g.bOut);
  const realised = matched <= 0 ? 0 : g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
  aggregate += realised;
  let w = wallets.get(user);
  if (w === undefined) { w = { pnl: 0, closed: 0, wins: 0, pools: new Set(), entryDelays: [], holds: [], volume: 0 }; wallets.set(user, w); }
  w.pnl += realised;
  w.pools.add(pool);
  w.volume += g.qIn + g.qOut;
  /** Only positions that actually round-tripped are scored as wins or losses. */
  if (g.bIn > 0 && g.bOut > 0) {
    w.closed += 1;
    if (realised > 0) w.wins += 1;
    const pf = poolBorn.get(pool) ?? poolFirstSlot.get(pool) ?? g.firstBuySlot;
    if (g.firstBuySlot >= 0) { w.entryDelays.push(g.firstBuySlot - pf); w.holds.push(g.lastSlot - g.firstBuySlot); }
  }
}

const SOL = (x: number): string => (x / 1e9).toFixed(2);
console.log('');
console.log('  ================= AGGREGATE CONTROL =================');
console.log(`  sum of realised profit across every wallet: ${SOL(aggregate)} SOL`);
console.log('  Trading is near zero sum before fees and negative after them, so this must be around');
console.log('  zero or below. A large positive number means the accounting is wrong and nothing below');
console.log('  it can be trusted.');
console.log('  ====================================================');
console.log('');

const all = [...wallets.entries()];
const profitable = all.filter(([, w]) => w.pnl > 0);
console.log(`  wallets: ${all.length.toLocaleString()}`);
console.log(`  with positive realised profit: ${profitable.length.toLocaleString()} (${(100 * profitable.length / all.length).toFixed(1)}%)`);

const med = (a: number[]): number => { if (a.length === 0) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const ranked = all.filter(([, w]) => w.closed >= MIN_CLOSED).sort((a, b) => b[1].pnl - a[1].pnl);
console.log(`  wallets with at least ${MIN_CLOSED} closed positions: ${ranked.length.toLocaleString()}`);
console.log('');

/**
 * THE COMPARISON IS THE POINT. If winners differ from losers only in outcome, the columns below will
 * look the same at both ends of the ranking and there is no behaviour to copy.
 */
function band(label: string, rowsIn: [string, W][]): void {
  if (rowsIn.length === 0) return;
  const pnl = rowsIn.map(([, w]) => w.pnl);
  const entry = rowsIn.flatMap(([, w]) => w.entryDelays);
  const hold = rowsIn.flatMap(([, w]) => w.holds);
  const winRate = rowsIn.map(([, w]) => (w.closed > 0 ? (100 * w.wins) / w.closed : NaN)).filter(Number.isFinite);
  const slotZero = entry.length === 0 ? NaN : (100 * entry.filter((d) => d === 0).length) / entry.length;
  console.log(
    `  ${label.padEnd(16)} n=${String(rowsIn.length).padStart(6)}  medPnL ${SOL(med(pnl)).padStart(9)} SOL  ` +
    `pools ${med(rowsIn.map(([, w]) => w.pools.size)).toFixed(0).padStart(4)}  ` +
    `win% ${med(winRate).toFixed(0).padStart(3)}  ` +
    `entry@slot0 ${slotZero.toFixed(1).padStart(5)}%  ` +
    `medEntryDelay ${med(entry).toFixed(0).padStart(6)}  medHold ${med(hold).toFixed(0).padStart(6)} slots`,
  );
}

const n = ranked.length;
console.log('  Ranked by realised profit. Compare the top band against the bottom band:');
console.log('');
band('top 10', ranked.slice(0, 10));
band('top 100', ranked.slice(0, 100));
band('top 1%', ranked.slice(0, Math.max(1, Math.floor(n * 0.01))));
band('top 10%', ranked.slice(0, Math.max(1, Math.floor(n * 0.10))));
band('middle 10%', ranked.slice(Math.floor(n * 0.45), Math.floor(n * 0.55)));
band('bottom 10%', ranked.slice(Math.floor(n * 0.90)));
console.log('');
console.log('  entry@slot0 is the share of closed positions whose first buy landed in the pool\'s very');
console.log('  first observed slot. medEntryDelay and medHold are in slots; one slot is about 0.4s.');
