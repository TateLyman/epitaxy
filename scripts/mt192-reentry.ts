/**
 * MT192 — after a stop, does climbing back into the band deserve a second position?
 *
 * MT189 measured the regret directly: of the positions the eight-SOL stop cuts, 32% reach the 82 SOL
 * target afterwards anyway. The stop is not wrong - MT188 swept it and the wider variants lose more
 * to the curves that never recover than they gain from the ones that do - but a third of what it cuts
 * is a real, recurring, MEASURED opportunity that the strategy currently walks away from and never
 * looks at again.
 *
 * A stop and a re-entry answer different questions. The stop asks whether THIS position should still
 * be held, and cutting is right because the curve has fallen eight SOL and might be dying. Re-entry
 * asks whether a curve that has since climbed all the way back into the entry band is worth buying,
 * which is the same question the strategy answers with "yes" for any other curve arriving there. That
 * a previous position was stopped is history; the curve in front of us satisfies the entry rule.
 *
 * THE COST IS NOT SMALL AND IS WHY THIS NEEDS MEASURING RATHER THAN ASSUMING. Every re-entry pays the
 * full round trip again - two lots of the 1% curve fee, the transaction cost, and fresh price impact -
 * and it buys a curve that has already demonstrated it can fall eight SOL. A curve that whipsaws will
 * take the fee repeatedly, which is exactly the pattern that destroys accounts, so the number of
 * re-entries per curve is capped and swept rather than left open.
 *
 * Each re-entry is priced at the reserves standing when the curve re-crosses the band, with no
 * knowledge of what follows. The concentration filter is re-applied at that moment rather than
 * inherited, because holders change while a curve falls and recovers, and the whole point of the
 * filter is that it reflects who holds the token NOW.
 *
 * Reads the bonding-curve tape only.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, tokenAmount: 48, isBuy: 56, user: 57, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const FEE = 0.01;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BC_FROM = Number(arg('from') ?? '0');
const BC_TO = Number(arg('to') ?? '999999999');
const NOTIONAL = Number(arg('notional') ?? '0.05');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
const ENTRY = Number(arg('entry') ?? '55');
const EXIT = Number(arg('exit') ?? '82');
const STOP_BELOW = Number(arg('stop-below') ?? '8');
const WATCH_BELOW = Number(arg('watch-below') ?? '10');
const MAX_OVERSHOOT = Number(arg('max-overshoot') ?? '4');
const CONC_LO = Number(arg('conc-lo') ?? '50');
const CONC_HI = Number(arg('conc-hi') ?? '80');
/** How many times a single curve may be bought. 1 is today's behaviour. */
const MAX_ENTRIES = (arg('max-entries') ?? '1,2,3,5').split(',').map(Number);
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;
const STOP_AT = ENTRY - STOP_BELOW;

