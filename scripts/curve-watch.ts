/**
 * Watch every pump.fun bonding curve in real time and report the ones entering the graduation band.
 *
 * This is the discovery half of MT171. `curve-entry.ts` can check a mint you already have;
 * `curve-live-state.ts` can check a list. Neither answers the question the strategy actually runs
 * on, which is "which curve is about to migrate, right now".
 *
 * WHY NOT SCAN ACCOUNTS. The obvious approach is getProgramAccounts with a memcmp on
 * real_sol_reserves. It does not work and the reason is worth keeping: pump.fun has over ten million
 * accounts, plain getProgramAccounts is refused outright at that size, and getProgramAccountsV2
 * paginates with a limit that bounds accounts SCANNED rather than matched - so a full sweep is on
 * the order of a thousand requests and takes minutes. A curve can cross from 70 SOL to graduation
 * inside that window, which makes the scan structurally incapable of seeing the thing it is for.
 *
 * WHAT THIS DOES INSTEAD. Every curve trade emits a TradeEvent carrying the post-trade reserves, and
 * pump.fun writes it to the transaction log as `Program data:`. So the reserves arrive as a
 * CONSEQUENCE of the trade rather than being polled for, one websocket subscription covers the whole
 * program, and there is no round trip per trade. Discovery becomes free and immediate.
 *
 * THE 30.00 CHECK DOES TWO JOBS AT ONCE, which is why it is the only validation here.
 *
 *   It proves the decode. virtual minus real must equal the program's initial virtual reserve, a
 *   constant measured at p10, p50 and p90 alike in MT170. A wrong offset cannot reproduce it.
 *
 *   It selects the instrument. pump.fun now supports curves quoted in mints other than SOL, whose
 *   initial virtual reserve comes from a Global config and is NOT 30. MT171 was measured on
 *   SOL-quoted curves and says nothing whatever about the others, so a curve that fails this check
 *   is not a decode failure to investigate - it is a different product, and it is dropped.
 *
 * Reads a websocket. Signs nothing, sends nothing, spends nothing. Nothing it prints is a
 * recommendation: curve-entry.ts re-reads the account and re-checks every gate before it quotes.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { base58Encode } from '../packages/solana/src/base58.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_EVENT = 'bddb7fd34ee661ee';
/** Offsets into the TradeEvent payload, byte 0 being its discriminator. */
const OFF = { mint: 8, vSol: 97, rSol: 113 };
const GRAD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;
const PREFIX = 'Program data:';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
/** curve-entry's own gate is 70%. Watch a little below it so a candidate is visible before it arrives. */
const MIN_PROGRESS = Number(arg('min-progress') ?? '70');
const RUN_SECONDS = Number(arg('seconds') ?? '0');

const secrets = await loadSecrets();
const ws = secrets.rpcWs;
if (ws === null || ws === '') { console.log('no websocket endpoint configured'); process.exit(1); }

console.log('CURVE WATCH — live pump.fun graduation band');
console.log(`  reporting curves at or above ${MIN_PROGRESS}% of the ${GRAD_SOL} SOL threshold`);
console.log('');

/** Highest progress each mint has been seen at, so a candidate is announced once rather than per trade. */
const peak = new Map<string, number>();
let trades = 0;
let nonSol = 0;
let graduated = 0;
const started = Date.now();

const sock = new WebSocket(ws);

sock.addEventListener('open', () => {
  sock.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }],
  }));
});

sock.addEventListener('message', (ev: MessageEvent) => {
  let msg: { params?: { result?: { value?: { logs?: string[] } } } };
  try { msg = JSON.parse(String(ev.data)) as typeof msg; } catch { return; }
  const logs = msg.params?.result?.value?.logs;
  if (logs === undefined) return;

  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    let b: Buffer;
    try { b = Buffer.from(line.slice(PREFIX.length).trim(), 'base64'); } catch { continue; }
    if (b.length < OFF.rSol + 8) continue;
    if (b.subarray(0, 8).toString('hex') !== TRADE_EVENT) continue;

    const vSol = Number(b.readBigUInt64LE(OFF.vSol)) / 1e9;
    const rSol = Number(b.readBigUInt64LE(OFF.rSol)) / 1e9;
    /** Proves the decode AND selects SOL-quoted curves. See the note above. */
    if (Math.abs(vSol - rSol - INITIAL_VIRTUAL_SOL) >= 0.01) { nonSol++; continue; }

    trades++;
    const mint = base58Encode(b.subarray(OFF.mint, OFF.mint + 32));
    const progress = (100 * rSol) / GRAD_SOL;
    const was = peak.get(mint) ?? 0;
    if (progress <= was) continue;
    peak.set(mint, progress);

    if (was < MIN_PROGRESS && progress >= MIN_PROGRESS) {
      const el = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  [+${el}s] ${mint}   ${rSol.toFixed(2)} SOL   ${progress.toFixed(1)}%   ${(GRAD_SOL - rSol).toFixed(2)} to go`);
    }
    if (progress >= 100 && was < 100) { graduated++; console.log(`  [GRADUATED] ${mint}`); }
  }
});

sock.addEventListener('error', () => { console.log('  websocket error'); });
sock.addEventListener('close', () => { console.log('  websocket closed'); report(); process.exit(0); });

function report(): void {
  const el = (Date.now() - started) / 1000;
  const band = [...peak.values()].filter((p) => p >= MIN_PROGRESS).length;
  console.log('');
  console.log(`  ${el.toFixed(0)}s: ${trades.toLocaleString()} SOL-quoted curve trades over ${peak.size.toLocaleString()} mints`);
  console.log(`  ${nonSol.toLocaleString()} events dropped as non-SOL-quoted or undecodable`);
  console.log(`  ${band} mints reached ${MIN_PROGRESS}%, ${graduated} graduated while watching`);
}

if (RUN_SECONDS > 0) {
  setTimeout(() => { report(); sock.close(); process.exit(0); }, RUN_SECONDS * 1000);
}
process.on('SIGINT', () => { report(); process.exit(0); });
