/**
 * Enter an MT171 position: buy a bonding curve near graduation, to be held THROUGH migration.
 *
 * MT171 replicated on three independent blocks - one strictly later than any corpus a model was
 * fitted on. Buying a curve near graduation and selling into the pool five seconds after it opens
 * books a median of +1,581 to +2,224 bps at 72.7% to 78.2% positive, with growth surviving removal
 * of its best fifty outcomes on every corpus. It works because a curve holder's tokens are ordinary
 * SPL tokens that carry across migration untouched: at the instant the pool opens they are ALREADY
 * HOLDING, ahead of every sniper, with no transaction slot to win. MT169 proved that seat cannot be
 * reached by racing, because the first two trades share one transaction 59.9% of the time.
 *
 * WHY THIS IS NOT one-shot-trade WITH A DIFFERENT MINT. That script refuses anything whose ROUND
 * TRIP exceeds 150 bps, and a curve round trip is structurally about 270 - the venue charges 1% a
 * leg. But this strategy never round-trips on the curve. It pays ONE curve leg on the way in and
 * sells on the AMM after migration, so the round-trip bar measures a trade nobody is proposing and
 * refuses a good entry for the wrong reason. The gates here are the ones that actually bind.
 *
 * EVERY GATE IS A HARD REFUSAL AND EACH EXISTS BECAUSE SOMETHING SPECIFIC CAN GO WRONG:
 *
 *   THE CURVE ACCOUNT MUST DECODE AGAINST THE PROGRAM CONSTANT. virtual_sol minus real_sol must
 *   equal 30.00 SOL, measured at p10, p50 and p90 alike across the whole corpus in MT170. A wrong
 *   offset cannot reproduce it, and a mis-decoded reserve would size a position at a price nobody
 *   quoted.
 *
 *   THE CURVE MUST NOT BE COMPLETE. A migrated curve zeroes its account, which reads as 0.00 SOL of
 *   progress - indistinguishable from a fresh launch unless `complete` is checked. Buying then is
 *   buying the post-migration pool at the top of the pump we were trying to sell into.
 *
 *   THE ROUTE MUST BE THE CURVE, NOT THE AMM. The aggregator labels these differently - "Pump.fun"
 *   is the bonding curve and "Pump.fun Amm" is post-migration. If it routes to the AMM the token has
 *   already graduated and this is the wrong trade entirely.
 *
 *   PROGRESS MUST BE INSIDE THE BAND. Too early and graduation is a coin flip: MT170 measured
 *   P(graduate) at 32.1% from 30 SOL against 96.6% from 80. Too late and there is nothing left.
 *
 * WHAT THIS DOES NOT DO. It does not sell. The position is opened to be held through migration, and
 * the exit is a separate act with its own timing. Nothing here closes anything.
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
const GRAD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const MINT = arg('mint');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '300');
/** MT170: P(graduate) is 74.1% from 60 SOL and 96.6% from 80. Below this the entry is a coin flip. */
const MIN_PROGRESS_PCT = Number(arg('min-progress') ?? '70');
/** One curve leg is 1% venue fee plus impact. Anything far above that is not the trade we modelled. */
const MAX_ENTRY_BPS = Number(arg('max-entry-bps') ?? '250');

if (MINT === null) { console.log('need --mint=<mint>'); process.exit(2); }

const mode = modeFromArgv(process.argv);
const config = await loadConfig(mode);
const secrets = await loadSecrets();
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 2, burst: 2 },
]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });
if (secrets.tradingKeypairPath === null) { console.log('REFUSED: no trading keypair configured'); process.exit(1); }
const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;

console.log(`CURVE ENTRY   owner ${owner}`);
console.log(`  mint ${MINT}`);
console.log(`  notional ${(Number(NOTIONAL) / 1e9).toFixed(4)} SOL   ${APPLY ? 'LIVE' : 'DRY RUN'}`);

const bal = await rpc.getAccounts([owner]);
console.log(`  balance ${(Number(bal[0]?.lamports ?? 0n) / 1e9).toFixed(9)} SOL`);
console.log('');

// ---- GATE 1: the curve account must exist, decode against the constant, and be incomplete ----
const seedTag = new TextEncoder().encode('bonding-curve');
const found = findProgramAddress([seedTag, base58Decode(MINT, 64)], PUMP_PROGRAM);
if (found === null) { console.log('REFUSED: could not derive the bonding-curve address'); process.exit(1); }
const curveAcc = (await rpc.getAccounts([found.address]))[0];
if (curveAcc === null || curveAcc === undefined) { console.log(`REFUSED: no bonding-curve account at ${found.address} — never launched, or migrated and closed`); process.exit(1); }
const acc = Buffer.from(curveAcc.dataBase64, 'base64');
if (acc.length < OFF.complete + 1) { console.log(`REFUSED: curve account too short (${acc.length}B)`); process.exit(1); }
const rSol = Number(acc.readBigUInt64LE(OFF.rSol)) / 1e9;
const vSol = Number(acc.readBigUInt64LE(OFF.vSol)) / 1e9;
const complete = acc.readUInt8(OFF.complete) === 1;
const progress = 100 * rSol / GRAD_SOL;
console.log(`  curve ${found.address}`);
console.log(`  real ${rSol.toFixed(2)} SOL   virtual ${vSol.toFixed(2)} SOL   progress ${progress.toFixed(1)}%   complete ${String(complete)}`);
if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) > 0.01) {
  console.log(`REFUSED: virtual minus real is ${(vSol - rSol).toFixed(3)}, not ${INITIAL_VIRTUAL_SOL}.00 — the decode does not match the program constant`);
  process.exit(1);
}
if (complete) { console.log('REFUSED: the curve is COMPLETE — this token has already migrated'); process.exit(1); }
if (progress < MIN_PROGRESS_PCT) {
  console.log(`REFUSED: progress ${progress.toFixed(1)}% is below the ${MIN_PROGRESS_PCT}% band; MT170 measured P(graduate) at only 32.1% from 30 SOL`);
  process.exit(1);
}

