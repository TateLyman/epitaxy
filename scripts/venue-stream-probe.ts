/**
 * `pnpm venue:probe` — can we read the whole PumpSwap tape for free?
 *
 * MT101 watches 128 wallets because a POLLED source costs one RPC call per
 * wallet per sweep and the shared endpoint budget is 8 req/s. That framing
 * assumes the watchlist has to be pushed to the provider. It does not.
 *
 * `BuyEvent` in the pump_amm IDL carries `user: pubkey` — the trader — along
 * with `pool`, `quote_amount_in`, the pool reserves AFTER the trade, and the
 * whole fee ladder including `lp_fee_basis_points` and
 * `coin_creator_fee_basis_points`. If that event reaches the transaction LOGS,
 * then one `logsSubscribe` on the program returns every buy on the venue, and
 * the watchlist is matched LOCALLY against a Set of any size. 128 becomes
 * 21,123, or 211,225, at no cost, with no per-wallet subscription and no
 * `getTransaction` per event.
 *
 * THREE THINGS COULD MAKE THAT FALSE, AND THIS PROBES ALL THREE.
 *
 *   1. Anchor's `emit_cpi!` puts an event in a self-CPI instruction, NOT in the
 *      logs. Only `emit!` produces a `Program data:` log line. Which one
 *      pump_amm uses is not in the IDL and is not worth guessing.
 *   2. The runtime truncates long log arrays. A venue whose events are present
 *      but truncated on the busiest transactions is worse than useless, because
 *      the losses would correlate with exactly the moments that matter.
 *   3. The public endpoint may refuse or drop a program-wide subscription.
 *      TARGETED_FLOW_V1 measured 219 messages a second on Pump plus PumpSwap
 *      and the previous build died of it — but it died of CREDITS on a metered
 *      endpoint, and `api.mainnet-beta.solana.com` is not metered. Whether it
 *      SUSTAINS the subscription is a different question and is measured here.
 *
 * This is read-only and costs nothing. It opens no position, writes to no
 * capital-bearing table, and imports no execution code.
 */
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { base58Encode } from '../packages/solana/src/base58.js';
import { MT101 } from '../packages/intelligence/src/wallet-watchlist.js';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ENDPOINT = process.env['VENUE_WS'] ?? 'wss://api.mainnet-beta.solana.com';
const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? '90');

const idl = JSON.parse(
  readFileSync('node_modules/@pump-fun/pump-swap-sdk/src/idl/pump_amm.json', 'utf8'),
) as { events: { name: string; discriminator: number[] }[] };

const disc = new Map<string, string>();
for (const e of idl.events) disc.set(Buffer.from(e.discriminator).toString('hex'), e.name);

/**
 * BuyEvent / SellEvent share a prefix layout: an i64 then thirteen u64s, then
 * `pool` and `user`. Only the two pubkeys and the quote amount are read here —
 * this probe answers "can we see the trader", not "can we price the trade".
 */
function decodeTrader(buf: Buffer): { pool: string; user: string; quote: bigint } | null {
  const HEAD = 8 + 8 + 13 * 8; // discriminator + timestamp + thirteen u64 fields
  if (buf.length < HEAD + 64) return null;
  const pool = base58Encode(buf.subarray(HEAD, HEAD + 32));
  const user = base58Encode(buf.subarray(HEAD + 32, HEAD + 64));
  // quote_amount_in is the SEVENTH u64 after the timestamp, not the eighth:
  // base_amount_out, max_quote_amount_in, user_base, user_quote, pool_base,
  // pool_quote, THEN quote_amount_in. Reading one slot late lands on
  // lp_fee_basis_points, which is a small integer and renders as 0.0000 SOL --
  // a wrong field that looks like an empty one.
  const quote = buf.readBigUInt64LE(8 + 8 + 6 * 8);
  return { pool, user, quote };
}

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const watchlist = new Set(
  (db.prepare('SELECT address FROM flagged_wallets WHERE ledger_row = ?').all(MT101.ledgerRow) as {
    address: string;
  }[]).map((r) => r.address),
);
db.close();

console.log(`venue stream probe — READ ONLY, nothing is opened and nothing is signed`);
console.log(`  endpoint ${ENDPOINT}`);
console.log(`  program  ${PUMPSWAP}`);
console.log(`  watchlist loaded: ${watchlist.size} wallets`);
console.log(`  running ${SECONDS}s\n`);

const stats = {
  notifications: 0,
  withProgramData: 0,
  decodedBuy: 0,
  decodedSell: 0,
  unknownDiscriminator: 0,
  truncated: 0,
  failedTx: 0,
  watchlistHits: 0,
};
const traders = new Set<string>();
const samples: { name: string; user: string; pool: string; quote: string }[] = [];
let firstMs = 0;
let lastMs = 0;
let subscribed = false;
let closeCode: number | null = null;

