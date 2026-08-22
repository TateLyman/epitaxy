/**
 * THE COST MODEL AGAINST THE ACTUAL CHAIN, WITHOUT SPENDING ANYTHING.
 *
 * Every number this programme has produced rests on `priceBuy`/`priceSell`. MT127-DEFECT showed
 * that model can be silently wrong — a 25 bps fee clamp understated round-trip cost by ~180 bps
 * and survived SEVEN consecutive tests, because understating cost makes a negative result merely
 * less negative, so the defect never surfaced. Nothing in the corpus can catch that class of
 * error, because the corpus is the same model checking itself.
 *
 * The obvious fix was a funded live round trip. It is not the only one. `simulateTransaction` runs
 * a real transaction against the REAL program at REAL current reserves and returns what would
 * actually happen — free, unsigned, nothing at risk. `sigVerify: false` with
 * `replaceRecentBlockhash: true` means no signature is required or produced, so this cannot spend
 * and cannot become a trade by accident.
 *
 * RESERVES ARE READ FROM THE CHAIN, NOT FROM OUR CORPUS. A first version looked the pool up in
 * `development_trajectories` and matched nothing: Jupiter routes to whatever pool is liquid right
 * now, and our corpus holds the pools the collector happened to open trajectories on. Reading the
 * pool's own vaults is both more available and more correct, because it is the state at the
 * moment of the quote rather than at the last mark.
 *
 * WHAT IS REPORTED, and the third one is the point:
 *   OURS vs JUPITER   our model against the aggregator's quote. Sensitive to the fee we assume.
 *   OURS vs CHAIN     our model against what the program actually does. GROUND TRUTH.
 *   IMPLIED FEE       the per-leg fee that would make our model match the chain exactly, solved
 *                     from the constant-product identity. This is the calibration: it does not
 *                     ask whether 115 bps is right, it measures what the fee actually is.
 *
 * Read-only and unsigned.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { priceBuy, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';

/** Anchor's `emit_cpi!` wrapper discriminator. */
const CPI_DISC = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const WSOL = 'So11111111111111111111111111111111111111112';
const NOTIONAL = 20_000_000n;
const ASSUMED_FEE_BPS = 115n;                       // the measured median charge per leg
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const TAKER = arg('taker');
const N = Number(arg('n') ?? '10');

const secrets = loadSecrets();
const RPC = secrets.rpcHttp;
if (RPC === null || RPC === undefined) { console.error('no RPC configured'); process.exit(2); }
const JKEY = secrets.jupiterApiKey;
const JH: Record<string, string> = JKEY !== null && JKEY !== undefined ? { 'x-api-key': JKEY } : {};

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC as string, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error !== undefined) return null;
    return j.result ?? null;
  } catch { return null; }
}

interface Vault { mint: string; amount: bigint }
/** A PumpSwap pool PDA owns its two vaults; their balances ARE the reserves. */
async function reserves(pool: string): Promise<{ base: bigint; quote: bigint } | null> {
  // BOTH token programs. A first version queried only the legacy one and failed on 21 of 40
  // pools — those tokens are Token-2022, and the empty result read as "no vaults" when it
  // actually meant "wrong program". An absent field was a fact about the query, not the pool.
  const vaults: Vault[] = [];
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const r = await rpc<{ value: { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] }>(
      'getTokenAccountsByOwner', [pool, { programId }, { encoding: 'jsonParsed' }],
    );
    for (const v of r?.value ?? []) {
      const info = v.account?.data?.parsed?.info;
      const mint = info?.mint; const amt = info?.tokenAmount?.amount;
      if (mint === undefined || amt === undefined) continue;
      vaults.push({ mint, amount: BigInt(amt) });
    }
  }
  const q = vaults.find((v) => v.mint === WSOL);
  const b = vaults.find((v) => v.mint !== WSOL);
  if (q === undefined || b === undefined || q.amount <= 0n || b.amount <= 0n) return null;
  return { base: b.amount, quote: q.amount };
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const mints = (db.prepare(
  `SELECT mint FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
    GROUP BY mint ORDER BY MAX(requested_utc_ms) DESC LIMIT ?`).all(N * 4) as { mint: string }[]).map((r) => r.mint);
db.close();

