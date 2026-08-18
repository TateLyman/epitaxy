import { buildEntityLinks, entityConcentrationFrom } from '../../intelligence/src/entity-links.js';
import type { EntityHistory } from '../../intelligence/src/risk-facts-order.js';

/**
 * O-2 — THE ENTITY-ADJUSTED TIER, ACTUALLY WALKED.
 *
 * The trajectory collector passed `holderHistories: []` and `clusteredShare: 0`
 * into every risk-fact assembly, with a comment saying the strong tier "is NOT
 * walked here". `entityAdjustedConcentration` correctly turned an empty history
 * list into `HISTORY_INCOMPLETE`, so:
 *
 *   - every candidate stratified `CONCENTRATION_RAW_ONLY` (2 of 2, and 545 of
 *     545 before that);
 *   - `entity_concentration` accumulated 57 rows from the SCREENING cycle, none
 *     of which was ever joined to a candidate decision;
 *   - `PreEntryFeatures.entityConcentration` was null on every decision, so the
 *     one policy that reads it could never read anything.
 *
 * A risk fact computed somewhere and reaching no decision is indistinguishable
 * from not having computed it.
 *
 * What made the walk unavailable was never the clustering — that has existed
 * since it was written — it was the history read. `buildEntityLinks` asks for
 * the OLDEST signature of a holder's token account, because a token account's
 * first transaction is its creation and that transaction's fee payer is the
 * funder. The screening cycle approximated it as "the oldest of the newest
 * 200", which is the exact substitution `reachedEarliestSignature` exists to
 * refuse: a wallet with 201 signatures then looks newly created and gets a
 * funder that funded nothing.
 *
 * So this paginates. `getSignaturesForAddress` walks backwards with `before`
 * until a page comes back short, which is the only proof that the earliest was
 * reached. When the page budget runs out first, the holder's history is
 * INCOMPLETE and says so — and `entityAdjustedConcentration` then refuses to
 * report a measured share at all, rather than reporting a lower bound as a fact.
 */

export interface SignatureReader {
  getSignaturesForAddress(
    address: string,
    limit?: number,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null; slot: number | null; failed: boolean | null }[]>;
  getTransactionFeePayer(signature: string): Promise<string | null>;
  getTokenLargestAccounts(mint: string): Promise<{ accounts: { address: string; amount: bigint }[] }>;
  getTokenSupply(mint: string): Promise<{ amount: bigint; decimals: number }>;
  getTokenAccountOwners(
    tokenAccounts: readonly string[],
  ): Promise<Map<string, { owner: string; systemOwned: boolean; ownerProgram: string | null }>>;
}

/**
 * Frozen before collection. A wider walk is a different measurement, not a
 * tuning knob.
 *
 * 20 is not a choice, it is the whole of what `getTokenLargestAccounts`
 * returns. At 10 the walk was structurally incapable of a trusted reading:
 * `concentration()` calls the entity figure untrustworthy once a quarter of the
 * holders are unexamined, and leaving half of a 20-holder list out guarantees
 * that. Measured on three live mints: 19 non-vault holders, 9 unexamined,
 * trustworthy=false every time — an apparatus that refuses its own output by
 * construction, which is indistinguishable from not having it.
 */
export const MAX_ENTITY_HOLDERS = 20;
export const MAX_HISTORY_PAGES = 6;
export const HISTORY_PAGE_SIZE = 1_000;

/**
 * A rate-limited history read is not a wallet with no funder.
 *
 * Measured against the keyed endpoint while the collector was running: 3 to 6
 * of 10 holders per mint came back HTTP 429, and each one silently became its
 * own entity. That inflates the entity count, which DEFLATES the entity share —
 * the direction that makes a clustered token look decentralised. It is the same
 * substitution as reporting an empty history list as a measured zero, arriving
 * one layer down.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 400;

const isRateLimited = (e: unknown): boolean => /rate_limited|429/.test((e as Error).message ?? '');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OldestSignature {
  readonly signature: string | null;
  /** True ONLY when a short page proved there is nothing older. */
  readonly reachedEarliest: boolean;
  readonly pagesWalked: number;
}

