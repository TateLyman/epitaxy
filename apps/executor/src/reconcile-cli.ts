import { loadConfig, loadSecrets } from '../../../packages/domain/src/config.js';
import { openDb } from '../../../packages/storage/src/db.js';
import type { Db } from '../../../packages/storage/src/db.js';
import { RateLimiter } from '../../../packages/adapters/src/ratelimit.js';
import { ExecutionRpc } from '../../../packages/execution/src/rpc.js';
import { Signer } from '../../../packages/execution/src/signer.js';
import { newId, insertFill, updateAttempt, recordHealth } from '../../../packages/storage/src/repo.js';
import { formatAmount } from '../../../packages/domain/src/amounts.js';
import { WRAPPED_SOL } from '../../../packages/execution/src/effect.js';

/**
 * Reconciliation.
 *
 * Answers one question: does what we believe about our own money match what the
 * chain says. It is the only place fills are allowed to be written for on-chain
 * trades, and it writes them from `getTransaction` balance deltas rather than
 * from the quote that preceded them — because the quote is what we hoped for
 * and the balances are what happened.
 *
 * It is deliberately runnable without a signer. Checking the books should not
 * require the ability to move money.
 */

interface AttemptRow {
  attempt_id: string;
  intent_id: string;
  signature: string;
  outcome: string;
  simulated_out: string | null;
  simulated_in: string | null;
}

interface IntentRow {
  intent_id: string;
  mint: string;
  side: string;
  input_mint: string;
  output_mint: string;
}

function all<T>(db: Db, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[];
}

