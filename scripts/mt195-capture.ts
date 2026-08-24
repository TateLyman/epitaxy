/**
 * MT195 — what fraction of the opportunities does a SEQUENTIAL bot actually get to take?
 *
 * Every sweep in this programme scores each qualifying curve independently, as though the bot could
 * be in all of them at once. The live bot cannot: it holds one position at a time and ignores every
 * candidate that crosses while it is busy. If qualifying curves arrive faster than positions close,
 * the measured growth per trade is real but the growth per DAY is a fiction, and the gap is pure
 * unrealised opportunity.
 *
 * The numbers make this worth checking rather than assuming. Block D carries 370 filtered positions
 * across roughly 2.25 days, which is on the order of one every ten minutes, against a median hold of
 * about 69 seconds - but the hold distribution has a long tail, and a single position that runs 45
 * minutes blocks everything behind it.
 *
 * SO THIS REPLAYS THE ARRIVALS AGAINST A BUSY FLAG, in slot order, exactly as the live bot behaves:
 * a candidate that crosses while a position is open is dropped and never revisited. It reports what
 * a sequential bot captures, what allowing N concurrent positions would capture, and - the part that
 * decides anything - whether the extra positions are as good as the ones already being taken.
 *
 * CONCURRENCY IS NOT FREE AND THE REPORT MUST NOT PRETEND IT IS. Holding three positions at f each
 * is three times the exposure of holding one, on outcomes that are correlated because they are the
 * same market minutes apart. The right comparison is therefore not total growth but growth against
 * exposure, and both are printed.
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
const SLOTS = (arg('slots') ?? '1,2,3,5,999').split(',').map(Number);
const DIR = 'data/sqd/events-6EF8rrec';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };
const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL;
const STOP_AT = ENTRY - STOP_BELOW;

/** A position as the live bot would experience it: opened at a slot, closed at a slot. */
interface Pos { mint: string; openSlot: number; closeSlot: number; bps: number }
const positions: Pos[] = [];

interface S { hold: Map<string, number>; phase: 0 | 1 | 2 | 3; tok: number; openSlot: number }
const st = new Map<string, S>();

const files = readdirSync(DIR).filter((x) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(x);
  return m !== null && Number(m[2]) >= BC_FROM && Number(m[1]) <= BC_TO;
}).sort();
console.log(`MT195 — sequential capture rate, entry ${ENTRY}, ${files.length} files`);

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
      let p = st.get(mint);
      if (p === undefined) { p = { hold: new Map(), phase: 0, tok: 0, openSlot: 0 }; st.set(mint, p); }
      const user = b.subarray(OFF.user, OFF.user + 32).toString('base64');
      const tokens = Number(b.readBigUInt64LE(OFF.tokenAmount)) / 1e6;
      p.hold.set(user, (p.hold.get(user) ?? 0) + (b.readUInt8(OFF.isBuy) === 1 ? tokens : -tokens));
      if (p.phase === 3) continue;

      if (p.phase === 0) {
        if (rSol >= ENTRY - WATCH_BELOW && rSol < ENTRY) p.phase = 1;
        else if (rSol >= ENTRY) p.phase = 3;
        continue;
      }
      if (p.phase === 1) {
        if (rSol < ENTRY) continue;
        if (rSol > ENTRY + MAX_OVERSHOOT) { p.phase = 3; continue; }
        const bal = [...p.hold.values()].filter((v) => v > 0).sort((a, c) => c - a);
        const supply = bal.reduce((a, c) => a + c, 0);
        if (!(supply > 0)) continue;
        const top10 = (100 * bal.slice(0, 10).reduce((a, c) => a + c, 0)) / supply;
        if (top10 < CONC_LO || top10 > CONC_HI) { p.phase = 3; continue; }
        const tok = buyTokens(vSol, vTok, NOTIONAL);
        if (!(tok > 0)) { p.phase = 3; continue; }
        p.tok = tok; p.phase = 2; p.openSlot = slot;
        continue;
      }
      if (rSol <= STOP_AT || rSol >= EXIT) {
        positions.push({ mint, openSlot: p.openSlot, closeSlot: slot, bps: 1e4 * (sellSol(vSol, vTok, p.tok) / NOTIONAL - 1) - fixedBps });
        p.phase = 3;
      }
    }
  }
  rl.close();
}
positions.sort((a, b) => a.openSlot - b.openSlot);
const spanDays = (BC_TO - BC_FROM) / 216_000;
console.log(`  ${positions.length.toLocaleString()} qualifying positions over ${spanDays.toFixed(2)} days = ${(positions.length / spanDays).toFixed(0)}/day`);
/**
 * 0.4 seconds per slot is correct for THIS tape and is no longer correct for live trading. SIMD-0525
 * cut mainnet slot time to 350 ms on 2026-08-22, after every block in this archive. Converting
 * historical slots at the historical rate is right; any LIVE measurement of trades per second must
 * use 0.35, which makes a curve trade about 14% faster than the tape implies and puts our entry
 * latency at correspondingly more trades of delay.
 */
const SLOT_SECONDS_HISTORICAL = 0.4;
const holds = positions.map((p) => (p.closeSlot - p.openSlot) * SLOT_SECONDS_HISTORICAL).sort((a, b) => a - b);
console.log(`  hold seconds: p50 ${holds[Math.floor(holds.length / 2)]?.toFixed(0)}  p90 ${holds[Math.floor(holds.length * 0.9)]?.toFixed(0)}  max ${holds[holds.length - 1]?.toFixed(0)}`);
console.log('');

const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

console.log('  slots   taken   capture   mean bps   g/trade   TOTAL log growth   per unit exposure');
for (const cap of SLOTS) {
  /** Replay arrivals in order against a fixed number of concurrent slots. */
  const busyUntil: number[] = new Array<number>(Math.min(cap, 64)).fill(0);
  const taken: number[] = [];
  for (const p of positions) {
    const free = busyUntil.findIndex((u) => u <= p.openSlot);
    if (free < 0) continue;
    busyUntil[free] = p.closeSlot;
    taken.push(p.bps);
  }
  if (taken.length === 0) continue;
  const g = growth(taken, 0.20);
  const total = g * taken.length;
  console.log(
    `  ${String(cap === 999 ? 'inf' : cap).padStart(5)} ${String(taken.length).padStart(7)} ${((100 * taken.length) / positions.length).toFixed(0).padStart(8)}% ` +
    `${mean(taken).toFixed(0).padStart(10)} ${g.toFixed(4).padStart(9)} ${total.toFixed(2).padStart(18)} ${(total / Math.min(cap, 64)).toFixed(2).padStart(19)}`,
  );
}
console.log('');
console.log('  Capture below 100% is opportunity a sequential bot never sees. But concurrency multiplies');
console.log('  exposure on correlated outcomes, so the last column - growth per unit of capital at risk -');
console.log('  is the one that decides whether more slots are worth having.');
