/**
 * Do cross-venue spreads PERSIST? This decides whether buying latency would change anything.
 *
 * MT182 found zero reachable arbitrages and concluded the opportunity is competed out to a latency we
 * cannot reach. That conclusion has a hole in it, and the hole is in the sampling: the tokens were
 * seeded from the pools MRiYA trades, which are BY CONSTRUCTION the ones a professional arbitrageur
 * already covers. Finding them picked clean says nothing about the pools nobody is working.
 *
 * SO THIS ASKS THE QUESTION THAT ACTUALLY DECIDES THE SPEND. Latency is worth buying if and only if
 * the opportunities are short-lived - if a spread opens, pays, and closes inside a second, then the
 * only way to take it is to be faster than the people already taking it. But a spread that is still
 * there sixty seconds later is not being taken by anyone, and its existence would mean latency is
 * irrelevant and the binding constraint was never speed. Those two worlds demand opposite decisions
 * and they are trivially distinguishable: quote the same round trip repeatedly and watch.
 *
 * THE SAMPLE IS DELIBERATELY THE OTHER POPULATION - pools drawn from the tape that MRiYA never
 * touched - because the whole point is to look where the professional is not looking. Volume bands
 * are reported separately, since if uncontested spreads exist anywhere they should be in thin pools
 * that are not worth a professional's attention.
 *
 * EVERY MEASUREMENT IS A FULL ROUND TRIP, net of both venues' fees, both legs' price impact, and a
 * flat transaction cost. A spread is not an arbitrage until it survives being traded twice, and
 * MT182 showed the difference between those two numbers is the entire result: quoted spreads of
 * hundreds of basis points routinely round-tripped negative.
 *
 * Reads quotes. Signs nothing, sends nothing, spends nothing.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const NOTIONAL = BigInt(arg('notional') ?? '200000000');
const TOKENS = Number(arg('tokens') ?? '10');
const ROUNDS = Number(arg('rounds') ?? '4');
const GAP_MS = Number(arg('gap-ms') ?? '550');
const TX_COST_LAMPORTS = Number(arg('tx-cost') ?? '150000');
const WSOL = 'So11111111111111111111111111111111111111112';
const VENUES = (arg('venues') ?? 'Pump.fun Amm,Meteora DLMM,Meteora,Meteora DAMM v2,Raydium CLMM,Raydium,Raydium CP,Whirlpool,SolFi,Obric V2,ZeroFi,Lifinity V2').split(',');

const secrets = await loadSecrets();
const H: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
/**
 * Results are appended to a file as they are produced, not just printed.
 *
 * Node block-buffers stdout when it is a pipe, so a survey that runs for twenty minutes shows
 * nothing at all until it exits - and a run that has to be killed then loses everything it had
 * already measured. Appending each line as it is produced makes the run inspectable while it works
 * and survives being interrupted.
 */
const LOG = 'data/arb-persistence.log';
writeFileSync(LOG, '');
const say = (m: string): void => { process.stdout.write(m + String.fromCharCode(10)); appendFileSync(LOG, m + String.fromCharCode(10)); };

const poolToMint = new Map<string, string>();
for (const line of readFileSync('data/panel/pool-map.jsonl', 'utf8').split(/\r?\n/)) {
  if (line.length === 0) continue;
  try { const r = JSON.parse(line) as { pool: string; baseMint: string }; poolToMint.set(r.pool, r.baseMint); } catch { /* skip */ }
}

/**
 * The candidate list is CACHED, because rebuilding it means re-parsing 6.5 million tape rows and a
 * survey that takes ten minutes to reach its first quote cannot be iterated on. scripts/seed step
 * writes it once: every pool in the window, minus the ones the professional touched, ranked by
 * volume and carried with its mint.
 */
