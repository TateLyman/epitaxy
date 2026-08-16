import { openDb } from '../packages/storage/src/db.js';

const d = openDb({ path: 'data/runtime.db', readonly: true, skipBackup: true });
const r = d
  .prepare(
    'SELECT trajectory_id, leg, fingerprint, instruction_count, program_ids, accounts, writable_accounts FROM leg_account_plans LIMIT 1',
  )
  .get() as
  | {
      leg: string;
      fingerprint: string;
      instruction_count: number;
      program_ids: string;
      accounts: string;
      writable_accounts: string;
    }
  | undefined;

if (r === undefined) {
  console.log('no plans recorded');
} else {
  console.log('leg', r.leg, '| instructions', r.instruction_count, '| fingerprint', r.fingerprint.slice(0, 16));
  console.log('programs :', (JSON.parse(r.program_ids) as string[]).join(', '));
  const a = JSON.parse(r.accounts) as string[];
  const w = JSON.parse(r.writable_accounts) as string[];
  console.log('accounts :', a.length, 'of which writable', w.length);
  for (const x of a) console.log('  ', x, w.includes(x) ? '(w)' : '');
}
