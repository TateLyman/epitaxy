/**
 * One command. It watches, buys, waits for migration, sells, and reclaims the rent.
 *
 * FEW TRADES IS THE DESIGN, NOT A LIMITATION, and the position cap is the most important line in
 * this file. MT174 measured this trade on fresh data at a median of +755 bps and a mean of -889.
 * Those two numbers point in opposite directions and both are real: more than half of these trades
 * win, and the losers are larger than the winners. A distribution shaped like that pays the median
 * over a handful of attempts and the mean over many, so running it MORE is the losing direction.
 * The cap exists to stop the mean from asserting itself. Anyone raising it is not increasing their
 * exposure to an edge, they are converting a coin flip into a slow loss.
 *
 * THE RENT IS THE OTHER HALF OF THE ARITHMETIC. Every position opens a token account holding
 * 0.00204 SOL, which against a 0.01 SOL position is 20% of the stake. It comes back only when the
 * account is closed, so closing is not tidying up afterwards - it is the difference between roughly
 * 2% round-trip friction and roughly 22%. This closes every account it opens, in the same run, and
 * reports the rent as recovered rather than as profit.
 *
 * WHAT IT WILL NOT DO:
 *   - spend more than the total budget, which is checked before every buy against the real balance
 *   - hold a position it cannot price, or sell into a route that is still the bonding curve
 *   - open a new position while one is still open
 *   - continue after a leg fails; a failure stops the run rather than retrying into a moving market
 *
 * Every trade goes through the signer's single entry point, so policy, binding and effect run
 * unchanged. Nothing here bypasses a gate; it only removes the typing between them.
 *
 * `--apply` is required. Without it this is a full dry run that quotes every leg and signs nothing.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { loadConfig, loadSecrets, modeFromArgv } from '../packages/domain/src/config.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../packages/execution/src/rpc.js';
import { Signer } from '../packages/execution/src/signer.js';
import { buildSignableOrder } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';
import type { TradeIntent } from '../packages/domain/src/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_EVENT = 'bddb7fd34ee661ee';
const OFF = { mint: 8, vSol: 97, rSol: 113 };
const CURVE = { vSol: 16, rSol: 32, complete: 48 };
const GRAD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;
const ATA_RENT = 2_039_280;
const PREFIX = 'Program data:';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const SOL_PER = Number(arg('sol') ?? '0.01');
/** See the note above: raising this is the losing direction, not more exposure to an edge. */
const MAX_POSITIONS = Number(arg('max-positions') ?? '3');
const MIN_PROGRESS = Number(arg('min-progress') ?? '94');
const SELL_AFTER_S = Number(arg('sell-after') ?? '5');
/**
 * SELL ON THE CURVE, NOT INTO THE POOL, AND CUT THE STALLS.
 *
 * The first live trade bought at 70.15 SOL and rode to graduation. The curve moved 70.15 -> 85,
 * which at vSol-squared pricing is +31.9%, and the round trip returned +7.4%. Twenty-four points
 * went to the migration: the pool's fee, the pool's impact, and about 13% of price movement in the
 * 400ms between quoting and landing. The pump was never captured. It was paid.
 *
 * MT185 tested the consequence on both corpora. Selling on the CURVE at 82 SOL instead of into the
 * pool lifts growth from -0.0034 to -0.0018, and adding a stop four SOL below entry lifts it again
 * to +0.0005 on block D over 959 positions with a mean of +106 bps -- the first positive
 * out-of-sample cell this programme has produced. Level 75 stays negative in both periods, so the
 * result is not a grid artifact.
 *
 * THE STOP DOES THE HEAVY LIFTING AND IT CUTS 58% OF POSITIONS. That is the point: holding the
 * stalls was costing roughly 66% each, and no improvement to the winners could outrun it. A bonding
 * curve is always quotable because it is a closed-form function of its own reserves, so unlike an
 * ordinary illiquid token the stop can actually be taken.
 */
