import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * Invalidate the migration rows written by the PDA-only decoder.
 *
 * Before the discriminator check existed, `decodeMigrations` accepted any
 * instruction whose derived pool appeared in the transaction's account keys.
 * A `buy` or a `sell` references that same pool, so ordinary swaps were
 * recorded as migrations — one mint was written seven times in a single run.
 *
 * These rows are NOT deleted. The corpus is the research asset and a record of a
 * decoder that was wrong is itself a finding; deleting it would leave the
 * database looking as though the mistake never happened. They are marked so the
 * candidate queue — which selects on `reversal_status = 'CONFIRMED'` — stops
 * returning them, while the rows themselves stay auditable.
 */
const MARK = 'MISIDENTIFIED_BY_PDA_ONLY_DECODER';

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, skipBackup: true });

const before = db.prepare('SELECT COUNT(*) c FROM confirmed_migrations').get() as { c: number };
const byStatus = db
  .prepare("SELECT COALESCE(reversal_status,'NULL') s, COUNT(*) c FROM confirmed_migrations GROUP BY s")
  .all();
console.log('rows before:', before.c, JSON.stringify(byStatus));

const res = db
  .prepare(`UPDATE confirmed_migrations SET reversal_status = ? WHERE reversal_status = 'CONFIRMED'`)
  .run(MARK);
console.log('marked', res.changes, 'row(s) as', MARK);

const after = db
  .prepare("SELECT COALESCE(reversal_status,'NULL') s, COUNT(*) c FROM confirmed_migrations GROUP BY s")
  .all();
console.log('rows after :', JSON.stringify(after));
console.log('');
console.log('Nothing was deleted. The rows remain auditable and simply leave the candidate queue.');
db.close();
