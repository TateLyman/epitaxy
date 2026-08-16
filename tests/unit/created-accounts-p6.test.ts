import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCreatedAccount,
  summariseSetup,
  requiresSharedAccountCreation,
  type ScopeContext,
  type CreatedAccount,
} from '../../packages/solana/src/created-accounts.js';
import { openDb } from '../../packages/storage/src/db.js';
import {
  insertCreatedAccounts,
  createdAccountsFor,
  setupEconomicsTotals,
} from '../../packages/storage/src/trajectory-repo.js';

/**
 * The directive's P6 tests: 29, 30, 32 and the accounting half of 31.
 *
 * F5 is the finding underneath all of them. The proof artifact showed drag
 * clusters at roughly 0.000509, 0.002547, 0.004333 and 0.006372 SOL, and
 * reported ZERO created-account rent on every single row. The observe set
 * missed the accounts the transaction created, and an account nobody observed
 * reports identically to one that cost nothing.
 *
 * The response the directive explicitly forbids is a larger notional.
 * Amortising a first trader's rent over a bigger trade does not make the rent
 * smaller — it hides it behind a size the strategy then has to justify on other
 * grounds.
 */

const TAKER = 'GgSuFAyZRqpzYNE32WNv5uihdENhz1nPHB7MquioFMj3';
const TAKER_ATA = '8MNXnWvhMvzfkNrySGQiPSiTYUxs2TboM9pzXCZw7AJ3';
const TAKER_WSOL = '7wbyVkQz8czKccDE5GS7AL1h53dtdUmXihajjjC4roNi';
const POOL = 'BSHanq7NmdY6j8u5YE9A3SUygj1bhavFqb73vadspkL3';
const BASE_VAULT = '81uxiueSporvHDhyBQDuecuGC1YQYW9mqxisvfaivDQX';
const QUOTE_VAULT = '9kivsjTqAEPWuJWbsGsuo4NxFKRec5Z7tw7W3cTJBEjx';
const CREATOR_VAULT_ATA = 'C93K8DX4YsABYJtHX9awzgZW3LWzBqBVezEbbLJH4yet';
const GLOBAL_ACCUM = '5d2dnhY788uQo3FTkEw9k4wjUGFfLVv7BV2bc36ftrsD';
const STRANGER = 'D1Eijw8vMeco5cJjCjSJyDFJL8oMemTwxSLEKgr6eHvp';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Rent exemption for a 165-byte SPL token account, the common case. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;

const CTX: ScopeContext = {
  taker: TAKER,
  takerBaseAta: TAKER_ATA,
  takerQuoteAta: TAKER_WSOL,
  pool: POOL,
  poolBaseVault: BASE_VAULT,
  poolQuoteVault: QUOTE_VAULT,
  baseMint: '24fTiNwEG3dEusEjT1GfskFwKpYZhx6MDigceXt2pump',
  quoteMint: 'So11111111111111111111111111111111111111112',
  coinCreatorVaultAta: CREATOR_VAULT_ATA,
  globalVolumeAccumulator: GLOBAL_ACCUM,
};

function made(pubkey: string, lamports = TOKEN_ACCOUNT_RENT, space = 165): CreatedAccount {
  return classifyCreatedAccount({ pubkey, owner: TOKEN_PROGRAM, space, lamports }, CTX);
}

