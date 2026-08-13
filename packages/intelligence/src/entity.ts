/**
 * Which wallets are actually one actor.
 *
 * §15 — entity and fraud features.
 *
 * "Top 10 holders own 18%" is reassuring and means nothing if those ten wallets
 * were funded by one address twenty minutes before launch. Concentration
 * measured over ADDRESSES is the number a launch is designed to flatter;
 * concentration measured over ENTITIES is the one that predicts a dump.
 *
 * The evidence used here is deliberately narrow, because each piece is a fact
 * that can be read off the chain and checked:
 *
 *   - a common funder: the wallets were filled from one source before they bought
 *   - a shared fee payer: somebody else paid for their transactions
 *   - same-transaction co-purchase: they bought in one atomic instruction set
 *   - direct transfers between them
 *
 * Anything softer — timing correlation, similar amounts, round numbers — is
 * left out. Those are real signals and they are also how a clustering algorithm
 * starts inventing conspiracies out of coincidence, and a wrong cluster
 * inflates measured concentration and refuses trades for no reason.
 *
 * UNKNOWN is a first-class answer. A wallet whose funding history was not
 * fetched is not an independent wallet.
 */

export type LinkKind = 'COMMON_FUNDER' | 'SHARED_FEE_PAYER' | 'SAME_TRANSACTION' | 'DIRECT_TRANSFER';

export interface EntityLink {
  readonly a: string;
  readonly b: string;
  readonly kind: LinkKind;
  /** What was observed, so a cluster can be justified rather than asserted. */
  readonly evidence: string;
}

export interface Holder {
  readonly address: string;
  readonly amount: bigint;
  /** False when this wallet's history was never fetched. */
  readonly historyKnown: boolean;
}

export interface Cluster {
  readonly members: readonly string[];
  readonly amount: bigint;
  readonly kinds: readonly LinkKind[];
}

/**
 * Group holders into entities by union-find over the observed links.
 *
 * Transitive on purpose: if A and B share a funder, and B and C bought in one
 * transaction, then A, B and C are one actor for the purpose of asking how much
 * of the supply can hit the market at once. That is the question being asked.
 */
export function cluster(holders: readonly Holder[], links: readonly EntityLink[]): Cluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const h of holders) parent.set(h.address, h.address);
  const kindsOf = new Map<string, Set<LinkKind>>();
  for (const l of links) {
    // A link naming an address we do not hold is not evidence about this
    // holder set. It is somebody else's graph.
    if (!parent.has(l.a) || !parent.has(l.b)) continue;
    union(l.a, l.b);
    for (const m of [l.a, l.b]) {
      const s = kindsOf.get(m) ?? new Set<LinkKind>();
      s.add(l.kind);
      kindsOf.set(m, s);
    }
  }

  const byRoot = new Map<string, { members: string[]; amount: bigint; kinds: Set<LinkKind> }>();
  for (const h of holders) {
    const root = find(h.address);
    const entry = byRoot.get(root) ?? { members: [], amount: 0n, kinds: new Set<LinkKind>() };
    entry.members.push(h.address);
    entry.amount += h.amount;
    for (const k of kindsOf.get(h.address) ?? []) entry.kinds.add(k);
    byRoot.set(root, entry);
  }

  return [...byRoot.values()]
    .map((e) => ({ members: e.members.sort(), amount: e.amount, kinds: [...e.kinds].sort() }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

export interface ConcentrationReading {
  /** Share held by the largest N entities, in basis points. */
  readonly topEntityBps: Readonly<Record<1 | 5 | 10 | 20, number>>;
  /** The same over raw addresses, for comparison. */
  readonly topAddressBps: Readonly<Record<1 | 5 | 10 | 20, number>>;
  readonly entityCount: number;
  readonly addressCount: number;
  /** Holders whose history was never fetched. */
  readonly unknownHistoryCount: number;
  /**
   * False when enough holders are unexamined that the entity figure cannot be
   * trusted. It is then NOT a better number than the address figure, merely a
   * different one.
   */
  readonly trustworthy: boolean;
  readonly detail: string;
}

const TOPS = [1, 5, 10, 20] as const;

function topBps(amounts: readonly bigint[], total: bigint): Record<1 | 5 | 10 | 20, number> {
  const sorted = [...amounts].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const out = {} as Record<1 | 5 | 10 | 20, number>;
  for (const n of TOPS) {
    const sum = sorted.slice(0, n).reduce((a, b) => a + b, 0n);
    // Rounded UP: this is a risk measure and understating it lets a trade
    // through.
    out[n] = total <= 0n ? 0 : Number((sum * 10_000n + total - 1n) / total);
  }
  return out;
}

/**
 * Concentration over entities and over addresses, side by side.
 *
 * Both are reported because the GAP between them is the interesting number. A
 * token whose top-10 addresses hold 18% and whose top-10 entities hold 71% is
 * not a decentralised token that happens to be clustered; it is a token that
 * was built to look decentralised.
 */
export function concentration(holders: readonly Holder[], links: readonly EntityLink[]): ConcentrationReading {
  const total = holders.reduce((a, h) => a + h.amount, 0n);
  const clusters = cluster(holders, links);
  const unknownHistoryCount = holders.filter((h) => !h.historyKnown).length;
  // A quarter is a judgement, and it is frozen here rather than configured so
  // it cannot be quietly relaxed when it starts refusing trades.
  const trustworthy = holders.length > 0 && unknownHistoryCount * 4 <= holders.length;

  return {
    topEntityBps: topBps(clusters.map((c) => c.amount), total),
    topAddressBps: topBps(holders.map((h) => h.amount), total),
    entityCount: clusters.length,
    addressCount: holders.length,
    unknownHistoryCount,
    trustworthy,
    detail: trustworthy
      ? `${holders.length} addresses resolve to ${clusters.length} entities`
      : `${unknownHistoryCount} of ${holders.length} holders have unexamined history, so the entity figure is ` +
        'not established. It is a different number from the address figure, not a better one.',
  };
}

/**
 * Net selling by a cluster, which is the behaviour that matters.
 *
 * Holding a large share is a risk. SELLING it is the event. Returns null when
 * the flows were not observed, because a cluster that has not been watched has
 * not been shown to be holding.
 */
export function netSoldByCluster(
  c: Cluster,
  flows: ReadonlyMap<string, { bought: bigint; sold: bigint } | undefined>,
): { netSold: bigint; observed: boolean } {
  let netSold = 0n;
  let observed = true;
  for (const m of c.members) {
    const f = flows.get(m);
    if (f === undefined) {
      observed = false;
      continue;
    }
    netSold += f.sold - f.bought;
  }
  return { netSold, observed };
}
