import { createRequire } from 'node:module';

/**
 * P6.3 — the Pump SDK versions this process is ACTUALLY running.
 *
 * Read from the installed packages, not written down. The capability
 * fingerprint commits to these, and a fingerprint that claims a version the
 * process is not running is worse than no fingerprint at all: it makes two
 * different builds look identical, which is precisely the property the
 * fingerprint exists to deny.
 *
 * The directive pins:
 *
 *     @pump-fun/pump-sdk        1.36.0
 *     @pump-fun/pump-swap-sdk   1.19.0
 *
 * `assertPinnedVersions` refuses when what is installed is not what is pinned,
 * so a lockfile drift is a loud failure rather than a fingerprint that silently
 * describes a different venue model.
 */

const require = createRequire(import.meta.url);

function installedVersion(pkg: string): string {
  try {
    const manifest = require(`${pkg}/package.json`) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const version = installedVersion('@pump-fun/pump-sdk');
export const swapVersion = installedVersion('@pump-fun/pump-swap-sdk');

/** What the 5d24e39 directive pins. */
export const PINNED_PUMP_SDK = '1.36.0';
export const PINNED_PUMP_SWAP_SDK = '1.19.0';
/** The pump-public-docs commit the account plans and fee model were read against. */
export const PINNED_PUMP_DOCS_COMMIT = '9c82f61cb711b044a17f770ab8ce9f9bdf78f333';

export class SdkVersionDrift extends Error {
  constructor(readonly drifts: readonly string[]) {
    super(
      `the installed Pump SDKs are not the pinned ones: ${drifts.join('; ')}. ` +
        'The capability fingerprint commits to these versions, and the account plan, the fee tier table and ' +
        'the cashback remaining-account order are all properties of a specific SDK build.',
    );
    this.name = 'SdkVersionDrift';
  }
}

export function pinnedVersionDrift(): string[] {
  const drifts: string[] = [];
  if (version !== PINNED_PUMP_SDK) drifts.push(`@pump-fun/pump-sdk ${version} != pinned ${PINNED_PUMP_SDK}`);
  if (swapVersion !== PINNED_PUMP_SWAP_SDK) {
    drifts.push(`@pump-fun/pump-swap-sdk ${swapVersion} != pinned ${PINNED_PUMP_SWAP_SDK}`);
  }
  return drifts;
}

export function assertPinnedVersions(): void {
  const drifts = pinnedVersionDrift();
  if (drifts.length > 0) throw new SdkVersionDrift(drifts);
}