function one<T>(db: Db, sql: string, params: unknown[] = []): T | null {
  return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function walletFromArgs(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--wallet='));
  return arg === undefined ? null : arg.slice('--wallet='.length);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();
  const db = openDb({ path: secrets.databasePath });

  let wallet = walletFromArgs();
  if (wallet === null && secrets.tradingKeypairPath !== null) {
    // Reading the file yields the public half without exposing the secret half
    // to anything outside the Signer.
    wallet = Signer.fromFile(secrets.tradingKeypairPath).publicKey;
  }

  console.log(`reconcile — mode ${config.mode}, ${new Date().toISOString()}`);
  console.log(`wallet: ${wallet ?? 'unknown (pass --wallet=<pubkey> or set TRADING_KEYPAIR_PATH)'}`);

  const attempts = all<AttemptRow>(
    db,
    `SELECT attempt_id,intent_id,signature,outcome,simulated_out,simulated_in FROM execution_attempts
     ORDER BY signed_utc_ms`,
  );
  if (attempts.length === 0) {
    console.log('\nno execution attempts have ever been recorded.');
    console.log('Nothing has been signed or sent, so there is nothing to reconcile. This is the');
    console.log('expected state until canary runs.');
    reportPaperOnly(db);
    return;
  }

  const limiter = RateLimiter.fromConfig(secrets.jupiterApiKey !== null);
  const rpc = new ExecutionRpc(limiter, { primary: secrets.rpcHttp, fallback: secrets.rpcHttpFallback });
  if (!rpc.configured) {
    console.error('\nSOLANA_RPC_HTTP is not set. Reconciliation without the chain is not reconciliation.');
    process.exitCode = 1;
    return;
  }

  let matched = 0;
  let written = 0;
  const problems: string[] = [];

  for (const a of attempts) {
    const tx = await rpc.getConfirmedTransaction(a.signature);
    if (tx === null) {
      if (a.outcome === 'CONFIRMED') {
        // We recorded a confirmation the chain does not remember. Either the
        // signature is wrong or the transaction was dropped after a reorg.
        problems.push(`${a.signature}: recorded CONFIRMED but getTransaction returns nothing`);
      }
      continue;
    }

    const landed = tx.err === null;
    if (landed && a.outcome !== 'CONFIRMED') {
      problems.push(`${a.signature}: landed on chain but recorded as ${a.outcome}`);
      updateAttempt(db, a.attempt_id, {
        outcome: 'CONFIRMED',
        landedSlot: tx.slot,
        chainError: null,
        resolvedUtcMs: Date.now(),
      });
    }
    if (!landed && a.outcome === 'CONFIRMED') {
      problems.push(`${a.signature}: recorded CONFIRMED but the chain reports an error`);
    }
    if (!landed) continue;
    matched++;

    const existing = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM fills WHERE signature = ?', [a.signature]);
    if ((existing?.n ?? 0) > 0) continue;

    const intent = one<IntentRow>(
      db,
      'SELECT intent_id,mint,side,input_mint,output_mint FROM intents WHERE intent_id = ?',
      [a.intent_id],
    );
    if (intent === null) {
      problems.push(`${a.signature}: confirmed transaction has no matching intent row`);
      continue;
    }
    if (wallet === null) {
      problems.push(`${a.signature}: cannot attribute balances without the wallet public key`);
      continue;
    }

    const delta = tokenDelta(tx, wallet);
    const solDelta = solLamportDelta(tx, wallet);
    const inMint = intent.input_mint;
    const outMint = intent.output_mint;

    const actualIn = inMint === WRAPPED_SOL ? solDelta.spent : -(delta.get(inMint) ?? 0n);
    const actualOut = outMint === WRAPPED_SOL ? -solDelta.spent : (delta.get(outMint) ?? 0n);

    insertFill(db, {
      fillId: newId(),
      intentId: intent.intent_id,
      mint: intent.mint,
      side: intent.side === 'sell' ? 'sell' : 'buy',
      actualInAmount: actualIn < 0n ? 0n : actualIn,
      actualOutAmount: actualOut < 0n ? 0n : actualOut,
      feeLamports: tx.feeLamports,
      // The priority component is not separable from the base fee in
      // getTransaction, so it is recorded as zero rather than estimated. A
      // fabricated split would corrupt the cost model that depends on it.
      priorityFeeLamports: 0n,
      rentLamports: 0n,
      signature: a.signature,
      slot: tx.slot,
      simulated: false,
      utcMs: tx.blockTimeUtcMs ?? Date.now(),
    });
    written++;

    const simOut = a.simulated_out === null ? null : BigInt(a.simulated_out);
    if (simOut !== null && simOut > 0n && actualOut > 0n) {
      const errBps = Number(((actualOut - simOut) * 10_000n) / simOut);
      console.log(
        `  ${a.signature.slice(0, 12)}… simulated ${simOut} vs actual ${actualOut} (${errBps > 0 ? '+' : ''}${errBps} bps)`,
      );
    }
  }

  console.log(`\n${attempts.length} attempts examined, ${matched} landed, ${written} fill(s) written from chain data`);

  if (problems.length > 0) {
    console.error('\nDISCREPANCIES');
    for (const p of problems) console.error(`  ${p}`);
    recordHealth(db, 'reconciliation_mismatch', 'critical', `${problems.length} discrepancies`);
    process.exitCode = 1;
  } else {
    console.log('books agree with the chain.');
  }

  if (wallet !== null) {
    const balance = await rpc.getAccounts([wallet]);
    const lamports = balance[0]?.lamports ?? 0n;
    console.log(`\nwallet balance: ${formatAmount(lamports, 9)} SOL`);
  }
}

/** Net change in our token balances, keyed by mint. */
function tokenDelta(
  tx: { preTokenBalances: readonly { mint: string; owner: string | null; amount: bigint }[]; postTokenBalances: readonly { mint: string; owner: string | null; amount: bigint }[] },
  wallet: string,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of tx.preTokenBalances) {
    if (b.owner !== wallet) continue;
    out.set(b.mint, (out.get(b.mint) ?? 0n) - b.amount);
  }
  for (const b of tx.postTokenBalances) {
    if (b.owner !== wallet) continue;
    out.set(b.mint, (out.get(b.mint) ?? 0n) + b.amount);
  }
  return out;
}

/**
 * Lamports the fee payer lost. Account index 0 is the fee payer, and its
 * pre/post balances include the transaction fee, so this is the true all-in
 * SOL cost of the trade rather than the swap leg alone.
 */
function solLamportDelta(
  tx: { preBalances: readonly bigint[]; postBalances: readonly bigint[] },
  _wallet: string,
): { spent: bigint } {
  const pre = tx.preBalances[0] ?? 0n;
  const post = tx.postBalances[0] ?? 0n;
  return { spent: pre - post };
}

function reportPaperOnly(db: Db): void {
  const p = one<{ n: number; closed: number }>(
    db,
    'SELECT COUNT(*) AS n, SUM(CASE WHEN closed_utc_ms IS NOT NULL THEN 1 ELSE 0 END) AS closed FROM positions WHERE simulated = 1',
  );
  console.log(`\npaper positions: ${p?.n ?? 0} (${p?.closed ?? 0} closed)`);
  console.log('Paper positions are assumptions, not holdings. They are excluded from');
  console.log('reconciliation because there is no chain state for them to disagree with.');
}

void main().catch((e: unknown) => {
  console.error(`reconcile failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
