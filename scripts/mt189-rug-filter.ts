/**
 * MT189 — does holder concentration at entry predict the catastrophic tail?
 *
 * A live position lost 90% when its curve collapsed from 69.7 SOL to 1.26 inside a SINGLE
 * transaction. No stop can act on that: a two-second poll, a websocket, a colocated node - all of
 * them look after the transaction has landed. Reacting faster is not the answer and never was. The
 * only defence against a one-transaction collapse is not holding the position when it happens.
 *
 * A COLLAPSE THAT LARGE IS ARITHMETIC, NOT SENTIMENT. Taking a curve from 69.7 SOL of reserves down
 * to 1.26 requires selling back most of the tokens the curve ever issued, so one wallet, or a few
 * acting together, must have been holding most of the supply. That position was bought earlier, on
 * the same curve, and every one of those buys is in our tape: the TradeEvent carries the user, the
 * side and the token amount. The holder distribution is therefore RECONSTRUCTABLE at any instant,
 * including the instant we would decide to buy.
 *
 * Published guidance says the same thing from the outside - top-ten concentration above roughly 30%
 * of circulating supply is the strongest single rug indicator, and a deployer plus a few snipers
 * above 35% means the chart belongs to them. That agreement is worth something, but it is not
 * evidence for OUR population: those thresholds are quoted for tokens in general, whereas we only
 * ever touch curves that have already climbed past 45 SOL, which is a small and unusual subset. So
 * the thresholds are measured here rather than adopted.
 *
 * WHAT WOULD MAKE THIS WORTH IMPLEMENTING is not that concentrated curves are riskier on average -
 * that would be unsurprising and could easily be paid for by higher returns. It is specifically
 * whether concentration separates the DISASTERS, the positions that lose more than half, because
 * those are what a mean cannot absorb and what ruins a bankroll running near the Kelly peak.
 *
 * Two passes: the first finds curves that reach the watch level at all, the second reconstructs
 * per-wallet holdings for only those, which keeps the wallet map to a size worth holding in memory.
 *
 * Reads the bonding-curve tape only.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
/** mint(32)@8, solAmount@40, tokenAmount@48, isBuy@56, user(32)@57, ts@89, then reserves. */
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
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT189 — does concentration predict the tail? entry ${ENTRY}, ${files.length} files`);

async function* events(): AsyncGenerator<{ mint: string; user: string; isBuy: boolean; tokens: number; vSol: number; vTok: number; rSol: number }> {
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
        yield {
          mint: b.subarray(OFF.mint, OFF.mint + 32).toString('base64'),
          user: b.subarray(OFF.user, OFF.user + 32).toString('base64'),
          isBuy: b.readUInt8(OFF.isBuy) === 1,
          tokens: Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6,
          vSol, vTok, rSol,
        };
      }
    }
  }
}

// ---- pass 1: which curves ever reach the watch level ----
const reached = new Set<string>();
for await (const e of events()) { if (e.rSol >= ENTRY - WATCH_BELOW) reached.add(e.mint); }
console.log(`  ${reached.size.toLocaleString()} curves reach ${ENTRY - WATCH_BELOW} SOL — holders tracked for these only`);

// ---- pass 2: reconstruct holders, then simulate ----
interface P { hold: Map<string, number>; phase: 0 | 1 | 2 | 3; tok: number; top1: number; top10: number; nHold: number; out: number; how: string; lastVSol: number; lastVTok: number }
const st = new Map<string, P>();
for await (const e of events()) {
  if (!reached.has(e.mint)) continue;
  let p = st.get(e.mint);
  if (p === undefined) { p = { hold: new Map(), phase: 0, tok: 0, top1: 0, top10: 0, nHold: 0, out: 0, how: 'drift', lastVSol: e.vSol, lastVTok: e.vTok }; st.set(e.mint, p); }
  p.lastVSol = e.vSol; p.lastVTok = e.vTok;
  /** Net position per wallet, updated on every trade, so the distribution is exact at any instant. */
  p.hold.set(e.user, (p.hold.get(e.user) ?? 0) + (e.isBuy ? e.tokens : -e.tokens));

  if (p.phase === 3) continue;
  if (p.phase === 0) {
    if (e.rSol >= ENTRY - WATCH_BELOW && e.rSol < ENTRY) p.phase = 1;
    else if (e.rSol >= ENTRY) p.phase = 3;
    continue;
  }
  if (p.phase === 1) {
    if (e.rSol < ENTRY) continue;
    if (e.rSol > ENTRY + MAX_OVERSHOOT) { p.phase = 3; continue; }
    const tok = buyTokens(e.vSol, e.vTok, NOTIONAL);
    if (!(tok > 0)) { p.phase = 3; continue; }
    /** Concentration measured AT THE INSTANT OF ENTRY, from trades already past. */
    const bal = [...p.hold.values()].filter((v) => v > 0).sort((a, b) => b - a);
    const supply = bal.reduce((a, b) => a + b, 0);
    p.nHold = bal.length;
    p.top1 = supply > 0 ? (100 * (bal[0] ?? 0)) / supply : 0;
    p.top10 = supply > 0 ? (100 * bal.slice(0, 10).reduce((a, b) => a + b, 0)) / supply : 0;
    p.tok = tok; p.phase = 2;
    continue;
  }
  if (e.rSol <= ENTRY - STOP_BELOW) { p.out = 1e4 * (sellSol(e.vSol, e.vTok, p.tok) / NOTIONAL - 1) - fixedBps; p.how = 'stop'; p.phase = 3; continue; }
  if (e.rSol >= EXIT) { p.out = 1e4 * (sellSol(e.vSol, e.vTok, p.tok) / NOTIONAL - 1) - fixedBps; p.how = 'target'; p.phase = 3; continue; }
}
const rows: P[] = [];
for (const p of st.values()) {
  if (p.phase === 2) { p.out = 1e4 * (sellSol(p.lastVSol, p.lastVTok, p.tok) / NOTIONAL - 1) - fixedBps; p.how = 'drift'; p.phase = 3; }
  if (p.tok > 0) rows.push(p);
}
console.log(`  ${rows.length.toLocaleString()} positions`);
console.log('');

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

function band(title: string, key: (p: P) => number): void {
  const sorted = [...rows].sort((a, b) => key(a) - key(b));
  console.log(`  ${title}`);
  console.log('  quintile   range          n   target%   DISASTER%   mean   g(f=.05)  g(f=.35)');
  for (let k = 0; k < 5; k += 1) {
    const g = sorted.slice(Math.floor((k * sorted.length) / 5), Math.floor(((k + 1) * sorted.length) / 5));
    if (g.length < 20) continue;
    const o = g.map((p) => p.out);
    /** A disaster is a position losing more than half. Those are what a bankroll cannot absorb. */
    const disaster = (100 * o.filter((x) => x <= -5000).length) / o.length;
    console.log(
      `  ${String(k + 1).padStart(5)}      ${(key(g[0] as P).toFixed(0) + '-' + key(g[g.length - 1] as P).toFixed(0)).padEnd(12)} ${String(g.length).padStart(5)} ` +
      `${((100 * g.filter((p) => p.how === 'target').length) / g.length).toFixed(0).padStart(7)}% ` +
      `${disaster.toFixed(1).padStart(9)}% ${mean(o).toFixed(0).padStart(7)} ${growth(o, 0.05).toFixed(4).padStart(10)} ${growth(o, 0.35).toFixed(4).padStart(9)}`,
    );
  }
  console.log('');
}

console.log(`  stake ${NOTIONAL} SOL, entry ${ENTRY}, target ${EXIT}, stop ${ENTRY - STOP_BELOW}`);
console.log('');
band('TOP-1 HOLDER share of circulating supply at entry — lowest first', (p) => p.top1);
band('TOP-10 HOLDER share at entry — lowest first', (p) => p.top10);
band('NUMBER OF HOLDERS at entry — fewest first', (p) => p.nHold);
const all = rows.map((p) => p.out);
console.log(`  ALL: n=${rows.length}  mean ${mean(all).toFixed(0)}  disasters ${((100 * all.filter((x) => x <= -5000).length) / all.length).toFixed(1)}%  g(.05) ${growth(all, 0.05).toFixed(4)}  g(.35) ${growth(all, 0.35).toFixed(4)}`);
/**
 * THE BET-FRACTION CURVE ON THIS SAMPLE, AND ON THE CONCENTRATION-FILTERED SUBSET.
 *
 * Growth quoted at a single fraction is how a sizing error hides. Blocks D and E gave +0.0161 at
 * f=0.35; a wider span gives -0.0007 at the same fraction, which means the favourable-period
 * estimate would have justified a bet size that loses money over a longer run. The whole curve is
 * printed so the peak can be read rather than assumed.
 *
 * The filtered arm keeps only curves whose top-ten concentration sits in the band that showed a
 * 0.3% disaster rate on both LARGE samples. If that band survives here it is worth having; if it
 * moves with the sample it was never a band.
 */
const CONC_LO = Number(arg('conc-lo') ?? '44');
const CONC_HI = Number(arg('conc-hi') ?? '71');
const filtered = rows.filter((p) => p.top10 >= CONC_LO && p.top10 <= CONC_HI).map((p) => p.out);
const allOut = rows.map((p) => p.out);
const dis = (o: number[]): string => `${((100 * o.filter((x) => x <= -5000).length) / o.length).toFixed(1)}%`;
console.log('');
console.log(`  BET FRACTION CURVE.  unfiltered n=${allOut.length} (disasters ${dis(allOut)})   filtered ${CONC_LO}-${CONC_HI}% n=${filtered.length} (disasters ${filtered.length ? dis(filtered) : 'n/a'})`);
console.log('     f        unfiltered      concentration-filtered');
for (const f of [0.02, 0.05, 0.10, 0.15, 0.20, 0.35, 0.50]) {
  const a = growth(allOut, f);
  const b = filtered.length >= 40 ? growth(filtered, f) : NaN;
  const fmt = (x: number): string => (x === -Infinity ? 'RUIN' : Number.isNaN(x) ? 'n/a' : x.toFixed(4));
  console.log(`   ${f.toFixed(2)}   ${fmt(a).padStart(12)}   ${fmt(b).padStart(20)}`);
}
console.log('');
console.log('  The column that matters is DISASTER%. Concentration being riskier on average is');
console.log('  unsurprising and can be paid for; concentration predicting total losses cannot be.');
