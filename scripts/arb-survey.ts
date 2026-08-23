/**
 * How many cross-venue arbitrages exist right now, and what do they actually pay?
 *
 * MT181 established that the one consistently profitable non-issuer wallet we could find is an atomic
 * cross-venue arbitrageur: it buys on one AMM and sells on another inside a single transaction and
 * ends holding nothing but more wrapped SOL. That is the first mechanism in this programme that does
 * not require predicting anything. It is also the most contested niche on Solana, and that wallet
 * fails 57% of its transactions.
 *
 * SO THE QUESTION IS NOT WHETHER ARBITRAGE EXISTS. It is whether enough of it survives long enough to
 * be reachable by someone who is not colocated, and whether what survives is worth more than the fee
 * to try. This measures exactly that and nothing else.
 *
 * HOW THE SPREAD IS PRICED. For each token, Jupiter is asked to quote the SAME notional on each venue
 * separately, with the venue filter honoured. That gives an EXECUTABLE price per venue rather than a
 * mid or a reserve ratio - the quote already contains the venue's fee and the price impact of the size
 * we would actually trade. The arbitrage is then the full round trip: buy on the cheaper venue, sell
 * the tokens received on the dearer one, and subtract the transaction cost. A spread that does not
 * survive that round trip is not an opportunity, it is a chart.
 *
 * THE ONE BIAS THAT MATTERS, STATED PLAINLY. The two legs are quoted sequentially, hundreds of
 * milliseconds apart, while a real arbitrage executes both in one atomic transaction at one slot. Any
 * price drift between the quotes is attributed to the arbitrage, and drift is not symmetric in its
 * effect: it manufactures apparent profit as readily as it hides it, and we would only notice the
 * ones it manufactures. So every candidate is RE-QUOTED, and one that does not survive re-quoting is
 * reported as transient rather than counted. This is the same discipline that killed MT171, applied
 * before rather than after.
 *
 * Tokens are seeded from the pools the known arbitrageur actually trades, because a token quoted on
 * one venue cannot be arbitraged at all and freshly graduated pump tokens live on exactly one.
 *
 * Reads quotes. Signs nothing, sends nothing, spends nothing.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadSecrets } from '../packages/domain/src/config.js';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const SEED_WALLET = arg('seed-wallet') ?? 'MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa';
const WINDOWS = (arg('windows') ?? 'E').split(',').filter((s) => s.length > 0);
const NOTIONAL = BigInt(arg('notional') ?? '50000000');
const LIMIT = Number(arg('limit') ?? '60');
const GAP_MS = Number(arg('gap-ms') ?? '550');
/** Transaction cost charged against every arbitrage, win or lose. */
const TX_COST_LAMPORTS = Number(arg('tx-cost') ?? '150000');
const WSOL = 'So11111111111111111111111111111111111111112';
const CACHE = 'data/trade-cache';
const VENUES = (arg('venues') ?? 'Pump.fun Amm,Meteora DLMM,Meteora,Meteora DAMM v2,Raydium CLMM,Raydium,Raydium CP,Whirlpool,SolFi,Obric V2,ZeroFi,Lifinity V2').split(',');

const secrets = await loadSecrets();
const H: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

const poolToMint = new Map<string, string>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; baseMint: string }; poolToMint.set(r.pool, r.baseMint); } catch { /* skip */ }
}

/** Seed from the pools a working arbitrageur trades: a single-venue token cannot be arbitraged. */
const mints = new Set<string>();
for (const w of WINDOWS) {
  const f = `${CACHE}/w${w}.jsonl`;
  if (!existsSync(f)) continue;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    try {
      const r = JSON.parse(line) as [string, ...unknown[]];
      if ((r as unknown[])[13] !== SEED_WALLET) continue;
      const m = poolToMint.get(r[0]);
      if (m !== undefined) mints.add(m);
    } catch { /* skip */ }
  }
  rl.close();
}
console.log('ARB SURVEY — how much cross-venue spread is actually reachable');
console.log(`  seeded ${mints.size} mints from ${SEED_WALLET.slice(0, 12)}'s pools`);
console.log(`  notional ${(Number(NOTIONAL) / 1e9).toFixed(3)} SOL, transaction cost ${(TX_COST_LAMPORTS / 1e9).toFixed(6)} SOL charged per attempt`);
console.log('');

interface Q { out: bigint; venue: string }
async function quote(inM: string, outM: string, amount: bigint, dex?: string): Promise<Q | null> {
  const p = new URLSearchParams({ inputMint: inM, outputMint: outM, amount: amount.toString(), slippageBps: '300' });
  if (dex !== undefined) p.set('dexes', dex);
  for (let a = 0; a < 5; a += 1) {
    let res: Response;
    try { res = await fetch(`https://api.jup.ag/swap/v1/quote?${p.toString()}`, { headers: H, signal: AbortSignal.timeout(20_000) }); }
    catch { await sleep(800); continue; }
    if (res.status === 429) { await sleep(1200 * (a + 1)); continue; }
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
    if (j.outAmount === undefined) return null;
    const labels = (j.routePlan ?? []).map((x) => x.swapInfo?.label ?? '?');
    /** A single-venue quote must have gone through exactly the venue asked for. */
    if (dex !== undefined && (labels.length !== 1 || labels[0] !== dex)) return null;
    return { out: BigInt(j.outAmount), venue: labels.join('+') };
  }
  return null;
}

