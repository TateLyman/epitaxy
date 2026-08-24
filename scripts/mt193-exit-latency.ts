/**
 * MT193 — what does the backtest's instantaneous exit actually cost us in the real world?
 *
 * Every simulation in this programme resolves a position at THE EVENT where the barrier is crossed:
 * the first trade at or below the stop, the first at or above the target. That is a fiction and it has
 * never been priced. A live bot polls the curve every two seconds, then fetches a quote, then builds
 * an order, then lands a transaction - and the curve keeps trading throughout. The exit happens
 * several trades later than the simulation says, at whatever price those trades left behind.
 *
 * THIS MATTERS BECAUSE THE CURRENT NUMBERS ARE NOT CREDIBLE AND SAYING SO IS THE POINT. Growth of
 * 0.0241 at f=0.20 across roughly 44 qualifying positions a day is about +2.4% of the bankroll per
 * trade, dozens of times daily. That is the same impossible-wealth signature that condemned MT171,
 * and the honest response is to hunt for what binds it rather than to bank the number.
 *
 * LATENCY IS ASYMMETRIC, WHICH IS WHY IT CANNOT BE WAVED AWAY AS NOISE. A stop fires because the
 * curve is falling, so the trades after the trigger are more likely to be lower still - delay makes
 * losses worse. A target fires because the curve is rising, and the trades after MIGHT be higher, but
 * the target sits at 82 SOL where graduation is imminent and migration can remove the venue entirely.
 * A live position hit its target and was worth -91.5% ten minutes later for exactly that reason. So
 * the two sides do not cancel and the net cost has to be measured rather than assumed to be small.
 *
 * Delay is expressed in EVENTS rather than seconds because that is what the tape records and what
 * actually moves the price: a busy curve trades many times per second, and it is the trades in
 * between, not the wall-clock, that decide the fill.
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
/** Events between the barrier being crossed and our order landing. 0 is the fiction every sweep used. */
const DELAYS = (arg('delays') ?? '0,1,2,3,5,10,20').split(',').map(Number);
/**
 * ENTRY latency, which was never priced either and is the same error on the other side.
 *
 * Every sweep buys at the exact event where the curve crosses the entry level. A live bot sees that
 * trade, reads the holder distribution, fetches a quote, builds an order, signs it and lands it -
 * and the curve trades throughout. Unlike the exit, the sign of this is not obvious: buying late
 * into a curve that is climbing means paying more for less room to the target, but it also means
 * the curves that immediately collapse are never bought at all. Whether that selection pays for the
 * worse price is exactly the sort of thing that cannot be reasoned out and has to be measured.
 */
const ENTRY_DELAY = Number(arg('entry-delay') ?? '0');
/**
 * THE SHORTFALL GATE, WHICH THE LIVE BOT HAS AND THIS SIMULATION DID NOT.
 *
 * Modelling entry delay by simply buying N trades later overstates the damage, because a real bot
 * compares the quote it finally receives against the curve's own closed-form price and REFUSES a fill
 * that has run away. In a dry run that gate fired at 1,131 bps. Delay hurts most precisely when the
 * curve moved a lot while we were building the order, and that is exactly the case the gate declines,
 * so the two interact and the loss cannot be read off the delay alone.
 */
const MAX_SHORTFALL_BPS = Number(arg('max-shortfall-bps') ?? '200');
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;
const STOP_AT = ENTRY - STOP_BELOW;

/**
 * A position per delay. `pending` counts down the events between the trigger and the fill, so the
 * exit price is whatever the curve reached while our order was in flight.
 */