/** One independent run of the strategy per cap, over the same curve. */
interface Slot { entries: number; holding: boolean; tok: number; armed: boolean }
interface C { hold: Map<string, number>; s: Slot[]; lastVSol: number; lastVTok: number }
const curves = new Map<string, C>();
const outs: number[][] = MAX_ENTRIES.map(() => []);
const reentryOuts: number[][] = MAX_ENTRIES.map(() => []);

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT192 — re-entry after a stop. entry ${ENTRY}, target ${EXIT}, stop ${STOP_AT}, ${files.length} files`);

for (const f of files) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { header?: { number?: number }; instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as typeof blk; } catch { continue; }
    const slot = blk.header?.number ?? 0;
    if (slot < BC_FROM || slot > BC_TO) continue;
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
      if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
      const b = raw.subarray(8);
      if (b.length < NEED || !b.subarray(0, 8).equals(TRADE_EVENT)) continue;
      const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
      const vTok = Number(b.readBigUInt64LE(OFF.vTok)) / 1e6;
      const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
      if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) continue;
      if (!(vSol > 0) || !(vTok > 0)) continue;

      const mint = b.subarray(OFF.mint, OFF.mint + 32).toString('base64');
      let c = curves.get(mint);
      if (c === undefined) { c = { hold: new Map(), s: MAX_ENTRIES.map(() => ({ entries: 0, holding: false, tok: 0, armed: false })), lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      c.lastVSol = vSol; c.lastVTok = vTok;
      const user = b.subarray(OFF.user, OFF.user + 32).toString('base64');
      const tokens = Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6;
      c.hold.set(user, (c.hold.get(user) ?? 0) + (b.readUInt8(OFF.isBuy) === 1 ? tokens : -tokens));

      for (let k = 0; k < MAX_ENTRIES.length; k += 1) {
        const st = c.s[k] as Slot;
        if (st.holding) {
          if (rSol <= STOP_AT) {
            const bps = 1e4 * (sellSol(vSol, vTok, st.tok) / NOTIONAL - 1) - fixedBps;
            (outs[k] as number[]).push(bps);
            if (st.entries > 1) (reentryOuts[k] as number[]).push(bps);
            st.holding = false; st.armed = false;
            continue;
          }
          if (rSol >= EXIT) {
            const bps = 1e4 * (sellSol(vSol, vTok, st.tok) / NOTIONAL - 1) - fixedBps;
            (outs[k] as number[]).push(bps);
            if (st.entries > 1) (reentryOuts[k] as number[]).push(bps);
            /** A target hit ends this curve entirely: it is about to graduate. */
            st.holding = false; st.entries = MAX_ENTRIES[k] as number;
            continue;
          }
          continue;
        }
        if (st.entries >= (MAX_ENTRIES[k] as number)) continue;
        /** Arm below the band, so every entry - first or later - follows an observed climb. */
        if (rSol >= ENTRY - WATCH_BELOW && rSol < ENTRY) { st.armed = true; continue; }
        if (!st.armed || rSol < ENTRY || rSol > ENTRY + MAX_OVERSHOOT) continue;
        /** Concentration re-read at THIS instant; holders change while a curve falls and recovers. */
        const bal = [...c.hold.values()].filter((v) => v > 0).sort((x, y) => y - x);
        const supply = bal.reduce((x, y) => x + y, 0);
        if (!(supply > 0)) continue;
        const top10 = (100 * bal.slice(0, 10).reduce((x, y) => x + y, 0)) / supply;
        if (top10 < CONC_LO || top10 > CONC_HI) { st.armed = false; continue; }
        const tok = buyTokens(vSol, vTok, NOTIONAL);
        if (!(tok > 0)) continue;
        st.tok = tok; st.holding = true; st.armed = false; st.entries += 1;
      }
    }
  }
  rl.close();
}
for (const c of curves.values()) {
  for (let k = 0; k < MAX_ENTRIES.length; k += 1) {
    const st = c.s[k] as Slot;
    if (!st.holding) continue;
    const bps = 1e4 * (sellSol(c.lastVSol, c.lastVTok, st.tok) / NOTIONAL - 1) - fixedBps;
    (outs[k] as number[]).push(bps);
    if (st.entries > 1) (reentryOuts[k] as number[]).push(bps);
    st.holding = false;
  }
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const dis = (o: number[]): string => `${((100 * o.filter((x) => x <= -5000).length) / o.length).toFixed(1)}%`;

console.log('');
console.log(`  stake ${NOTIONAL} SOL, concentration band ${CONC_LO}-${CONC_HI}%`);
console.log('');
console.log('  maxEntries      n    hit%   disasters      mean   g(.05)   g(.20)');
for (let k = 0; k < MAX_ENTRIES.length; k += 1) {
  const o = outs[k] as number[];
  if (o.length < 40) continue;
  console.log(
    `  ${String(MAX_ENTRIES[k]).padStart(10)} ${String(o.length).padStart(6)} ${((100 * o.filter((x) => x > 0).length) / o.length).toFixed(0).padStart(6)}% ` +
    `${dis(o).padStart(9)} ${mean(o).toFixed(0).padStart(9)} ${growth(o, 0.05).toFixed(4).padStart(8)} ${growth(o, 0.20).toFixed(4).padStart(8)}`,
  );
}
console.log('');
console.log('  THE RE-ENTRIES ALONE — the positions that would not exist without this change.');
console.log('  maxEntries      n    hit%      mean   g(.20)');
for (let k = 0; k < MAX_ENTRIES.length; k += 1) {
  const o = reentryOuts[k] as number[];
  if (o.length < 30) { console.log(`  ${String(MAX_ENTRIES[k]).padStart(10)} ${String(o.length).padStart(6)}  too few`); continue; }
  console.log(
    `  ${String(MAX_ENTRIES[k]).padStart(10)} ${String(o.length).padStart(6)} ${((100 * o.filter((x) => x > 0).length) / o.length).toFixed(0).padStart(6)}% ` +
    `${mean(o).toFixed(0).padStart(9)} ${growth(o, 0.20).toFixed(4).padStart(8)}`,
  );
}
console.log('');
console.log('  Re-entries must carry their own weight. If they earn less than the first entries they');
console.log('  dilute the strategy even when the combined number still looks acceptable.');
