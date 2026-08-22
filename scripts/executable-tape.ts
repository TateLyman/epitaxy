/**
 * The same tape, but built from EXECUTABLE quotes instead of the aggregate price feed.
 *
 * WHY THIS EXISTS. MT140 found 20-second reversion on established tokens returning +32.1 bps after
 * cost, with all three frozen tests passing and reversion beating momentum 26 cells to 1. That is
 * the first positive result in 140 rows, and there is a mundane explanation that fits every piece
 * of it:
 *
 *   THE PRICE FEED MAY LAG. `price/v3` is an aggregate USD price refreshed about every 8 seconds,
 *   not a price anyone can trade at. If it lags the true price, then a measured "dip" is partly a
 *   move that ALREADY HAPPENED, and the feed catching up is indistinguishable from reversion. It
 *   would be strongest at the SHORTEST lookback, because that is where lag makes up most of the
 *   signal — which is exactly the gradient MT140 reports, 20s beating 60s beating 180s.
 *
 * That alternative explains the finding at least as well as the finding does. So the question is
 * not whether the pattern is in the feed — it is — but whether it is in prices we could actually
 * trade at. This tape answers that by asking for a real `/swap/v2/order` quote on each side.
 *
 * ROUND-TRIP PRICE IS RECORDED, NOT A MID. For each token: quote SOL -> token, then quote that
 * exact token amount back to SOL. The buy price is what we would pay, the sell price is what we
 * would receive, and the gap between them is the real spread we must cross twice. A mid-price
 * would hide exactly the cost that decides whether a 32 bps signal is tradeable.
 *
 * Free. Quoting is not trading and nothing is signed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TOKENS = Number(arg('tokens') ?? '5');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const MINUTES = Number(arg('minutes') ?? '45');
const OUT = arg('out') ?? 'data/executable-tape.jsonl';

const secrets = loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
mkdirSync('data', { recursive: true });

async function universe(): Promise<{ mint: string; symbol: string }[]> {
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=${TOKENS * 3}`, { signal: AbortSignal.timeout(20_000) });
  const j = (await res.json()) as { id?: string; symbol?: string }[];
  const out: { mint: string; symbol: string }[] = [];
  for (const t of j) {
    if (t.id === undefined || t.id === WSOL) continue;
    out.push({ mint: t.id, symbol: t.symbol ?? '?' });
    if (out.length >= TOKENS) break;
  }
  return out;
}

async function quote(inMint: string, outMint: string, amount: bigint): Promise<bigint | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: '300' });
  try {
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string };
    return j.outAmount === undefined ? null : BigInt(j.outAmount);
  } catch { return null; }
}

const uni = await universe();
console.log(`executable tape over ${uni.length} tokens at ${Number(NOTIONAL) / 1e9} SOL, ${MINUTES} minutes`);
console.log(`  ${uni.map((u) => u.symbol).join(' ')}`);
console.log(`  -> ${OUT}`);

const deadline = Date.now() + MINUTES * 60_000;
let cycles = 0;
while (Date.now() < deadline) {
  for (const u of uni) {
    if (Date.now() >= deadline) break;
    // Two quotes back to back: what we pay in, and what that same position sells back for.
    const tokensOut = await quote(WSOL, u.mint, NOTIONAL);
    await new Promise((r) => setTimeout(r, 700));
    if (tokensOut === null || tokensOut <= 0n) { await new Promise((r) => setTimeout(r, 700)); continue; }
    const solBack = await quote(u.mint, WSOL, tokensOut);
    await new Promise((r) => setTimeout(r, 700));
    if (solBack === null || solBack <= 0n) continue;
    // buyPrice: SOL paid per token unit. sellPrice: SOL received per token unit.
    const buyPrice = Number(NOTIONAL) / Number(tokensOut);
    const sellPrice = Number(solBack) / Number(tokensOut);
    const spreadBps = 1e4 * (1 - Number(solBack) / Number(NOTIONAL));
    appendFileSync(OUT, `${JSON.stringify({
      ts: Date.now(), mint: u.mint, sym: u.symbol,
      tokensOut: tokensOut.toString(), solBack: solBack.toString(),
      buyPrice, sellPrice, spreadBps,
    })}\n`);
  }
  cycles += 1;
  if (cycles % 5 === 0) console.log(`  ${new Date().toISOString().slice(11, 19)}  cycles ${cycles}`);
}
console.log(`done — ${cycles} cycles`);
