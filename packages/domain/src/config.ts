import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mode } from './types.js';
import { MODES } from './types.js';
import { loadDotEnvOnce } from './dotenv.js';

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

export const ExitConfigSchema = z.object({
  /** Loss from cost at which the position is closed unconditionally. */
  stopLossBps: z.number().int().min(1).max(10_000),
  /** Give-back from the peak mark that closes a winning position. */
  trailingStopBps: z.number().int().min(1).max(10_000),
  takeProfitBps: z.number().int().min(1),
  /** Positions are not held indefinitely; the thesis has a shelf life. */
  maxHoldMs: z.number().int().min(1000),
  /** Churn guard so a single noisy mark cannot round-trip us through fees. */
  minHoldMs: z.number().int().min(0),
  /**
   * Executable exit value, in bps of entry cost, at or below which the
   * position is treated as a liquidity collapse and closed immediately.
   *
   * This replaced `maxExitImpactBps`, which fired on
   * `Math.abs(priceImpactPct)`. Two things were wrong with that knob and only
   * one of them was the `Math.abs`: Jupiter does not document the sign
   * convention of that field at all (checked 2026-08-12, docs/RESEARCH.md), so
   * no threshold over it could be given a stable meaning. It is not kept as an
   * unused field, because a config knob read by nothing is the same defect as
   * O028 and O031.
   *
   * Stated against executable output, which needs no vendor convention.
   */
  liquidityCollapseRatioBps: z.number().int().min(1).max(10_000),
});
export type ExitConfig = z.infer<typeof ExitConfigSchema>;

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
  exits: ExitConfigSchema,
  /** Starting NAV for simulated modes. Ignored by canary and live. */
  paperStartLamports: z.coerce.bigint(),
  /** Discovery cadence, bounded by the source rate budget. */
  discoveryIntervalMs: z.number().int().min(1000),
  /**
   * Cadence at which an OPEN position is re-quoted and a `position_marks` row
   * is written. Separate from `discoveryIntervalMs` because the two have
   * opposite economics: discovery is expensive, rate-limited and slow-moving,
   * while marking an open position is a single quote and is the only thing
   * standing between us and knowing what happened to the money.
   *
   * Before this field existed the two shared one interval, so the mark cadence
   * was whatever discovery happened to be — ~31s in the measured corpus. All
   * four liquidity collapses did their entire damage inside a single interval,
   * which means the corpus cannot distinguish a one-block rug from a
   * 25-second drain. That is a property of the instrument, not of the market,
   * and it is what this field exists to fix.
   *
   * Floor of 1s rather than lower: below that the quote is older than the
   * interval and the extra requests buy nothing but rate-limit pressure.
   */
  markIntervalMs: z.number().int().min(1000),
  enrichIntervalMs: z.number().int().min(1000),
  /** Max clock skew before trading is refused. */
  maxClockSkewMs: z.number().int().min(0),
  /** A quote older than this may not be used for a decision. */
  maxQuoteAgeMs: z.number().int().min(0),
  /** Cost model. Modelled conservatively; see docs/RESEARCH.md for measurement. */
  assumedNewTokenFeeBps: z.number().int().min(0).max(10_000),
  assumedPriorityFeeLamports: z.coerce.bigint(),
  assumedAtaRentLamports: z.coerce.bigint(),
  /** Per-signature base fee. Charged on entry and again on exit. */
  assumedSignatureFeeLamports: z.coerce.bigint(),
  /**
   * Share of ATA rent expected back. Rent is refunded only when the token
   * account is closed, which requires a zero balance — impossible while holding
   * an unsellable token. In this population that is a common outcome, so this
   * is well below 1 and is an assumption to be measured, not a constant.
   */
  assumedRentRecoveryRate: z.number().min(0).max(1),
  /**
   * Largest share of notional that non-recoverable round-trip cost may consume
   * before a trade is refused as unable to clear its own overhead.
   */
  maxFeeFractionBps: z.number().int().min(1).max(10_000),
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

/**
 * The mode requested on the command line, if any.
 *
 * Entry points take the mode from an argument rather than only from MODE
 * because `MODE=paper pnpm paper` is not portable: an inline assignment in a
 * package.json script does nothing under cmd.exe, so the script silently ran as
 * observe and the entry point refused to start.
 */
export function modeFromArgv(argv: readonly string[] = process.argv): string | undefined {
  const arg = argv.find((a) => a.startsWith('--mode='));
  return arg?.slice('--mode='.length);
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
  /**
   * True when `rpcHttp` was built from `HELIUS_API_KEY` rather than read from
   * `SOLANA_RPC_HTTP`. Doctor and the deployment gates report the difference:
   * an operator who believes they set an endpoint and did not is a different
   * situation from one running on a derived default.
   */
  rpcHttpDerivedFromHeliusKey: boolean;
  tradingKeypairPath: string | null;
  liveAckPath: string | null;
  databasePath: string;
  dataDir: string;
}

function envOrNull(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

/**
 * Helius authenticates by query parameter, not by header, so the key becomes
 * part of the URL. That URL must never be written to a file or a log: it is
 * built here, held in memory, and redacted on the way out by the `api-key=`
 * rule in `packages/observability/src/log.ts`. `scripts/secretscan.ts` has a
 * matching rule (`helius_url_with_key`) that fails the build if the assembled
 * form ever lands in the tree.
 *
 * Endpoint form per docs/SOURCE_MATRIX.csv (helius, mainnet rpc).
 */
export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

export function loadSecrets(): Secrets {
  // `.env` is loaded here rather than at process start so that every entry
  // point gets it without having to remember to. Idempotent, and ambient
  // variables always win — see packages/domain/src/dotenv.ts (O031).
  loadDotEnvOnce();
  const heliusApiKey = envOrNull('HELIUS_API_KEY');
  const explicitRpcHttp = envOrNull('SOLANA_RPC_HTTP');
  // Explicit beats derived, always. An operator who names an endpoint gets that
  // endpoint even when a Helius key is also present, because silently
  // preferring the key would make the configured value a lie.
  const derived = explicitRpcHttp === null && heliusApiKey !== null;
  return {
    heliusApiKey,
    jupiterApiKey: envOrNull('JUPITER_API_KEY'),
    goplusToken: envOrNull('GOPLUS_ACCESS_TOKEN'),
    rpcHttp: explicitRpcHttp ?? (heliusApiKey === null ? null : heliusRpcUrl(heliusApiKey)),
    rpcWs: envOrNull('SOLANA_RPC_WS'),
    rpcHttpFallback: envOrNull('SOLANA_RPC_HTTP_FALLBACK'),
    rpcHttpDerivedFromHeliusKey: derived,
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

const KILL_PATHS = ['./data/KILL', './KILL'] as const;

/**
 * The kill switch, as a file rather than a signal or an API call.
 *
 * A file works when the process is wedged, when the operator is on a different
 * machine with a synced directory, and when whatever would have served an HTTP
 * endpoint is the thing that broke. It needs no running code to arm.
 *
 * It must be read on every cycle, not once at startup. A switch that is only
 * consulted before the process begins cannot stop the process, which is the
 * only situation anyone reaches for it in.
 *
 * Returns the path that engaged it, so the operator is told which of the two
 * files to remove.
 */
export function killSwitchEngaged(): string | null {
  for (const p of KILL_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}
