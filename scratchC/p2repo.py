# -*- coding: utf-8 -*-
import io

ADD = '''

/**
 * P2/F12 — persist the exact plan of a leg's bytes.
 *
 * Append-only, like every other evidence row here. A plan that could be
 * rewritten would let a later rebuild redefine what the earlier execution was,
 * which is precisely the substitution freezing it exists to prevent.
 */
export function insertAccountPlan(
  db: Db,
  trajectoryId: string,
  plan: {
    leg: string;
    fingerprint: string;
    instructions: readonly unknown[];
    programIds: readonly string[];
    accounts: readonly string[];
    writableAccounts: readonly string[];
  },
  recordedUtcMs: number,
): void {
  const existing = db
    .prepare('SELECT fingerprint f FROM leg_account_plans WHERE trajectory_id = ? AND leg = ?')
    .get(trajectoryId, plan.leg) as { f: string } | undefined;
  if (existing !== undefined) {
    // The same plan recorded twice is a retry and is fine. A DIFFERENT plan
    // under the same identity means the leg was rebuilt, which is the defect.
    if (existing.f === plan.fingerprint) return;
    throw new EvidenceReplaceRefused(`${trajectoryId}/${plan.leg}`);
  }
  db.prepare(
    `INSERT INTO leg_account_plans (
       trajectory_id, leg, fingerprint, instruction_count,
       plan_json, program_ids, accounts, writable_accounts, recorded_utc_ms
     ) VALUES (?,?,?,?, ?,?,?,?,?)`,
  ).run(
    trajectoryId,
    plan.leg,
    plan.fingerprint,
    plan.instructions.length,
    JSON.stringify(plan.instructions),
    JSON.stringify(plan.programIds),
    JSON.stringify(plan.accounts),
    JSON.stringify(plan.writableAccounts),
    recordedUtcMs,
  );
}

export function accountPlanFor(
  db: Db,
  trajectoryId: string,
  leg: string,
): { fingerprint: string; instruction_count: number; plan_json: string; accounts: string } | undefined {
  return db
    .prepare(
      `SELECT fingerprint, instruction_count, plan_json, accounts
         FROM leg_account_plans WHERE trajectory_id = ? AND leg = ?`,
    )
    .get(trajectoryId, leg) as never;
}

export function accountPlanCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) c FROM leg_account_plans').get() as { c: number }).c;
}
'''

p = 'packages/storage/src/trajectory-repo.ts'
s = io.open(p, encoding='utf-8').read()
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.rstrip('\n') + ADD)
print('ok')
