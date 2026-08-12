import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';

/**
 * P2a.1 §P0.1 and §P1.1 — audit every historical paper fill for executable
 * buildability, and trace every impact number back to what the provider sent.
 *
 * Read-only. Reports what is in the corpus; changes nothing.
 */

const db = new DatabaseSync(loadSecrets().databasePath, { readOnly: true });
const q = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...(args as never[])) as T[];

const line = (s: string): void => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

// ---------------------------------------------------------------- P0.1
line('P0.1  BUILDABILITY OF EVERY STORED QUOTE');

const quoteTotals = q<{ n: number; buildable: number; withTx: number; err: number }>(
  `SELECT COUNT(*) AS n,
          COALESCE(SUM(transaction_buildable),0) AS buildable,
          COALESCE(SUM(CASE WHEN transaction_buildable = 1 THEN 1 ELSE 0 END),0) AS withTx,
          COALESCE(SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END),0) AS err
   FROM quotes`,
)[0]!;
console.log(`quotes stored                 ${quoteTotals.n}`);
console.log(`  transaction_buildable = 1   ${quoteTotals.buildable}`);
console.log(`  carrying an errorCode       ${quoteTotals.err}`);

const bySide = q<{ side: string; n: number; buildable: number }>(
  `SELECT side, COUNT(*) AS n, COALESCE(SUM(transaction_buildable),0) AS buildable
   FROM quotes GROUP BY side ORDER BY side`,
);
for (const r of bySide) console.log(`  side=${r.side.padEnd(5)} ${String(r.n).padStart(6)} quotes, ${r.buildable} buildable`);

// ---------------------------------------------------------------- fills
line('P0.1  FILL PROVENANCE');

const fillCols = q<{ name: string }>("SELECT name FROM pragma_table_info('fills')").map((r) => r.name);
console.log(`fills columns: ${fillCols.join(', ')}`);
console.log(`\nfills carry a quote reference: ${fillCols.includes('quote_id') ? 'yes' : 'NO'}`);
if (!fillCols.includes('quote_id')) {
  console.log(
    '  A fill therefore cannot be tied to the exact quote it was priced from.\n' +
      '  Provenance is only (mint, side, timestamp) proximity. Recorded as a defect.',
  );
}

const fills = q<{
  fill_id: string;
  position_id: string;
  mint: string;
  side: string;
  simulated: number;
  signature: string | null;
  utc: number;
}>(
  `SELECT fill_id, intent_id AS position_id, mint, side, simulated, signature, utc_ms AS utc
   FROM fills ORDER BY utc_ms`,
);

line('P0.1  EVERY PAPER FILL, CLASSIFIED');

/*
 * The classification does not depend on resolving the missing fill->quote link.
 * Zero of the stored quotes are buildable, so whichever quote priced a given
 * fill, that quote had no transaction. Every leg is QUOTE_ONLY by construction.
 * This is stated as a corpus-wide fact rather than reconstructed per row,
 * because a per-row guess would imply a precision the schema does not support.
 */
const anyBuildable = quoteTotals.buildable > 0;
const cls = anyBuildable ? 'MIXED — resolve per row' : 'QUOTE_ONLY';
console.log(`fills stored                  ${fills.length}`);
console.log(`  buy legs                    ${fills.filter((f) => f.side === 'buy').length}`);
console.log(`  sell legs                   ${fills.filter((f) => f.side === 'sell').length}`);
console.log(`  simulated                   ${fills.filter((f) => f.simulated === 1).length}`);
console.log(`  carrying a signature        ${fills.filter((f) => f.signature !== null).length}`);
console.log(`\n  classification of every leg: ${cls}`);
console.log('    no taker was supplied, so Jupiter returned no transaction to validate');

line('P0.1  PAPER_PNL_ELIGIBLE POSITIONS');

const positions = q<{ position_id: string; closed: number | null; realized: string | null }>(
  'SELECT position_id, closed_utc_ms AS closed, realized_lamports AS realized FROM positions',
);
const closed = positions.filter((p) => p.realized !== null);
const eligible = anyBuildable ? -1 : 0;

console.log(`positions                     ${positions.length}`);
console.log(`  closed with realised PnL    ${closed.length}`);
console.log(`  PAPER_PNL_ELIGIBLE          ${eligible === -1 ? 'requires per-row resolution' : eligible}`);
if (eligible === 0) {
  let sum = 0n;
  for (const c of closed) sum += BigInt(c.realized!);
  console.log(
    `\n  ${closed.length} closed positions carry ${(Number(sum) / 1e9).toFixed(9)} SOL of realised paper PnL.\n` +
      '  NONE of it is executable evidence: neither leg of any trade had a\n' +
      '  buildable, policy-validated transaction at decision time.\n\n' +
      '  0 historical paper trades establish executable PnL',
  );
}

