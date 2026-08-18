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

/**
 * The transaction-level facts the other three link kinds need.
 *
 * Separate from `HistorySource` because it is a different order of RPC spend:
 * `feePayerOf` reads one field off one transaction, this reads the whole body.
 * A caller with a small budget can supply the first and omit the second, and
 * gets `COMMON_FUNDER` links only — which is a smaller claim, not a wrong one.
 */
export interface TransactionSource {
  /**
   * Which of `addresses` appear as writable signers or token-account owners in
   * this transaction, and who paid for it.
   */
  participantsOf(signature: string): Promise<{ feePayer: string | null; participants: readonly string[] } | null>;
  /** Direct SOL or token transfers between two of the tracked addresses. */
  transfersIn(signature: string): Promise<readonly { from: string; to: string }[]>;
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

/**
 * A holder, and the account whose history establishes who funded it.
 *
 * These are deliberately two addresses. Clustering happens over the OWNER,
 * because that is the actor who can sell. But the owner's wallet may be years
 * old with thousands of transactions, and its first one says nothing about this
 * token. The TOKEN ACCOUNT was created for this mint, usually has a handful of
 * transactions, and its first one is its creation — whose fee payer is exactly
 * the funder this is looking for.
 *
 * Reading the owner's history instead was the first implementation, and it made
 * every reading untrustworthy: `getSignaturesForAddress` returns newest-first,
 * so the "oldest" of a bounded page is the Nth-newest transaction of an active
 * wallet, not its first. Its fee payer is then usually the wallet itself, which
 * links nobody.
 */
export interface HolderForLinking {
  readonly address: string;
  readonly amount: bigint;
  /** The account to read history from. Defaults to `address`. */
  readonly historyAddress?: string;
}

export async function buildEntityLinks(
  source: HistorySource,
  holders: readonly HolderForLinking[],
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
  /**
   * READ is not the same as CLUSTERED, and conflating them made the entity
   * figure untrustworthy on exactly the tokens that are genuinely dispersed.
   *
   * `historyKnown` was `funderOf.has(address)`. A holder whose creation
   * transaction was fetched and whose fee payer turned out to be ITSELF, or a
   * known exchange, gets no funder link — correctly — and was then counted as
   * having UNEXAMINED history. `concentration()` calls the whole reading
   * untrustworthy once a quarter of holders are unexamined, so a token where
   * every holder self-funded scored the same as one where the RPC answered
   * nothing.
   *
   * Measured on three live mints: 19 of 19 histories reached their earliest
   * signature and `trustworthy` was still false on all three.
   *
   * This set is "the history was read and the answer is what it is". The funder
   * map stays what it was: a link, or nothing.
   */
  const historyRead = new Set<string>();
  for (const h of examine) {
    try {
      const sigs = await source.oldestSignatures(h.historyAddress ?? h.address, 1);
      const first = sigs[0];
      // No signature at all is not a read history. An account with no
      // transactions cannot be the token account of a holder with a balance,
      // so this is the RPC declining to say rather than a fact about the wallet.
      if (first === undefined) continue;
      const payer = await source.feePayerOf(first.signature);
      // A null payer is an unreadable transaction, NOT a self-funded wallet.
      if (payer === null) continue;
      historyRead.add(h.address);
      if (payer === h.address || ignored.has(payer)) continue;
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
    ...examine.map((h) => ({ address: h.address, amount: h.amount, historyKnown: historyRead.has(h.address) })),
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

/**
 * The remaining three link kinds, from transaction bodies.
 *
 * `SHARED_FEE_PAYER`  two holders whose activity someone else paid for
 * `SAME_TRANSACTION`  two holders that appear in one transaction — a bundle,
 *                     or a co-purchase, which is the same thing seen twice
 * `DIRECT_TRANSFER`   one holder sent tokens or SOL straight to another
 *
 * All three are strictly stronger evidence than a shared first funder and all
 * three cost more to obtain, which is why they are a separate call with a
 * separate source. A caller that cannot afford the transaction bodies gets
 * `COMMON_FUNDER` alone and a correspondingly weaker claim.
 *
 * `signatures` is what the caller is willing to examine. Nothing here fetches
 * more: the budget stays with the caller, where it can be reasoned about.
 */
export async function buildTransactionLinks(
  source: TransactionSource,
  tracked: readonly string[],
  signatures: readonly string[],
): Promise<{ links: EntityLink[]; examined: number; notes: string[] }> {
  const set = new Set(tracked);
  const links: EntityLink[] = [];
  const notes: string[] = [];
  const payerOf = new Map<string, string[]>();
  let examined = 0;

  for (const sig of signatures) {
    let info: { feePayer: string | null; participants: readonly string[] } | null = null;
    try {
      info = await source.participantsOf(sig);
    } catch (e) {
      notes.push(`transaction ${sig.slice(0, 8)} unreadable: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    if (info === null) continue;
    examined += 1;

    const present = [...new Set(info.participants.filter((a) => set.has(a)))];

    // SAME_TRANSACTION — two tracked holders in one transaction.
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        links.push({
          a: present[i] as string,
          b: present[j] as string,
          kind: 'SAME_TRANSACTION',
          evidence: `both appear in ${sig.slice(0, 12)}`,
        });
      }
    }

    // SHARED_FEE_PAYER — somebody else paid for this holder's activity. A
    // holder paying for its OWN transaction says nothing about anyone.
    const payer = info.feePayer;
    if (payer !== null) {
      for (const a of present) {
        if (a === payer) continue;
        payerOf.set(payer, [...(payerOf.get(payer) ?? []), a]);
      }
    }

    // DIRECT_TRANSFER — the strongest of the three. One holder sent value
    // straight to another; there is no innocent reading in which they are
    // independent actors for the purpose of "how much can hit the market".
    try {
      for (const t of await source.transfersIn(sig)) {
        if (!set.has(t.from) || !set.has(t.to) || t.from === t.to) continue;
        links.push({
          a: t.from,
          b: t.to,
          kind: 'DIRECT_TRANSFER',
          evidence: `${t.from.slice(0, 8)} -> ${t.to.slice(0, 8)} in ${sig.slice(0, 12)}`,
        });
      }
    } catch (e) {
      notes.push(`transfers in ${sig.slice(0, 8)} unreadable: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  for (const [payer, holders] of payerOf) {
    const members = [...new Set(holders)];
    if (members.length < 2) continue;
    const [head, ...rest] = members as [string, ...string[]];
    for (const other of rest) {
      links.push({
        a: head,
        b: other,
        kind: 'SHARED_FEE_PAYER',
        evidence: `both had transactions paid for by ${payer}`,
      });
    }
  }

  return { links, examined, notes };
}

/** Fold extra links into a build result, keeping the holder set unchanged. */
export function withExtraLinks(r: LinkBuildResult, extra: readonly EntityLink[]): LinkBuildResult {
  return { ...r, links: [...r.links, ...extra] };
}

/** The reading, with the links actually built. */
export function entityConcentrationFrom(r: LinkBuildResult): ConcentrationReading {
  return concentration(r.holders, r.links);
}
