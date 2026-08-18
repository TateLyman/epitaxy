import BN from 'bn.js';
import { PublicKey, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import {
  PumpAmmSdk,
  sellBaseInput,
  buyQuoteInput,
  canonicalPumpPoolPda,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  userVolumeAccumulatorPda,
  coinCreatorVaultAuthorityPda,
  coinCreatorVaultAtaPda,
  poolV2Pda,
} from '@pump-fun/pump-swap-sdk';

/**
 * P2/P13 — build a PumpSwap leg from an ARBITRARY set of account bytes.
 *
 * `pumpswap-model.ts` reads its accounts through the RPC, which is correct for
 * a mark against mainnet and useless for the thing that actually matters:
 *
 *   the sell must be priced and constructed against the pool the BUY moved
 *
 * A pool that a hypothetical buy just bought into does not exist on any RPC.
 * It exists only inside the sequential runtime, as the committed post-state of
 * step N. So the whole account source is a parameter here — the caller passes
 * the runtime's own post-buy bytes and gets a sell built against them.
 *
 * Every field of the SDK's `SwapSolanaState` comes from account bytes and
 * nothing else, which is what makes this possible at all. The state object is
 * assembled from the source; the SDK's own decoders and its own instruction
 * builder do the rest. Nothing here reimplements the AMM.
 *
 * Reading is SYNCHRONOUS and total: an account that is not in the source is an
 * error naming the account, never a default. A missing vault silently read as
 * zero would price a sell against an empty pool and report a number.
 */

export interface AccountBytes {
  readonly owner: string;
  readonly dataBase64: string;
  readonly lamports: bigint;
}

/** A total, synchronous account source. `null` means the source does not have it. */
export interface AccountBytesSource {
  get(pubkey: string): AccountBytes | null;
}

export class OfflineStateIncomplete extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[], context: string) {
    super(`offline PumpSwap state incomplete (${context}): ${missing.join(', ')}`);
    this.name = 'OfflineStateIncomplete';
    this.missing = missing;
  }
}

/** Build a source from any list of {pubkey, ...} records. Last write wins. */
/**
 * The fee config account exists and this build cannot read it.
 *
 * Never downgraded to "there is no fee config". The two produce different
 * prices, and only one of them is a fact about the pool.
 */
export class FeeConfigUndecodable extends Error {
  constructor(readonly detail: string) {
    super(
      `the PumpSwap fee config is present and did not decode (${detail.slice(0, 120)}). ` +
        'Refusing rather than pricing against the static tier, which is a different fee.',
    );
    this.name = 'FeeConfigUndecodable';
  }
}

export function accountSourceOf(
  records: readonly {
    pubkey: string;
    owner: string;
    /** Null means the observation did not request this account's bytes. */
    dataBase64: string | null;
    lamports: bigint | number;
  }[],
): AccountBytesSource {
  const map = new Map<string, AccountBytes>();
  for (const r of records) {
    // An account whose bytes were never fetched must not enter a source that
    // the next leg is BUILT from. Treating it as empty would quote a pool with
    // no reserves and call the answer a market fact.
    if (r.dataBase64 === null) {
      throw new Error(
        `accountSourceOf: ${r.pubkey} carries no bytes (they were not requested), ` +
          'so it cannot back a build. Name it in the economic set.',
      );
    }
    map.set(r.pubkey, {
      owner: r.owner,
      dataBase64: r.dataBase64,
      lamports: typeof r.lamports === 'bigint' ? r.lamports : BigInt(Math.trunc(r.lamports)),
    });
  }
  return {
    get: (p) => map.get(p) ?? null,
  };
}

/** Layer a second source over a first. Used to put post-buy state over the snapshot. */
export function overlaySource(base: AccountBytesSource, over: AccountBytesSource): AccountBytesSource {
  return { get: (p) => over.get(p) ?? base.get(p) };
}

