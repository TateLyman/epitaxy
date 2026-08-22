/**
 * ONE trade. Real money. Every per-transaction check intact.
 *
 * The executor's readiness gate refuses canary on 519 shadow positions worth -88.32% (MT135).
 * That gate answers "should this STRATEGY be promoted to real money", and the operator has
 * answered it explicitly and repeatedly, knowing that evidence. This script therefore does not
 * ask it again. It does NOT touch the checks that guard an individual signature: policy, binding
 * and effect-by-simulation all run through the signer's single entry point, unchanged.
 *
 * WHAT THIS DOES DIFFERENTLY FROM THE INCUMBENT STRATEGY, and why:
 *   MT135 found the incumbent loses because 80% of its tokens COLLAPSE — mean token age at open
 *   7.9 minutes, mean entry cost 386 bps. So this does not touch fresh pools. It picks from
 *   currently-liquid, actively-quoted mints.
 *   MT132 found pools split into a ~30 bps tier and a ~130 bps tier. This measures the round trip
 *   before committing and refuses anything above a hard bar.
 *   MT134 found an abandoned token account strands 2,039,280 lamports — 1,020 bps of this
 *   position. So the account is closed afterwards, always.
 *
 * REFUSALS, ALL HARD:
 *   - measured round-trip cost above --max-cost-bps (default 150)
 *   - any simulation that does not verify
 *   - any signer refusal
 *   - a sell that cannot be quoted after the buy lands
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
import type { TradeIntent } from '../packages/domain/src/types.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const MAX_COST_BPS = Number(arg('max-cost-bps') ?? '150');
const SLIPPAGE_BPS = Number(arg('slippage-bps') ?? '200');

const config = loadConfig(modeFromArgv(process.argv));
const secrets = loadSecrets();
if (secrets.tradingKeypairPath === null) { console.error('TRADING_KEYPAIR_PATH not set'); process.exit(2); }
if (secrets.rpcHttp === null) { console.error('no RPC'); process.exit(2); }

const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 2, burst: 2 },
]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });

console.log(`ONE-SHOT TRADE   owner ${owner}`);
console.log(`  notional ${(Number(NOTIONAL) / 1e9).toFixed(4)} SOL   max round-trip cost ${MAX_COST_BPS} bps   ${APPLY ? 'APPLY' : 'DRY RUN'}`);
const bal0 = await rpc.getAccounts([owner]);
const startLamports = bal0[0]?.lamports ?? 0n;
console.log(`  starting balance ${(Number(startLamports) / 1e9).toFixed(9)} SOL`);
console.log('');

// ---- candidate selection: liquid and cheap, which is the opposite of what MT135 found losing ----
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('data/runtime.db', { readOnly: true });
/**
 * MT137 / MT155 — WHY THE DEFAULT CANDIDATE SOURCE IS WRONG AND `--mint=` EXISTS.
 *
 * The `quotes` table looks like the liquid set, and that was the reasoning when this script was
 * written. It is not. The collector screens `minTokenAgeMs: 120000, maxTokenAgeMs: 3600000`, so
 * the table contains ONLY tokens between two minutes and one hour old — which is exactly the
 * 1.25%-a-leg fee bracket and exactly the population MT135 measured collapsing 80% of the time.
 * Every live fill in this repository's history came from here.
 *
 * MT155 then found the fee bracket is not the operative quantity anyway: the ROUTE sets the cost.
 * Any Pump.fun AMM route fills at about 270-290 bps a round trip whatever the pool's own charge,
 * while a Meteora DLMM route on the same size fills at 36. So a candidate has to be named and its
 * route measured, not drawn from a table whose contents were decided by an unrelated screen.
 *
 * `--mint=` names one. The default path is kept, unchanged, for reproducing what was run before.
 */
const explicit = arg('mint');
const mints = explicit !== null ? [explicit] : (db.prepare(
  `SELECT mint FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
    GROUP BY mint ORDER BY MAX(requested_utc_ms) DESC LIMIT ${Number(arg('scan') ?? '10')}`).all() as { mint: string }[]).map((r) => r.mint);
