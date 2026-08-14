/**
 * What the chain says about the mints this system screens.
 *
 * P11 wired the mint read into every mode. This is the first thing that read
 * back what it collected, and it answers two questions the corpus could not
 * answer at all before:
 *
 *   how often does a candidate carry something that can take the position
 *   is the P14 parity coverage gap a gap in the SAMPLE or in the UNIVERSE
 *
 * The second matters because "no legacy SPL mint appeared in the parity matrix"
 * has two very different explanations, and only one of them is a reason to stop
 * looking.
 *
 * Read-only, no network. The whole point is that these facts are already
 * banked.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { EXTENSION_NAMES, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../packages/solana/src/mint.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const db = openDb({ path: loadSecrets().databasePath, readonly: true });
const all = <T>(sql: string, p: unknown[] = []): T[] => {
  try {
    return db.prepare(sql).all(...(p as never[])) as T[];
  } catch {
    return [];
  }
};
const one = <T>(sql: string): T | null => all<T>(sql)[0] ?? null;

const total = one<{ n: number }>('SELECT COUNT(*) n FROM direct_mint_facts')?.n ?? 0;
const read = one<{ n: number }>("SELECT COUNT(*) n FROM direct_mint_facts WHERE overall <> 'UNKNOWN'")?.n ?? 0;

const byProgram = all<{ token_program: string | null; n: number }>(
  'SELECT token_program, COUNT(*) n FROM direct_mint_facts GROUP BY 1 ORDER BY n DESC',
);

/** Which single fact makes each hostile mint hostile. */
const hostile = all<{ field: string; n: number }>(
  `SELECT 'mint_authority' AS field, COUNT(*) n FROM direct_mint_facts WHERE mint_authority='HOSTILE'
   UNION ALL SELECT 'freeze_authority', COUNT(*) FROM direct_mint_facts WHERE freeze_authority='HOSTILE'
   UNION ALL SELECT 'permanent_delegate', COUNT(*) FROM direct_mint_facts WHERE permanent_delegate='HOSTILE'
   UNION ALL SELECT 'transfer_hook', COUNT(*) FROM direct_mint_facts WHERE transfer_hook='HOSTILE'
   UNION ALL SELECT 'pausable', COUNT(*) FROM direct_mint_facts WHERE pausable='HOSTILE'
   UNION ALL SELECT 'non_transferable', COUNT(*) FROM direct_mint_facts WHERE non_transferable='HOSTILE'
   UNION ALL SELECT 'default_account_state', COUNT(*) FROM direct_mint_facts WHERE default_account_state='HOSTILE'
   UNION ALL SELECT 'confidential', COUNT(*) FROM direct_mint_facts WHERE confidential='HOSTILE'`,
).filter((r) => r.n > 0);

const fees = all<{ bps: number; n: number }>(
  'SELECT current_epoch_fee_bps bps, COUNT(*) n FROM direct_mint_facts WHERE current_epoch_fee_bps > 0 GROUP BY 1 ORDER BY n DESC',
);

const extensionCounts = new Map<number, number>();
for (const r of all<{ extension_types: string; n: number }>(
  "SELECT extension_types, COUNT(*) n FROM direct_mint_facts WHERE extension_types <> '' GROUP BY 1",
)) {
  for (const t of r.extension_types.split(',')) {
    const k = Number(t);
    if (Number.isFinite(k)) extensionCounts.set(k, (extensionCounts.get(k) ?? 0) + r.n);
  }
}

const legacy = byProgram.find((r) => r.token_program === TOKEN_PROGRAM)?.n ?? 0;
const t2022 = byProgram.find((r) => r.token_program === TOKEN_2022_PROGRAM)?.n ?? 0;
const unread = byProgram.find((r) => r.token_program === null)?.n ?? 0;

/**
 * The mechanics consequence of a transfer fee, stated against the measured
 * floor rather than in the abstract.
 *
 * A fee is charged on the way in AND on the way out, so a 300 bps mint pays
 * 600 bps on a round trip — against a measured AMM drag of 241.5 bps. It more
 * than doubles the cost of trading, and until P11 nothing in this corpus knew
 * which mints those were.
 */