interface Slot { phase: 0 | 1 | 2 | 3; tok: number; pending: number; why: 'stop' | 'target' | ''; armEntry: number; triggerVSol: number; triggerVTok: number }
interface C { hold: Map<string, number>; s: Slot[]; lastVSol: number; lastVTok: number }
const curves = new Map<string, C>();
const outs: number[][] = DELAYS.map(() => []);
const stopOuts: number[][] = DELAYS.map(() => []);
const tgtOuts: number[][] = DELAYS.map(() => []);

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT193 — latency. entry ${ENTRY} (buy delay ${ENTRY_DELAY}), target ${EXIT}, stop ${STOP_AT}, ${files.length} files`);

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
      if (c === undefined) { c = { hold: new Map(), s: DELAYS.map(() => ({ phase: 0 as 0, tok: 0, pending: -1, why: '' as const, armEntry: -1, triggerVSol: 0, triggerVTok: 0 })), lastVSol: vSol, lastVTok: vTok }; curves.set(mint, c); }
      c.lastVSol = vSol; c.lastVTok = vTok;
      const user = b.subarray(OFF.user, OFF.user + 32).toString('base64');
      const tokens = Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6;
      c.hold.set(user, (c.hold.get(user) ?? 0) + (b.readUInt8(OFF.isBuy) === 1 ? tokens : -tokens));

      for (let k = 0; k < DELAYS.length; k += 1) {
        const st = c.s[k] as Slot;
        if (st.phase === 3) continue;

        /** An order already in flight fills here if its delay has elapsed. */
        if (st.pending >= 0) {
          if (st.pending === 0) {
            const bps = 1e4 * (sellSol(vSol, vTok, st.tok) / NOTIONAL - 1) - fixedBps;
            (outs[k] as number[]).push(bps);
            (st.why === 'stop' ? (stopOuts[k] as number[]) : (tgtOuts[k] as number[])).push(bps);
            st.phase = 3; st.pending = -1;
          } else st.pending -= 1;
          continue;
        }

        if (st.phase === 0) {
          if (rSol >= ENTRY - WATCH_BELOW && rSol < ENTRY) st.phase = 1;
          else if (rSol >= ENTRY) st.phase = 3;
          continue;
        }
        if (st.phase === 1) {
          if (rSol < ENTRY) continue;
          /** Arm on the crossing, buy ENTRY_DELAY trades later at whatever price stands then. */
          if (st.armEntry < 0) { st.armEntry = ENTRY_DELAY; st.triggerVSol = vSol; st.triggerVTok = vTok; if (ENTRY_DELAY > 0) continue; }
          else if (st.armEntry > 0) { st.armEntry -= 1; continue; }
          /**
           * Refuse a fill that has run away from the price we decided on. This is the live gate, and
           * without it the delayed entry buys at any price the curve happened to reach.
           */
          if (st.triggerVSol > 0) {
            const wouldGet = buyTokens(vSol, vTok, NOTIONAL);
            const atTrigger = buyTokens(st.triggerVSol, st.triggerVTok, NOTIONAL);
            if (atTrigger > 0 && 1e4 * (1 - wouldGet / atTrigger) > MAX_SHORTFALL_BPS) { st.phase = 3; continue; }
          }
          if (rSol > ENTRY + MAX_OVERSHOOT) { st.phase = 3; continue; }
          const bal = [...c.hold.values()].filter((v) => v > 0).sort((x, y) => y - x);
          const supply = bal.reduce((x, y) => x + y, 0);
          if (!(supply > 0)) continue;
          const top10 = (100 * bal.slice(0, 10).reduce((x, y) => x + y, 0)) / supply;
          if (top10 < CONC_LO || top10 > CONC_HI) { st.phase = 3; continue; }
          const tok = buyTokens(vSol, vTok, NOTIONAL);
          if (!(tok > 0)) { st.phase = 3; continue; }
          st.tok = tok; st.phase = 2;
          continue;
        }
        /** Barrier crossed: the order is SENT here and fills DELAYS[k] events later. */
        if (rSol <= STOP_AT) { st.why = 'stop'; st.pending = DELAYS[k] as number; continue; }
        if (rSol >= EXIT) { st.why = 'target'; st.pending = DELAYS[k] as number; continue; }
      }
    }
  }
  rl.close();
}
for (const c of curves.values()) {
  for (let k = 0; k < DELAYS.length; k += 1) {
    const st = c.s[k] as Slot;
    if (st.phase !== 2 && st.pending < 0) continue;
    const bps = 1e4 * (sellSol(c.lastVSol, c.lastVTok, st.tok) / NOTIONAL - 1) - fixedBps;
    (outs[k] as number[]).push(bps);
    if (st.why === 'stop') (stopOuts[k] as number[]).push(bps);
    else if (st.why === 'target') (tgtOuts[k] as number[]).push(bps);
    st.phase = 3;
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
console.log(`  stake ${NOTIONAL} SOL, band ${CONC_LO}-${CONC_HI}%. Delay is in TRADES between trigger and fill.`);
console.log('');
console.log('  delay      n   disasters      mean   stopMean   tgtMean   g(.05)   g(.20)');
for (let k = 0; k < DELAYS.length; k += 1) {
  const o = outs[k] as number[];
  if (o.length < 40) continue;
  console.log(
    `  ${String(DELAYS[k]).padStart(5)} ${String(o.length).padStart(6)} ${dis(o).padStart(9)} ${mean(o).toFixed(0).padStart(9)} ` +
    `${mean(stopOuts[k] as number[]).toFixed(0).padStart(10)} ${mean(tgtOuts[k] as number[]).toFixed(0).padStart(9)} ` +
    `${growth(o, 0.05).toFixed(4).padStart(8)} ${growth(o, 0.20).toFixed(4).padStart(8)}`,
  );
}
console.log('');
console.log('  Delay 0 is the fiction every previous sweep assumed. If growth collapses across this');
console.log('  row, the strategy was never as good as measured and the gap is execution, not edge.');