console.log(`cost model vs chain — ${Number(NOTIONAL) / 1e9} SOL, single-hop PumpSwap only`);
console.log(`  taker ${TAKER ?? '(none — no transaction will be built, so no chain simulation)'}`);
console.log(`  our model assumes ${ASSUMED_FEE_BPS} bps per leg`);
console.log('');

interface Row { mint: string; ours: bigint; jup: bigint; chain: bigint | null; impliedBps: number | null }
const rows: Row[] = [];
const ladders: { lp: number; pro: number; cre: number; sum: number; charged: number }[] = [];
let skipMultiHop = 0; let skipNoReserves = 0; let skipQuote = 0;

for (const mint of mints) {
  if (rows.length >= N) break;
  await new Promise((r) => setTimeout(r, 900));

  const qs = new URLSearchParams({ inputMint: WSOL, outputMint: mint, amount: NOTIONAL.toString(), slippageBps: '300' });
  if (TAKER !== null) qs.set('taker', TAKER);
  let order: { outAmount?: string; transaction?: string; routePlan?: { swapInfo?: { ammKey?: string; label?: string } }[] };
  try {
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) { skipQuote += 1; continue; }
    order = await res.json() as typeof order;
  } catch { skipQuote += 1; continue; }
  if (order.outAmount === undefined) { skipQuote += 1; continue; }

  const plan = order.routePlan ?? [];
  if (plan.length !== 1) { skipMultiHop += 1; continue; }
  const pool = plan[0]?.swapInfo?.ammKey;
  if (pool === undefined) { skipMultiHop += 1; continue; }

  const res0 = await reserves(pool);
  if (res0 === null) { skipNoReserves += 1; continue; }
  const jup = BigInt(order.outAmount);

  let ours: bigint; let zeroFee: bigint;
  try {
    const mk = (bps: bigint): PoolFeeLadder => ({
      lpFeeBasisPoints: 20n, protocolFeeBasisPoints: 5n, coinCreatorFeeBasisPoints: 0n, chargedFeeBasisPoints: bps,
    });
    ours = priceBuy({ base: res0.base, quote: res0.quote, virtualQuote: 0n }, NOTIONAL, mk(ASSUMED_FEE_BPS)).baseOut;
    zeroFee = priceBuy({ base: res0.base, quote: res0.quote, virtualQuote: 0n }, NOTIONAL, mk(0n)).baseOut;
  } catch (e) { if (e instanceof FillNotPriceable) continue; throw e; }

  // Ground truth. Unsigned; nothing can be spent from this call.
  let chain: bigint | null = null;
  let emitted: ReturnType<typeof decodePumpSwapTrade> = null;
  if (order.transaction !== undefined) {
    const sim = await rpc<{ value?: { err?: unknown; logs?: string[] } }>(
      'simulateTransaction',
      [order.transaction, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'processed' }],
    );
    const v = sim?.value;
    /**
     * GROUND TRUTH IS THE PROGRAM'S OWN RETURN VALUE, not a log string. Jupiter returns the
     * realised output as a base64 little-endian u64, so this is what the chain would actually
     * deliver rather than what anything predicted. Verified against a live simulation: quoted
     * 35,402,649 against a returned 35,437,092, i.e. the quote is slightly conservative.
     */
    for (const l of v?.logs ?? []) {
      const m = /^Program return: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 (.+)$/.exec(l);
      if (m?.[1] === undefined) continue;
      const b = Buffer.from(m[1], 'base64');
      if (b.length >= 8) { chain = b.readBigUInt64LE(0); break; }
    }
    // The pool also emits its own trade event; decoding it gives the fee ladder the program
    // ACTUALLY applied, which is the thing MT127-DEFECT was wrong about.
    for (const l of v?.logs ?? []) {
      const m = /^Program data: (.+)$/.exec(l);
      if (m?.[1] === undefined) continue;
      let raw: Buffer;
      try { raw = Buffer.from(m[1], 'base64'); } catch { continue; }
      if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI_DISC)) continue;
      const t = decodePumpSwapTrade(raw.subarray(8));
      if (t === null) continue;
      emitted = t;
      break;
    }
    if (chain === null && v?.err !== null && v?.err !== undefined) {
      console.log(`  ${mint.slice(0, 8)}  simulate: ${JSON.stringify(v.err).slice(0, 70)}`);
    }
  }

  /** Solve for the fee that reproduces the observed output: out = zeroFeeOut * (1 - f). */
  const ref = chain ?? jup;
  const impliedBps = zeroFee > 0n ? 1e4 * (1 - Number(ref) / Number(zeroFee)) : null;

  if (emitted !== null && emitted.coinCreatorFeeBasisPoints !== null) {
    const sum = emitted.lpFeeBasisPoints + emitted.protocolFeeBasisPoints + emitted.coinCreatorFeeBasisPoints;
    const chargedObs = emitted.quoteAmount > 0n
      ? 1e4 * Number(emitted.quoteAmount > emitted.userQuoteAmount ? emitted.quoteAmount - emitted.userQuoteAmount : emitted.userQuoteAmount - emitted.quoteAmount)
        / Number(emitted.quoteAmount > emitted.userQuoteAmount ? emitted.quoteAmount : emitted.userQuoteAmount)
      : NaN;
    ladders.push({ lp: Number(emitted.lpFeeBasisPoints), pro: Number(emitted.protocolFeeBasisPoints), cre: Number(emitted.coinCreatorFeeBasisPoints), sum: Number(sum), charged: chargedObs });
  }
  rows.push({ mint, ours, jup, chain, impliedBps });
  const dj = 1e4 * (Number(ours) - Number(jup)) / Number(jup);
  const dc = chain === null ? NaN : 1e4 * (Number(ours) - Number(chain)) / Number(chain);
  console.log(
    `  ${mint.slice(0, 8)}  ours-vs-jup ${dj.toFixed(0).padStart(6)} bps   ` +
    `ours-vs-chain ${(Number.isFinite(dc) ? dc.toFixed(0) : '  n/a').padStart(6)} bps   ` +
    `implied fee ${(impliedBps === null ? 'n/a' : impliedBps.toFixed(0) + ' bps').padStart(9)}`,
  );
}

