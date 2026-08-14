import { writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { canonicalPool, AMM_PROGRAM_ID } from '../packages/solana/src/pumpswap-offline.js';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from '../packages/solana/src/pump.js';
import {
  decodeMigrations,
  enrichMigration,
  migrationDedupKey,
  MigrationUndecodable,
} from '../packages/solana/src/migration.js';

/**
 * P7's proof, against the live chain.
 *
 * The stored corpus says what happens without this: 256,880 MIGRATION rows, of
 * which 256,235 are ERRORED transactions, spanning 56 distinct mints, and zero
 * of three hundred sampled (mint, pool) pairs satisfy
 * `canonicalPool(mint) === pool`.
 *
 * The claim under test is that decoding from a verified PDA gives an identity a
 * decision can be made on. The check is the one that matters: the derived pool
 * must be readable on chain and must belong to the derived mint.
 */

const MIGRATION_PROGRAMS = [PUMP_PROGRAM, PUMPSWAP_PROGRAM, AMM_PROGRAM_ID];

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);

  const db = new DatabaseSync(secrets.databasePath, { readOnly: true });
  const mints = (db.prepare('SELECT DISTINCT mint FROM screenings ORDER BY rowid DESC LIMIT 600').all() as {
    mint: string;
  }[]).map((r) => r.mint);

  // The old corpus, for the before/after the report needs.
  const storedTotal = (
    db.prepare("SELECT COUNT(*) c FROM chain_events WHERE kind='MIGRATION'").get() as { c: number }
  ).c;
  const storedErrored = (
    db.prepare("SELECT COUNT(*) c FROM chain_events WHERE kind='MIGRATION' AND tx_error IS NOT NULL").get() as {
      c: number;
    }
  ).c;
  const storedDistinct = (
    db.prepare("SELECT COUNT(DISTINCT mint) c FROM chain_events WHERE kind='MIGRATION' AND mint IS NOT NULL").get() as {
      c: number;
    }
  ).c;
  db.close();

  // Find migrated mints, then find the transaction that created each pool.
  const migrated: { mint: string; pool: string }[] = [];
  for (const mint of mints) {
    if (migrated.length >= 6) break;
    try {
      const pool = canonicalPool(mint);
      await rpc.getAccountRaw(pool);
      migrated.push({ mint, pool });
    } catch {
      /* most Pump mints never migrate */
    }
  }

  const decoded: unknown[] = [];
  const refusals: Record<string, number> = {};

  for (const { mint, pool } of migrated) {
    // The pool's OLDEST signature is its creation. getSignaturesForAddress
    // returns newest-first, so the creation is the last page's last entry; for
    // a young pool one page reaches it.
    let sigs: { signature: string }[] = [];
    try {
      sigs = await rpc.getSignaturesForAddress(pool, 1000);
    } catch {
      refusals['pool_history_unreadable'] = (refusals['pool_history_unreadable'] ?? 0) + 1;
      continue;
    }
    if (sigs.length === 0) continue;
    const creation = sigs[sigs.length - 1];
    if (creation === undefined) continue;

    const tx = await rpc.getTransactionInstructions(creation.signature);
    if (tx === null) {
      refusals['transaction_unreadable'] = (refusals['transaction_unreadable'] ?? 0) + 1;
      continue;
    }

    try {
      const events = decodeMigrations(tx, { commitment: 'confirmed', migrationProgramIds: MIGRATION_PROGRAMS });
      for (const e of events) {
        const rich = await enrichMigration(rpc, e);
        decoded.push({
          // Truncated, and the DEDUP KEY has to be truncated too — it embeds
          // the signature, so publishing it whole reintroduces exactly what
          // truncating `signature` was for. A 64-byte signature and a 64-byte
          // secret key are indistinguishable by shape, which is why the
          // scanner cannot tell them apart and why this is not cosmetic.
          dedupKey: migrationDedupKey({ ...rich, signature: rich.signature.slice(0, 32) }),
          signaturePrefix: rich.signature.slice(0, 32),
          instructionIndex: rich.instructionIndex,
          programId: rich.programId,
          mint: rich.mint,
          canonicalPool: rich.canonicalPool,
          bondingCurve: rich.bondingCurve,
          poolBaseTokenAccount: rich.poolBaseTokenAccount,
          poolQuoteTokenAccount: rich.poolQuoteTokenAccount,
          quoteMint: rich.quoteMint,
          isMayhemMode: rich.isMayhemMode,
          isCashbackCoin: rich.isCashbackCoin,
          slot: rich.slot,
          blockTime: rich.blockTime,
          identitySource: rich.identitySource,
          // The check that the old parser failed 300 times out of 300.
          derivedPoolMatchesExpected: rich.canonicalPool === pool,
          derivedMintMatchesExpected: rich.mint === mint,
        });
      }
    } catch (e) {
      const r = e instanceof MigrationUndecodable ? e.reason : (e as Error).message.slice(0, 70);
      refusals[r] = (refusals[r] ?? 0) + 1;
    }
  }

  const rows = decoded as { derivedPoolMatchesExpected: boolean; derivedMintMatchesExpected: boolean }[];
  const correct = rows.filter((r) => r.derivedPoolMatchesExpected && r.derivedMintMatchesExpected).length;

  // The negative case: a failed transaction must refuse, because 99.75% of the
  // stored corpus is exactly that.
  let refusedFailedTx: string | null = null;
  try {
    decodeMigrations(
      {
        signature: 'x',
        slot: 1,
        blockTime: null,
        failed: true,
        accountKeys: [],
        tokenBalanceMints: [],
        instructions: [],
      },
      { commitment: 'confirmed', migrationProgramIds: MIGRATION_PROGRAMS },
    );
  } catch (e) {
    refusedFailedTx = e instanceof MigrationUndecodable ? e.reason : (e as Error).message;
  }

  const proof = {
    host,
    storedCorpusBefore: {
      migrationEvents: storedTotal,
      erroredTransactions: storedErrored,
      erroredShare: storedTotal === 0 ? null : Number((storedErrored / storedTotal).toFixed(4)),
      distinctMints: storedDistinct,
      identityCheckPassRate: '0 of 300 sampled (canonicalPool(storedMint) === storedPool)',
    },
    migratedMintsFound: migrated.length,
    decodedMigrations: decoded.length,
    identitiesCorrect: correct,
    refusals,
    refusedFailedTransaction: refusedFailedTx,
    decoded,
    ok: decoded.length > 0 && correct === decoded.length && refusedFailedTx !== null,
  };

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/migration-lane-proof.json', JSON.stringify(proof, null, 2) + '\n');
  console.log('migrated mints found  :', migrated.length);
  console.log('decoded migrations    :', decoded.length);
  console.log('identities correct    :', correct, 'of', decoded.length);
  console.log('refusals              :', JSON.stringify(refusals));
  console.log('refused a failed tx   :', refusedFailedTx);
  console.log('ok:', proof.ok);
  if (!proof.ok) process.exitCode = 1;
}

await main();
