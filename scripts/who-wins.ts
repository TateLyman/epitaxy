/**
 * WHO ACTUALLY MAKES MONEY ON THIS VENUE, AND HOW.
 *
 * Nineteen preregistered tests in this repository asked "does OUR rule work". Every one was a
 * variation on WHICH TOKEN AND WHEN, and every one came back negative. Not one asked the prior
 * question: on a venue where somebody is clearly winning, WHO is it and what are they doing that
 * we are not.
 *
 * EXPLORATORY. States no hypothesis, decides nothing, cannot produce a tradable claim. Anything
 * it finds must be re-preregistered and tested on held-out windows before it means anything.
 *
 * THREE DECODING HAZARDS, ALL HANDLED, ALL PREVIOUSLY MEASURED IN THIS REPO:
 *
 *   THE QUOTE FIELDS ARE SWAPPED ON ~32% OF BUYS (MT106, verified at 0.000 bps residual against
 *   the reserve chain). The trader's leg is therefore never read positionally: on a BUY the trader
 *   pays the LARGER of the two quote fields, on a SELL receives the SMALLER. Robust by construction.
 *
 *   THE BASE LEG IS READ, NOT INFERRED. A first version of this script recovered it from the
 *   reserve chain via baseAfter(i) == baseBefore(i+1). That identity holds only when nothing but
 *   a trade happened in between, and MT106 recorded that liquidity deposits and withdrawals move
 *   reserves for reasons that are not trades. The contamination produced phantom token balances
 *   and a venue-wide trader profit of +1,075,843 SOL. It is now the decoded `baseAmount`.
 *
 *   MARKS ARE NOT PROFITS. A wallet still holding tokens is marked at the pool's last observed
 *   price, which is a price at which it did NOT sell and frequently could not have. Realised and
 *   marked PnL are therefore reported SEPARATELY and never summed into one headline.
 *
 * THE CONSERVATION CHECK IS THE POINT OF THIS FILE. Traders in aggregate must LOSE, because every
 * leg pays a fee out of the system. If the measured net is positive the accounting is wrong, and
 * the script says so loudly instead of printing a discovery.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CACHE = 'data/trade-cache';
const LAMPORTS = 1e9;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WINDOWS = (arg('windows') ?? '1').split(',').filter((s) => s.length > 0);

interface Ev { slot: number; ts: number; tx: number; addr: string; buy: boolean; b: bigint; q: bigint; big: bigint; small: bigint; who: string; base: bigint }

interface W {
  solOut: number; solIn: number;
  buys: number; sells: number;
  pools: Set<string>;
  markValue: number;
  sameSlotRoundTrips: number;
  holdS: number[];
  entryAgeS: number[];
  feesPaid: number;
}
const blank = (): W => ({ solOut: 0, solIn: 0, buys: 0, sells: 0, pools: new Set(), markValue: 0, sameSlotRoundTrips: 0, holdS: [], entryAgeS: [], feesPaid: 0 });

const wallets = new Map<string, W>();
let poolsSeen = 0; let tradesUsed = 0; let feeTotal = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) { console.log(`  (missing w${w})`); continue; }
  const byPool = new Map<string, Ev[]>();
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  let bad = 0;
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line); } catch { continue; }
    if (r.length < 15) { bad += 1; continue; }
    const qa = BigInt(r[8]); const ua = BigInt(r[9]);
    const a = byPool.get(r[0]) ?? [];
    a.push({
      slot: r[1], ts: r[2], tx: r[3], addr: r[4], buy: r[5] === 1,
      b: BigInt(r[6]), q: BigInt(r[7]),
      big: qa > ua ? qa : ua, small: qa > ua ? ua : qa,
      who: r[13], base: BigInt(r[14]),
    });
    byPool.set(r[0], a);
  }
  rl.close();
  if (bad > 0) { console.log(`  w${w}: ${bad.toLocaleString()} lines lack the base field — REBUILD THE CACHE, results would be wrong`); process.exit(2); }

  for (const [pool, evs] of byPool) {
    if (evs.length < 10) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    poolsSeen += 1;
    const t0 = evs[0]?.ts ?? 0;

    /** Only wallets that touched THIS pool, so marking is O(holders) and not O(all wallets). */
    const holders = new Map<string, number>();
    const openedAt = new Map<string, number>();
    const slotSide = new Map<string, Set<number>>();

    for (const e of evs) {
      if (e.base <= 0n) continue;
      tradesUsed += 1;
      let s = wallets.get(e.who);
      if (s === undefined) { s = blank(); wallets.set(e.who, s); }
      if (!s.pools.has(pool)) { s.pools.add(pool); s.entryAgeS.push(e.ts - t0); }

      // The fee is the gap between the two legs, whichever way round they are stored.
      const fee = Number(e.big - e.small) / LAMPORTS;
      if (Number.isFinite(fee) && fee >= 0) { s.feesPaid += fee; feeTotal += fee; }

      const held = holders.get(e.who) ?? 0;
      const base = Number(e.base);
      if (e.buy) {
        s.solOut += Number(e.big) / LAMPORTS;
        s.buys += 1;
        if (held <= 0) openedAt.set(e.who, e.ts);
        holders.set(e.who, held + base);
      } else {
        s.solIn += Number(e.small) / LAMPORTS;
        s.sells += 1;
        // Never let a wallet sell more than we saw it buy: it may have arrived holding tokens
        // bought before this window opened, and crediting that as profit is a phantom.
        const sold = Math.min(base, Math.max(0, held));
        const left = held - sold;
        holders.set(e.who, left);
        if (held > 0 && left <= held * 0.02) {
          const o = openedAt.get(e.who);
          if (o !== undefined) { s.holdS.push(e.ts - o); openedAt.delete(e.who); }
        }
      }

      const key = e.who + String(e.slot);
      const sides = slotSide.get(key) ?? new Set<number>();
      sides.add(e.buy ? 1 : 0);
      slotSide.set(key, sides);
      if (sides.size === 2) { s.sameSlotRoundTrips += 1; sides.clear(); sides.add(-1); }
    }

    const last = evs[evs.length - 1];
    if (last !== undefined && last.b > 0n) {
      const px = Number(last.q) / Number(last.b);
      for (const [who, h] of holders) {
        if (h <= 0) continue;
        const s = wallets.get(who);
        if (s !== undefined) s.markValue += (h * px) / LAMPORTS;
      }
    }
  }
  byPool.clear();
  console.log(`  w${w} folded in — ${wallets.size.toLocaleString()} wallets so far`);
}

