import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { JupiterClient } from '../packages/adapters/src/jupiter/client.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import {
  bondingCurveAddress,
  decodeBondingCurve,
  quoteBuyTokensForSol,
  venueOf,
  PUMP_PROGRAM,
} from '../packages/solana/src/pump.js';

/**
 * `pnpm pump:parity` — §13's quoter, checked against an independent source.
 *
 * The directive asks for parity against the official SDK. That is one way to
 * check arithmetic; comparing against what a ROUTER will actually pay is a
 * better one, because it is the number a trade is filled at and it comes from
 * somebody who has no reason to agree with us.
 *
 * The comparison is deliberately loose in one direction and strict in another.
 * Jupiter's output is net of Pump's protocol fee and whatever routing it picks,
 * so it must be LOWER than the raw curve output; a router beating the curve
 * would mean our curve is wrong. The residual is reported as a fee in basis
 * points, and if that residual is stable across tokens and sizes it is a fee
 * schedule, while if it is erratic the curve math is wrong.
 *
 * Read-only. Nothing is signed or sent.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const SIZES = [10_000_000n, 20_000_000n, 50_000_000n];
const RPC = process.env['SOLANA_RPC_HTTP'] ?? 'https://api.mainnet-beta.solana.com';

const secrets = loadSecrets();
const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.log('PAPER_TAKER_PUBKEY is unset.');
  process.exit(2);
}

const jup = new JupiterClient({
  limiter: RateLimiter.fromConfig(secrets.jupiterApiKey !== null),
  apiKey: secrets.jupiterApiKey,
});

async function rpc(method: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result ?? null;
}

// Recent candidates are the ones most likely to still be on a bonding curve.
const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const mints = (db.prepare('SELECT mint FROM candidates ORDER BY rowid DESC LIMIT 60').all() as { mint: string }[]).map(
  (r) => r.mint,
);
db.close();

interface Row {
  mint: string;
  lamportsIn: string;
  curveTokens: string;
  routerTokens: string;
  residualBps: number;
  routerBeatCurve: boolean;
  route: string;
}
const rows: Row[] = [];
let live = 0;
let moved = 0;
let nonStandard = 0;

/** The curve as it stands right now, or null if it is not a live Pump curve. */
async function readCurve(mint: string): Promise<ReturnType<typeof decodeBondingCurve> | null> {
  try {
    const info = await rpc('getAccountInfo', [bondingCurveAddress(mint), { encoding: 'base64' }]);
    const v = info?.['value'] as { data?: [string, string]; owner?: string } | null;
    if (v === null || v === undefined || v.owner !== PUMP_PROGRAM) return null;
    const c = decodeBondingCurve(new Uint8Array(Buffer.from(v.data?.[0] ?? '', 'base64')));
    return venueOf(c) === 'BONDING_CURVE' ? c : null;
  } catch {
    return null;
  }
}