const MEASURED_AMM_DRAG_BPS = 241.5;
const feeImpact = fees.map((f) => ({
  transferFeeBps: f.bps,
  mints: f.n,
  roundTripFeeBps: f.bps * 2,
  totalMechanicsBps: f.bps * 2 + MEASURED_AMM_DRAG_BPS,
  multipleOfBaselineMechanics: Number(((f.bps * 2 + MEASURED_AMM_DRAG_BPS) / MEASURED_AMM_DRAG_BPS).toFixed(2)),
}));

const summary = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'schema-v34',
    sampleInclusionQuery: 'direct_mint_facts, every mint the screening loop has read',
  }),
  mints: total,
  read,
  unread,
  byTokenProgram: byProgram.map((r) => ({
    program: r.token_program ?? '(unread)',
    label:
      r.token_program === TOKEN_PROGRAM
        ? 'legacy SPL Token'
        : r.token_program === TOKEN_2022_PROGRAM
          ? 'Token-2022'
          : 'unread',
    mints: r.n,
  })),
  hostileByField: hostile,
  hostileTotal: one<{ n: number }>("SELECT COUNT(*) n FROM direct_mint_facts WHERE overall='HOSTILE'")?.n ?? 0,
  transferFees: feeImpact,
  extensions: [...extensionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => ({ type, name: EXTENSION_NAMES[type] ?? '(unknown to this decoder)', mints: n })),
  /** Zero means the decoder covered everything it met. Not that none exist. */
  unknownExtensionMints: one<{ n: number }>('SELECT COUNT(*) n FROM direct_mint_facts WHERE has_unknown_extension=1')?.n ?? 0,
  /** A pending fee-schedule change. Zero means the epoch selection has not had to fire. */
  pendingFeeScheduleChange:
    one<{ n: number }>(
      'SELECT COUNT(*) n FROM direct_mint_facts WHERE worst_case_fee_bps IS NOT NULL AND worst_case_fee_bps <> current_epoch_fee_bps',
    )?.n ?? 0,
  providerDisagreements:
    one<{ n: number }>('SELECT COUNT(*) n FROM direct_mint_facts WHERE provider_disagreements IS NOT NULL')?.n ?? 0,
  /**
   * The P14 question: is the parity matrix missing legacy SPL because the
   * universe has none, or because the sample did?
   */
  parityCoverage: {
    legacyMintsInCorpus: legacy,
    token2022MintsInCorpus: t2022,
    verdict:
      legacy > 0
        ? 'legacy SPL base is a SAMPLING gap in the parity matrix, not a universe gap: the corpus holds ' +
          `${legacy} legacy mints`
        : 'no legacy SPL mint has been read, so the gap cannot yet be attributed',
  },
  note:
    'Every figure here is chain-authoritative and none of it existed before P11: the mint read was gated ' +
    'on capitalAtRisk(mode), so paper - the mode that produces this entire corpus - never read one.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/mint-facts-status.json', JSON.stringify(summary, null, 2));

console.log(`${total} mints, ${read} read, ${unread} unread\n`);
console.log('by token program:');
for (const r of summary.byTokenProgram) console.log(`  ${r.label.padEnd(18)} ${r.mints}`);
console.log(`\nhostile: ${summary.hostileTotal} of ${read} read (${((summary.hostileTotal / Math.max(read, 1)) * 100).toFixed(2)}%)`);
for (const h of hostile) console.log(`  ${h.field.padEnd(24)} ${h.n}`);
console.log('\ntransfer fees:');
for (const f of feeImpact) {
  console.log(
    `  ${f.transferFeeBps} bps x ${f.mints} mints -> ${f.roundTripFeeBps} bps per round trip, ` +
      `${f.multipleOfBaselineMechanics}x the measured mechanics floor`,
  );
}
console.log('\nextensions:');
for (const e of summary.extensions) console.log(`  ${String(e.type).padStart(3)} ${e.name.padEnd(22)} ${e.mints}`);
console.log(`\nunknown extensions ${summary.unknownExtensionMints}  pending fee changes ${summary.pendingFeeScheduleChange}  provider disagreements ${summary.providerDisagreements}`);
console.log(`\n${summary.parityCoverage.verdict}`);
console.log('\nartifacts/mint-facts-status.json');
db.close();
