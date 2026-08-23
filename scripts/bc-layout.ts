/**
 * Verify the pump.fun bonding-curve TradeEvent layout against our own chain data before trusting it.
 *
 * A published IDL gives the field order as mint, sol_amount, token_amount, is_buy, user, timestamp,
 * virtual_sol_reserves, virtual_token_reserves, real_sol_reserves, real_token_reserves. Walking the
 * widths puts mint at 8, sol_amount at 40, token_amount at 48, is_buy at 56, user at 57, timestamp
 * at 89, vSOL at 97, vToken at 105, realSOL at 113 and realToken at 121, for a 129-byte payload.
 *
 * THAT IS AN ASSUMPTION UNTIL IT REPRODUCES SOMETHING WE KNOW INDEPENDENTLY, and this session has
 * already caught two published sources disagreeing about CreatePoolEvent - one of which was simply
 * wrong. So the layout is checked three ways that do not depend on the document:
 *
 *   THE INVARIANT. On this curve the product of the virtual reserves is conserved, so
 *   vSOL * vToken should be near-constant across every trade of the same mint. If the two offsets
 *   are right the ratio is ~1.0; if they are swapped or shifted it is not.
 *
 *   THE ARITHMETIC. A buy must move the reserves in the right direction and by the traded amount:
 *   vSOL should rise by sol_amount and vToken fall by token_amount, and the reverse on a sell.
 *
 *   THE BOUNDS. real_sol_reserves is the number the graduation threshold is defined on, so across
 *   many mints it should live between zero and roughly 85 SOL and never exceed it by much.
 *
 * Read-only. Proposes nothing, funds nothing, signs nothing.
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58DecodeBulk, base58Encode } from '../packages/solana/src/base58.js';

const DIR = 'data/sqd/events-6EF8rrec';
const CPI = Buffer.from('e445a52e51cb9a1d', 'hex');
/**
 * Anchor derives an event discriminator as sha256('event:' + Name).slice(0,8). The derivation is
 * validated rather than assumed: for pump_amm it reproduces b1310cd2a076a774 for CreatePoolEvent,
 * which is the constant already hard-coded in create-pool-mint-offsets.ts. The bonding-curve program
 * emits several event types - payload lengths of 359, 358, 80 and 373 bytes appear in one file - so
 * decoding every emit_cpi as a TradeEvent produced a real_sol_reserves maximum of 18 BILLION SOL.
 */
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const OFF = { mint: 8, sol: 40, token: 48, isBuy: 56, user: 57, ts: 89, vSol: 97, vTok: 105, rSol: 113, rTok: 121 };
const NEED = 129;

if (!existsSync(DIR)) { console.log('no bonding-curve data yet'); process.exit(1); }
const files = readdirSync(DIR).filter((f) => /^events-\d+-\d+\.jsonl$/.test(f)).sort();
if (files.length === 0) { console.log('no complete files yet'); process.exit(1); }

interface T { mint: string; sol: bigint; tok: bigint; buy: boolean; vSol: bigint; vTok: bigint; rSol: bigint; rTok: bigint }
const rows: T[] = [];
const lens = new Map<number, number>();
const rl = createInterface({ input: createReadStream(`${DIR}/${files[0] as string}`, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0 || rows.length >= 60000) continue;
  let blk: { instructions?: { data: string }[] };
  try { blk = JSON.parse(line) as { instructions?: { data: string }[] }; } catch { continue; }
  for (const i of blk.instructions ?? []) {
    let raw: Buffer;
    try { raw = Buffer.from(base58DecodeBulk(i.data, 4096)); } catch { continue; }
    if (raw.length < 16 || !raw.subarray(0, 8).equals(CPI)) continue;
    const b = raw.subarray(8);
    if (!b.subarray(0, 8).equals(TRADE_EVENT)) continue;
    lens.set(b.length, (lens.get(b.length) ?? 0) + 1);
    if (b.length < NEED) continue;
    rows.push({
      mint: base58Encode(b.subarray(OFF.mint, OFF.mint + 32)),
      sol: b.readBigUInt64LE(OFF.sol),
      tok: b.readBigUInt64LE(OFF.token),
      buy: b.readUInt8(OFF.isBuy) === 1,
      vSol: b.readBigUInt64LE(OFF.vSol),
      vTok: b.readBigUInt64LE(OFF.vTok),
      rSol: b.readBigUInt64LE(OFF.rSol),
      rTok: b.readBigUInt64LE(OFF.rTok),
    });
  }
}
rl.close();

console.log(`${files[0] as string}`);
console.log(`  payload lengths seen: ${[...lens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, c]) => `${l}B x${c}`).join(', ')}`);
console.log(`  decoded ${rows.length.toLocaleString()} TradeEvents`);
if (rows.length === 0) process.exit(0);

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

/** CHECK 1 — the virtual invariant. */
const k = rows.filter((r) => r.vSol > 0n && r.vTok > 0n).map((r) => Number(r.vSol) * Number(r.vTok));
console.log('');
console.log(`  CHECK 1  vSOL * vToken   p05 ${q(k, 0.05).toExponential(4)}  median ${q(k, 0.5).toExponential(4)}  p95 ${q(k, 0.95).toExponential(4)}`);
console.log(`           spread p95/p05 = ${(q(k, 0.95) / q(k, 0.05)).toFixed(3)}   (a conserved product sits near 1.0)`);

/** CHECK 2 — reserves must be in SOL-sized and token-sized ranges. */
const vs = rows.map((r) => Number(r.vSol) / 1e9);
const rs = rows.map((r) => Number(r.rSol) / 1e9);
console.log('');
console.log(`  CHECK 2  virtual SOL reserves (SOL)  p05 ${q(vs, 0.05).toFixed(2)}  median ${q(vs, 0.5).toFixed(2)}  p95 ${q(vs, 0.95).toFixed(2)}`);
console.log(`           REAL SOL reserves (SOL)     p05 ${q(rs, 0.05).toFixed(2)}  median ${q(rs, 0.5).toFixed(2)}  p95 ${q(rs, 0.95).toFixed(2)}  max ${Math.max(...rs).toFixed(2)}`);
console.log(`           (graduation is defined near 85 SOL of real reserves, so the max should sit close to it)`);

/** CHECK 3 — direction: a buy raises virtual SOL by sol_amount. */
const byMint = new Map<string, T[]>();
for (const r of rows) { const a = byMint.get(r.mint) ?? []; a.push(r); byMint.set(r.mint, a); }
let agree = 0; let tested = 0;
for (const [, a] of byMint) {
  for (let i = 1; i < a.length; i += 1) {
    const p = a[i - 1] as T; const c = a[i] as T;
    tested += 1;
    const dv = Number(c.vSol) - Number(p.vSol);
    const expect = c.buy ? Number(c.sol) : -Number(c.sol);
    if (Math.abs(dv - expect) < Math.max(1e6, Math.abs(expect) * 0.02)) agree += 1;
  }
}
console.log('');
console.log(`  CHECK 3  vSOL moved by sol_amount in the traded direction: ${tested > 0 ? (100 * agree / tested).toFixed(1) : 'n/a'}% of ${tested.toLocaleString()} consecutive pairs`);
console.log(`  distinct mints in sample: ${byMint.size.toLocaleString()}`);
console.log('');
console.log('  All three must pass before this layout is used. A field order taken from a document and');
console.log('  never checked is an assumption, and this session has already caught two that disagreed.');
