/**
 * Check a named wallet against our own tape.
 *
 * Every result so far has been statistical - deciles, cohorts, controls. This is the other thing,
 * and it had not been tried: take a wallet somebody publicly claims is winning, and look at what it
 * actually did on chain.
 *
 * IT IS WORTH DOING FOR A REASON THAT IS NOT "MAYBE THEY KNOW SOMETHING". A census reports the
 * average behaviour of a band, and averaging is exactly what hides a mechanism practised by a small
 * number of wallets. If a publicly celebrated winner turns out to be sitting in the pool's birth slot
 * then the anecdote confirms MT175 and there is nothing new. If it turns out to be doing something
 * the bands averaged away, that is a hypothesis we did not have.
 *
 * IT ALSO CHECKS THE ANECDOTE ITSELF. Claimed profits circulate without anyone recomputing them, and
 * the accounting that produces a headline number is usually not stated. Our own first census run
 * booked +661,755 SOL of venue-wide profit before the both-legs-observed rule was applied, so a
 * number derived by counting proceeds without cost basis is not hypothetical - it is the default
 * mistake. Every figure here is recomputed from the decoded legs.
 *
 * WHAT A SINGLE WALLET CANNOT DO is establish an edge. It is one draw, selected because it won, from
 * a population where MT175 found 81% of wallets lose. Whatever it did is consistent with skill and
 * equally consistent with being the lucky tail, and nothing here can separate those. This tool
 * characterises a mechanism; it does not measure an expectation.
 *
 * Reads tape. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const WALLETS = (arg('wallets') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
const WINDOWS = (arg('windows') ?? 'A0,A1,A2,A3,A4,A5,A6,A7,D0,D1,D2,D3,D4,D5,D6,D7,E').split(',').filter((s) => s.length > 0);
const CACHE = 'data/trade-cache';
/**
 * DISCOVERY: find the winners in our own tape rather than taking them from a leaderboard.
 *
 * This turned out to matter. The one address a public dashboard offered does not appear anywhere in
 * 59 million trades of this archive, because that dashboard was published over a year ago, and the
 * live leaderboards render their tables in the browser so there is nothing to read. Sourcing a
 * "current winner" from the web is unreliable in a way that is easy to miss: a stale address returns
 * no data, which looks the same as a wallet that simply trades elsewhere.
 *
 * Ranking our own tape has none of those problems. The wallets it returns are provably profitable on
 * data we decoded ourselves, they are current, and their profit is computed with the both-legs-observed
 * rule rather than whatever a dashboard chose to count.
 */
const DISCOVER = Number(arg('discover') ?? '0');
const DISCOVER_WINDOWS = (arg('discover-windows') ?? 'E').split(',').filter((s) => s.length > 0);
if (WALLETS.length === 0 && DISCOVER === 0) { console.log('need --wallets=<pubkey,...> or --discover=<N>'); process.exit(2); }

const poolBorn = new Map<string, number>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; createdSlot?: number }; if (r.createdSlot !== undefined) poolBorn.set(r.pool, r.createdSlot); } catch { /* skip */ }
}

if (DISCOVER > 0) {
  const acc = new Map<string, { qIn: number; qOut: number; bIn: number; bOut: number }>();
  for (const w of DISCOVER_WINDOWS) {
    const f = `${CACHE}/w${w}.jsonl`;
    if (!existsSync(f)) continue;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
      try { r = JSON.parse(line) as typeof r; } catch { continue; }
      const u = r[13]; const uq = Number(r[9]); const base = Number(r[14]);
      if (u === undefined || !Number.isFinite(uq) || !Number.isFinite(base)) continue;
      const k = `${u}|${r[0]}`;
      let g = acc.get(k);
      if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0 }; acc.set(k, g); }
      if (r[5] === 1) { g.qIn += uq; g.bIn += base; } else { g.qOut += uq; g.bOut += base; }
    }
    rl.close();
  }
  const byWallet = new Map<string, number>();
  for (const [k, g] of acc) {
    const u = k.slice(0, k.indexOf('|'));
    const matched = Math.min(g.bIn, g.bOut);
    if (matched <= 0) continue;
    byWallet.set(u, (byWallet.get(u) ?? 0) + (g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn)));
  }
  const top = [...byWallet.entries()].sort((a, b) => b[1] - a[1]).slice(0, DISCOVER);
  console.log(`Discovered the ${DISCOVER} most profitable wallets in windows ${DISCOVER_WINDOWS.join(',')}:`);
  for (const [u, v] of top) console.log(`  ${u}  ${(v / 1e9).toFixed(2)} SOL`);
  console.log('');
  WALLETS.push(...top.map(([u]) => u));
}

const want = new Set(WALLETS);
interface Leg { qIn: number; qOut: number; bIn: number; bOut: number; firstBuySlot: number; lastSlot: number; window: string }
const legs = new Map<string, Leg>();
const trades = new Map<string, number>();
let scanned = 0;