// ---------------------------------------------------------------- P1.1
line('P1.1  RAW IMPACT DISTRIBUTION AS STORED');

const imp = q<{ n: number; mn: number; mx: number; neg: number; zero: number; gt1: number }>(
  `SELECT COUNT(*) AS n, MIN(price_impact_pct) AS mn, MAX(price_impact_pct) AS mx,
          SUM(CASE WHEN price_impact_pct < 0 THEN 1 ELSE 0 END) AS neg,
          SUM(CASE WHEN price_impact_pct = 0 THEN 1 ELSE 0 END) AS zero,
          SUM(CASE WHEN price_impact_pct > 1 THEN 1 ELSE 0 END) AS gt1
   FROM quotes`,
)[0]!;
console.log(`quotes                        ${imp.n}`);
console.log(`  min price_impact_pct        ${imp.mn}`);
console.log(`  max price_impact_pct        ${imp.mx}`);
console.log(`  NEGATIVE (schema/parser?)   ${imp.neg}`);
console.log(`  exactly 0                   ${imp.zero}   <- includes any missing field coerced to 0`);
console.log(`  greater than 1              ${imp.gt1}   <- outside Jupiter's documented 0..1 decimal`);

line('P1.1  SAME FIELD ON THE MARK SERIES (position_marks)');
const mimp = q<{ n: number; mn: number; mx: number; neg: number; nulls: number }>(
  `SELECT COUNT(*) AS n, MIN(raw_price_impact_pct) AS mn, MAX(raw_price_impact_pct) AS mx,
          SUM(CASE WHEN raw_price_impact_pct < 0 THEN 1 ELSE 0 END) AS neg,
          SUM(CASE WHEN raw_price_impact_pct IS NULL THEN 1 ELSE 0 END) AS nulls
   FROM position_marks`,
)[0]!;
console.log(`marks                         ${mimp.n}`);
console.log(`  min raw_price_impact_pct    ${mimp.mn}`);
console.log(`  max raw_price_impact_pct    ${mimp.mx}`);
console.log(`  NEGATIVE                    ${mimp.neg}`);
console.log(`  NULL (unknown, honest)      ${mimp.nulls}`);

const signed = q<{ n: number; mn: number; mx: number }>(
  `SELECT COUNT(*) AS n, MIN(raw_price_impact_bps_signed) AS mn, MAX(raw_price_impact_bps_signed) AS mx
   FROM position_marks WHERE raw_price_impact_bps_signed IS NOT NULL`,
)[0]!;
console.log(`  signed bps range            ${signed.mn} .. ${signed.mx}  (n=${signed.n})`);

line('P1.1  IS THE RAW PROVIDER PAYLOAD PERSISTED ANYWHERE?');
const cols = q<{ name: string }>(`SELECT name FROM pragma_table_info('quotes')`).map((r) => r.name);
console.log(`quotes columns: ${cols.join(', ')}`);
const hasRaw = cols.some((c) => /raw|payload|body|json/i.test(c));
console.log(`\nraw response or hash stored:  ${hasRaw ? 'yes' : 'NO — only derived numbers survive'}`);

// ---------------------------------------------------------------- versions
line('P2.1  STRATEGY VERSION MIX ACROSS THE POSITION CORPUS');
for (const r of q<{ v: string; n: number; realized: number }>(
  `SELECT strategy_version AS v, COUNT(*) AS n,
          SUM(CASE WHEN realized_lamports IS NOT NULL THEN 1 ELSE 0 END) AS realized
   FROM positions GROUP BY strategy_version ORDER BY v`,
)) {
  console.log(`  ${r.v.padEnd(28)} ${String(r.n).padStart(4)} positions, ${r.realized} closed`);
}

line('P2.1  MARK CADENCE REGIMES PRESENT IN THE CORPUS');
for (const r of q<{ backfilled: number; n: number; positions: number }>(
  `SELECT backfilled, COUNT(*) AS n, COUNT(DISTINCT position_id) AS positions
   FROM position_marks GROUP BY backfilled`,
)) {
  console.log(`  backfilled=${r.backfilled}  ${r.n} marks over ${r.positions} positions`);
}

db.close();
