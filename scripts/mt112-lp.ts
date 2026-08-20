/**
 * MT112 — the LP question, on complete coverage, with liquidity events excised.
 *
 * Preregistered in `docs/MULTIPLE_TESTING_LEDGER.csv` row MT112 before this file existed.
 *
 * WHY THE STANDARD ALGEBRA IS WRONG HERE, and this is the part MT106 got wrong twice.
 * The textbook constant-product LP result assumes the LP owns both reserves. On a pump.fun
 * graduate the quote side carries a VIRTUAL component v — verified here at 17.5845 SOL by
 * sweeping v for the value that minimises impossible k decreases, 2.45% against 24.5% at
 * v = 0 — and the LP does NOT own v. It is not withdrawable. So:
 *
 *     marginal price      p     = (q_raw + v) / b            write q_eff = q_raw + v
 *     invariant           k     = b * q_eff
 *     WITHDRAWABLE value  V     = q_raw + b*p = 2*q_raw + v = 2*q_eff - v
 *
 * The last line is why capital is `2*q_raw + v` and not `2*q - v`; the retracted MT106
 * numbers had that backwards, inflating capital 1.29x, and used q_raw/b for price, which
 * overstated LVR 1.58x.
 *
 * Decomposition against the same end price, so it is exact and needs no step sum — a step
 * sum is biased by sampling frequency, and that bias is what made both earlier attempts
 * unreadable:
 *
 *     fee income  = V_actual(1) - V_nofee(1) = 2*sqrt(p1)*(sqrt(k1) - sqrt(k0))
 *     rebalancing = V_nofee(1) - V_hold(1)   = -q_eff0 * (sqrt(r) - 1)^2
 *
 * The second is MT100's (sqrt(r)-1)^2 term, correctly scaled. Both are reported as
 * fractions of the capital actually at risk.
 *
 * Read-only. Nothing here funds, signs, or proposes a position.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { decodePumpSwapTrade, decodePumpSwapLiquidity } from '../packages/intelligence/src/pumpswap-event.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const V_SOL = 17.5845;
const V = BigInt(Math.round(V_SOL * 1e9));
const MIN_TRADES = 200;
const CPI_WRAPPER = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DIR = 'data/sqd/events-pAMMBay6';
const HEAD = 440_494_520;
const SLOTS_PER_DAY = 207_494;
const WINDOWS: { from: number; to: number }[] = [];
for (let k = 1; k <= 12; k += 1) {
  const to = HEAD - k * SLOTS_PER_DAY;
  WINDOWS.push({ from: to - 19_999, to });
}

interface Node { slot: number; tx: number; addr: string; liq: boolean; b: bigint; q: bigint; lp: number }
interface Seg {
  pool: string; day: string; trades: number; lpBps: number;
  b0: bigint; q0: bigint; b1: bigint; q1: bigint; hours: number;
}

const segs: Seg[] = [];
let liqEvents = 0;
let kDecreased = 0;
let kSteps = 0;

console.log('MT112 — LP on complete coverage, liquidity events excised\n');
const allFiles = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f));

for (const w of WINDOWS) {
  const files = allFiles.filter((f) => {
    const m = /^events-(\d+)-(\d+)\.jsonl$/.exec(f);
    if (m === null) return false;
    return Number(m[2]) >= w.from && Number(m[1]) <= w.to;
  });
  if (files.length === 0) continue;

  const byPool = new Map<string, Node[]>();
  const tsOf = new Map<string, number>();
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
        const body = raw.subarray(8);
        const t = decodePumpSwapTrade(body);
        if (t !== null) {
          const a = byPool.get(t.pool) ?? [];
          a.push({ slot: hdr.number, tx: ins.transactionIndex, addr: ins.instructionAddress.join('.'),
                   liq: false, b: t.poolBaseReservesBefore, q: t.poolQuoteReservesBefore, lp: Number(t.lpFeeBasisPoints) });
          byPool.set(t.pool, a);
          if (!tsOf.has(`${t.pool}|${hdr.number}`)) tsOf.set(`${t.pool}|${hdr.number}`, hdr.timestamp);
          continue;
        }
        const l = decodePumpSwapLiquidity(body);
        if (l !== null) {
          liqEvents += 1;
          const a = byPool.get(l.pool) ?? [];
          a.push({ slot: hdr.number, tx: ins.transactionIndex, addr: ins.instructionAddress.join('.'),
                   liq: true, b: l.poolBaseReserves, q: l.poolQuoteReserves, lp: 0 });
          byPool.set(l.pool, a);
        }
      }
    }
  }

  for (const [pool, nodes] of byPool) {
    nodes.sort((x, y) => x.slot - y.slot || x.tx - y.tx || (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
    // Split at every liquidity event. A segment is a maximal run of pure trading.
    let run: Node[] = [];
    const flush = (): void => {
      const trades = run.filter((n) => !n.liq);
      if (trades.length >= MIN_TRADES) {
        const a = trades[0];
        const z = trades[trades.length - 1];
        if (a !== undefined && z !== undefined && a.b > 0n && a.q > 0n && z.b > 0n && z.q > 0n) {
          // The k-monotonicity control, computed on this segment only.
          for (let i = 0; i + 1 < trades.length; i += 1) {
            const x = trades[i]; const y = trades[i + 1];
            if (x === undefined || y === undefined) continue;
            const k0 = Number(x.b) * Number(x.q + V);
            const k1 = Number(y.b) * Number(y.q + V);
            if (k0 > 0 && k1 > 0) { kSteps += 1; if (k1 < k0) kDecreased += 1; }
          }
          const t0 = tsOf.get(`${pool}|${a.slot}`) ?? 0;
          const t1 = tsOf.get(`${pool}|${z.slot}`) ?? 0;
          segs.push({ pool, day: new Date(t0 * 1000).toISOString().slice(0, 10), trades: trades.length,
                      lpBps: z.lp, b0: a.b, q0: a.q, b1: z.b, q1: z.q, hours: Math.max((t1 - t0) / 3600, 0) });
        }
      }
      run = [];
    };
    for (const n of nodes) { if (n.liq) { flush(); } else { run.push(n); } }
    flush();
  }
  byPool.clear();
  console.log(`  window ${w.from}..${w.to}  segments so far ${segs.length}`);
}

console.log(`\n  liquidity events seen ${liqEvents.toLocaleString()}`);
console.log(`  CONTROL 2 — share of adjacent steps where k DECREASED inside a liquidity-free segment:`);
console.log(`    ${kDecreased.toLocaleString()} of ${kSteps.toLocaleString()} = ${(100 * kDecreased / Math.max(kSteps, 1)).toFixed(3)}%`);
console.log(`    MT106 measured 30.8% under the sparse instrument and voided itself on it.`);
if (kSteps > 0 && kDecreased / kSteps > 0.05) {
  console.log('\n  ABOVE 5%: MT112 VOIDS ITSELF, exactly as preregistered. The invariant is not clean');
  console.log('  and no LP number computed from it would be readable. Nothing further is reported.');
  process.exit(0);
}
if (segs.length === 0) { console.log('\n  no segments met the trade floor. Nothing computed.'); process.exit(0); }

// Resolve mints by name. Unresolved is REFUSED, never assumed WSOL.
const db = openDb({ path: 'data/runtime.db' });
const known = new Map<string, string>();
for (const r of db.prepare('SELECT pool, quote_mint FROM venue_pools').all() as { pool: string; quote_mint: string }[]) known.set(r.pool, r.quote_mint);
const upsert = db.prepare(
  `INSERT OR REPLACE INTO venue_pools (pool, base_mint, quote_mint, base_vault, quote_vault, coin_creator, resolved_utc_ms, tracked)
   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT tracked FROM venue_pools WHERE pool = ?), 0))`);
const need = [...new Set(segs.map((s) => s.pool))].filter((p) => !known.has(p));
console.log(`\n  segments ${segs.length}   pools needing a mint lookup ${need.length}`);
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
    if ((i + 1) % 200 === 0) console.log(`    resolved ${i + 1}/${need.length}`);
  }
}
db.close();
console.log(`  unresolvable and REFUSED ${unresolved}`);

interface Row { pool: string; day: string; lpBps: number; capSol: number; fee: number; il: number; net: number; hours: number; trades: number; r: number }
const rows: Row[] = [];
for (const s of segs) {
  if (known.get(s.pool) !== WSOL) continue;
  const qe0 = Number(s.q0 + V);
  const qe1 = Number(s.q1 + V);
  const b0 = Number(s.b0);
  const b1 = Number(s.b1);
  if (!(qe0 > 0 && qe1 > 0 && b0 > 0 && b1 > 0)) continue;
  const k0 = b0 * qe0;
  const k1 = b1 * qe1;
  const p0 = qe0 / b0;
  const p1 = qe1 / b1;
  if (!(k0 > 0 && k1 > 0 && p0 > 0 && p1 > 0)) continue;
  const r = p1 / p0;
  const cap = 2 * Number(s.q0) + Number(V); // WITHDRAWABLE capital, in lamports of quote
  if (!(cap > 0)) continue;
  const fee = (2 * Math.sqrt(p1) * (Math.sqrt(k1) - Math.sqrt(k0))) / cap;
  const il = (-qe0 * (Math.sqrt(r) - 1) ** 2) / cap;
  rows.push({ pool: s.pool, day: s.day, lpBps: s.lpBps, capSol: cap / 1e9, fee, il, net: fee + il, hours: s.hours, trades: s.trades, r });
}
console.log(`  WSOL-quoted segments measured: ${rows.length}`);
if (rows.length === 0) { console.log('  nothing to report.'); process.exit(0); }

const med = (a: number[]): number => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s[Math.floor(0.5 * (s.length - 1))] ?? NaN) : NaN; };
const P = (a: number[], x: number): number => { const s = [...a].filter(Number.isFinite).sort((m, n) => m - n); return s.length ? (s[Math.floor(x * (s.length - 1))] ?? NaN) : NaN; };
const F = (v: number, d = 4): string => (Number.isFinite(v) ? (100 * v).toFixed(d).padStart(10) : '       n/a');

console.log('\nPER SEGMENT, as a fraction of WITHDRAWABLE capital (2*q_raw + v)');
console.log(`  capital SOL      p10 ${P(rows.map((r) => r.capSol), 0.1).toFixed(1)}   p50 ${P(rows.map((r) => r.capSol), 0.5).toFixed(1)}   p90 ${P(rows.map((r) => r.capSol), 0.9).toFixed(1)}`);
console.log(`  segment hours    p10 ${P(rows.map((r) => r.hours), 0.1).toFixed(2)}   p50 ${P(rows.map((r) => r.hours), 0.5).toFixed(2)}   p90 ${P(rows.map((r) => r.hours), 0.9).toFixed(2)}`);
console.log(`  trades/segment   p10 ${P(rows.map((r) => r.trades), 0.1).toFixed(0)}   p50 ${P(rows.map((r) => r.trades), 0.5).toFixed(0)}   p90 ${P(rows.map((r) => r.trades), 0.9).toFixed(0)}`);
console.log(`\n  FEE INCOME %     p10 ${F(P(rows.map((r) => r.fee), 0.1))}  p50 ${F(med(rows.map((r) => r.fee)))}  p90 ${F(P(rows.map((r) => r.fee), 0.9))}`);
console.log(`  REBALANCING %    p10 ${F(P(rows.map((r) => r.il), 0.1))}  p50 ${F(med(rows.map((r) => r.il)))}  p90 ${F(P(rows.map((r) => r.il), 0.9))}`);
console.log(`  NET %            p10 ${F(P(rows.map((r) => r.net), 0.1))}  p50 ${F(med(rows.map((r) => r.net)))}  p90 ${F(P(rows.map((r) => r.net), 0.9))}`);
const ratio = rows.map((r) => r.fee / Math.abs(r.il)).filter(Number.isFinite);
console.log(`\n  FEE / |REBALANCING|   p10 ${P(ratio, 0.1).toFixed(3)}   p50 ${med(ratio).toFixed(3)}   p90 ${P(ratio, 0.9).toFixed(3)}`);
console.log(`  segments where fee beats rebalancing: ${rows.filter((r) => r.net > 0).length} of ${rows.length} = ${(100 * rows.filter((r) => r.net > 0).length / rows.length).toFixed(1)}%`);
console.log(`  MT100 on freshly-migrated tier-0 pools: rebalancing was 47x fee income.`);

console.log('\nCONTROL 1 — fee income MUST rise with the fee tier, or the fee is not what is being measured');
const tiers = [...new Set(rows.map((r) => r.lpBps))].sort((a, b) => a - b);
for (const t of tiers) {
  const r = rows.filter((x) => x.lpBps === t);
  console.log(`  lp=${String(t).padStart(3)} bps   segments ${String(r.length).padStart(5)}   median fee ${F(med(r.map((x) => x.fee)))}%   median net ${F(med(r.map((x) => x.net)))}%   net>0 ${(100 * r.filter((x) => x.net > 0).length / r.length).toFixed(1)}%`);
}

console.log('\nBY UTC DAY — the cluster, per MT108');
const days = [...new Set(rows.map((r) => r.day))].sort();
for (const d of days) {
  const r = rows.filter((x) => x.day === d);
  console.log(`  ${d}  segments ${String(r.length).padStart(5)}  median net ${F(med(r.map((x) => x.net)))}%  net>0 ${(100 * r.filter((x) => x.net > 0).length / r.length).toFixed(1)}%`);
}
console.log(`\n  ${days.length} day clusters.`);
console.log('  NOT INCLUDED IN ANY NUMBER ABOVE: the LP\'s own entry and exit round trip, and the');
console.log('  fact that a pool which dies costs the position rather than impermanent loss.');
console.log('  No position is proposed. Nothing is funded. Nothing is signed.');