/**
 * The genuinely oldest signature of an address, or an honest failure.
 *
 * `reachedEarliest` is true only when a page came back shorter than the page
 * size — that short page is the proof. Exhausting the budget returns the oldest
 * signature SEEN together with `reachedEarliest: false`, and every caller must
 * treat that as unknown rather than as old.
 */
export async function oldestSignatureOf(
  rpc: SignatureReader,
  address: string,
  maxPages: number = MAX_HISTORY_PAGES,
  /**
   * Called between PAGES, so a mark whose horizon arrives mid-walk is taken.
   *
   * A walk is up to `maxPages` sequential reads against a rate-limited
   * endpoint, and it is one of the two stretches that cost this repository its
   * mark SLA: measured 2026-08-18, the worst collector mark was 43,251 ms late
   * against a frozen 10,000 ms bound, because a horizon that came due inside a
   * candidate's entity walk waited for the whole walk to finish.
   *
   * Optional, because every other caller of this function is a script that has
   * no marks to take.
   */
  yieldTo?: () => Promise<void>,
): Promise<OldestSignature> {
  let before: string | undefined;
  let oldest: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    if (yieldTo !== undefined) await yieldTo();
    let sigs: Awaited<ReturnType<SignatureReader['getSignaturesForAddress']>> | null = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      try {
        sigs = await rpc.getSignaturesForAddress(address, HISTORY_PAGE_SIZE, before);
        break;
      } catch (e) {
        if (!isRateLimited(e) || attempt === RATE_LIMIT_RETRIES) throw e;
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      }
    }
    if (sigs === null) throw new Error('the signature page was neither returned nor refused');
    if (sigs.length === 0) {
      // An empty page after at least one full page also proves the end.
      return { signature: oldest, reachedEarliest: true, pagesWalked: page };
    }
    const last = sigs[sigs.length - 1];
    if (last === undefined) return { signature: oldest, reachedEarliest: true, pagesWalked: page };
    oldest = last.signature;
    if (sigs.length < HISTORY_PAGE_SIZE) {
      return { signature: oldest, reachedEarliest: true, pagesWalked: page };
    }
    before = last.signature;
  }
  return { signature: oldest, reachedEarliest: false, pagesWalked: maxPages };
}

export interface EntityTierReading {
  readonly histories: readonly EntityHistory[];
  /**
   * Top-10-entity share OF SUPPLY, so it means the same thing the limit does.
   *
   * `concentration()` reports every figure over the holders it was handed,
   * because the number it exists to produce is the GAP between the entity and
   * address readings and both need one denominator. `admitCandidate` compares
   * against `maxEntityConcentration` and `maxRawTopHolderShare`, and the raw
   * tier feeds it `held / supply.amount` — a share of SUPPLY.
   *
   * Handing the within-holders figure to that gate compares two different
   * quantities. Measured 2026-08-17, before it was corrected: the raw share
   * across the corpus runs 11.4% to 47.2% of supply and the within-holders
   * entity figure came out at 71.0%, 74.9% and 97.3% on the three mints tried,
   * so the entity gate refused every candidate on a number that was never a
   * share of the token. The first deep pool the window ever saw — 28.4 SOL of
   * quote reserve, every other gate passed — was refused at "entity-adjusted
   * share 71.0% vs limit 50.0%".
   *
   * The limit is unchanged. Only the quantity compared against it is.
   */
  readonly clusteredShare: number;
  /** The same denominator, over raw addresses. The GAP is the interesting part. */
  readonly addressShare: number;
  /** Both figures within the examined holders, which is what `concentration()` returns. */
  readonly clusteredShareOfExamined: number;
  readonly addressShareOfExamined: number;
  readonly entityCount: number;
  readonly addressCount: number;
  readonly trustworthy: boolean;
  readonly notes: readonly string[];
  /** Non-null when the tier could not be walked at all. Never a share of zero. */
  readonly refusal: string | null;
}

