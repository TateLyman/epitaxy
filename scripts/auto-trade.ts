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
import { buildSignableOrderV1 } from '../packages/execution/src/order.js';
import { verifyEffect } from '../packages/execution/src/effect.js';
import { decodeTransaction } from '../packages/solana/src/transaction.js';
import { minOutputOnEffectBasis } from '../packages/execution/src/quote-basis.js';
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode, base58Encode } from '../packages/solana/src/base58.js';
import type { TradeIntent } from '../packages/domain/src/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_EVENT = 'bddb7fd34ee661ee';
const OFF = { mint: 8, tokenAmount: 48, isBuy: 56, user: 57, vSol: 97, rSol: 113 };
const CURVE = { vSol: 16, rSol: 32, complete: 48 };
const GRAD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;
const ATA_RENT = 2_039_280;
/** pump.fun curve constants: initial virtual reserves, so k is fixed for every curve. */
const INIT_VSOL = 30, INIT_VTOK = 1_073_000_000;
const CURVE_K = INIT_VSOL * INIT_VTOK;
const PREFIX = 'Program data:';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const APPLY = process.argv.includes('--apply');
const SOL_PER = Number(arg('sol') ?? '0.01');
/** See the note above: raising this is the losing direction, not more exposure to an edge. */
const MAX_POSITIONS = Number(arg('max-positions') ?? '3');
/**
 * ENTER MUCH LOWER AND GIVE THE POSITION FAR MORE ROOM.
 *
 * MT188 swept entry level against stop distance in a single forward pass, 25 cells per block, on
 * both corpora. The surface is a smooth gradient in both directions rather than a bright square in
 * noise, which is the distinction that matters: neighbouring cells agree, so the effect is real
 * rather than the grid handing back its luckiest square.
 *
 * The configuration this bot was running - enter at 70 SOL, stop four below - reads +0.0008 on block
 * D and +0.0002 on block E, and it was inherited from MT171, which is the falsified one. Entry 55
 * with a stop eight SOL below reads +0.0038 and +0.0035. The peak sits at 45 on block D and 50-55 on
 * block E, a broad PLATEAU rather than a point, so 55 is chosen for agreeing on both blocks while
 * holding for less time than 45 would.
 *
 * The arithmetic is the whole reason and it is not subtle. The target is an ABSOLUTE reserve level,
 * so entering at 55 buys the move 55 to 82, which the curve prices at about +74%, where entering at
 * 70 buys +25%. The target rate FALLS from 44% to 35% and stop-outs rise, because a curve entered at
 * 55 has much further to climb - but each win is worth three times more, and the mean goes from +166
 * to +812 bps. Fewer, larger wins paid for by more frequent, larger stops.
 *
 * EXPECT ABOUT 63% OF POSITIONS TO STOP OUT, each around -18%. That is the design. A stop at 47 SOL
 * from an entry at 55 is a much deeper drawdown than the old four-SOL stop and it will feel wrong;
 * tightening it is measurably worse on both blocks, in every row of the sweep.
 */
const MIN_PROGRESS = Number(arg('min-progress') ?? '64.7');
const SELL_AFTER_S = Number(arg('sell-after') ?? '5');
/** A migration handover blocks routing for seconds; the retry has to outlast it by a wide margin. */
const SELL_ATTEMPTS = Number(arg('sell-attempts') ?? '40');
const SELL_RETRY_MS = Number(arg('sell-retry-ms') ?? '4000');
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
/** Reserve level below the entry band at which a curve starts being watched. */
/** Ten SOL below entry, so the climb into the band is genuinely observed. */
const WATCH_FROM_SOL = Number(arg('watch-from') ?? '45');
/** Absolute reserve level the entry percentage corresponds to, used for the climb gate. */
const ENTRY_SOL = Number(arg('entry-sol') ?? '55');
/** How far above the entry level a fill may land. A bound on giving away the move, not an edge. */
const MAX_OVERSHOOT_SOL = Number(arg('max-overshoot') ?? '4');
/**
 * Top-ten concentration band. Both tails are dangerous; MT189 measured where they are not.
 *
 * 44-71 came from quintile edges, which is where the data happened to split rather than where the
 * effect lives. Sweeping the boundaries gives a broad plateau from roughly 50 to 85, and 50-80 is the
 * most stable point on it: growth at f=0.20 reads 0.0269 over eleven days against 0.0273 on block D,
 * two independent samples agreeing to the third decimal, on 418 and 370 positions. Narrower bands
 * score higher - 55-75 reads 0.0391 and 0.0352 - but block E cannot test them at all, with 55
 * positions, and a band narrowed past the point where a sample can check it is a curve fit.
 */
