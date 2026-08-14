import type { EntityLink, Holder } from './entity.js';
import { concentration, type ConcentrationReading } from './entity.js';

/**
 * P11 — build the entity links, from history the chain will actually give us.
 *
 * `entity.ts` has had union-find clustering, entity-vs-address concentration
 * and a trustworthiness rule since it was written. **Nothing in production
 * built a single link**, so `cluster()` was always called with an empty list,
 * every holder was its own entity, and the entity figure was the address figure
 * wearing a different name. Same defect class as the shadow state machine that
 * no loop imported.
 *
 * The link this module builds is COMMON_FUNDER, and only that one, because it
 * is the only one available at a cost the screening budget can pay:
 *
 *   one `getSignaturesForAddress` per holder, oldest page
 *   the funder is the fee payer of the account's FIRST transaction
 *
 * Two wallets funded by the same wallet are one actor for the purpose this is
 * asked for — how much of the supply can hit the market at once — and that
 * inference is strong enough to act on. The other kinds the directive lists
 * (shared fee payer, same transaction, direct transfer, bundle co-occurrence)
 * need full transaction bodies per holder, which is a different order of RPC
 * spend, and are left unbuilt rather than approximated.
 *
 * A holder whose history was not fetched is `historyKnown: false`, which
 * `concentration()` already counts and uses to decide whether the entity figure
 * may be trusted at all. Not fetching is therefore a reported fact rather than
 * a silent assumption that the wallet is independent.
 */

export interface SignatureRef {
  readonly signature: string;
  readonly blockTime: number | null;
}

export interface HistorySource {
  /** Oldest-first signatures for an address, bounded by the caller. */
  oldestSignatures(address: string, limit: number): Promise<readonly SignatureRef[]>;
  /** The fee payer of a transaction, or null when it cannot be read. */
  feePayerOf(signature: string): Promise<string | null>;
}

export interface LinkBuildResult {
  readonly links: readonly EntityLink[];
  readonly holders: readonly Holder[];
  /** How many holders had their history read. The rest are UNKNOWN, not independent. */
  readonly examined: number;
  readonly unexamined: number;
  readonly funderOf: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
}

export interface BuildOptions {
  /** How many of the largest holders to examine. Everything beyond is unknown. */
  readonly maxHolders?: number;
  /**
   * Wallets that fund everyone and link nobody.
   *
   * Supplied by the caller from CROSS-MINT evidence — a funder that links
   * holders on many unrelated mints — because genericness is not a property
   * this mint's holder list can establish.
   */
  readonly ignoredFunders?: ReadonlySet<string>;
}

/**
 * Addresses that fund everything and link nobody.
 *
 * An exchange hot wallet funds tens of thousands of unrelated people, and
 * treating that as one actor would merge the holder set and report a
 * concentration that is an artefact of using Coinbase.
 *
 * The tempting shortcut is to call a funder generic when it funded a large
 * SHARE of this mint's top holders. That is exactly backwards here. An exchange
 * funds people who then buy many different tokens, so it appears behind a small
 * fraction of any one token's holders; a funder behind sixty per cent of one
 * memecoin's top wallets is the sniper cluster this measurement exists to find.
 * Suppressing it would suppress the finding.
 *
 * Genericness is therefore a CROSS-MINT property and the caller supplies it —
 * a funder that links holders on many unrelated mints. Until that evidence
 * exists the links are built, which errs toward reporting concentration, and
 * for a risk measure that is the safe direction.
 */
const DEFAULT_IGNORED = new Set<string>(['11111111111111111111111111111111']);

export async function buildEntityLinks(
  source: HistorySource,
  holders: readonly { address: string; amount: bigint }[],
  opts: BuildOptions = {},
): Promise<LinkBuildResult> {
  const maxHolders = opts.maxHolders ?? 20;
  const ignored = opts.ignoredFunders ?? DEFAULT_IGNORED;
  const notes: string[] = [];

  const ranked = [...holders].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const examine = ranked.slice(0, maxHolders);
  const rest = ranked.slice(maxHolders);
  if (rest.length > 0) {
    notes.push(`${rest.length} holder(s) beyond the top ${maxHolders} were not examined and count as unknown history`);
  }

  const funderOf = new Map<string, string>();
  for (const h of examine) {
    try {
      const sigs = await source.oldestSignatures(h.address, 1);
      const first = sigs[0];
      if (first === undefined) continue;
      const payer = await source.feePayerOf(first.signature);
      if (payer === null || payer === h.address || ignored.has(payer)) continue;
      funderOf.set(h.address, payer);
    } catch (e) {
      // An unreadable history is an unknown history. It is NOT a wallet with
      // no funder, and it must not silently become an independent entity.
      notes.push(`history unreadable for ${h.address.slice(0, 8)}: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  const byFunder = new Map<string, string[]>();
  for (const [addr, f] of funderOf) {
    byFunder.set(f, [...(byFunder.get(f) ?? []), addr]);
  }
  for (const [f, members] of byFunder) {
    if (members.length >= 2 && examine.length > 0) {
      notes.push(`${f.slice(0, 8)} first funded ${members.length} of ${examine.length} examined holders`);
    }
  }

  const links: EntityLink[] = [];
  for (const [funder, members] of byFunder) {
    if (members.length < 2) continue;
    // A star, not a clique: union-find makes it transitive anyway, and n^2
    // links on a large group is a lot of rows saying one thing.
    const [head, ...others] = members as [string, ...string[]];
    for (const other of others) {
      links.push({
        a: head,
        b: other,
        kind: 'COMMON_FUNDER',
        evidence: `both first funded by ${funder}`,
      });
    }
  }

  const built: Holder[] = [
    ...examine.map((h) => ({ address: h.address, amount: h.amount, historyKnown: funderOf.has(h.address) })),
    ...rest.map((h) => ({ address: h.address, amount: h.amount, historyKnown: false })),
  ];

  return {
    links,
    holders: built,
    examined: funderOf.size,
    unexamined: built.length - funderOf.size,
    funderOf,
    notes,
  };
}

/** The reading, with the links actually built. */
export function entityConcentrationFrom(r: LinkBuildResult): ConcentrationReading {
  return concentration(r.holders, r.links);
}
