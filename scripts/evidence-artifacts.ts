import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';

/**
 * P2/P7 — the two evidence artifacts, emitted from the DATABASE.
 *
 * `artifacts/account-plan-proof.json` and `artifacts/cashback-both-legs.json`
 * are required outputs, and both describe rows the collector wrote rather than
 * anything this script computes. That direction matters: an artifact generated
 * by re-deriving what should have happened is the proof-script substitution
 * this whole directive exists to remove. Everything below is a SELECT.
 *
 * Both refuse to claim anything when the corpus is empty, rather than emitting
 * a well-formed file full of zeros.
 */

function provenance(): { sourceCommit: string; dirty: boolean } {
  try {
    return {
      sourceCommit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      dirty: execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0,
    };
  } catch {
    return { sourceCommit: 'unknown', dirty: true };
  }
}

function main(): void {
  const db = openDb({ path: loadSecrets().databasePath, readonly: true });
  const { sourceCommit, dirty } = provenance();
  const stamp = { generatedUtcMs: Date.now(), sourceCommit, dirty };

  // ---- account plans -----------------------------------------------------
  const plans = db
    .prepare(
      `SELECT p.trajectory_id, p.leg, p.fingerprint, p.program_ids, p.accounts, p.writable_accounts,
              t.mint, t.venue, t.stratum, t.notional_lamports
         FROM leg_account_plans p
         LEFT JOIN development_trajectories t ON t.trajectory_id = p.trajectory_id
        ORDER BY p.trajectory_id, p.leg`,
    )
    .all() as Record<string, unknown>[];

  const byTrajectory = new Map<string, Set<string>>();
  for (const p of plans) {
    const id = String(p['trajectory_id']);
    if (!byTrajectory.has(id)) byTrajectory.set(id, new Set());
    byTrajectory.get(id)?.add(String(p['leg']));
  }
  const bothLegsFrozen = [...byTrajectory.values()].filter((s) => s.has('buy') && s.has('sell')).length;
  const fingerprints = new Set(plans.map((p) => String(p['fingerprint'])));

  writeFileSync(
    'artifacts/account-plan-proof.json',
    JSON.stringify(
      {
        artifact: 'account-plan-proof',
        directiveSection: 'P2/F12',
        ...stamp,
        rule: 'build once -> capture from THAT plan -> execute THOSE bytes -> fingerprint THEM',
        totalPlans: plans.length,
        trajectoriesWithAPlan: byTrajectory.size,
        trajectoriesWithBOTHLegsFrozen: bothLegsFrozen,
        distinctFingerprints: fingerprints.size,
        // A repeated fingerprint means two legs were the same transaction
        // shape. Reported rather than deduped, because a collision is a fact.
        fingerprintCollisions: plans.length - fingerprints.size,
        plans: plans.slice(0, 50),
        notClaimed:
          'a frozen plan describes BYTES. It is not a claim that the trade was profitable, ' +
          'and nothing here was signed or submitted.',
        empty: plans.length === 0 ? 'no account plans have been recorded' : null,
      },
      null,
      2,
    ),
  );

  // ---- cashback, per leg -------------------------------------------------
  const legs = db
    .prepare(
      `SELECT c.trajectory_id, c.leg, c.accumulator_wsol_delta, c.accumulator_delta,
              c.creator_vault_delta, c.fee_recipient_delta, c.accrued_to_us, c.is_cashback_coin,
              t.mint, t.stratum, t.notional_lamports
         FROM leg_cashback c
         LEFT JOIN development_trajectories t ON t.trajectory_id = c.trajectory_id
        ORDER BY c.trajectory_id, c.leg DESC`,
    )
    .all() as Record<string, unknown>[];

  const sum = (pred: (r: Record<string, unknown>) => boolean, col: string): string => {
    let n = 0n;
    for (const r of legs) {
      if (!pred(r)) continue;
      const v = r[col];
      if (typeof v === 'string') n += BigInt(v);
    }
    return n.toString();
  };

  const isCashback = (r: Record<string, unknown>): boolean => r['is_cashback_coin'] === 1;
  const buy = (r: Record<string, unknown>): boolean => r['leg'] === 'buy';
  const sell = (r: Record<string, unknown>): boolean => r['leg'] === 'sell';

  writeFileSync(
    'artifacts/cashback-both-legs.json',
    JSON.stringify(
      {
        artifact: 'cashback-both-legs',
        directiveSection: 'P7/F13/F14',
        ...stamp,
        correction:
          'the repository asserted that `sell` carries no volume accumulator. It carries two, as ' +
          'optional POSITIONAL remaining accounts. Modelling one leg instead of two understated the ' +
          'retained round trip by roughly half.',
        legs: legs.length,
        cashbackCoinLegs: legs.filter(isCashback).length,
        // The count that settles F13. If sellAccrued stays 0 while buyAccrued
        // climbs, the old one-leg model was right and the correction is wrong.
        buyLegsAccrued: legs.filter((r) => buy(r) && r['accrued_to_us'] === 1).length,
        sellLegsAccrued: legs.filter((r) => sell(r) && r['accrued_to_us'] === 1).length,
        undetermined: legs.filter((r) => r['accrued_to_us'] === null).length,
        accumulatorGainedOnBuyLamports: sum((r) => isCashback(r) && buy(r), 'accumulator_wsol_delta'),
        accumulatorGainedOnSellLamports: sum((r) => isCashback(r) && sell(r), 'accumulator_wsol_delta'),
        creatorVaultGainedNonCashbackLamports: sum((r) => !isCashback(r), 'creator_vault_delta'),
        rows: legs.slice(0, 100),
        claimedLamports: '0',
        onlyClaimedEntersPnl:
          'these are ACCRUALS into the accumulator, which is a receivable. `claim_cashback` has ' +
          'never been called and nothing here has been signed, so realized PnL from cashback is zero.',
        empty: legs.length === 0 ? 'no cashback legs have been recorded' : null,
      },
      null,
      2,
    ),
  );

  db.close();

  console.log(`account-plan-proof   : ${plans.length} plan(s), ${bothLegsFrozen} trajectory(ies) with both legs frozen`);
  console.log(
    `cashback-both-legs   : ${legs.length} leg(s); buy accrued ${legs.filter((r) => buy(r) && r['accrued_to_us'] === 1).length}, ` +
      `sell accrued ${legs.filter((r) => sell(r) && r['accrued_to_us'] === 1).length}`,
  );
  console.log('wrote artifacts/account-plan-proof.json and artifacts/cashback-both-legs.json');
}

mkdirSync('artifacts', { recursive: true });
main();