const toAccountInfo = (r: AccountBytes): AccountInfo<Buffer> => ({
  owner: new PublicKey(r.owner),
  data: Buffer.from(r.dataBase64, 'base64'),
  lamports: Number(r.lamports),
  executable: false,
  rentEpoch: 0,
});

/** SPL token account amount: u64 LE at offset 64. */
export function tokenAmountFromBytes(dataBase64: string): bigint | null {
  const b = Buffer.from(dataBase64, 'base64');
  if (b.length < 72) return null;
  return b.readBigUInt64LE(64);
}

/**
 * The mint fields the fee model reads, at their documented offsets.
 *
 * Duplicated deliberately rather than imported from `pumpswap-model.ts`: that
 * module reaches for the network in every exported function, and this one must
 * never do so.
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

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const AMM_PROGRAM_ID = PUMP_AMM_PROGRAM_ID.toBase58();
export const AMM_EVENT_AUTHORITY = PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58();
export const GLOBAL_VOLUME_ACCUMULATOR = GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58();
export const GLOBAL_CONFIG_ADDR = GLOBAL_CONFIG_PDA.toBase58();
export const FEE_CONFIG_ADDR = PUMP_AMM_FEE_CONFIG_PDA.toBase58();

/**
 * Every program a PumpSwap swap executes, including the ones it reaches by
 * CPI and therefore names in no instruction.
 *
 * The AMM calls into the pump program for the volume accumulator and into the
 * fee program for the dynamic tier. Loading only the AMM left both as accounts
 * with no executable behind them, which the runtime reports as anchor 3009,
 * `InvalidProgramExecutable`, at whichever instruction index happened to reach
 * one first.
 */
export const SWAP_PROGRAM_IDS: readonly string[] = [
  PUMP_AMM_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  PUMP_FEE_PROGRAM_ID.toBase58(),
];

/** The canonical pool for a base mint, from the SDK's own PDA derivation. */
export function canonicalPool(baseMint: string, quoteMint = WSOL_MINT): string {
  return canonicalPumpPoolPda(new PublicKey(baseMint), new PublicKey(quoteMint)).toBase58();
}

/**
 * Every account a PumpSwap swap by `user` on `pool` can touch.
 *
 * Used to tell the snapshot capture what to fetch: the runtime must hold all of
 * these or the leg fails inside it for a reason that has nothing to do with the
 * market. Derivable without reading anything except the pool itself.
 */
