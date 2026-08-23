/**
 * Can the aggregator route to a pump.fun BONDING CURVE, or only to the post-migration AMM?
 *
 * MT171 replicated across three corpora: buying a curve near graduation and holding through
 * migration reaches the pool-opening seat MT169 proved unreachable by racing. Testing that live
 * needs a curve BUY, and the architecture turns entirely on this question.
 *
 * If the aggregator quotes a token that is still on its curve, the trade runs through
 * `buildSignableOrder` and the existing signer - policy, binding and effect unchanged. If it does
 * not, a curve buy means constructing a pump.fun instruction by hand and widening the transaction
 * policy to accept a program it has never seen, which is a change to the one part of this
 * repository that must never be loosened for convenience. That is not a step to take for a test.
 *
 * Quotes only. Signs nothing, sends nothing, spends nothing.
 */
import { loadSecrets } from '../packages/domain/src/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const MINTS = (process.argv.find((a) => a.startsWith('--mints='))?.slice(8) ?? '').split(',').filter((s) => s.length > 0);
const secrets = await loadSecrets();
const JH: Record<string, string> = secrets.jupiterApiKey ? { 'x-api-key': secrets.jupiterApiKey } : {};

async function quote(inMint: string, outMint: string, amount: bigint): Promise<{ out: bigint; labels: string[] } | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amount.toString(), slippageBps: '300' });
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const res = await fetch(`https://api.jup.ag/swap/v2/order?${qs.toString()}`, { headers: JH, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
    if (j.outAmount === undefined) return null;
    return { out: BigInt(j.outAmount), labels: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?') };
  } catch { return null; }
}

console.log('CURVE ROUTE PROBE — can we buy a token that is still on its bonding curve?');
console.log('');
console.log('  mint            buy 0.02 SOL      route                          sell back      round trip');
for (const m of MINTS) {
  const a = await quote(WSOL, m, 20_000_000n);
  if (a === null || a.out <= 0n) { console.log(`  ${m.slice(0, 12)}  NO BUY QUOTE — not routable`); continue; }
  const b = await quote(m, WSOL, a.out);
  const rt = b === null || b.out <= 0n ? null : 1e4 * (1 - Number(b.out) / 20_000_000);
  console.log(
    `  ${m.slice(0, 12)}  ${a.out.toString().padStart(16)}  ${a.labels.join('>').padEnd(28)}  ${(b === null ? 'none' : b.out.toString()).padStart(14)}  ${rt === null ? '   n/a' : rt.toFixed(0).padStart(6) + ' bps'}`,
  );
}
console.log('');
console.log('  A "Pump.fun" label without "Amm" is the bonding curve. "Pump.fun Amm" is post-migration,');
console.log('  which would mean the token has already graduated and is the wrong test.');
