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
 * committed config file.
 *
 * That rule is currently enforced by the ABSENCE of an override path, not by
 * `assertNotLoosened`. `loadConfig` reads the committed file and returns it;
 * nothing merges env or CLI values into `risk`, and nothing calls
 * `assertNotLoosened`. The previous wording here claimed it was enforced at
 * load time, which was not true and would have been believed by whoever added
 * the first override. If an override path is ever added, it must call
 * `assertNotLoosened` in the same change. Registered as O041.
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
  /**
   * Refuse to book a simulated fill unless the quote that priced it carried a
   * structurally buildable transaction.
   *
   * The project's own rule is that a quoted price without a buildable
   * transaction is not executable. Paper mode nevertheless booked 38 fills
   * across 19 positions against quotes where `transaction_buildable = 0` on
   * every one of 2255 rows, because nothing read the flag — the same dead-field
   * class as O028, O031, O037 and O040. Those 19 closed positions therefore
   * establish no executable PnL (P2a.1 audit, docs/P2A1_AUDIT.md).
   *
   * Defaults to true and fails CLOSED. Setting it false does not make a fill
   * executable; it only records that the operator accepted quote-only
   * observations, and such rows must be excluded from any confirmatory result.
   */
  requireBuildableFill: z.boolean(),
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

  /**
   * The one route family a paper fill may be built from.
   *
   * A price from `/order` and a build from `/build` are two different trades.
   * Measured live 2026-08-12 at 0.02 SOL -> USDC: /build returned 1,510,066 and
   * carried no fee fields, /order returned 1,509,732 with feeBps 2. Booking a
   * fill against both describes a trade that existed on neither, so the family
   * is chosen once, here, and every leg of a position uses it.
   *
   * BUILD_CUSTOM is the only PnL-eligible family today: it returns quote and
   * instructions in one response, and it is the only one whose sell leg a local
   * SVM fork could ever validate for a wallet that does not hold the tokens.
   */
  primaryRouteFamily: z.enum(['ORDER_EXECUTE', 'BUILD_CUSTOM', 'DIRECT_VENUE', 'QUOTE_ONLY_BENCHMARK']),

  /**
   * Refuse to book a paper fill without a successful LOCAL simulation.
   *
   * This is currently unsatisfiable and that is the point. A mainnet
   * `simulateTransaction` cannot validate either leg here: the taker holds no
   * SOL, so a buy fails on funding, and it holds none of the hypothetical
   * tokens, so a sell fails on balance. Both failures would be about the wallet
   * rather than the route. The correct instrument is a local SVM fork with
   * captured mainnet accounts and a synthetic balance, and it is not wired.
   *
   * Setting this true therefore stops paper booking fills. That is a true
   * statement about the evidence -- no observation in this system has ever been
   * simulated -- and it is better made every cycle by a refusal than once in a
   * document nobody re-reads.
   */
  requireLocalSimulation: z.boolean(),

  /**
   * Refuse to price an entry from any amount other than the one being entered.
   *
   * The probe quote may screen. It may not price the fill: impact is not linear
   * in size, and scaling a 0.05 SOL threshold down to 0.02 SOL overstates the
   * output in the flattering direction.
   */
  requireExactSizeBuild: z.boolean(),

  /** Tip the chosen broadcaster requires. Zero for an ordinary RPC send. */
  assumedBroadcasterTipLamports: z.coerce.bigint(),
  /**
   * Expected cost of attempts that never land, per round trip. Not optional:
   * a failed transaction still pays its signature and priority fee.
   */
  assumedFailedAttemptLamports: z.coerce.bigint(),
  /** Haircut applied to the expected output for the LATENCY_STRESSED valuation. */
  latencyStressBps: z.number().int().min(0).max(10_000),
  /**
   * Floor on planned loss per trade, as a fraction of notional.
   *
   * A 25% nominal stop is not the loss this population can inflict. Eight
   * measured collapses went from above the 10% floor to near zero inside one
   * mark interval -- faster than the stop could be acted on. Until enough valid
   * observations exist to estimate a severe-loss quantile, sizing assumes the
   * whole principal is at risk.
   */
  catastrophicLossFloorPct: z.number().min(0).max(100),

  /**
   * Frozen notionals for the shadow books.
   *
   * Frozen, and not derived from free capital, because the whole point of a
   * shadow book is to estimate what a signal is worth independently of whether
   * the wallet happened to be able to take it. A shadow position sized from
   * available capital would reintroduce the censoring it exists to remove.
   *
   * `canaryShadow` is deliberately the committed canary entry cap. It answers
   * the question the paper ledger cannot: do results at a comfortable paper
   * size survive at the amount this system is actually permitted to deploy?
   */
  alphaShadowNotionalLamports: z.coerce.bigint(),
  canaryShadowNotionalLamports: z.coerce.bigint(),
  /** Cap on shadow positions worked per cycle, so the rate budget survives. */
  maxShadowMarksPerCycle: z.number().int().min(0).max(50),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export class ConfigError extends Error {}

