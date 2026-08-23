/**
 * Buy or sell one token, once, through the signer's own policy and effect path.
 *
 * This is a TOOL, not a strategy, and the distinction is the honest part. Every mechanism this
 * programme measured came back negative once it was measured correctly - the bonding-curve
 * graduation route, the copy-trading cohorts, cross-venue arbitrage, and MT171 which looked
 * fundable until its look-ahead was found. Nothing here predicts that any particular trade will
 * make money, and a file that pretended otherwise would be lying.
 *
 * What it does do is make a single trade EXECUTABLE SAFELY, so that a decision to take a position
 * is a decision about the position rather than a gamble on the plumbing. The failure modes it is
 * built against are the ones that actually cost money in practice, and each is a refusal rather
 * than a warning:
 *
 *   PAYING FAR ABOVE THE FRICTIONLESS PRICE. The quote is compared against the pool's own implied
 *   price and rejected past a ceiling, so an illiquid or half-dead pool cannot fill us at a number
 *   nobody would choose. MT182 found venues quoting spreads of millions of basis points whose round
 *   trips returned minus the entire notional; that is what this gate exists for.
 *
 *   SPENDING MORE THAN INTENDED. A hard notional cap is enforced against the ACTUAL input amount in
 *   the built transaction, not against what we asked for.
 *
 *   SIGNING SOMETHING WE DID NOT VERIFY. The transaction is decoded and simulated, and the effect -
 *   the real balance change on our own account - has to match the intent before the signer sees it.
 *   An unverified effect is a refusal.
 *
 *   FORGETTING THE RENT. Every new token account locks 0.00204 SOL, which at small size is a large
 *   fraction of the position. It is reported explicitly because it is invisible in a quote and is
 *   recoverable only by closing the account afterwards.
 *
 * `--apply` is required to sign. Without it nothing is signed, sent, or spent.
 */
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { buildSignableOrder } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';
import type { TradeIntent } from '../packages/domain/src/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const ATA_RENT_LAMPORTS = 2_039_280;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const MINT = arg('mint');
const SIDE = (arg('side') ?? 'buy').toLowerCase();
const SOL = Number(arg('sol') ?? '0.01');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '300');
/** Refuse a fill worse than this against the pool's own frictionless price. */
const MAX_COST_BPS = Number(arg('max-cost-bps') ?? '400');
/** Hard ceiling on what may be spent, checked against the built transaction. */
const MAX_SOL = Number(arg('max-sol') ?? '0.02');

if (MINT === null) { console.log('need --mint=<mint> [--side=buy|sell] [--sol=0.01] [--apply]'); process.exit(2); }
if (SIDE !== 'buy' && SIDE !== 'sell') { console.log('--side must be buy or sell'); process.exit(2); }
if (SIDE === 'buy' && SOL > MAX_SOL) { console.log(`REFUSED: --sol ${SOL} exceeds --max-sol ${MAX_SOL}`); process.exit(1); }

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

const acct = (await rpc.getAccounts([owner]))[0];
const balance = Number(acct?.lamports ?? 0n);
console.log(`SWAP   owner ${owner}`);
console.log(`  balance ${(balance / 1e9).toFixed(9)} SOL`);
console.log(`  ${SIDE.toUpperCase()} ${MINT}   ${APPLY ? 'LIVE' : 'DRY RUN'}`);

