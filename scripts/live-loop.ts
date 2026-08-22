/**
 * Repeatable live round trips, with every round recorded.
 *
 * WHAT THIS CAPITAL CAN AND CANNOT BUY. At the 8.5% win rate MT135 measured over 519 shadow
 * positions, a handful of live rounds says NOTHING about edge — the sample is far too small and
 * anyone claiming otherwise is reading noise. What it does buy, and what no backtest can, is
 * execution truth: do we land, what do we actually pay, does a fix hold, does a refusal fire when
 * it should. So this optimises for LEARNING PER ROUND, not for finding an edge, and it appends
 * every round to `artifacts/live-trades.jsonl` including the ones that refuse before signing.
 *
 * WHAT IT APPLIES FROM THE SESSION, each traceable to a measurement:
 *   MT135 — the incumbent loses because 80% of its tokens collapse (mean age at open 7.9 min,
 *           mean entry cost 386 bps). So candidates are liquid and actively quoted, never fresh.
 *   MT132 — pools split into a ~30 bps and a ~130 bps tier. The round trip is MEASURED on each
 *           candidate before committing, and anything over the bar is refused.
 *   MT134 — an abandoned token account strands 2,039,280 lamports. Accounts are closed every round.
 *   MT136 — the quote is gross and the effect check is net-of-rent when selling into SOL. The two
 *           are put on one basis before comparing, or good sells get refused on an open position.
 *
 * Every per-transaction check is intact: policy, binding and effect-by-simulation through the
 * signer's single entry point. `--apply` is required; without it nothing is signed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { buildSignableOrder } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';
import {
  encodeCloseAccountTransaction, closeAccountIntent, verifyCloseEffect,
} from '../packages/execution/src/close-account.js';
import type { TradeIntent } from '../packages/domain/src/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const NOTIONAL = BigInt(arg('notional') ?? '20000000');
const MAX_COST_BPS = Number(arg('max-cost-bps') ?? '100');
const SLIPPAGE_BPS = Number(arg('slippage-bps') ?? '300');
const ROUNDS = Number(arg('rounds') ?? '1');
const HOLD_S = Number(arg('hold-s') ?? '15');
const SCAN = Number(arg('scan') ?? '5');
/** Stop the whole loop if cumulative loss reaches this, whatever the round count says. */
const STOP_LOSS_LAMPORTS = BigInt(arg('stop-loss') ?? '12000000');

const config = loadConfig(modeFromArgv(process.argv));
const secrets = loadSecrets();
if (secrets.tradingKeypairPath === null || secrets.rpcHttp === null) { console.error('keypair or rpc missing'); process.exit(2); }
const RPC = secrets.rpcHttp;

const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 1, burst: 1 },
]);
const rpc = new ExecutionRpc(limiter, { primary: RPC, fallback: secrets.rpcHttpFallback ?? null });

mkdirSync('artifacts', { recursive: true });
const LOG = 'artifacts/live-trades.jsonl';
const rec = (row: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
};

const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function quoteOut(inMint: string, outMint: string, amount: bigint): Promise<bigint | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: String(SLIPPAGE_BPS) });
  try {
    await sleep(1100);
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string };
    return j.outAmount === undefined ? null : BigInt(j.outAmount);
  } catch { return null; }
}

async function balance(): Promise<bigint> {
  const a = await rpc.getAccounts([owner]);
  return a[0]?.lamports ?? 0n;
}

async function heldTokens(): Promise<{ mint: string; amount: bigint; account: string; program: string }[]> {
  const out: { mint: string; amount: bigint; account: string; program: string }[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { programId }, { encoding: 'jsonParsed' }] }),
    });
    const j = (await res.json()) as { result?: { value?: { pubkey: string; account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }[] } };
    for (const a of j.result?.value ?? []) {
      const info = a.account?.data?.parsed?.info;
      if (info?.mint === undefined || info.tokenAmount?.amount === undefined) continue;
      if (info.mint === WSOL) continue;
      out.push({ mint: info.mint, amount: BigInt(info.tokenAmount.amount), account: a.pubkey, program: programId });
    }
  }
  return out;
}