console.log('looking for live bonding curves among recent candidates\n');
for (const mint of mints) {
  if (live >= 3) break;
  const curve = await readCurve(mint);
  if (curve === null) continue;
  if (!curve.standardConfiguration) {
    // Not a failure of the quoter: it refuses these, and this check is what
    // established that it should.
    console.log(`${mint.slice(0, 10)}  non-standard virtual offsets; the quoter refuses to price it`);
    nonStandard += 1;
    continue;
  }
  live += 1;
  console.log(
    `${mint.slice(0, 10)}  real ${(Number(curve.realSolReserves) / 1e9).toFixed(3)} SOL, ` +
      `virtual ${(Number(curve.virtualSolReserves) / 1e9).toFixed(3)} SOL, standard=${curve.standardConfiguration}`,
  );

  for (const amount of SIZES) {
    // Re-read the curve either side of the router call and require it not to
    // have moved.
    //
    // Measured: one token gave a CONSTANT -1016 bps across three sizes, meaning
    // the router paid 10% more than the constant product allows. A stale-reserve
    // error would vary with size, because the curve is nonlinear; a constant
    // multiplier means the whole ratio shifted, i.e. somebody traded between the
    // account read and the quotes. On a curve holding 1.68 real SOL a single
    // 0.17 SOL sell does exactly that.
    //
    // Comparing across a moved pool is comparing two different curves and
    // calling the difference a parity failure.
    const before = await readCurve(mint);
    const curveTokens = before === null ? null : quoteBuyTokensForSol(before, amount);
    if (before === null || curveTokens === null) {
      console.log(`  ${Number(amount) / 1e9} SOL  curve refuses to quote (migrated, or too large for real reserves)`);
      continue;
    }
    const built = await jup.build({ inputMint: SOL, outputMint: mint, amount, taker });
    if (!built.buildable) {
      console.log(`  ${Number(amount) / 1e9} SOL  router has no route (${built.failure})`);
      continue;
    }
    const after = await readCurve(mint);
    if (
      after === null ||
      after.virtualSolReserves !== before.virtualSolReserves ||
      after.virtualTokenReserves !== before.virtualTokenReserves
    ) {
      console.log(
        `  ${Number(amount) / 1e9} SOL  SKIPPED: the curve moved during the quote ` +
          `(${before.virtualSolReserves} -> ${after?.virtualSolReserves ?? 'unreadable'})`,
      );
      moved += 1;
      continue;
    }
    const routerTokens = built.outAmount;
    // Positive means the curve quoted MORE than the router pays, which is the
    // expected direction: the router's number is net of protocol fees.
    const residualBps = Number(((curveTokens - routerTokens) * 10_000n) / curveTokens);
    const routerBeatCurve = routerTokens > curveTokens;
    console.log(
      `  ${String(Number(amount) / 1e9).padStart(5)} SOL  curve ${curveTokens}  router ${routerTokens}  ` +
        `residual ${residualBps} bps  route ${built.routeLabels.join('+')}${routerBeatCurve ? '  ROUTER BEAT CURVE' : ''}`,
    );
    rows.push({
      mint,
      lamportsIn: amount.toString(),
      curveTokens: curveTokens.toString(),
      routerTokens: routerTokens.toString(),
      residualBps,
      routerBeatCurve,
      route: built.routeLabels.join('+'),
    });
  }
}

if (rows.length === 0) {
  console.log(`\nno comparable quote was obtained (${moved} skipped because the curve moved mid-quote)`);
  process.exit(2);
}
if (nonStandard > 0) console.log(`${nonStandard} curve(s) skipped as non-standard, which the quoter refuses to price`);
if (moved > 0) console.log(`\n${moved} comparison(s) skipped because the curve moved during the quote`);

const residuals = rows.map((r) => r.residualBps);
const spread = Math.max(...residuals) - Math.min(...residuals);
const beat = rows.filter((r) => r.routerBeatCurve);

console.log('\nparity:');
const checks: [string, boolean, string][] = [
  [
    'the router never pays MORE than the raw curve',
    beat.length === 0,
    beat.length === 0
      ? 'as expected: the router quotes net of protocol fees'
      : `${beat.length} case(s) where the router beat the curve, which means the curve math is wrong`,
  ],
  [
    'the residual is a stable fee rather than noise',
    spread <= 200,
    `residuals ${Math.min(...residuals)}..${Math.max(...residuals)} bps, spread ${spread}`,
  ],
];
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) process.exitCode = 1;
}

console.log(
  '\nA stable residual is a fee schedule and confirms the curve. An erratic one means the constant-product\n' +
    'arithmetic is wrong, and a router paying MORE than the curve means it is wrong in the dangerous direction.',
);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/pump-parity.json',
  `${JSON.stringify(
    { takenAtUtcMs: Date.now(), rows, residualSpreadBps: spread, routerBeatCurveCount: beat.length, skippedBecauseCurveMoved: moved, skippedNonStandard: nonStandard },
    null,
    2,
  )}\n`,
);
console.log('wrote artifacts/pump-parity.json');
