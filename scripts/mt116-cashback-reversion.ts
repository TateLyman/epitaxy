/**
 * MT116 — does reversion clear cost once the cashback rebate is credited?
 *
 * Frozen in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT116 before this file existed.
 *
 * THE ASYMMETRY THIS TESTS. MT115 established, at 67 of 67 pool-level agreement, that on a
 * cashback coin the creator fee is CHARGED TO THE TRADER and redirected to the trader's own
 * volume accumulator rather than to the creator. So the declared ladder reads a zero creator
 * fee while the trader still pays it, and a builder that appends the accumulator accounts gets
 * it back. That is a structural cost advantage over everyone else in the same pool — roughly
 * 50 bps a round trip against roughly 120 — and it is not a prediction about any token.
 *
 * MT110 measured gross reversion of roughly 95 bps in the >5% impact bucket at 5s. Against 120
 * that is negative, which is why MT110 closed. Against 50 it is not. MT110 priced every pool at
 * the full ladder, so it never asked this question.
 *
 * TWO COST MODELS ON THE SAME EVENTS, which is what makes the comparison internal:
 *   FULL      the fee the trader actually pays, taken from the sell identity rather than the
 *             declared ladder, because the ladder understates it on cashback pools by design
 *   CREDITED  the same, minus the creator component a correct cashback build recovers
 *
 * The gap between them must equal the creator component and nothing else. If the credited arm
 * is positive but the gap does not match, something else is doing the work.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { decodePumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';
import { priceBuy, priceSell, FillNotPriceable, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const CPI = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;
const IMPACT_BAR = 0.05;
const HORIZON_S = 15;
const NOTIONAL = 20_000_000n;
/** Per-pool virtual reserve is exactly one of these two. Never fitted. */
const V_CANDIDATES = [0n, 17_584_500_000n];

const WINDOWS: { from: number; to: number }[] = [];
for (let k = 1; k <= 12; k += 1) {
  const to = HEAD - k * SLOTS_PER_DAY;
  WINDOWS.push({ from: to - 19_999, to });
}

interface Ev {
  slot: number; ts: number; tx: number; addr: string; side: string;
  b: bigint; q: bigint; quote: bigint; user: bigint;
  lp: bigint; pf: bigint; cf: bigint;
}

/** Solve each pool's own invariant for v: exactly 0 or exactly 17.5845 SOL. */
function resolveV(evs: Ev[]): bigint | null {
  let best: bigint | null = null;
  let bestBad = Infinity;
  for (const v of V_CANDIDATES) {
    let bad = 0; let n = 0;
    for (let i = 0; i + 1 < evs.length && n < 60; i += 1) {
      const a = evs[i]; const c = evs[i + 1];
      if (a === undefined || c === undefined) continue;
      if (a.b <= 0n || a.q <= 0n || c.b <= 0n || c.q <= 0n) continue;
      const k0 = Number(a.b) * Number(a.q + v);
      const k1 = Number(c.b) * Number(c.q + v);
      if (!(k0 > 0) || !(k1 > 0)) continue;
      n += 1;
      if (k1 < k0) bad += 1; // k cannot fall between two trades; the pool keeps the LP fee
    }
    if (n >= 10 && bad < bestBad) { bestBad = bad; best = v; }
  }
  return best;
}

const db = openDb({ path: 'data/runtime.db' });
const known = new Map<string, string>();
for (const r of db.prepare('SELECT pool, quote_mint FROM venue_pools').all() as { pool: string; quote_mint: string }[]) known.set(r.pool, r.quote_mint);

interface Row {
  pool: string; day: string; depthSol: number; cashback: boolean;
  fullBps: number; creditedBps: number; creatorBps: number;
  retFull: number; retCredited: number;
}
const rows: Row[] = [];
const poolCash = new Map<string, boolean>();
let scanned = 0;

