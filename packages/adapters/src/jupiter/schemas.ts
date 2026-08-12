import { z } from 'zod';

/**
 * Runtime schemas for the Jupiter API.
 *
 * Verified live 2026-08-11 against https://api.jup.ag.
 * Source: https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml
 *
 * Policy: unknown EXTRA fields are tolerated (providers add fields routinely),
 * but a missing or retyped field we depend on must fail closed.
 */

export const SCHEMA_VERSION = 'jup-2026-08-11';
export const PARSER_VERSION = '1';

/** u64 values arrive as decimal strings. Never parse these as JS numbers. */
const U64String = z.string().regex(/^\d+$/, 'expected unsigned integer string');

export const SwapInfoSchema = z
  .object({
    ammKey: z.string(),
    label: z.string().optional(),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: U64String,
    outAmount: U64String,
    feeAmount: U64String.optional(),
    feeMint: z.string().optional(),
  })
  .passthrough();

export const RoutePlanStepSchema = z
  .object({
    swapInfo: SwapInfoSchema,
    percent: z.number().optional(),
    bps: z.number().optional(),
    usdValue: z.number().optional(),
  })
  .passthrough();

export const PlatformFeeSchema = z
  .object({
    amount: U64String.optional(),
    feeBps: z.number(),
    feeMint: z.string().optional(),
  })
  .passthrough();

/**
 * GET /swap/v2/order
 *
 * Notes from live verification:
 *  - `transaction` is null when no `taker` was supplied (quote-only mode) and
 *    "" when the build failed; `errorCode`/`errorMessage` carry the reason.
 *  - `priceImpactPct` and `swapType` are marked deprecated upstream; we read
 *    `priceImpact` and `router` and treat the old fields as fallback only.
 */
export const OrderResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: U64String,
    outAmount: U64String,
    otherAmountThreshold: U64String,
    swapMode: z.string(),
    slippageBps: z.number(),
    routePlan: z.array(RoutePlanStepSchema),

    // Fees. feeBps is the TOTAL; platformFee.feeBps is Jupiter's own cut.
    feeBps: z.number().optional(),
    feeMint: z.string().optional(),
    platformFee: PlatformFeeSchema.nullish(),
    signatureFeeLamports: z.number().optional(),
    prioritizationFeeLamports: z.number().optional(),
    rentFeeLamports: z.number().optional(),

    // Impact: prefer `priceImpact`, fall back to deprecated `priceImpactPct`.
    priceImpact: z.number().optional(),
    priceImpactPct: z.union([z.string(), z.number()]).optional(),

    router: z.string().optional(),
    swapType: z.string().optional(),
    mode: z.string().optional(),

    transaction: z.string().nullish(),
    requestId: z.string().optional(),
    quoteId: z.string().optional(),
    lastValidBlockHeight: z.number().nullish(),
    expireAt: z.union([z.string(), z.number()]).nullish(),
    taker: z.string().nullish(),
    gasless: z.boolean().optional(),

    contextSlot: z.number().nullish(),
    inUsdValue: z.number().optional(),
    outUsdValue: z.number().optional(),
    swapUsdValue: z.number().optional(),
    totalTime: z.number().optional(),

    errorCode: z.number().nullish(),
    errorMessage: z.string().nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

/** POST /swap/v2/execute */
export const ExecuteResponseSchema = z
  .object({
    status: z.string(),
    signature: z.string().nullish(),
    slot: z.union([z.number(), z.string()]).nullish(),
    code: z.number().nullish(),
    error: z.string().nullish(),
    totalInputAmount: U64String.nullish(),
    totalOutputAmount: U64String.nullish(),
    inputAmountResult: U64String.nullish(),
    outputAmountResult: U64String.nullish(),
    swapEvents: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>;

const StatsWindowSchema = z
  .object({
    priceChange: z.number().nullish(),
    holderChange: z.number().nullish(),
    liquidityChange: z.number().nullish(),
    volumeChange: z.number().nullish(),
    buyVolume: z.number().nullish(),
    sellVolume: z.number().nullish(),
    numBuys: z.number().nullish(),
    numSells: z.number().nullish(),
    numTraders: z.number().nullish(),
    numNetBuyers: z.number().nullish(),
  })
  .passthrough();

export const AuditSchema = z
  .object({
    mintAuthorityDisabled: z.boolean().nullish(),
    freezeAuthorityDisabled: z.boolean().nullish(),
    topHoldersPercentage: z.number().nullish(),
    devBalancePercentage: z.number().nullish(),
    devMints: z.number().nullish(),
    isSus: z.boolean().nullish(),
  })
  .passthrough();

/** GET /tokens/v2/{recent,toporganicscore/{interval},search} */
export const MintInformationSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    symbol: z.string().nullish(),
    icon: z.string().nullish(),
    decimals: z.number(),
    tokenProgram: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    dev: z.string().nullish(),
    launchpad: z.string().nullish(),
    circSupply: z.number().nullish(),
    totalSupply: z.number().nullish(),
    holderCount: z.number().nullish(),
    firstPool: z
      .object({ id: z.string().nullish(), createdAt: z.string().nullish() })
      .passthrough()
      .nullish(),
    audit: AuditSchema.nullish(),
    organicScore: z.number().nullish(),
    organicScoreLabel: z.string().nullish(),
    isVerified: z.boolean().nullish(),
    tags: z.array(z.string()).nullish(),
    fdv: z.number().nullish(),
    mcap: z.number().nullish(),
    usdPrice: z.number().nullish(),
    priceBlockId: z.number().nullish(),
    liquidity: z.number().nullish(),
    stats5m: StatsWindowSchema.nullish(),
    stats1h: StatsWindowSchema.nullish(),
    stats6h: StatsWindowSchema.nullish(),
    stats24h: StatsWindowSchema.nullish(),
  })
  .passthrough();

