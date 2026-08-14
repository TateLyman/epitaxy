import { canonicalPool, poolAddressesFrom, accountSourceOf } from './pumpswap-offline.js';
import { bondingCurveAddress } from './pump.js';

/**
 * P7 — migration identity that a decision can be made on.
 *
 * The stored corpus is what happens without this module. Measured on the
 * runtime database at head `1c499cd`:
 *
 * ```
 * MIGRATION events                          256,880
 *   errored transactions                    256,235   (99.75%)
 *   distinct mints                               56
 *   canonicalPool(storedMint) == storedPool       0   of 300 sampled
 *   stored mints with a live canonical pool       0   of 60 sampled
 * ```
 *
 * Three independent defects produced that:
 *
 * 1. **Identity by string position.** The parser took `mint` from the first
 *    base58 string in the logs and `pool` from the second. Log ordering is not
 *    an interface; it is an implementation detail of whatever emitted it. Zero
 *    of three hundred pairs survived the only check that matters.
 * 2. **Failed transactions counted as flow.** 99.75% of the "migrations" never
 *    happened. Bots spam migrate attempts and lose the race; each failure was
 *    recorded as a migration.
 * 3. **The wrong dedup key.** `(signature, program_id)` collapses every
 *    instruction in a transaction into one row, so a transaction migrating more
 *    than one thing keeps one arbitrary member of the set.
 *
 * The repair is to derive identity from a PDA and then REQUIRE that PDA to be
 * present in the transaction's account list. That is a verification rather than
 * a guess: the program cannot have written a pool whose address it never
 * referenced. A candidate mint whose derived pool is absent is refused, and the
 * refusal reason is recorded.
 */

export type MigrationCommitment = 'processed' | 'confirmed' | 'finalized';

export interface MigrationEventIdentity {
  readonly signature: string;
  /** Which instruction inside the transaction. Part of the dedup key. */
  readonly instructionIndex: number;
  readonly programId: string;

  readonly mint: string;
  readonly bondingCurve: string;
  readonly canonicalPool: string;
  readonly poolBaseTokenAccount: string | null;
  readonly poolQuoteTokenAccount: string | null;
  readonly quoteMint: string | null;
  readonly creator: string | null;

  readonly isMayhemMode: boolean | null;
  readonly isCashbackCoin: boolean | null;

  readonly slot: number;
  readonly blockTime: number | null;
  readonly commitment: MigrationCommitment;

  /** How the identity was established. Never blank. */
  readonly identitySource: 'pda_verified_in_account_keys';
}

export class MigrationUndecodable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`migration not decodable: ${reason}`);
    this.name = 'MigrationUndecodable';
    this.reason = reason;
  }
}

/**
 * The dedup key the corpus needs.
 *
 * `signature + programId` collapses a multi-instruction transaction to one row.
 * The event index is what distinguishes two migrations bundled into one
 * transaction, and bundling is normal rather than exotic.
 */
export function migrationDedupKey(e: {
  signature: string;
  instructionIndex: number;
  programId: string;
}): string {
  return `${e.signature}:${e.instructionIndex}:${e.programId}`;
}

/**
 * Anchor discriminators, read from the shipped `pump_amm` IDL.
 *
 * These are what distinguish a pool CREATION from an ordinary swap, and without
 * them this module has a defect in exactly the shape of the one it fixes.
 *
 * The PDA check alone is not sufficient: a `buy` or a `sell` references the very
 * same pool address, so "the derived pool is in the account keys" is true for
 * every trade against that pool. Verified on live data - scanning recent
 * PumpSwap activity, one mint was recorded as having migrated SEVEN times,
 * because seven of its swaps each looked like a migration.
 *
 * Identity by PDA answers WHICH pool. The discriminator answers WHETHER this
 * instruction created it. Both are required.
 */
export const CREATE_POOL_DISCRIMINATOR = 'e992d18ecf6840bc';
export const MIGRATE_POOL_COIN_CREATOR_DISCRIMINATOR = 'd0089f044aaf103a';

export const MIGRATION_DISCRIMINATORS: readonly string[] = [CREATE_POOL_DISCRIMINATOR];

export interface MigrationTxView {
  readonly signature: string;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly failed: boolean;
  readonly accountKeys: readonly string[];
  /** Mints the chain itself named in the token balances. Not parsed from logs. */
  readonly tokenBalanceMints: readonly string[];
  /**
   * Per-instruction program, accounts and DATA, in order.
   *
   * `dataHex` carries the raw instruction bytes; its first eight are the anchor
   * discriminator. Null when the provider returned a parsed form with no raw
   * data, which is refused rather than assumed to be a migration.
   */
  readonly instructions: readonly {
    programId: string;
    accounts: readonly string[];
    dataHex: string | null;
  }[];
}