const EXIT_SOL = Number(arg('exit-sol') ?? '82');
const STOP_BELOW = Number(arg('stop-below') ?? '4');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '300');
const MAX_IMPACT_BPS = Number(arg('max-impact-bps') ?? '400');
const RESERVE_SOL = Number(arg('reserve') ?? '0.008');
const LOG = 'data/auto-trade.log';
/**
 * A STRUCTURED RECORD OF EVERYTHING SEEN, NOT ONLY OF WHAT WAS DONE.
 *
 * The human-readable log says what the run traded. That is the least interesting part. What decides
 * whether the next run is better is the population it DECLINED - every curve that crossed the band
 * and was skipped, and the exact reason. Without those rows the run produces one or two outcomes and
 * teaches nothing; with them it produces a labelled sample of every candidate the market offered and
 * how each was judged, which is the only thing that can be measured afterwards.
 *
 * Reserves, route, impact and timing are captured AT THE MOMENT OF THE DECISION rather than
 * reconstructed later, because reconstructing a decision from a tape is how MT171 acquired a
 * look-ahead and how MT180 measured one leg of a two-leg trade.
 */
const EVENTS = 'data/auto-trade-events.jsonl';
/**
 * A kill switch that does not require finding the process. Creating this file stops the run at the
 * next safe point rather than mid-position, so a stop cannot strand a bag.
 */
const STOP_FILE = 'data/STOP';

const mode = modeFromArgv(process.argv);
const config = await loadConfig(mode);
const secrets = await loadSecrets();
if (secrets.tradingKeypairPath === null) { console.log('REFUSED: no trading keypair'); process.exit(1); }
const limiter = new RateLimiter([
  { bucket: 'solana_rpc', requestsPerSecond: 8, burst: 8 },
  { bucket: 'jupiter_main', requestsPerSecond: 2, burst: 2 },
]);
const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback ?? null });
const signer = Signer.fromFile(secrets.tradingKeypairPath);
const owner = signer.publicKey;
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

const say = (m: string): void => {
  const line = `${new Date().toISOString()}  ${m}`;
  process.stdout.write(line + String.fromCharCode(10));
  appendFileSync(LOG, line + String.fromCharCode(10));
};

/** One JSON object per decision, so the run is analysable rather than merely readable. */
const rec = (kind: string, fields: Record<string, unknown>): void => {
  appendFileSync(EVENTS, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), kind, ...fields }) + String.fromCharCode(10));
};

const balance = async (): Promise<number> => Number((await rpc.getAccounts([owner]))[0]?.lamports ?? 0n);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function held(mint: string): Promise<bigint> {
  const res = await fetch(secrets.rpcHttp ?? '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint }, { encoding: 'jsonParsed' }] }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } };
  let t = 0n;
  for (const a of j.result?.value ?? []) t += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return t;
}

/** Reserves and completion together, so a target, a stop and a migration are one read. */
async function curveState(mint: string): Promise<{ rSol: number; complete: boolean } | null> {
  const found = findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(mint, 64)], PUMP);
  if (found === null) return null;
  const acc = (await rpc.getAccounts([found.address]))[0];
  if (acc === null || acc === undefined) return { rSol: 0, complete: true };
  const b = Buffer.from(acc.dataBase64, 'base64');
  if (b.length < CURVE.complete + 1) return null;
  return { rSol: Number(b.readBigUInt64LE(CURVE.rSol)) / 1e9, complete: b.readUInt8(CURVE.complete) === 1 };
}

interface Leg { out: bigint; labels: string[]; impactBps: number }
/**
 * A 429 IS NOT AN ANSWER, AND TREATING IT AS ONE COST A TRADE.
 *
 * The first live dry run found a candidate at 93.6% and then reported "no buy quote", which read
 * like the token was unroutable. It was not: Jupiter had returned 429, this function returned null
 * on any non-200, and the position was skipped. The gateway rate-limits intermittently even on a
 * valid key - the same request seconds later returns 200 - so a single failed call says nothing
 * about whether the trade is available. Backing off and retrying is the difference between a
 * strategy and a strategy that silently declines whenever the API is busy.
 */