console.log('MT116 — reversion under two cost models\n');
for (const w of WINDOWS) {
  const files = readdirSync(DIR).filter((f) => {
    const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
    return m !== null && Number(m[2]) >= w.from && Number(m[1]) <= w.to;
  });
  if (files.length === 0) continue;
  const byPool = new Map<string, Ev[]>();
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(`${DIR}/${f}`, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let blk: { header?: { number: number; timestamp: number }; instructions?: { transactionIndex: number; instructionAddress: number[]; data: string }[] };
      try { blk = JSON.parse(line); } catch { continue; }
      const h = blk.header;
      if (h === undefined || h.number < w.from || h.number > w.to) continue;
      for (const i of blk.instructions ?? []) {
        let raw: Buffer;
        try { raw = Buffer.from(base58Decode(i.data, 4096)); } catch { continue; }
        if (raw.length < 8 || !raw.subarray(0, 8).equals(CPI)) continue;
        const t = decodePumpSwapTrade(raw.subarray(8));
        if (t === null || t.coinCreatorFeeBasisPoints === null) continue;
        if (known.get(t.pool) !== WSOL) continue;
        const a = byPool.get(t.pool) ?? [];
        a.push({ slot: h.number, ts: h.timestamp, tx: i.transactionIndex, addr: i.instructionAddress.join('.'),
                 side: t.side, b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore,
                 quote: t.quoteAmount, user: t.userQuoteAmount,
                 lp: t.lpFeeBasisPoints, pf: t.protocolFeeBasisPoints, cf: t.coinCreatorFeeBasisPoints });
        byPool.set(t.pool, a);
      }
    }
    rl.close();
  }

  for (const [pool, evs] of byPool) {
    if (evs.length < 40) continue;
    evs.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    const v = resolveV(evs);
    if (v === null) continue;

    // The fee ACTUALLY charged, from the sell identity. The declared ladder understates it on
    // cashback pools by construction, which is the whole point of MT115.
    const charged: number[] = [];
    for (const e of evs) {
      if (e.side !== 'SELL' || e.quote <= 0n || e.user <= 0n) continue;
      const c = 1e4 * (Number(e.quote) - Number(e.user)) / Number(e.quote);
      if (Number.isFinite(c) && c > 0 && c < 1000) charged.push(c);
    }
    if (charged.length < 5) continue;
    charged.sort((a, b) => a - b);
    const chargedBps = charged[Math.floor(0.5 * (charged.length - 1))] ?? NaN;
    if (!Number.isFinite(chargedBps)) continue;

    // Declared ladder, for the creator component the rebate returns.
    const last = evs[evs.length - 1];
    if (last === undefined) continue;
    const declared = Number(last.lp + last.pf + last.cf);
    // On a cashback pool the event's creator field reads 0 and the residual IS the redirected
    // creator fee. On a non-cashback pool the ladder already matches, so the residual is ~0.
    const creatorBps = Math.max(chargedBps - declared, 0);
    const creditedBps = Math.max(chargedBps - creatorBps, 1);

    let lastEnd = -1;
    for (let i = 1; i + 1 < evs.length; i += 1) {
      const pre = evs[i]; const post = evs[i + 1];
      if (pre === undefined || post === undefined) continue;
      if (pre.b <= 0n || pre.q <= 0n || post.b <= 0n || post.q <= 0n) continue;
      const p0 = Number(pre.q + v) / Number(pre.b);
      const p1 = Number(post.q + v) / Number(post.b);
      if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0 || p1 <= 0) continue;
      if (!(p1 / p0 - 1 < 0)) continue;
      if (Math.abs(Number(post.q - pre.q)) / Number(pre.q) < IMPACT_BAR) continue;
      if (post.ts < lastEnd) continue;
      let mark: Ev | null = null;
      for (let j = i + 2; j < evs.length; j += 1) { const e = evs[j]; if (e !== undefined && e.ts >= post.ts + HORIZON_S) { mark = e; break; } }
      if (mark === null) continue;
      lastEnd = post.ts + HORIZON_S;
      scanned += 1;

      const mk = (bps: number): PoolFeeLadder => ({
        lpFeeBasisPoints: BigInt(Math.round(bps)), protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n,
        chargedFeeBasisPoints: BigInt(Math.round(bps)),
      });
      const entry = { base: post.b, quote: post.q, virtualQuote: v };
      const exit = { base: mark.b, quote: mark.q, virtualQuote: v };
      try {
        const bf = priceBuy(entry, NOTIONAL, mk(chargedBps));
        const sf = priceSell({ base: exit.base - bf.baseOut, quote: exit.quote + (bf.reservesAfter.quote - post.q), virtualQuote: v }, bf.baseOut, mk(chargedBps));
        const bc = priceBuy(entry, NOTIONAL, mk(creditedBps));
        const sc = priceSell({ base: exit.base - bc.baseOut, quote: exit.quote + (bc.reservesAfter.quote - post.q), virtualQuote: v }, bc.baseOut, mk(creditedBps));
        rows.push({
          pool, day: new Date(post.ts * 1000).toISOString().slice(0, 10),
          depthSol: Number(post.q + v) / 1e9, cashback: false,
          fullBps: chargedBps, creditedBps, creatorBps,
          retFull: Number(sf.quoteOut - NOTIONAL) / Number(NOTIONAL),
          retCredited: Number(sc.quoteOut - NOTIONAL) / Number(NOTIONAL),
        });
      } catch (e) { if (!(e instanceof FillNotPriceable)) throw e; }
    }
  }
  byPool.clear();
  console.log(`  window ${w.from}..${w.to}  triggers ${rows.length}`);
}

