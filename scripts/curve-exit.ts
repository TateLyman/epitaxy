/**
 * Close an MT171 position: wait for the curve to migrate, then sell into the pool.
 *
 * This is the half that earns. `curve-entry.ts` buys a bonding curve near graduation; the return
 * comes from what happens in the first seconds AFTER the pool opens. MT168 measured each pool
 * against its own opening price at +5 seconds: p50 1.279, p75 5.147, p90 60.91. MT171 sells there
 * and books a median of +1,581 to +2,224 bps across three corpora.
 *
 * SO TIMING IS THE STRATEGY, NOT A DETAIL. Selling at 0 seconds books approximately nothing - the
 * curve price and the migration price are the same number, which is exactly why MT171's zero-second
 * control is flat and why that control is what proves the gain is real rather than an accounting
 * artifact. Selling too late gives it back: the same pools measured at +30 seconds are already
 * lower than at +5 for a large share of the distribution. The window is seconds wide.
 *
 * WHAT `--watch` DOES. It polls the bonding-curve account until `complete` flips, which is the
 * migration itself, and then sells immediately. Polling an account is enough here precisely because
 * we are NOT racing anyone: MT169 established the pool-opening seat is unreachable by racing, and
 * MT171 works by already holding it. We need to be quick, not first - and MT168 showed the pump
 * persists at least eight slots, so a second or two of polling latency costs little.
 *
 * EVERY GATE IS A HARD REFUSAL:
 *
 *   WE MUST ACTUALLY HOLD THE TOKEN. The balance is read from the chain, never assumed, because
 *   selling what we do not have produces a confusing failure at the signer rather than a clear one
 *   here.
 *
 *   THE ROUTE MUST BE THE AMM, NOT THE CURVE. "Pump.fun Amm" is post-migration; a bare "Pump.fun"
 *   label means the curve has not migrated and selling there books the zero-second control - the
 *   trade we specifically do not want.
 *
 *   THE PROCEEDS MUST CLEAR A FLOOR. A sell whose output is far below the position's entry cost is
 *   refused rather than dumped, so a mis-decode or a collapsed pool stops the trade instead of
 *   realising it.
 *
 * `--apply` is required. Without it nothing is signed.
 */
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { buildSignableOrder } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode } from '../packages/solana/src/base58.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';
import type { TradeIntent } from '../packages/domain/src/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OFF = { vSol: 16, rSol: 32, complete: 48 };

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const WATCH = process.argv.includes('--watch');
const MINT = arg('mint');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '300');
/** How long to keep polling for migration before giving up, in seconds. */
const WATCH_SECONDS = Number(arg('watch-seconds') ?? '1800');
const POLL_MS = Number(arg('poll-ms') ?? '2000');
/** Refuse a sell whose proceeds fall below this fraction of what we paid, in bps of the entry. */
const MIN_PROCEEDS_BPS = Number(arg('min-proceeds-bps') ?? '2000');
const ENTRY_LAMPORTS = BigInt(arg('entry-lamports') ?? '20000000');

if (MINT === null) { console.log('need --mint=<mint>'); process.exit(2); }

const mode = modeFromArgv(process.argv);
const config = await loadConfig(mode);
const secrets = await loadSecrets();
if (secrets.tradingKeypairPath === null) { console.log('REFUSED: no trading keypair configured'); process.exit(1); }
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 2, burst: 2 },
]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });
const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

console.log(`CURVE EXIT   owner ${owner}`);
console.log(`  mint ${MINT}   ${APPLY ? 'LIVE' : 'DRY RUN'}${WATCH ? `   watching up to ${WATCH_SECONDS}s` : ''}`);