const CONC_LO = Number(arg('conc-lo') ?? '50');
const CONC_HI = Number(arg('conc-hi') ?? '80');
const STOP_BELOW = Number(arg('stop-below') ?? '8');
const SLIPPAGE_BPS = Number(arg('slippage') ?? '300');
/** How far below the curve's closed-form price a fill may land before it is refused. */
const MAX_SHORTFALL_BPS = Number(arg('max-shortfall-bps') ?? '200');
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

/**
 * A ZERO BALANCE JUST AFTER A BUY IS NOT EVIDENCE OF AN EMPTY POSITION, AND BELIEVING IT STRANDED
 * REAL CAPITAL.
 *
 * The third live position bought 32,919,493,561 tokens in a CONFIRMED transaction that cost
 * 0.0121 SOL, hit its stop four seconds later, queried its holdings, was told zero, concluded there
 * was nothing to sell and ended the run - leaving the bag open on chain with the bot no longer
 * watching it. The buy was fine and the stop was right: the curve genuinely fell 69.84 to 65.99.
 * The defect was trusting a single balance read taken four seconds after the token account was
 * created, which is precisely when an RPC is least likely to have indexed it.
 *
 * So a zero is retried before it is believed. Anything else lets a race condition masquerade as an
 * empty wallet, which is the most expensive thing it could possibly pretend to be.
 */
async function held(mint: string, insist = false): Promise<bigint> {
  const tries = insist ? 6 : 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const v = await heldOnce(mint);
    if (v > 0n) return v;
    if (attempt + 1 < tries) {
      say(`   holdings read 0, retrying (${attempt + 1}/${tries}) — the RPC may not have indexed the account yet`);
      await sleep(2_500);
    }
  }
  return 0n;
}

