/**
 * WHAT DOES A ROUND TRIP ACTUALLY COST RIGHT NOW, AND DOES SIZE CHANGE IT?
 *
 * Every cost measurement in this repository is a ONE-LEG measurement doubled. MT132 measured the
 * buy leg against the chain at 32 bps and doubled it to 71. That is only correct if the two legs
 * are symmetric, and nobody has checked. The sell leg pays fee on a different base, meets
 * different reserves (ours moved them), and on a Token-2022 mint can carry a transfer fee the buy
 * leg never touched.
 *
 * SIZE HAS NEVER BEEN SWEPT EITHER, and it cuts both ways. Fixed costs — signature, priority —
 * are 3.3 bps of a 0.02 SOL notional but 0.13 bps of a 0.5 SOL one, so bigger is cheaper. Price
 * impact is the opposite: it grows with size and a round trip pays it twice. Those two curves
 * cross somewhere, and where they cross is the cheapest size this system could ever trade. The
 * frozen 0.02 SOL research notional was chosen as a research constant, never as an optimum.
 *
 * THE MEASUREMENT IS A PAIRED EXECUTABLE QUOTE, not a model. Buy N SOL of a mint, then
 * immediately quote selling back EXACTLY the tokens that buy would produce. The round trip is
 * `solBack / solIn - 1`. Both legs are Jupiter's own executable quotes at the same moment, so
 * this is what a real round trip would return, including whatever the router does about fees,
 * impact and Token-2022 transfer hooks.
 *
 * WHY QUOTES AND NOT SIMULATION FOR THE SELL LEG: `simulateTransaction` has no pre-state
 * override, so a sell cannot be simulated from a wallet that does not hold the token. The buy leg
 * WAS validated against the chain in MT132 to within tens of bps, so the quote is a trustworthy
 * instrument here; pretending otherwise would mean refusing to measure the thing at all.
 *
 * Read-only. Quoting is not trading. Nothing is signed and nothing is spent.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
/** A taker is required or Jupiter reports no fee fields at all, which read as 0.0 bps of fixed cost. */
const TAKER = arg('taker');
const N_MINTS = Number(arg('mints') ?? '12');
/** The sweep. 0.02 SOL is the frozen research notional and sits inside it deliberately. */
const SIZES = (arg('sizes') ?? '5000000,10000000,20000000,50000000,100000000,250000000,500000000')
  .split(',').map((s) => BigInt(s));

const secrets = loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

interface Q { out: bigint; label: string; hops: number; prio: number; sig: number }
async function quote(inMint: string, outMint: string, amount: bigint): Promise<Q | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: '300' });
  if (TAKER !== null) qs.set('taker', TAKER);
  try {
    await new Promise((r) => setTimeout(r, 550));
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[];
      prioritizationFeeLamports?: number; signatureFeeLamports?: number;
    };
    if (j.outAmount === undefined) return null;
    const plan = j.routePlan ?? [];
    return {
      out: BigInt(j.outAmount),
      label: plan.map((p) => p.swapInfo?.label ?? '?').join('>'),
      hops: plan.length,
      prio: j.prioritizationFeeLamports ?? 0,
      sig: j.signatureFeeLamports ?? 0,
    };
  } catch { return null; }
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const mints = (db.prepare(
  `SELECT mint FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
    GROUP BY mint ORDER BY MAX(requested_utc_ms) DESC LIMIT ?`).all(N_MINTS * 3) as { mint: string }[]).map((r) => r.mint);
db.close();

console.log('EXECUTABLE ROUND-TRIP COST BY SIZE — paired Jupiter quotes, buy then sell back');
console.log(`  sizes ${SIZES.map((s) => (Number(s) / 1e9).toFixed(3)).join(', ')} SOL`);
console.log('');

/** size -> list of round-trip costs in bps (positive = it costs you) */
const bySize = new Map<string, number[]>();
const fixedBySize = new Map<string, number[]>();
let used = 0;

for (const mint of mints) {
  if (used >= N_MINTS) break;
  const row: string[] = [];
  let anyOk = false;
  for (const size of SIZES) {
    const buy = await quote(WSOL, mint, size);
    if (buy === null || buy.out <= 0n) { row.push('    —'); continue; }
    const sell = await quote(mint, WSOL, buy.out);
    if (sell === null || sell.out <= 0n) { row.push('    —'); continue; }
    // Positive = the round trip destroyed value, which is the sign convention everywhere else here.
    const costBps = 1e4 * (1 - Number(sell.out) / Number(size));
    if (!Number.isFinite(costBps)) { row.push('    —'); continue; }
    const k = size.toString();
    const a = bySize.get(k) ?? []; a.push(costBps); bySize.set(k, a);
    const fx = 1e4 * (buy.prio + buy.sig + sell.prio + sell.sig) / Number(size);
    const b = fixedBySize.get(k) ?? []; b.push(fx); fixedBySize.set(k, b);
    row.push(costBps.toFixed(0).padStart(5));
    anyOk = true;
  }
  if (anyOk) { used += 1; console.log(`  ${mint.slice(0, 8)}  ${row.join('  ')}`); }
}

const med = (a: number[]): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const pct = (a: number[], p: number): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] ?? NaN) : NaN; };

console.log('');
console.log(`mints measured ${used}`);
console.log('');
console.log('ROUND-TRIP COST BY SIZE  (positive = cost)');
console.log('   size SOL      n      p10      p25   MEDIAN      p75      p90   fixed');
let best: { size: string; cost: number } | null = null;
for (const size of SIZES) {
  const k = size.toString();
  const a = bySize.get(k) ?? [];
  if (a.length === 0) continue;
  const m = med(a);
  if (best === null || m < best.cost) best = { size: k, cost: m };
  console.log(
    `  ${(Number(size) / 1e9).toFixed(3).padStart(9)} ${String(a.length).padStart(6)}  ` +
    `${pct(a, 0.10).toFixed(0).padStart(7)}  ${pct(a, 0.25).toFixed(0).padStart(7)}  ${m.toFixed(0).padStart(7)}  ` +
    `${pct(a, 0.75).toFixed(0).padStart(7)}  ${pct(a, 0.90).toFixed(0).padStart(7)}  ` +
    `${med(fixedBySize.get(k) ?? []).toFixed(1).padStart(6)}`,
  );
}
console.log('');
if (best !== null) {
  console.log(`CHEAPEST SIZE MEASURED: ${(Number(best.size) / 1e9).toFixed(3)} SOL at ${best.cost.toFixed(0)} bps round trip`);
  console.log(`  the frozen research notional is 0.020 SOL at ${med(bySize.get('20000000') ?? []).toFixed(0)} bps`);
}
console.log('');
console.log('WHAT TO DO WITH THIS NUMBER. It is the toll on a round trip at the best size this');
console.log('venue offers us. Every edge this programme has measured must clear it: MT117 gross');
console.log('reversion is ~50 bps at 5-20% impact and decays to near zero within a second, and');
console.log('MT133 found gross NEGATIVE above 20% impact on both sides. If the cheapest round trip');
console.log('here still exceeds the biggest gross edge on the board, the venue is arithmetically');
console.log('closed to a taker at any size, which is a stronger statement than any single test.');
