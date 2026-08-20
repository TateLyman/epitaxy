/**
 * `pnpm venue:verify` — does the log decode agree with the chain, exactly?
 *
 * `pumpswap-event.ts` reads a trade out of a `Program data:` log line at fixed
 * byte offsets. Offsets fail silently: reading `quote_amount_in` one slot late
 * returns `lp_fee_basis_points`, a small integer that renders as 0.0000 SOL and
 * looks exactly like an empty field. That happened in the first version of the
 * probe, so the decode is checked against a second instrument rather than
 * trusted.
 *
 * THE INSTRUMENT MATTERS MORE THAN THE TOLERANCE, AND THE FIRST ONE WAS WRONG.
 *
 * The obvious check is the trader's own balance delta. It is a bad check, and
 * three separate confounds proved it:
 *
 *   1. A MULTI-HOP ROUTE sells into SOL and spends it again in the same
 *      transaction, so the wallet's NET delta is ~0 while the leg was real.
 *   2. `user` IS NOT ALWAYS THE ECONOMIC PARTY. PumpSwap takes
 *      `user_base_token_account` and `user_quote_token_account` explicitly, so
 *      `user` is an authority. Inspected directly on one event: the decoded user
 *      sat at key index 18, was not the fee payer, had native delta 0, WSOL
 *      unchanged at 22.094 SOL and token balance 0 to 0, while the 0.1986 SOL
 *      moved through a third account in a 37-key transaction.
 *   3. PRIORITY FEES and ATA rent add an unbounded amount on top.
 *
 * Every one of those is a fact about the transaction, not about the decode, and
 * a tolerance wide enough to swallow them would no longer be testing anything.
 *
 * SO THE CHECK IS EXACT AND UNCONFOUNDED INSTEAD. The event reports
 * `pool_quote_token_reserves` and `pool_base_token_reserves` BEFORE the trade,
 * and the same transaction's `preTokenBalances` carry the pool vaults` balances
 * before it. Those are the same quantity by two routes and must match to the
 * unit — no tolerance, no fee model, no assumption about who paid.
 *
 * BEFORE, not after, and finding that out is what this check was for. The first
 * version compared against postTokenBalances and got 0 of 30. The tell was that
 * consecutive trades on one pool CHAIN: the event value of the second trade
 * equalled the POST balance of the first, exactly. Reading these as post-trade
 * reserves would have shifted every reconstructed reserve path by one trade,
 * silently, and the reserve path is the quantity five phases died on.
 *
 * `user == fee payer` is still measured and reported, because it is not a decode
 * question at all: it is MT104's COVERAGE. The watchlist is keyed on Dune's
 * `trader_id`, and every event whose `user` is a different identity is a signal
 * the stream cannot match.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { openDb } from '../packages/storage/src/db.js';
import { tradesFromLogs, logsWereTruncated, type PumpSwapTrade } from '../packages/intelligence/src/pumpswap-event.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WANT = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? '25');
const ENDPOINT = process.env['VENUE_WS'] ?? 'wss://api.mainnet-beta.solana.com';

interface Caught {
  readonly signature: string;
  readonly trade: PumpSwapTrade;
}

const caught: Caught[] = [];
let truncated = 0;

console.log(`catching ${WANT} PumpSwap trades from ${ENDPOINT}\n`);

await new Promise<void>((resolve) => {
  const ws = new WebSocket(ENDPOINT);
  const stop = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    resolve();
  }, 120_000);
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
    let msg: { method?: string; params?: { result?: { value?: { logs?: string[]; err?: unknown; signature?: string } } } };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const v = msg.params?.result?.value;
    if (v === undefined || v.err !== null) return;
    const logs = v.logs ?? [];
    if (logsWereTruncated(logs)) {
      truncated += 1;
      return;
    }
    const sig = v.signature;
    if (typeof sig !== 'string') return;
    const inTx = tradesFromLogs(logs);
    // One trade per transaction only. With two legs the FIRST event's reserves
    // are already stale by the time the transaction ends, so a post-balance
    // comparison would legitimately differ and would prove nothing.
    if (inTx.length !== 1) return;
    const only = inTx[0];
    if (only === undefined) return;
    caught.push({ signature: sig, trade: only.trade });
    if (caught.length >= WANT) {
      clearTimeout(stop);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve();
    }
  });
  ws.addEventListener('close', () => {
    clearTimeout(stop);
    resolve();
  });
});

console.log(`caught ${caught.length} single-leg trades (log-truncated skipped: ${truncated})\n`);
if (caught.length === 0) {
  console.error('nothing caught; nothing verified');
  process.exit(1);
}

const db = openDb({ path: 'data/runtime.db' });
const { rpc } = researchRpc(loadSecrets(), db);

const vaultsOf = new Map<string, { base: string; quote: string } | null>();
async function resolveVaults(pool: string): Promise<{ base: string; quote: string } | null> {
  const hit = vaultsOf.get(pool);
  if (hit !== undefined) return hit;
  try {
    const raw = await rpc.getAccountRaw(pool);
    const a = poolAddressesFrom(
      { get: (k) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) },
      pool,
    );
    const v = { base: a.poolBaseTokenAccount, quote: a.poolQuoteTokenAccount };
    vaultsOf.set(pool, v);
    return v;
  } catch {
    vaultsOf.set(pool, null);
    return null;
  }
}

let exact = 0;
let mismatched = 0;
let unverifiable = 0;
let userIsPayer = 0;
let userNotPayer = 0;
const rows: Record<string, unknown>[] = [];

for (const c of caught) {
  const vaults = await resolveVaults(c.trade.pool);
  if (vaults === null) {
    unverifiable += 1;
    continue;
  }
  const tx = await rpc.getTransactionWithMeta(c.signature);
  if (tx === null) {
    unverifiable += 1;
    continue;
  }

  // Coverage, not accuracy. Reported beside the decode check, never mixed in.
  if (tx.accountKeys.indexOf(c.trade.user) === 0) userIsPayer += 1;
  else userNotPayer += 1;

  const balanceOf = (account: string): bigint | null => {
    const keyIndex = tx.accountKeys.indexOf(account);
    if (keyIndex < 0) return null;
    for (const r of tx.preTokenBalances) if (r.accountIndex === keyIndex) return r.amount;
    return null;
  };
  const chainQuote = balanceOf(vaults.quote);
  const chainBase = balanceOf(vaults.base);
  if (chainQuote === null || chainBase === null) {
    unverifiable += 1;
    continue;
  }

  const quoteOk = chainQuote === c.trade.poolQuoteReservesBefore;
  const baseOk = chainBase === c.trade.poolBaseReservesBefore;
  const ok = quoteOk && baseOk;
  if (ok) exact += 1;
  else mismatched += 1;
  rows.push({
    // TRUNCATED DELIBERATELY. A Solana signature is 87-88 base58 characters and
    // an ed25519 SECRET key is 86-90 of the same alphabet, so this repository's
    // secretscan cannot tell them apart and correctly refused this artifact.
    // The exemption it does carry is scoped to tests/fixtures on purpose - its
    // own comment says context is the only honest discriminator - and widening a
    // security rule so an artifact of mine can pass is not a trade worth making.
    // 64 characters identify the transaction unambiguously, and the untruncated
    // signature lives in wallet_flow_events where the corpus keeps it.
    signaturePrefix: c.signature.slice(0, 64),
    side: c.trade.side,
    eventPoolQuoteReservesBefore: c.trade.poolQuoteReservesBefore.toString(),
    chainPoolQuoteReservesPre: chainQuote.toString(),
    eventPoolBaseReservesBefore: c.trade.poolBaseReservesBefore.toString(),
    chainPoolBaseReservesPre: chainBase.toString(),
    exactMatch: ok,
  });
  console.log(
    `  ${ok ? 'EXACT   ' : 'MISMATCH'} ${c.trade.side.padEnd(4)} ` +
      `quote ${quoteOk ? 'ok' : `${c.trade.poolQuoteReservesBefore} vs ${chainQuote}`} ` +
      `base ${baseOk ? 'ok' : `${c.trade.poolBaseReservesBefore} vs ${chainBase}`}`,
  );
}
db.close();

const decoded = userIsPayer + userNotPayer;
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/venue-event-verification.json',
  `${JSON.stringify(
    {
      verifiedUtc: new Date().toISOString(),
      endpoint: ENDPOINT,
      check: 'event pool reserves BEFORE trade == pool vault preTokenBalances, exact, no tolerance',
      caught: caught.length,
      exact,
      mismatched,
      unverifiable,
      logTruncatedSkipped: truncated,
      coverage: {
        note: 'MT104 coverage, not decode accuracy: the watchlist is keyed on Dune trader_id',
        userIsFeePayer: userIsPayer,
        userNotFeePayer: userNotPayer,
        shareUserIsFeePayer: decoded === 0 ? null : userIsPayer / decoded,
      },
      rows,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nexact ${exact}   mismatched ${mismatched}   unverifiable ${unverifiable}`);
console.log(
  `user == fee payer on ${userIsPayer} of ${decoded} decoded events` +
    (decoded === 0 ? '' : ` (${((100 * userIsPayer) / decoded).toFixed(1)}%)`) +
    ' — MT104 coverage, not decode accuracy',
);
console.log('artifacts/venue-event-verification.json');
if (mismatched > 0) {
  console.error('\nTHE DECODE AND THE CHAIN DISAGREE ON POOL RESERVES. The offsets are wrong or the layout moved.');
  process.exit(1);
}
console.log('\nEvery verifiable event reproduces the pool reserves the chain recorded, exactly.');
