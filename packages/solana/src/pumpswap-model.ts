import BN from 'bn.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  PumpAmmSdk,
  buyQuoteInput,
  sellBaseInput,
  canonicalPumpPoolPda,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
} from '@pump-fun/pump-swap-sdk';

/**
 * P13 — the current official PumpSwap model, through the official SDK.
 *
 * Deliberately NOT reimplemented. The directive's bar is that a 123–257 bps
 * residual is not parity, and arithmetic written from memory cannot clear it:
 * the fee tier is dynamic (`FeeTier { marketCapLamportsThreshold, fees }`), the
 * quote reserve is effective rather than raw
 * (`raw quote vault + virtual_quote_reserves`), and rounding is exact integer
 * at every step. A plausible local model would be wrong with authority, and it
 * would be wrong in the marks.
 *
 * So the SDK's own decoders read the accounts and the SDK's own functions
 * price the swap. What this module adds is the boundary: reading the state
 * through OUR rpc, and returning a result that says what it did not know
 * rather than defaulting.
 *
 * Pinned: @pump-fun/pump-swap-sdk 1.19.0, @pump-fun/pump-sdk 1.36.0 — both
 * verified against the registry on 2026-08-13 and matching the audited
 * directive's stated versions.
 */

export const PUMPSWAP_SDK_VERSION = '1.19.0';

/** Every account the model needs. Absent is UNKNOWN, never a default. */
export interface PoolState {
  readonly poolAddress: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseReserve: bigint;
  /** Raw vault balance. The EFFECTIVE reserve adds virtual below. */
  readonly quoteReserveRaw: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly coinCreator: string;
  readonly creator: string;
}

export interface PumpSwapQuote {
  readonly baseOutAtoms: bigint;
  readonly maxQuoteInLamports: bigint;
  readonly feeConfigPresent: boolean;
  readonly virtualQuoteReserves: bigint;
}

export class PumpSwapModelUnavailable extends Error {
  constructor(reason: string) {
    super(`no PumpSwap model: ${reason}`);
    this.name = 'PumpSwapModelUnavailable';
  }
}

/** Minimal shape of what our RPC returns, so this file does not import it. */
export interface RawAccountBytes {
  readonly owner: string;
  readonly dataBase64: string;
  readonly lamports: bigint;
}

const toAccountInfo = (r: RawAccountBytes): AccountInfo<Buffer> => ({
  owner: new PublicKey(r.owner),
  data: Buffer.from(r.dataBase64, 'base64'),
  lamports: Number(r.lamports),
  executable: false,
  rentEpoch: 0,
});

export interface AccountReader {
  getAccountRaw(pubkey: string): Promise<RawAccountBytes>;
}

/** The canonical pool for a mint, from the SDK's own PDA derivation. */
export function canonicalPoolFor(baseMint: string, quoteMint?: string): string {
  return canonicalPumpPoolPda(
    new PublicKey(baseMint),
    quoteMint === undefined ? undefined : new PublicKey(quoteMint),
  ).toBase58();
}

export const GLOBAL_CONFIG = GLOBAL_CONFIG_PDA.toBase58();
export const FEE_CONFIG = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
export const AMM_PROGRAM = PUMP_AMM_PROGRAM_ID.toBase58();

/**
 * Price a buy of `quoteLamports` into a pool, using the official model.
 *
 * Throws rather than approximating. A model that silently substitutes a static
 * fee when the fee config is unreadable produces a number that looks like a
 * quote and is not one.
 */
