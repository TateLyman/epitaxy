/**
 * MT191 — every token we actually traded, followed all the way through, including after we sold.
 *
 * A backtest measures a rule against history. This measures OUR TRADES against what the token went on
 * to do, which is a different question and the only one that can say where the money was left. Two
 * things from the live run make it worth asking rather than assuming:
 *
 *   A position stopped out at 47.96 SOL and the curve then ran to 78. The stop was correct by the rule
 *   and cost about eighteen percent, and the same token would have paid roughly forty percent to
 *   somebody who held. That is either evidence the stop is too tight or an ordinary draw from a
 *   distribution the sweep already priced, and the difference is not visible from one trade.
 *
 *   A position hit its 82 SOL target, failed to sell through a migration handover, and was worth
 *   -91.5% ten minutes later. Whatever the rule says, the achievable outcome there was bounded by
 *   something other than the rule.
 *
 * SO EACH TRADE IS REPLAYED AGAINST COUNTERFACTUALS THAT COULD ACTUALLY HAVE BEEN EXECUTED. The peak
 * is reported because it bounds the opportunity, but it is explicitly NOT a strategy - nobody sells
 * at the high, and treating the maximum as a target is the purest form of hindsight. The rules
 * compared against it are ones a bot could have followed without knowing the future: hold to
 * graduation, a wider or tighter stop, a trailing stop, and a nearer target.
 *
 * WHAT THIS CAN AND CANNOT ESTABLISH. Eleven trades is far too few to choose a rule - the sweeps used
 * hundreds to thousands of positions and still landed on broad plateaus rather than points. What it
 * CAN do is show whether our exits were systematically early or late in a way the simulations did not
 * anticipate, and whether the losses came from the rule or from the plumbing. Those are different
 * problems with different fixes, and one live session can separate them.
 *
 * Reads the bonding-curve tape and our own event log. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, vSol: 97, vTok: 105, rSol: 113 };
const NEED = OFF.rSol + 8;
const INITIAL_VIRTUAL_SOL = 30;
const FEE = 0.01;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const NOTIONAL = Number(arg('notional') ?? '0.05');
const FIXED_LAMPORTS = Number(arg('fixed-lamports') ?? '108513');
const DIR = 'data/sqd/events-6EF8rrec';
/** Our trades all happened tonight; reading the whole archive to find them is pointless. */
const BC_FROM = Number(arg('from') ?? '441190000');
const EVENTS = 'data/auto-trade-events.jsonl';

const buyTokens = (vSol: number, vTok: number, sol: number): number => { const k = vSol * vTok; return vTok - k / (vSol + sol * (1 - FEE)); };
const sellSol = (vSol: number, vTok: number, tok: number): number => { const k = vSol * vTok; return (vSol - k / (vTok + tok)) * (1 - FEE); };

/** Our own trades, as the bot recorded them at the time. */
interface Trade { mint: string; entryRSol: number; reason: string; trueBps: number | null; holdS: number | null; notional: number }
const trades = new Map<string, Trade>();
if (existsSync(EVENTS)) {
  for (const line of readFileSync(EVENTS, 'utf8').split(/\r?\n/)) {
    if (line.length === 0) continue;
    let d: { kind?: string; mint?: string; rSolAtEntry?: number; reason?: string; trueBps?: number; holdSeconds?: number; solIn?: number };
    try { d = JSON.parse(line) as typeof d; } catch { continue; }
    const m = d.mint;
    if (m === undefined) continue;
    if (d.kind === 'bought') trades.set(m, { mint: m, entryRSol: d.rSolAtEntry ?? 0, reason: '?', trueBps: null, holdS: null, notional: d.solIn ?? NOTIONAL });
    const t = trades.get(m);
    if (t === undefined) continue;
    if (d.kind === 'exit-trigger') t.reason = d.reason ?? '?';
    if (d.kind === 'closed') { t.trueBps = d.trueBps ?? null; t.holdS = d.holdSeconds ?? null; }
  }
}
console.log(`MT191 — post-mortem on ${trades.size} traded tokens`);

/** The full reserve path of each traded mint, from the tape. */
interface Pt { slot: number; rSol: number; vSol: number; vTok: number }
const path = new Map<string, Pt[]>();
const files = readdirSync(DIR).filter((f) => {
  const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
  return m !== null && Number(m[2]) >= BC_FROM;
}).sort();
console.log(`  reading ${files.length} tape files from slot ${BC_FROM.toLocaleString()}`);
for (const f of files) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let blk: { header?: { number?: number }; instructions?: { data: string }[] };
    try { blk = JSON.parse(line) as typeof blk; } catch { continue; }
    const slot = blk.header?.number ?? 0;
    for (const i of blk.instructions ?? []) {
      let raw: Buffer;
      try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
      if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
      const b = raw.subarray(8);
      if (b.length < NEED || !b.subarray(0, 8).equals(TRADE_EVENT)) continue;
      const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
      if (!trades.has(mint)) continue;
      const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
      const vTok = Number(b.readBigUInt64LE(OFF.vTok)) / 1e6;
      const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
      if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) continue;
      const a = path.get(mint) ?? [];
      a.push({ slot, rSol, vSol, vTok });
      path.set(mint, a);
    }
  }
  rl.close();
}
for (const a of path.values()) a.sort((x, y) => x.slot - y.slot);