export type MintInformation = z.infer<typeof MintInformationSchema>;

export const MintListSchema = z.array(MintInformationSchema);

/** GET /price/v3?ids=... — max 50 ids per request. */
export const PriceV3Schema = z.record(
  z.string(),
  z
    .object({
      usdPrice: z.number(),
      blockId: z.number().nullish(),
      decimals: z.number().nullish(),
      priceChange24h: z.number().nullish(),
      liquidity: z.number().nullish(),
      createdAt: z.string().nullish(),
    })
    .passthrough(),
);

/**
 * GET /swap/v2/build
 *
 * Raw, policy-inspectable instructions rather than a serialized transaction.
 *
 * Verified live 2026-08-12: this endpoint requires a `taker` but does NOT
 * require that taker to hold the funds. A wallet with 0 lamports gets a full
 * instruction set back, where `/swap/v2/order` with the same taker returns
 * errorCode 1 "Insufficient funds" and an empty `transaction`. That difference
 * is the whole reason paper mode can establish structural buildability at all.
 *
 * Structural buildability is NOT the same as a successful mainnet simulation,
 * and this schema is never treated as one. It answers: could a transaction have
 * been constructed for this exact route at this exact size?
 */
export const BuildInstructionSchema = z
  .object({
    programId: z.string(),
    accounts: z
      .array(z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }).passthrough())
      .optional(),
    data: z.string().optional(),
  })
  .passthrough();

export const BuildResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: U64String,
    outAmount: U64String,
    // Verified live 2026-08-12: /build carries its own economics. Top-level key
    // set for 0.02 SOL -> USDC was addressesByLookupTableAddress,
    // blockhashWithMetadata, cleanupInstruction, computeBudgetInstructions,
    // inAmount, inputMint, otherAmountThreshold, otherInstructions, outAmount,
    // outputMint, priceImpactPct, routePlan, setupInstructions, slippageBps,
    // swapInstruction, swapMode, tipInstruction.
    //
    // Notably ABSENT: feeBps, feeMint, platformFee, signatureFeeLamports,
    // prioritizationFeeLamports, rentFeeLamports, router, requestId,
    // contextSlot, expireAt, priceImpact. That absence is the point -- this is
    // a Metis-only route with no default Jupiter swap fee, and it is why an
    // /order price cannot be attached to a /build instruction set.
    otherAmountThreshold: U64String.optional(),
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    priceImpactPct: z.union([z.string(), z.number()]).optional(),
    routePlan: z.array(RoutePlanStepSchema).optional(),
    swapInstruction: BuildInstructionSchema.nullish(),
    setupInstructions: z.array(BuildInstructionSchema).optional(),
    cleanupInstruction: BuildInstructionSchema.nullish(),
    computeBudgetInstructions: z.array(BuildInstructionSchema).optional(),
    otherInstructions: z.array(BuildInstructionSchema).optional(),
    tipInstruction: BuildInstructionSchema.nullish(),
    addressesByLookupTableAddress: z.record(z.unknown()).nullish(),
    // Shape verified live 2026-08-12: { blockhash: number[] | string,
    // lastValidBlockHeight: number, fetchedAt: {...} }. Only the field we act
    // on is typed; the rest passes through so a provider addition is not a
    // schema failure.
    blockhashWithMetadata: z
      .object({
        blockhash: z.union([z.string(), z.array(z.number())]).nullish(),
        lastValidBlockHeight: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
    contextSlot: z.number().nullish(),
    expireAt: z.union([z.string(), z.number()]).nullish(),
    lastValidBlockHeight: z.number().nullish(),
    requestId: z.string().nullish(),
    router: z.string().nullish(),
    errorCode: z.number().nullish(),
    errorMessage: z.string().nullish(),
  })
  .passthrough();
export type BuildResponse = z.infer<typeof BuildResponseSchema>;