/** Build, verify by simulation, sign, send. Returns the signature, or null with the reason logged. */
async function leg(round: number, label: string, inputMint: string, outputMint: string, amount: bigint, attempts: number): Promise<string | null> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const order = await buildSignableOrder(limiter, secrets.jupiterApiKey, {
        inputMint, outputMint, amount, slippageBps: SLIPPAGE_BPS, taker: owner,
      });
      const raw = order.transaction;
      const decoded = decodeTransaction(raw);
      const now = Date.now();
      const minOut = minOutputOnEffectBasis({ outputMint, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
      const intent: TradeIntent = {
        intentId: `loop-${label}-${String(now)}`, idempotencyKey: `loop-${label}-${String(now)}`,
        mint: inputMint === WSOL ? outputMint : inputMint,
        side: inputMint === WSOL ? 'buy' : 'sell',
        inputMint, outputMint, maxInputAmount: amount, minOutputAmount: minOut,
        maxTotalFeeLamports: 8_000_000n, maxPriorityFeeLamports: 200_000n,
        deadlineUtcMs: now + 60_000, strategyVersion: config.strategyVersion,
        riskSnapshotHash: 'live-loop', createdUtcMs: now,
      };
      const effect = await verifyEffect(rpc, Buffer.from(raw).toString('base64'), decoded, intent, owner);
      if (!effect.verified) {
        const detail = effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; ');
        console.log(`    ${label} attempt ${i} refused — ${detail}`);
        rec({ round, event: 'effect_refused', label, attempt: i, detail });
        await sleep(5_000);
        continue;
      }
      const outcome = signer.sign({ raw, intent, effect, nowUtcMs: Date.now() });
      if (!outcome.signed) {
        console.log(`    ${label} attempt ${i} signer refused (${outcome.kind}) — ${outcome.detail}`);
        rec({ round, event: 'signer_refused', label, attempt: i, kind: outcome.kind, detail: outcome.detail });
        await sleep(5_000);
        continue;
      }
      const sig = await rpc.send(outcome.transactionBase64);
      console.log(`    ${label} SENT ${sig}`);
      rec({
        round, event: 'sent', label, signature: sig, attempt: i,
        quotedOut: order.quote.outAmount.toString(), minOut: minOut.toString(),
        simLamportDelta: (effect.lamportDelta ?? 0n).toString(),
        simOutputDelta: (effect.outputDelta ?? 0n).toString(),
      });
      return sig;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 140);
      console.log(`    ${label} attempt ${i}: ${msg}`);
      rec({ round, event: 'error', label, attempt: i, message: msg });
      await sleep(8_000);
    }
  }
  return null;
}

/** Close every empty token account. Returns lamports recovered. */
async function sweepRent(round: number): Promise<bigint> {
  let recovered = 0n;
  for (const h of await heldTokens()) {
    if (h.amount !== 0n) continue;
    try {
      const { blockhash } = await rpc.getLatestBlockhash();
      const raw = encodeCloseAccountTransaction({ owner, tokenAccount: h.account, tokenProgram: h.program, recentBlockhash: blockhash });
      const decoded = decodeTransaction(raw);
      const effect = await verifyCloseEffect(rpc, Buffer.from(raw).toString('base64'), decoded, h.account, owner);
      if (!effect.verified) continue;
      const now = Date.now();
      const intent = closeAccountIntent({
        mint: h.mint, nowUtcMs: now, maxTotalFeeLamports: 100_000n,
        strategyVersion: config.strategyVersion, riskSnapshotHash: 'live-loop',
      });
      const outcome = signer.sign({ raw, intent, effect, nowUtcMs: now });
      if (!outcome.signed) continue;
      const sig = await rpc.send(outcome.transactionBase64);
      recovered += effect.lamportDelta ?? 0n;
      console.log(`    rent recovered ${(effect.lamportDelta ?? 0n).toString()} — ${sig}`);
      rec({ round, event: 'rent_recovered', signature: sig, lamports: (effect.lamportDelta ?? 0n).toString() });
    } catch { /* a failed sweep is not a failed trade; the next round retries it */ }
  }
  return recovered;
}

const { DatabaseSync } = await import('node:sqlite');
const runStart = await balance();
console.log(`LIVE LOOP   owner ${owner}`);
console.log(`  rounds ${ROUNDS}   notional ${(Number(NOTIONAL) / 1e9).toFixed(4)} SOL   hold ${HOLD_S}s   cost bar ${MAX_COST_BPS} bps   ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  starting balance ${(Number(runStart) / 1e9).toFixed(9)} SOL   loop stops at -${(Number(STOP_LOSS_LAMPORTS) / 1e9).toFixed(4)} SOL`);
rec({ event: 'loop_start', owner, rounds: ROUNDS, notional: NOTIONAL.toString(), startLamports: runStart.toString() });

