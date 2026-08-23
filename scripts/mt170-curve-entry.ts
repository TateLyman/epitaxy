/**
 * MT170 — buy a bonding curve at X SOL of progress and sell at graduation. Does it pay?
 *
 * Everything in 169 rows has been POST-migration. This is the other half of the venue and it has
 * never been touched. Under 2% of launches graduate, so buying at launch needs a graduation
 * probability above roughly 6% against a base rate of 1 to 2% - a bet on selection. But that is the
 * WRONG ENTRY. A token already at 60 SOL of the 85 it needs is a different proposition entirely, and
 * the curve from there is deterministic.
 *
 * WHY THE CURVE IS A CLEANER INSTRUMENT THAN THE AMM. There is no impermanent loss, no market-cap
 * fee tier, no LP to be adverse to, and no routing: price is exactly virtual_sol / virtual_token and
 * the product is conserved. Every TradeEvent carries all four reserve fields, so progress toward the
 * 85 SOL threshold is observable without a single account read. The entire payoff from any level of
 * completion to graduation is therefore computable in advance rather than estimated.
 *
 * THE RISK IS STALLING, AND IT IS THE WHOLE QUESTION. A curve that reaches 60 SOL may graduate in
 * minutes or may sit there and bleed back down. So this measures two things separately and refuses
 * to blend them: the PROBABILITY of reaching 85 given that a level was reached, and the RETURN
 * conditional on each outcome.
 *
 * ENTRY AND EXIT ARE PRICED THROUGH THE CURVE ITSELF, not marked at mid. A buy of the notional moves
 * virtual_sol up and virtual_token down along the conserved product, and the sell is priced back
 * through the reserves as they stand at exit, so our own impact is charged on both legs. The venue
 * takes 1% per leg during the bonding phase and that is charged too.
 *
 * NO EXIT IS ASSUMED TO BE FREE. If a curve stalls we do not get to walk away at the entry price;
 * the position is marked at the curve where it actually ends up, which is the honest treatment and
 * the one that killed several earlier results when it was applied.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-6EF8rrec';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, sol: 40, isBuy: 56, ts: 89, vSol: 97, vTok: 105, rSol: 113 };
const NEED = 129;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const NOTIONAL_SOL = Number(arg('notional') ?? '0.02');
/** pump.fun charges 1% per leg during the bonding phase. */
const FEE = Number(arg('fee') ?? '0.01');
/** Fixed network and priority cost per round trip, from MT136. */
const FIXED_LAMPORTS = 46_000;
/** Real SOL levels at which we would enter, in SOL. */
const LEVELS = [10, 20, 30, 40, 50, 60, 70, 75, 80];
/** Graduation is at 85 SOL of real reserves; treat anything at or above as graduated. */
const GRAD = 84.0;

interface Ev { ts: number; vSol: number; vTok: number; rSol: number }
const byMint = new Map<string, Ev[]>();

const files = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f)).sort();
let scanned = 0;
for (const f of files) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as { instructions?: { data: string }[] }; } catch { continue; }
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
      if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
      const b = raw.subarray(8);
      if (b.length < NEED || !b.subarray(0, 8).equals(TRADE_EVENT)) continue;
      scanned += 1;
      const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
      const a = byMint.get(mint) ?? [];
      a.push({
        ts: Number(b.readBigInt64LE(OFF.ts)),
        vSol: Number(b.readBigUInt64LE(OFF.vSol)) / 1e9,
        vTok: Number(b.readBigUInt64LE(OFF.vTok)) / 1e6,
        rSol: Number(b.readBigUInt64LE(OFF.rSol)) / 1e9,
      });
      byMint.set(mint, a);
    }
  }
  rl.close();
  if (files.indexOf(f) % 5 === 0) console.log(`  ${f} — ${byMint.size.toLocaleString()} mints, ${scanned.toLocaleString()} trades`);
}
console.log('');
console.log(`MT170 — ${byMint.size.toLocaleString()} mints, ${scanned.toLocaleString()} bonding-curve trades`);