describe('29/30 — every created account is observed and classified', () => {
  it('rent is the EXEMPTION, not the closing balance', () => {
    // The coin-creator fee vault is opened AND paid in the same transaction, so
    // its balance is rent plus a fee the pool sent it. Crediting the whole
    // balance back to the payer flattered every sell by a few basis points.
    const paid = made(CREATOR_VAULT_ATA, TOKEN_ACCOUNT_RENT + 94_000n);
    expect(paid.rentExemptMinimumLamports).toBe(TOKEN_ACCOUNT_RENT);
    expect(paid.excessLamports).toBe(94_000n);
  });

  it('an account funded BELOW its exemption is charged only what it holds', () => {
    const thin = made(STRANGER, 1_000n);
    expect(thin.rentExemptMinimumLamports).toBe(1_000n);
    expect(thin.excessLamports).toBe(0n);
  });

  it('our own token accounts are ours, and recoverable', () => {
    expect(made(TAKER_ATA).scope).toBe('WALLET_TOKEN_MINT');
    expect(made(TAKER_ATA).recoverability).toBe('RECOVERABLE_BY_US');
    expect(made(TAKER_WSOL).scope).toBe('WALLET_QUOTE_MINT');
    expect(made(TAKER_WSOL).recoverability).toBe('RECOVERABLE_BY_US');
  });

  it('the creator fee vault is ours to pay for and THEIRS to close', () => {
    const v = made(CREATOR_VAULT_ATA);
    expect(v.scope).toBe('CREATOR_QUOTE_MINT');
    expect(v.recoverability).toBe('RECOVERABLE_BY_OTHER');
    expect(v.sharedWithOtherTraders).toBe(true);
  });

  it('pool vaults and the global accumulator are nobody’s to close', () => {
    expect(made(BASE_VAULT).recoverability).toBe('NOT_RECOVERABLE');
    expect(made(QUOTE_VAULT).recoverability).toBe('NOT_RECOVERABLE');
    expect(made(GLOBAL_ACCUM).recoverability).toBe('NOT_RECOVERABLE');
    expect(made(GLOBAL_ACCUM).sharedWithOtherTraders).toBe(true);
  });

  it('an unrecognised account is UNKNOWN, never assumed free', () => {
    const s = made(STRANGER);
    expect(s.scope).toBe('UNKNOWN');
    expect(s.recoverability).toBe('UNKNOWN');
    // The optimistic default — treat it as ours and recoverable — is exactly
    // how created-account rent disappeared from the surface in the first place.
    expect(s.recoverability).not.toBe('RECOVERABLE_BY_US');
  });
});

describe('30 — the summary keeps a float apart from a cost', () => {
  it('separates recoverable rent from money that is gone', () => {
    const accounts = [made(TAKER_ATA), made(TAKER_WSOL), made(CREATOR_VAULT_ATA)];
    const s = summariseSetup(accounts);

    expect(s.totalRentLamports).toBe(TOKEN_ACCOUNT_RENT * 3n);
    // Two of ours come back.
    expect(s.recoverableLamports).toBe(TOKEN_ACCOUNT_RENT * 2n);
    expect(s.unrecoverableLamports).toBe(TOKEN_ACCOUNT_RENT);
    // The creator's vault is the one every later trader gets for free.
    expect(s.subsidyToOtherTradersLamports).toBe(TOKEN_ACCOUNT_RENT);
  });

  it('the three columns always reconcile to the total', () => {
    const s = summariseSetup([made(TAKER_ATA), made(BASE_VAULT), made(STRANGER)]);
    expect(s.recoverableLamports + s.unrecoverableLamports).toBe(s.totalRentLamports);
  });

  it('counts what it could not classify rather than dropping it', () => {
    expect(summariseSetup([made(STRANGER)]).unknownScopeCount).toBe(1);
    expect(summariseSetup([made(TAKER_ATA)]).unknownScopeCount).toBe(0);
  });

  it('a five-account cold setup is roughly the ten millisol the artifacts showed', () => {
    // F5's larger clusters: five token accounts at 2,039,280 lamports each is
    // 0.0102 SOL, which is the drag the size surface reported as zero rent.
    const cold = [made(TAKER_ATA), made(TAKER_WSOL), made(CREATOR_VAULT_ATA), made(BASE_VAULT), made(QUOTE_VAULT)];
    expect(summariseSetup(cold).totalRentLamports).toBe(10_196_400n);
  });
});