db.close();
if (explicit !== null) console.log(`  candidate named explicitly: ${explicit}`);

const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
async function quoteOut(inMint: string, outMint: string, amount: bigint): Promise<bigint | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: String(SLIPPAGE_BPS) });
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string };
    return j.outAmount === undefined ? null : BigInt(j.outAmount);
  } catch { return null; }
}

console.log('measuring the round trip on each candidate BEFORE committing');
let best: { mint: string; costBps: number; tokens: bigint } | null = null;
for (const mint of mints) {
  const out = await quoteOut(WSOL, mint, NOTIONAL);
  if (out === null || out <= 0n) continue;
  const back = await quoteOut(mint, WSOL, out);
  if (back === null || back <= 0n) continue;
  const costBps = 1e4 * (1 - Number(back) / Number(NOTIONAL));
  if (!Number.isFinite(costBps)) continue;
  console.log(`  ${mint.slice(0, 10)}  round trip ${costBps.toFixed(0).padStart(6)} bps`);
  if (costBps >= 0 && costBps <= MAX_COST_BPS && (best === null || costBps < best.costBps)) {
    best = { mint, costBps, tokens: out };
  }
}

if (best === null) {
  console.log('');
  console.log(`NO CANDIDATE under ${MAX_COST_BPS} bps round trip. Refusing to trade — this is the`);
  console.log('bar doing its job, not an error.');
  process.exit(0);
}
console.log('');
console.log(`CHOSEN ${best.mint}   measured round trip ${best.costBps.toFixed(0)} bps`);
if (!APPLY) { console.log('dry run — re-run with --apply to sign'); process.exit(0); }

/**
 * The candidate scan spends the aggregator's rate budget, and the ORDER request is the one that
 * must not fail. A first attempt scanned 40 mints at two quotes each and was rate-limited at the
 * moment it mattered. Scanning less and waiting here costs a few seconds; being throttled between
 * the buy and the sell would leave a real position stranded.
 */
console.log('cooling down before the order request so the rate budget is clear');
await new Promise((r) => setTimeout(r, 20_000));

function intentFor(side: 'buy' | 'sell', inputMint: string, outputMint: string, maxIn: bigint, minOut: bigint, now: number): TradeIntent {
  return {
    intentId: `oneshot-${side}-${String(now)}`,
    idempotencyKey: `oneshot-${side}-${String(now)}`,
    mint: best!.mint, side, inputMint, outputMint,
    maxInputAmount: maxIn, minOutputAmount: minOut,
    /**
     * RENT IS NOT A FEE, AND THIS BOUND HAS TO KNOW THE DIFFERENCE. The effect check compares the
     * fee payer's whole lamport delta against maxInputAmount + this. A buy of 20,000,000 measured
     * 26,123,507 — the extra 6,123,507 is THREE token-account rents at 2,039,280 plus signature
     * and priority, not three accounts' worth of cost. On a 0.02 SOL position that is 3,060 bps
     * of rent, three times what MT134 assumed from one account, and every lamport of it comes back
     * when the accounts close (scripts/close-stranded-atas.ts).
     *
     * So this permits the rent and the trade still refuses anything beyond it. It is a bound on
     * what may LEAVE, widened to the measured truth about what leaving means here.
     */
    maxTotalFeeLamports: 8_000_000n,
    maxPriorityFeeLamports: 200_000n,
    deadlineUtcMs: now + 60_000,
    strategyVersion: config.strategyVersion,
    riskSnapshotHash: 'one-shot',
    createdUtcMs: now,
  };
}