export interface PoolByteReader {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

/**
 * Decode the migrations in one transaction.
 *
 * Returns every distinct migration the transaction performed, keyed so that two
 * in one transaction stay two.
 */
export function decodeMigrations(
  tx: MigrationTxView,
  opts: {
    commitment: MigrationCommitment;
    migrationProgramIds: readonly string[];
    /** Defaults to MIGRATION_DISCRIMINATORS. */
    migrationDiscriminators?: readonly string[];
  },
): readonly MigrationEventIdentity[] {
  // A failed transaction migrated nothing. Counting it as flow is how a corpus
  // comes to be 99.75% events that never happened.
  if (tx.failed) throw new MigrationUndecodable('the transaction failed; nothing migrated');
  if (tx.slot === null) throw new MigrationUndecodable('the transaction has no slot');

  const keys = new Set(tx.accountKeys);
  const out: MigrationEventIdentity[] = [];
  const seen = new Set<string>();
  let sawNonMigrationInstruction = false;
  let sawUndecodableData = false;

  for (let ix = 0; ix < tx.instructions.length; ix++) {
    const instruction = tx.instructions[ix];
    if (instruction === undefined) continue;
    if (!opts.migrationProgramIds.includes(instruction.programId)) continue;

    // THE DISCRIMINATOR CHECK. Without it a swap against the pool decodes as a
    // migration of it, because a swap references the same pool address.
    if (instruction.dataHex === null) {
      sawUndecodableData = true;
      continue;
    }
    const discriminator = instruction.dataHex.slice(0, 16).toLowerCase();
    if (!(opts.migrationDiscriminators ?? MIGRATION_DISCRIMINATORS).includes(discriminator)) {
      sawNonMigrationInstruction = true;
      continue;
    }

    // Candidate mints come from the chain's own token balance records and from
    // this instruction's account list — never from log string ordering.
    //
    // THE INSTRUCTION'S OWN ACCOUNTS COME FIRST, and that ordering is load
    // bearing. Searching the transaction-wide token balances first made every
    // instruction in a two-migration transaction resolve to whichever mint
    // appeared earliest in the transaction, so the second migration was
    // silently attributed to the first token — a different way of doing exactly
    // what identity-by-string-position did.
    const candidates = new Set<string>([...instruction.accounts, ...tx.tokenBalanceMints]);

    for (const mint of candidates) {
      let pool: string;
      let curve: string;
      try {
        pool = canonicalPool(mint);
        curve = bondingCurveAddress(mint);
      } catch {
        continue; // not a valid pubkey, so not a mint
      }

      // THE CHECK. The program cannot have created a pool whose address the
      // transaction never referenced. A mint whose derived pool is absent from
      // the account keys is not this transaction's migration.
      if (!keys.has(pool)) continue;

      const key = migrationDedupKey({ signature: tx.signature, instructionIndex: ix, programId: instruction.programId });
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        signature: tx.signature,
        instructionIndex: ix,
        programId: instruction.programId,
        mint,
        bondingCurve: curve,
        canonicalPool: pool,
        poolBaseTokenAccount: null,
        poolQuoteTokenAccount: null,
        quoteMint: null,
        creator: null,
        isMayhemMode: null,
        isCashbackCoin: null,
        slot: tx.slot,
        blockTime: tx.blockTime,
        commitment: opts.commitment,
        identitySource: 'pda_verified_in_account_keys',
      });
      break; // one migration per instruction
    }
  }

  if (out.length === 0) {
    // Distinguished, because "this was a swap" and "this was a migration whose
    // mint we could not identify" are different facts and only the second is a
    // gap in this decoder.
    if (sawUndecodableData) throw new MigrationUndecodable('the instruction data was not readable');
    if (sawNonMigrationInstruction) throw new MigrationUndecodable('no instruction carried a migration discriminator');
    throw new MigrationUndecodable('no candidate mint derives a pool present in the account keys');
  }
  return out;
}

/**
 * Fill in the facts that require reading the pool account.
 *
 * Kept separate from `decodeMigrations` so identity is decidable without a
 * network round trip, and so a failure to enrich degrades the row rather than
 * discarding a correctly identified migration.
 */