export function swapAccountAddresses(p: {
  poolKey: string;
  baseMint: string;
  user: string;
  coinCreator?: string | null;
  baseTokenProgram?: string;
  quoteTokenProgram?: string;
}): string[] {
  const out = new Set<string>([
    p.poolKey,
    p.baseMint,
    WSOL_MINT,
    p.user,
    GLOBAL_CONFIG_PDA.toBase58(),
    PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
    PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(),
    GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58(),
    AMM_PROGRAM_ID,
  ]);
  try {
    out.add(userVolumeAccumulatorPda(new PublicKey(p.user)).toBase58());
  } catch {
    /* an undecodable user is the caller's problem, reported elsewhere */
  }
  if (p.coinCreator !== null && p.coinCreator !== undefined) {
    try {
      const auth = coinCreatorVaultAuthorityPda(new PublicKey(p.coinCreator));
      out.add(auth.toBase58());
      out.add(
        coinCreatorVaultAtaPda(
          auth,
          new PublicKey(WSOL_MINT),
          new PublicKey(p.quoteTokenProgram ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        ).toBase58(),
      );
    } catch {
      /* a creator that does not decode has no vault to fetch */
    }
  }
  return [...out];
}

/**
 * The same addresses as `swapAccountAddresses`, but NAMED.
 *
 * P6 needs the names, not the set. `swapAccountAddresses` returns an unordered
 * bag suitable for "fetch all of these", and a bag is exactly what a classifier
 * cannot use: every account the buy created came back as `UNKNOWN`, which the
 * warm gate then treats as shared. Safe, and uninformative — an entry that
 * opened only its own recoverable ATAs was indistinguishable from one that paid
 * a creator vault's rent.
 *
 * P7 needs them too, for a different reason: the cashback remaining accounts
 * are POSITIONAL, so verifying placement means knowing which address belongs at
 * which index.
 *
 * A derivation that throws yields `null` rather than a guess. An address we
 * could not derive must not silently equal an address we did.
 */
export interface SwapAccountRoles {
  readonly userVolumeAccumulator: string | null;
  readonly accumulatorWsolAta: string | null;
  readonly globalVolumeAccumulator: string;
  readonly coinCreatorVaultAuthority: string | null;
  readonly coinCreatorVaultAta: string | null;
  /**
   * The `pool-v2` PDA the SDK appends after the cashback accounts whenever
   * `coinCreator` is set. Part of the remaining-account TAIL, so P7's placement
   * check has to know about it even though it carries no cashback itself.
   */
  readonly poolV2: string | null;
}

/**
 * The PumpSwap `buy`/`sell` account layout, by POSITION.
 *
 * The program reads these positionally, so position is what they are. This
 * repository already relies on that for the cashback tail — `remainingTailRefusal`
 * checks exact positions — and the same reasoning applies here.
 *
 * `PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT` is the one that matters for D-2. It is
 * SELECTED BY THE SDK from a list in the global config, so it cannot be derived;
 * it can only be read off the frozen plan. Measured 2026-08-17 on two pools:
 *
 *     payer spent                       20,000,000
 *     pool quote vault gained           19,757,035
 *     creator vault + cashback tail        151,112
 *     THIS ACCOUNT                          91,852     <- 46 bps, unattributed
 *
 * Omitting it made every entry fail quote-side conservation by 0.46%, which is
 * the correct refusal for an incomplete model and the wrong conclusion about the
 * venue.
 */
export const SWAP_ACCOUNT_INDEX = {
  POOL: 0,
  USER: 1,
  GLOBAL_CONFIG: 2,
  BASE_MINT: 3,
  QUOTE_MINT: 4,
  USER_BASE_TOKEN_ACCOUNT: 5,
  USER_QUOTE_TOKEN_ACCOUNT: 6,
  POOL_BASE_TOKEN_ACCOUNT: 7,
  POOL_QUOTE_TOKEN_ACCOUNT: 8,
  PROTOCOL_FEE_RECIPIENT: 9,
  PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT: 10,
  BASE_TOKEN_PROGRAM: 11,
  QUOTE_TOKEN_PROGRAM: 12,
  SYSTEM_PROGRAM: 13,
  ASSOCIATED_TOKEN_PROGRAM: 14,
  EVENT_AUTHORITY: 15,
  PROGRAM: 16,
  COIN_CREATOR_VAULT_ATA: 17,
  COIN_CREATOR_VAULT_AUTHORITY: 18,
} as const;

/**
 * The quote destinations a swap instruction NAMES, read off the frozen plan.
 *
 * Verified against the plan rather than derived: the layout above is checked by
 * confirming the accounts we CAN derive land where it says they do. If the pool
 * quote vault is not at index 8, the layout has changed and this returns null
 * rather than reading whatever happens to sit at index 10.
 */
export function namedQuoteDestinations(
  swapInstructionAccounts: readonly string[],
  expect: { poolQuoteTokenAccount: string; globalConfig: string },
): { protocolFeeRecipientTokenAccount: string; coinCreatorVaultAta: string } | null {
  const a = swapInstructionAccounts;
  if (a.length <= SWAP_ACCOUNT_INDEX.COIN_CREATOR_VAULT_ATA) return null;
  if (a[SWAP_ACCOUNT_INDEX.POOL_QUOTE_TOKEN_ACCOUNT] !== expect.poolQuoteTokenAccount) return null;
  if (a[SWAP_ACCOUNT_INDEX.GLOBAL_CONFIG] !== expect.globalConfig) return null;
  return {
    protocolFeeRecipientTokenAccount: a[SWAP_ACCOUNT_INDEX.PROTOCOL_FEE_RECIPIENT_TOKEN_ACCOUNT] as string,
    coinCreatorVaultAta: a[SWAP_ACCOUNT_INDEX.COIN_CREATOR_VAULT_ATA] as string,
  };
}

export function swapAccountRoles(p: {
  user: string;
  baseMint?: string;
  coinCreator?: string | null;
  quoteMint?: string;
  quoteTokenProgram?: string;
}): SwapAccountRoles {
  const quoteMint = p.quoteMint ?? WSOL_MINT;
  const quoteProgram = p.quoteTokenProgram ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  let uva: string | null = null;
  let uvaAta: string | null = null;
  try {
    const pda = userVolumeAccumulatorPda(new PublicKey(p.user));
    uva = pda.toBase58();
    /**
     * The accumulator's WSOL account is an ATA owned by the PDA.
     *
     * `coinCreatorVaultAtaPda` is a misleading name for what it is — the SDK
     * defines it as `getAssociatedTokenAddressSync(mint, owner, true, program)`
     * with no creator-specific logic at all — but it is the SAME call the SDK
     * makes when it pushes remaining_accounts[0], so using it here derives the
     * identical address rather than a parallel one that might drift.
     */
    uvaAta = coinCreatorVaultAtaPda(pda, new PublicKey(quoteMint), new PublicKey(quoteProgram)).toBase58();
  } catch {
    /* an undecodable user has no accumulator; null, never a placeholder */
  }

  let poolV2: string | null = null;
  if (p.baseMint !== undefined) {
    try {
      poolV2 = poolV2Pda(new PublicKey(p.baseMint)).toBase58();
    } catch {
      /* a mint that does not decode has no pool-v2 PDA */
    }
  }

  let auth: string | null = null;
  let ata: string | null = null;
  if (p.coinCreator !== null && p.coinCreator !== undefined) {
    try {
      const a = coinCreatorVaultAuthorityPda(new PublicKey(p.coinCreator));
      auth = a.toBase58();
      ata = coinCreatorVaultAtaPda(a, new PublicKey(quoteMint), new PublicKey(quoteProgram)).toBase58();
    } catch {
      /* a creator that does not decode has no vault */
    }
  }

  return {
    userVolumeAccumulator: uva,
    accumulatorWsolAta: uvaAta,
    globalVolumeAccumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58(),
    coinCreatorVaultAuthority: auth,
    coinCreatorVaultAta: ata,
    poolV2,
  };
}

export interface OfflinePoolFacts {
  readonly poolKey: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly poolBaseTokenAccount: string;
  readonly poolQuoteTokenAccount: string;
  readonly baseReserve: bigint;
  readonly quoteReserveRaw: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly coinCreator: string;
  readonly creator: string;
  readonly baseTokenProgram: string;
  readonly quoteTokenProgram: string;
  /**
   * F15 — the base mint's total supply, which the fee TIER depends on.
   *
   * `marketCap = quoteReserve × baseMintSupply / baseReserve`. Null when the
   * mint was not in the source: an unread supply must not silently become the
   * canonical one billion, because a token that is not canonical would then be
   * placed in the wrong tier and reported with the wrong floor.
   */
  readonly baseMintSupplyAtoms: bigint | null;
}

export interface OfflinePoolAddresses {
  readonly poolKey: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly poolBaseTokenAccount: string;
  readonly poolQuoteTokenAccount: string;
  readonly coinCreator: string;
  readonly creator: string;
  /** P11 — Mayhem mode, decoded from the pool rather than looked for elsewhere. */
  readonly isMayhemMode: boolean | null;
  readonly isCashbackCoin: boolean | null;
}

/**
 * The addresses a pool names, from the pool account ALONE.
 *
 * Separate from `poolFactsFrom` because there is a chicken and egg: the vaults
 * cannot be fetched until the pool says where they are, and the reserves cannot
 * be read until the vaults are fetched. This is the first half.
 */
export function poolAddressesFrom(src: AccountBytesSource, poolKey: string): OfflinePoolAddresses {
  const sdk = new PumpAmmSdk();
  const raw = src.get(poolKey);
  if (raw === null) throw new OfflineStateIncomplete([poolKey], 'pool account');
  const pool = sdk.decodePool(toAccountInfo(raw)) as unknown as {
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    coinCreator: PublicKey;
    creator: PublicKey;
    isMayhemMode?: boolean;
    isCashbackCoin?: boolean;
  };
  return {
    poolKey,
    baseMint: pool.baseMint.toBase58(),
    quoteMint: pool.quoteMint.toBase58(),
    poolBaseTokenAccount: pool.poolBaseTokenAccount.toBase58(),
    poolQuoteTokenAccount: pool.poolQuoteTokenAccount.toBase58(),
    coinCreator: pool.coinCreator.toBase58(),
    creator: pool.creator.toBase58(),
    // Undefined means this build of the IDL has no such field, which is a
    // different thing from a pool that is not in Mayhem mode.
    isMayhemMode: pool.isMayhemMode ?? null,
    isCashbackCoin: pool.isCashbackCoin ?? null,
  };
}

/** Decode the pool and both vaults from a source, without any network call. */
export function poolFactsFrom(src: AccountBytesSource, poolKey: string): OfflinePoolFacts {
  const sdk = new PumpAmmSdk();
  const poolRaw = src.get(poolKey);
  if (poolRaw === null) throw new OfflineStateIncomplete([poolKey], 'pool account');
  const pool = sdk.decodePool(toAccountInfo(poolRaw)) as unknown as {
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    coinCreator: PublicKey;
    creator: PublicKey;
    virtualQuoteReserves?: BN;
  };

  const baseVault = pool.poolBaseTokenAccount.toBase58();
  const quoteVault = pool.poolQuoteTokenAccount.toBase58();
  const b = src.get(baseVault);
  const q = src.get(quoteVault);
  const missing = [
    ...(b === null ? [`${baseVault} (base vault)`] : []),
    ...(q === null ? [`${quoteVault} (quote vault)`] : []),
  ];
  if (b === null || q === null) throw new OfflineStateIncomplete(missing, 'pool vaults');

  const baseAmount = tokenAmountFromBytes(b.dataBase64);
  const quoteAmount = tokenAmountFromBytes(q.dataBase64);
  if (baseAmount === null || quoteAmount === null) {
    throw new OfflineStateIncomplete([baseVault, quoteVault], 'vault bytes are not token accounts');
  }

  // The supply, for the fee tier. Read where present, null where not: the
  // caller decides whether a missing supply is fatal, and no caller gets a
  // fabricated one.
  let baseMintSupply: bigint | null = null;
  const mintRaw = src.get(pool.baseMint.toBase58());
  if (mintRaw !== null) {
    try {
      const buf = Buffer.from(mintRaw.dataBase64, 'base64');
      // Mint layout: supply is a u64 at offset 36. Same in Token-2022, whose
      // extensions live past the 82-byte base.
      if (buf.length >= 44) baseMintSupply = buf.readBigUInt64LE(36);
    } catch {
      /* bytes that do not decode leave it null, never zero */
    }
  }

  return {
    poolKey,
    baseMint: pool.baseMint.toBase58(),
    quoteMint: pool.quoteMint.toBase58(),
    poolBaseTokenAccount: baseVault,
    poolQuoteTokenAccount: quoteVault,
    baseReserve: baseAmount,
    quoteReserveRaw: quoteAmount,
    virtualQuoteReserves: BigInt((pool.virtualQuoteReserves ?? new BN(0)).toString()),
    coinCreator: pool.coinCreator.toBase58(),
    creator: pool.creator.toBase58(),
    baseTokenProgram: b.owner,
    quoteTokenProgram: q.owner,
    // Null rather than a default. A mint the source does not carry is a fact
    // about the capture, and substituting the canonical supply would put a
    // non-canonical token in the wrong fee tier without saying so.
    baseMintSupplyAtoms: baseMintSupply,
  };
}

/**
 * Assemble the SDK's own swap state object from a source.
 *
 * `feeConfig` is null when the fee-config account is absent, which is the SDK's
 * documented "no dynamic tier" signal — not a substituted static fee.
 */
function swapStateFrom(src: AccountBytesSource, poolKey: string, user: string): Record<string, unknown> {
  const sdk = new PumpAmmSdk();
  const facts = poolFactsFrom(src, poolKey);

  const globalRaw = src.get(GLOBAL_CONFIG_PDA.toBase58());
  if (globalRaw === null) throw new OfflineStateIncomplete([GLOBAL_CONFIG_PDA.toBase58()], 'global config');
  const globalConfig = sdk.decodeGlobalConfig(toAccountInfo(globalRaw));

  const feeRaw = src.get(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  let feeConfig: unknown = null;
  if (feeRaw !== null) {
    try {
      feeConfig = sdk.decodeFeeConfig(toAccountInfo(feeRaw));
    } catch (e) {
      // F11 — present-but-undecodable REFUSES.
      //
      // "no dynamic fee config exists" and "the config exists and this build
      // cannot read it" are opposite facts, and substituting null merges them
      // into the first. The pricing that follows is then computed against the
      // static tier while the chain charges the dynamic one, and the difference
      // is a few basis points that show up as a strategy result.
      throw new FeeConfigUndecodable((e as Error).message);
    }
  }

  const mintRaw = src.get(facts.baseMint);
  if (mintRaw === null) throw new OfflineStateIncomplete([facts.baseMint], 'base mint');

  const userBase = associatedTokenAddressOf(user, facts.baseMint, facts.baseTokenProgram);
  const userQuote = associatedTokenAddressOf(user, facts.quoteMint, facts.quoteTokenProgram);
  const userBaseRaw = src.get(userBase);
  const userQuoteRaw = src.get(userQuote);

  const poolRaw = src.get(poolKey);

  return {
    globalConfig,
    feeConfig,
    poolKey: new PublicKey(poolKey),
    poolAccountInfo: poolRaw === null ? null : toAccountInfo(poolRaw),
    pool: sdk.decodePool(toAccountInfo(poolRaw as AccountBytes)),
    poolBaseAmount: new BN(facts.baseReserve.toString()),
    poolQuoteAmount: new BN(facts.quoteReserveRaw.toString()),
    baseTokenProgram: new PublicKey(facts.baseTokenProgram),
    quoteTokenProgram: new PublicKey(facts.quoteTokenProgram),
    baseMint: new PublicKey(facts.baseMint),
    baseMintAccount: decodeRawMint(Buffer.from(mintRaw.dataBase64, 'base64')),
    user: new PublicKey(user),
    userBaseTokenAccount: new PublicKey(userBase),
    userQuoteTokenAccount: new PublicKey(userQuote),
    userBaseAccountInfo: userBaseRaw === null ? null : toAccountInfo(userBaseRaw),
    userQuoteAccountInfo: userQuoteRaw === null ? null : toAccountInfo(userQuoteRaw),
  };
}

/** ATA derivation, through the SDK's own dependency so it cannot drift from it. */
export function associatedTokenAddressOf(owner: string, mint: string, tokenProgram: string): string {
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROGRAM,
  )[0].toBase58();
}

export interface OfflineSellQuote {
  readonly baseAtomsIn: bigint;
  readonly quoteOutLamports: bigint;
  readonly minQuoteLamports: bigint;
  readonly poolBaseReserve: bigint;
  readonly poolQuoteReserveRaw: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly feeConfigPresent: boolean;
}

/**
 * Price a sell of `baseAtoms` against WHATEVER state the source holds.
 *
 * Called twice by the proof, on two sources that differ only in whether the buy
 * has committed. The gap between the two answers IS the self-impact a
 * fresh-state sell cannot see.
 */
export function quoteSellFrom(
  src: AccountBytesSource,
  poolKey: string,
  baseAtoms: bigint,
  slippagePct: number,
): OfflineSellQuote {
  const sdk = new PumpAmmSdk();
  const facts = poolFactsFrom(src, poolKey);

  const globalRaw = src.get(GLOBAL_CONFIG_PDA.toBase58());
  if (globalRaw === null) throw new OfflineStateIncomplete([GLOBAL_CONFIG_PDA.toBase58()], 'global config');
  const feeRaw = src.get(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  const mintRaw = src.get(facts.baseMint);
  if (mintRaw === null) throw new OfflineStateIncomplete([facts.baseMint], 'base mint');

  let feeConfig: unknown = null;
  if (feeRaw !== null) {
    try {
      feeConfig = sdk.decodeFeeConfig(toAccountInfo(feeRaw));
    } catch (e) {
      // F11 — present-but-undecodable REFUSES.
      //
      // "no dynamic fee config exists" and "the config exists and this build
      // cannot read it" are opposite facts, and substituting null merges them
      // into the first. The pricing that follows is then computed against the
      // static tier while the chain charges the dynamic one, and the difference
      // is a few basis points that show up as a strategy result.
      throw new FeeConfigUndecodable((e as Error).message);
    }
  }

  const res = sellBaseInput({
    base: new BN(baseAtoms.toString()),
    slippage: slippagePct,
    baseReserve: new BN(facts.baseReserve.toString()),
    quoteReserve: new BN(facts.quoteReserveRaw.toString()),
    virtualQuoteReserves: new BN(facts.virtualQuoteReserves.toString()),
    globalConfig: sdk.decodeGlobalConfig(toAccountInfo(globalRaw)),
    baseMintAccount: decodeRawMint(Buffer.from(mintRaw.dataBase64, 'base64')),
    baseMint: new PublicKey(facts.baseMint),
    coinCreator: new PublicKey(facts.coinCreator),
    creator: new PublicKey(facts.creator),
    feeConfig,
  } as never) as unknown as { uiQuote?: BN; minQuote?: BN };

  return {
    baseAtomsIn: baseAtoms,
    quoteOutLamports: BigInt(res.uiQuote?.toString() ?? '0'),
    minQuoteLamports: BigInt(res.minQuote?.toString() ?? '0'),
    poolBaseReserve: facts.baseReserve,
    poolQuoteReserveRaw: facts.quoteReserveRaw,
    virtualQuoteReserves: facts.virtualQuoteReserves,
    feeConfigPresent: feeRaw !== null,
  };
}

/** Price a buy of `quoteLamports` against whatever state the source holds. */
export function quoteBuyFrom(
  src: AccountBytesSource,
  poolKey: string,
  quoteLamports: bigint,
  slippagePct: number,
): { baseOutAtoms: bigint; maxQuoteInLamports: bigint } {
  const sdk = new PumpAmmSdk();
  const facts = poolFactsFrom(src, poolKey);
  const globalRaw = src.get(GLOBAL_CONFIG_PDA.toBase58());
  if (globalRaw === null) throw new OfflineStateIncomplete([GLOBAL_CONFIG_PDA.toBase58()], 'global config');
  const mintRaw = src.get(facts.baseMint);
  if (mintRaw === null) throw new OfflineStateIncomplete([facts.baseMint], 'base mint');
  const feeRaw = src.get(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  let feeConfig: unknown = null;
  if (feeRaw !== null) {
    try {
      feeConfig = sdk.decodeFeeConfig(toAccountInfo(feeRaw));
    } catch (e) {
      // F11 — present-but-undecodable REFUSES.
      //
      // "no dynamic fee config exists" and "the config exists and this build
      // cannot read it" are opposite facts, and substituting null merges them
      // into the first. The pricing that follows is then computed against the
      // static tier while the chain charges the dynamic one, and the difference
      // is a few basis points that show up as a strategy result.
      throw new FeeConfigUndecodable((e as Error).message);
    }
  }

  const res = buyQuoteInput({
    quote: new BN(quoteLamports.toString()),
    slippage: slippagePct,
    baseReserve: new BN(facts.baseReserve.toString()),
    quoteReserve: new BN(facts.quoteReserveRaw.toString()),
    virtualQuoteReserves: new BN(facts.virtualQuoteReserves.toString()),
    globalConfig: sdk.decodeGlobalConfig(toAccountInfo(globalRaw)),
    baseMintAccount: decodeRawMint(Buffer.from(mintRaw.dataBase64, 'base64')),
    baseMint: new PublicKey(facts.baseMint),
    coinCreator: new PublicKey(facts.coinCreator),
    creator: new PublicKey(facts.creator),
    feeConfig,
  } as never) as unknown as { base: BN; maxQuote: BN };

  return {
    baseOutAtoms: BigInt(res.base.toString()),
    maxQuoteInLamports: BigInt(res.maxQuote.toString()),
  };
}

export interface BuiltLeg {
  readonly instructions: readonly TransactionInstruction[];
  readonly accounts: readonly string[];
  readonly quote: OfflineSellQuote;
}

/**
 * Build the SELL instructions against the source's state.
 *
 * The whole point of the module: pass the runtime's post-buy accounts and both
 * the PRICE and the ACCOUNT SET come from the pool the buy moved. Passing
 * mainnet accounts here instead reproduces exactly the linked-leg defect the
 * sequential runtime exists to remove, so the caller's choice of source is the
 * entire experiment.
 */
export async function buildSellFrom(
  src: AccountBytesSource,
  p: { poolKey: string; user: string; baseAtoms: bigint; slippagePct: number },
): Promise<BuiltLeg> {
  const sdk = new PumpAmmSdk();
  const state = swapStateFrom(src, p.poolKey, p.user);
  const quote = quoteSellFrom(src, p.poolKey, p.baseAtoms, p.slippagePct);

  const instructions = await sdk.sellInstructions(
    state as never,
    new BN(p.baseAtoms.toString()),
    new BN(quote.minQuoteLamports.toString()),
  );

  const accounts = new Set<string>();
  for (const ix of instructions) {
    accounts.add(ix.programId.toBase58());
    for (const k of ix.keys) accounts.add(k.pubkey.toBase58());
  }

  return { instructions, accounts: [...accounts], quote };
}

/** Build the BUY instructions against the source's state. Used by the size surface. */
export async function buildBuyFrom(
  src: AccountBytesSource,
  p: { poolKey: string; user: string; quoteLamports: bigint; slippagePct: number },
): Promise<{
  instructions: readonly TransactionInstruction[];
  /** Every account the leg touches. A caller that does not observe these cannot see what it opened. */
  accounts: readonly string[];
  baseOutAtoms: bigint;
  maxQuoteIn: bigint;
}> {
  const sdk = new PumpAmmSdk();
  const state = swapStateFrom(src, p.poolKey, p.user);
  const q = quoteBuyFrom(src, p.poolKey, p.quoteLamports, p.slippagePct);
  const instructions = await sdk.buyInstructions(
    state as never,
    new BN(q.baseOutAtoms.toString()),
    new BN(q.maxQuoteInLamports.toString()),
  );
  const accounts = new Set<string>();
  for (const ix of instructions) {
    accounts.add(ix.programId.toBase58());
    for (const k of ix.keys) accounts.add(k.pubkey.toBase58());
  }
  return { instructions, accounts: [...accounts], baseOutAtoms: q.baseOutAtoms, maxQuoteIn: q.maxQuoteInLamports };
}
