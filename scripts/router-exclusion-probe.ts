/**
 * Can the 40 bps MT125 measured actually be RECOVERED, or only observed?
 *
 * MT125 showed metis costs 40 bps more than okx on the SAME token, within-mint, across 202
 * mints. That is a real routing effect rather than token selection. But Jupiter chooses the
 * router; a caller cannot demand one. The API does expose `excludeRouters` accepting
 * `metis, jupiterz, dflow, okx`, so the lever exists in the negative direction.
 *
 * TWO THINGS DECIDE WHETHER IT IS USABLE, and neither is answerable from the corpus:
 *   COVERAGE  if metis is excluded, is a quote still returned at all? metis served 77% of our
 *             quotes, so a large share of tokens may have no other route.
 *   PRICE     when a non-metis route IS returned, is it actually better on the same token at
 *             the same moment?
 *
 * This asks both, live, on real mints, with paired requests issued back to back so the two
 * quotes describe the same market. Quoting does not trade and signs nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const BASE = 'https://api.jup.ag';
const AMOUNT = 20_000_000n; // 0.02 SOL, the frozen research notional
const N = 40;

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
// MOST RECENTLY quoted, not most-quoted. A first attempt used the highest-count mints and 37
// of 40 baseline quotes failed: the most-quoted tokens are the OLDEST ones, and they are dead.
// Liquidity on this venue is a property of the last few minutes, not of history.
const mints = (db.prepare(
  `SELECT mint, MAX(requested_utc_ms) t FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
    GROUP BY mint ORDER BY t DESC LIMIT ?`).all(N) as { mint: string; t: number }[]).map((r) => r.mint);
db.close();
console.log(`probing ${mints.length} mints at 0.02 SOL, paired requests back to back\n`);

// A first run failed 37 of 40 baseline quotes and I misread it as dead tokens. It was RATE
// LIMITING: two requests per mint fired back to back with the only delay at the end of the
// loop, 80 requests in a burst against an unauthenticated endpoint. The key and a per-request
// pace fix it. Raw curl on the same mint had worked, which is what gave it away.
const KEY = loadSecrets().jupiterApiKey;
const HEADERS: Record<string, string> = KEY !== null && KEY !== undefined ? { 'x-api-key': KEY } : {};
console.log(`  api key ${KEY !== null && KEY !== undefined ? 'present' : 'ABSENT — expect rate limiting'}`);
const PACE_MS = 900;

interface Q { out: bigint; router: string; route: string }
async function quote(mint: string, exclude: string | null): Promise<Q | null> {
  const qs = new URLSearchParams({ inputMint: WSOL, outputMint: mint, amount: AMOUNT.toString(), slippageBps: '200' });
  if (exclude !== null) qs.set('excludeRouters', exclude);
  try {
    await new Promise((r) => setTimeout(r, PACE_MS));
    const res = await fetch(`${BASE}/swap/v2/order?${qs.toString()}`, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string; router?: string; routePlan?: { swapInfo?: { label?: string } }[] };
    if (j.outAmount === undefined) return null;
    return {
      out: BigInt(j.outAmount),
      router: j.router ?? 'unknown',
      route: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?').join('>') || 'unknown',
    };
  } catch { return null; }
}

let both = 0; let noAlt = 0; let baseFail = 0;
const deltas: number[] = [];
const altRouters = new Map<string, number>();
for (const m of mints) {
  const a = await quote(m, null);
  const b = await quote(m, 'metis');
  if (a === null) { baseFail += 1; continue; }
  if (b === null) { noAlt += 1; continue; }
  both += 1;
  altRouters.set(b.router, (altRouters.get(b.router) ?? 0) + 1);
  // Positive => excluding metis returns MORE output, i.e. it is cheaper for us.
  deltas.push(1e4 * (Number(b.out) - Number(a.out)) / Number(a.out));
}

const med = (x: number[]): number => { const s = [...x].sort((p, q2) => p - q2); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
console.log('COVERAGE — does a quote still exist with metis excluded?');
console.log(`  both routes returned      ${both}`);
console.log(`  NO non-metis route        ${noAlt}`);
console.log(`  baseline quote failed     ${baseFail}`);
console.log('');
console.log('PRICE — output difference on the SAME mint, same moment (positive = excluding metis is BETTER)');
if (deltas.length >= 5) {
  const s = [...deltas].sort((a, b) => a - b);
  const p = (x: number): number => s[Math.floor(x * (s.length - 1))] ?? NaN;
  console.log(`  n=${deltas.length}   p25 ${p(0.25).toFixed(3)} bps   median ${med(deltas).toFixed(3)} bps   p75 ${p(0.75).toFixed(3)} bps`);
  console.log(`  raw deltas: ${[...deltas].sort((a, b) => a - b).map((d) => d.toFixed(2)).join(', ')}`);
  console.log(`  better on ${deltas.filter((d) => d > 0).length}/${deltas.length}`);
} else {
  console.log(`  n=${deltas.length} — too few to read`);
}
console.log('');
console.log('ROUTERS SERVING THE EXCLUDED REQUESTS');
for (const [k, v] of [...altRouters.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}`);
console.log('');
console.log('  This is ONE leg. A round trip pays it twice, so double any figure above before');
console.log('  comparing to the MT125 within-mint estimate of 40 bps a ROUND TRIP.');