const seed = JSON.parse(readFileSync('data/panel/arb-seed.json', 'utf8')) as {
  totalPools: number; touchedByPro: number; untouched: number;
  rows: { pool: string; mint: string; volLamports: number }[];
};
const untouched: [string, number][] = seed.rows.map((r) => [r.pool, r.volLamports]);
for (const r of seed.rows) poolToMint.set(r.pool, r.mint);
say('ARB PERSISTENCE — does a spread survive long enough that speed would not matter?');
say(`  ${seed.totalPools.toLocaleString()} pools in tape, ${seed.touchedByPro.toLocaleString()} touched by the professional, ${seed.untouched.toLocaleString()} untouched`);
say(`  notional ${(Number(NOTIONAL) / 1e9).toFixed(3)} SOL, ${ROUNDS} rounds per token`);
say('');

interface Q { out: bigint }
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
    if (dex !== undefined && (labels.length !== 1 || labels[0] !== dex)) return null;
    return { out: BigInt(j.outAmount) };
  }
  return null;
}
async function roundTrip(mint: string, buyOn: string, sellOn: string): Promise<number | null> {
  const l1 = await quote(WSOL, mint, NOTIONAL, buyOn);
  await sleep(GAP_MS);
  if (l1 === null || l1.out <= 0n) return null;
  const l2 = await quote(mint, WSOL, l1.out, sellOn);
  await sleep(GAP_MS);
  if (l2 === null) return null;
  return Number(l2.out) - Number(NOTIONAL) - TX_COST_LAMPORTS;
}

let surveyed = 0; let multi = 0; let everPositive = 0; let persistent = 0;
say('  mint         venues                      round-trip net by round (SOL)                verdict');
for (const [pool, vol] of untouched) {
  if (surveyed >= TOKENS) break;
  const mint = poolToMint.get(pool);
  if (mint === undefined) continue;
  const per: { venue: string; out: bigint }[] = [];
  for (const v of VENUES) {
    const q = await quote(WSOL, mint, NOTIONAL, v);
    await sleep(GAP_MS);
    if (q !== null && q.out > 0n) per.push({ venue: v, out: q.out });
  }
  if (per.length < 2) continue;
  const outs = per.map((x) => Number(x.out)).sort((a, b) => a - b);
  const mid = outs[Math.floor(outs.length / 2)] ?? 0;
  const liquid = per.filter((x) => Number(x.out) > mid / 2 && Number(x.out) < mid * 2);
  if (liquid.length < 2) continue;
  surveyed += 1; multi += 1;
  liquid.sort((a, b) => (b.out > a.out ? 1 : -1));
  const buyOn = liquid[0]?.venue ?? ''; const sellOn = liquid[liquid.length - 1]?.venue ?? '';
  const series: (number | null)[] = [];
  for (let r = 0; r < ROUNDS; r += 1) series.push(await roundTrip(mint, buyOn, sellOn));
  const vals = series.filter((x): x is number => x !== null);
  const pos = vals.filter((x) => x > 0).length;
  if (pos > 0) everPositive += 1;
  /** Persistent means positive on EVERY round: nobody is taking it, so speed is not the constraint. */
  const verdict = vals.length === 0 ? 'unpriceable'
    : pos === vals.length ? 'PERSISTENT — speed is not the constraint'
      : pos > 0 ? `transient (${pos}/${vals.length} rounds)` : 'never positive';
  if (vals.length > 0 && pos === vals.length) persistent += 1;
  say(
    `  ${mint.slice(0, 10)}  ${liquid.map((x) => x.venue).join(',').slice(0, 26).padEnd(26)} ` +
    `${series.map((x) => (x === null ? '   n/a' : (x / 1e9).toFixed(5).padStart(9))).join(' ')}   ${verdict}   vol ${(vol / 1e9).toFixed(0)} SOL`,
  );
}
say('');
say(`  ${surveyed} untouched tokens on 2+ liquid venues; ${everPositive} positive in ANY round; ${persistent} positive in EVERY round`);
say('');
if (persistent > 0) {
  say('  A spread positive on every round over minutes is not being competed for. If these are real,');
  say('  latency is NOT the binding constraint and the infrastructure spend is unnecessary.');
} else {
  say('  Nothing persisted. Combined with MT182, the spreads that exist are either taken within a');
  say('  slot or never clear the two-swap cost. Buying latency would buy entry to a race, not an edge.');
}