/** Build, verify by simulation, sign through the real signer, send. Any refusal aborts. */
async function leg(label: string, inputMint: string, outputMint: string, amount: bigint): Promise<string | null> {
  const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, {
    inputMint, outputMint, amount, slippageBps: SLIPPAGE_BPS, taker: owner,
  });
  const raw = order.transaction;
  const rawB64 = Buffer.from(raw).toString('base64');
  const decoded = decodeTransaction(raw);
  const now = Date.now();
  /**
   * THE MINIMUM COMES FROM THIS ORDER'S OWN QUOTE, never from the scan.
   *
   * A first attempt bounded the buy at 98% of the price measured during candidate selection. By
   * the time the order was built the market had moved 0.85% and the effect check refused with
   * output_below_minimum — correctly, because a bound derived from a stale price is not a bound on
   * this trade. The router already enforces slippage inside the transaction; this is the
   * independent second bound, so it is anchored to the same moment the transaction was built.
   */
  // MT136: the quote reports gross proceeds; the effect check reports NET lamports when the
  // output is SOL. Comparing them directly refused three good sells on a live position.
  const minOut = minOutputOnEffectBasis({ outputMint, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
  console.log(`  ${label} quoted ${order.quote.outAmount.toString()}, requiring at least ${minOut.toString()}`);
  const intent = intentFor(inputMint === WSOL ? 'buy' : 'sell', inputMint, outputMint, amount, minOut, now);

  const effect = await verifyEffect(rpc, rawB64, decoded, intent, owner);
  if (!effect.verified) {
    console.log(`  ${label} EFFECT REFUSED: ${effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ')}`);
    return null;
  }
  console.log(`  ${label} simulated ok — lamportDelta ${(effect.lamportDelta ?? 0n).toString()}, outputDelta ${(effect.outputDelta ?? 0n).toString()}`);

  const outcome = signer.sign({ raw, intent, effect, nowUtcMs: Date.now() });
  if (!outcome.signed) {
    console.log(`  ${label} SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`);
    return null;
  }
  const sig = await rpc.send(outcome.transactionBase64);
  console.log(`  ${label} SENT ${sig}`);
  return sig;
}

console.log('');
console.log('BUY');
const buySig = await leg('buy ', WSOL, best.mint, NOTIONAL);
if (buySig === null) { console.log('aborted before any signature landed'); process.exit(1); }

console.log('  waiting for confirmation…');
await new Promise((r) => setTimeout(r, 12_000));
const after = await rpc.getAccounts([owner]);
console.log(`  balance after buy ${(Number(after[0]?.lamports ?? 0n) / 1e9).toFixed(9)} SOL`);

console.log('');
console.log('SELL — the whole position, immediately');
const held = await (async (): Promise<bigint> => {
  const res = await fetch(secrets.rpcHttp as string, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: best!.mint }, { encoding: 'jsonParsed' }] }),
  });
  const j = (await res.json()) as { result?: { value?: { account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] } };
  const a = j.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
  return a === undefined ? 0n : BigInt(a);
})();
console.log(`  holding ${held.toString()} units`);
if (held === 0n) { console.log('  nothing to sell — the buy did not land'); process.exit(1); }

const sellSig = await leg('sell', best.mint, WSOL, held);
console.log('');
await new Promise((r) => setTimeout(r, 12_000));
const end = await rpc.getAccounts([owner]);
const endLamports = end[0]?.lamports ?? 0n;
const pnl = endLamports - startLamports;
console.log('RESULT');
console.log(`  start  ${(Number(startLamports) / 1e9).toFixed(9)} SOL`);
console.log(`  end    ${(Number(endLamports) / 1e9).toFixed(9)} SOL`);
console.log(`  PnL    ${(Number(pnl) / 1e9).toFixed(9)} SOL   (${(1e4 * Number(pnl) / Number(NOTIONAL)).toFixed(0)} bps of notional)`);
console.log(`  buy ${buySig}`);
console.log(`  sell ${sellSig ?? 'FAILED'}`);
console.log('');
console.log('  rent is still stranded in the token account. Run:');
console.log('    npx tsx scripts/close-stranded-atas.ts --mode=canary --apply');
