/**
 * Find every bonding curve on pump.fun that is near graduation RIGHT NOW.
 *
 * This is the piece that makes MT171 operable. `curve-live-state.ts` answers "where is THIS token",
 * which is only useful once you already have a candidate; the strategy needs the opposite question -
 * "which tokens are about to migrate" - answered across the whole program, live, in a couple of
 * seconds.
 *
 * HOW IT IS DONE CHEAPLY. real_sol_reserves is a little-endian u64 at offset 32 of the BondingCurve
 * account. The graduation band we care about is roughly 70 to 85 SOL, and every value in that band
 * shares a property: byte 4 of the u64 - the byte at offset 36 - is one of exactly four values.
 *
 *   0x10 << 32 = 68.72 SOL          0x14 << 32 = 85.90 SOL
 *
 * So the four single-byte memcmp filters 0x10, 0x11, 0x12, 0x13 partition the ENTIRE near-graduation
 * population, and nothing outside it, into four getProgramAccounts calls. That works because a curve
 * physically cannot hold more than the ~85 SOL that completes it, which pins bytes 5 through 7 at
 * zero and makes byte 4 the whole high end of the number. Without this the call would have to return
 * every live curve on the program - hundreds of thousands of accounts - and would simply be refused.
 *
 * A RANGE QUERY BUILT OUT OF EQUALITY FILTERS IS STILL A RANGE QUERY, so the decoded reserve is
 * re-checked in JavaScript afterwards and anything outside the band is dropped. The memcmp is an
 * index, not a proof.
 *
 * EVERY ROW IS VALIDATED THE SAME WAY curve-live-state VALIDATES ONE. virtual_sol minus real_sol must
 * equal 30.00, the program's initial virtual reserve, measured at p10, p50 and p90 alike in MT170. A
 * row that fails is REFUSED rather than printed, because a mis-decoded reserve is exactly how a
 * position gets opened at a price nobody quoted.
 *
 * Reads accounts. Signs nothing, sends nothing, spends nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OFF = { vTok: 8, vSol: 16, rTok: 24, rSol: 32, supply: 40, complete: 48 };
const GRAD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;
/** Anchor account discriminator: sha256("account:BondingCurve")[0..8]. */
const DISCRIMINATOR = '17b7f83760d8ac60';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
/** curve-entry's own gate is 70%; scan a little wider so we can see what is coming. */
const MIN_PROGRESS = Number(arg('min-progress') ?? '70');
const TOP = Number(arg('top') ?? '25');

const secrets = await loadSecrets();
const url = secrets.rpcHttp ?? secrets.rpcHttpFallback ?? '';
if (url === '') { console.log('no RPC url configured'); process.exit(1); }

function b58encode(bytes: number[]): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out === '' ? '1' : out;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error !== undefined) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
}

type Acc = { pubkey: string; account: { data: [string, string] } };

console.log('CURVES NEAR GRADUATION — LIVE');
console.log('');

/** The four high-bytes that between them cover 68.72 to 85.90 SOL, and nothing else. */
const HIGH_BYTES = [0x10, 0x11, 0x12, 0x13];
const seen = new Map<string, { rSol: number; vSol: number; complete: boolean }>();
let refused = 0;

for (const hb of HIGH_BYTES) {
  let accs: Acc[];
  try {
    accs = (await rpc('getProgramAccounts', [PUMP_PROGRAM, {
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 0, bytes: b58encode([...Buffer.from(DISCRIMINATOR, 'hex')]) } },
        { memcmp: { offset: OFF.rSol + 4, bytes: b58encode([hb]) } },
        { memcmp: { offset: OFF.complete, bytes: b58encode([0]) } },
      ],
    }])) as Acc[];
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`  RPC refused the scan for high byte 0x${hb.toString(16)}: ${msg}`);
    console.log('');
    console.log('  getProgramAccounts is disabled on many free endpoints. This scan needs an endpoint');
    console.log('  that allows it — Helius paid, Triton, or a self-hosted node. Without it, feed known');
    console.log('  mints to curve-live-state.ts instead.');
    process.exit(1);
  }
  for (const a of accs) {
    const b = Buffer.from(a.account.data[0], 'base64');
    if (b.length < OFF.complete + 1) { refused++; continue; }
    const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
    const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
    const complete = b.readUInt8(OFF.complete) === 1;
    /** The memcmp was an index, not a proof — re-check the band and the program constant. */
    if (rSol < 0 || rSol > GRAD_SOL * 1.05) { refused++; continue; }
    if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) { refused++; continue; }
    seen.set(a.pubkey, { rSol, vSol, complete });
  }
}

const rows = [...seen.entries()]
  .map(([pda, v]) => ({ pda, ...v, progress: (100 * v.rSol) / GRAD_SOL }))
  .filter((r) => r.progress >= MIN_PROGRESS && !r.complete)
  .sort((a, b) => b.rSol - a.rSol);

console.log(`  ${seen.size} live curves decoded in the 68.7–85.9 SOL band, ${refused} refused on validation`);
console.log(`  ${rows.length} at or above ${MIN_PROGRESS}% of the ${GRAD_SOL} SOL threshold`);
console.log('');
if (rows.length === 0) {
  console.log('  Nothing in range right now. Graduations run roughly 600 a day, so a curve enters');
  console.log('  this band every few minutes — re-run shortly.');
  process.exit(0);
}
console.log('  curve account                                   real SOL   to go   progress');
for (const r of rows.slice(0, TOP)) {
  console.log(
    `  ${r.pda}  ${r.rSol.toFixed(2).padStart(8)}  ${(GRAD_SOL - r.rSol).toFixed(2).padStart(6)}  ${r.progress.toFixed(1).padStart(7)}%`,
  );
}
console.log('');
console.log('  These are CURVE ACCOUNTS, not mints. The curve is a PDA of the mint, so the map runs one');
console.log('  way only — resolve a mint with `getAccountInfo` on the curve and read its token account,');
console.log('  or take mints from a launch feed and check them with curve-live-state.ts.');
console.log('');
console.log('  Nothing here is a recommendation. curve-entry.ts re-checks every gate before it quotes.');
