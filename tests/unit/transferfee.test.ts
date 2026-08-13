import { describe, it, expect } from 'vitest';
import {
  transferFeeAtEpoch,
  worstCaseTransferFee,
  amountAfterTransferFee,
  decodeMint,
  type TransferFeeConfig,
} from '../../packages/solana/src/mint.js';

/**
 * §10.5 — Token-2022 transfer fees, both schedules.
 *
 * The decoder read the NEWER config unconditionally and called it "what a
 * transfer today pays". It is not. Token-2022 keeps an older and a newer
 * schedule, each with the epoch it takes effect from, and the newer applies
 * only from its own epoch onward.
 *
 * A mint can advertise 0 bps effective next epoch while charging 1,000 bps
 * today. The old decoder reported a free transfer on a token taking a tenth of
 * every trade — wrong in the one direction that costs money.
 */

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const config = (over: Partial<TransferFeeConfig> = {}): TransferFeeConfig => ({
  withheldAmount: 0n,
  older: { epoch: 10n, maximumFee: 1_000_000n, basisPoints: 1_000 },
  newer: { epoch: 20n, maximumFee: 1_000_000n, basisPoints: 0 },
  ...over,
});

describe('which schedule is in force', () => {
  it('uses the older one before the newer takes effect', () => {
    // The case that matters: 1,000 bps today, 0 bps promised for epoch 20.
    expect(transferFeeAtEpoch(config(), 19n).basisPoints).toBe(1_000);
  });

  it('uses the newer one from its own epoch', () => {
    expect(transferFeeAtEpoch(config(), 20n).basisPoints).toBe(0);
    expect(transferFeeAtEpoch(config(), 500n).basisPoints).toBe(0);
  });

  it('takes the DEARER schedule when the epoch is unknown', () => {
    // Overstating a cost refuses a trade that might have been fine.
    // Understating one takes a trade that was not.
    expect(worstCaseTransferFee(config()).basisPoints).toBe(1_000);
    expect(worstCaseTransferFee(config({ older: { epoch: 1n, maximumFee: 0n, basisPoints: 0 } })).basisPoints).toBe(0);
  });

  it('breaks a bps tie on the maximum fee', () => {
    const c = config({
      older: { epoch: 1n, maximumFee: 5n, basisPoints: 100 },
      newer: { epoch: 2n, maximumFee: 900n, basisPoints: 100 },
    });
    expect(worstCaseTransferFee(c).maximumFee).toBe(900n);
  });
});

describe('amountAfterTransferFee', () => {
  it('takes the fee out of what the recipient gets', () => {
    // 1,000 bps of 1,000,000 is 100,000.
    expect(amountAfterTransferFee(1_000_000n, { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: 1_000 })).toBe(900_000n);
  });

  it('rounds the fee UP, so the recipient is never credited a token the fee took', () => {
    // 1 bps of 1,001 is 0.1001, charged as 1.
    expect(amountAfterTransferFee(1_001n, { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: 1 })).toBe(1_000n);
  });

  it('caps at the maximum fee', () => {
    expect(amountAfterTransferFee(10n ** 12n, { epoch: 0n, maximumFee: 5n, basisPoints: 1_000 })).toBe(10n ** 12n - 5n);
  });

  it('leaves the amount alone when there is no fee', () => {
    expect(amountAfterTransferFee(1_000n, { epoch: 0n, maximumFee: 0n, basisPoints: 0 })).toBe(1_000n);
  });
});

describe('decoding both schedules from a real layout', () => {
  /** A Token-2022 mint with a TransferFeeConfig extension. */
  function mintWithTransferFee(olderBps: number, newerBps: number, newerEpoch: bigint, withheld: bigint): Uint8Array {
    // 82-byte base mint, padded to 165, then account type, then extensions.
    const b = Buffer.alloc(165 + 1 + 4 + 108);
    b.writeUInt32LE(0, 0); // mint authority: None
    b.writeBigUInt64LE(1_000_000n, 36); // supply
    b[44] = 9; // decimals
    b[45] = 1; // initialized
    b.writeUInt32LE(0, 46); // freeze authority: None
    b[165] = 1; // account type: Mint
    b.writeUInt16LE(1, 166); // extension discriminant: TransferFeeConfig
    b.writeUInt16LE(108, 168); // length

    const v = 170;
    // config authority (32) + withdraw authority (32), both left zero = None.
    b.writeBigUInt64LE(withheld, v + 64);
    const older = v + 72;
    b.writeBigUInt64LE(1n, older);
    b.writeBigUInt64LE(1_000_000n, older + 8);
    b.writeUInt16LE(olderBps, older + 16);
    const newer = older + 18;
    b.writeBigUInt64LE(newerEpoch, newer);
    b.writeBigUInt64LE(1_000_000n, newer + 8);
    b.writeUInt16LE(newerBps, newer + 16);
    return new Uint8Array(b);
  }

  it('reads both schedules, the epochs and the withheld amount', () => {
    const m = decodeMint(mintWithTransferFee(1_000, 0, 20n, 4_242n), TOKEN_2022);
    expect(m.transferFeeConfig).not.toBeNull();
    expect(m.transferFeeConfig?.older.basisPoints).toBe(1_000);
    expect(m.transferFeeConfig?.newer.basisPoints).toBe(0);
    expect(m.transferFeeConfig?.newer.epoch).toBe(20n);
    expect(m.transferFeeConfig?.withheldAmount).toBe(4_242n);
  });

  it('reports the WORST case on the legacy transferFee field', () => {
    // Callers that only ever asked "is there a fee" now get the answer that
    // cannot understate it. The old code returned the newer schedule, which on
    // this mint is 0 bps while it charges 1,000 today.
    const m = decodeMint(mintWithTransferFee(1_000, 0, 20n, 0n), TOKEN_2022);
    expect(m.transferFee?.basisPoints).toBe(1_000);
  });

  it('leaves the config null on a mint with no such extension', () => {
    const plain = Buffer.alloc(82);
    plain[45] = 1;
    expect(decodeMint(new Uint8Array(plain), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').transferFeeConfig).toBeNull();
  });
});
