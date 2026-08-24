/**
 * Does the corrected concentration reading actually differ from the broken one?
 *
 * The live filter divided the top ten holders by the sum of the twenty accounts
 * `getTokenLargestAccounts` returns. That cap is the defect: the ratio was the top ten's share of
 * the top TWENTY, which is forced above 50% arithmetically regardless of how the token is held, so
 * the lower half of the 50-80% band could never fire and the upper bound screened a statistic
 * MT189 never validated. Every live reading came back between 59% and 76%, exactly the range that
 * construction produces.
 *
 * The corrected reading divides by CIRCULATING supply - token_total_supply minus the unsold
 * inventory still in the curve's vault, both carried by the BondingCurve account. This prints both
 * side by side on live curves so the difference is visible rather than argued.
 *
 * Reads accounts. Signs nothing, sends nothing.
 */
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CURVE = { vTok: 8, vSol: 16, rTok: 24, rSol: 32, supply: 40, complete: 48 };

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const READS = (arg('reads') ?? 'https://solana-rpc.publicnode.com,https://rpc.solanatracker.io/public').split(',');
const MINTS = (arg('mints') ?? '').split(',').filter((x) => x.length > 0);

async function readRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (const url of READS) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { result?: T; error?: unknown };
      if (j.error !== undefined || j.result === undefined) continue;
      return j.result;
    } catch { /* next endpoint */ }
  }
  return null;
}

/** Curves currently in or near the entry band, found from the live feed if none are given. */
async function liveCandidates(seconds: number): Promise<string[]> {
  const { base58Encode } = await import('../packages/solana/src/base58.js');
  const found = new Set<string>();
  await new Promise<void>((resolve) => {
    const sock = new WebSocket('wss://rpc.solanatracker.io/public');
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
    });
    sock.addEventListener('message', (ev: MessageEvent) => {
      let m: { params?: { result?: { value?: { logs?: string[] } } } };
      try { m = JSON.parse(String(ev.data)) as typeof m; } catch { return; }
      for (const line of m.params?.result?.value?.logs ?? []) {
        if (!line.startsWith('Program data:')) continue;
        let b: Buffer;
        try { b = Buffer.from(line.slice(13).trim(), 'base64'); } catch { continue; }
        if (b.length < 121 || b.subarray(0, 8).toString('hex') !== 'bddb7fd34ee661ee') continue;
        const vSol = Number(b.readBigUInt64LE(97)) / 1e9;
        const rSol = Number(b.readBigUInt64LE(113)) / 1e9;
        if (Math.abs(vSol - rSol - 30) >= 0.01) continue;
        if (rSol < 40 || rSol > 80) continue;
        found.add(base58Encode(b.subarray(8, 40)));
        if (found.size >= 6) { try { sock.close(); } catch { /* closing */ } resolve(); return; }
      }
    });
    sock.addEventListener('error', () => { resolve(); });
    setTimeout(() => { try { sock.close(); } catch { /* closing */ } resolve(); }, seconds * 1000);
  });
  return [...found];
}

const mints = MINTS.length > 0 ? MINTS : await liveCandidates(Number(arg('watch') ?? '25'));
console.log(`CONCENTRATION, OLD MATH vs CORRECTED, on ${mints.length} live curves`);
console.log('');
console.log('  mint          reserves   holders   OLD (top10/top20)   CORRECTED (top10/circulating)');
for (const mint of mints) {
  const largest = await readRpc<{ value?: { address: string; amount: string }[] }>('getTokenLargestAccounts', [mint]);
  const rows = largest?.value ?? [];
  if (rows.length === 0) { console.log(`  ${mint.slice(0, 12)}  no largest-accounts answer`); continue; }
  const found = findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(mint, 64)], PUMP);
  if (found === null) continue;
  const acc = await readRpc<{ value?: { data?: [string, string] } }>('getAccountInfo', [found.address, { encoding: 'base64' }]);
  const data = acc?.value?.data?.[0];
  if (data === undefined) { console.log(`  ${mint.slice(0, 12)}  no curve account`); continue; }
  const cb = Buffer.from(data, 'base64');
  if (cb.length < CURVE.complete + 1) continue;
  const totalSupply = Number(cb.readBigUInt64LE(CURVE.supply));
  const vaultHeld = Number(cb.readBigUInt64LE(CURVE.rTok));
  const rSol = Number(cb.readBigUInt64LE(CURVE.rSol)) / 1e9;
  const circulating = totalSupply - vaultHeld;

  const all = rows.map((r) => Number(r.amount)).filter((v) => v > 0).sort((a, b) => b - a);
  const oldSupply = all.reduce((a, b) => a + b, 0);
  const oldTop10 = oldSupply > 0 ? (100 * all.slice(0, 10).reduce((a, b) => a + b, 0)) / oldSupply : NaN;

  const held = all.filter((v) => v !== vaultHeld);
  const newTop10 = circulating > 0 ? (100 * held.slice(0, 10).reduce((a, b) => a + b, 0)) / circulating : NaN;

  console.log(
    `  ${mint.slice(0, 12)}  ${rSol.toFixed(1).padStart(8)}  ${String(held.length).padStart(7)}   ` +
    `${oldTop10.toFixed(1).padStart(17)}   ${newTop10.toFixed(1).padStart(29)}`,
  );
}
console.log('');
console.log('  The old column cannot fall below 50 by construction. If the corrected column spans a wider');
console.log('  range, the 50-80% band is finally screening the quantity MT189 measured.');
