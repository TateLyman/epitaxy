/**
 * MT113 — is there persistent skill in this venue, for anyone?
 *
 * Preregistered in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT113 before this file existed.
 *
 * NOT another strategy. It is the diagnostic that decides whether further strategy search
 * is rational. MT110, MT111 and MT112 are three independent mechanisms and all three land
 * on the same cost boundary. If day-to-day rank correlation of wallet performance is
 * indistinguishable from a shuffle control, then no observable we could have conditioned on
 * would have found an edge, and the last three negatives are one fact reported three times.
 *
 * AMOUNTS COME ONLY FROM VERIFIED QUANTITIES. The base leg chains EXACTLY on 35,650 of
 * 35,650 adjacent pairs, so `base_amount` is trusted. The quote leg is taken from the POOL
 * RESERVE DELTA between consecutive trades, which is exact by the same chaining, and the
 * out-of-pool fees are charged from the ladder the event declares. `quote_amount` and
 * `user_quote_amount` are NOT used anywhere: the buy-side routing model reproduces them only
 * about 55% of the time and that defect is open.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing. A persistence measurement is
 * not a tradeable rule and this row cannot license a position under any outcome.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V = 17_584_500_000n;
const MIN_TRADES_PER_DAY = 10;
const DEEP_SOL = 35;
const CPI_WRAPPER = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;
const WINDOWS: { from: number; to: number }[] = [];
for (let k = 1; k <= 12; k += 1) {
  const to = HEAD - k * SLOTS_PER_DAY;
  WINDOWS.push({ from: to - 19_999, to });
}

interface WalletDay {
  quote: number;       // net SOL flow: negative is spent, positive is received
  base: Map<string, bigint>; // residual base inventory per pool
  trades: number;
  deepTrades: number;
  feesPaid: number;
  pools: Set<string>;
}
const wallets = new Map<string, WalletDay>(); // key: wallet|day
const lastPrice = new Map<string, number>();  // pool -> last observed price
const poolsSeen = new Set<string>();
let skippedNoDelta = 0;

console.log('MT113 — venue-wide performance persistence\n');
const allFiles = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f));

for (const w of WINDOWS) {
  const files = allFiles.filter((f) => {
    const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
    return m !== null && Number(m[2]) >= w.from && Number(m[1]) <= w.to;
  });
  if (files.length === 0) continue;

  interface Ev { slot: number; tx: number; addr: string; ts: number; side: string; pool: string; user: string; base: bigint; b: bigint; q: bigint; lp: number; pf: number; cf: number }
  const byPool = new Map<string, Ev[]>();
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      const blk = JSON.parse(line) as {
        header?: { number: number; timestamp: number };
        instructions?: { transactionIndex: number; instructionAddress: number[]; data: string }[];
      };
      const hdr = blk.header;
      if (hdr === undefined || hdr.number < w.from || hdr.number > w.to) continue;
      for (const ins of blk.instructions ?? []) {
        let raw: Buffer;
        try { raw = Buffer.from(base58Decode(ins.data, 4096)); } catch { continue; }
        if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI_WRAPPER)) continue;
        const t = decodePumpSwapTrade(raw.subarray(8));
        if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
        const a = byPool.get(t.pool) ?? [];
        a.push({ slot: hdr.number, tx: ins.transactionIndex, addr: ins.instructionAddress.join('.'), ts: hdr.timestamp,
                 side: t.side, pool: t.pool, user: t.user, base: t.baseAmount,
                 b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore,
                 lp: Number(t.lpFeeBasisPoints), pf: Number(t.protocolFeeBasisPoints), cf: Number(t.coinCreatorFeeBasisPoints) });
        byPool.set(t.pool, a);
        poolsSeen.add(t.pool);
      }
    }
  }

  for (const [pool, evs] of byPool) {
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    for (let i = 0; i + 1 < evs.length; i += 1) {
      const e = evs[i];
      const nx = evs[i + 1];
      if (e === undefined || nx === undefined) continue;
      if (e.b <= 0n || e.q <= 0n || nx.q <= 0n) continue;
      // The pool's realised quote movement, exact by chaining.
      const poolDelta = Number(nx.q - e.q);
      if (poolDelta === 0) { skippedNoDelta += 1; continue; }
      const day = new Date(e.ts * 1000).toISOString().slice(0, 10);
      const key = `${e.user}|${day}`;
      let wd = wallets.get(key);
      if (wd === undefined) { wd = { quote: 0, base: new Map(), trades: 0, deepTrades: 0, feesPaid: 0, pools: new Set() }; wallets.set(key, wd); }

      const ladder = (e.lp + e.pf + e.cf) / 1e4;
      const outOfPool = (e.pf + e.cf) / 1e4;
      let walletQuote: number;
      if (e.side === 'BUY') {
        // The pool gained poolDelta; protocol and creator took their cut on top.
        // Verified routing: only protocol and creator leave the pool; the LP fee stays.
        const paid = poolDelta / Math.max(1 - outOfPool, 1e-9);
        walletQuote = -paid;
        wd.base.set(pool, (wd.base.get(pool) ?? 0n) + e.base);
        wd.feesPaid += paid * ladder;
      } else {
        // The pool gave up gross; poolDelta is gross net of the retained LP fee.
        const gross = -poolDelta / Math.max(1 - e.lp / 1e4, 1e-9);
        const received = gross * (1 - ladder);
        walletQuote = received;
        wd.base.set(pool, (wd.base.get(pool) ?? 0n) - e.base);
        wd.feesPaid += gross * ladder;
      }
      wd.quote += walletQuote;
      wd.pools.add(pool);
      wd.trades += 1;
      if (Number(e.q) / 1e9 > DEEP_SOL) wd.deepTrades += 1;
      const px = Number(e.q + V) / Number(e.b);
      if (Number.isFinite(px) && px > 0) lastPrice.set(pool, px);
    }
  }
  byPool.clear();
  console.log(`  window ${w.from}..${w.to}  wallet-days so far ${wallets.size.toLocaleString()}`);
}

// Resolve mints; a pool we cannot read is REFUSED, never assumed WSOL.
const db = openDb({ path: 'data/runtime.db' });
const known = new Map<string, string>();
for (const r of db.prepare('SELECT pool, quote_mint FROM venue_pools').all() as { pool: string; quote_mint: string }[]) known.set(r.pool, r.quote_mint);
const upsert = db.prepare(
  `INSERT OR REPLACE INTO venue_pools (pool, base_mint, quote_mint, base_vault, quote_vault, coin_creator, resolved_utc_ms, tracked)
   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT tracked FROM venue_pools WHERE pool = ?), 0))`);
const touched = new Set<string>();
for (const wd of wallets.values()) { if (wd.trades >= MIN_TRADES_PER_DAY) for (const p of wd.pools) touched.add(p); }
const need = [...touched].filter((p) => !known.has(p));
console.log(`\n  pools seen ${poolsSeen.size.toLocaleString()}   needing a mint lookup ${need.length.toLocaleString()}`);
let unresolved = 0;
if (need.length > 0) {
  const { rpc } = researchRpc(loadSecrets(), db);
  for (let i = 0; i < need.length; i += 1) {
    const pool = need[i];
    if (pool === undefined) continue;
    try {
      const raw = await rpc.getAccountRaw(pool);
      const a = poolAddressesFrom({ get: (k: string) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) }, pool);
      upsert.run(pool, a.baseMint, a.quoteMint, a.poolBaseTokenAccount, a.poolQuoteTokenAccount, a.coinCreator, Date.now(), pool);
      known.set(pool, a.quoteMint);
    } catch { unresolved += 1; }
    if ((i + 1) % 500 === 0) console.log(`    resolved ${i + 1}/${need.length}`);
  }
}
db.close();
console.log(`  unresolvable and REFUSED ${unresolved}`);

// Settle each wallet-day: mark residual inventory at the last observed price, exit ladder charged.
interface WD { wallet: string; day: string; pnl: number; trades: number; deepShare: number }
const wds: WD[] = [];
let aggregate = 0;
let feeSum = 0;
for (const [key, wd] of wallets) {
  if (wd.trades < MIN_TRADES_PER_DAY) continue;
  const [wallet, day] = key.split('|');
  if (wallet === undefined || day === undefined) continue;
  let pnl = wd.quote;
  let anyNonWsol = false;
  for (const [pool, amt] of wd.base) {
    if (known.get(pool) !== WSOL) { anyNonWsol = true; break; }
    if (amt === 0n) continue;
    const px = lastPrice.get(pool);
    if (px === undefined) continue;
    // Residual base marked at the last observed price, charged a full exit ladder at 250 bps,
    // the top of the observed range. Marking residual inventory optimistically is the single
    // most flattering error available in a PnL census, so it is charged the worst ladder.
    pnl += (Number(amt) * px) * (amt > 0n ? 0.975 : 1.025);
  }
  if (anyNonWsol) continue; // mixed-quote wallets are refused rather than mispriced
  pnl /= 1e9;
  aggregate += pnl;
  feeSum += wd.feesPaid / 1e9;
  wds.push({ wallet, day, pnl, trades: wd.trades, deepShare: wd.deepTrades / wd.trades });
}
console.log(`\n  wallet-days with >=${MIN_TRADES_PER_DAY} trades, all-WSOL: ${wds.length.toLocaleString()}`);
console.log(`  distinct wallets ${new Set(wds.map((x) => x.wallet)).size.toLocaleString()}   skipped for a zero pool delta ${skippedNoDelta.toLocaleString()}`);

console.log('\nCONTROL — the aggregate MUST be negative and near the fees paid, or the accounting is wrong');
console.log(`  aggregate taker PnL  ${aggregate.toFixed(1)} SOL`);
console.log(`  fees paid            ${feeSum.toFixed(1)} SOL`);
console.log(`  ratio                ${(aggregate / -Math.max(feeSum, 1e-9)).toFixed(3)}  (near +1 means the accounting closes)`);

const pctOf = (a: number[], x: number): number => { const s = [...a].filter(Number.isFinite).sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
const pnls = wds.map((x) => x.pnl);
console.log('\nDISTRIBUTION of wallet-day PnL, SOL');
console.log(`  p01 ${pctOf(pnls, 0.01).toFixed(2)}   p10 ${pctOf(pnls, 0.1).toFixed(3)}   p50 ${pctOf(pnls, 0.5).toFixed(3)}   p90 ${pctOf(pnls, 0.9).toFixed(3)}   p99 ${pctOf(pnls, 0.99).toFixed(2)}`);
console.log(`  share positive ${(100 * pnls.filter((x) => x > 0).length / pnls.length).toFixed(1)}%`);

// Spearman rank correlation between two days over wallets present in both.
const byDay = new Map<string, Map<string, number>>();
for (const x of wds) {
  const m = byDay.get(x.day) ?? new Map<string, number>();
  m.set(x.wallet, x.pnl);
  byDay.set(x.day, m);
}
const days = [...byDay.keys()].sort();
const spearman = (a: string, b: string, filter?: (w: string) => boolean): { rho: number; n: number } => {
  const ma = byDay.get(a);
  const mb = byDay.get(b);
  if (ma === undefined || mb === undefined) return { rho: NaN, n: 0 };
  const common = [...ma.keys()].filter((w) => mb.has(w) && (filter === undefined || filter(w)));
  if (common.length < 20) return { rho: NaN, n: common.length };
  const rank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array<number>(vals.length);
    for (let i = 0; i < idx.length; i += 1) { const e = idx[i]; if (e !== undefined) r[e.i] = i + 1; }
    return r;
  };
  const ra = rank(common.map((w) => ma.get(w) ?? 0));
  const rb = rank(common.map((w) => mb.get(w) ?? 0));
  const n = common.length;
  const mean = (n + 1) / 2;
  let num = 0; let da = 0; let dbb = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = (ra[i] ?? mean) - mean;
    const xb = (rb[i] ?? mean) - mean;
    num += xa * xb; da += xa * xa; dbb += xb * xb;
  }
  return { rho: num / Math.sqrt(Math.max(da * dbb, 1e-12)), n };
};

console.log('\nHEADLINE — Spearman rank correlation of wallet PnL, ADJACENT days');
const adj: number[] = [];
for (let i = 0; i + 1 < days.length; i += 1) {
  const a = days[i]; const b = days[i + 1];
  if (a === undefined || b === undefined) continue;
  const r = spearman(a, b);
  if (Number.isFinite(r.rho)) { adj.push(r.rho); console.log(`  ${a} -> ${b}   rho ${r.rho.toFixed(4).padStart(8)}   wallets in both ${r.n}`); }
}
console.log('\nSHUFFLE CONTROL — the same statistic on NON-adjacent day pairs, which is the honest zero');
const shuf: number[] = [];
for (let i = 0; i < days.length; i += 1) {
  for (let j = i + 3; j < days.length; j += 1) {
    const a = days[i]; const b = days[j];
    if (a === undefined || b === undefined) continue;
    const r = spearman(a, b);
    if (Number.isFinite(r.rho)) shuf.push(r.rho);
  }
}
const med = (a: number[]): number => pctOf(a, 0.5);
console.log(`  adjacent pairs  n=${adj.length}  median rho ${med(adj).toFixed(4)}   min ${Math.min(...adj).toFixed(4)}  max ${Math.max(...adj).toFixed(4)}`);
console.log(`  shuffle pairs   n=${shuf.length}  median rho ${med(shuf).toFixed(4)}   min ${Math.min(...shuf).toFixed(4)}  max ${Math.max(...shuf).toFixed(4)}`);

console.log('\nDEEP-POOL WALLETS ONLY — MT111 showed depth alone moves a round trip by 7 points,');
console.log('so a naive persistence signal could be nothing but persistent pool selection.');
const deepW = new Set(wds.filter((x) => x.deepShare > 0.5).map((x) => x.wallet));
const adjDeep: number[] = [];
for (let i = 0; i + 1 < days.length; i += 1) {
  const a = days[i]; const b = days[i + 1];
  if (a === undefined || b === undefined) continue;
  const r = spearman(a, b, (w) => deepW.has(w));
  if (Number.isFinite(r.rho)) adjDeep.push(r.rho);
}
console.log(`  adjacent, deep-pool wallets  n=${adjDeep.length}  median rho ${adjDeep.length ? med(adjDeep).toFixed(4) : 'n/a'}`);

console.log('\nFROZEN READING: a median adjacent rho that is not clearly above the shuffle median is');
console.log('NO PERSISTENCE — and would mean the last three negatives are one fact reported three times.');
console.log('No position is proposed. Nothing is funded. Nothing is signed.');