for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let r: [string, number, number, number, string, number, string, string, string, string, number, number, number, string, string];
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    scanned += 1;
    const user = r[13];
    if (user === undefined || !want.has(user)) continue;
    trades.set(user, (trades.get(user) ?? 0) + 1);
    const uq = Number(r[9]); const base = Number(r[14]);
    if (!Number.isFinite(uq) || !Number.isFinite(base)) continue;
    const k = `${user}|${r[0]}|${w}`;
    let g = legs.get(k);
    if (g === undefined) { g = { qIn: 0, qOut: 0, bIn: 0, bOut: 0, firstBuySlot: -1, lastSlot: r[1], window: w }; legs.set(k, g); }
    g.lastSlot = r[1];
    if (r[5] === 1) { g.qIn += uq; g.bIn += base; if (g.firstBuySlot < 0) g.firstBuySlot = r[1]; }
    else { g.qOut += uq; g.bOut += base; }
  }
  rl.close();
}

console.log(`WALLET CHECK — ${scanned.toLocaleString()} trades scanned across ${WINDOWS.length} windows`);
console.log('');
const SOL = (x: number): string => (x / 1e9).toFixed(4);
const med = (a: number[]): number => { if (a.length === 0) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };

for (const wal of WALLETS) {
  const mine = [...legs.entries()].filter(([k]) => k.startsWith(`${wal}|`));
  console.log(`  ${wal}`);
  if (mine.length === 0) {
    console.log(`    NOT PRESENT in any window of our tape. Either it does not trade PumpSwap WSOL pools,`);
    console.log(`    or it was not active in the roughly 27 days this archive covers.`);
    console.log('');
    continue;
  }
  let pnl = 0; let closed = 0; let wins = 0; let atBirth = 0; let classified = 0;
  let uncosted = 0;
  const holds: number[] = []; const delays: number[] = [];
  const pools = new Set<string>();
  for (const [k, g] of mine) {
    const pool = k.split('|')[1] ?? '';
    pools.add(pool);
    /** Both-legs-observed, exactly as MT175. Proceeds without a cost basis are NOT profit. */
    const matched = Math.min(g.bIn, g.bOut);
    if (g.bIn <= 0 && g.bOut > 0) uncosted += g.qOut;
    if (matched > 0) {
      const realised = g.qOut * (matched / g.bOut) - g.qIn * (matched / g.bIn);
      pnl += realised; closed += 1; if (realised > 0) wins += 1;
      const born = poolBorn.get(pool);
      if (born !== undefined && g.firstBuySlot >= born) {
        classified += 1;
        if (g.firstBuySlot === born) atBirth += 1;
        delays.push(g.firstBuySlot - born);
      }
      holds.push(g.lastSlot - g.firstBuySlot);
    }
  }
  console.log(`    trades ${(trades.get(wal) ?? 0).toLocaleString()}   pools ${pools.size.toLocaleString()}   closed round trips ${closed.toLocaleString()}`);
  console.log(`    realised profit (both legs observed): ${SOL(pnl)} SOL`);
  console.log(`    win rate ${closed > 0 ? ((100 * wins) / closed).toFixed(1) : 'n/a'}%`);
  if (uncosted > 0) {
    console.log(`    NOTE: ${SOL(uncosted)} SOL of proceeds had NO observed purchase in this tape and is excluded.`);
    console.log(`          That is inventory bought before the window or on the bonding curve. A naive`);
    console.log(`          leaderboard would count all of it as profit.`);
  }
  if (classified > 0) {
    console.log(`    entries in the pool's BIRTH SLOT: ${atBirth}/${classified} = ${((100 * atBirth) / classified).toFixed(1)}%   (MT175: top-10 wallets 52.3%, everyone else 0.0-0.2%)`);
    console.log(`    median entry delay after pool birth: ${med(delays).toFixed(0)} slots (${(med(delays) * 0.4).toFixed(0)}s)`);
  } else {
    console.log(`    entry timing not measurable: none of its pools were watched from birth in this tape`);
  }
  console.log(`    median hold: ${med(holds).toFixed(0)} slots (${(med(holds) * 0.4 / 60).toFixed(1)} min)`);
  /**
   * PER WINDOW, BECAUSE A TOTAL HIDES WHETHER THE WALLET EARNS OR MERELY EARNED ONCE.
   *
   * This is the concentration test applied to one wallet. A total of a few thousand SOL is
   * consistent with a repeatable operation and equally consistent with a single enormous trade
   * surrounded by noise, and those two have completely different implications for whether the
   * behaviour is worth understanding. Splitting by window separates them, and the count of
   * profitable windows is the honest headline rather than the sum.
   */
  const byWin = new Map<string, number>();
  for (const [k, g] of mine) {
    const win = k.split('|')[2] ?? '?';
    const m2 = Math.min(g.bIn, g.bOut);
    if (m2 <= 0) continue;
    byWin.set(win, (byWin.get(win) ?? 0) + (g.qOut * (m2 / g.bOut) - g.qIn * (m2 / g.bIn)));
  }
  const wins2 = [...byWin.entries()].filter(([, v]) => v > 0).length;
  const vals = [...byWin.values()].sort((x, y) => y - x);
  console.log(`    per-window: ${wins2}/${byWin.size} profitable   best window ${SOL(vals[0] ?? 0)} SOL   ` +
    `total without best window ${SOL(vals.slice(1).reduce((x, y) => x + y, 0))} SOL`);
  console.log(`      ${[...byWin.entries()].map(([w2, v]) => `${w2}:${(v / 1e9).toFixed(0)}`).join('  ')}`);
  console.log('');
}
console.log('  One wallet cannot establish an edge. It is a single draw selected because it won, from a');
console.log('  population where 81% lose. This says what it DID, not what it can be expected to earn.');
