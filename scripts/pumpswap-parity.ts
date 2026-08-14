/**
 * P13 — parity between the local PumpSwap model and Jupiter BUILD_CUSTOM.
 *
 * The bar is the directive's, not a comfortable one:
 *
 *   Require exact or fully explained deterministic difference.
 *   A 123–257 bps residual is not parity.
 *
 * So this REPORTS the residual it measures and refuses to grade itself. If the
 * number is bad, the number is bad, and the local quoter stays out of the mark
 * path — which is where a wrong model does the most damage, because a mark
 * moves a stop.
 *
 * The local side is the official SDK's own functions over the official SDK's
 * own decoders. What is being tested is whether OUR account reading and pool
 * identification feed it correctly, not whether Pump's arithmetic is right.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc } from '../packages/solana/src/rpc.js';
import {
  quoteBuy,
  canonicalPoolFor,
  PUMPSWAP_SDK_VERSION,
  PumpSwapModelUnavailable,
  GLOBAL_CONFIG,
  FEE_CONFIG,
} from '../packages/solana/src/pumpswap-model.js';

const SOL = 'So11111111111111111111111111111111111111112';
const PROBE_LAMPORTS = 20_000_000n;

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
  console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
const rpc = new SolanaRpc(RateLimiter.fromConfig(true), {
  primary: secrets.rpcHttp,
  fallback: secrets.rpcHttpFallback,
});
const jupiter = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});
void config;

/** Mints seen recently that route through PumpSwap. */
const candidates = db
  .prepare(
    `SELECT DISTINCT o.mint
       FROM execution_observations o
      WHERE o.side = 'buy'
        AND o.received_utc_ms > ?
        AND (o.route_labels LIKE '%Pump%' OR o.route_labels LIKE '%pump%')
      -- Older first: a canonical PumpSwap pool only exists AFTER migration, so
      -- the youngest candidates are precisely the ones still on the bonding
      -- curve and unpriceable by this model. That is a fact about the venue,
      -- not a parity failure.
      ORDER BY o.received_utc_ms ASC
      LIMIT ${Number(process.env['PARITY_LIMIT'] ?? 12)}`,
  )
  .all(Date.now() - 14 * 24 * 3_600_000) as { mint: string }[];

interface Row {
  mint: string;
  pool: string | null;
  localBaseOut: string | null;
  jupiterOut: string | null;
  residualBps: number | null;
  feeConfigPresent: boolean | null;
  virtualQuoteReserves: string | null;
  status: string;
  detail: string | null;
}

const rows: Row[] = [];
console.log(`pumpswap parity — sdk ${PUMPSWAP_SDK_VERSION}, probe ${Number(PROBE_LAMPORTS) / 1e9} SOL`);
console.log(`  global config ${GLOBAL_CONFIG}`);
console.log(`  fee config    ${FEE_CONFIG}\n`);

for (const c of candidates) {
  const r: Row = {
    mint: c.mint,
    pool: null,
    localBaseOut: null,
    jupiterOut: null,
    residualBps: null,
    feeConfigPresent: null,
    virtualQuoteReserves: null,
    status: 'PENDING',
    detail: null,
  };
  process.stdout.write(`  ${c.mint.slice(0, 12)} ... `);

  try {
    r.pool = canonicalPoolFor(c.mint, SOL);
  } catch (e) {
    r.status = 'NO_CANONICAL_POOL';
    r.detail = (e as Error).message.slice(0, 120);
    console.log(r.status);
    rows.push(r);
    continue;
  }

  let local;
  try {
    local = await quoteBuy(rpc, r.pool, PROBE_LAMPORTS, 3);
    r.localBaseOut = local.baseOutAtoms.toString();
    r.feeConfigPresent = local.feeConfigPresent;
    r.virtualQuoteReserves = local.virtualQuoteReserves.toString();
  } catch (e) {
    // A pool that does not exist is a fact about the mint (it may still be on
    // the bonding curve), not a parity failure.
    r.status = e instanceof PumpSwapModelUnavailable ? 'MODEL_UNAVAILABLE' : 'MODEL_ERROR';
    r.detail = (e as Error).message.slice(0, 140);
    console.log(`${r.status} ${r.detail}`);
    rows.push(r);
    continue;
  }

  const built = await jupiter
    .build({ inputMint: SOL, outputMint: c.mint, amount: PROBE_LAMPORTS, taker, slippageBps: 300, priority: 'risk' })
    .catch((e: unknown) => {
      r.status = 'JUPITER_NO_ROUTE';
      r.detail = (e as Error).message.slice(0, 120);
      return null;
    });
  if (built === null || built.outAmount === null) {
    if (r.status === 'PENDING') r.status = 'JUPITER_NO_OUTPUT';
    console.log(r.status);
    rows.push(r);
    continue;
  }

  r.jupiterOut = built.outAmount.toString();
  const a = local.baseOutAtoms;
  const b = built.outAmount;
  // Signed: positive means the local model is OPTIMISTIC relative to the route
  // actually being built, which is the dangerous direction.
  r.residualBps = b === 0n ? null : Number(((a - b) * 10_000n) / b);
  r.status = 'MEASURED';
  console.log(`local=${a} jupiter=${b} residual=${r.residualBps}bps`);
  rows.push(r);
}

const measured = rows.filter((x) => x.status === 'MEASURED' && x.residualBps !== null);
const abs = measured.map((x) => Math.abs(x.residualBps as number)).sort((x, y) => x - y);
const median = abs.length === 0 ? null : abs[Math.floor(abs.length / 2)];
const worst = abs.length === 0 ? null : abs[abs.length - 1];

const out = {
  generatedUtcMs: Date.now(),
  sdkVersions: { pumpSwapSdk: PUMPSWAP_SDK_VERSION, pumpSdk: '1.36.0' },
  probeLamports: PROBE_LAMPORTS.toString(),
  attempted: rows.length,
  measured: measured.length,
  medianAbsResidualBps: median ?? null,
  worstAbsResidualBps: worst ?? null,
  /**
   * The directive's bar, applied honestly. Parity is exact or fully explained;
   * a 123-257 bps residual is explicitly NOT parity, so anything in that range
   * or beyond fails and the local quoter stays out of the mark path.
   */
  parityAchieved: median !== null && median !== undefined && median === 0,
  withinDirectiveBar: median !== null && median !== undefined && median < 123,
  rows,
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/pumpswap-parity.json', JSON.stringify(out, null, 2));

console.log(`\nmeasured ${measured.length}/${rows.length}`);
console.log(`median |residual| ${median ?? 'n/a'} bps    worst ${worst ?? 'n/a'} bps`);
console.log(
  out.parityAchieved
    ? 'EXACT parity'
    : out.withinDirectiveBar
      ? 'not exact; below the 123 bps the directive calls not-parity — still not parity'
      : 'NOT parity. The local quoter does not enter the mark path.',
);
console.log('artifacts/pumpswap-parity.json');
db.close();
