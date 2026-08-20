/**
 * `pnpm crowding` — MT107. Is a flagged wallet's buy followed by a crowd?
 *
 * MT072 has carried crowding as UNKNOWN since the wallet-persistence work, and
 * section 7 of WALLET_PERSISTENCE_RESULTS names it as one of two unmodelled
 * costs that "bite hardest exactly here". It stayed unknown because nothing this
 * programme owned could see the whole venue. The free tape can.
 *
 * For every buy it sees, this opens a window and measures two things at +2s,
 * +5s, +15s and +45s:
 *
 *   1. how many further buys land in that pool
 *   2. how far the pool price moves
 *
 * and it does it for FLAGGED buys and for an UNFLAGGED CONTROL drawn from the
 * same stream. The control is the point. The venue has a base rate of
 * buys-following-any-buy, and reporting the flagged number alone would report
 * that base rate as though it were crowding.
 *
 * BOTH MEASURES MUST AGREE. A count with no price move is people trading who are
 * not moving the pool; a price move with no extra count is the market moving for
 * its own reasons. Only both together are a follower paying up.
 *
 * The control is selected by the SAME deterministic hash MT105 uses for
 * admission, so it is not chosen by hand and the selection is reproducible.
 *
 * Streaming and in-memory. Stores nothing, opens nothing, signs nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tradesFromLogs, logsWereTruncated } from '../packages/intelligence/src/pumpswap-event.js';
import { MT101, MT104, fnv1a32 } from '../packages/intelligence/src/wallet-watchlist.js';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ENDPOINT = process.env['VENUE_WS'] ?? 'wss://api.mainnet-beta.solana.com';
const RUN_MS = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? '25') * 60_000;

/** Frozen by MT107 before the stream opened. */
const HORIZONS_MS = [2_000, 5_000, 15_000, 45_000] as const;
const MAX_H: number = HORIZONS_MS[HORIZONS_MS.length - 1] ?? 45_000;
/** Control sampling rate, so the control set stays comparable in size. */
const CONTROL_RATE = 0.004;

const db = new DatabaseSync('data/runtime.db', { readOnly: true });
const watched = new Set(
  (db.prepare('SELECT address FROM flagged_wallets WHERE ledger_row IN (?, ?)').all(MT104.ledgerRow, MT101.ledgerRow) as {
    address: string;
  }[]).map((r) => r.address),
);
db.close();
console.log(`MT107 crowding probe — READ ONLY, ${watched.size} flagged wallets, ${RUN_MS / 60_000} minutes\n`);

interface Window {
  readonly flagged: boolean;
  readonly pool: string;
  readonly openedMs: number;
  readonly priceAtOpen: number;
  /** Buys counted, cumulative, one slot per horizon. */
  readonly counts: number[];
  /** Price at each horizon, NaN until a trade lands past it. */
  readonly priceAt: number[];
}

const open: Window[] = [];
const done: Window[] = [];
let seenBuys = 0;
let flaggedBuys = 0;

const priceOf = (base: bigint, quote: bigint): number =>
  base > 0n ? Number(quote) / Number(base) : Number.NaN;

function closeExpired(now: number): void {
  for (let i = open.length - 1; i >= 0; i -= 1) {
    const w = open[i]!;
    if (now - w.openedMs > MAX_H) {
      done.push(w);
      open.splice(i, 1);
    }
  }
}

await new Promise<void>((resolve) => {
  const ws = new WebSocket(ENDPOINT);
  const stop = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    resolve();
  }, RUN_MS);
  ws.addEventListener('open', () =>
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMPSWAP] }, { commitment: 'confirmed' }],
      }),
    ),
  );
  ws.addEventListener('message', (ev: MessageEvent) => {
    let m: { method?: string; params?: { result?: { value?: { logs?: string[]; err?: unknown } } } };
    try {
      m = JSON.parse(String(ev.data)) as typeof m;
    } catch {
      return;
    }
    if (m.method !== 'logsNotification') return;
    const v = m.params?.result?.value;
    if (v === undefined || v.err !== null) return;
    const logs = v.logs ?? [];
    if (logsWereTruncated(logs)) return;

    const now = Date.now();
    closeExpired(now);

    let trades;
    try {
      trades = tradesFromLogs(logs);
    } catch {
      return;
    }

    for (const { trade } of trades) {
      const price = priceOf(trade.poolBaseReservesBefore, trade.poolQuoteReservesBefore);
      if (!Number.isFinite(price) || price <= 0) continue;

      // Update every open window on this pool, whatever the side, because the
      // price a follower would pay moves on sells too.
      for (const w of open) {
        if (w.pool !== trade.pool) continue;
        const age = now - w.openedMs;
        for (let h = 0; h < HORIZONS_MS.length; h += 1) {
          if (age <= HORIZONS_MS[h]!) {
            if (trade.side === 'BUY') w.counts[h] = (w.counts[h] ?? 0) + 1;
            w.priceAt[h] = price;
          }
        }
      }

      if (trade.side !== 'BUY') continue;
      seenBuys += 1;
      const isFlagged = watched.has(trade.user);
      if (isFlagged) flaggedBuys += 1;
      // The control is drawn by MT105's own hash, so it is reproducible and not
      // chosen by hand.
      const inControl =
        !isFlagged && fnv1a32(`${trade.pool}|${trade.user}|MT107`) % 10_000 < CONTROL_RATE * 10_000;
      if (!isFlagged && !inControl) continue;
      if (open.length > 4_000) continue;

      open.push({
        flagged: isFlagged,
        pool: trade.pool,
        openedMs: now,
        priceAtOpen: price,
        counts: HORIZONS_MS.map(() => 0),
        priceAt: HORIZONS_MS.map(() => Number.NaN),
      });
    }
  });
  ws.addEventListener('close', () => {
    clearTimeout(stop);
    resolve();
  });
});

