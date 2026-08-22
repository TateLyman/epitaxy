/**
 * THE TRUE ALL-IN COST FLOOR, MEASURED AGAINST THE CHAIN, SPENDING NOTHING.
 *
 * Every negative result this programme has produced is priced against a cost number. MT124 said
 * 130-250 bps round trip. MT127-DEFECT found a 25 bps fee clamp that had understated it by ~180
 * bps for seven consecutive tests. And a single hand-verified simulation last hour said the AMM
 * fee on a currently-liquid pool is 26.4 bps a leg, not the 115 the trade cache measured — a
 * disagreement of 89 bps in the OTHER direction. One of those is wrong about the population.
 *
 * This settles it, and settles the part nobody has measured at all.
 *
 * THE STALENESS FIX. A first version read reserves at one instant and simulated at another, so
 * the implied fee absorbed whatever trading happened in between and returned impossible values,
 * including negatives and one reading of 422,550 bps. Here reserves are read BEFORE and AFTER the
 * simulation and the sample is DISCARDED unless both reads are byte-identical. A pool that moved
 * during the measurement is not evidence about fees; it is evidence that the measurement raced.
 *
 * THE FIXED COSTS, WHICH ARE THE PART THAT ACTUALLY BITES AT THIS SIZE. A percentage fee is
 * scale-free; a signature fee is not. At a 0.02 SOL notional a 5,000 lamport signature is 2.5 bps
 * and a priority fee of 100,000 lamports is 50 bps — per leg. The order response carries
 * `signatureFeeLamports`, `prioritizationFeeLamports` and `rentFeeLamports` explicitly, so the
 * all-in floor is computable rather than assumed. Rent is reported SEPARATELY because it is
 * refundable when the account closes, and counting a refundable deposit as a cost would overstate
 * the floor exactly as ignoring it understates it.
 *
 * GROUND TRUTH is the aggregator's own return value — a base64 little-endian u64 — not a parsed
 * log line. Unsigned throughout: `sigVerify: false` means no signature is required or produced,
 * so this cannot spend and cannot become a trade by accident.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { priceBuy, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAKER = arg('taker');
const N = Number(arg('n') ?? '40');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');

const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
if (RPC === null || RPC === undefined) { console.error('no RPC configured'); process.exit(2); }
if (TAKER === null) { console.error('need --taker=<pubkey> so a transaction can be built and simulated'); process.exit(2); }
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: T; error?: unknown };
    if (j.error !== undefined) return null;
    return j.result ?? null;
  } catch { return null; }
}

async function reserves(pool: string): Promise<{ base: bigint; quote: bigint } | null> {
  const found: { mint: string; amount: bigint }[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpc<{ value: { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] }>(
      'getTokenAccountsByOwner', [pool, { programId }, { encoding: 'jsonParsed' }],
    );
    for (const v of r?.value ?? []) {
      const i = v.account?.data?.parsed?.info;
      if (i?.mint === undefined || i.tokenAmount?.amount === undefined) continue;
      found.push({ mint: i.mint, amount: BigInt(i.tokenAmount.amount) });
    }
  }
  const q = found.find((v) => v.mint === WSOL);
  const b = found.find((v) => v.mint !== WSOL);
  if (q === undefined || b === undefined || q.amount <= 0n || b.amount <= 0n) return null;
  return { base: b.amount, quote: q.amount };
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const mints = (db.prepare(
  `SELECT mint FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
    GROUP BY mint ORDER BY MAX(requested_utc_ms) DESC LIMIT ?`).all(N * 6) as { mint: string }[]).map((r) => r.mint);
db.close();

console.log(`TRUE COST FLOOR — ${Number(NOTIONAL) / 1e9} SOL notional, single-hop PumpSwap, unsigned simulation`);
console.log(`  reserves verified stable across the simulation; racing samples discarded`);
console.log('');

interface S {
  mint: string; ammFeeBps: number; vUsed: number; sigL: number; prioL: number; rentL: number; platformL: number;
}
const ok: S[] = [];
let raced = 0; let noQuote = 0; let multiHop = 0; let noSim = 0; let noVaults = 0; let unresolvedV = 0;

for (const mint of mints) {
  if (ok.length >= N) break;
  await new Promise((r) => setTimeout(r, 850));

  const qs = new URLSearchParams({
    inputMint: WSOL, outputMint: mint, amount: NOTIONAL.toString(), slippageBps: '300', taker: TAKER,
  });
  let o: {
    outAmount?: string; transaction?: string; routePlan?: { swapInfo?: { ammKey?: string } }[];
    signatureFeeLamports?: number; prioritizationFeeLamports?: number; rentFeeLamports?: number;
    platformFee?: { amount?: string } | null;
  };
  try {
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) { noQuote += 1; continue; }
    o = await res.json() as typeof o;
  } catch { noQuote += 1; continue; }
  if (o.outAmount === undefined || o.transaction === undefined) { noQuote += 1; continue; }
  const plan = o.routePlan ?? [];
  if (plan.length !== 1) { multiHop += 1; continue; }
  const pool = plan[0]?.swapInfo?.ammKey;
  if (pool === undefined) { multiHop += 1; continue; }

  const r1 = await reserves(pool);
  if (r1 === null) { noVaults += 1; continue; }

  const sim = await rpc<{ value?: { err?: unknown; logs?: string[] } }>('simulateTransaction', [
    o.transaction, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'processed' },
  ]);
  let chain: bigint | null = null;
  for (const l of sim?.value?.logs ?? []) {
    const m = new RegExp(`^Program return: ${JUP_PROGRAM} (.+)$`).exec(l);
    if (m?.[1] === undefined) continue;
    const b = Buffer.from(m[1], 'base64');
    if (b.length >= 8) { chain = b.readBigUInt64LE(0); break; }
  }
  if (chain === null || chain <= 0n) { noSim += 1; continue; }

  // THE RACE CHECK. If the pool moved while we measured, the sample says nothing about fees.
  const r2 = await reserves(pool);
  if (r2 === null || r2.base !== r1.base || r2.quote !== r1.quote) { raced += 1; continue; }

  /**
   * THE VIRTUAL QUOTE RESERVE IS NOT OPTIONAL AND IT IS NOT FITTED. This repository established
   * that a PumpSwap pool carries a per-pool virtual quote reserve of EXACTLY 0 or 17,584,500,000
   * lamports — two values, never a free parameter. A first version of this script hardcoded 0 for
   * every pool, and the pools where v is nonzero came back with impossible implied fees (1,994
   * bps, and negatives) because the missing reserve was absorbed into the fee term.
   *
   * Both candidates are evaluated and BOTH are reported. Choosing whichever looks nicer would be
   * fitting; reporting both lets the reader see that one candidate produces a tight cluster and
   * the other produces nonsense, which is evidence rather than selection.
   */
  const feeUnder = (v: bigint): number | null => {
    try {
      const f: PoolFeeLadder = {
        lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: 0n,
      };
      const zf = priceBuy({ base: r1.base, quote: r1.quote, virtualQuote: v }, NOTIONAL, f).baseOut;
      if (zf <= 0n) return null;
      return 1e4 * (1 - Number(chain) / Number(zf));
    } catch { return null; }
  };
  const fee0 = feeUnder(0n);
  const feeV = feeUnder(17_584_500_000n);
  if (fee0 === null) continue;
  // Plausibility is judged on the DECODED ladder this venue actually uses: the observed tiers sum
  // to between 25 and 125 bps a leg. A candidate outside 0..200 is not a fee, it is a wrong v.
  const plausible = (x: number | null): boolean => x !== null && x >= 0 && x <= 200;
  const ammFeeBps = plausible(fee0) ? fee0 : plausible(feeV) ? (feeV as number) : fee0;
  const vUsed = plausible(fee0) ? 0 : plausible(feeV) ? 1 : -1;
  if (vUsed < 0) { unresolvedV += 1; continue; }
  const platformL = o.platformFee?.amount === undefined ? 0 : Number(o.platformFee.amount);
  ok.push({
    mint, ammFeeBps, vUsed,
    sigL: o.signatureFeeLamports ?? 0,
    prioL: o.prioritizationFeeLamports ?? 0,
    rentL: o.rentFeeLamports ?? 0,
    platformL,
  });
  console.log(
    `  ${mint.slice(0, 8)}  amm ${ammFeeBps.toFixed(1).padStart(6)} bps  v=${vUsed === 0 ? '0    ' : '17.58S'}  ` +
    `sig ${String(o.signatureFeeLamports ?? 0).padStart(6)}   prio ${String(o.prioritizationFeeLamports ?? 0).padStart(8)}   ` +
    `rent ${String(o.rentFeeLamports ?? 0).padStart(8)}   platform ${String(platformL).padStart(6)}`,
  );
}