// Cashback status, read from the Pool account and never inferred.
const pools = [...new Set(rows.map((r) => r.pool))];
console.log(`\n  distinct pools with triggers: ${pools.length}   resolving cashback flags…`);
const { rpc } = researchRpc(loadSecrets(), db);
let refused = 0;
for (let i = 0; i < pools.length; i += 1) {
  const p = pools[i];
  if (p === undefined) continue;
  try {
    const raw = await rpc.getAccountRaw(p);
    const a = poolAddressesFrom({ get: (k: string) => (k === p ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) }, p);
    if (a.isCashbackCoin === null || a.isCashbackCoin === undefined) { refused += 1; continue; }
    poolCash.set(p, a.isCashbackCoin);
  } catch { refused += 1; }
  if ((i + 1) % 100 === 0) console.log(`    ${i + 1}/${pools.length}`);
}
db.close();
for (const r of rows) r.cashback = poolCash.get(r.pool) ?? false;
const usable = rows.filter((r) => poolCash.has(r.pool));
console.log(`  pools resolved ${poolCash.size}   REFUSED ${refused}   usable triggers ${usable.length}\n`);

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number): string => (Number.isFinite(v) ? (100 * v).toFixed(3).padStart(9) : '      n/a');

const report = (label: string, sub: Row[]): void => {
  if (sub.length === 0) { console.log(`  ${label.padEnd(30)} no events`); return; }
  const days = new Set(sub.map((r) => r.day)).size;
  const pf = med(sub.map((r) => r.retFull));
  const pc = med(sub.map((r) => r.retCredited));
  const posF = sub.filter((r) => r.retFull > 0).length / sub.length;
  const posC = sub.filter((r) => r.retCredited > 0).length / sub.length;
  console.log(`  ${label.padEnd(30)} n=${String(sub.length).padStart(5)} days=${String(days).padStart(2)}  FULL ${F(pf)}% (${(100 * posF).toFixed(0)}% pos)   CREDITED ${F(pc)}% (${(100 * posC).toFixed(0)}% pos)   median creator ${med(sub.map((r) => r.creatorBps)).toFixed(1)} bps`);
};

console.log('THE TEST — same events, two cost models');
report('ALL', usable);
report('CASHBACK pools', usable.filter((r) => r.cashback));
report('NON-cashback (control)', usable.filter((r) => !r.cashback));
console.log('\nBY DEPTH, cashback pools only');
for (const [lab, lo, hi] of [['0-35 SOL', 0, 35], ['35-120', 35, 120], ['120-300', 120, 300], ['300+', 300, Infinity]] as const) {
  report(`  ${lab}`, usable.filter((r) => r.cashback && r.depthSol >= lo && r.depthSol < hi));
}
console.log('\nBY DEPTH, NON-cashback control');
for (const [lab, lo, hi] of [['120-300', 120, 300], ['300+', 300, Infinity]] as const) {
  report(`  ${lab}`, usable.filter((r) => !r.cashback && r.depthSol >= lo && r.depthSol < hi));
}
console.log('\n  PREREGISTERED READING: the credited arm counts only if the FULL arm stays negative,');
console.log('  the control stays negative, and the gap equals the creator component. A credited');
console.log('  arm that is positive while the control is too is NOT the rebate doing the work.');
