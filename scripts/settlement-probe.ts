import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import { SequentialWorker } from '../packages/simulator/src/sequential-worker.js';
import { openTrajectory } from '../packages/pipeline/src/open-trajectory.js';

/**
 * P5 — exercise the settlement path on demand, WITHOUT touching the corpus.
 *
 * Verifying an accounting fix needed a freshly-openable candidate, and the
 * sampler correctly refuses one: a mint with an open trajectory is excluded,
 * and after a collection run every deep mint has one. So each iteration of a
 * fix was waiting on a 60-minute horizon.
 *
 * This opens exactly one trajectory in memory and prints the settlement. It
 * writes NO database row, which is the point twice over: the diagnostic is
 * available immediately, and a diagnostic run can never be mistaken later for a
 * collected outcome.
 *
 * ```
 * pnpm settlement:probe <mint>
 * ```
 */

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const taker = secrets.paperTakerPubkey;
  if (taker === null) {
    console.error('PAPER_TAKER_PUBKEY is required');
    process.exit(1);
  }
  const { rpc, host } = researchRpc(secrets as never);

  let mint = process.argv[2] ?? '';
  if (mint === '') {
    // The deepest candidate we know of, so the probe is not accidentally
    // measuring a drained pool's self-impact.
    const db = openDb({ path: secrets.databasePath, readonly: true });
    const row = db
      .prepare(
        `SELECT mint FROM candidate_risk_facts
          WHERE admitted = 1 ORDER BY collected_utc_ms DESC LIMIT 1`,
      )
      .get() as { mint: string } | undefined;
    db.close();
    if (row === undefined) {
      console.error('no admitted candidate on record; pass a mint explicitly');
      process.exit(1);
    }
    mint = row.mint;
  }

  console.log(`settlement probe  mint=${mint.slice(0, 12)}  endpoint=${host}`);
  console.log('NO DATABASE ROW IS WRITTEN. This is an apparatus check, not a collected outcome.');
  console.log('');

  const worker = new SequentialWorker({ commandTimeoutMs: 240_000, maxOutputBytes: 256 * 1024 * 1024 });
  try {
    const res = await openTrajectory(rpc as never, worker, {
      mint,
      taker,
      notionalLamports: BigInt(process.env['COLLECT_LAMPORTS'] ?? '20000000'),
      slippagePct: 3,
      isCashbackCoin: false,
      captureSnapshot: async (accounts, programs) =>
        captureSnapshot(rpc, [], { extraAccounts: [...accounts], extraPrograms: [...programs] }) as never,
    });

    if (!res.ok) {
      console.log(`REFUSED  ${res.refusal}`);
      console.log(`  ${res.detail}`);
      return;
    }

    const t = res.trajectory;
    const s = t.settlement;
    const n = (x: bigint | null): string => (x === null ? 'null' : x.toString().padStart(12));

    console.log(`acquired        ${t.acquiredAtoms}`);
    console.log(`soleVenue       ${t.soleVenueAttributed}   quoteState ${t.quoteStateSurvived}`);
    console.log(`baseAtaClosed   ${t.baseAtaClosedInSell}`);
    console.log('');
    console.log(`entryCashOut    ${n(s.entryCashOutLamports)}`);
    console.log(`exitCashIn      ${n(s.exitCashInLamports)}`);
    console.log(`rentCreated     ${n(s.rentCreatedLamports)}`);
    console.log(`rentRecovered   ${n(s.rentRecoveredLamports)}`);
    console.log(`rentStillLocked ${n(s.rentStillLockedLamports)}`);
    console.log(`cashbackAccrued ${n(s.cashbackAccruedLamports)}`);
    console.log(`executionCost   ${n(s.executionCostLamports)}`);
    console.log(`NET PnL         ${n(s.netPnlLamports)}`);
    console.log('');
    console.log('itemised, per leg:');
    console.log(
      `  entry  venueFee ${n(s.entry.costs.protocolFeeLamports)}  rentCreated ${n(s.entry.costs.rentCreatedLamports)}` +
        `  rentBack ${n(s.entry.costs.rentRecoveredLamports)}  payerDelta ${n(s.entry.payerNativeDeltaLamports)}`,
    );
    if (s.exit !== null) {
      console.log(
        `  exit   venueFee ${n(s.exit.costs.protocolFeeLamports)}  rentCreated ${n(s.exit.costs.rentCreatedLamports)}` +
          `  rentBack ${n(s.exit.costs.rentRecoveredLamports)}  payerDelta ${n(s.exit.payerNativeDeltaLamports)}`,
      );
      const tradeOut = s.entry.input.kind === 'native_sol' ? s.entry.input.actualTradeDebitLamports : 0n;
      const tradeIn = s.exit.output.kind === 'native_sol' ? s.exit.output.actualCreditLamports : 0n;
      console.log(`  tradeOut ${n(tradeOut)}  tradeIn ${n(tradeIn)}`);
    }
    console.log('');
    console.log('CONSERVATION (sum of every observed lamport delta, plus the fee):');
    console.log(`  entry leg     ${n(t.settlement.entry.costs.unexplainedLamports)}`);
    console.log(`  exit leg      ${n(t.settlement.exit?.costs.unexplainedLamports ?? null)}`);
    console.log(`  combined      ${n(s.unexplainedLamports)}`);
    console.log('  Zero means every lamport the legs moved landed in an account we observed.');
    if (s.pnlBlockedReasons.length > 0) {
      console.log('');
      console.log('PnL blocked by:');
      for (const r of s.pnlBlockedReasons) console.log(`  - ${r}`);
    }
    if (t.identityViolations.length > 0) {
      console.log('');
      console.log('IDENTITY VIOLATIONS:');
      for (const v of t.identityViolations) console.log(`  - ${v}`);
    }
  } finally {
    await worker.close();
  }
}

await main();
