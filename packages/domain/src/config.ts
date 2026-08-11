import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mode } from './types.js';
import { MODES } from './types.js';

/**
 * Typed, validated configuration.
 *
 * Design rule: caps may be TIGHTENED by env/CLI but never LOOSENED beyond the
 * committed config file. `assertNotLoosened` enforces that at load time, so a
 * stray environment variable cannot quietly raise risk limits.
 */

export const RiskConfigSchema = z.object({
  riskBudgetPctPerTrade: z.number().min(0).max(5),
  maxNotionalPctPerPosition: z.number().min(0).max(10),
  maxSimultaneousPositions: z.number().int().min(0).max(20),
  maxAggregatePlannedLossPct: z.number().min(0).max(10),
  dailyLossHaltPct: z.number().min(0).max(20),
  weeklyLossHaltPct: z.number().min(0).max(40),
  drawdownHaltPct: z.number().min(0).max(50),
  minSolReserveLamports: z.coerce.bigint(),
  maxEntryLamports: z.coerce.bigint(),
  maxTotalExposureLamports: z.coerce.bigint(),
  dailyLossCapLamports: z.coerce.bigint(),
  maxPriorityFeeLamports: z.coerce.bigint(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const GateConfigSchema = z.object({
  /** Minimum time after first pool creation before a token may be considered. */
  minTokenAgeMs: z.number().int().min(0),
  maxTokenAgeMs: z.number().int().min(0),
  minLiquidityUsd: z.number().min(0),
  minHolderCount: z.number().int().min(0),
  /** Hard cap on a single entity's share of supply, after clustering. */
  maxTopHolderPct: z.number().min(0).max(100),
  maxDevBalancePct: z.number().min(0).max(100),
  maxPriceImpactBps: z.number().int().min(0).max(10_000),
  /** A round trip costing more than this can never be profitable often enough. */
  maxRoundTripLossBps: z.number().int().min(0).max(10_000),
  minOrganicScore: z.number().min(0).max(100),
  maxSourceAgeMs: z.number().int().min(0),
  requireMintAuthorityDisabled: z.boolean(),
  requireFreezeAuthorityDisabled: z.boolean(),
  allowedTokenPrograms: z.array(z.string()).min(1),
  minBuyCount5m: z.number().int().min(0),
  minNetBuyers5m: z.number().int().min(0),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

export const SourceLimitSchema = z.object({
  name: z.string(),
  requestsPerSecond: z.number().min(0),
  burst: z.number().int().min(1),
  /** Separate buckets are modelled independently, matching provider docs. */
  bucket: z.string(),
});

export const AppConfigSchema = z.object({
  mode: z.enum(MODES as unknown as [Mode, ...Mode[]]),
  strategyVersion: z.string(),
  risk: RiskConfigSchema,
  gates: GateConfigSchema,
  /** Discovery cadence, bounded by the source rate budget. */
  discoveryIntervalMs: z.number().int().min(1000),
  enrichIntervalMs: z.number().int().min(1000),
  /** Max clock skew before trading is refused. */
  maxClockSkewMs: z.number().int().min(0),
  /** A quote older than this may not be used for a decision. */
  maxQuoteAgeMs: z.number().int().min(0),
  /** Cost model. Modelled conservatively; see docs/RESEARCH.md for measurement. */
  assumedNewTokenFeeBps: z.number().int().min(0).max(10_000),
  assumedPriorityFeeLamports: z.coerce.bigint(),
  assumedAtaRentLamports: z.coerce.bigint(),
  /** Notional used to measure round-trip cost. Never signed, quote-only. */
  quoteProbeLamports: z.coerce.bigint(),
  /** Upper bound on round-trip quotes per discovery cycle (rate budget). */
  maxQuotesPerCycle: z.number().int().min(0).max(60),
  /** Minimum opportunity score for a candidate to be considered eligible. */
  minOpportunityScore: z.number().min(0).max(1),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export class ConfigError extends Error {}

function configPathForMode(mode: Mode): string {
  return resolve(process.cwd(), 'config', `${mode}.json`);
}

/**
 * Direction in which each risk field is "safer". Used to reject any override
 * that moves a cap in the permissive direction.
 */
const SAFER_WHEN_LOWER: readonly (keyof RiskConfig)[] = [
  'riskBudgetPctPerTrade',
  'maxNotionalPctPerPosition',
  'maxSimultaneousPositions',
  'maxAggregatePlannedLossPct',
  'dailyLossHaltPct',
  'weeklyLossHaltPct',
  'drawdownHaltPct',
  'maxEntryLamports',
  'maxTotalExposureLamports',
  'dailyLossCapLamports',
  'maxPriorityFeeLamports',
  'maxSlippageBps',
];

export function assertNotLoosened(base: RiskConfig, override: Partial<RiskConfig>): void {
  for (const key of SAFER_WHEN_LOWER) {
    const o = override[key];
    if (o === undefined) continue;
    const b = base[key];
    const oNum = typeof o === 'bigint' ? o : BigInt(Math.round(Number(o) * 1e6));
    const bNum = typeof b === 'bigint' ? b : BigInt(Math.round(Number(b) * 1e6));
    if (oNum > bNum) {
      throw new ConfigError(
        `refusing to loosen risk cap "${key}": committed=${String(b)} attempted=${String(o)}. ` +
          `Loosening requires a versioned config change, not a runtime override.`,
      );
    }
  }
  // minSolReserveLamports is safer when HIGHER — inverted check.
  if (override.minSolReserveLamports !== undefined && override.minSolReserveLamports < base.minSolReserveLamports) {
    throw new ConfigError('refusing to lower minSolReserveLamports at runtime');
  }
}

export function loadConfig(modeInput?: string): AppConfig {
  const rawMode = modeInput ?? process.env['MODE'] ?? 'observe';
  const parsedMode = z.enum(MODES as unknown as [Mode, ...Mode[]]).safeParse(rawMode);
  if (!parsedMode.success) {
    throw new ConfigError(`invalid MODE "${String(rawMode).slice(0, 24)}". Expected one of: ${MODES.join(', ')}`);
  }
  const mode = parsedMode.data;
  const path = configPathForMode(mode);
  if (!existsSync(path)) {
    // Fail CLOSED: a missing config must never fall back to a permissive mode.
    throw new ConfigError(`config file missing for mode "${mode}": ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config file for mode "${mode}" is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = AppConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`config validation failed for mode "${mode}":\n${parsed.error.toString()}`);
  }
  if (parsed.data.mode !== mode) {
    throw new ConfigError(`config file ${path} declares mode "${parsed.data.mode}" but was loaded as "${mode}"`);
  }
  return parsed.data;
}

export interface Secrets {
  heliusApiKey: string | null;
  jupiterApiKey: string | null;
  goplusToken: string | null;
  rpcHttp: string | null;
  rpcWs: string | null;
  rpcHttpFallback: string | null;
  tradingKeypairPath: string | null;
  liveAckPath: string | null;
  databasePath: string;
  dataDir: string;
}

function envOrNull(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

export function loadSecrets(): Secrets {
  return {
    heliusApiKey: envOrNull('HELIUS_API_KEY'),
    jupiterApiKey: envOrNull('JUPITER_API_KEY'),
    goplusToken: envOrNull('GOPLUS_ACCESS_TOKEN'),
    rpcHttp: envOrNull('SOLANA_RPC_HTTP'),
    rpcWs: envOrNull('SOLANA_RPC_WS'),
    rpcHttpFallback: envOrNull('SOLANA_RPC_HTTP_FALLBACK'),
    tradingKeypairPath: envOrNull('TRADING_KEYPAIR_PATH'),
    liveAckPath: envOrNull('LIVE_ACK_PATH'),
    databasePath: envOrNull('DATABASE_PATH') ?? './data/runtime.db',
    dataDir: envOrNull('DATA_DIR') ?? './data',
  };
}

/** Observe and paper must never be able to construct a signer. */
export function assertSignerNotAllowed(mode: Mode): void {
  if (mode !== 'canary' && mode !== 'live') return;
  throw new ConfigError(`internal error: signer guard called in mode ${mode}`);
}

export function signerAllowed(mode: Mode): boolean {
  return mode === 'canary' || mode === 'live';
}
