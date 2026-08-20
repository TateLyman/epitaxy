/**
 * `pnpm venue:bridge` — turn flagged buys into positions, and price the ones
 * whose horizon has passed.
 *
 * OBSERVATION ONLY. It opens no trajectory, signs nothing, imports no execution
 * code, and every position it writes is a MODELLED fill priced off the reserve
 * path — not a built, simulated and effect-verified transaction, which is what
 * this repository means by executable. Nothing here may decide anything until
 * §validation compares it against real executable quotes.
 *
 * WHY IT IS A SEPARATE PASS FROM THE TAPE. The tape handles 472 notifications a
 * second and must not block; resolving a pool's mint costs an RPC call. The exit
 * is an hour away, so a few seconds of resolution latency changes nothing, and
 * keeping them apart means a slow RPC can never drop a tape event.
 *
 * THE ENTRY IS PRICED IN THE ORDER IT HAPPENS, and this is the part that decides
 * whether the whole arm is honest. The tape reports the pool BEFORE the followed
 * wallet's own buy. A follower does not get that price: the wallet moves the pool
 * first and we arrive after. So the wallet's trade is applied, and only then
 * ours. That gap is the quote-to-land cost Phase C measured at +2.94% by the
 * mean, and it is the single most likely way this arm fails. Granting ourselves
 * the pre-wallet price would hide exactly that.
 *
 * SAMPLING REFUSALS ARE NOT STORED, and that is not a lapse in "rejections are
 * the product". MT105's draw is a pure deterministic function of (mint, wallet,
 * salt) and the recorded inclusion probability, so any refusal is recomputable
 * from rows we already keep. A stored refusal would be redundant rather than
 * evidential. Refusals that are NOT recomputable — an unresolvable pool, an
 * unpriceable fee ladder — are counted and reported.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { poolAddressesFrom } from '../packages/solana/src/pumpswap-offline.js';
import { MT101, MT104, MT105, admitSignal, inclusionProbabilityFor } from '../packages/intelligence/src/wallet-watchlist.js';
import { FillNotPriceable, priceBuy, priceSell, type PoolFeeLadder } from '../packages/intelligence/src/copy-fill.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const HORIZON_MS = MT101.primaryHorizonMs;
const NOTIONAL = MT101.notionalLamports;

const db = openDb({ path: 'data/runtime.db' });
const secrets = loadSecrets();
const { rpc } = researchRpc(secrets, db);

// ---------------------------------------------------------------------------
// 1. The sampling rate, from what the tape is actually delivering.
// ---------------------------------------------------------------------------

const span = db
  .prepare(
    `SELECT MIN(observed_utc_ms) a, MAX(observed_utc_ms) b, COUNT(*) n
       FROM venue_trades WHERE side='BUY' AND kept_because='WATCHLIST_TRADER'`,
  )
  .get() as { a: number | null; b: number | null; n: number };

if (span.a === null || span.b === null || span.n === 0) {
  console.error('no flagged buys captured yet. Run pnpm venue:collect first.');
  process.exit(1);
}
const days = Math.max((span.b - span.a) / 86_400_000, 1 / 1440);
const observedPerDay = span.n / days;
const p = inclusionProbabilityFor(observedPerDay);

console.log('MT105 bridge — OBSERVATION ONLY, modelled fills, nothing signed');
console.log(`  flagged buys captured ${span.n} over ${(days * 24).toFixed(2)}h = ${observedPerDay.toFixed(0)}/day`);
console.log(`  inclusion probability ${p.toExponential(3)} for a ${MT105.targetOpensPerDay}/day target`);
console.log('');

// ---------------------------------------------------------------------------
// 2. Resolve pools, once each.
// ---------------------------------------------------------------------------

const upsertPool = db.prepare(
  `INSERT OR REPLACE INTO venue_pools (pool, base_mint, quote_mint, base_vault, quote_vault, coin_creator, resolved_utc_ms, tracked)
   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT tracked FROM venue_pools WHERE pool = ?), 0))`,
);
const knownPools = new Map<string, { baseMint: string; quoteMint: string }>();
for (const r of db.prepare('SELECT pool, base_mint, quote_mint FROM venue_pools').all() as {
  pool: string;
  base_mint: string;
  quote_mint: string;
}[]) {
  knownPools.set(r.pool, { baseMint: r.base_mint, quoteMint: r.quote_mint });
}

let resolved = 0;
let unresolvable = 0;
async function poolMints(pool: string): Promise<{ baseMint: string; quoteMint: string } | null> {
  const hit = knownPools.get(pool);
  if (hit !== undefined) return hit;
  try {
    const raw = await rpc.getAccountRaw(pool);
    const a = poolAddressesFrom(
      { get: (k) => (k === pool ? { owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports } : null) },
      pool,
    );
    upsertPool.run(pool, a.baseMint, a.quoteMint, a.poolBaseTokenAccount, a.poolQuoteTokenAccount, a.coinCreator, Date.now(), pool);
    const v = { baseMint: a.baseMint, quoteMint: a.quoteMint };
    knownPools.set(pool, v);
    resolved += 1;
    return v;
  } catch {
    // Unread is not "absent". Counted and skipped, never guessed.
    unresolvable += 1;
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Open positions from flagged buys not already positioned.
// ---------------------------------------------------------------------------

const candidates = db
  .prepare(
    `SELECT v.signature, v.event_index, v.trader, v.pool, v.observed_utc_ms, v.event_utc_s,
            v.pool_base_reserves_before AS b, v.pool_quote_reserves_before AS q,
            v.user_quote_amount AS wq, v.lp_fee_bps AS lp, v.protocol_fee_bps AS pf, v.creator_fee_bps AS cf,
            f.fit_decile AS decile
       FROM venue_trades v
       JOIN flagged_wallets f ON f.address = v.trader AND f.ledger_row = ?
      WHERE v.side = 'BUY' AND v.kept_because = 'WATCHLIST_TRADER'
        AND NOT EXISTS (SELECT 1 FROM copy_positions cp
                         WHERE cp.trigger_signature = v.signature AND cp.trigger_event_index = v.event_index)
      ORDER BY v.observed_utc_ms`,
  )
  .all(MT104.ledgerRow) as {
  signature: string;
  event_index: number;
  trader: string;
  pool: string;
  observed_utc_ms: number;
  event_utc_s: number;
  b: string;
  q: string;
  wq: string;
  lp: number;
  pf: number;
  cf: number | null;
  decile: number | null;
}[];

const insertPosition = db.prepare(
  `INSERT OR IGNORE INTO copy_positions
     (position_id, ledger_row, selection_arm, fit_decile, trigger_signature, trigger_event_index,
      wallet, pool, base_mint, entry_utc_ms, entry_event_utc_s, entry_base_reserves, entry_quote_reserves,
      wallet_quote_in, notional_lamports, lp_fee_bps, protocol_fee_bps, creator_fee_bps,
      inclusion_probability, horizon_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const markTracked = db.prepare('UPDATE venue_pools SET tracked = 1 WHERE pool = ?');

let opened = 0;
let refusedSample = 0;
let refusedNonSol = 0;
let refusedDuplicateMint = 0;
const openedMints = new Set(
  (db.prepare('SELECT DISTINCT base_mint FROM copy_positions WHERE base_mint IS NOT NULL').all() as {
    base_mint: string;
  }[]).map((r) => r.base_mint),
);

for (const c of candidates) {
  const mints = await poolMints(c.pool);
  if (mints === null) continue;
  // Only pools this apparatus could actually enter. A non-WSOL quote leg is not
  // lamports and pricing it as such is the error that produced a "3,897 SOL" sell.
  if (mints.quoteMint !== WSOL) {
    refusedNonSol += 1;
    continue;
  }
  if (!admitSignal(mints.baseMint, c.trader, p)) {
    refusedSample += 1;
    continue;
  }
  // One position per mint, as MT101 froze.
  if (openedMints.has(mints.baseMint)) {
    refusedDuplicateMint += 1;
    continue;
  }
  const arm =
    c.decile === MT104.treatmentDecile
      ? MT104.treatmentArm
      : c.decile === MT104.controlDecile
        ? MT104.controlArm
        : MT101.selectionArm;

  insertPosition.run(
    `${c.signature}:${c.event_index}`,
    MT104.ledgerRow,
    arm,
    c.decile,
    c.signature,
    c.event_index,
    c.trader,
    c.pool,
    mints.baseMint,
    c.observed_utc_ms,
    c.event_utc_s,
    c.b,
    c.q,
    c.wq,
    NOTIONAL.toString(),
    c.lp,
    c.pf,
    // Measured present on 4,000 of 4,000 events, but a null stays a null: the
    // creator fee runs 0 to 95 bps and is NOT a function of the lp/protocol
    // tier, so a position missing it is unpriceable rather than assumed.
    c.cf,
    p,
    HORIZON_MS,
  );
  markTracked.run(c.pool);
  openedMints.add(mints.baseMint);
  opened += 1;
}

console.log(`opened ${opened} positions from ${candidates.length} candidate flagged buys`);
console.log(`  refused by sampling      ${refusedSample}   (recomputable, not stored)`);
console.log(`  refused non-SOL quote    ${refusedNonSol}`);
console.log(`  refused duplicate mint   ${refusedDuplicateMint}`);
console.log(`  pools resolved this pass ${resolved}   unresolvable ${unresolvable}`);

// ---------------------------------------------------------------------------
// 4. Price the positions whose horizon has passed.
// ---------------------------------------------------------------------------

const due = db
  .prepare(
    `SELECT * FROM copy_positions
      WHERE ledger_row = ? AND exit_utc_ms IS NULL AND entry_utc_ms + horizon_ms <= ?`,
  )
  .all(MT104.ledgerRow, Date.now()) as Record<string, string | number | null>[];

const exitReservesAt = db.prepare(
  `SELECT pool_base_reserves_before AS b, pool_quote_reserves_before AS q, observed_utc_ms AS t
     FROM venue_trades
    WHERE pool = ? AND observed_utc_ms > ? AND observed_utc_ms <= ?
    ORDER BY observed_utc_ms DESC LIMIT 1`,
);
const settle = db.prepare(
  `UPDATE copy_positions
      SET exit_utc_ms = ?, exit_base_reserves = ?, exit_quote_reserves = ?, exit_source = ?,
          quote_out = ?, return_fraction = ?
    WHERE position_id = ?`,
);

let priced = 0;
let unpriceable = 0;
for (const pos of due) {
  const entryB = BigInt(String(pos['entry_base_reserves']));
  const entryQ = BigInt(String(pos['entry_quote_reserves']));
  const walletIn = BigInt(String(pos['wallet_quote_in']));
  const notional = BigInt(String(pos['notional_lamports']));
  const creator = pos['creator_fee_bps'];
  if (creator === null || creator === undefined) {
    unpriceable += 1;
    continue;
  }
  const fees: PoolFeeLadder = {
    lpFeeBasisPoints: BigInt(Number(pos['lp_fee_bps'])),
    protocolFeeBasisPoints: BigInt(Number(pos['protocol_fee_bps'])),
    coinCreatorFeeBasisPoints: BigInt(Number(creator)),
  };
  const entryMs = Number(pos['entry_utc_ms']);
  const horizonMs = Number(pos['horizon_ms']);

  try {
    // The wallet's own trade first, then ours. We arrive after it.
    const walletFill = priceBuy({ base: entryB, quote: entryQ }, walletIn, fees);
    const ourFill = priceBuy(walletFill.reservesAfter, notional, fees);

    const at = exitReservesAt.get(String(pos['pool']), entryMs, entryMs + horizonMs) as
      | { b: string; q: string; t: number }
      | undefined;
    // NO CENSORING. A pool with no trade in the window has not moved, so the
    // exit prices against the state our own entry left. That is the whole reason
    // a reserve path beats a trade tape: absence of a trade is information, not
    // a missing value.
    const exitBase = at === undefined ? ourFill.reservesAfter.base : BigInt(at.b);
    const exitQuote = at === undefined ? ourFill.reservesAfter.quote : BigInt(at.q);
    const source = at === undefined ? 'NO_TRADE_IN_WINDOW_ENTRY_STATE' : 'TAPE_RESERVES';

    const sell = priceSell({ base: exitBase, quote: exitQuote }, ourFill.baseOut, fees);
    const ret = Number(((sell.quoteOut - notional) * 1_000_000_000_000n) / notional) / 1e12;
    settle.run(
      entryMs + horizonMs,
      exitBase.toString(),
      exitQuote.toString(),
      source,
      sell.quoteOut.toString(),
      ret,
      String(pos['position_id']),
    );
    priced += 1;
  } catch (e) {
    if (e instanceof FillNotPriceable) unpriceable += 1;
    else throw e;
  }
}

console.log('');
console.log(`priced ${priced} positions at H* = ${HORIZON_MS / 1000}s   unpriceable ${unpriceable}`);

const summary = db
  .prepare(
    `SELECT selection_arm arm, COUNT(*) n, SUM(exit_utc_ms IS NOT NULL) settled,
            AVG(return_fraction) mean_ret
       FROM copy_positions WHERE ledger_row = ? GROUP BY 1 ORDER BY 1`,
  )
  .all(MT104.ledgerRow) as { arm: string; n: number; settled: number; mean_ret: number | null }[];

console.log('');
for (const s of summary) {
  console.log(
    `  ${s.arm.padEnd(18)} open+settled ${String(s.n).padStart(5)}  settled ${String(s.settled).padStart(5)}` +
      `  mean return ${s.mean_ret === null ? 'n/a' : `${(100 * s.mean_ret).toFixed(2)}%`}`,
  );
}
console.log('');
console.log('These are MODELLED fills. Nothing here is executable evidence and nothing decides anything');
console.log('until it is validated against real executable quotes.');

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/mt105-bridge.json',
  `${JSON.stringify(
    {
      ranUtc: new Date().toISOString(),
      ledgerRow: MT104.ledgerRow,
      samplingRow: MT105.ledgerRow,
      observedFlaggedBuysPerDay: observedPerDay,
      inclusionProbability: p,
      horizonMs: HORIZON_MS,
      notionalLamports: NOTIONAL.toString(),
      opened,
      refusedSample,
      refusedNonSol,
      refusedDuplicateMint,
      poolsResolved: resolved,
      poolsUnresolvable: unresolvable,
      priced,
      unpriceable,
      evidenceGrade: 'RESERVE_MODELLED',
      arms: summary,
    },
    null,
    2,
  )}\n`,
);
console.log('artifacts/mt105-bridge.json');
db.close();
