/**
 * Is the cheap fee bracket actually cheap in EXECUTABLE terms, or only in tape arithmetic?
 *
 * MT154 closed the fee axis as a source of edge, but it left one thing standing and untested:
 * moving bracket is a real cost reduction. On the tape it is worth up to 190 bps a round trip —
 * 125 bps a leg below 420 SOL market cap against 30 bps a leg above 98,240 SOL. That number has
 * never been checked against a quote anyone would actually fill.
 *
 * IT HAS TO BE CHECKED, BECAUSE THE MODEL HAS BEEN WRONG IN THIS EXACT PLACE BEFORE. MT132
 * modelled the cost floor at 71 bps; MT136 measured 23 on a real round trip. MT127-DEFECT found a
 * clamp that WAS the entire cost model in nine scripts. Tape arithmetic prices a direct hop
 * against pool reserves, and live routing is not that: live-cost-check.ts records 18% of real
 * routes going through OKX DEX Router, Meteora DAMM v2 or a multi-hop, across three routers. A
 * cheaper pool that only routes through an expensive path is not cheaper.
 *
 * WHY THE CANDIDATE SOURCE IS THE WHOLE POINT. one-shot-trade.ts picks from the `quotes` table,
 * reasoning it is the liquid set. MT137 found that table is screened by the collector to
 * minTokenAgeMs 120000 through maxTokenAgeMs 3600000 — two minutes to one hour old — so it
 * contains ONLY the top fee bracket. Every live fill in this repository's history, all ten of
 * them, was a fresh sub-420-SOL pool at 125 bps a leg. The cheap bracket has never been touched.
 * So candidates come from the PANEL instead, selected on their own measured charge.
 *
 * THE CONTROL IS THE POINT OF COMPARISON, NOT A FORMALITY. The same measurement runs on the top
 * bracket in the same session, minutes apart, so the two cohorts see the same market. A cheap
 * number alone would prove nothing; the DIFFERENCE is the claim.
 *
 * Quotes only. This signs nothing, sends nothing and spends nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const PER_COHORT = Number(arg('per-cohort') ?? '12');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '100');

interface P { pool: string; feeBps: number; depthSol: number; firstTs: number }

const byPool = new Map<string, P>();
for (const tag of ['A', 'B', 'S']) {
  const f = `data/panel/panel-${tag}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    try {
      const r = JSON.parse(line) as P;
      /** Keep the most recent sighting of each pool: depth and tier both move over time. */
      const prev = byPool.get(r.pool);
      if (prev === undefined || r.firstTs > prev.firstTs) byPool.set(r.pool, r);
    } catch { /* skip */ }
  }
  rl.close();
}
console.log(`panel pools: ${byPool.size.toLocaleString()}`);

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const mintOf = new Map<string, string>();
for (const r of db.prepare(`SELECT pool, base_mint FROM venue_pools`).all() as { pool: string; base_mint: string }[]) {
  mintOf.set(r.pool, r.base_mint);
}
db.close();

const all = [...byPool.values()].filter((p) => mintOf.has(p.pool));
/**
 * CHEAP cohort: the pool's own charge says it is in a low bracket, and it is deep enough that a
 * 0.02 SOL order is not the reason the quote looks bad. Deepest first, because market cap is what
 * sets the tier and depth is the observable proxy we have.
 */
const cheap = all.filter((p) => p.feeBps <= 40 && p.depthSol >= 300).sort((a, b) => b.depthSol - a.depthSol).slice(0, PER_COHORT);
/** CONTROL: the top bracket, which is every trade this repository has ever actually made. */
const dear = all.filter((p) => p.feeBps >= 122).sort((a, b) => b.firstTs - a.firstTs).slice(0, PER_COHORT);

console.log(`cheap cohort  ${cheap.length}  median fee ${cheap.length ? cheap[Math.floor(cheap.length / 2)]?.feeBps : '-'} bps/leg`);
console.log(`control       ${dear.length}  median fee ${dear.length ? dear[Math.floor(dear.length / 2)]?.feeBps : '-'} bps/leg`);
console.log('');

const secrets = await loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

async function quoteOut(inMint: string, outMint: string, amount: bigint): Promise<bigint | null> {
  const qs = new URLSearchParams({
    inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: String(SLIPPAGE_BPS),
  });
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string };
    return j.outAmount === undefined ? null : BigInt(j.outAmount);
  } catch { return null; }
}

interface Res { mint: string; feeBps: number; depthSol: number; costBps: number }

async function measure(label: string, pools: P[]): Promise<Res[]> {
  console.log(`--- ${label} ---`);
  const out: Res[] = [];
  for (const p of pools) {
    const mint = mintOf.get(p.pool);
    if (mint === undefined) continue;
    const got = await quoteOut(WSOL, mint, NOTIONAL);
    if (got === null || got <= 0n) { console.log(`  ${mint.slice(0, 10)}  no buy quote`); continue; }
    const back = await quoteOut(mint, WSOL, got);
    if (back === null || back <= 0n) { console.log(`  ${mint.slice(0, 10)}  no sell quote`); continue; }
    const costBps = 1e4 * (1 - Number(back) / Number(NOTIONAL));
    if (!Number.isFinite(costBps)) continue;
    out.push({ mint, feeBps: p.feeBps, depthSol: p.depthSol, costBps });
    console.log(`  ${mint.slice(0, 10)}  tape fee ${String(p.feeBps).padStart(5)} bps/leg  depth ${p.depthSol.toFixed(0).padStart(6)} SOL  ->  EXECUTABLE round trip ${costBps.toFixed(0).padStart(7)} bps`);
  }
  return out;
}

const cheapR = await measure(`CHEAP BRACKET (never traded by this system)`, cheap);
console.log('');
const dearR = await measure(`TOP BRACKET (every live fill in this repo's history)`, dear);

const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
console.log('');
console.log('='.repeat(78));
console.log('EXECUTABLE ROUND-TRIP COST at ' + (Number(NOTIONAL) / 1e9).toFixed(3) + ' SOL, quoted minutes apart in one session');
console.log('');
console.log('  cohort                 n     median      min      max   tape fee/leg');
for (const [l, r] of [['cheap bracket', cheapR], ['top bracket (control)', dearR]] as [string, Res[]][]) {
  if (r.length === 0) { console.log(`  ${l.padEnd(22)} ${String(0).padStart(3)}   no quotes`); continue; }
  const c = r.map((x) => x.costBps);
  console.log(
    `  ${l.padEnd(22)} ${String(r.length).padStart(3)} ${med(c).toFixed(0).padStart(10)} ${Math.min(...c).toFixed(0).padStart(8)} ${Math.max(...c).toFixed(0).padStart(8)} ${med(r.map((x) => x.feeBps)).toFixed(0).padStart(14)}`,
  );
}
if (cheapR.length >= 3 && dearR.length >= 3) {
  const d = med(dearR.map((x) => x.costBps)) - med(cheapR.map((x) => x.costBps));
  console.log('');
  console.log(`  DIFFERENCE: the cheap bracket is ${d.toFixed(0)} bps a round trip cheaper, measured on executable quotes.`);
  console.log(`  The tape predicted about 190. A large gap either way means routing, not the pool, sets the cost.`);
}
console.log('');
console.log('  This is a COST measurement. It says nothing about whether either bracket is profitable —');
console.log('  MT154 found no positive gross expectation in any bracket, and a cheaper toll on a game');
console.log('  with no drift is a slower loss, not a gain.');
