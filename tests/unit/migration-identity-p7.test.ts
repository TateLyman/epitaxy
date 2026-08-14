import { describe, it, expect } from 'vitest';
import {
  decodeMigrations,
  migrationDedupKey,
  reconcileCommitment,
  MigrationUndecodable,
  type MigrationTxView,
} from '../../packages/solana/src/migration.js';
import { canonicalPool, AMM_PROGRAM_ID } from '../../packages/solana/src/pumpswap-offline.js';
import { bondingCurveAddress } from '../../packages/solana/src/pump.js';

/**
 * P7 / finding J — migration identity a decision can be made on.
 *
 * Measured on the runtime database at head 1c499cd, which is what the code
 * under test replaces:
 *
 *   MIGRATION events                          256,880
 *     errored transactions                    256,235   (99.75%)
 *     distinct mints                               56
 *     canonicalPool(storedMint) == storedPool       0   of 300 sampled
 *
 * Three defects: identity by string position, failed transactions counted as
 * flow, and a dedup key that collapses a multi-instruction transaction.
 */

const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const PROGRAMS = [AMM_PROGRAM_ID];

function tx(over: Partial<MigrationTxView> = {}): MigrationTxView {
  const pool = canonicalPool(MINT_A);
  return {
    signature: 'sig1',
    slot: 500,
    blockTime: 1_760_000_000,
    failed: false,
    accountKeys: [pool, MINT_A, 'someOtherAccount11111111111111111111111111'],
    tokenBalanceMints: [MINT_A],
    instructions: [{ programId: AMM_PROGRAM_ID, accounts: [pool, MINT_A] }],
    ...over,
  };
}

describe('P7 — identity comes from a verified PDA, not from string position', () => {
  it('decodes the mint and pool of a real migration shape', () => {
    const [m] = decodeMigrations(tx(), { commitment: 'confirmed', migrationProgramIds: PROGRAMS });
    expect(m?.mint).toBe(MINT_A);
    expect(m?.canonicalPool).toBe(canonicalPool(MINT_A));
    expect(m?.bondingCurve).toBe(bondingCurveAddress(MINT_A));
    expect(m?.identitySource).toBe('pda_verified_in_account_keys');
  });

  it('REFUSES when no candidate mint derives a pool the transaction referenced', () => {
    // The old parser would have returned the first base58 string it saw. The
    // program cannot have created a pool whose address it never named, so a
    // mint failing this check is not this transaction's migration.
    const t = tx({ accountKeys: [MINT_B, 'x'], tokenBalanceMints: [MINT_B], instructions: [{ programId: AMM_PROGRAM_ID, accounts: [MINT_B] }] });
    expect(() => decodeMigrations(t, { commitment: 'confirmed', migrationProgramIds: PROGRAMS })).toThrow(
      /no candidate mint derives a pool present/,
    );
  });

  it('is not fooled by the order of the account keys', () => {
    // Identity by position is exactly the defect. Reversing the list must not
    // change the answer.
    const forward = decodeMigrations(tx(), { commitment: 'confirmed', migrationProgramIds: PROGRAMS });
    const reversed = decodeMigrations(tx({ accountKeys: [...tx().accountKeys].reverse() }), {
      commitment: 'confirmed',
      migrationProgramIds: PROGRAMS,
    });
    expect(reversed[0]?.mint).toBe(forward[0]?.mint);
    expect(reversed[0]?.canonicalPool).toBe(forward[0]?.canonicalPool);
  });

  it('ignores instructions belonging to other programs', () => {
    const t = tx({ instructions: [{ programId: 'SomeOtherProgram1111111111111111111111111', accounts: [MINT_A] }] });
    expect(() => decodeMigrations(t, { commitment: 'confirmed', migrationProgramIds: PROGRAMS })).toThrow(
      MigrationUndecodable,
    );
  });
});

describe('P7 — a failed transaction migrated nothing', () => {
  it('refuses an errored transaction', () => {
    // 256,235 of 256,880 stored "migrations" are this.
    expect(() => decodeMigrations(tx({ failed: true }), { commitment: 'confirmed', migrationProgramIds: PROGRAMS })).toThrow(
      /the transaction failed; nothing migrated/,
    );
  });

  it('refuses a transaction with no slot rather than inventing one', () => {
    expect(() => decodeMigrations(tx({ slot: null }), { commitment: 'confirmed', migrationProgramIds: PROGRAMS })).toThrow(
      /no slot/,
    );
  });
});

describe('P7 — the dedup key keeps two migrations in one transaction as two', () => {
  it('distinguishes instruction indices within one signature and program', () => {
    const a = migrationDedupKey({ signature: 's', instructionIndex: 0, programId: 'p' });
    const b = migrationDedupKey({ signature: 's', instructionIndex: 1, programId: 'p' });
    expect(a).not.toBe(b);
  });

  it('decodes both migrations when one transaction performs two', () => {
    const poolA = canonicalPool(MINT_A);
    const poolB = canonicalPool(MINT_B);
    const t = tx({
      accountKeys: [poolA, MINT_A, poolB, MINT_B],
      tokenBalanceMints: [MINT_A, MINT_B],
      instructions: [
        { programId: AMM_PROGRAM_ID, accounts: [poolA, MINT_A] },
        { programId: AMM_PROGRAM_ID, accounts: [poolB, MINT_B] },
      ],
    });
    const out = decodeMigrations(t, { commitment: 'confirmed', migrationProgramIds: PROGRAMS });
    // `(signature, program_id)` — the key the table actually uses — would have
    // kept one arbitrary member of this pair.
    expect(out).toHaveLength(2);
    expect(new Set(out.map((m) => m.mint))).toEqual(new Set([MINT_A, MINT_B]));
    expect(new Set(out.map(migrationDedupKey)).size).toBe(2);
  });
});

describe('P7 — processed is a claim, not a fact', () => {
  it('finalized needs no reconciliation', () => {
    expect(reconcileCommitment('finalized', null)).toBe('CONFIRMED');
  });

  it('an unchecked processed sighting is STILL_UNKNOWN, never CONFIRMED', () => {
    // All 256,880 stored migration rows have reversal_status NULL. "Not yet
    // reconciled" is not the same as "reconciled and fine".
    expect(reconcileCommitment('processed', null)).toBe('STILL_UNKNOWN');
  });

  it('a processed sighting that later cannot be found is a reversal', () => {
    expect(reconcileCommitment('processed', { found: false, failed: false })).toBe('REVERSED_OR_DROPPED');
  });

  it('a processed sighting that later shows as failed is a reversal', () => {
    expect(reconcileCommitment('processed', { found: true, failed: true })).toBe('REVERSED_OR_DROPPED');
  });

  it('a processed sighting that later lands is confirmed', () => {
    expect(reconcileCommitment('processed', { found: true, failed: false })).toBe('CONFIRMED');
  });
});
