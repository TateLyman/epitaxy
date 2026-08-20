// Does the admitted arm drift, and is it the gate or is it liquidity?
//
// The panel: reject_tracking carries repeated forward price observations per mint.
// A return is computed BETWEEN TWO FORWARD OBSERVATIONS and never touches the
// screening anchor, so a stale anchor price cannot manufacture it.
//
// THE CONFOUND I need to rule out: admitted mints passed a liquidity gate, so
// they trade. Most rejects are illiquid and their price simply does not move —
// a 0.00% median for rejects would then be "no trades", not "no drift", and the
// comparison would be measuring liquidity rather than the gate.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/runtime.db', { readOnly: true });

const obs = db
  .prepare(
    `SELECT mint, observed_utc_ms t, price_usd p, liquidity_usd liq
       FROM reject_tracking WHERE price_usd IS NOT NULL AND price_usd > 0
      ORDER BY mint, observed_utc_ms`,
  )
  .all();
console.log('priced observations:', obs.length);

const byMint = new Map();
for (const o of obs) {
  let a = byMint.get(o.mint);
  if (a === undefined) { a = []; byMint.set(o.mint, a); }
  a.push(o);
}

const screen = db
  .prepare(
    `SELECT mint, evaluated_utc_ms t, eligible, strategy_version v FROM screenings`,
  )
  .all();
console.log('screenings:', screen.length, ' mints with a price path:', byMint.size);

/** First observation at or after t+ms, within a tolerance. */
function at(path, t0, ms, tolMs) {
  const target = t0 + ms;
  let best = null;
  for (const o of path) {
    if (o.t < target) continue;
    if (o.t > target + tolMs) break;
    best = o;
    break;
  }
  return best;
}

const TOL = 240_000; // 4 minutes either side of the target

function bucket(rows) {
  const rets = rows.map((r) => r.ret).sort((a, b) => a - b);
  if (rets.length === 0) return null;
  const p = (x) => rets[Math.floor(x * (rets.length - 1))];
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const pos = rets.filter((v) => v > 0).length / rets.length;
  const days = new Set(rows.map((r) => r.day));
  return { n: rets.length, mean, median: p(0.5), p10: p(0.1), p90: p(0.9), pos, days: days.size };
}

function run(label, fromMs, toMs, filter) {
  const rows = [];
  for (const s of screen) {
    if (!filter(s)) continue;
    const path = byMint.get(s.mint);
    if (path === undefined) continue;
    const a = at(path, s.t, fromMs, TOL);
    const b = at(path, s.t, toMs, TOL);
    if (a === null || b === null || a.p <= 0) continue;
    if (b.t <= a.t) continue;
    rows.push({
      ret: b.p / a.p - 1,
      day: new Date(a.t).toISOString().slice(0, 10),
      liq: a.liq,
      moved: b.p !== a.p,
    });
  }
  const st = bucket(rows);
  if (st === null) { console.log(`  ${label.padEnd(38)} no rows`); return null; }
  const movedShare = rows.filter((r) => r.moved).length / rows.length;
  console.log(
    `  ${label.padEnd(38)} n=${String(st.n).padStart(6)}  mean ${(100 * st.mean).toFixed(2).padStart(8)}%  ` +
      `median ${(100 * st.median).toFixed(2).padStart(7)}%  pos ${(100 * st.pos).toFixed(1).padStart(5)}%  ` +
      `moved ${(100 * movedShare).toFixed(1).padStart(5)}%  days ${st.days}`,
  );
  return { ...st, movedShare, rows };
}

console.log('\n=== +5m -> +15m, the window the corpus agent flagged ===');
const elig = run('eligible=1 (admitted)', 300_000, 900_000, (s) => s.eligible === 1);
run('eligible=0 (all rejects)', 300_000, 900_000, (s) => s.eligible === 0);

console.log('\n=== THE CONFOUND: rejects that actually MOVED at all ===');
console.log('  (if rejects are flat because nothing trades, the contrast is liquidity, not the gate)');

// Rebuild the reject bucket restricted to paths whose price changed in the window.
function runMovedOnly(label, fromMs, toMs, filter) {
  const rows = [];
  for (const s of screen) {
    if (!filter(s)) continue;
    const path = byMint.get(s.mint);
    if (path === undefined) continue;
    const a = at(path, s.t, fromMs, TOL);
    const b = at(path, s.t, toMs, TOL);
    if (a === null || b === null || a.p <= 0) continue;
    if (b.t <= a.t) continue;
    if (b.p === a.p) continue; // price did not move at all
    rows.push({ ret: b.p / a.p - 1, day: new Date(a.t).toISOString().slice(0, 10) });
  }
  const st = bucket(rows);
  if (st === null) { console.log(`  ${label.padEnd(38)} no rows`); return null; }
  console.log(
    `  ${label.padEnd(38)} n=${String(st.n).padStart(6)}  mean ${(100 * st.mean).toFixed(2).padStart(8)}%  ` +
      `median ${(100 * st.median).toFixed(2).padStart(7)}%  pos ${(100 * st.pos).toFixed(1).padStart(5)}%  days ${st.days}`,
  );
  return st;
}
runMovedOnly('eligible=0, price MOVED', 300_000, 900_000, (s) => s.eligible === 0);
runMovedOnly('eligible=1, price MOVED', 300_000, 900_000, (s) => s.eligible === 1);

console.log('\n=== by gate version, admitted only, +5m -> +15m ===');
for (const v of ['delayed-momentum-v0.2.0', 'delayed-momentum-v0.4.0', 'delayed-momentum-v0.6.0']) {
  run(v, 300_000, 900_000, (s) => s.eligible === 1 && s.v === v);
}

console.log('\n=== admitted, at longer horizons ===');
for (const [lab, a, b] of [
  ['+5m -> +30m', 300_000, 1_800_000],
  ['+5m -> +60m', 300_000, 3_600_000],
  ['+15m -> +60m', 900_000, 3_600_000],
  ['+5m -> +24h', 300_000, 86_400_000],
]) {
  run(lab, a, b, (s) => s.eligible === 1);
}

if (elig !== null) {
  console.log('\n=== day clustering of the admitted +5m->+15m cell ===');
  const byDay = new Map();
  for (const r of elig.rows) {
    let a = byDay.get(r.day);
    if (a === undefined) { a = []; byDay.set(r.day, a); }
    a.push(r.ret);
  }
  for (const [d, a] of [...byDay.entries()].sort()) {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`  ${d}  n=${String(a.length).padStart(5)}  mean ${(100 * m).toFixed(2)}%`);
  }
}
db.close();
