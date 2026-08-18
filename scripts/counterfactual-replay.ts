/**
 * `pnpm counterfactual:replay` — the EXACT contract, for a calibration subset.
 *
 * P8.3 / M-1. `BOUNDED_COUNTERFACTUAL_V1` is cheap and approximate: it carries
 * our entry's displacement onto the later real reserves and applies a frozen
 * adverse haircut. It is graded DEVELOPMENT and may not enter a confirmatory
 * result until it has been shown CONSERVATIVE against something exact.
 *
 * `RESERVE_DELTA_REPLAY_V1` is that exact thing. Every confirmed transaction
 * that touched the pool's vaults between our entry and the mark, in slot order,
 * applied to the LOCAL post-entry state — the state that contains our position.
 * What comes out the other end is the pool our exit would actually have faced.
 *
 * It is expensive: one `getSignaturesForAddress` walk plus one `getTransaction`
 * per intervening swap, per horizon. That is exactly why it is a subset. Its
 * job is to tell us whether the cheap contract is conservative, not to price
 * every row.
 *
 * The vault deltas are read from `meta.preTokenBalances` / `postTokenBalances`,
 * which the chain itself recorded inside each transaction. No archival node is
 * needed for a historical reserve: the transaction carries its own before and
 * after.
 *
 *   --limit=N       how many trajectories to replay (default 2)
 *   --offset=MS     which horizon (default 900000, the control's own)
 *   --context=ID    restrict to one evidence context
 */
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { canonicalPool, poolAddressesFrom, accountSourceOf } from '../packages/solana/src/pumpswap-offline.js';
import {
  replayCounterfactual,
  insertCounterfactualMark,
  calibrate,
  type PoolEvent,
} from '../packages/pipeline/src/counterfactual.js';
import { writeArtifact, writeNotRun } from './_artifact.js';