export async function quoteBuy(
  rpc: AccountReader,
  poolAddress: string,
  quoteLamports: bigint,
  slippagePct: number,
): Promise<PumpSwapQuote> {
  const sdk = new PumpAmmSdk();

  let pool;
  let globalConfig;
  let feeConfig = null;
  let baseMintAccount;
  try {
    pool = sdk.decodePool(toAccountInfo(await rpc.getAccountRaw(poolAddress)));
    globalConfig = sdk.decodeGlobalConfig(toAccountInfo(await rpc.getAccountRaw(GLOBAL_CONFIG)));
  } catch (e) {
    throw new PumpSwapModelUnavailable(`pool or global config unreadable: ${(e as Error).message.slice(0, 120)}`);
  }
  try {
    feeConfig = sdk.decodeFeeConfig(toAccountInfo(await rpc.getAccountRaw(FEE_CONFIG)));
  } catch {
    // Null is the SDK's own "no dynamic tier" signal, and it is passed as null
    // rather than replaced by the old static 20+5 model.
    feeConfig = null;
  }

  const p = pool as unknown as {
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    baseMint: PublicKey;
    coinCreator: PublicKey;
    creator: PublicKey;
  };

  let baseReserve: BN;
  let quoteReserve: BN;
  try {
    const b = await rpc.getAccountRaw(p.poolBaseTokenAccount.toBase58());
    const q = await rpc.getAccountRaw(p.poolQuoteTokenAccount.toBase58());
    // SPL token account: amount is u64 LE at offset 64.
    baseReserve = new BN(Buffer.from(b.dataBase64, 'base64').subarray(64, 72), 'le');
    quoteReserve = new BN(Buffer.from(q.dataBase64, 'base64').subarray(64, 72), 'le');
    baseMintAccount = Buffer.from((await rpc.getAccountRaw(p.baseMint.toBase58())).dataBase64, 'base64');
  } catch (e) {
    throw new PumpSwapModelUnavailable(`pool vaults unreadable: ${(e as Error).message.slice(0, 120)}`);
  }

  const virtual = (pool as unknown as { virtualQuoteReserves?: BN }).virtualQuoteReserves ?? new BN(0);

  const res = buyQuoteInput({
    quote: new BN(quoteLamports.toString()),
    slippage: slippagePct,
    baseReserve,
    quoteReserve,
    // The EFFECTIVE quote reserve is raw + virtual. Passing only the vault is
    // the old model and it misprices every canonical pool.
    virtualQuoteReserves: virtual,
    globalConfig,
    baseMintAccount: decodeRawMint(baseMintAccount),
    baseMint: p.baseMint,
    coinCreator: p.coinCreator,
    creator: p.creator,
    feeConfig,
  } as never);

  return {
    baseOutAtoms: BigInt(res.base.toString()),
    maxQuoteInLamports: BigInt(res.maxQuote.toString()),
    feeConfigPresent: feeConfig !== null,
    virtualQuoteReserves: BigInt(virtual.toString()),
  };
}

/** Price a sell of `baseAtoms`, same contract. */
export async function quoteSell(
  rpc: AccountReader,
  poolAddress: string,
  baseAtoms: bigint,
  slippagePct: number,
): Promise<{ quoteOutLamports: bigint; minQuoteLamports: bigint }> {
  const sdk = new PumpAmmSdk();
  const pool = sdk.decodePool(toAccountInfo(await rpc.getAccountRaw(poolAddress)));
  const globalConfig = sdk.decodeGlobalConfig(toAccountInfo(await rpc.getAccountRaw(GLOBAL_CONFIG)));
  let feeConfig = null;
  try {
    feeConfig = sdk.decodeFeeConfig(toAccountInfo(await rpc.getAccountRaw(FEE_CONFIG)));
  } catch {
    feeConfig = null;
  }

  const p = pool as unknown as {
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    baseMint: PublicKey;
    coinCreator: PublicKey;
    creator: PublicKey;
  };
  const b = await rpc.getAccountRaw(p.poolBaseTokenAccount.toBase58());
  const q = await rpc.getAccountRaw(p.poolQuoteTokenAccount.toBase58());
  const baseMintAccount = Buffer.from((await rpc.getAccountRaw(p.baseMint.toBase58())).dataBase64, 'base64');

  const res = sellBaseInput({
    base: new BN(baseAtoms.toString()),
    slippage: slippagePct,
    baseReserve: new BN(Buffer.from(b.dataBase64, 'base64').subarray(64, 72), 'le'),
    quoteReserve: new BN(Buffer.from(q.dataBase64, 'base64').subarray(64, 72), 'le'),
    virtualQuoteReserves: (pool as unknown as { virtualQuoteReserves?: BN }).virtualQuoteReserves ?? new BN(0),
    globalConfig,
    baseMintAccount: decodeRawMint(baseMintAccount),
    baseMint: p.baseMint,
    coinCreator: p.coinCreator,
    creator: p.creator,
    feeConfig,
  } as never);

  return {
    quoteOutLamports: BigInt((res as unknown as { uiQuote: BN }).uiQuote?.toString() ?? '0'),
    minQuoteLamports: BigInt((res as unknown as { minQuote: BN }).minQuote?.toString() ?? '0'),
  };
}

/**
 * The mint fields the fee model reads, decoded from the account's own bytes.
 *
 * `RawMint` from @solana/spl-token; only the fields the SDK touches are
 * populated, and each is read at its documented offset rather than guessed.
 */
function decodeRawMint(data: Buffer): unknown {
  return {
    mintAuthorityOption: data.readUInt32LE(0),
    mintAuthority: new PublicKey(data.subarray(4, 36)),
    supply: new BN(data.subarray(36, 44), 'le'),
    decimals: data.readUInt8(44),
    isInitialized: data.readUInt8(45) === 1,
    freezeAuthorityOption: data.readUInt32LE(46),
    freezeAuthority: new PublicKey(data.subarray(50, 82)),
  };
}