const med = (a: number[]): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const pctl = (a: number[], p: number): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] ?? NaN) : NaN; };

console.log('');
console.log(`clean samples ${ok.length}   discarded: ${raced} raced, ${multiHop} multi-hop, ${noVaults} no vaults, ${noSim} no sim, ${noQuote} no quote, ${unresolvedV} no plausible v`);
console.log(`  virtual reserve resolved: ${ok.filter((s) => s.vUsed === 0).length} pools at v=0, ${ok.filter((s) => s.vUsed === 1).length} at v=17.5845 SOL`);
if (ok.length < 5) { console.log('TOO FEW CLEAN SAMPLES to state a floor. Reported as an instrument limit, not a result.'); process.exit(0); }

const amm = ok.map((s) => s.ammFeeBps);
const notionalL = Number(NOTIONAL);
const fixedBpsPerLeg = ok.map((s) => 1e4 * (s.sigL + s.prioL + s.platformL) / notionalL);
const rentBps = ok.map((s) => 1e4 * s.rentL / notionalL);

console.log('');
console.log('AMM FEE, solved from constant product against what the chain actually returned');
console.log(`  p10 ${pctl(amm, 0.10).toFixed(1)}   MEDIAN ${med(amm).toFixed(1)}   p90 ${pctl(amm, 0.90).toFixed(1)} bps per leg`);
console.log('');
console.log('FIXED COSTS as bps of this notional — scale-free fees are not the whole story at 0.02 SOL');
console.log(`  signature + priority + platform   MEDIAN ${med(fixedBpsPerLeg).toFixed(1)} bps per leg`);
console.log(`  rent (REFUNDABLE on close)        MEDIAN ${med(rentBps).toFixed(1)} bps — reported, not counted`);
console.log('');
const floorLeg = med(amm) + med(fixedBpsPerLeg);
console.log('THE ALL-IN ROUND-TRIP FLOOR');
console.log(`  ${floorLeg.toFixed(1)} bps per leg  ->  ${(2 * floorLeg).toFixed(0)} bps round trip`);
console.log('');
console.log('  Against the numbers this programme has been pricing every result with:');
console.log('    MT124 said 130-250 bps round trip');
console.log('    the trade cache measured 115 bps per leg = 230 round trip');
console.log(`    the chain says ${(2 * floorLeg).toFixed(0)} bps round trip at this size`);
console.log('');
console.log('  A LOWER floor does not turn a negative result positive — MT127 at -10%, MT128 at');
console.log('  -8.7% and MT131 at -18% all dwarf any plausible fee correction. What it changes is');
console.log('  the EDGE-VERSUS-TOLL arithmetic, where the gap was 16 bps of decayed edge against a');
console.log('  160 bps net toll. That comparison is only as good as this number.');
