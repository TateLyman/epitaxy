/**
 * Read a token's LIVE bonding-curve state, so the MT171 strategy can be watched in real time.
 *
 * Everything measured so far is historical. MT171 says buying a curve near graduation and holding
 * through migration reaches the pool-opening seat, but acting on that needs to know where a curve is
 * RIGHT NOW - not where it was when the archive was cut. The BondingCurve account carries exactly
 * that, and it is a PDA of the mint, so no indexer and no stream is required to check one token.
 *
 * THE LAYOUT IS VALIDATED THE SAME WAY THE EVENT LAYOUT WAS, on the protocol's own constants rather
 * than on a document. Two independent checks have to pass on every account read:
 *
 *   real_sol_reserves must sit between 0 and about 85 SOL, because 85 is the graduation threshold
 *   and the curve cannot hold more than it takes to complete.
 *
 *   virtual_sol_reserves minus real_sol_reserves must equal 30.00 SOL, the initial virtual reserve.
 *   That was measured across the whole corpus at p10, p50 AND p90 in MT170, so it is not a fit - it
 *   is a constant of the program, and a wrong offset cannot reproduce it.
 *
 * A read that fails either check is REFUSED rather than reported, because a silently mis-decoded
 * reserve would put a position on at a price nobody quoted.
 *
 * Reads accounts. Signs nothing, sends nothing, spends nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { findProgramAddress } from '../packages/solana/src/pda.js';
import { base58Decode } from '../packages/solana/src/base58.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** Account layout after the 8-byte Anchor discriminator. */
const OFF = { vTok: 8, vSol: 16, rTok: 24, rSol: 32, supply: 40, complete: 48 };
/** The curve completes here. Measured max in the corpus was 85.01 SOL. */
const GRAD_SOL = 85;
/** Measured at p10, p50 and p90 alike in MT170. */
const INITIAL_VIRTUAL_SOL = 30;

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const MINTS = (arg('mints') ?? '').split(',').filter((s) => s.length > 0);
if (MINTS.length === 0) { console.log('need --mints=<mint,mint,...>'); process.exit(2); }

const secrets = await loadSecrets();
const url = secrets.rpcHttp ?? secrets.rpcHttpFallback ?? '';
if (url === '') { console.log('no RPC url configured'); process.exit(1); }

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error !== undefined) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
}

/** BondingCurve PDA: seeds are the literal "bonding-curve" and the mint. */
function curvePda(mint: string): string | null {
  const seedTag = new TextEncoder().encode('bonding-curve');
  const mintBytes = base58Decode(mint, 64);
  const found = findProgramAddress([seedTag, mintBytes], PUMP_PROGRAM);
  return found === null ? null : found.address;
}

console.log('LIVE BONDING-CURVE STATE');
console.log('');
console.log('  mint            curve account     real SOL   virtual SOL   progress   complete   check');
for (const mint of MINTS) {
  const pda = curvePda(mint);
  if (pda === null) { console.log(`  ${mint.slice(0, 12)}  PDA derivation failed`); continue; }
  let info: { value?: { data?: [string, string] } };
  try {
    info = (await rpc('getAccountInfo', [pda, { encoding: 'base64' }])) as { value?: { data?: [string, string] } };
  } catch (e) { console.log(`  ${mint.slice(0, 12)}  rpc error: ${(e as Error).message}`); continue; }
  const data = info.value?.data?.[0];
  if (data === undefined) { console.log(`  ${mint.slice(0, 12)}  ${pda.slice(0, 12)}  no account — never launched, or already migrated and closed`); continue; }
  const b = Buffer.from(data, 'base64');
  if (b.length < OFF.complete + 1) { console.log(`  ${mint.slice(0, 12)}  account too short (${b.length}B)`); continue; }
  const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
  const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
  const complete = b.readUInt8(OFF.complete) === 1;
  /** Both checks must pass or the read is refused rather than reported. */
  const boundsOk = rSol >= 0 && rSol <= GRAD_SOL * 1.05;
  const constOk = Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) < 0.01;
  const verdict = boundsOk && constOk ? 'ok' : `REFUSED (bounds ${boundsOk ? 'ok' : 'BAD'}, vSol-rSol=${(vSol - rSol).toFixed(3)})`;
  console.log(
    `  ${mint.slice(0, 12)}  ${pda.slice(0, 12)}  ${rSol.toFixed(2).padStart(9)}  ${vSol.toFixed(2).padStart(11)}  ${(100 * rSol / GRAD_SOL).toFixed(1).padStart(7)}%  ${String(complete).padStart(8)}   ${verdict}`,
  );
}
console.log('');
console.log(`  A read is only trusted when virtual SOL minus real SOL equals ${INITIAL_VIRTUAL_SOL}.00 exactly — the`);
console.log('  program constant MT170 measured at p10, p50 and p90 alike. A wrong offset cannot reproduce it.');