export async function enrichMigration(
  rpc: PoolByteReader,
  m: MigrationEventIdentity,
): Promise<MigrationEventIdentity> {
  let raw;
  try {
    raw = await rpc.getAccountRaw(m.canonicalPool);
  } catch {
    // The pool address was verified present in the transaction; if it is not
    // readable now the identity still stands and the enrichment does not.
    return m;
  }
  try {
    const src = accountSourceOf([
      { pubkey: m.canonicalPool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports },
    ]);
    const a = poolAddressesFrom(src, m.canonicalPool);
    return {
      ...m,
      poolBaseTokenAccount: a.poolBaseTokenAccount,
      poolQuoteTokenAccount: a.poolQuoteTokenAccount,
      quoteMint: a.quoteMint,
      creator: a.coinCreator ?? null,
      isMayhemMode: a.isMayhemMode ?? null,
      isCashbackCoin: a.isCashbackCoin ?? null,
    };
  } catch {
    return m;
  }
}

export interface SignatureHistoryReader {
  getSignaturesForAddress(
    address: string,
    limit?: number,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null }[]>;
  getTransactionInstructions(signature: string): Promise<MigrationTxView | null>;
}

/**
 * Find the transaction that CREATED a pool.
 *
 * Two things make this harder than it sounds, and both were measured rather than
 * assumed:
 *
 * 1. **`getSignaturesForAddress` returns newest first.** The last entry of one
 *    page is the oldest of the most recent N, not the oldest overall. One live
 *    pool needed 25 pages of 1,000 to reach its creation, and without paging it
 *    is indistinguishable from a pool created 30 signatures ago.
 *
 * 2. **The oldest signature is often NOT the creation.** Bots submit buys
 *    against the deterministic pool PDA *before* the migration lands, so the
 *    earliest entries are frequently FAILED snipe attempts. On the first live
 *    pool examined, the oldest signature was a failed `buy_exact_quote_in`.
 *
 * So: page to the end, then walk forward from the oldest until an instruction
 * actually carries a creation discriminator.
 */
export async function findPoolCreation(
  rpc: SignatureHistoryReader,
  pool: string,
  opts: { commitment: MigrationCommitment; migrationProgramIds: readonly string[]; maxPages?: number; scanOldest?: number },
): Promise<{ migrations: readonly MigrationEventIdentity[]; signature: string; pagesWalked: number } | { refusal: string; pagesWalked: number }> {
  const maxPages = opts.maxPages ?? 40;
  let before: string | undefined;
  let lastPage: { signature: string }[] = [];
  let pages = 0;

  for (;;) {
    let page: { signature: string }[];
    try {
      page = await rpc.getSignaturesForAddress(pool, 1_000, before);
    } catch {
      return { refusal: 'the pool history was unreadable', pagesWalked: pages };
    }
    pages++;
    if (page.length === 0) break;
    lastPage = page;
    before = page[page.length - 1]?.signature;
    if (page.length < 1_000) break;
    if (pages >= maxPages) break;
  }

  if (lastPage.length === 0) return { refusal: 'the pool has no signature history', pagesWalked: pages };

  const oldestFirst = [...lastPage].reverse().slice(0, opts.scanOldest ?? 30);
  let lastRefusal = 'no creation instruction in the oldest signatures';
  for (const { signature } of oldestFirst) {
    let tx: MigrationTxView | null;
    try {
      tx = await rpc.getTransactionInstructions(signature);
    } catch {
      continue;
    }
    if (tx === null) continue;
    try {
      const migrations = decodeMigrations(tx, {
        commitment: opts.commitment,
        migrationProgramIds: opts.migrationProgramIds,
      });
      return { migrations, signature, pagesWalked: pages };
    } catch (e) {
      lastRefusal = e instanceof MigrationUndecodable ? e.reason : (e as Error).message.slice(0, 70);
    }
  }
  return { refusal: lastRefusal, pagesWalked: pages };
}

/**
 * Reconcile a `processed` sighting against a later read.
 *
 * `processed` is a claim that can be rolled back. A migration acted on at
 * processed and never rechecked is a candidate that may not exist.
 */
export type ReversalStatus = 'CONFIRMED' | 'REVERSED_OR_DROPPED' | 'STILL_UNKNOWN';

export function reconcileCommitment(
  observedAt: MigrationCommitment,
  later: { found: boolean; failed: boolean } | null,
): ReversalStatus {
  if (observedAt === 'finalized') return 'CONFIRMED';
  if (later === null) return 'STILL_UNKNOWN';
  if (!later.found) return 'REVERSED_OR_DROPPED';
  return later.failed ? 'REVERSED_OR_DROPPED' : 'CONFIRMED';
}
