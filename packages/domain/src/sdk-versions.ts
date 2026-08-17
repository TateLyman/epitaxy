import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/**
 * The version ACTUALLY installed, read from the package's own manifest.
 *
 * `require('<pkg>/package.json')` is the obvious way and it does not work: both
 * Pump packages publish an `exports` map that does not include `./package.json`,
 * so the subpath is not resolvable and this returned `'unknown'` for BOTH — on a
 * tree where 1.36.0 and 1.19.0 were correctly installed.
 *
 * That is not a cosmetic miss. The capability fingerprint COMMITS to these
 * versions, so every fingerprint computed before this fix recorded
 * `{"@pump-fun/pump-sdk":"unknown","@pump-fun/pump-swap-sdk":"unknown"}` — a
 * fingerprint that cannot distinguish two builds is the one thing a fingerprint
 * exists to do, and `assertPinnedVersions` could never have fired either.
 *
 * So: resolve the package ENTRY POINT, which `exports` does publish, and walk up
 * to the directory holding its manifest. Returns `'unknown'` only when it
 * genuinely cannot be read, and `pinnedVersionDrift` treats that as drift.
 */
function installedVersion(pkg: string): string {
  let dir: string;
  try {
    dir = dirname(require.resolve(pkg));
  } catch {
    return 'unknown';
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
        // Walk past a nested manifest that belongs to a different package.
        if (manifest.name === pkg && typeof manifest.version === 'string') return manifest.version;
      } catch {
        /* an unreadable manifest is not this package's manifest */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'unknown';
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
