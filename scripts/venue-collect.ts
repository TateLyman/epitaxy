/**
 * `pnpm venue:collect` — run the PumpSwap tape and record what the watchlists do.
 *
 * OBSERVATION ONLY. It opens no trajectory, takes no position, imports no
 * execution code and writes to no capital-bearing table. What it produces is the
 * quantity MT104 needs before anything else: the ADMITTED-SIGNAL RATE, which
 * carries one of the five kill conditions at under five a day.
 *
 * It also answers, for free and continuously, the question that killed five
 * phases: `venue_trades` keeps `pool_*_reserves_before` on every stored trade,
 * so the reserve path of any pool we care about is recorded as it happens
 * instead of being reconstructed afterwards from a trade tape that could not
 * price 46% of positions.
 *
 * THE DENOMINATOR IS KEPT EVEN THOUGH MOST ROWS ARE NOT. At 472 notifications a
 * second, storing everything would add several GB a day to a 9.4GB corpus that
 * is not reproducible. Unmatched trades are counted into
 * `venue_stream_sessions` and discarded; without that count "we saw 40 flagged
 * buys" has no denominator and the arrival rate means nothing.
 *
 * EVERY DISCONNECT IS A ROW. A gap is persisted, not smoothed — an arrival rate
 * computed across an unrecorded gap reads a dropped subscription as a quiet
 * market, and that rate is decision-bearing.
 */
import { openDb } from '../packages/storage/src/db.js';
import { MT101, MT104 } from '../packages/intelligence/src/wallet-watchlist.js';
import {
  VenueLogStream,
  type VenueStreamCounters,
  type VenueTrade,
} from '../packages/intelligence/src/venue-stream.js';

const LEDGER_ROW = MT104.ledgerRow;
const runMinutes = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? '0');

const db = openDb({ path: 'data/runtime.db' });

// The whole watchlist, in memory. 13,743 addresses is nothing to a Set, and
// that is the entire reason the stream removes MT101's 128-wallet bound: the
// list is matched HERE rather than pushed to a provider.
const watched = new Map<string, number>();
for (const r of db
  .prepare('SELECT address, fit_decile FROM flagged_wallets WHERE ledger_row = ?')
  .all(LEDGER_ROW) as { address: string; fit_decile: number | null }[]) {
  watched.set(r.address, r.fit_decile ?? 0);
}
// MT101's 128 stay watched too. Its arm is dying of its own kill condition and
// that verdict is worth recording rather than assuming, so its wallets are not
// dropped from the tape while it runs.
for (const r of db.prepare('SELECT address FROM flagged_wallets WHERE ledger_row = ?').all(MT101.ledgerRow) as {
  address: string;
}[]) {
  if (!watched.has(r.address)) watched.set(r.address, 0);
}

if (watched.size === 0) {
  console.error('no wallets frozen. Run pnpm watchlist:load-deciles first.');
  process.exit(1);
}

/**
 * Pools whose EVERY trade must be stored, because a position in one needs its
 * complete reserve path from entry to horizon.
 *
 * REFRESHED, not loaded once. The first version read this at startup only, so a
 * pool the bridge marked tracked five minutes later never had its trades kept -
 * and the exit reserves for those positions came from whatever flagged-wallet
 * trade happened to land in the same pool. That is a sparse and non-random
 * sample of a price path, which is precisely the defect this whole arm exists to
 * avoid, arriving through the back door.
 */
const trackedPools = new Set<string>();
function refreshTrackedPools(): void {
  for (const r of db.prepare('SELECT pool FROM venue_pools WHERE tracked = 1').all() as { pool: string }[]) {
    trackedPools.add(r.pool);
  }
  for (const r of db.prepare('SELECT DISTINCT pool FROM development_trajectories WHERE pool IS NOT NULL').all() as {
    pool: string;
  }[]) {
    trackedPools.add(r.pool);
  }
}
refreshTrackedPools();

