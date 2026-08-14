import {
  accountSourceOf,
  poolAddressesFrom,
  poolFactsFrom,
  quoteSellFrom,
  canonicalPool,
  type OfflinePoolFacts,
} from '../../solana/src/pumpswap-offline.js';
import { feeTiersOf, tierFor, type FeeTier } from '../../solana/src/fee-tiers.js';

/**
 * P4/P7 — price the exit from the pool, not from a router.
 *
 * The repaired fill loop could not fire, and the corpus said exactly why: of the
 * marks taken in ten minutes of running it, **none had a route**. 93% of all
 * marks ever recorded have `route_available = 0`. The router declines a sell for
 * a token with no canonical pool, and an unpriced mark can never become a fill
 * however correct the ordering above it is.
 *
 * A canonical PumpSwap pool does not need a router. Its reserves are two token
 * accounts, its fee is a decoded table, and the official model prices a sell
 * from those bytes. That is both cheaper and more exact than asking a router
 * whether it feels like quoting.
 *
 * This is deliberately a MARK, not a fill: it establishes the executable value
 * of the position right now. Turning a mark into a fill still requires the
 * effect verification the fill loop does, because a price nobody executed is
 * still a quote.
 */

export interface DirectMarkInput {
  readonly mint: string;
  readonly tokenAmount: bigint;
  readonly slippagePct?: number;
}

export interface DirectMark {
  readonly mint: string;
  readonly pool: string;
  /** What the position is worth, from the pool's own reserves. */
  readonly executableLamports: bigint;
  readonly minimumLamports: bigint;
  readonly poolFacts: OfflinePoolFacts;
  /** The tier the pool actually sits in, so drag is not assumed. */
  readonly feeTier: FeeTier | null;
  readonly roundTripFeeBps: number | null;
  readonly isMayhemMode: boolean | null;
  readonly isCashbackCoin: boolean | null;
  readonly capturedSlot: number | null;
  readonly accountHashes: Readonly<Record<string, string>>;
}

export class DirectMarkUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`no direct mark: ${reason}`);
    this.name = 'DirectMarkUnavailable';
    this.reason = reason;
  }
}

export interface AccountReader {
  getAccountRaw(pubkey: string): Promise<{ owner: string; dataBase64: string; lamports: bigint }>;
}

const FEE_CONFIG = 'ADyA8hdefvWN2yZ9nwecQyJheAF6xJK2ZFcHNPjRWyeg';

/**
 * Read the accounts a direct sell quote needs, and price it.
 *
 * Throws `DirectMarkUnavailable` with a reason rather than returning null, so a
 * caller records WHY a mark was not priced. "No route" collapsed six different
 * facts into one word and that is how 93% of the corpus became uninformative.
 */
export async function directSellMark(
  rpc: AccountReader,
  input: DirectMarkInput,
  opts: { globalConfig: string; feeConfig?: string } = { globalConfig: '' },
): Promise<DirectMark> {
  if (input.tokenAmount <= 0n) throw new DirectMarkUnavailable('the position holds no tokens');

  const pool = canonicalPool(input.mint);
  let poolRow;
  try {
    const raw = await rpc.getAccountRaw(pool);
    poolRow = { pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports };
  } catch {
    // Not a failure of this system. Most Pump mints never migrate.
    throw new DirectMarkUnavailable('no canonical PumpSwap pool');
  }

  const addrs = poolAddressesFrom(accountSourceOf([poolRow]), pool);
  const wanted = [
    addrs.poolBaseTokenAccount,
    addrs.poolQuoteTokenAccount,
    input.mint,
    opts.globalConfig,
    opts.feeConfig ?? FEE_CONFIG,
  ].filter((x) => x.length > 0);

  const rows = [poolRow];
  for (const pubkey of wanted) {
    try {
      const raw = await rpc.getAccountRaw(pubkey);
      rows.push({ pubkey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports });
    } catch {
      // A vault or the mint missing is fatal; the fee config is optional and its
      // absence is the SDK's documented "no dynamic tier" signal.
      if (pubkey === addrs.poolBaseTokenAccount || pubkey === addrs.poolQuoteTokenAccount || pubkey === input.mint) {
        throw new DirectMarkUnavailable(`required account ${pubkey.slice(0, 12)} unreadable`);
      }
    }
  }

  const src = accountSourceOf(rows);
  const facts = poolFactsFrom(src, pool);
  if (facts.baseReserve === 0n || facts.quoteReserveRaw === 0n) {
    throw new DirectMarkUnavailable(`pool drained: base ${facts.baseReserve}, quote ${facts.quoteReserveRaw}`);
  }

  const quote = quoteSellFrom(src, pool, input.tokenAmount, input.slippagePct ?? 3);

  // The tier the pool is actually in. The mechanics floor is a step function of
  // market cap, so assuming the bottom tier overstates cost by up to 4x.
  let feeTier: FeeTier | null = null;
  const feeRow = src.get(opts.feeConfig ?? FEE_CONFIG);
  if (feeRow !== null) {
    try {
      const { PumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
      const { PublicKey } = await import('@solana/web3.js');
      const decoded = new PumpAmmSdk().decodeFeeConfig({
        owner: new PublicKey(feeRow.owner),
        data: Buffer.from(feeRow.dataBase64, 'base64'),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      });
      feeTier = tierFor(feeTiersOf(decoded), facts.quoteReserveRaw + facts.virtualQuoteReserves);
    } catch {
      feeTier = null;
    }
  }

  const hashes: Record<string, string> = {};
  for (const r of rows) hashes[r.pubkey] = hashOf(r.dataBase64);

  return {
    mint: input.mint,
    pool,
    executableLamports: quote.quoteOutLamports,
    minimumLamports: quote.minQuoteLamports,
    poolFacts: facts,
    feeTier,
    roundTripFeeBps: feeTier?.roundTripBps ?? null,
    isMayhemMode: addrs.isMayhemMode,
    isCashbackCoin: addrs.isCashbackCoin,
    capturedSlot: null,
    accountHashes: hashes,
  };
}

/** FNV-1a over the bytes. Enough to detect that an account moved. */
function hashOf(dataBase64: string): string {
  const b = Buffer.from(dataBase64, 'base64');
  let h = 0x811c9dc5;
  for (const byte of b) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