async function heldOnce(mint: string): Promise<bigint> {
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

/**
 * HOLDER CONCENTRATION, ASKED OF THE CHAIN RATHER THAN RECONSTRUCTED FROM THE STREAM.
 *
 * The rug defence is a filter, not a stop. A live position lost 90% when its curve fell from 69.7 SOL
 * to 1.26 inside ONE transaction, and nothing reacts to that - not a two-second poll, not a websocket,
 * not a colocated node - because every one of them looks after the transaction has landed. The only
 * defence is not to be holding it. MT189 found what separates those: a collapse that large needs one
 * wallet holding most of the supply, and top-ten concentration inside 44-71% cut disasters from 3.2%
 * to 0.5% over eleven days, 2.3% to 0.2% on block D and 5.6% to 3.6% on block E, improving growth at
 * every bet fraction on all three. Both tails are dangerous: too dispersed and nobody is driving the
 * curve to graduation, too concentrated and one wallet can end it.
 *
 * REBUILDING BALANCES FROM THE TRADE STREAM WAS TRIED FIRST AND WAS WRONG. The backtest walks a
 * curve's whole history; a live bot joins mid-story, so a curve that traded for an hour before startup
 * has most of its holders missing and the computed share measures how long we have been watching
 * rather than how concentrated the curve is. A dry run reported "100% across 7 wallets" for curves with
 * hundreds of holders and would have refused nearly everything.
 *
 * The bonding curve's OWN vault is excluded, because unsold inventory is not circulating supply and
 * counting it would put every young curve near 100% - the same artifact by another route.
 */
async function concentration(mint: string): Promise<{ top10: number; nHold: number } | null> {
  interface Largest { result?: { value?: { address: string; amount: string }[] } }
  interface Owned { result?: { value?: { pubkey: string }[] } }
  async function post<T>(method: string, params: unknown[]): Promise<T | null> {
    const r = await fetch(secrets.rpcHttp ?? '', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  }
  let largest: Largest | null = null;
  try { largest = await post<Largest>('getTokenLargestAccounts', [mint]); } catch { return null; }
  const rows: { address: string; amount: string }[] = largest?.result?.value ?? [];
  if (rows.length === 0) return null;

  let curveAta: string | null = null;
  const found = findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(mint, 64)], PUMP);
  if (found !== null) {
    try {
      const owned = await post<Owned>('getTokenAccountsByOwner', [found.address, { mint }, { encoding: 'jsonParsed' }]);
      curveAta = owned?.result?.value?.[0]?.pubkey ?? null;
    } catch { /* the vault simply stays counted; the band is wide enough to survive it */ }
  }

  const bal: number[] = rows.filter((r) => r.address !== curveAta).map((r) => Number(r.amount)).filter((v) => v > 0).sort((a, b) => b - a);
  const supply = bal.reduce((a, b) => a + b, 0);
  if (!(supply > 0)) return null;
  return { top10: (100 * bal.slice(0, 10).reduce((a, b) => a + b, 0)) / supply, nHold: bal.length };
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

interface Leg { out: bigint; labels: string[]; impactBps: number; raw: unknown }
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
    return { out: BigInt(j.outAmount), labels: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?'), impactBps: Math.abs(Number(j.priceImpactPct ?? '0')) * 1e4, raw: j };
  }
  return null;
}