/** How much of the token do we hold? Read from chain, never assumed. */
async function heldAmount(): Promise<bigint> {
  const res = await fetch(secrets.rpcHttp ?? '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: MINT }, { encoding: 'jsonParsed' }] }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } };
  let total = 0n;
  for (const a of j.result?.value ?? []) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return total;
}

const inputMint = SIDE === 'buy' ? WSOL : MINT;
const outputMint = SIDE === 'buy' ? MINT : WSOL;
let amount: bigint;
if (SIDE === 'buy') {
  amount = BigInt(Math.floor(SOL * 1e9));
  const need = Number(amount) + ATA_RENT_LAMPORTS + 200_000;
  if (balance < need) { console.log(`REFUSED: need ~${(need / 1e9).toFixed(6)} SOL including rent and fees, have ${(balance / 1e9).toFixed(6)}`); process.exit(1); }
} else {
  amount = await heldAmount();
  console.log(`  held ${amount.toString()} raw units`);
  if (amount === 0n) { console.log('REFUSED: we hold none of this token'); process.exit(1); }
}

// ---- quote, and check it against the pool's own frictionless price ----
const qs = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(SLIPPAGE_BPS) });
const res = await fetch(`https://api.jup.ag/swap/v1/quote?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
if (!res.ok) { console.log(`REFUSED: no quote (${res.status})`); process.exit(1); }
const jq = (await res.json()) as { outAmount?: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[] };
if (jq.outAmount === undefined) { console.log('REFUSED: quote carried no outAmount'); process.exit(1); }
const labels = (jq.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?');
const impactBps = Math.abs(Number(jq.priceImpactPct ?? '0')) * 1e4;
console.log(`  route ${labels.join(' > ')}`);
console.log(`  quote out ${jq.outAmount}   price impact ${impactBps.toFixed(0)} bps`);
if (labels.length === 0) { console.log('REFUSED: empty route'); process.exit(1); }
if (impactBps > MAX_COST_BPS) { console.log(`REFUSED: price impact ${impactBps.toFixed(0)} bps exceeds the ${MAX_COST_BPS} bps ceiling`); process.exit(1); }
if (SIDE === 'buy') {
  console.log(`  NOTE: a new token account locks ${(ATA_RENT_LAMPORTS / 1e9).toFixed(6)} SOL of rent`);
  console.log(`        = ${((1e4 * ATA_RENT_LAMPORTS) / Number(amount)).toFixed(0)} bps of this position, recoverable only by closing it afterwards`);
}
if (!APPLY) { console.log('  dry run — re-run with --apply to sign'); process.exit(0); }

// ---- the signed leg: policy, binding and effect all run before anything is signed ----
const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, { inputMint, outputMint, amount, slippageBps: SLIPPAGE_BPS, taker: owner });
const txRaw = order.transaction;
const decoded = decodeTransaction(txRaw);
const now = Date.now();
const minOut = minOutputOnEffectBasis({ outputMint, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
/** The cap is enforced against what the transaction actually spends, not what we asked for. */
if (SIDE === 'buy' && Number(amount) > MAX_SOL * 1e9) { console.log('REFUSED: built order exceeds the notional cap'); process.exit(1); }
console.log(`  quoted ${order.quote.outAmount.toString()}, requiring at least ${minOut.toString()}`);
const intent: TradeIntent = {
  intentId: `swap-${String(now)}`,
  idempotencyKey: `swap-${String(now)}`,
  mint: MINT, side: SIDE as 'buy' | 'sell', inputMint, outputMint,
  maxInputAmount: amount, minOutputAmount: minOut,
  maxTotalFeeLamports: 8_000_000n,
  maxPriorityFeeLamports: 200_000n,
  deadlineUtcMs: now + 60_000,
  strategyVersion: config.strategyVersion,
  riskSnapshotHash: 'manual-swap',
  createdUtcMs: now,
};
const effect = await verifyEffect(rpc, Buffer.from(txRaw).toString('base64'), decoded, intent, owner);
if (!effect.verified) { console.log(`  EFFECT REFUSED: ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`); process.exit(1); }
const outcome = signer.sign({ raw: txRaw, intent, effect, nowUtcMs: Date.now() });
if (!outcome.signed) { console.log(`  SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`); process.exit(1); }
const sig = await rpc.send(outcome.transactionBase64);
console.log(`  SENT ${sig}`);
console.log(`  https://solscan.io/tx/${sig}`);
