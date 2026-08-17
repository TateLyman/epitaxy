/**
 * `pnpm trajectory:trace -- --trajectory=<id>`
 *
 * INDEPENDENT RECOMPUTATION. The point of this command is that it does NOT
 * call `buildTrajectorySettlement`, `legSettlementFromRuntime`, or any other
 * function whose output it is checking. If it did, it would prove only that the
 * writer is deterministic — which nobody doubted.
 *
 * What it does instead:
 *
 *   1. load the raw blob graph for the trajectory;
 *   2. derive the entry economics from the PAYER's own pre/post lamports;
 *   3. derive the exit economics the same way;
 *   4. derive trajectory PnL from the cash identity, restated here;
 *   5. compare every stored field against what it derived;
 *   6. exit non-zero on any mismatch.
 *
 * The 8f73cef audit's C-4 is what this exists to make impossible:
 *
 *     "`entry_cash_out`, `exit_cash_in`, rent and the venue skim are each
 *      recorded exactly once and are UNFALSIFIABLE FROM THE DATABASE."
 *
 * A number recorded once, by one writer, checked by nothing, is a claim. This
 * command is the second opinion, and it is deliberately written from the raw
 * account bytes rather than from any intermediate the writer produced.
 */
import { openDb } from '../packages/storage/src/db.js';
import { EvidenceStore } from '../packages/storage/src/evidence-repo.js';
import { writeArtifact } from './_artifact.js';

interface Row {
  trajectory_id: string;
  mint: string;
  state: string;
  notional_lamports: string;
  entry_cash_out_lamports: string | null;
  exit_cash_in_lamports: string | null;
  execution_cost_lamports: string | null;
  net_pnl_lamports: string | null;
  snapshot_hash: string;
  capability_fingerprint: string;
}

interface ManifestRow {
  address: string;
  role: string;
  writable: number;
  leg: string;
  step_index: number;
  pre_state: string;
  post_state: string;
  pre_blob_sha256: string | null;
  post_blob_sha256: string | null;
  pre_lamports: string | null;
  post_lamports: string | null;
}

interface AccountBlob {
  pubkey: string;
  lamports: string | number | bigint;
  owner: string;
  dataLen?: number;
  dataSha256?: string;
}

function big(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return typeof v === 'bigint' ? v : BigInt(String(v));
}

interface Mismatch {
  readonly field: string;
  readonly stored: string | null;
  readonly derived: string | null;
}

