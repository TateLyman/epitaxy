/**
 * WHY does one cheap-bracket mint round-trip at 31 bps and the next at 288?
 *
 * bracket-cost-check.ts found the cheap cohort is BIMODAL: two mints quote at 31 and 35 bps a
 * round trip against a top-bracket control of 242, and five cluster at 280-288 with under 8 bps
 * of spread between them. Five different tokens landing that close together is not depth and is
 * not coincidence — something uniform is setting that number, and until it is named the cheap
 * bracket cannot be used.
 *
 * TWO HYPOTHESES, AND THEY ARE DISTINGUISHED BY SIZE.
 *
 *   STALE DEPTH. The panel is three days old. If those pools have since collapsed, a 0.02 SOL
 *   order is now large relative to what is left and the cost is our own impact. Then quoting TEN
 *   TIMES SMALLER collapses the cost, because impact scales with size.
 *
 *   A FIXED CHARGE. If instead the cost is a fee — a tier we have misread, a routing toll, a
 *   token-level transfer fee on both legs — then it is invariant to size and 0.002 SOL costs the
 *   same 288 bps as 0.02.
 *
 * The two predictions are opposite, which is what makes this worth one minute of quotes.
 *
 * ROUTE LABELS ARE READ TOO, because live-cost-check.ts records 18% of real routes leaving the
 * direct Pump.fun hop entirely — OKX DEX Router, Meteora DAMM v2, multi-hop. A pool that is cheap
 * on the tape but only reachable through an expensive route is not cheap to us.
 *
 * Quotes only. Signs nothing, sends nothing, spends nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const SIZES = [2_000_000n, 20_000_000n];
const MINTS = [
  ['5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2', 'cheap  35 bps'],
  ['9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump', 'cheap  31 bps'],
  ['C6G2FyVnFgTVWCfkEwrp4ETpcU9tp4idaAcHZuHKpump', 'dear  288 bps'],
  ['TENg3y8YGNGhdq8vWPkXjykMZG4Mwr79nRYxb6cpump', 'dear  288 bps'],
  ['awEiojbGyfrwmSEFUDcAbh82LJtf5MMca5YMnagpump', 'dear  280 bps'],
];

const secrets = await loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

interface Q { out: bigint; labels: string[]; priceImpactPct: number | null }

async function quote(inMint: string, outMint: string, amount: bigint): Promise<Q | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: '100' });
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      outAmount?: string; priceImpactPct?: string;
      routePlan?: { swapInfo?: { label?: string } }[];
    };
    if (j.outAmount === undefined) return null;
    return {
      out: BigInt(j.outAmount),
      labels: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?'),
      priceImpactPct: j.priceImpactPct === undefined ? null : Number(j.priceImpactPct),
    };
  } catch { return null; }
}

console.log('ROUND-TRIP COST AGAINST ORDER SIZE');
console.log('  stale depth predicts the cost FALLS as size falls. A fixed charge predicts it does not.');
console.log('');
console.log('  mint          expected      0.002 SOL     0.020 SOL    verdict');
for (const entry of MINTS) {
  const mint = entry[0] as string;
  const label = entry[1] as string;
  const costs: (number | null)[] = [];
  const routes: string[] = [];
  for (const N of SIZES) {
    const a = await quote(WSOL, mint, N);
    if (a === null || a.out <= 0n) { costs.push(null); continue; }
    const b = await quote(mint, WSOL, a.out);
    if (b === null || b.out <= 0n) { costs.push(null); continue; }
    costs.push(1e4 * (1 - Number(b.out) / Number(N)));
    routes.push(`${a.labels.join('>')} | back ${b.labels.join('>')}${a.priceImpactPct !== null ? ` | impact ${(100 * a.priceImpactPct).toFixed(2)}%` : ''}`);
  }
  const small = costs[0]; const big = costs[1];
  const verdict = small === null || big === null ? 'incomplete'
    : Math.abs(small - big) < 30 ? 'FIXED CHARGE — size-invariant'
    : small < big ? 'OUR OWN IMPACT — falls with size'
    : 'inverted';
  console.log(
    `  ${mint.slice(0, 10)}  ${label.padEnd(12)} ${(small === null ? 'n/a' : small.toFixed(0)).padStart(10)} ${(big === null ? 'n/a' : big.toFixed(0)).padStart(13)}    ${verdict}`,
  );
  for (const r of routes) console.log(`               route: ${r}`);
}
console.log('');
console.log('  A pool that is cheap on the tape but only reachable through an expensive route is not');
console.log('  cheap to us. The tape prices a direct hop; we have to fill what the router returns.');