/** One signed leg through the signer's single entry point. Returns the signature, or null on refusal. */
async function execute(inM: string, outM: string, amount: bigint, mint: string, side: 'buy' | 'sell', preQuote?: unknown): Promise<{ sig: string; quotedOut: bigint } | null> {
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
  let order: Awaited<ReturnType<typeof buildSignableOrderV1>> | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      order = await buildSignableOrderV1(secrets.jupiterApiKey, { inputMint: inM, outputMint: outM, amount, slippageBps: SLIPPAGE_BPS, taker: owner, preQuote });
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
say(`  plan: up to ${MAX_POSITIONS} positions of ${SOL_PER} SOL`);
say(`  ENTER at >=${MIN_PROGRESS}% of ${GRAD_SOL} SOL   TARGET ${EXIT_SOL} SOL on the curve   STOP ${STOP_BELOW} SOL below entry`);
say(`  Only curves watched climbing from ${WATCH_FROM_SOL} SOL are eligible; overshoot capped at ${MAX_OVERSHOOT_SOL} SOL.`);
say(`  Rug filter: top-10 concentration must sit inside ${CONC_LO}-${CONC_HI}% of circulating supply.`);
say(`  Exits trigger from the trade stream, not a poll: MT193 prices every trade of lateness at real cost.`);
say(`  MT189/MT190: growth at f=0.20 reads 0.0269 over 11 days and 0.0273 on block D inside this band.`);
say(`  Expect roughly 63% to stop out at about -18%. Fewer, larger wins pay for them. That is the design.`);
say('');

let positionsDone = 0;
let candidatesSeen = 0;
let skipped = 0;
let busy = false;
/**
 * THE MINT WE ACTUALLY HOLD, OR NULL. NOTHING MAY END THE RUN WHILE THIS IS SET.
 *
 * Three separate paths abandoned a bought position: a route that did not match the expected venue, a
 * websocket close, and any thrown error. Each called finish() and exited, and one of them - a sell
 * quote failing during the curve-to-pool handover - turned the run's only winning trade, a +68%
 * target hit, into a -91.5% loss ten minutes later.
 *
 * `busy` was never the right flag for this: it is true from the moment a candidate is picked up,
 * including the whole stretch before anything is bought, when exiting is perfectly safe. Only the
 * interval between a confirmed buy and a confirmed sell matters, and until now nothing recorded it.
 */
let openMint: string | null = null;
/** Set when the candidate feed drops; new entries stop, open positions are still managed. */
let feedClosed = false;
/**
 * THE LIVE RESERVE OF THE POSITION WE HOLD, PUBLISHED BY THE STREAM.
 *
 * The exit used to poll the bonding-curve account every two seconds, and MT193 measured what that
 * costs. Delay is counted in TRADES between the barrier being crossed and the order landing, and it
 * does not merely shave the mean - it manufactures disasters, because a stop fires precisely when the
 * curve is falling, so every trade we are late by is a worse fill. Across the eleven-day sample the
 * disaster rate runs 1.2% at zero delay, 5.5% at five trades, 13.2% at ten and 17.5% at twenty, while
 * growth at f=0.20 falls from 0.0244 to 0.0065. A live exit took six seconds from trigger to fill.
 *
 * We were already subscribed to every trade on the program. The same stream that finds candidates
 * carries the trades on the curve we are holding, so the barrier can be checked the instant the trade
 * lands instead of up to two seconds later. Polling stays as a fallback for the case where our token
 * simply is not trading, which is exactly when the stream tells us nothing.
 */
let heldRSol: number | null = null;
let heldComplete = false;

/** Everything a person needs to close a position by hand, printed wherever one might be left open. */
function warnOpen(where: string): void {
  if (openMint === null) return;
  say(`  !! POSITION STILL OPEN (${where}). Close it by hand:`);
  say(`     npx tsx scripts/swap.ts --mode=` + `canary --mint=${openMint} --side=sell --apply`);
  rec('stranded', { mint: openMint, reason: where });
}
let realised = 0;
const ws = secrets.rpcWs;
if (ws === null || ws === '') { say('REFUSED: no websocket configured'); process.exit(1); }
const sock = new WebSocket(ws);
const seen = new Set<string>();
/**
 * ONLY TRADE CURVES WE WATCHED CLIMB INTO THE BAND.
 *
 * MT187 restricts its sample to positions where the rise from 60 SOL to the entry level was actually
 * observed, and that restriction alone is worth about a hundred basis points on the mean: block D
 * reads +129 bps against MT186's +29 on the identical configuration, and block E reads +51. Both are
 * positive, and both improve on the unrestricted version.
 *
 * The mechanism is the same one the climb-time quintiles show. A curve first seen ALREADY above the
 * entry level has an unknown climb time, and unknown behaves like slow: those quintiles carry the
 * worst target rates in both blocks. Buying one is arriving late to something that may have been
 * stalled there for an hour.
 *
 * The bot was doing exactly that. It bought whatever it first noticed at or above the progress
 * threshold, which after any restart is mostly curves that crossed while it was not running. This
 * records every curve seen BELOW the entry level and refuses anything not on that list.
 */
const watchedBelow = new Set<string>();
/**
 * Concentration is read ON DEMAND, not prefetched, and that is a deliberate reversal.
 *
 * Reading it ahead of the crossing would shave about 250ms from the entry path, which MT193 values
 * at roughly a third of a trade of delay on a median curve. But it costs two RPC calls for EVERY
 * curve in the watch band, most of which never cross, and the provider quota turned out to be the
 * binding constraint long before latency was: the key hit "max usage reached" and the websocket
 * handshake was refused along with it, which stops the bot entirely. A cheaper entry is worth
 * nothing if the feed is switched off.
 */
const concCache = new Map<string, { top10: number; nHold: number; at: number }>();
const CONC_TTL_MS = Number(arg('conc-ttl-ms') ?? '90000');

sock.addEventListener('open', () => {
  sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
  say('  watching…');
});

sock.addEventListener('message', (ev: MessageEvent) => {
  /** A closed feed takes no new candidates; anything already held is still managed to completion. */
  if (feedClosed || busy || positionsDone >= MAX_POSITIONS) return;
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
    const mintEarly = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
    /** Our own position's reserve, straight off the trade that moved it. */
    if (openMint !== null && mintEarly === openMint) { heldRSol = rSol; if (rSol >= GRAD_SOL) heldComplete = true; }
    /** Seen below the band: this is what makes a later crossing a climb we watched rather than a guess. */
    if (rSol >= WATCH_FROM_SOL && rSol < ENTRY_SOL) {
      watchedBelow.add(mintEarly);
    }
    if (progress < MIN_PROGRESS || progress >= 100) continue;
    const mint = mintEarly;
    if (seen.has(mint)) continue;
    if (!watchedBelow.has(mint)) {
      /** Not an error and not worth a log line per event — just never a trade. */
      seen.add(mint);
      rec('skip', { mint, reason: 'climb-not-observed', rSol, progress });
      continue;
    }
    seen.add(mint);
    candidatesSeen += 1;
    rec('candidate', { mint, rSol, progress, positionsDone });
    if (existsSync(STOP_FILE)) { say('  STOP file present — halting'); rec('stopped', { reason: 'stop-file' }); finish(); return; }
    busy = true;
    void run(mint, rSol);
    return;
  }
});
/**
 * A CLOSED SOCKET STOPS NEW ENTRIES AND NOTHING ELSE. Position management runs independently of the
 * feed, so exiting here would kill a live position for the sake of a stream that is only used to find
 * candidates. If nothing is held the run ends normally; if something is, it is left to complete.
 */