/** Buy `sol` into a curve with conserved product; returns tokens received. */
const buyTokens = (vSol: number, vTok: number, sol: number): number => {
  const k = vSol * vTok;
  const eff = sol * (1 - FEE);
  return vTok - k / (vSol + eff);
};
/** Sell `tok` back into a curve; returns SOL received. */
const sellSol = (vSol: number, vTok: number, tok: number): number => {
  const k = vSol * vTok;
  return (vSol - k / (vTok + tok)) * (1 - FEE);
};

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const med = (a: number[]): number => q(a, 0.5);
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const growth = (o: number[], f: number): number => {
  let s = 0;
  for (const x of o) { const m = 1 + f * (x / 1e4); if (m <= 0) return -Infinity; s += Math.log(m); }
  return s / o.length;
};

console.log('');
console.log('  entry level    reached      graduated    P(grad|reached)     median      mean    %pos   g(f=.05)');
for (const L of LEVELS) {
  const outs: number[] = []; const outsG: number[] = []; const outsN: number[] = []; let noGradIdx = 0;
  let reached = 0; let grad = 0;
  for (const [, raw] of byMint) {
    const evs = raw.sort((a, b) => a.ts - b.ts);
    /** The first observation at or above the level is where we would have entered. */
    const iEntry = evs.findIndex((e) => e.rSol >= L);
    if (iEntry < 0) continue;
    const at = evs[iEntry] as Ev;
    if (!(at.vSol > 0) || !(at.vTok > 0)) continue;
    reached += 1;
    const graduated = evs.some((e) => e.rSol >= GRAD);
    if (graduated) grad += 1;
    /**
     * Exit at graduation if it comes, otherwise at the LAST observation. A stall is not a free
     * exit: the position is marked where the curve actually ends up.
     */
    /**
     * EXIT AT THE MAXIMUM-rSol EVENT, not at a sequential search for the first crossing. Timestamps
     * on this feed are in WHOLE SECONDS and a hot curve can run from 60 to 85 SOL inside one, so
     * sorting by ts alone cannot order those events reliably. A sequential findIndex for the first
     * crossing AFTER the entry index therefore returned -1 for 790 of 1,998 graduating tokens - 40%
     * of them - and those were silently exited at the LAST event instead of at graduation, which is
     * a different and much worse trade. The graduation moment is simply where rSol peaks.
     */
    let iGrad = -1;
    if (graduated) { let best = -Infinity; for (let j = 0; j < evs.length; j += 1) { const rr2 = (evs[j] as Ev).rSol; if (rr2 > best) { best = rr2; iGrad = j; } } }
    if (graduated && iGrad < 0) noGradIdx += 1;
    const exit = (iGrad >= 0 ? evs[iGrad] : evs[evs.length - 1]) as Ev;
    if (!(exit.vSol > 0) || !(exit.vTok > 0)) continue;
    const tok = buyTokens(at.vSol, at.vTok, NOTIONAL_SOL);
    if (!(tok > 0)) continue;
    const back = sellSol(exit.vSol, exit.vTok, tok);
    const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / NOTIONAL_SOL;
    const rr = 1e4 * (back / NOTIONAL_SOL - 1) - fixedBps;
    outs.push(rr);
    if (graduated) outsG.push(rr); else outsN.push(rr);
  }
  if (outs.length < 30) continue;
  console.log(`    [split] n=${outs.length} graduated=${outsG.length} med(grad)=${outsG.length ? med(outsG).toFixed(0) : "-"} nonGrad=${outsN.length} med(nonGrad)=${outsN.length ? med(outsN).toFixed(0) : "-"} gradButNoExitIdx=${noGradIdx}`);
  const g5 = growth(outs, 0.05);
  console.log(
    `  ${(L + ' SOL').padStart(10)} ${String(reached).padStart(10)} ${String(grad).padStart(13)} ${(100 * grad / reached).toFixed(1).padStart(16)}% ${med(outs).toFixed(0).padStart(10)} ${mean(outs).toFixed(0).padStart(9)} ${(100 * outs.filter((x) => x > 0).length / outs.length).toFixed(1).padStart(6)}% ${(g5 === -Infinity ? 'RUIN' : g5.toFixed(4)).padStart(10)}`,
  );
}
console.log('');
console.log('  Entry and exit are priced through the curve with our own impact on both legs, 1% venue');
console.log('  fee per leg, and the MT136 fixed cost. A stall is marked where the curve ends up, not');
console.log('  waved away, because pretending we can exit at cost is what flattered earlier results.');
