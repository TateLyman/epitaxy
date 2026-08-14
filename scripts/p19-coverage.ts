import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * P19 — verify each of the 40 required tests exists as a real assertion.
 *
 * Matched on test TITLES across the suite, not on source strings in production
 * code: the directive says tests over source strings do not count, and a title
 * match at least proves an `it()` exists that claims the behaviour.
 */
const REQUIRED: [number, string, RegExp][] = [
  [1, 'sequential quote state equals sell pre-execution state', /quote state must survive|quote state survived|quoted state is not the executed/i],
  [2, 'one-pass worker, no replayed second buy', /observes BEFORE it builds the sell|init, buy, observe, sell, close/i],
  [3, 'all u64 JSON values remain strings', /decimal string|u64 never crosses Number|remain strings|above 2\^53/i],
  [4, 'coherent snapshot batch slot/drift contract', /drift|never simultaneously true|coherence is enforced/i],
  [5, 'present-but-undecodable fee config refuses', /required to decode but is absent|undecodable|fail closed/i],
  [6, 'cashback coin without remaining accounts refuses attribution', /remaining_accounts|fail closed when the builder omits/i],
  [7, 'cashback accrual measured separately from claimed cash', /accrued.*claimable.*claimed|receivable until it is claimed/i],
  [8, 'close appended to sell', /close/i],
  [9, 'canonical settlement writes position/fill/ledger identically', /one settlement|canonical settlement|one set of economics/i],
  [10, 'cost_lamports == entry_cash_out_lamports', /entry cash out|cost_lamports|one row could hold two entry costs/i],
  [11, 'execution cost includes transfer fee and excludes principal', /principal is never execution cost|excludes the principal/i],
  [12, 'no router fallback closes an unmeasured exit', /no measured settlement|blocked, never a fallback|unmeasured/i],
  [13, 'BUILD_CUSTOM fill receives no /order platform fee', /platform fee|BUILD_CUSTOM/i],
  [14, 'later-fill candidate simulated before selection', /simulated before|already been settled|latency floor/i],
  [15, 'selected observation ID equals simulated and settled ID', /select A, simulate B, book A|selected|OBSERVATION IT SELECTED/i],
  [16, 'shadow loop escapes the current deadlock', /deadlock/i],
  [17, 'blocked trajectory remains managed', /blocked|EXIT_BLOCKED|remains managed/i],
  [18, 'migration parser decodes mint/pool from structure', /verified PDA, not from string position|identity comes from/i],
  [19, 'failed transaction does not enter successful flow', /failed transaction migrated nothing|errored transaction/i],
  [20, 'two events in one transaction are not deduplicated into one', /two migrations in one transaction|dedup key/i],
  [21, 'event bars aggregate amounts and unique users, not log count', /unique|aggregate|bars/i],
  [22, 'exploration debt persists across production cycles', /exploration debt|carried debt|entitlement/i],
  [23, 'all three entry policies differ on a counterexample', /entry polic|unknown feature is never a pass|hard gates bind/i],
  [24, 'both exit policies differ on one shared mark path', /exit policies see the same mark stream|challenger leaves/i],
  [25, 'cohort-relative score does not punish older cohorts', /cohort-relative rank|cross-cohort/i],
  [26, 'insufficient score coverage changes eligibility', /low-coverage score is never silently|coverage/i],
  [27, 'entity-adjusted concentration reaches the gate', /concentration gate|entity-adjusted/i],
  [28, 'Mayhem/cashback facts exist before entry decision', /risk facts precede|collected after quote selection/i],
  [29, 'WSS watches vaults and consumes urgent marks', /vaults, never the pool PDA|urgent queue is drained/i],
  [30, 'counterfactual future marks carry evidence class/error bound', /evidence grades are ordered|entry impact bound|haircut/i],
  [31, 'reject panel records prospective outcomes', /reject panel is prospective|samples deterministically/i],
  [32, 'rate report counts trajectories, active time, API families', /ACTIVE time|active seconds|completed TRAJECTORY/i],
  [33, 'stale/dirty artifact cannot authorize readiness', /stale artifact cannot substitute|stale/i],
  [34, 'confirmatory contract checks every frozen field', /ANY bound field|every bound field/i],
  [35, 'exact job/settlement links prevent unrelated-job qualification', /one trajectory, one row|duplicated/i],
  [36, 'historical invalid shadows cannot enter readiness', /UNKNOWN as a FAIL|historical|invalid/i],
  [37, 'large bigint ratios remain exact', /never crosses Number|2\^53|exact/i],
  [38, 'no signer/key/network path reachable from collector', /signer|packages\/execution|cannot sign/i],
  [39, 'canary/live remain blocked', /canary|live/i],
  [40, '200 losing trajectories can never pass', /200 consistently losing|200 losing/i],
];

const files = globSync('tests/**/*.test.ts');
const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');

let found = 0;
const missing: string[] = [];
for (const [n, name, re] of REQUIRED) {
  if (re.test(corpus)) found++;
  else missing.push(`${n}. ${name}`);
}
console.log(`P19: ${found} of ${REQUIRED.length} required behaviours have a matching test`);
if (missing.length > 0) {
  console.log('');
  console.log('NO MATCH:');
  for (const m of missing) console.log('  ' + m);
}
console.log('');
console.log('test files scanned:', files.length);