const insertTrade = db.prepare(
  `INSERT OR IGNORE INTO venue_trades
     (signature, event_index, slot, side, pool, base_mint, quote_mint, trader,
      quote_amount, user_quote_amount, base_amount,
      pool_base_reserves_before, pool_quote_reserves_before,
      lp_fee_bps, protocol_fee_bps, creator_fee_bps, event_utc_s, observed_utc_ms, session_id, kept_because)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const openSession = db.prepare(
  `INSERT INTO venue_stream_sessions (session_id, endpoint, opened_utc_ms, ledger_row) VALUES (?, ?, ?, ?)`,
);
const saveCounters = db.prepare(
  `UPDATE venue_stream_sessions
      SET notifications = ?, trades_decoded = ?, buys_decoded = ?, trades_kept = ?,
          failed_tx = ?, log_truncated = ?, undecodable = ?
    WHERE session_id = ?`,
);
const closeSession = db.prepare(
  `UPDATE venue_stream_sessions
      SET closed_utc_ms = ?, close_code = ?, notifications = ?, trades_decoded = ?, buys_decoded = ?,
          trades_kept = ?, failed_tx = ?, log_truncated = ?, undecodable = ?
    WHERE session_id = ?`,
);

let sessionId = '';
let sessionOpenedMs = 0;
let sessions = 0;
const started = Date.now();
const decileHits = new Map<number, number>();
let buysKept = 0;

const stream = new VenueLogStream(
  {
    isWatched: (t) => watched.has(t),
    isTrackedPool: (p) => trackedPools.has(p),
    now: () => Date.now(),
    onTrade: (t: VenueTrade) => {
      insertTrade.run(
        t.signature,
        t.eventIndex,
        t.slot,
        t.trade.side,
        t.trade.pool,
        t.trade.user,
        t.trade.quoteAmount.toString(),
        t.trade.userQuoteAmount.toString(),
        t.trade.baseAmount.toString(),
        t.trade.poolBaseReservesBefore.toString(),
        t.trade.poolQuoteReservesBefore.toString(),
        Number(t.trade.lpFeeBasisPoints),
        Number(t.trade.protocolFeeBasisPoints),
        // Null when the payload was too short. Measured at 4,000 of 4,000 present,
        // but a null must stay a null: the creator fee ranges 0 to 95 bps and is
        // not derivable from the tier, so inferring it manufactures edge.
        t.trade.coinCreatorFeeBasisPoints === null ? null : Number(t.trade.coinCreatorFeeBasisPoints),
        Number(t.trade.timestamp),
        t.observedUtcMs,
        sessionId,
        t.keptBecause,
      );
      if (t.keptBecause === 'WATCHLIST_TRADER' && t.trade.side === 'BUY') {
        buysKept += 1;
        const d = watched.get(t.trade.user) ?? 0;
        decileHits.set(d, (decileHits.get(d) ?? 0) + 1);
        const arm = d === MT104.treatmentDecile ? MT104.treatmentArm : d === MT104.controlDecile ? MT104.controlArm : 'MT101';
        console.log(
          `  ${new Date(t.observedUtcMs).toISOString().slice(11, 19)}  BUY  ${arm.padEnd(17)} ` +
            `${(Number(t.trade.userQuoteAmount) / 1e9).toFixed(4)} quote  pool ${t.trade.pool.slice(0, 8)}  ` +
            `fees ${t.trade.lpFeeBasisPoints}/${t.trade.protocolFeeBasisPoints} bps`,
        );
      }
    },
    onCounters: () => {
      /* persisted at session close; printing per event would drown the log */
    },
  },
  (event, info) => {
    const now = Date.now();
    if (event === 'open') {
      sessions += 1;
      sessionId = `venue-${now}-${sessions}`;
      sessionOpenedMs = now;
      openSession.run(sessionId, stream.endpoint, now, LEDGER_ROW);
      console.log(`session ${sessions} open  ${new Date(now).toISOString()}`);
      return;
    }
    const c: VenueStreamCounters = info.counters;
    closeSession.run(
      now,
      info.closeCode,
      c.notifications,
      c.tradesDecoded,
      c.buysDecoded,
      c.tradesKept,
      c.failedTx,
      c.logTruncated,
      c.undecodable,
      sessionId,
    );
    const mins = (now - sessionOpenedMs) / 60_000;
    console.log(
      `session ${sessions} closed after ${mins.toFixed(1)}m  code ${info.closeCode ?? '-'}  ` +
        `notifications ${c.notifications}  buys ${c.buysDecoded}  kept ${c.tradesKept}  ` +
        `failed ${c.failedTx}  truncated ${c.logTruncated}`,
    );
  },
);

console.log('MT104 venue tape — OBSERVATION ONLY, nothing is opened and nothing is signed');
console.log(`  endpoint      ${stream.endpoint}`);
console.log(`  watched       ${watched.size} wallets (${MT104.ledgerRow} + ${MT101.ledgerRow})`);
console.log(`  tracked pools ${trackedPools.size} (refreshed every reporting tick)`);
console.log('');

function report(): void {
  const hours = (Date.now() - started) / 3_600_000;
  const c = stream.currentCounters();
  // Persist the DENOMINATOR here and not only at close. The first run lost it
  // entirely: the process was killed by a timeout, closeSession never fired, and
  // the session row kept zeros while the console had 237,681 notifications. A
  // denominator that survives only a clean shutdown is not a denominator, and
  // this table exists precisely so that "we saw N flagged buys" has one.
  refreshTrackedPools();
  if (sessionId.length > 0) {
    saveCounters.run(c.notifications, c.tradesDecoded, c.buysDecoded, c.tradesKept, c.failedTx, c.logTruncated, c.undecodable, sessionId);
  }
  console.log('');
  console.log(`--- ${hours.toFixed(2)}h ---`);
  console.log(`  notifications ${c.notifications}  buys decoded ${c.buysDecoded}  kept ${c.tradesKept}`);
  for (const [d, n] of [...decileHits.entries()].sort((a, b) => a[0] - b[0])) {
    const arm = d === MT104.treatmentDecile ? MT104.treatmentArm : d === MT104.controlDecile ? MT104.controlArm : 'MT101/unlabelled';
    console.log(`  decile ${String(d).padStart(2)}  ${arm.padEnd(17)} ${n} buys  ${hours > 0.05 ? `${(n / hours).toFixed(1)}/hour = ${(n / hours * 24).toFixed(0)}/day` : ''}`);
  }
  console.log(`  flagged buys total ${buysKept}${hours > 0.05 ? `  = ${((buysKept / hours) * 24).toFixed(0)}/day` : ''}`);
}

const ticker = setInterval(report, 300_000);
if (runMinutes > 0) {
  setTimeout(() => {
    stream.stop();
    clearInterval(ticker);
  }, runMinutes * 60_000);
}

process.on('SIGINT', () => {
  stream.stop();
  clearInterval(ticker);
});

await stream.run();
clearInterval(ticker);
report();
db.close();