/** How much of the token do we actually hold? Read from the chain, never assumed. */
async function heldAmount(): Promise<bigint> {
  const res = await fetch(secrets.rpcHttp ?? '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [owner, { mint: MINT }, { encoding: 'jsonParsed' }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } };
  let total = 0n;
  for (const a of j.result?.value ?? []) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return total;
}

/** Has the curve migrated? `complete` flipping true IS the migration. */
async function curveComplete(): Promise<{ complete: boolean; rSol: number } | null> {
  const seedTag = new TextEncoder().encode('bonding-curve');
  const found = findProgramAddress([seedTag, base58Decode(MINT as string, 64)], PUMP_PROGRAM);
  if (found === null) return null;
  const acc = (await rpc.getAccounts([found.address]))[0];
  if (acc === null || acc === undefined) return { complete: true, rSol: NaN };
  const b = Buffer.from(acc.dataBase64, 'base64');
  if (b.length < OFF.complete + 1) return null;
  return { complete: b.readUInt8(OFF.complete) === 1, rSol: Number(b.readBigUInt64LE(OFF.rSol)) / 1e9 };
}

const held = await heldAmount();
console.log(`  held ${held.toString()} raw units`);
if (held === 0n) { console.log('REFUSED: we hold none of this token — nothing to exit'); process.exit(1); }

// ---- wait for migration if asked ----
const deadline = Date.now() + WATCH_SECONDS * 1000;
for (;;) {
  const st = await curveComplete();
  if (st === null) { console.log('REFUSED: could not read the bonding curve'); process.exit(1); }
  if (st.complete) { console.log(`  curve is COMPLETE — migrated. Selling into the pool.`); break; }
  if (!WATCH) {
    console.log(`  curve NOT migrated yet (real ${st.rSol.toFixed(2)} SOL). Selling now would book the zero-second control.`);
    console.log('  re-run with --watch to poll until it migrates.');
    process.exit(0);
  }
  if (Date.now() > deadline) { console.log(`  gave up after ${WATCH_SECONDS}s — curve still at ${st.rSol.toFixed(2)} SOL`); process.exit(0); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// ---- GATE: the route must be the AMM, and proceeds must clear the floor ----
const qs = new URLSearchParams({ inputMint: MINT, outputMint: WSOL, amount: held.toString(), slippageBps: String(SLIPPAGE_BPS) });
const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
if (!res.ok) { console.log(`REFUSED: no sell quote (${res.status})`); process.exit(1); }
const jq = (await res.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
if (jq.outAmount === undefined) { console.log('REFUSED: sell quote carried no outAmount'); process.exit(1); }
const labels = (jq.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?');
const proceeds = BigInt(jq.outAmount);
const retBps = 1e4 * (Number(proceeds) / Number(ENTRY_LAMPORTS) - 1);
console.log(`  route ${labels.join(' > ')}`);
console.log(`  proceeds ${(Number(proceeds) / 1e9).toFixed(6)} SOL against an entry of ${(Number(ENTRY_LAMPORTS) / 1e9).toFixed(6)} = ${retBps.toFixed(0)} bps`);
if (labels.some((l) => l === 'Pump.fun') && !labels.some((l) => l === 'Pump.fun Amm')) {
  console.log('REFUSED: the route is still the bonding CURVE, not the AMM — migration has not settled into a pool yet');
  process.exit(1);
}
if (Number(proceeds) < Number(ENTRY_LAMPORTS) * (MIN_PROCEEDS_BPS / 1e4)) {
  console.log(`REFUSED: proceeds below the ${MIN_PROCEEDS_BPS} bps floor of entry — refusing to dump on a possible mis-decode or collapsed pool`);
  process.exit(1);
}
if (!APPLY) { console.log('  dry run — re-run with --apply to sign'); process.exit(0); }

// ---- the signed leg, same policy/binding/effect path as every other trade here ----
const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, {
  inputMint: MINT, outputMint: WSOL, amount: held, slippageBps: SLIPPAGE_BPS, taker: owner,
});
const txRaw = order.transaction;
const decoded = decodeTransaction(txRaw);
const now = Date.now();
const minOut = minOutputOnEffectBasis({ outputMint: WSOL, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
console.log(`  sell quoted ${order.quote.outAmount.toString()}, requiring at least ${minOut.toString()}`);
const intent: TradeIntent = {
  intentId: `curve-exit-${String(now)}`,
  idempotencyKey: `curve-exit-${String(now)}`,
  mint: MINT, side: 'sell', inputMint: MINT, outputMint: WSOL,
  maxInputAmount: held, minOutputAmount: minOut,
  maxTotalFeeLamports: 8_000_000n,
  maxPriorityFeeLamports: 200_000n,
  deadlineUtcMs: now + 60_000,
  strategyVersion: config.strategyVersion,
  riskSnapshotHash: 'curve-exit',
  createdUtcMs: now,
};
const effect = await verifyEffect(rpc, Buffer.from(txRaw).toString('base64'), decoded, intent, owner);
if (!effect.verified) {
  console.log(`  EFFECT REFUSED: ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`);
  process.exit(1);
}
const outcome = signer.sign({ raw: txRaw, intent, effect, nowUtcMs: Date.now() });
if (!outcome.signed) { console.log(`  SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`); process.exit(1); }
const sig = await rpc.send(outcome.transactionBase64);
console.log(`  SENT ${sig}`);
console.log('');
console.log('  position closed. The token account still holds 2,039,280 lamports of rent —');
console.log('  scripts/close-stranded-atas.ts reclaims it.');