const pct = (x: number, n: number): string => (n > 0 ? (100 * x / n).toFixed(1) + '%' : 'n/a');
const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };

interface Row { who: string; realised: number; marked: number; s: W }
const rows: Row[] = [];
for (const [who, s] of wallets) {
  if (s.buys + s.sells < 2) continue;
  rows.push({ who, realised: s.solIn - s.solOut, marked: s.markValue, s });
}

// ---- CONSERVATION CHECK, before a single result is printed ----
const realisedNet = rows.reduce((a, r) => a + r.realised, 0);
const markedNet = rows.reduce((a, r) => a + r.marked, 0);
console.log('');
console.log(`pools ${poolsSeen.toLocaleString()}   trades attributed ${tradesUsed.toLocaleString()}   wallets with >=2 trades ${rows.length.toLocaleString()}`);
console.log('');
console.log('CONSERVATION CHECK — traders in aggregate must LOSE, because every leg pays a fee');
console.log(`  realised SOL flow, all traders   ${realisedNet.toFixed(1)} SOL`);
console.log(`  fees paid, summed independently  ${feeTotal.toFixed(1)} SOL`);
console.log(`  value still held (marked)        ${markedNet.toFixed(1)} SOL  <- NOT profit; a price they did not sell at`);
if (realisedNet > 0) {
  console.log('');
  console.log('  *** REALISED FLOW IS POSITIVE. That is impossible and the accounting is wrong. ***');
  console.log('  Not printing rankings built on it.');
  process.exit(2);
}
console.log(`  realised flow as a share of fees paid: ${pct(-realisedNet, feeTotal)}`);
console.log('  (traders losing roughly what they paid in fees is the expected signature)');