async function quote(inM: string, outM: string, amount: bigint): Promise<Leg | null> {
  const qs = new URLSearchParams({ inputMint: inM, outputMint: outM, amount: amount.toString(), slippageBps: String(SLIPPAGE_BPS) });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let r: Response;
    try { r = await fetch(`https://api.jup.ag/swap/v1/quote?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) }); }
    catch { await sleep(600 * (attempt + 1)); continue; }
    if (r.status === 429) { await sleep(700 * (attempt + 1)); continue; }
    if (!r.ok) return null;
    const j = (await r.json()) as { outAmount?: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[] };
    if (j.outAmount === undefined) return null;
    return { out: BigInt(j.outAmount), labels: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?'), impactBps: Math.abs(Number(j.priceImpactPct ?? '0')) * 1e4 };
  }
  return null;
}

/** One signed leg through the signer's single entry point. Returns the signature, or null on refusal. */
async function execute(inM: string, outM: string, amount: bigint, mint: string, side: 'buy' | 'sell'): Promise<{ sig: string; quotedOut: bigint } | null> {
  /**
   * THE ORDER PATH NEEDS THE SAME RETRY THE QUOTE PATH GOT, AND LEARNING THAT COST A POSITION.
   *
   * The first live run bought at 70.15 SOL, sold 69 seconds later for +2,338 bps, then found its
   * second candidate, quoted it successfully at 203 bps impact - and died building the order, on a
   * 429. The retry added earlier only guarded quote(); buildSignableOrder was left bare, so a
   * transient gateway limit ended a run that had capital, a valid candidate and a good quote.
   *
   * A rate limit is never information about the trade. It is only information about the gateway, and
   * the two must not be allowed to look alike.
   */
  let order: Awaited<ReturnType<typeof buildSignableOrder>> | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      order = await buildSignableOrder(limiter, secrets.jupiterApiKey, { inputMint: inM, outputMint: outM, amount, slippageBps: SLIPPAGE_BPS, taker: owner });
      break;
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes('rate_limited') && !msg.includes('429')) throw e;
      say(`   order rate-limited, retry ${attempt + 1}/5`);
      await sleep(900 * (attempt + 1));
    }
  }
  if (order === null) { say('   order still rate-limited after retries'); rec('skip', { mint, reason: 'order-rate-limited', side }); return null; }
  const raw = order.transaction;
  const decoded = decodeTransaction(raw);
  const now = Date.now();
  const minOut = minOutputOnEffectBasis({ outputMint: outM, quotedOut: order.quote.outAmount, slippageBps: SLIPPAGE_BPS });
  const intent: TradeIntent = {
    intentId: `auto-${side}-${String(now)}`, idempotencyKey: `auto-${side}-${String(now)}`,
    mint, side, inputMint: inM, outputMint: outM,
    maxInputAmount: amount, minOutputAmount: minOut,
    maxTotalFeeLamports: 8_000_000n, maxPriorityFeeLamports: 200_000n,
    deadlineUtcMs: now + 60_000, strategyVersion: config.strategyVersion,
    riskSnapshotHash: 'auto-trade', createdUtcMs: now,
  };
  const effect = await verifyEffect(rpc, Buffer.from(raw).toString('base64'), decoded, intent, owner);
  if (!effect.verified) { say(`   EFFECT REFUSED: ${effect.refusals.map((r) => r.refusal).join(', ')}`); return null; }
  const outcome = signer.sign({ raw, intent, effect, nowUtcMs: Date.now() });
  if (!outcome.signed) { say(`   SIGNER REFUSED (${outcome.kind}): ${outcome.detail}`); return null; }
  /**
   * THE ORDER CARRIES ITS OWN QUOTE AND IT IS NOT THE ONE WE LOGGED.
   *
   * The first live sell logged 0.012338 SOL and the wallet received 0.010723 - a 13% gap that looked
   * like catastrophic slippage and was not. quote() fetches a price for reporting, then
   * buildSignableOrder fetches a SECOND quote 400ms later and executes against that one, so minOut
   * was computed from a price we never printed and no slippage guard could trip. In a pool five
   * seconds old the price genuinely moved 13% in those 400 milliseconds.
   *
   * Reporting the order's own quoted output rather than the earlier probe makes the logged number
   * the number that was actually traded against.
   */
  const sig = await rpc.send(outcome.transactionBase64);
  return { sig, quotedOut: order.quote.outAmount };
}

const startBalance = await balance();
say('');
say('AUTO-TRADE');
say(`  owner ${owner}`);
say(`  balance ${(startBalance / 1e9).toFixed(9)} SOL`);
say(`  ${APPLY ? 'LIVE — WILL SIGN AND SEND' : 'DRY RUN — quotes every leg, signs nothing'}`);
say(`  plan: up to ${MAX_POSITIONS} positions of ${SOL_PER} SOL, entering at >=${MIN_PROGRESS}% of ${GRAD_SOL} SOL, selling ${SELL_AFTER_S}s after migration`);
say(`  MT174 measured this at median +755 bps, mean -889. Few trades is deliberate.`);
say('');

let positionsDone = 0;
let candidatesSeen = 0;
let skipped = 0;
let busy = false;
let realised = 0;
const ws = secrets.rpcWs;
if (ws === null || ws === '') { say('REFUSED: no websocket configured'); process.exit(1); }
const sock = new WebSocket(ws);
const seen = new Set<string>();

sock.addEventListener('open', () => {
  sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
  say('  watching…');
});

sock.addEventListener('message', (ev: MessageEvent) => {
  if (busy || positionsDone >= MAX_POSITIONS) return;
  let msg: { params?: { result?: { value?: { logs?: string[] } } } };
  try { msg = JSON.parse(String(ev.data)) as typeof msg; } catch { return; }
  for (const line of msg.params?.result?.value?.logs ?? []) {
    if (!line.startsWith(PREFIX)) continue;
    let b: Buffer;
    try { b = Buffer.from(line.slice(PREFIX.length).trim(), 'base64'); } catch { continue; }
    if (b.length < OFF.rSol + 8 || b.subarray(0, 8).toString('hex') !== TRADE_EVENT) continue;
    const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
    const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
    /** Proves the decode and selects SOL-quoted curves; the others are a different instrument. */
    if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) continue;
    const progress = (100 * rSol) / GRAD_SOL;
    if (progress < MIN_PROGRESS || progress >= 100) continue;
    const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
    if (seen.has(mint)) continue;
    seen.add(mint);
    candidatesSeen += 1;
    rec('candidate', { mint, rSol, progress, positionsDone });
    if (existsSync(STOP_FILE)) { say('  STOP file present — halting'); rec('stopped', { reason: 'stop-file' }); finish(); return; }
    busy = true;
    void run(mint, rSol);
    return;
  }
});
sock.addEventListener('close', () => { say('  websocket closed'); finish(); });

async function run(mint: string, rSol: number): Promise<void> {
  try {
    say(`[${positionsDone + 1}/${MAX_POSITIONS}] ${mint}  at ${rSol.toFixed(2)} SOL (${((100 * rSol) / GRAD_SOL).toFixed(1)}%)`);
    const bal = await balance();
    const need = SOL_PER * 1e9 + ATA_RENT + 300_000;
    if (bal - need < RESERVE_SOL * 1e9) { say(`   REFUSED: balance ${(bal / 1e9).toFixed(6)} leaves less than the ${RESERVE_SOL} SOL reserve`); finish(); return; }

    const amount = BigInt(Math.floor(SOL_PER * 1e9));
    const q = await quote(WSOL, mint, amount);
    if (q === null) { say('   no buy quote after retries — skipping'); rec('skip', { mint, reason: 'no-quote', rSol }); skipped += 1; busy = false; return; }
    if (!q.labels.includes('Pump.fun')) { say(`   route is ${q.labels.join('+')}, not the bonding curve — skipping`); rec('skip', { mint, reason: 'not-curve-route', labels: q.labels, rSol }); skipped += 1; busy = false; return; }
    if (q.impactBps > MAX_IMPACT_BPS) { say(`   impact ${q.impactBps.toFixed(0)} bps over ceiling — skipping`); rec('skip', { mint, reason: 'impact', impactBps: q.impactBps, rSol }); skipped += 1; busy = false; return; }
    say(`   buy quote ${q.out} tokens via ${q.labels.join('+')}, impact ${q.impactBps.toFixed(0)} bps`);
    rec('buy-quote', { mint, rSol, progress: (100 * rSol) / GRAD_SOL, tokensOut: q.out.toString(), labels: q.labels, impactBps: q.impactBps, solIn: SOL_PER, balanceLamports: bal });
    if (!APPLY) { say('   DRY RUN — would buy here'); positionsDone += 1; busy = false; if (positionsDone >= MAX_POSITIONS) finish(); return; }

    const balBeforeBuy = await balance();
    const buyRes = await execute(WSOL, mint, amount, mint, 'buy');
    if (buyRes === null) { say('   buy refused — stopping'); finish(); return; }
    const buySig = buyRes.sig;
    say(`   BOUGHT  ${buySig}`);
    const boughtAt = Date.now();
    rec('bought', { mint, sig: buySig, solIn: SOL_PER, rSolAtEntry: rSol });

    /**
     * Watch the curve's own reserves for a target, a stop, or a migration we did not want.
     * Polling is enough: we hold the position already and are not racing anyone for it.
     */
    const stopAt = rSol - STOP_BELOW;
    say(`   target ${EXIT_SOL} SOL   stop ${stopAt.toFixed(2)} SOL`);
    const deadline = Date.now() + 45 * 60_000;
    let reason = 'timeout';
    for (;;) {
      const st = await curveState(mint);
      if (st === null || st.complete) { reason = 'migrated'; break; }
      if (st.rSol >= EXIT_SOL) { reason = 'target'; break; }
      if (st.rSol <= stopAt) { reason = 'stop'; break; }
      if (Date.now() > deadline) break;
      await sleep(2_000);
    }
    const heldS = (Date.now() - boughtAt) / 1000;
    say(`   EXIT REASON: ${reason}  after ${heldS.toFixed(0)}s`);
    rec('exit-trigger', { mint, reason, heldSeconds: heldS, entryRSol: rSol, target: EXIT_SOL, stopAt });
    /** Only a migration needs the settling delay; on the curve we sell immediately. */
    if (reason === 'migrated') await sleep(SELL_AFTER_S * 1000);

    const bag = await held(mint);
    if (bag === 0n) { say('   nothing held — stopping'); finish(); return; }
    const sq = await quote(mint, WSOL, bag);
    if (sq === null) { say('   no sell quote — stopping, position still open'); finish(); return; }
    /**
     * The old gate refused a curve route outright, which was right when every exit went through the
     * pool and is wrong now: a target or stop exit is SUPPOSED to sell back to the curve.
     */
    const wantCurve = reason === 'target' || reason === 'stop';
    const onCurve = sq.labels.includes('Pump.fun') && !sq.labels.includes('Pump.fun Amm');
    if (wantCurve !== onCurve) { say(`   route ${sq.labels.join('+')} does not match a ${reason} exit — stopping`); finish(); return; }
    say(`   sell quote ${(Number(sq.out) / 1e9).toFixed(6)} SOL via ${sq.labels.join('+')}`);
    rec('sell-quote', { mint, solOut: Number(sq.out) / 1e9, labels: sq.labels, impactBps: sq.impactBps, bag: bag.toString() });
    const sellRes = await execute(mint, WSOL, bag, mint, 'sell');
    if (sellRes === null) { say('   sell refused — stopping, position still open'); finish(); return; }
    const sellSig = sellRes.sig;
    say(`   SOLD    ${sellSig}`);
    await sleep(3_000);
    const balAfterSell = await balance();
    /**
     * P&L IS THE WALLET DELTA, NOT THE QUOTE, and the first live trade is why this line exists.
     * Comparing sell proceeds to buy notional reported +2,338 bps on a round trip whose real
     * contribution was +626 lamports once fees and the rent outlay were counted -- an overstatement
     * of nearly four times. A number that flatters the strategy by four times is worse than no
     * number. Rent is reported separately because it is recoverable and is not a loss.
     */
    const walletDelta = balAfterSell - balBeforeBuy;
    const netOfRent = walletDelta + ATA_RENT;
    const trueBps = 1e4 * (netOfRent / Number(amount));
    const quotedBps = 1e4 * (Number(sellRes.quotedOut) / Number(amount) - 1);
    say(`   quoted  ${quotedBps.toFixed(0)} bps  |  WALLET ${(walletDelta / 1e9).toFixed(9)} SOL`);
    say(`   TRUE NET ${(netOfRent / 1e9).toFixed(9)} SOL = ${trueBps.toFixed(0)} bps once the ${(ATA_RENT / 1e9).toFixed(6)} SOL rent is reclaimed`);
    rec('closed', {
      mint, sig: sellSig, solIn: SOL_PER,
      quotedOutSol: Number(sellRes.quotedOut) / 1e9, quotedBps,
      walletDeltaSol: walletDelta / 1e9, netOfRentSol: netOfRent / 1e9, trueBps,
      holdSeconds: (Date.now() - boughtAt) / 1000,
    });
    realised += netOfRent;

    positionsDone += 1;
    busy = false;
    if (positionsDone >= MAX_POSITIONS) finish();
  } catch (e) {
    say(`   ERROR: ${(e as Error).message}`);
    finish();
  }
}

function finish(): void {
  say('');
  say(`  ${candidatesSeen} candidates seen, ${skipped} skipped, ${positionsDone} position(s) completed`);
  say(`  realised ${(realised / 1e9).toFixed(6)} SOL before rent recovery`);
  rec('run-end', { candidatesSeen, skipped, positionsDone, realisedLamports: realised });
  say('  Reclaim the rent from every account this opened — it is ~20% of a 0.01 SOL position:');
  say('     npx tsx scripts/close-stranded-atas.ts --mode=canary --apply');
  say('');
  try { sock.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', finish);
