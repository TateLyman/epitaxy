/**
 * Build a price tape for established tokens, for free, so edges can be searched without spending.
 *
 * WHY THIS EXISTS. Every one of the 138 preregistered rows was measured on PumpSwap first-hour
 * memecoins, because that is the only population this repository has ever collected. MT138 showed
 * the established universe is a fundamentally better place to EXPERIMENT — round trips cost about
 * 17 bps against roughly 2,000, and the per-round noise is about 13 bps rather than tens of
 * percent — but there is no historical data for it at all, so there is nothing to test against.
 *
 * Live rounds are the wrong instrument for finding an edge. At 17 bps each they are cheap, but
 * they are still a payment for information that a quote poll gives away. So: build the tape first,
 * search it for free, and spend the operator's SOL only on something that already looks positive.
 *
 * `price/v3` returns many mints in a single request, so a thirty-token tape at a five-second
 * cadence is one request per five seconds. That is inside any sane rate budget and can run for
 * hours.
 *
 * PRICES ARE CONVERTED TO SOL, not left in USD. We buy tokens with SOL and are paid back in SOL,
 * so the quantity that decides a trade is token/SOL. Leaving it in USD would fold SOL's own moves
 * into every measurement and manufacture correlations that have nothing to do with the token.
 */
import { appendFileSync, mkdirSync } from 'node:fs';

const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TOKENS = Number(arg('tokens') ?? '30');
const INTERVAL_MS = Number(arg('interval-ms') ?? '5000');
const MINUTES = Number(arg('minutes') ?? '30');
const OUT = arg('out') ?? 'data/established-tape.jsonl';

mkdirSync('data', { recursive: true });

interface Universe { mint: string; symbol: string }
async function universe(): Promise<Universe[]> {
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=${TOKENS * 2}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`universe fetch failed: ${res.status}`);
  const j = (await res.json()) as { id?: string; symbol?: string }[];
  const out: Universe[] = [];
  for (const t of j) {
    if (t.id === undefined || t.id === WSOL) continue;
    out.push({ mint: t.id, symbol: t.symbol ?? '?' });
    if (out.length >= TOKENS) break;
  }
  return out;
}

const uni = await universe();
console.log(`tape over ${uni.length} established tokens, every ${INTERVAL_MS}ms, for ${MINUTES} minutes`);
console.log(`  ${uni.map((u) => u.symbol).join(' ')}`);
console.log(`  -> ${OUT}`);

const ids = [WSOL, ...uni.map((u) => u.mint)].join(',');
const deadline = Date.now() + MINUTES * 60_000;
let ticks = 0;
let written = 0;

while (Date.now() < deadline) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const j = (await res.json()) as Record<string, { usdPrice?: number; liquidity?: number } | null>;
      const sol = j[WSOL]?.usdPrice;
      if (typeof sol === 'number' && sol > 0) {
        const ts = Date.now();
        const rows: string[] = [];
        for (const u of uni) {
          const p = j[u.mint]?.usdPrice;
          if (typeof p !== 'number' || !(p > 0)) continue;
          // token priced in SOL — the quantity a trade actually earns or loses.
          rows.push(JSON.stringify({ ts, mint: u.mint, sym: u.symbol, solPrice: p / sol, usd: p, liq: j[u.mint]?.liquidity ?? null }));
        }
        if (rows.length > 0) { appendFileSync(OUT, `${rows.join('\n')}\n`); written += rows.length; }
        ticks += 1;
        if (ticks % 12 === 0) console.log(`  ${new Date().toISOString().slice(11, 19)}  ticks ${ticks}  rows ${written.toLocaleString()}`);
      }
    }
  } catch { /* a dropped tick is a gap, not a failure; the analyser sees the timestamps */ }
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, Math.max(500, INTERVAL_MS - elapsed)));
}

console.log(`done — ${ticks} ticks, ${written.toLocaleString()} rows in ${OUT}`);