// Realised only. A ranking on marks ranks unsold bags.
rows.sort((a, b) => b.realised - a.realised);
const win = rows.filter((r) => r.realised > 0);
const totWin = win.reduce((a, r) => a + r.realised, 0);
console.log('');
console.log('THE DISTRIBUTION OF REALISED OUTCOMES');
console.log(`  wallets in profit    ${win.length.toLocaleString()}  (${pct(win.length, rows.length)})`);
console.log(`  won by winners       ${totWin.toFixed(1)} SOL`);
console.log(`  lost by everyone else ${rows.filter((r) => r.realised <= 0).reduce((a, r) => a + r.realised, 0).toFixed(1)} SOL`);
console.log('');
console.log('HOW CONCENTRATED IS THE WINNING?');
for (const k of [10, 100, 1000]) {
  const top = rows.slice(0, k).reduce((a, r) => a + r.realised, 0);
  console.log(`  top ${String(k).padStart(4)} wallets take ${top.toFixed(1)} SOL = ${pct(top, totWin)} of all winnings`);
}

const band = (label: string, rs: Row[]): void => {
  if (rs.length === 0) return;
  const ss = rs.map((r) => r.s);
  const mev = ss.reduce((a, s) => a + s.sameSlotRoundTrips, 0);
  const withMev = ss.filter((s) => s.sameSlotRoundTrips > 0).length;
  const holds = ss.flatMap((s) => s.holdS);
  const ages = ss.flatMap((s) => s.entryAgeS);
  console.log(
    `  ${label.padEnd(13)} n=${String(rs.length).padStart(6)}  medRealised ${med(rs.map((r) => r.realised)).toFixed(3).padStart(10)}  ` +
    `medTrades ${String(med(ss.map((s) => s.buys + s.sells))).padStart(4)}  medPools ${String(med(ss.map((s) => s.pools.size))).padStart(3)}  ` +
    `RTinSlot ${String(mev).padStart(6)} (${pct(withMev, rs.length).padStart(5)} of wallets)  ` +
    `medHold ${(Number.isFinite(med(holds)) ? med(holds).toFixed(0) + 's' : 'n/a').padStart(6)}  ` +
    `medEntryAge ${(Number.isFinite(med(ages)) ? med(ages).toFixed(0) + 's' : 'n/a').padStart(6)}  ` +
    `medFees ${med(ss.map((s) => s.feesPaid)).toFixed(3).padStart(8)}`,
  );
};
console.log('');
console.log('WHAT DO THE WINNERS DO THAT EVERYONE ELSE DOES NOT?');
band('top 10', rows.slice(0, 10));
band('top 100', rows.slice(0, 100));
band('top 1%', rows.slice(0, Math.max(1, Math.floor(rows.length * 0.01))));
band('top 10%', rows.slice(0, Math.max(1, Math.floor(rows.length * 0.10))));
band('middle 50%', rows.slice(Math.floor(rows.length * 0.25), Math.floor(rows.length * 0.75)));
band('bottom 10%', rows.slice(Math.floor(rows.length * 0.90)));
console.log('');
console.log('  RTinSlot = bought AND sold one pool inside ONE slot. Not a position — an extraction.');
console.log('  medEntryAge = seconds from a pool\'s first observed trade to this wallet\'s first.');
console.log('');
console.log('EXPLORATORY. Decides nothing. Re-preregister anything interesting before believing it.');