/** Replay one rule forward over the post-entry path. Never consults an event before it decides. */
function replay(pts: Pt[], entryIdx: number, tok: number, notional: number, target: number, stopAt: number, trail: number | null): { bps: number; how: string } {
  const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / notional;
  let peak = pts[entryIdx]?.rSol ?? 0;
  for (let i = entryIdx + 1; i < pts.length; i += 1) {
    const p = pts[i] as Pt;
    if (p.rSol > peak) peak = p.rSol;
    const cut = trail === null ? stopAt : peak - trail;
    if (p.rSol <= cut) return { bps: 1e4 * (sellSol(p.vSol, p.vTok, tok) / notional - 1) - fixedBps, how: 'stop' };
    if (p.rSol >= target) return { bps: 1e4 * (sellSol(p.vSol, p.vTok, tok) / notional - 1) - fixedBps, how: 'target' };
  }
  const last = pts[pts.length - 1] as Pt;
  return { bps: 1e4 * (sellSol(last.vSol, last.vTok, tok) / notional - 1) - fixedBps, how: 'end' };
}

console.log('');
console.log('  mint         entry   ourExit   ourBps  |  peakAfter  peakBps  |  hold82  wider12  trail8  target74');
let sumOurs = 0; let sumAlt: Record<string, number> = { hold82: 0, wider12: 0, trail8: 0, target74: 0 }; let n = 0;
for (const t of trades.values()) {
  const pts = path.get(t.mint);
  if (pts === undefined || pts.length < 2) { console.log(`  ${t.mint.slice(0, 10)}  no tape coverage`); continue; }
  /** Our entry is the first tape point at or above the reserve the bot recorded buying at. */
  let ei = pts.findIndex((p) => p.rSol >= t.entryRSol - 0.05);
  if (ei < 0) ei = 0;
  const e = pts[ei] as Pt;
  const tok = buyTokens(e.vSol, e.vTok, t.notional);
  if (!(tok > 0)) continue;
  const fixedBps = 1e4 * (FIXED_LAMPORTS / 1e9) / t.notional;

  /** The peak bounds the opportunity. It is not a rule and nobody could have sold there. */
  let peakBps = -1e9; let peakR = 0;
  for (let i = ei + 1; i < pts.length; i += 1) {
    const p = pts[i] as Pt;
    const v = 1e4 * (sellSol(p.vSol, p.vTok, tok) / t.notional - 1) - fixedBps;
    if (v > peakBps) { peakBps = v; peakR = p.rSol; }
  }
  const alts = {
    hold82: replay(pts, ei, tok, t.notional, 82, -1e9, null),
    wider12: replay(pts, ei, tok, t.notional, 82, t.entryRSol - 12, null),
    trail8: replay(pts, ei, tok, t.notional, 82, -1e9, 8),
    target74: replay(pts, ei, tok, t.notional, 74, t.entryRSol - 8, null),
  };
  const ours = t.trueBps ?? NaN;
  if (Number.isFinite(ours)) { sumOurs += ours; n += 1; for (const k of Object.keys(sumAlt)) sumAlt[k] = (sumAlt[k] ?? 0) + (alts[k as keyof typeof alts]?.bps ?? 0); }
  console.log(
    `  ${t.mint.slice(0, 10)}  ${t.entryRSol.toFixed(1).padStart(5)}  ${t.reason.padEnd(7)} ${(Number.isFinite(ours) ? ours.toFixed(0) : '?').padStart(7)}  |  ` +
    `${peakR.toFixed(1).padStart(8)} ${peakBps.toFixed(0).padStart(8)}  |  ` +
    `${alts.hold82.bps.toFixed(0).padStart(6)} ${alts.wider12.bps.toFixed(0).padStart(8)} ${alts.trail8.bps.toFixed(0).padStart(7)} ${alts.target74.bps.toFixed(0).padStart(9)}`,
  );
}
console.log('');
if (n > 0) {
  console.log(`  totals over ${n} trades with a recorded result:`);
  console.log(`    ours      ${sumOurs.toFixed(0).padStart(8)} bps`);
  for (const [k, v] of Object.entries(sumAlt)) console.log(`    ${k.padEnd(9)} ${v.toFixed(0).padStart(8)} bps`);
}
console.log('');
console.log('  peakBps bounds the opportunity and is NOT a rule: nobody sells at the high, and treating');
console.log('  the maximum as a target is hindsight. Only the four named rules could have been followed.');