const REFUSED = (why: string): EntityTierReading => ({
  histories: [],
  clusteredShare: 0,
  addressShare: 0,
  clusteredShareOfExamined: 0,
  addressShareOfExamined: 0,
  entityCount: 0,
  addressCount: 0,
  trustworthy: false,
  notes: [],
  refusal: why,
});

/**
 * Walk the top holders and report the entity-adjusted share.
 *
 * The pool's own base vault is excluded: it is the largest holder of every
 * migrated token, and counting it reports every pool as maximally concentrated.
 * Program-owned holders are excluded from LINKING for the same reason a vault
 * is — they are not a wallet whose funder means anything — but they still count
 * toward the denominator, so excluding them cannot flatter the share.
 */
export async function measureEntityTier(
  rpc: SignatureReader,
  p: {
    readonly mint: string;
    readonly poolBaseVault: string | null;
    readonly maxHolders?: number;
    readonly maxPages?: number;
    /**
     * The holder list the RAW tier already read, and the supply it divided by.
     *
     * Supplied by the collector, which reads both a few lines earlier. Passing
     * them is not only two fewer calls per candidate: it makes the raw share and
     * the entity share describe THE SAME INSTANT. Read twice, the gap between
     * them is partly a gap in time, and the gap is the whole output of this
     * module.
     */
    readonly holders?: { readonly address: string; readonly amount: bigint }[] | null;
    readonly supplyAtoms?: bigint | null;
    /**
     * Called between every address walk and every fee-payer lookup.
     *
     * The entity walk is the LONGEST unyielded stretch in a discovery cycle:
     * up to `maxHolders` addresses, each up to `maxPages` sequential reads,
     * against a bucket deliberately set to a few requests a second. Nothing
     * inside it was interruptible, so a one-minute horizon that came due while
     * it ran was served when it ended.
     *
     * Passing the collector's mark hook here turns one 30-second stretch into
     * a few dozen sub-second ones.
     */
    readonly yieldTo?: () => Promise<void>;
  },
): Promise<EntityTierReading> {
  let accounts: { address: string; amount: bigint }[];
  let supplyAtoms: bigint;
  if (p.holders !== undefined && p.holders !== null && p.supplyAtoms !== undefined && p.supplyAtoms !== null) {
    accounts = p.holders.filter((a) => a.address !== p.poolBaseVault && a.amount > 0n);
    supplyAtoms = p.supplyAtoms;
  } else {
    try {
      const [largest, supply] = await Promise.all([
        rpc.getTokenLargestAccounts(p.mint),
        rpc.getTokenSupply(p.mint),
      ]);
      accounts = largest.accounts.filter((a) => a.address !== p.poolBaseVault && a.amount > 0n);
      supplyAtoms = supply.amount;
    } catch (e) {
      return REFUSED(`the holder list could not be read: ${(e as Error).message.slice(0, 90)}`);
    }
  }
  if (supplyAtoms <= 0n) {
    return REFUSED('the mint reports zero supply, so no share of it can be computed');
  }
  if (accounts.length < 2) {
    return REFUSED(`only ${accounts.length} non-vault holder(s) were returned, so there is nothing to cluster`);
  }

  let owners: Map<string, { owner: string; systemOwned: boolean; ownerProgram: string | null }>;
  try {
    owners = await rpc.getTokenAccountOwners(accounts.map((a) => a.address));
  } catch (e) {
    return REFUSED(`the holder owners could not be resolved: ${(e as Error).message.slice(0, 90)}`);
  }

  const maxHolders = p.maxHolders ?? MAX_ENTITY_HOLDERS;
  const linkable = accounts
    .map((a) => ({ a, o: owners.get(a.address) }))
    .filter((x) => x.o !== undefined && x.o.systemOwned)
    .map((x) => ({
      address: (x.o as { owner: string }).owner,
      amount: x.a.amount,
      historyAddress: x.a.address,
    }));
  if (linkable.length < 2) {
    return REFUSED(
      `${accounts.length} holder(s) resolved but only ${linkable.length} is a plain wallet, so no link can be built`,
    );
  }

  const walked = new Map<string, OldestSignature>();
  const built = await buildEntityLinks(
    {
      oldestSignatures: async (address, limit) => {
        if (p.yieldTo !== undefined) await p.yieldTo();
        const seen = walked.get(address);
        const o = seen ?? (await oldestSignatureOf(rpc, address, p.maxPages ?? MAX_HISTORY_PAGES, p.yieldTo));
        if (seen === undefined) walked.set(address, o);
        // The interface wants oldest-first. There is exactly one that matters —
        // the creation — and returning more would invite a caller to treat a
        // later transaction's payer as the funder.
        return o.signature === null || limit < 1 ? [] : [{ signature: o.signature, slot: null, blockTime: null }];
      },
      // Retried for the same reason the page walk is: `buildEntityLinks`
      // catches a throw here as "history unreadable", and an unreadable history
      // becomes an independent entity, which deflates the share.
      feePayerOf: async (signature) => {
        if (p.yieldTo !== undefined) await p.yieldTo();
        for (let attempt = 0; ; attempt++) {
          try {
            return await rpc.getTransactionFeePayer(signature);
          } catch (e) {
            if (!isRateLimited(e) || attempt === RATE_LIMIT_RETRIES) throw e;
            await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
          }
        }
      },
    },
    linkable,
    { maxHolders },
  );

  const reading = entityConcentrationFrom(built);
  /**
   * ONE HISTORY PER EXAMINED HOLDER, with the truth about whether the walk
   * finished. `entityAdjustedConcentration` refuses on any incomplete entry, so
   * a budget-exhausted walk cannot be reported as a measured share — which is
   * the whole reason the field exists.
   */
  const histories: EntityHistory[] = linkable.slice(0, maxHolders).map((h) => {
    const w = walked.get(h.historyAddress ?? h.address);
    return {
      // A holder whose page was never fetched, or whose walk ran out of budget,
      // is INCOMPLETE. Absent is never earliest.
      reachedEarliestSignature: w?.reachedEarliest ?? false,
      pagesWalked: w?.pagesWalked ?? 0,
      links: [],
    };
  });

  /**
   * Rebase onto SUPPLY.
   *
   * `reading.topEntityBps[10]` is a share of the holders `concentration()` was
   * handed — `linkable`, the plain wallets among the top accounts. Scaling by
   * that set's own share of supply converts it without recomputing anything, and
   * keeps the entity and address figures on one denominator so the gap between
   * them is still the gap.
   *
   * Program-owned holders are outside the numerator because they belong to no
   * wallet cluster. They are not lost: the RAW tier counts every top account
   * against `maxRawTopHolderShare`, and both gates run.
   */
  const examinedAtoms = linkable.reduce((a, h) => a + h.amount, 0n);
  const ofSupply = Number((examinedAtoms * 1_000_000n) / supplyAtoms) / 1_000_000;

  return {
    histories,
    clusteredShare: (reading.topEntityBps[10] / 10_000) * ofSupply,
    addressShare: (reading.topAddressBps[10] / 10_000) * ofSupply,
    clusteredShareOfExamined: reading.topEntityBps[10] / 10_000,
    addressShareOfExamined: reading.topAddressBps[10] / 10_000,
    entityCount: reading.entityCount,
    addressCount: reading.addressCount,
    trustworthy: reading.trustworthy,
    notes: built.notes,
    refusal: null,
  };
}