describe('32 — the warm gate refuses shared account creation', () => {
  it('passes when only our own recoverable accounts are opened', () => {
    expect(requiresSharedAccountCreation([made(TAKER_ATA), made(TAKER_WSOL)])).toBe(false);
  });

  it('refuses when the entry opens a shared protocol account', () => {
    expect(requiresSharedAccountCreation([made(TAKER_ATA), made(CREATOR_VAULT_ATA)])).toBe(true);
    expect(requiresSharedAccountCreation([made(BASE_VAULT)])).toBe(true);
  });

  it('refuses on an account it could not classify', () => {
    // "We did not recognise it" must not read the same as "it costs nothing".
    expect(requiresSharedAccountCreation([made(STRANGER)])).toBe(true);
  });

  it('an entry that creates nothing is warm', () => {
    expect(requiresSharedAccountCreation([])).toBe(false);
  });
});

describe('P6 persistence — append-only, and the corpus totals', () => {
  function db() {
    const d = openDb({ path: join(mkdtempSync(join(tmpdir(), 'p6-')), 'x.db'), skipBackup: true });
    d.prepare(
      `INSERT INTO development_trajectories
         (trajectory_id, entry_observation_id, entry_simulation_job_id, entry_settlement_id,
          venue, pool, capability_fingerprint, snapshot_hash, mint, cohort, stratum,
          migration_age_ms, notional_lamports, entry_policy_inputs, entry_policy, exit_policy,
          state, evidence_grade, max_attainable_grade, quote_impact_ratio, base_impact_ratio,
          max_impact_ratio, haircut_bps, within_small_impact, opened_utc_ms, refusals)
       VALUES ('t1','o','j','s','PUMPSWAP_DIRECT','p','f','h','m','FIRST_HOUR','S',
               NULL,'1','{}','E','X','AWAITING_FILL_OBSERVATION','SIMULATED_EXECUTION',
               'SIMULATED_EXECUTION',0,0,0,0,1,0,'[]')`,
    ).run();
    return d;
  }

  it('stores each created account with its scope and recoverability', () => {
    const d = db();
    insertCreatedAccounts(d, 't1', 'buy', [made(TAKER_ATA), made(CREATOR_VAULT_ATA)], 1);
    const rows = createdAccountsFor(d, 't1');
    expect(rows).toHaveLength(2);
    const creator = rows.find((r) => r.pubkey === CREATOR_VAULT_ATA);
    expect(creator?.economic_scope).toBe('CREATOR_QUOTE_MINT');
    expect(creator?.recoverability).toBe('RECOVERABLE_BY_OTHER');
    expect(creator?.shared_with_other).toBe(1);
    // TEXT, because SQLite INTEGER is 64-bit SIGNED and these are u64 lamports.
    expect(creator?.rent_exempt_min).toBe('2039280');
  });

  it('re-recording the same observation does not double the corpus', () => {
    const d = db();
    insertCreatedAccounts(d, 't1', 'buy', [made(TAKER_ATA)], 1);
    insertCreatedAccounts(d, 't1', 'buy', [made(TAKER_ATA)], 2);
    expect(createdAccountsFor(d, 't1')).toHaveLength(1);
  });

  it('totals report the subsidy separately from recoverable float', () => {
    const d = db();
    insertCreatedAccounts(
      d,
      't1',
      'buy',
      [made(TAKER_ATA), made(TAKER_WSOL), made(CREATOR_VAULT_ATA), made(STRANGER)],
      1,
    );
    const t = setupEconomicsTotals(d);
    expect(t.accounts).toBe(4);
    expect(t.trajectories).toBe(1);
    expect(t.totalRentLamports).toBe((TOKEN_ACCOUNT_RENT * 4n).toString());
    expect(t.recoverableLamports).toBe((TOKEN_ACCOUNT_RENT * 2n).toString());
    expect(t.subsidyLamports).toBe(TOKEN_ACCOUNT_RENT.toString());
    expect(t.unknownScope).toBe(1);
  });

  it('an empty corpus reports zero rather than failing', () => {
    const t = setupEconomicsTotals(db());
    expect(t.accounts).toBe(0);
    expect(t.totalRentLamports).toBe('0');
    expect(t.subsidyLamports).toBe('0');
  });
});