function configPathForMode(mode: Mode): string {
  return resolve(process.cwd(), 'config', `${mode}.json`);
}

/**
 * Direction in which each risk field is "safer". Used to reject any override
 * that moves a cap in the permissive direction.
 *
 * Both lists are EXPORTED and both are enforced by the same loop. Until P2a.1
 * only the first existed as a list; the one field that is safer when higher was
 * checked by a hand-written `if` at the bottom of `assertNotLoosened`, so
 * "enumerate every field in SAFER_WHEN_HIGHER" had no answer and a second such
 * field would have been added with no mechanism to add it to.
 *
 * `tests/unit/p10-regressions.test.ts` enumerates the risk schema and fails if
 * any numeric field appears in neither list, or in both.
 */
export const SAFER_WHEN_LOWER: readonly (keyof RiskConfig)[] = [
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

/** Fields where a LARGER value is the safer one. */
export const SAFER_WHEN_HIGHER: readonly (keyof RiskConfig)[] = ['minSolReserveLamports'];

/**
 * Canary may never be more permissive than live.
 *
 * A mode with a smaller absolute entry cap is not automatically safer. The
 * committed canary config had a 0.02 SOL entry cap -- reassuringly small -- and
 * simultaneously a 6x looser per-trade risk budget, an 8x looser notional
 * fraction, double the aggregate planned loss, double the daily halt, and half
 * the SOL reserve. Canary is the mode where real money moves for the first
 * time, on the least-tested path, so every dimension of it must be at least as
 * tight as the mode it is a rehearsal for.
 *
 * Throws rather than warns: this is a promotion gate, and a warning printed
 * during promotion is a line of output nobody reads.
 */
export function assertCanaryNoLooserThanLive(canary: RiskConfig, live: RiskConfig): void {
  const offences: string[] = [];
  for (const key of SAFER_WHEN_LOWER) {
    if (scaled(canary[key]) > scaled(live[key])) {
      offences.push(`${key}: canary ${String(canary[key])} > live ${String(live[key])}`);
    }
  }
  for (const key of SAFER_WHEN_HIGHER) {
    if (scaled(canary[key]) < scaled(live[key])) {
      offences.push(`${key}: canary ${String(canary[key])} < live ${String(live[key])}`);
    }
  }
  if (offences.length > 0) {
    throw new ConfigError(
      `canary risk policy is looser than live in ${offences.length} dimension(s): ${offences.join('; ')}. ` +
        'A smaller absolute entry cap does not make a mode safer.',
    );
  }
}

/** Comparable integer for a field that may be a bigint or a fractional number. */
function scaled(v: number | bigint): bigint {
  return typeof v === 'bigint' ? v : BigInt(Math.round(Number(v) * 1e6));
}

export function assertNotLoosened(base: RiskConfig, override: Partial<RiskConfig>): void {
  for (const key of SAFER_WHEN_LOWER) {
    const o = override[key];
    if (o === undefined) continue;
    if (scaled(o) > scaled(base[key])) {
      throw new ConfigError(
        `refusing to loosen risk cap "${key}": committed=${String(base[key])} attempted=${String(o)}. ` +
          `Loosening requires a versioned config change, not a runtime override.`,
      );
    }
  }
  for (const key of SAFER_WHEN_HIGHER) {
    const o = override[key];
    if (o === undefined) continue;
    if (scaled(o) < scaled(base[key])) {
      throw new ConfigError(
        `refusing to lower risk floor "${key}": committed=${String(base[key])} attempted=${String(o)}. ` +
          `Lowering requires a versioned config change, not a runtime override.`,
      );
    }
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
  /**
   * PUBLIC key used as the `taker` for `/swap/v2/build`, so paper mode can
   * establish that a route is structurally buildable.
   *
   * Deliberately not a keypair path. `/swap/v2/order` with a taker refuses to
   * build for an unfunded wallet (errorCode 1, "Insufficient funds", empty
   * transaction), but `/swap/v2/build` returns raw instructions regardless of
   * balance — verified 2026-08-12 against a wallet holding 0 lamports. A public
   * key is therefore sufficient, and no private key exists anywhere in this
   * system for it to leak.
   */
  paperTakerPubkey: string | null;
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

/**
 * The websocket endpoint, derived the same way the HTTP one is.
 *
 * `rpcHttp` fell back to the Helius key and `rpcWs` did not, so an operator
 * with a key configured got HTTP and NO websocket — and every websocket
 * feature then did nothing, silently. The reserve alarm and the direct chain
 * clock were both constructed, both logged an absence at `warn`, and neither
 * connected, because of one missing fallback.
 *
 * The asymmetry is the defect: two transports of the same endpoint, one
 * derived and one not, with nothing to make the difference visible.
 */
export function heliusWsUrl(apiKey: string): string {
  return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

/**
 * The websocket form of whatever HTTP endpoint is actually in use.
 *
 * The asymmetry above was fixed in one direction and left open in the other.
 * With `SOLANA_RPC_HTTP` naming one provider and `HELIUS_API_KEY` still present
 * from an earlier setup, HTTP went to the named provider and the websocket went
 * to Helius — two transports, two providers, and no way to notice.
 *
 * Measured on this machine on 2026-08-16: the Helius-derived socket closed with
 * code 1006 on every attempt while the same-host socket derived from the
 * configured HTTP endpoint subscribed successfully. So the collector's live
 * migration lane silently never covered anything, and reported a coverage gap
 * that read as a chain fact rather than a configuration one.
 *
 * Every mainstream provider serves RPC and websocket on the same host under the
 * `wss:` scheme, path and query included — the API key lives in the query
 * string and is carried over unchanged.
 *
 * Returns null for a URL that will not parse. A malformed endpoint is a
 * configuration error to surface, not a socket to guess at.
 */
export function wsUrlFromHttp(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  } catch {
    return null;
  }
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
    paperTakerPubkey: envOrNull('PAPER_TAKER_PUBKEY'),
    goplusToken: envOrNull('GOPLUS_ACCESS_TOKEN'),
    rpcHttp: explicitRpcHttp ?? (heliusApiKey === null ? null : heliusRpcUrl(heliusApiKey)),
    /**
     * Explicit beats derived here too — and a derived socket follows the
     * endpoint HTTP is actually using, not a second provider's key.
     *
     * The order matters and each step earns its place: an operator who names a
     * socket gets it; an operator who names an HTTP endpoint gets that
     * provider's socket, because two transports pointing at two providers is
     * the defect this whole comment block exists about; and only an operator
     * with nothing but a Helius key falls back to Helius, where HTTP is going
     * anyway.
     */
    rpcWs:
      envOrNull('SOLANA_RPC_WS') ??
      (explicitRpcHttp === null ? null : wsUrlFromHttp(explicitRpcHttp)) ??
      (heliusApiKey === null ? null : heliusWsUrl(heliusApiKey)),
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

export const KILL_PATHS = ['./data/KILL', './KILL'] as const;

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