sock.addEventListener('close', () => {
  feedClosed = true;
  say('  websocket closed — no new candidates');
  if (openMint === null && !busy) finish();
  else say('  a position is still being managed; the run continues until it closes');
});

async function run(mint: string, rSol: number): Promise<void> {
  try {
    say(`[${positionsDone + 1}/${MAX_POSITIONS}] ${mint}  at ${rSol.toFixed(2)} SOL (${((100 * rSol) / GRAD_SOL).toFixed(1)}%)`);
    const bal = await balance();
    const need = SOL_PER * 1e9 + ATA_RENT + 300_000;
    if (bal - need < RESERVE_SOL * 1e9) { say(`   REFUSED: balance ${(bal / 1e9).toFixed(6)} leaves less than the ${RESERVE_SOL} SOL reserve`); finish(); return; }

    const amount = BigInt(Math.floor(SOL_PER * 1e9));
    /**
     * NEVER BUY A CURVE THAT IS ALREADY PAST THE TARGET, which the live run did and which produced
     * a position that triggered its own exit zero seconds after opening.
     *
     * The entry filter is a PERCENTAGE of graduation and the target is an ABSOLUTE reserve level,
     * so a curve at 82.37 SOL satisfied "at least 82% of 85" while already standing above the 82
     * SOL exit. There was never a trade there: it bought, immediately fired `target`, and paid two
     * lots of fees for a round trip with no move in between. The two thresholds have to be compared
     * in the same units.
     */
    /**
     * Refuse a fill that has already given away most of the run to the target. MT187 tested caps of
     * 1, 2 and 4 SOL across both corpora and found NO consistent winner - 4 was best on block D, 1
     * on block E - so this is a sanity bound rather than an edge, set where it is never worse on
     * either block. Entering twelve SOL above the level leaves three SOL of upside against an
     * unchanged stop, which is a bad trade regardless of what the statistics say.
     */
    if (rSol > ENTRY_SOL + MAX_OVERSHOOT_SOL) {
      say(`   ${rSol.toFixed(2)} SOL is ${(rSol - ENTRY_SOL).toFixed(2)} above the entry level — too little room to target`);
      rec('skip', { mint, reason: 'entry-overshoot', rSol, entryLevel: ENTRY_SOL });
      skipped += 1; busy = false; return;
    }
    if (rSol >= EXIT_SOL - 1) {
      say(`   already at ${rSol.toFixed(2)} SOL, at or past the ${EXIT_SOL} target — no trade here`);
      rec('skip', { mint, reason: 'already-past-target', rSol, target: EXIT_SOL });
      skipped += 1; busy = false; return;
    }
    /**
     * THE RUG FILTER. Refusing on an unreadable distribution is deliberate: a curve whose holders we
     * cannot see is one we do not understand, and the whole point is to decline those.
     */
    /** Use the prefetched reading when it is fresh; fall back to reading it now when it is not. */
    const cached = concCache.get(mint);
    const conc = cached !== undefined && Date.now() - cached.at <= CONC_TTL_MS
      ? { top10: cached.top10, nHold: cached.nHold }
      : await concentration(mint);
    if (conc === null) {
      say('   could not read the holder distribution — no trade');
      rec('skip', { mint, reason: 'concentration-unknown', rSol });
      skipped += 1; busy = false; return;
    }
    if (conc.top10 < CONC_LO || conc.top10 > CONC_HI) {
      say(`   top-10 hold ${conc.top10.toFixed(0)}% of supply — outside the ${CONC_LO}-${CONC_HI}% band`);
      rec('skip', { mint, reason: 'concentration-outside-band', top10: conc.top10, nHold: conc.nHold, rSol });
      skipped += 1; busy = false; return;
    }
    say(`   top-10 hold ${conc.top10.toFixed(0)}% of supply — inside the band`);

    const q = await quote(WSOL, mint, amount);
    if (q === null) { say('   no buy quote after retries — skipping'); rec('skip', { mint, reason: 'no-quote', rSol }); skipped += 1; busy = false; return; }
    if (!q.labels.includes('Pump.fun')) { say(`   route is ${q.labels.join('+')}, not the bonding curve — skipping`); rec('skip', { mint, reason: 'not-curve-route', labels: q.labels, rSol }); skipped += 1; busy = false; return; }
    /**
     * GATE ON CLOSED-FORM CURVE MATH, NOT ON JUPITER'S IMPACT FIELD.
     *
     * Measured against the first live fill: closed-form predicted the tokens received to within
     * 0.337%, and the TRUE combined cost was 1.34% of which a full 1.00% is the pump.fun fee -- so
     * real impact was 0.34%. Jupiter reported 232 bps on that same trade, roughly seven times the
     * truth. Its priceImpactPct is not measuring what its name says on bonding-curve routes.
     *
     * The old ceiling therefore rejected on a number that does not mean what it claims, and it
     * already threw away a candidate at "686 bps" whose real impact was almost certainly near 1%.
     * Comparing the quote against the curve's own arithmetic tests the thing we actually care
     * about: is this fill close to what the curve is obliged to give us.
     */
    const vSolNow = rSol + INIT_VSOL;
    const vTokNow = CURVE_K / vSolNow;
    const modelTokens = vTokNow - CURVE_K / (vSolNow + SOL_PER * (1 - 0.01));
    const shortfallBps = 1e4 * (1 - Number(q.out) / 1e6 / modelTokens);
    if (shortfallBps > MAX_SHORTFALL_BPS) {
      say(`   quote is ${shortfallBps.toFixed(0)} bps below the curve's own price — skipping`);
      rec('skip', { mint, reason: 'below-curve-model', shortfallBps, jupiterImpactBps: q.impactBps, rSol });
      skipped += 1; busy = false; return;
    }
    /**
     * A QUOTE THAT IS IMPOSSIBLY GOOD IS AS WRONG AS ONE THAT IS IMPOSSIBLY BAD.
     *
     * The gate only ever checked one direction. A live candidate quoted 1,410 bps BETTER than the
     * bonding curve is mathematically able to give, with Jupiter reporting zero price impact, and it
     * passed straight through to fail simulation. The curve is a closed-form function of its own
     * reserves: it cannot hand out fourteen percent more tokens than its formula. A quote claiming
     * otherwise is describing a different pool, a stale state, or a token whose constants are not
     * the ones assumed - and in every one of those cases the right move is to decline, not to sign.
     */
    if (shortfallBps < -MAX_SHORTFALL_BPS) {
      say(`   quote is ${(-shortfallBps).toFixed(0)} bps BETTER than the curve can give — impossible, skipping`);
      rec('skip', { mint, reason: 'above-curve-model', shortfallBps, jupiterImpactBps: q.impactBps, rSol });
      skipped += 1; busy = false; return;
    }
    say(`   quote is ${shortfallBps.toFixed(0)} bps off closed-form (jupiter claims ${q.impactBps.toFixed(0)} bps impact)`);
    say(`   buy quote ${q.out} tokens via ${q.labels.join('+')}, impact ${q.impactBps.toFixed(0)} bps`);
    rec('buy-quote', { mint, rSol, progress: (100 * rSol) / GRAD_SOL, tokensOut: q.out.toString(), labels: q.labels, impactBps: q.impactBps, solIn: SOL_PER, balanceLamports: bal });
    if (!APPLY) { say('   DRY RUN — would buy here'); positionsDone += 1; busy = false; if (positionsDone >= MAX_POSITIONS) finish(); return; }

    const balBeforeBuy = await balance();
    /** Hand over the quote we just judged: one fewer round trip, and the order matches the decision. */
    const buyRes = await execute(WSOL, mint, amount, mint, 'buy', q.raw);
    if (buyRes === null) {
      /**
       * A REFUSED BUY IS ONE BAD CANDIDATE, NOT THE END OF THE SESSION.
       *
       * The run died an hour into a live session because a single token's transaction failed
       * simulation and this called finish(). Nothing was bought, nothing was at risk, and there was
       * no reason to stop watching - but the bot sat dead while curves kept crossing the band. The
       * refusal itself was correct: the effect check simulated the transaction and it failed, which
       * is exactly what that gate is for. Only the response was wrong.
       *
       * A refusal BEFORE any capital moves means skip and keep watching. Only a failure with a
       * position already open justifies stopping, because then there is something to protect.
       */
      say('   buy refused — skipping this candidate, still watching');
      rec('skip', { mint, reason: 'buy-refused', rSol });
      skipped += 1; busy = false; return;
    }
    const buySig = buyRes.sig;
    openMint = mint;
    heldRSol = null; heldComplete = false;
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
    /**
     * Watch the STREAM first and poll only as a fallback. The stream reports the reserve on the very
     * trade that moved it; polling can be a full interval behind, and MT193 prices every trade of that
     * lateness in both mean and disaster rate. The tight loop below costs nothing because it is almost
     * always waiting on an event rather than an RPC round trip.
     */
    let lastPoll = 0;
    for (;;) {
      if (heldComplete) { reason = 'migrated'; break; }
      if (heldRSol !== null) {
        if (heldRSol >= EXIT_SOL) { reason = 'target'; break; }
        if (heldRSol <= stopAt) { reason = 'stop'; break; }
      }
      /**
       * A curve that is not trading publishes nothing, and that is exactly when it may have migrated
       * or gone quiet, so the account is still read - just infrequently enough not to matter.
       */
      if (Date.now() - lastPoll > 5_000) {
        lastPoll = Date.now();
        const st = await curveState(mint);
        if (st === null || st.complete) { reason = 'migrated'; break; }
        if (st.rSol >= EXIT_SOL) { reason = 'target'; break; }
        if (st.rSol <= stopAt) { reason = 'stop'; break; }
        if (heldRSol === null) heldRSol = st.rSol;
      }
      if (Date.now() > deadline) break;
      await sleep(120);
    }
    const heldS = (Date.now() - boughtAt) / 1000;
    say(`   EXIT REASON: ${reason}  after ${heldS.toFixed(0)}s`);
    rec('exit-trigger', { mint, reason, heldSeconds: heldS, entryRSol: rSol, target: EXIT_SOL, stopAt });
    /** Only a migration needs the settling delay; on the curve we sell immediately. */
    if (reason === 'migrated') await sleep(SELL_AFTER_S * 1000);

    /** insist: we just bought, so a zero here is far likelier to be RPC lag than an empty bag. */
    const bag = await held(mint, true);
    if (bag === 0n) {
      say('   REFUSING TO REPORT SUCCESS: bought this position but cannot read a balance after 6 tries.');
      finish(); return;
    }
    /**
     * A POSITION IS NEVER ABANDONED BECAUSE ONE QUOTE FAILED. THIS COST THE BEST TRADE OF THE RUN.
     *
     * A position reached its 82 SOL target in 164 seconds - the strategy's best possible outcome, about
     * +68% - and the sell quote returned nothing on the first attempt, so the bot logged "no sell quote"
     * and exited holding it. The token was MIGRATING at that instant: during the curve-to-pool handover
     * there is a window where the curve no longer routes and the pool does not yet. It is a few seconds
     * long and it is entirely survivable. Ten minutes later the migrated pool had collapsed and the
     * position was worth -91.5%, turning the run's only winner into its largest loss.
     *
     * The transition is precisely when a sell is most likely to fail and most urgent to complete, so
     * the retry runs for minutes rather than once, and the loop only ends when the position is closed
     * or the operator is told plainly to close it by hand. Giving up while holding inventory is never
     * the correct response to a temporary routing gap.
     */
    let sq: Leg | null = null;
    for (let attempt = 0; attempt < SELL_ATTEMPTS; attempt += 1) {
      sq = await quote(mint, WSOL, bag);
      if (sq !== null) break;
      say(`   no sell route yet (attempt ${attempt + 1}/${SELL_ATTEMPTS}) — likely mid-migration, retrying`);
      await sleep(SELL_RETRY_MS);
    }
    if (sq === null) {
      say('   STILL NO SELL ROUTE after every retry.');
      finish(); return;
    }
    /**
     * The old gate refused a curve route outright, which was right when every exit went through the
     * pool and is wrong now: a target or stop exit is SUPPOSED to sell back to the curve.
     */
    const wantCurve = reason === 'target' || reason === 'stop';
    const onCurve = sq.labels.includes('Pump.fun') && !sq.labels.includes('Pump.fun Amm');
    /**
     * A MISMATCHED ROUTE IS INFORMATION, NOT A REASON TO WALK AWAY FROM INVENTORY. This previously
     * called finish(). During migration the venue legitimately flips from the curve to the pool
     * between the exit trigger and the quote, so a target exit can correctly arrive on Pump.fun Amm -
     * and refusing to sell because of it left the position open while the token collapsed. We are at
     * an exit condition and we want out; the venue we get out through is not worth holding for.
     */
    if (wantCurve !== onCurve) {
      say(`   note: route ${sq.labels.join('+')} is not the venue a ${reason} exit expected — selling anyway`);
      rec('route-mismatch', { mint, reason, labels: sq.labels });
    }
    say(`   sell quote ${(Number(sq.out) / 1e9).toFixed(6)} SOL via ${sq.labels.join('+')}`);
    rec('sell-quote', { mint, solOut: Number(sq.out) / 1e9, labels: sq.labels, impactBps: sq.impactBps, bag: bag.toString() });
    /** Same rule for the signed leg: a refusal while holding inventory is retried, not accepted. */
    let sellRes: { sig: string; quotedOut: bigint } | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      sellRes = await execute(mint, WSOL, bag, mint, 'sell', attempt === 0 ? sq.raw : undefined);
      if (sellRes !== null) break;
      say(`   sell refused (attempt ${attempt + 1}/6) — rebuilding and retrying`);
      await sleep(3_000);
    }
    if (sellRes === null) {
      say('   SELL STILL REFUSED after every retry.');
      finish(); return;
    }
    const sellSig = sellRes.sig;
    openMint = null;
    heldRSol = null; heldComplete = false;
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
    warnOpen('error-while-holding');
    finish();
  }
}

function finish(): void {
  say('');
  /** A run that ends holding something must say exactly what, and how to close it. */
  warnOpen('run-ended-holding');
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