// ---- GATE 2: the aggregator must route to the CURVE, and the entry cost must be sane ----
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
const qs = new URLSearchParams({ inputMint: WSOL, outputMint: MINT, amount: NOTIONAL.toString(), slippageBps: String(SLIPPAGE_BPS) });
const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
if (!res.ok) { console.log(`REFUSED: no quote (${res.status})`); process.exit(1); }
const jq = (await res.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
if (jq.outAmount === undefined) { console.log('REFUSED: quote carried no outAmount'); process.exit(1); }
const labels = (jq.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?');
console.log(`  route ${labels.join(' > ')}`);
if (!labels.some((l) => l === 'Pump.fun')) {
  console.log(`REFUSED: the route is not the bonding curve. "Pump.fun Amm" means already migrated; anything else is a venue this strategy was not measured on`);
  process.exit(1);
}
/** Entry cost against the curve's own arithmetic: what the reserves say we should receive. */
const kCurve = vSol * (Number(acc.readBigUInt64LE(8)) / 1e6);
const fairTokens = (Number(acc.readBigUInt64LE(8)) / 1e6) - kCurve / (vSol + Number(NOTIONAL) / 1e9);
const gotTokens = Number(jq.outAmount) / 1e6;
const entryBps = fairTokens > 0 ? 1e4 * (1 - gotTokens / fairTokens) : NaN;
console.log(`  quote ${gotTokens.toFixed(0)} tokens against a frictionless ${fairTokens.toFixed(0)} — entry cost ${Number.isFinite(entryBps) ? entryBps.toFixed(0) : '?'} bps`);
if (!Number.isFinite(entryBps) || entryBps > MAX_ENTRY_BPS) {
  console.log(`REFUSED: entry cost above the ${MAX_ENTRY_BPS} bps bar`);
  process.exit(1);
}

console.log('');
console.log('  ALL GATES PASS');
console.log(`  this position is opened to be HELD THROUGH MIGRATION. MT171 sells 5s after the pool opens.`);
if (!APPLY) { console.log('  dry run — re-run with --apply to sign'); process.exit(0); }

// ---- the signed leg, through the same policy/binding/effect path as every other trade here ----
console.log('');
console.log('cooling down before the order request so the rate budget is clear');
await new Promise((r) => setTimeout(r, 20_000));

const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, {
  inputMint: WSOL, outputMint: MINT, amount: NOTIONAL, slippageBps: SLIPPAGE_BPS, taker: owner,
});
const txRaw = order.transaction;
const rawB64 = Buffer.from(txRaw).toString('base64');
const decoded = decodeTransaction(txRaw);
const now = Date.now();
const minOut = minOutputOnEffectBasis({ outputMint: MINT, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
console.log(`  buy quoted ${order.quote.outAmount.toString()}, requiring at least ${minOut.toString()}`);
const intent: TradeIntent = {
  intentId: `curve-entry-${String(now)}`,
  idempotencyKey: `curve-entry-${String(now)}`,
  mint: MINT, side: 'buy', inputMint: WSOL, outputMint: MINT,
  maxInputAmount: NOTIONAL, minOutputAmount: minOut,
  /** MT136/MT134: a buy moves three token-account rents, and rent is refundable, not a fee. */
  maxTotalFeeLamports: 8_000_000n,
  maxPriorityFeeLamports: 200_000n,
  deadlineUtcMs: now + 60_000,
  strategyVersion: config.strategyVersion,
  riskSnapshotHash: 'curve-entry',
  createdUtcMs: now,
};
const effect = await verifyEffect(rpc, rawB64, decoded, intent, owner);
if (!effect.verified) {
  console.log(`  EFFECT REFUSED: ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`);
  process.exit(1);
}
const outcome = signer.sign({ raw: txRaw, intent, effect, nowUtcMs: Date.now() });
if (!outcome.signed) {
  console.log(`  SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`);
  process.exit(1);
}
const sig = await rpc.send(outcome.transactionBase64);
console.log(`  SENT ${sig}`);
console.log('');
console.log('  position open. It is meant to be held through migration; watch the curve with');
console.log('  scripts/curve-live-state.ts and exit once the pool opens.');
