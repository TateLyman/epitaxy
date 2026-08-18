import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import BN from 'bn.js';
import type { FeeSplit, FeeTier } from './fee-tiers.js';

/**
 * A VERIFICATION ORACLE. Never the live path.
 *
 * `selectFeeTier` in `fee-tiers.ts` is a replication of the Pump AMM SDK's
 * `calculateFeeTier`, and the audit carried J-4 as OUT OF SCOPE on the grounds
 * that the SDK does not export it. That was half true and the half that was
 * wrong mattered.
 *
 * `@pump-fun/pump-swap-sdk@1.19.0` ships the function in
 * `dist/esm/sdk/fees.js`, which DOES export it — but the package's `exports`
 * map publishes only `"."`, so a bare specifier cannot reach it. Node refuses
 * the subpath, not the module.
 *
 * So the oracle resolves the package's own entry point, walks to the sibling
 * ESM bundle, and imports it by file URL. That is deliberately a thing a test
 * does and a trading path does not:
 *
 *   - it reaches past a package boundary the vendor drew, so it can break on
 *     any patch release without notice, and a live path that breaks on a
 *     `pnpm install` is a defect;
 *   - it exists to DISAGREE with `selectFeeTier`. If the two are ever wired to
 *     the same call site the comparison stops being independent and the check
 *     becomes a tautology.
 *
 * `available()` returns null with a reason rather than throwing, so a version
 * that moves the file downgrades J-4 back to NOT TESTABLE with a message that
 * says which path was tried — instead of failing an unrelated suite.
 */

interface SdkFees {
  readonly lpFeeBps: { toString(): string };
  readonly protocolFeeBps: { toString(): string };
  readonly creatorFeeBps: { toString(): string };
}

interface SdkFeesModule {
  calculateFeeTier(a: { feeTiers: unknown[]; marketCap: BN }): SdkFees;
}

export interface FeeOracle {
  /** The SDK's own answer for this table and market cap, in bps. */
  readonly feesFor: (tiers: readonly FeeTier[], marketCapLamports: bigint) => FeeSplit;
  readonly modulePath: string;
}

let cached: FeeOracle | null | undefined;
let unavailableReason = '';

/**
 * The oracle, or null and a reason. Never throws.
 */
export async function sdkFeeOracle(): Promise<FeeOracle | null> {
  if (cached !== undefined) return cached;
  const req = createRequire(import.meta.url);
  let modulePath = '';
  try {
    const dist = dirname(req.resolve('@pump-fun/pump-swap-sdk'));
    modulePath = join(dist, 'esm', 'sdk', 'fees.js');
    const mod = (await import(pathToFileURL(modulePath).href)) as unknown as SdkFeesModule;
    if (typeof mod.calculateFeeTier !== 'function') {
      unavailableReason = `${modulePath} does not export calculateFeeTier`;
      cached = null;
      return null;
    }
    cached = {
      modulePath,
      feesFor: (tiers, marketCapLamports) => {
        const sdk = mod.calculateFeeTier({
          feeTiers: tiers.map((t) => ({
            marketCapLamportsThreshold: new BN(t.marketCapLamportsThreshold.toString()),
            fees: {
              lpFeeBps: new BN(t.fees.lpFeeBps),
              protocolFeeBps: new BN(t.fees.protocolFeeBps),
              creatorFeeBps: new BN(t.fees.creatorFeeBps),
            },
          })),
          marketCap: new BN(marketCapLamports.toString()),
        });
        const lp = Number(sdk.lpFeeBps.toString());
        const protocol = Number(sdk.protocolFeeBps.toString());
        const creator = Number(sdk.creatorFeeBps.toString());
        return { lpFeeBps: lp, protocolFeeBps: protocol, creatorFeeBps: creator, totalBps: lp + protocol + creator };
      },
    };
    return cached;
  } catch (e) {
    unavailableReason = `${modulePath === '' ? '@pump-fun/pump-swap-sdk' : modulePath}: ${(e as Error).message}`;
    cached = null;
    return null;
  }
}

export function sdkFeeOracleUnavailableReason(): string {
  return unavailableReason;
}
