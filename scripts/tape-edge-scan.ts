/**
 * Search the established-token tape for anything that beats the measured cost. For free.
 *
 * THE COST TO BEAT IS MEASURED, NOT ASSUMED. MT138 ran four live round trips on this universe and
 * realised -3, -34, -12 and -20 bps, a mean of -17.3. That is the number an entry rule has to
 * clear, and it is the realised all-in figure including both fills, fees and rent recovery — not
 * a model of one.
 *
 * WHAT IS SWEPT, and every cell is reported rather than the best:
 *   SIGNAL     the price change over a lookback window, per token.
 *   DIRECTION  buy after a FALL (reversion) and buy after a RISE (momentum). Both, always, because
 *              a rule that only works in one direction and is never checked in the other is a rule
 *              that has never been controlled.
 *   LOOKBACK   how far back the signal is measured.
 *   HORIZON    how long the position is held.
 *
 * WHY THE CONTROL MATTERS MORE THAN THE CELLS. A RANDOM-ENTRY arm is run on the same tape, same
 * horizons, same cost. Any strategy arm has to beat random, not just beat zero — on a tape where
 * every token drifted up, every long rule looks profitable, and the random arm is what exposes it.
 *
 * NOTHING HERE IS TRADEABLE ON ITS OWN. This is a search over many cells on one tape, so anything
 * positive is a CANDIDATE requiring preregistration and a held-out window before a lamport is
 * spent on it. That is the discipline the whole ledger exists to enforce.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAPE = arg('tape') ?? 'data/established-tape.jsonl';
/** MT138, realised over four live rounds on this universe. */
const COST_BPS = Number(arg('cost-bps') ?? '17.3');
const LOOKBACKS_S = (arg('lookbacks') ?? '20,60,180').split(',').map(Number);
const HORIZONS_S = (arg('horizons') ?? '30,60,180,600').split(',').map(Number);
const TRIGGER_BPS = (arg('triggers') ?? '10,25,50').split(',').map(Number);
/**
 * NON-OVERLAPPING WINDOWS ONLY, when confirming rather than discovering.
 *
 * The feed refreshes about every 8 seconds, so a 60-second horizon overlaps roughly eight
 * neighbours and a 180-second horizon about twenty-three. Overlap does not bias the mean but it
 * badly inflates n, and therefore t: a reported t of 6.74 at a 180s horizon is about 1.42 once
 * effective sample size is used. Discovery can live with that. A confirmation cannot.
 */
const DISJOINT = process.argv.includes('--disjoint');

if (!existsSync(TAPE)) { console.error(`no tape at ${TAPE}`); process.exit(2); }

interface Tick { ts: number; p: number }
const series = new Map<string, Tick[]>();
const symbols = new Map<string, string>();