for (let round = 1; round <= ROUNDS; round += 1) {
  const before = await balance();
  if (runStart - before >= STOP_LOSS_LAMPORTS) {
    console.log(`\nSTOP LOSS: down ${(Number(runStart - before) / 1e9).toFixed(6)} SOL. Halting.`);
    rec({ round, event: 'stop_loss_halt', downLamports: (runStart - before).toString() });
    break;
  }
  console.log(`\n=== ROUND ${round} of ${ROUNDS} ===  balance ${(Number(before) / 1e9).toFixed(9)} SOL`);

  const db = new DatabaseSync('data/runtime.db', { readOnly: true });
  const mints = (db.prepare(
    `SELECT mint FROM quotes WHERE side='buy' AND out_amount IS NOT NULL
      GROUP BY mint ORDER BY MAX(requested_utc_ms) DESC LIMIT ?`).all(SCAN) as { mint: string }[]).map((r) => r.mint);
  db.close();

  let best: { mint: string; costBps: number } | null = null;
  for (const mint of mints) {
    const out = await quoteOut(WSOL, mint, NOTIONAL);
    if (out === null || out <= 0n) continue;
    const back = await quoteOut(mint, WSOL, out);
    if (back === null || back <= 0n) continue;
    const costBps = 1e4 * (1 - Number(back) / Number(NOTIONAL));
    if (!Number.isFinite(costBps)) continue;
    console.log(`    ${mint.slice(0, 10)}  round trip ${costBps.toFixed(0).padStart(6)} bps`);
    if (costBps >= 0 && costBps <= MAX_COST_BPS && (best === null || costBps < best.costBps)) best = { mint, costBps };
  }
  if (best === null) {
    console.log(`    no candidate under ${MAX_COST_BPS} bps — skipping this round, which is the bar working`);
    rec({ round, event: 'no_candidate', scanned: mints.length, barBps: MAX_COST_BPS });
    continue;
  }
  console.log(`    CHOSEN ${best.mint.slice(0, 12)} at ${best.costBps.toFixed(0)} bps`);
  rec({ round, event: 'chosen', mint: best.mint, measuredRoundTripBps: Math.round(best.costBps) });
  if (!APPLY) continue;

  await sleep(15_000);
  const buySig = await leg(round, 'buy ', WSOL, best.mint, NOTIONAL, 3);
  if (buySig === null) { rec({ round, event: 'buy_failed' }); continue; }

  await sleep(HOLD_S * 1000);

  const held = (await heldTokens()).find((h) => h.mint === best!.mint && h.amount > 0n);
  if (held === undefined) { console.log('    nothing held after buy — the fill did not land'); rec({ round, event: 'no_fill' }); continue; }
  const sellSig = await leg(round, 'sell', best.mint, WSOL, held.amount, 8);
  if (sellSig === null) { console.log('    COULD NOT SELL — position open, run exit-position.ts'); rec({ round, event: 'sell_failed', mint: best.mint }); break; }

  await sleep(10_000);
  const recovered = await sweepRent(round);
  await sleep(6_000);
  const after = await balance();
  const pnl = after - before;
  console.log(`    ROUND ${round} PnL ${(Number(pnl) / 1e9).toFixed(9)} SOL  (${(1e4 * Number(pnl) / Number(NOTIONAL)).toFixed(0)} bps)`);
  rec({
    round, event: 'round_complete', mint: best.mint,
    beforeLamports: before.toString(), afterLamports: after.toString(),
    pnlLamports: pnl.toString(), pnlBps: Math.round(1e4 * Number(pnl) / Number(NOTIONAL)),
    rentRecovered: recovered.toString(), buySig, sellSig,
    measuredRoundTripBps: Math.round(best.costBps),
  });
}

const runEnd = await balance();
const total = runEnd - runStart;
console.log('');
console.log('LOOP COMPLETE');
console.log(`  start ${(Number(runStart) / 1e9).toFixed(9)} SOL`);
console.log(`  end   ${(Number(runEnd) / 1e9).toFixed(9)} SOL`);
console.log(`  total ${(Number(total) / 1e9).toFixed(9)} SOL`);
console.log(`  every round is in ${LOG}`);
rec({ event: 'loop_end', startLamports: runStart.toString(), endLamports: runEnd.toString(), totalLamports: total.toString() });
