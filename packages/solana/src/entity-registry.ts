import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Which programs are VERIFIED to hold inventory on behalf of a market.
 *
 * §7.2. Holder concentration excluded any account whose owner was not the
 * System Program, on the reasoning that a pool authority is a PDA and a wallet
 * is not. Two things are wrong with that:
 *
 *   1. An UNRESOLVED owner — an account the RPC did not return — was classified
 *      program-controlled and therefore excluded from the wallet figures. A
 *      large holder we failed to look up made concentration look BETTER. The
 *      comment beside it claimed the opposite.
 *   2. A creator-controlled PDA is program-owned and is not a market. Anyone
 *      can deploy a program and park supply behind it; "not the System Program"
 *      is a statement about account layout, not about who can sell.
 *
 * So ownership is three-way, and only the middle case is excluded:
 *
 *   WALLET                       System-Program-owned. Can sell into our exit.
 *   VERIFIED_PROGRAM_CONTROLLED  owned by a program in this registry, whose
 *                                pool/vault/escrow semantics are understood.
 *   UNKNOWN                      anything else, INCLUDING an unresolved owner.
 *                                Counted as wallet concentration, because an
 *                                unknown holder that might sell is the case we
 *                                cannot afford to treat as inert.
 *
 * The registry is versioned and read from `config/programs.mainnet.json`, the
 * same file the transaction policy allowlist is derived from, so a program
 * cannot be trusted here without being a reviewed, committed change.
 */

export const HOLDER_CLASSES = ['WALLET', 'VERIFIED_PROGRAM_CONTROLLED', 'UNKNOWN'] as const;
export type HolderClass = (typeof HOLDER_CLASSES)[number];

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const ProgramsFileSchema = z
  .object({
    _meta: z.record(z.unknown()).optional(),
    token: z.record(z.string()).optional(),
    amm: z.record(z.string()).optional(),
    launchpad: z.record(z.string()).optional(),
    system: z.record(z.string()).optional(),
    known_traps: z.record(z.string()).optional(),
  })
  .passthrough();

export interface EntityRegistry {
  readonly version: string;
  /** program id -> human label, for programs that legitimately hold inventory. */
  readonly marketPrograms: ReadonlyMap<string, string>;
  /** program ids that must NEVER be treated as safe inventory. */
  readonly traps: ReadonlySet<string>;
}

let cached: EntityRegistry | null = null;

/**
 * Load the registry.
 *
 * `amm` and `launchpad` hold inventory as part of being a market: a bonding
 * curve holding 90% of supply IS the market we trade against. `known_traps` is
 * carried through as an explicit deny — a devnet clone or a fee program parked
 * in the same file must not be read as a market by a fuzzy match.
 */
export function loadEntityRegistry(path = resolve(process.cwd(), 'config', 'programs.mainnet.json')): EntityRegistry {
  if (cached !== null) return cached;
  const parsed = ProgramsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

  const market = new Map<string, string>();
  for (const [label, id] of Object.entries(parsed.amm ?? {})) market.set(id, `amm:${label}`);
  for (const [label, id] of Object.entries(parsed.launchpad ?? {})) market.set(id, `launchpad:${label}`);

  const traps = new Set<string>(Object.values(parsed.known_traps ?? {}));
  for (const t of traps) market.delete(t);

  const meta = parsed._meta as Record<string, unknown> | undefined;
  cached = {
    version: typeof meta?.['checked_at_utc'] === 'string' ? (meta['checked_at_utc'] as string) : 'unknown',
    marketPrograms: market,
    traps,
  };
  return cached;
}

/** Tests only: forget the cached registry. */
export function resetEntityRegistry(): void {
  cached = null;
}

export interface OwnerFacts {
  /** The wallet or PDA that owns the token account. Null when unresolved. */
  readonly owner: string | null;
  /** Program that owns the OWNER account. Null when unresolved. */
  readonly ownerProgram: string | null;
}

export interface HolderClassification {
  readonly holderClass: HolderClass;
  readonly detail: string;
  /** True only for VERIFIED_PROGRAM_CONTROLLED. */
  readonly excludedFromWalletConcentration: boolean;
}

/**
 * Classify one holder.
 *
 * Fails toward `UNKNOWN`, and `UNKNOWN` counts as wallet concentration. That is
 * the conservative direction: an unknown holder that might sell is worse to
 * ignore than a market maker that will not.
 */
export function classifyHolder(facts: OwnerFacts, registry: EntityRegistry): HolderClassification {
  if (facts.owner === null || facts.ownerProgram === null) {
    return {
      holderClass: 'UNKNOWN',
      detail: 'owner account could not be resolved; counted as wallet concentration',
      excludedFromWalletConcentration: false,
    };
  }
  if (facts.ownerProgram === SYSTEM_PROGRAM_ID) {
    return {
      holderClass: 'WALLET',
      detail: 'System-Program-owned account; an independent wallet',
      excludedFromWalletConcentration: false,
    };
  }
  if (registry.traps.has(facts.ownerProgram)) {
    return {
      holderClass: 'UNKNOWN',
      detail: `owner program ${facts.ownerProgram} is on the known-trap list`,
      excludedFromWalletConcentration: false,
    };
  }
  const label = registry.marketPrograms.get(facts.ownerProgram);
  if (label !== undefined) {
    return {
      holderClass: 'VERIFIED_PROGRAM_CONTROLLED',
      detail: `owned by ${label}; pool or curve inventory, not a seller`,
      excludedFromWalletConcentration: true,
    };
  }
  return {
    holderClass: 'UNKNOWN',
    detail:
      `owner program ${facts.ownerProgram} is not a verified market program. A creator-controlled PDA is ` +
      'program-owned and is not safe; counted as wallet concentration',
    excludedFromWalletConcentration: false,
  };
}