const arg = (name: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;

/** How far back the signature walk will page before giving up on a horizon. */
const MAX_SIGNATURE_PAGES = 10;
const SIGNATURE_PAGE = 1_000;

async function main(): Promise<void> {
  const limit = Number(arg('limit', '2'));
  const offsetMs = Number(arg('offset', '900000'));
  const contextId = arg('context', '');

  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath, skipBackup: true });
  const { rpc } = researchRpc(secrets as never);

  const scope =
    contextId === ''
      ? ''
      : `AND EXISTS (SELECT 1 FROM trajectory_evidence_context c
                       WHERE c.trajectory_id = t.trajectory_id AND c.evidence_context_id = '${contextId}')`;

  /**
   * Only rows that carry BOTH states. A trajectory opened before the inputs
   * were persisted cannot be replayed, and guessing its post-entry reserves
   * from its notional would be a model standing in for a measurement.
   */
  const subjects = db
    .prepare(
      `SELECT t.trajectory_id, t.mint, t.opened_utc_ms,
              t.post_entry_base_reserve, t.post_entry_quote_reserve,
              t.entry_policy_inputs,
              m.observed_utc_ms,
              (SELECT counterfactual_exit_lamports FROM counterfactual_marks b
                WHERE b.trajectory_id = t.trajectory_id AND b.offset_ms = ?
                  AND b.evidence_class = 'BOUNDED_COUNTERFACTUAL_V1'
                  AND b.refusal IS NULL) AS bounded
         FROM development_trajectories t
         JOIN trajectory_marks m
           ON m.trajectory_id = t.trajectory_id AND m.offset_ms = ?
        WHERE t.post_entry_base_reserve IS NOT NULL
          AND t.post_entry_quote_reserve IS NOT NULL
          AND m.observed_base_reserve IS NOT NULL
          ${scope}
          AND NOT EXISTS (SELECT 1 FROM counterfactual_marks r
                           WHERE r.trajectory_id = t.trajectory_id AND r.offset_ms = ?
                             AND r.evidence_class = 'RESERVE_DELTA_REPLAY_V1')
        ORDER BY t.opened_utc_ms DESC
        LIMIT ?`,
    )
    .all(offsetMs, offsetMs, offsetMs, limit) as {
    trajectory_id: string;
    mint: string;
    opened_utc_ms: number;
    post_entry_base_reserve: string;
    post_entry_quote_reserve: string;
    entry_policy_inputs: string;
    observed_utc_ms: number;
    bounded: string | null;
  }[];

  console.log(`counterfactual replay — RESERVE_DELTA_REPLAY_V1 at +${offsetMs / 60_000}m\n`);
  if (subjects.length === 0) {
    console.log('NOT RUN. No trajectory carries both a local post-entry state and an observed mark');
    console.log(`at +${offsetMs / 60_000}m without a replay already recorded.`);
    const p = writeNotRun(
      'counterfactual-replay.json',
      `no trajectory carries a post-entry local state and an observed mark at ${offsetMs}ms`,
      { offsetMs, contextId: contextId === '' ? null : contextId },
    );
    console.log(`\n-> ${p}`);
    db.close();
    process.exit(1);
  }

  const done: Record<string, unknown>[] = [];
  for (const s of subjects) {
    const pool = canonicalPool(s.mint);
    const raw = await rpc.getAccountRaw(pool);
    const addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
      pool,
    );
    const baseVault = addrs.poolBaseTokenAccount;
    const quoteVault = addrs.poolQuoteTokenAccount;

    /**
     * The window is [entry, mark] in WALL CLOCK, matched against blockTime.
     *
     * A signature with no blockTime is not assumed inside or outside — it is
     * counted as unresolved and reported, because silently dropping it would
     * make the replay look complete when an event is missing, and a missing
     * SELL is the direction that flatters the exit.
     */
    const fromSec = Math.floor(s.opened_utc_ms / 1000);
    const toSec = Math.ceil(s.observed_utc_ms / 1000);
    const events: PoolEvent[] = [];
    let unresolvedTime = 0;
    let scanned = 0;
    let reachedEntry = false;
    let before: string | undefined;

    for (let page = 0; page < MAX_SIGNATURE_PAGES && !reachedEntry; page++) {
      const sigs = await rpc.getSignaturesForAddress(baseVault, SIGNATURE_PAGE, before);
      if (sigs.length === 0) {
        reachedEntry = true;
        break;
      }
      for (const sig of sigs) {
        scanned++;
        if (sig.blockTime === null) {
          unresolvedTime++;
          continue;
        }
        if (sig.blockTime < fromSec) {
          reachedEntry = true;
          break;
        }
        if (sig.blockTime > toSec) continue;
        if (sig.failed === true) continue;
        const tx = await rpc.getTransactionWithMeta(sig.signature);
        if (tx === null || tx.failed) continue;
        const at = (rows: readonly { accountIndex: number; amount: bigint }[], vault: string): bigint | null => {
          const idx = tx.accountKeys.indexOf(vault);
          if (idx === -1) return null;
          const row = rows.find((r) => r.accountIndex === idx);
          return row === undefined ? null : row.amount;
        };
        const baseBefore = at(tx.preTokenBalances, baseVault);
        const baseAfter = at(tx.postTokenBalances, baseVault);
        const quoteBefore = at(tx.preTokenBalances, quoteVault);
        const quoteAfter = at(tx.postTokenBalances, quoteVault);
        // A transaction that touched the pool but whose vault balances the
        // chain did not report is NOT a zero delta. It is skipped and counted,
        // so the replay's completeness is visible.
        if (baseBefore === null || baseAfter === null || quoteBefore === null || quoteAfter === null) {
          unresolvedTime++;
          continue;
        }
        events.push({
          signature: sig.signature,
          slot: sig.slot ?? 0,
          baseVaultDelta: baseAfter - baseBefore,
          quoteVaultDelta: quoteAfter - quoteBefore,
        });
      }
      const last = sigs[sigs.length - 1];
      if (last === undefined || sigs.length < SIGNATURE_PAGE) break;
      before = last.signature;
    }

    let acquired = 0n;
    try {
      const inputs = JSON.parse(s.entry_policy_inputs) as Record<string, string>;
      acquired = BigInt(inputs['baseVaultDeltaAtoms'] ?? '0');
    } catch {
      acquired = 0n;
    }

    const replayed = replayCounterfactual({
      postEntryBaseReserve: BigInt(s.post_entry_base_reserve),
      postEntryQuoteReserve: BigInt(s.post_entry_quote_reserve),
      events,
      tokensHeldAtoms: acquired,
    });

    insertCounterfactualMark(db, {
      trajectoryId: s.trajectory_id,
      offsetMs,
      evidenceClass: 'RESERVE_DELTA_REPLAY_V1',
      contractVersion: replayed.contractVersion,
      // The replay applies absolute state, so it carries no displacement. Zero
      // here is the honest value: it is not "we measured no displacement", it
      // is "this contract does not use one".
      entryBaseDeltaAtoms: 0n,
      entryQuoteDeltaLamports: 0n,
      observedBaseReserve: BigInt(s.post_entry_base_reserve),
      observedQuoteReserve: BigInt(s.post_entry_quote_reserve),
      adjustedBaseReserve: replayed.finalBaseReserve,
      adjustedQuoteReserve: replayed.finalQuoteReserve,
      haircutFormula: 'none — the replay is exact and takes no haircut',
      haircutBps: 0,
      haircutLamports: 0n,
      entryImpactBps: 0,
      counterfactualExitLamports: replayed.counterfactualExitLamports,
      // Exact by construction. The DEVELOPMENT grade belongs to the BOUNDED
      // contract, which is what this exists to judge.
      evidenceGrade: 'CALIBRATED',
      nowMs: Date.now(),
      refusal:
        unresolvedTime > 0
          ? `${unresolvedTime} intervening transaction(s) could not be resolved, so the replay is incomplete`
          : null,
    });

    const cal =
      s.bounded === null ? null : calibrate(BigInt(s.bounded), replayed.counterfactualExitLamports);
    console.log(
      `  ${s.trajectory_id.slice(0, 8)} ${s.mint.slice(0, 10)}  ${events.length} event(s) applied ` +
        `(${scanned} scanned, ${unresolvedTime} unresolved)  replay exit ${replayed.counterfactualExitLamports}` +
        (cal === null
          ? '  [no bounded row to compare]'
          : `  bounded ${cal.boundedExitLamports}  error ${cal.errorBps} bps  ` +
            `${cal.conservative ? 'CONSERVATIVE' : 'OPTIMISTIC — the bound overstates the exit'}`),
    );
    done.push({
      trajectoryId: s.trajectory_id,
      mint: s.mint,
      offsetMs,
      eventsApplied: events.length,
      signaturesScanned: scanned,
      unresolved: unresolvedTime,
      replayExitLamports: replayed.counterfactualExitLamports.toString(),
      boundedExitLamports: s.bounded,
      conservative: cal?.conservative ?? null,
      errorBps: cal?.errorBps ?? null,
    });
  }

  const p = writeArtifact('counterfactual-replay.json', {
    offsetMs,
    contextId: contextId === '' ? null : contextId,
    replayed: done,
  });
  console.log(`\n-> ${p}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