/** Buy the token on `buyOn`, sell what we receive on `sellOn`, and report lamports net of costs. */
async function roundTrip(mint: string, buyOn: string, sellOn: string): Promise<number | null> {
  const leg1 = await quote(WSOL, mint, NOTIONAL, buyOn);
  await sleep(GAP_MS);
  if (leg1 === null || leg1.out <= 0n) return null;
  const leg2 = await quote(mint, WSOL, leg1.out, sellOn);
  await sleep(GAP_MS);
  if (leg2 === null) return null;
  return Number(leg2.out) - Number(NOTIONAL) - TX_COST_LAMPORTS;
}

let checked = 0; let multiVenue = 0; let candidates = 0; let confirmed = 0;
const profits: number[] = [];
console.log('  mint         venues quoted                        best spread   round trip net   re-quote');
for (const mint of [...mints].slice(0, LIMIT)) {
  const per: { venue: string; out: bigint }[] = [];
  for (const v of VENUES) {
    const q = await quote(WSOL, mint, NOTIONAL, v);
    await sleep(GAP_MS);
    if (q !== null && q.out > 0n) per.push({ venue: v, out: q.out });
  }
  checked += 1;
  if (per.length < 2) continue;
  /**
   * DROP VENUES QUOTING NONSENSE, BECAUSE THEY MANUFACTURE ENORMOUS FAKE SPREADS.
   *
   * A near-empty pool will happily quote a colossal number of tokens for a small amount of SOL, and
   * that shows up as a spread of millions of basis points against a liquid venue. It is not an
   * opportunity: the round trip on those came back at exactly minus the whole notional, meaning the
   * tokens could not be sold back at all. Requiring every venue to be within a factor of two of the
   * median quote removes them, and a genuine arbitrage is a small spread between LIQUID venues
   * anyway - if it were large somebody would have taken it already.
   */
  const outs = per.map((x) => Number(x.out)).sort((a, b) => a - b);
  const mid = outs[Math.floor(outs.length / 2)] ?? 0;
  const liquid = per.filter((x) => Number(x.out) > mid / 2 && Number(x.out) < mid * 2);
  if (liquid.length < 2) { console.log(`  ${mint.slice(0, 10)}  ${per.length} venues but only ${liquid.length} liquid — skipped`); continue; }
  per.length = 0; per.push(...liquid);
  multiVenue += 1;
  per.sort((a, b) => (b.out > a.out ? 1 : -1));
  const best = per[0]; const worst = per[per.length - 1];
  if (best === undefined || worst === undefined) continue;
  /** Tokens-per-SOL differ across venues: buy where you get MOST tokens, sell where they are dearest. */
  const spreadBps = 1e4 * (Number(best.out) / Number(worst.out) - 1);
  const net = await roundTrip(mint, best.venue, worst.venue);
  let verdict = 'no round trip';
  if (net !== null) {
    if (net > 0) {
      candidates += 1;
      const again = await roundTrip(mint, best.venue, worst.venue);
      if (again !== null && again > 0) { confirmed += 1; profits.push(again); verdict = `CONFIRMED ${(again / 1e9).toFixed(6)} SOL`; }
      else verdict = 'transient, gone on re-quote';
    } else verdict = 'negative';
  }
  console.log(
    `  ${mint.slice(0, 10)}  ${per.map((x) => x.venue).join(',').slice(0, 34).padEnd(34)} ${spreadBps.toFixed(0).padStart(8)} bps  ` +
    `${net === null ? '     n/a' : (net / 1e9).toFixed(6).padStart(11)}   ${verdict}`,
  );
}

console.log('');
console.log(`  ${checked} mints quoted, ${multiVenue} priced on 2+ venues, ${candidates} positive before re-quote, ${confirmed} SURVIVED re-quote`);
if (profits.length > 0) {
  const s = [...profits].sort((a, b) => a - b);
  console.log(`  confirmed net profit per arbitrage: median ${(s[Math.floor(s.length / 2)] ?? 0) / 1e9} SOL, total ${(profits.reduce((a, b) => a + b, 0) / 1e9).toFixed(6)} SOL`);
} else {
  console.log('  No arbitrage survived re-quoting at this notional.');
}
console.log('');
console.log('  A spread that vanishes on the second quote was never reachable: it is either drift between');
console.log('  our two sequential quotes or an opportunity somebody else has already taken.');