const med = (a: number[]): number => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
console.log('');
console.log(`compared ${rows.length}   skipped: ${skipMultiHop} multi-hop, ${skipNoReserves} no readable vaults, ${skipQuote} no quote`);
if (rows.length === 0) process.exit(0);

const dj = rows.map((r) => 1e4 * (Number(r.ours) - Number(r.jup)) / Number(r.jup));
console.log('');
console.log(`OURS vs JUPITER   n=${rows.length}   median ${med(dj).toFixed(0)} bps`);
const wc = rows.filter((r) => r.chain !== null && r.chain > 0n);
if (wc.length > 0) {
  const dc = wc.map((r) => 1e4 * (Number(r.ours) - Number(r.chain)) / Number(r.chain));
  console.log(`OURS vs CHAIN     n=${wc.length}   median ${med(dc).toFixed(0)} bps   <- GROUND TRUTH: the model error`);
} else {
  console.log('OURS vs CHAIN     not measured — no transaction simulated');
}
const imp = rows.map((r) => r.impliedBps).filter((x): x is number => x !== null);
if (imp.length > 0) {
  console.log(`IMPLIED FEE       n=${imp.length}   median ${med(imp).toFixed(1)} bps per leg   (we assume ${ASSUMED_FEE_BPS})`);
  console.log(`                  round trip implied ${(2 * med(imp)).toFixed(0)} bps against our assumed ${2 * Number(ASSUMED_FEE_BPS)}`);
}
if (ladders.length > 0) {
  console.log('');
  console.log(`THE PROGRAM'S OWN EMITTED FEE LADDER, n=${ladders.length} — decoded from the simulated trade event`);
  console.log(`  median lp ${med(ladders.map((l) => l.lp)).toFixed(0)}  protocol ${med(ladders.map((l) => l.pro)).toFixed(0)}  creator ${med(ladders.map((l) => l.cre)).toFixed(0)}  SUM ${med(ladders.map((l) => l.sum)).toFixed(0)} bps`);
  console.log(`  median charge actually taken from the trader: ${med(ladders.map((l) => l.charged)).toFixed(1)} bps per leg`);
  console.log(`  round trip ${(2 * med(ladders.map((l) => l.charged))).toFixed(0)} bps  <- the real cost floor, from the chain`);
}
console.log('');
console.log('A POSITIVE median means the model predicts MORE tokens than reality delivers — the');
console.log('direction that manufactures an edge, and exactly the MT127-DEFECT failure mode.');
