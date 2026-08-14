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

export interface MigrationTxView {
  readonly signature: string;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly failed: boolean;
  readonly accountKeys: readonly string[];
  /** Mints the chain itself named in the token balances. Not parsed from logs. */
  readonly tokenBalanceMints: readonly string[];
  /** Per-instruction program + account addresses, in order. */
  readonly instructions: readonly { programId: string; accounts: readonly string[] }[];
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
  opts: { commitment: MigrationCommitment; migrationProgramIds: readonly string[] },
): readonly MigrationEventIdentity[] {
  // A failed transaction migrated nothing. Counting it as flow is how a corpus
  // comes to be 99.75% events that never happened.
  if (tx.failed) throw new MigrationUndecodable('the transaction failed; nothing migrated');
  if (tx.slot === null) throw new MigrationUndecodable('the transaction has no slot');

  const keys = new Set(tx.accountKeys);
  const out: MigrationEventIdentity[] = [];
  const seen = new Set<string>();

  for (let ix = 0; ix < tx.instructions.length; ix++) {
    const instruction = tx.instructions[ix];
    if (instruction === undefined) continue;
    if (!opts.migrationProgramIds.includes(instruction.programId)) continue;

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