closeExpired(Date.now() + MAX_H + 1);

const pct = (a: number[], x: number): number => {
  const s = [...a].filter((v) => Number.isFinite(v)).sort((m, n) => m - n);
  return s.length === 0 ? Number.NaN : (s[Math.floor(x * (s.length - 1))] ?? Number.NaN);
};
const mean = (a: number[]): number => {
  const s = a.filter((v) => Number.isFinite(v));
  return s.length === 0 ? Number.NaN : s.reduce((m, n) => m + n, 0) / s.length;
};

const flagged = done.filter((w) => w.flagged);
const control = done.filter((w) => !w.flagged);

console.log(`buys seen ${seenBuys}   flagged ${flaggedBuys}`);
console.log(`windows closed: flagged ${flagged.length}   control ${control.length}\n`);

interface Row {
  horizonS: number;
  flaggedCountMean: number;
  controlCountMean: number;
  flaggedMoveBpsMean: number;
  controlMoveBpsMean: number;
  flaggedMoveBpsP50: number;
  controlMoveBpsP50: number;
}
const rows: Row[] = [];

const moveBps = (w: Window, h: number): number =>
  Number.isFinite(w.priceAt[h]!) ? ((w.priceAt[h]! - w.priceAtOpen) / w.priceAtOpen) * 10_000 : Number.NaN;

console.log('                  follower BUY count            price move from the trigger, bps');
console.log('  horizon     flagged   control   diff       flagged   control   diff   (median flagged)');
for (let h = 0; h < HORIZONS_MS.length; h += 1) {
  const fc = mean(flagged.map((w) => w.counts[h] ?? 0));
  const cc = mean(control.map((w) => w.counts[h] ?? 0));
  const fm = mean(flagged.map((w) => moveBps(w, h)));
  const cm = mean(control.map((w) => moveBps(w, h)));
  const fp = pct(flagged.map((w) => moveBps(w, h)), 0.5);
  const cp = pct(control.map((w) => moveBps(w, h)), 0.5);
  rows.push({
    horizonS: HORIZONS_MS[h]! / 1000,
    flaggedCountMean: fc,
    controlCountMean: cc,
    flaggedMoveBpsMean: fm,
    controlMoveBpsMean: cm,
    flaggedMoveBpsP50: fp,
    controlMoveBpsP50: cp,
  });
  console.log(
    `  +${String(HORIZONS_MS[h]! / 1000).padStart(3)}s     ${fc.toFixed(2).padStart(7)}   ${cc.toFixed(2).padStart(7)}   ${(fc - cc).toFixed(2).padStart(6)}` +
      `     ${fm.toFixed(1).padStart(8)}  ${cm.toFixed(1).padStart(8)}  ${(fm - cm).toFixed(1).padStart(6)}   ${fp.toFixed(1).padStart(7)}`,
  );
}

const last = rows[rows.length - 1]!;
const crowded = last.flaggedCountMean > last.controlCountMean && last.flaggedMoveBpsMean > last.controlMoveBpsMean;

console.log('');
console.log('MT107 required BOTH measures to move together for this to be crowding.');
console.log(`  at +${last.horizonS}s: count ${crowded || last.flaggedCountMean > last.controlCountMean ? 'higher' : 'not higher'}, ` +
  `price ${last.flaggedMoveBpsMean > last.controlMoveBpsMean ? 'higher' : 'not higher'} than control`);
console.log(`  verdict: ${crowded ? 'CROWDING' : 'NOT DEMONSTRATED'}`);
console.log('');
console.log('For scale: the round-trip cost floor is 246.9 bps at the bottom tier and ~50 at 20/5.');
console.log('A price move above that between the wallet\'s buy and ours removes the edge before it starts.');

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/mt107-crowding.json',
  `${JSON.stringify(
    {
      probedUtc: new Date().toISOString(),
      ledgerRow: 'MT107',
      endpoint: ENDPOINT,
      runMinutes: RUN_MS / 60_000,
      watchedWallets: watched.size,
      buysSeen: seenBuys,
      flaggedBuysSeen: flaggedBuys,
      windowsFlagged: flagged.length,
      windowsControl: control.length,
      controlRate: CONTROL_RATE,
      horizons: rows,
      verdict: crowded ? 'CROWDING' : 'NOT_DEMONSTRATED',
    },
    null,
    2,
  )}\n`,
);
console.log('artifacts/mt107-crowding.json');