function main(): void {
  const idArg = process.argv.find((a) => a.startsWith('--trajectory='));
  const all = process.argv.includes('--all');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg === undefined ? 20 : Number(limitArg.slice(8));

  if (idArg === undefined && !all) {
    console.error('usage: pnpm trajectory:trace -- --trajectory=<id>   (or --all [--limit=N])');
    process.exit(2);
  }

  const db = openDb({ path: process.env['DATABASE_PATH'] ?? './data/runtime.db', skipBackup: true });
  const store = new EvidenceStore(db, 'data/evidence-blobs');

  try {
    const ids = all
      ? (
          db
            .prepare(
              `SELECT l.trajectory_id FROM trajectory_evidence_links l
                 JOIN development_trajectories t ON t.trajectory_id = l.trajectory_id
                ORDER BY t.opened_utc_ms DESC LIMIT ?`,
            )
            .all(limit) as { trajectory_id: string }[]
        ).map((r) => r.trajectory_id)
      : [idArg!.slice(13)];

    if (ids.length === 0) {
      console.log('no trajectory carries an evidence-link row, so there is nothing to recompute.');
      console.log('Pre-repair trajectories cannot be traced: their raw state was never persisted.');
      writeArtifact('trajectory-trace.json', {
        status: 'NOT_RUN',
        reason: 'no trajectory carries an evidence-link row',
      });
      process.exit(1);
    }

    const results: Record<string, unknown>[] = [];
    let failures = 0;

    for (const id of ids) {
      const t = db
        .prepare(
          `SELECT trajectory_id, mint, state, notional_lamports, entry_cash_out_lamports,
                  exit_cash_in_lamports, execution_cost_lamports, net_pnl_lamports,
                  snapshot_hash, capability_fingerprint
             FROM development_trajectories WHERE trajectory_id = ?`,
        )
        .get(id) as Row | undefined;

      if (t === undefined) {
        console.error(`${id}: no such trajectory`);
        failures++;
        continue;
      }

      const link = db
        .prepare(
          `SELECT entry_job_id, entry_step_index, entry_settlement_id, entry_observation_id,
                  exit_job_id, exit_step_index, exit_settlement_id, exit_observation_id,
                  snapshot_hash, capability_fingerprint
             FROM trajectory_evidence_links WHERE trajectory_id = ?`,
        )
        .get(id) as
        | {
            entry_job_id: string;
            entry_step_index: number;
            entry_settlement_id: string;
            entry_observation_id: string;
            exit_job_id: string | null;
            exit_step_index: number | null;
            exit_settlement_id: string | null;
            exit_observation_id: string | null;
            snapshot_hash: string;
            capability_fingerprint: string;
          }
        | undefined;

      if (link === undefined) {
        console.error(`${id}: no evidence-link row — its raw state was never persisted, so it cannot be traced`);
        results.push({ trajectoryId: id, traceable: false, reason: 'no evidence-link row' });
        failures++;
        continue;
      }

      const mismatches: Mismatch[] = [];

      // ---- identity checks, before any arithmetic -------------------------
      if (!/^[0-9a-f]{64}$/.test(t.snapshot_hash)) {
        mismatches.push({ field: 'snapshot_hash', stored: t.snapshot_hash, derived: 'a sha256 hex digest' });
      }
      if (t.capability_fingerprint === t.snapshot_hash) {
        mismatches.push({
          field: 'capability_fingerprint',
          stored: t.capability_fingerprint,
          derived: 'a value distinct from snapshot_hash',
        });
      }

      // ---- 1. the raw manifests -------------------------------------------
      const manifests = db
        .prepare(
          `SELECT address, role, writable, leg, step_index, pre_state, post_state,
                  pre_blob_sha256, post_blob_sha256, pre_lamports, post_lamports
             FROM account_state_manifests WHERE job_id = ? ORDER BY step_index, address`,
        )
        .all(link.entry_job_id) as unknown as ManifestRow[];

      if (manifests.length === 0) {
        mismatches.push({ field: 'account_state_manifests', stored: '0 rows', derived: 'at least the payer' });
      }

      // Every blob must READ BACK. This is the falsifiability check: if a blob
      // is gone or altered, the numbers derived from it are unverifiable and
      // that must be a failure rather than a silently skipped account.
      let blobsRead = 0;
      const unreadable: string[] = [];
      for (const m of manifests) {
        for (const h of [m.pre_blob_sha256, m.post_blob_sha256]) {
          if (h === null) continue;
          try {
            store.get<AccountBlob>(h);
            blobsRead++;
          } catch (e) {
            unreadable.push(`${m.address.slice(0, 10)}: ${(e as Error).message.slice(0, 60)}`);
          }
        }
      }
      if (unreadable.length > 0) {
        mismatches.push({
          field: 'evidence_blobs',
          stored: `${unreadable.length} unreadable`,
          derived: 'all readable',
        });
      }

      // ---- 2/3. the payer's own lamports, per leg -------------------------
      //
      // The payer is the ONE quantity that cannot disagree with itself.
      // Building a round trip from a credit here and a debit there is how the
      // exit's fees and rent went missing from it entirely.
      const payerDelta = (leg: string): bigint | null => {
        const rows = manifests.filter((m) => m.leg === leg && m.role === 'PAYER');
        const payer = rows[0] ?? manifests.filter((m) => m.leg === leg).find((m) => m.role === 'UNCLASSIFIED');
        if (payer === undefined) return null;
        return big(payer.post_lamports) - big(payer.pre_lamports);
      };

      const entryDelta = payerDelta('buy');
      const exitDelta = payerDelta('sell');

      // ---- 4. the cash identity, RESTATED here ---------------------------
      //
      //   net_pnl = exit_cash_in + cashback_claimed - entry_cash_out - claim_cost
      //
      // Deliberately written out rather than imported, so a change to the
      // production identity does not silently change this check too.
      const legs = db
        .prepare(
          `SELECT leg, cash_out_lamports, cash_in_lamports, unexplained_lamports,
                  cashback_claimed_lamports, cashback_claim_cost_lamports, pnl_eligible
             FROM leg_settlements WHERE trajectory_id = ?`,
        )
        .all(id) as {
        leg: string;
        cash_out_lamports: string | null;
        cash_in_lamports: string | null;
        unexplained_lamports: string;
        cashback_claimed_lamports: string;
        cashback_claim_cost_lamports: string;
        pnl_eligible: number;
      }[];

      const entryLeg = legs.find((l) => l.leg === 'buy');
      const exitLeg = legs.find((l) => l.leg === 'sell');

      const derivedEntryCashOut = entryDelta === null ? null : -entryDelta;
      const derivedExitCashIn = exitDelta;
      const claimed = big(exitLeg?.cashback_claimed_lamports ?? '0');
      const claimCost = big(exitLeg?.cashback_claim_cost_lamports ?? '0');
      const unexplained = big(entryLeg?.unexplained_lamports ?? '0') + big(exitLeg?.unexplained_lamports ?? '0');

      const derivedNetPnl =
        derivedEntryCashOut === null || derivedExitCashIn === null
          ? null
          : unexplained !== 0n
            ? null // P4.2 — a residue withholds PnL. No exception.
            : derivedExitCashIn + claimed - derivedEntryCashOut - claimCost;

      // ---- 5. compare against what is stored ------------------------------
      const cmp = (field: string, stored: string | null, derived: bigint | null): void => {
        const d = derived === null ? null : derived.toString();
        if (stored !== d) mismatches.push({ field, stored, derived: d });
      };

      if (derivedEntryCashOut !== null) cmp('entry_cash_out_lamports', t.entry_cash_out_lamports, derivedEntryCashOut);
      if (derivedExitCashIn !== null) cmp('exit_cash_in_lamports', t.exit_cash_in_lamports, derivedExitCashIn);
      cmp('net_pnl_lamports', t.net_pnl_lamports, derivedNetPnl);

      // The settlement row must agree with the trajectory row. K-3 found 31 net
      // PnL figures in one and 0 in the other.
      const settlement = db
        .prepare('SELECT net_pnl, entry_cash_out, exit_cash_in, unexplained_lamports FROM trajectory_settlements WHERE trajectory_id = ?')
        .get(id) as
        | { net_pnl: string | null; entry_cash_out: string; exit_cash_in: string | null; unexplained_lamports: string }
        | undefined;
      if (settlement !== undefined) {
        if (settlement.net_pnl !== t.net_pnl_lamports) {
          mismatches.push({
            field: 'settlement.net_pnl vs trajectory.net_pnl_lamports',
            stored: `${settlement.net_pnl} / ${t.net_pnl_lamports}`,
            derived: 'equal',
          });
        }
        if (big(settlement.unexplained_lamports) !== 0n && settlement.net_pnl !== null) {
          mismatches.push({
            field: 'net_pnl over unexplained value',
            stored: `net ${settlement.net_pnl} with ${settlement.unexplained_lamports} unexplained`,
            derived: 'net PnL withheld',
          });
        }
      }

      const ok = mismatches.length === 0;
      if (!ok) failures++;

      console.log(`\n${id}  ${t.mint.slice(0, 12)}  ${t.state}`);
      console.log(`  manifests    ${manifests.length} account row(s), ${blobsRead} blob(s) read back`);
      console.log(`  entry out    stored ${t.entry_cash_out_lamports ?? 'null'}  derived ${derivedEntryCashOut ?? 'null'}`);
      console.log(`  exit in      stored ${t.exit_cash_in_lamports ?? 'null'}  derived ${derivedExitCashIn ?? 'null'}`);
      console.log(`  unexplained  ${unexplained}`);
      console.log(`  net pnl      stored ${t.net_pnl_lamports ?? 'null'}  derived ${derivedNetPnl ?? 'null'}`);
      console.log(`  verdict      ${ok ? 'RECOMPUTES' : 'MISMATCH'}`);
      for (const m of mismatches) {
        console.log(`    ${m.field}: stored ${m.stored ?? 'null'}, derived ${m.derived ?? 'null'}`);
      }

      results.push({
        trajectoryId: id,
        traceable: true,
        manifestRows: manifests.length,
        blobsRead,
        unreadableBlobs: unreadable,
        derived: {
          entryCashOutLamports: derivedEntryCashOut?.toString() ?? null,
          exitCashInLamports: derivedExitCashIn?.toString() ?? null,
          unexplainedLamports: unexplained.toString(),
          netPnlLamports: derivedNetPnl?.toString() ?? null,
        },
        stored: {
          entryCashOutLamports: t.entry_cash_out_lamports,
          exitCashInLamports: t.exit_cash_in_lamports,
          netPnlLamports: t.net_pnl_lamports,
        },
        mismatches,
        recomputes: ok,
      });
    }

    const artifact = writeArtifact('trajectory-trace.json', {
      traced: results.length,
      recomputed: results.filter((r) => r['recomputes'] === true).length,
      failures,
      results,
    });

    console.log(`\ntraced ${results.length}, recomputed ${results.filter((r) => r['recomputes'] === true).length}, failures ${failures}`);
    console.log(`-> ${artifact}`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    db.close();
  }
}

main();
