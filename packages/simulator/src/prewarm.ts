/**
 * P6 — the PREWARMED surface, and the one thing it must not do.
 *
 * The directive asks for three surfaces from the SAME original price state:
 *
 * ```
 * COLD                          the chain as it is, we open everything
 * PREWARMED_NON_PRICE_ACCOUNTS  the shared accounts already exist, reserves untouched
 * REPEAT                        the second trade, after the first moved the pool
 * ```
 *
 * COLD and REPEAT are easy: run once, run twice. PREWARMED is the one that
 * carries the whole hypothesis, and it is the one that is trivial to get wrong.
 *
 * The wrong version is "run the trade, then run it again from the post state".
 * That is REPEAT wearing PREWARMED's label. It answers a different question,
 * because the second trade faces reserves the first one moved — so the measured
 * difference is setup cost PLUS self-impact, and those have opposite policy
 * implications. Setup cost says *wait for a warm pool*. Self-impact says
 * *trade smaller*. A surface that mixes them recommends neither.
 *
 * So the transplant is deliberately narrow: shared accounts the first trade
 * created are copied into the ORIGINAL snapshot, and every price-bearing
 * account keeps its original bytes. If a caller asks to transplant something
 * price-bearing, that is refused by name rather than quietly honoured — the
 * result would look like a cheaper trade and would actually be a different
 * market.
 */

export interface PrewarmAccount {
  readonly pubkey: string;
  readonly owner: string;
  readonly dataBase64: string;
  readonly lamports: bigint;
  readonly executable?: boolean;
  readonly rentEpoch?: bigint;
}

export class PriceStateTransplant extends Error {
  readonly accounts: readonly string[];
  constructor(accounts: readonly string[]) {
    super(
      `refusing to prewarm ${accounts.length} price-bearing account(s): ${accounts.slice(0, 4).join(', ')}. ` +
        'Carrying reserve state forward measures a different market, not a warmer one.',
    );
    this.name = 'PriceStateTransplant';
    this.accounts = accounts;
  }
}

export interface PrewarmResult {
  readonly accounts: readonly PrewarmAccount[];
  /** Accounts that were warmed, in the order they were applied. */
  readonly transplanted: readonly string[];
  /**
   * Accounts asked for that the post-state did not have.
   *
   * Not an error: an account the first trade did not create cannot be warmed
   * from it, and that is a fact about the trade rather than about the request.
   */
  readonly unavailable: readonly string[];
}

/**
 * Copy warm non-price accounts into the original snapshot.
 *
 * `priceBearing` is a hard boundary, checked against the REQUEST rather than
 * against what happens to differ. An account that is price-bearing and happened
 * not to move is still refused: whether the transplant is safe cannot depend on
 * the particular run, or the check passes right up until the one run where it
 * matters.
 */
export function prewarmNonPriceAccounts(p: {
  original: readonly PrewarmAccount[];
  afterFirstTrade: readonly PrewarmAccount[];
  priceBearing: readonly string[];
  transplant: readonly string[];
}): PrewarmResult {
  const price = new Set(p.priceBearing);
  const offending = p.transplant.filter((a) => price.has(a));
  if (offending.length > 0) throw new PriceStateTransplant(offending);

  const post = new Map(p.afterFirstTrade.map((a) => [a.pubkey, a]));
  const out = new Map(p.original.map((a) => [a.pubkey, a]));

  const transplanted: string[] = [];
  const unavailable: string[] = [];

  for (const key of p.transplant) {
    const warm = post.get(key);
    // An account with no lamports after the trade was not created by it.
    if (warm === undefined || warm.lamports <= 0n) {
      unavailable.push(key);
      continue;
    }
    out.set(key, warm);
    transplanted.push(key);
  }

  return { accounts: [...out.values()], transplanted, unavailable };
}

/**
 * The accounts a prewarm is ALLOWED to take, given what a leg created.
 *
 * Only shared ones. Our own recoverable ATAs are ours to open and ours to
 * close, and warming them would be assuming a wallet state we would have to
 * establish ourselves anyway — the rent is a float either way, so transplanting
 * it moves a number without changing an economic fact.
 *
 * The point of the surface is the accounts SOMEBODY ELSE would have opened.
 */
export function sharedAccountsToPrewarm(
  created: readonly { pubkey: string; sharedWithOtherTraders: boolean; scope?: string; recoverability?: string }[],
): string[] {
  /**
   * UNKNOWN counts, because the warm GATE already counts it.
   *
   * `requiresSharedAccountCreation` treats an unclassified account as shared —
   * "we did not recognise it" must not read as "it costs nothing". This
   * function filtered on `sharedWithOtherTraders` alone, so the two disagreed
   * about the same account: the gate called a candidate COLD and the surface
   * then had nothing to warm, and PREWARMED was skipped as though the entry had
   * opened nothing shared.
   *
   * Transplanting an account that turns out to be ours costs only a slightly
   * conservative warm surface. NOT transplanting one that is genuinely shared
   * makes the setup cost invisible, which is the error this whole section
   * exists to remove.
   */
  return created.filter((a) => a.sharedWithOtherTraders || a.scope === 'UNKNOWN' || a.recoverability === 'UNKNOWN').map((a) => a.pubkey);
}