await new Promise<void>((resolve) => {
  const ws = new WebSocket(ENDPOINT);
  const stop = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    resolve();
  }, SECONDS * 1000);

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMPSWAP] }, { commitment: 'confirmed' }],
      }),
    );
  });

  ws.addEventListener('message', (ev: MessageEvent) => {
    let msg: {
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { result?: { value?: { logs?: string[]; err?: unknown; signature?: string } } };
    };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.error !== undefined) {
      console.log('SUBSCRIBE REFUSED:', JSON.stringify(msg.error).slice(0, 300));
      clearTimeout(stop);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve();
      return;
    }
    if (typeof msg.result === 'number') {
      subscribed = true;
      console.log(`subscribed, id ${msg.result}`);
      return;
    }
    if (msg.method !== 'logsNotification') return;

    const now = Date.now();
    if (firstMs === 0) firstMs = now;
    lastMs = now;
    stats.notifications += 1;

    const value = msg.params?.result?.value;
    const logs = value?.logs ?? [];
    if (value?.err !== null && value?.err !== undefined) stats.failedTx += 1;
    if (logs.some((l) => l.includes('Log truncated'))) stats.truncated += 1;

    for (const line of logs) {
      const at = line.indexOf('Program data: ');
      if (at < 0) continue;
      stats.withProgramData += 1;
      const b64 = line.slice(at + 'Program data: '.length).trim();
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        continue;
      }
      if (buf.length < 8) continue;
      const name = disc.get(buf.subarray(0, 8).toString('hex'));
      if (name === undefined) {
        stats.unknownDiscriminator += 1;
        continue;
      }
      if (name !== 'BuyEvent' && name !== 'SellEvent') continue;
      const d = decodeTrader(buf);
      if (d === null) continue;
      if (name === 'BuyEvent') stats.decodedBuy += 1;
      else stats.decodedSell += 1;
      traders.add(d.user);
      if (watchlist.has(d.user)) stats.watchlistHits += 1;
      if (samples.length < 5) {
        samples.push({ name, user: d.user, pool: d.pool, quote: (Number(d.quote) / 1e9).toFixed(4) });
      }
    }
  });

  ws.addEventListener('close', (e: CloseEvent) => {
    closeCode = e.code;
    clearTimeout(stop);
    resolve();
  });
  ws.addEventListener('error', () => {
    /* close follows */
  });
});

const secs = firstMs === 0 ? 0 : Math.max(1, (lastMs - firstMs) / 1000);
const perSec = secs === 0 ? 0 : stats.notifications / secs;

console.log('');
console.log(`subscribed: ${String(subscribed)}   close code: ${closeCode ?? 'clean'}`);
console.log(`notifications: ${stats.notifications} over ${secs.toFixed(0)}s = ${perSec.toFixed(1)}/s`);
console.log(`  failed tx        ${stats.failedTx}`);
console.log(`  log truncated    ${stats.truncated}`);
console.log(`  Program data:    ${stats.withProgramData}`);
console.log(`  BuyEvent         ${stats.decodedBuy}`);
console.log(`  SellEvent        ${stats.decodedSell}`);
console.log(`  unknown discrim  ${stats.unknownDiscriminator}`);
console.log(`  distinct traders ${traders.size}`);
console.log(`  watchlist hits   ${stats.watchlistHits}  (against ${watchlist.size} wallets)`);
for (const s of samples) console.log(`    ${s.name.padEnd(9)} user ${s.user}  ${s.quote} SOL`);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/venue-stream-probe.json',
  `${JSON.stringify(
    {
      probedUtc: new Date().toISOString(),
      endpoint: ENDPOINT,
      program: PUMPSWAP,
      seconds: secs,
      subscribed,
      closeCode,
      notificationsPerSecond: perSec,
      watchlistSize: watchlist.size,
      stats,
      distinctTraders: traders.size,
    },
    null,
    2,
  )}\n`,
);

console.log('\n---');
if (!subscribed) {
  console.log('The subscription was never established, so nothing here is about the event layout.');
} else if (stats.decodedBuy + stats.decodedSell > 0) {
  console.log('THE TRADER IS READABLE FROM LOGS ALONE. One free venue-wide subscription yields');
  console.log('every buy with its buyer, so the watchlist can be ANY size and is matched locally.');
  console.log('That removes the 128-wallet cap, the per-sweep decode budget, and the detection lag');
  console.log('in one step — and it is a different source from the one MT101 froze, so it needs its');
  console.log('own ledger row before it feeds anything.');
} else if (stats.withProgramData > 0) {
  console.log('Program data lines exist but no Buy/Sell event decoded. Either the layout moved or');
  console.log('the events are emitted by CPI. Inspect before concluding.');
} else {
  console.log('NO Program data LINES AT ALL. pump_amm almost certainly uses emit_cpi!, which puts');
  console.log('the event in a self-CPI instruction that logs do not carry. The free venue-wide path');
  console.log('would then need getTransaction per event, which is the cost this was meant to avoid.');
}
console.log('artifacts/venue-stream-probe.json');