const rl = createInterface({ input: createReadStream(TAPE, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  let r: { ts: number; mint: string; sym: string; solPrice: number };
  try { r = JSON.parse(line); } catch { continue; }
  if (!(r.solPrice > 0)) continue;
  const a = series.get(r.mint) ?? [];
  a.push({ ts: r.ts, p: r.solPrice });
  series.set(r.mint, a);
  symbols.set(r.mint, r.sym);
}
rl.close();

for (const a of series.values()) a.sort((x, y) => x.ts - y.ts);
const spanMin = (() => {
  let lo = Infinity; let hi = -Infinity;
  for (const a of series.values()) { const f = a[0]; const l = a[a.length - 1]; if (f) lo = Math.min(lo, f.ts); if (l) hi = Math.max(hi, l.ts); }
  return Number.isFinite(lo) ? (hi - lo) / 60_000 : 0;
})();
console.log(`tape: ${series.size} tokens, ${[...series.values()].reduce((n, a) => n + a.length, 0).toLocaleString()} ticks, ${spanMin.toFixed(0)} minutes`);
console.log(`cost to beat: ${COST_BPS} bps per round trip (MT138, realised live)`);
console.log(`windows: ${DISJOINT ? 'NON-OVERLAPPING (confirmation mode)' : 'overlapping (discovery mode — t-stats are inflated)'}`);
console.log('');

/** Price at or before a timestamp. Series are dense and sorted, so a scan from a hint is fine. */
function priceAt(a: Tick[], t: number, from: number): { i: number; p: number } | null {
  let i = from;
  while (i + 1 < a.length && (a[i + 1] as Tick).ts <= t) i += 1;
  const e = a[i];
  if (e === undefined || e.ts > t) return null;
  return { i, p: e.p };
}

const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const stdev = (x: number[]): number => {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / (x.length - 1));
};

interface Cell { n: number; rets: number[] }
const cells = new Map<string, Cell>();
const bump = (k: string, r: number): void => { const c = cells.get(k) ?? { n: 0, rets: [] }; c.n += 1; c.rets.push(r); cells.set(k, c); };

for (const [mint, a] of series) {
  if (a.length < 30) continue;
  void mint;
  for (const lb of LOOKBACKS_S) {
    for (const hz of HORIZONS_S) {
      let iPast = 0; let iFwd = 0; let busyUntil = -1;
      for (let i = 0; i < a.length; i += 1) {
        const now = a[i] as Tick;
        if (DISJOINT && now.ts < busyUntil) continue;
        const past = priceAt(a, now.ts - lb * 1000, iPast);
        if (past === null) continue;
        iPast = past.i;
        const fwd = priceAt(a, now.ts + hz * 1000, iFwd < i ? i : iFwd);
        if (fwd === null) continue;
        iFwd = fwd.i;
        // The forward point must actually be forward by roughly the horizon, not merely the last
        // tick in the file. A truncated tail would otherwise read as a zero-return trade.
        const fwdTick = a[fwd.i] as Tick;
        if (fwdTick.ts < now.ts + hz * 1000 * 0.8) continue;

        const signalBps = 1e4 * (now.p / past.p - 1);
        const grossBps = 1e4 * (fwdTick.p / now.p - 1);
        const netBps = grossBps - COST_BPS;

        if (DISJOINT) busyUntil = now.ts + hz * 1000;
        // The control. Every entry, unconditionally — what a coin flip earns on this tape.
        bump(`random|${lb}|${hz}`, netBps);

        for (const tb of TRIGGER_BPS) {
          if (signalBps <= -tb) bump(`reversion|${tb}|${lb}|${hz}`, netBps);
          if (signalBps >= tb) bump(`momentum|${tb}|${lb}|${hz}`, netBps);
        }
      }
    }
  }
}

console.log('RANDOM ENTRY — the control. Any rule must beat THIS, not merely beat zero.');
console.log('  lookback horizon        n      mean bps    median      stdev');
for (const lb of LOOKBACKS_S) for (const hz of HORIZONS_S) {
  const c = cells.get(`random|${lb}|${hz}`);
  if (c === undefined || c.n < 50) continue;
  console.log(`  ${String(lb).padStart(8)}s ${String(hz).padStart(6)}s ${String(c.n).padStart(8)}  ${mean(c.rets).toFixed(1).padStart(9)}  ${med(c.rets).toFixed(1).padStart(9)}  ${stdev(c.rets).toFixed(1).padStart(9)}`);
}

console.log('');
console.log('EVERY STRATEGY CELL, none omitted. `edge` is mean minus the random arm on the same cell.');
console.log('  rule       trig  lookback horizon        n     mean bps     random      EDGE    t-stat');
const candidates: { key: string; edge: number; t: number; n: number }[] = [];
for (const rule of ['reversion', 'momentum']) {
  for (const tb of TRIGGER_BPS) for (const lb of LOOKBACKS_S) for (const hz of HORIZONS_S) {
    const c = cells.get(`${rule}|${tb}|${lb}|${hz}`);
    const r = cells.get(`random|${lb}|${hz}`);
    if (c === undefined || r === undefined || c.n < 50) continue;
    const m = mean(c.rets);
    const edge = m - mean(r.rets);
    // Against the cell's own dispersion, so a wide-but-lucky cell cannot masquerade as a signal.
    const t = edge / (stdev(c.rets) / Math.sqrt(c.n));
    console.log(
      `  ${rule.padEnd(10)} ${String(tb).padStart(4)} ${String(lb).padStart(8)}s ${String(hz).padStart(6)}s ${String(c.n).padStart(8)}  ` +
      `${m.toFixed(1).padStart(9)}  ${mean(r.rets).toFixed(1).padStart(9)}  ${edge.toFixed(1).padStart(8)}  ${t.toFixed(2).padStart(8)}`,
    );
    if (m > 0 && edge > 0 && t > 2) candidates.push({ key: `${rule} trig${tb} lb${lb}s hz${hz}s`, edge, t, n: c.n });
  }
}

console.log('');
const examined = [...cells.keys()].filter((k) => !k.startsWith('random')).length;
console.log(`CELLS EXAMINED: ${examined}`);
if (candidates.length === 0) {
  console.log('NO CELL is both net-positive after cost AND better than random AND t > 2.');
  console.log('That is the honest result of a free search, and it cost nothing to learn.');
} else {
  console.log(`CANDIDATES (net positive, beat random, t > 2): ${candidates.length}`);
  for (const c of candidates.sort((a, b) => b.t - a.t)) {
    console.log(`  ${c.key.padEnd(34)} edge ${c.edge.toFixed(1)} bps   t ${c.t.toFixed(2)}   n ${c.n}`);
  }
  console.log('');
  console.log('  NONE OF THESE IS TRADEABLE YET. This is a multi-cell search on ONE tape, so the');
  console.log(`  best of ${examined} cells is expected to look good by chance. A candidate must be`);
  console.log('  preregistered and confirmed on a FRESH tape before any capital touches it.');
}
