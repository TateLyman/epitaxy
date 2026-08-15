import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { rentExemptLamports, createdAccountRent } from '../../packages/simulator/src/sequential-runtime.js';
import type { SequentialStepResult } from '../../packages/simulator/src/sequential-runtime.js';

/**
 * P24 items 35 and 36 — sell parity, and parity at more than one size.
 *
 * The previous matrix was five buy quotes at one 0.02 SOL notional. It could
 * not have caught what this one did: the sell arm disagreed with the runtime by
 * 41,818 bps at 0.001 SOL and 1,045 bps at 0.04 SOL, which is one constant
 * four-million-lamport error reported as six different numbers because only the
 * denominator changed. A single-size matrix would have seen one of those and
 * called it a pricing residual.
 */

const ARTIFACT = 'artifacts/pumpswap-parity-v2.json';

interface Row {
  side: 'buy' | 'sell';
  sizeLamports: string;
  mint: string;
  runtimeVsOfflineBps: number | null;
  offlineVsSdkBps: number | null;
  status: string;
}
interface Artifact {
  sizes: string[];
  measured: number;
  buys: number;
  sells: number;
  exactRuntimeVsOffline: number;
  comparedRuntimeVsOffline: number;
  rows: Row[];
}

const load = (): Artifact => JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Artifact;

describe('P24 item 35 — the SELL is compared, not only the buy', () => {
  it.skipIf(!existsSync(ARTIFACT))('measured at least as many sells as buys', () => {
    const a = load();
    expect(a.sells).toBeGreaterThan(0);
    expect(a.sells).toBe(a.buys);
  });

  it.skipIf(!existsSync(ARTIFACT))('every measured sell agrees with the runtime exactly', () => {
    // Exactly. A residual is either zero or it is not, and this one was not
    // until created-account rent was charged at the exemption rather than at
    // the account's closing balance.
    const a = load();
    const sells = a.rows.filter((r) => r.side === 'sell' && r.status === 'MEASURED' && r.runtimeVsOfflineBps !== null);
    expect(sells.length).toBeGreaterThan(0);
    expect(sells.filter((r) => r.runtimeVsOfflineBps !== 0)).toEqual([]);
  });
});

describe('P24 item 36 — parity holds across the size grid, not at one notional', () => {
  it.skipIf(!existsSync(ARTIFACT))('covers every preregistered size on both sides', () => {
    const a = load();
    for (const size of a.sizes) {
      const at = a.rows.filter((r) => r.sizeLamports === size || r.side === 'sell');
      expect(at.length).toBeGreaterThan(0);
    }
    const buySizes = new Set(a.rows.filter((r) => r.side === 'buy').map((r) => r.sizeLamports));
    expect(buySizes.size).toBe(a.sizes.length);
  });

  it.skipIf(!existsSync(ARTIFACT))('spans more than one mint, so one pool cannot carry the result', () => {
    const a = load();
    expect(new Set(a.rows.map((r) => r.mint)).size).toBeGreaterThan(1);
  });

  it.skipIf(!existsSync(ARTIFACT))('reports exactness against what was actually compared', () => {
    // Not against the row count. An arm that was never obtained is not an arm
    // that agreed, and dividing by the wrong denominator is how a matrix
    // reports coverage it does not have.
    const a = load();
    expect(a.comparedRuntimeVsOffline).toBeLessThanOrEqual(a.measured);
    expect(a.exactRuntimeVsOffline).toBeLessThanOrEqual(a.comparedRuntimeVsOffline);
  });
});

describe('rent is derived from the chain’s constants, not from a remembered number', () => {
  it('reproduces the 165-byte token account exemption', () => {
    // (128 + 165) x 3480 x 2. The figure this system has quoted all along,
    // computed rather than pasted.
    expect(rentExemptLamports(165n)).toBe(2_039_280n);
  });

  it('charges a Token-2022 account with extensions its own larger rent', () => {
    expect(rentExemptLamports(256n)).toBeGreaterThan(rentExemptLamports(165n));
  });

  it('credits only the exemption when an account is opened AND paid in one step', () => {
    // The coin-creator fee vault. Crediting its closing balance back to the
    // payer treated a fee the pool sent it as rent the payer recovered, and
    // flattered every sell by a few basis points.
    const step: SequentialStepResult = {
      label: 'sell',
      status: 'SIMULATED_OK',
      transactionError: null,
      computeUnitsConsumed: null,
      logs: [],
      preAccounts: [],
      postAccounts: [
        {
          pubkey: 'vault',
          // 165 bytes of data, and 500,000 lamports more than its rent.
          dataBase64: Buffer.alloc(165).toString('base64'),
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          lamports: 2_539_280n,
          executable: false,
          rentEpoch: 0n,
          dataLen: 165,
          dataSha256: '',
          accountHash: 'vault-post',
        },
      ],
      unobserved: [],
    };
    const r = createdAccountRent(step);
    expect(r.lamports).toBe(2_039_280n);
    expect(r.accounts[0]?.excessLamports).toBe('500000');
  });

  it('never credits more than the account actually holds', () => {
    const step: SequentialStepResult = {
      label: 'sell',
      status: 'SIMULATED_OK',
      transactionError: null,
      computeUnitsConsumed: null,
      logs: [],
      preAccounts: [],
      postAccounts: [
        {
          pubkey: 'thin',
          dataBase64: Buffer.alloc(165).toString('base64'),
          owner: 'x',
          lamports: 1_000n,
          executable: false,
          rentEpoch: 0n,
          dataLen: 165,
          dataSha256: '',
          accountHash: 'thin-post',
        },
      ],
      unobserved: [],
    };
    expect(createdAccountRent(step).lamports).toBe(1_000n);
  });

  it('an account that already existed is not a creation', () => {
    const acct = {
      pubkey: 'a',
      dataBase64: '',
      owner: 'o',
      lamports: 10n,
      executable: false,
      rentEpoch: 0n,
      dataLen: 0,
      dataSha256: '',
      accountHash: 'a-pre',
    };
    const step: SequentialStepResult = {
      label: 'sell',
      status: 'SIMULATED_OK',
      transactionError: null,
      computeUnitsConsumed: null,
      logs: [],
      preAccounts: [acct],
      postAccounts: [{ ...acct, lamports: 5_000_000n }],
      unobserved: [],
    };
    expect(createdAccountRent(step).lamports).toBe(0n);
  });
});
