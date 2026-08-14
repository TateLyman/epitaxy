/**
 * P14 — parity against transactions that actually LANDED.
 *
 * Every other parity arm compares the model to something this system produced:
 * another decode, or the local runtime. They can all agree and all be wrong in
 * the same way. This one compares against what the chain itself recorded.
 *
 * The trick that makes it possible without an archival node: a landed
 * transaction carries `meta.preTokenBalances` and `meta.postTokenBalances`, so
 * the pool vaults' contents BEFORE the swap travel with the transaction. Reading
 * historical account state normally needs archival access this project does not
 * have; reading it out of the transaction's own metadata needs nothing but
 * `getTransaction`, which even the keyless public endpoint serves.
 *
 * The comparison, per landed swap:
 *
 *   reserves before   from meta.preTokenBalances on the two pool vaults
 *   quote paid in     from the taker's own balance delta
 *   base received     from the taker's token balance delta   <- GROUND TRUTH
 *   model output      the offline model, priced on those before-reserves
 *
 * A residual here is the model being wrong about the real world, not about
 * another copy of itself.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc, type LandedTransaction } from '../packages/solana/src/rpc.js';
import {
  accountSourceOf,
  poolAddressesFrom,
  quoteBuyFrom,
  quoteSellFrom,
  canonicalPool,
  AMM_PROGRAM_ID,
  GLOBAL_CONFIG_ADDR,
  FEE_CONFIG_ADDR,
} from '../packages/solana/src/pumpswap-offline.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const OVERRIDE = process.env['RPC_ENDPOINT'] ?? null;
const secrets = loadSecrets();
const endpoint = OVERRIDE ?? secrets.rpcHttp;
if (endpoint === null) {
  console.error('set RPC_ENDPOINT or configure an endpoint');
  process.exit(1);
}
const host = (() => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
})();
const rpc = new SolanaRpc(RateLimiter.fromConfig(OVERRIDE === null), { primary: endpoint, fallback: null });
const db = openDb({ path: secrets.databasePath, readonly: true });

/** Programs whose presence at top level does not make a swap routed. */
const SYSTEM_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

const TARGET = Number(process.env['LANDED_CASES'] ?? 6);
const SIGS_PER_POOL = Number(process.env['LANDED_SIGS'] ?? 12);
const SLIPPAGE_PCT = 3;

interface Case {
  signature: string;
  mint: string;
  pool: string;
  side: 'buy' | 'sell' | 'unknown';
  slot: number | null;
  baseReserveBefore: string | null;
  quoteReserveBefore: string | null;
  /** What the chain says the taker actually received or paid. */
  /** The POOL vault movement. Includes fees routed out of the vault. */
  vaultBaseDeltaAtoms: string | null;
  vaultQuoteDeltaLamports: string | null;
  /** What the TAKER actually received or paid. The ground truth. */
  takerBaseDeltaAtoms: string | null;
  takerQuoteDeltaLamports: string | null;
  quoteSource: string | null;
  /** Whether this was a single-hop swap by the fee payer, or a routed one. */
  shape: 'DIRECT' | 'ROUTED' | 'UNKNOWN';
  topLevelPrograms: string[];
  modelOutput: string | null;
  residualBps: number | null;
  status: string;
  detail: string | null;
}

/** The taker is the fee payer: account key zero, by definition. */
const takerOf = (tx: LandedTransaction): string => tx.accountKeys[0] ?? '';

function deltaFor(tx: LandedTransaction, index: number): bigint {
  const pre = tx.preTokenBalances.find((b) => b.accountIndex === index)?.amount ?? 0n;
  const post = tx.postTokenBalances.find((b) => b.accountIndex === index)?.amount ?? 0n;
  return post - pre;
}

/**
 * One read per address, for the whole run.
 *
 * The global config and the fee config are singletons, and the pool and mint
 * accounts do not change between two signatures on the same pool. Re-fetching
 * them per case earned a connection-rate 429 on the public endpoint after four
 * cases, which is a self-inflicted outage rather than a limit worth hitting.
 */
const accountCache = new Map<string, { pubkey: string; owner: string; dataBase64: string; lamports: bigint }>();
async function cachedAccount(
  pubkey: string,
): Promise<{ pubkey: string; owner: string; dataBase64: string; lamports: bigint }> {
  const hit = accountCache.get(pubkey);
  if (hit !== undefined) return hit;
  const raw = await rpc.getAccountRaw(pubkey);
  const row = { pubkey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports };
  accountCache.set(pubkey, row);
  return row;
}

const cases: Case[] = [];
const directCount = (): number =>
  cases.filter((c) => c.status === 'COMPARED' && c.shape === 'DIRECT').length;
const mints = db
  .prepare(
    `SELECT DISTINCT mint FROM execution_observations
      WHERE side='buy' AND exact_transaction_blob IS NOT NULL AND received_utc_ms > ?
      ORDER BY received_utc_ms DESC LIMIT 300`,
  )
  .all(Date.now() - 7 * 86_400_000) as { mint: string }[];

console.log(`endpoint ${host}${OVERRIDE === null ? '' : ' (explicit override)'}, target ${TARGET} landed swaps\n`);

for (const { mint } of mints) {
  if (directCount() >= TARGET) break;

  const pool = canonicalPool(mint);
  let addrs;
  try {
    addrs = poolAddressesFrom(accountSourceOf([await cachedAccount(pool)]), pool);
  } catch {
    continue; // no canonical pool. A market fact, not a failure.
  }

  let sigs: { signature: string }[] = [];
  try {
    sigs = await rpc.getSignaturesForAddress(pool, SIGS_PER_POOL);
  } catch (e) {
    console.log(`  ${mint.slice(0, 10)} signatures unavailable: ${(e as Error).message.slice(0, 50)}`);
    continue;
  }

  for (const { signature } of sigs) {
    if (directCount() >= TARGET) break;

    const c: Case = {
      signature,
      mint,
      pool,
      side: 'unknown',
      slot: null,
      baseReserveBefore: null,
      quoteReserveBefore: null,
      vaultBaseDeltaAtoms: null,
      vaultQuoteDeltaLamports: null,
      takerBaseDeltaAtoms: null,
      takerQuoteDeltaLamports: null,
      quoteSource: null,
      shape: 'UNKNOWN',
      topLevelPrograms: [],
      modelOutput: null,
      residualBps: null,
      status: 'PENDING',
      detail: null,
    };

    let tx: LandedTransaction | null = null;
    try {
      tx = await rpc.getTransactionWithMeta(signature);
    } catch (e) {
      c.status = 'TX_UNAVAILABLE';
      c.detail = (e as Error).message.slice(0, 90);
      cases.push(c);
      continue;
    }
    if (tx === null) {
      c.status = 'TX_UNAVAILABLE';
      cases.push(c);
      continue;
    }
    c.slot = tx.slot;
    if (tx.failed) {
      c.status = 'TX_FAILED_ON_CHAIN';
      cases.push(c);
      continue;
    }

    /**
     * Direct or routed, from the log stack.
     *
     * A residual only means something when the taker's balance delta is THIS
     * swap and nothing else. In a routed transaction the fee payer's native
     * balance moves for several legs at once, and attributing all of it to one
     * pool produces residuals in the hundreds or thousands of basis points that
     * say nothing about the model.
     *
     * `Program X invoke [1]` is a top-level instruction; deeper numbers are CPI.
     * One top-level AMM invoke and no other venue is a direct swap.
     */
    const topLevel = tx.logMessages
      .map((l) => /^Program (\S+) invoke \[1\]$/.exec(l)?.[1] ?? null)
      .filter((x): x is string => x !== null)
      .filter((x) => !SYSTEM_PROGRAMS.has(x));
    c.topLevelPrograms = [...new Set(topLevel)];
    const ammInvokes = topLevel.filter((p) => p === AMM_PROGRAM_ID).length;
    c.shape = ammInvokes === 1 && c.topLevelPrograms.every((p) => p === AMM_PROGRAM_ID) ? 'DIRECT' : 'ROUTED';

    // The pool vaults, by their index in this transaction's account list.
    const baseIdx = tx.accountKeys.indexOf(addrs.poolBaseTokenAccount);
    const quoteIdx = tx.accountKeys.indexOf(addrs.poolQuoteTokenAccount);
    if (baseIdx < 0 || quoteIdx < 0) {
      c.status = 'NOT_A_POOL_SWAP';
      c.detail = 'the pool vaults do not appear in this transaction';
      cases.push(c);
      continue;
    }

    const baseBefore = tx.preTokenBalances.find((b) => b.accountIndex === baseIdx)?.amount ?? null;
    const quoteBefore = tx.preTokenBalances.find((b) => b.accountIndex === quoteIdx)?.amount ?? null;
    if (baseBefore === null || quoteBefore === null) {
      c.status = 'NO_PRE_BALANCES';
      cases.push(c);
      continue;
    }
    c.baseReserveBefore = baseBefore.toString();
    c.quoteReserveBefore = quoteBefore.toString();

    const baseVaultDelta = deltaFor(tx, baseIdx);
    const quoteVaultDelta = deltaFor(tx, quoteIdx);
    if (baseVaultDelta === 0n || quoteVaultDelta === 0n) {
      c.status = 'NOT_A_SWAP';
      cases.push(c);
      continue;
    }

    // Base LEAVING the pool is a buy; base arriving is a sell.
    c.side = baseVaultDelta < 0n ? 'buy' : 'sell';
    c.vaultBaseDeltaAtoms = (baseVaultDelta < 0n ? -baseVaultDelta : baseVaultDelta).toString();
    c.vaultQuoteDeltaLamports = (quoteVaultDelta < 0n ? -quoteVaultDelta : quoteVaultDelta).toString();

    /**
     * The TAKER's delta, which is not the vault's.
     *
     * A first pass compared the model against the quote vault's movement and
     * found a residual of exactly -123 bps on several cases. That is not a
     * model error: it is the protocol and creator fee, 93 + 30 bps at the
     * bottom tier, which leaves the vault for other accounts and never reaches
     * the taker. The vault moves by the taker's proceeds PLUS those fees.
     *
     * What the model quotes is what the taker gets, so that is what it must be
     * compared against.
     */
    const taker = takerOf(tx);
    const takerBase = (() => {
      const idx = tx.postTokenBalances.filter((b) => b.owner === taker && b.mint === mint).map((b) => b.accountIndex);
      if (idx.length === 0) return null;
      return idx.reduce((t, i) => t + deltaFor(tx, i), 0n);
    })();
    c.takerBaseDeltaAtoms = takerBase === null ? null : (takerBase < 0n ? -takerBase : takerBase).toString();

    const takerQuote = (() => {
      // Wrapped SOL held by the taker, when the route left it wrapped.
      const wsolIdx = tx.postTokenBalances
        .filter((b) => b.owner === taker && b.mint === addrs.quoteMint)
        .map((b) => b.accountIndex);
      if (wsolIdx.length > 0) {
        const d = wsolIdx.reduce((t, i) => t + deltaFor(tx, i), 0n);
        if (d !== 0n) {
          c.quoteSource = 'taker wrapped-quote account';
          return d < 0n ? -d : d;
        }
      }
      // Otherwise the native balance, with the transaction fee added back:
      // the fee is a cost of landing, not part of the swap's price.
      const pre = tx.preBalances[0];
      const post = tx.postBalances[0];
      if (pre === undefined || post === undefined) return null;
      const d = post - pre + tx.feeLamports;
      c.quoteSource = 'taker native balance, net of the transaction fee';
      return d < 0n ? -d : d;
    })();
    c.takerQuoteDeltaLamports = takerQuote === null ? null : takerQuote.toString();

    if (takerBase === null || takerBase === 0n || takerQuote === null || takerQuote === 0n) {
      c.status = 'NO_TAKER_DELTA';
      c.detail = 'the fee payer holds no balance row for this swap; it is probably routed for someone else';
      cases.push(c);
      continue;
    }

    /**
     * The model, priced on the reserves the CHAIN recorded before this swap.
     *
     * The pool account itself is read at its current state for the fields that
     * do not move with a swap — the mints, the creator, the virtual reserve
     * constant — while the two numbers that do move come from the transaction.
     */
    let src;
    try {
      src = accountSourceOf([
        await cachedAccount(pool),
        // The two numbers that DO move, from the transaction's own metadata.
        { pubkey: addrs.poolBaseTokenAccount, owner: '', dataBase64: vaultBytes(baseBefore), lamports: 0n },
        { pubkey: addrs.poolQuoteTokenAccount, owner: '', dataBase64: vaultBytes(quoteBefore), lamports: 0n },
        await cachedAccount(mint),
        // Singletons, at their SDK-derived addresses. Neither moves with a swap.
        await cachedAccount(GLOBAL_CONFIG_ADDR),
        await cachedAccount(FEE_CONFIG_ADDR),
      ]);
    } catch (e) {
      c.status = 'STATE_UNAVAILABLE';
      c.detail = (e as Error).message.slice(0, 100);
      cases.push(c);
      continue;
    }

    const takerQuoteStr = c.takerQuoteDeltaLamports;
    const takerBaseStr = c.takerBaseDeltaAtoms;
    if (takerQuoteStr === null || takerBaseStr === null) {
      c.status = 'NO_TAKER_DELTA';
      cases.push(c);
      continue;
    }
    try {
      if (c.side === 'buy') {
        // Priced on what the taker PAID; compared against what they received.
        const q = quoteBuyFrom(src, pool, BigInt(takerQuoteStr), SLIPPAGE_PCT);
        c.modelOutput = q.baseOutAtoms.toString();
        const actual = BigInt(takerBaseStr);
        c.residualBps = actual === 0n ? null : Number(((q.baseOutAtoms - actual) * 10_000n) / actual);
      } else {
        const q = quoteSellFrom(src, pool, BigInt(takerBaseStr), SLIPPAGE_PCT);
        c.modelOutput = q.quoteOutLamports.toString();
        const actual = BigInt(takerQuoteStr);
        c.residualBps = actual === 0n ? null : Number(((q.quoteOutLamports - actual) * 10_000n) / actual);
      }
      /**
       * Whether the taker-side quantity can be trusted for THIS transaction.
       *
       * The quote leg is the fragile one. A buy funds its wrapped-SOL account
       * with a slippage-padded `maxQuoteIn` and gets the remainder back on
       * close, so the account's net movement is not what the swap consumed; a
       * native-balance reading additionally absorbs priority fees, tips and any
       * account rent paid in the same transaction. Both produce a quote figure
       * that is larger than the price and a residual that measures the padding.
       *
       * Rather than publish a median over a mixture of clean and contaminated
       * readings — the first pass did, and its median of 0 bps was an artefact
       * of the spread rather than a result — a case whose residual exceeds what
       * the fee table can explain is marked uncertain and excluded from the
       * headline. It is kept in the artifact with its numbers so the
       * attribution can be argued with.
       */
      const ATTRIBUTABLE_BPS = 300;
      c.status =
        c.residualBps !== null && Math.abs(c.residualBps) > ATTRIBUTABLE_BPS
          ? 'ATTRIBUTION_UNCERTAIN'
          : 'COMPARED';
      if (c.status === 'ATTRIBUTION_UNCERTAIN') {
        c.detail =
          'the taker-side quantity could not be isolated: a padded wrapped-SOL funding, a priority fee, ' +
          'a tip or account rent in the same transaction all move it without being part of the price';
      }
    } catch (e) {
      c.status = 'MODEL_UNAVAILABLE';
      c.detail = (e as Error).message.slice(0, 120);
    }
    cases.push(c);
    console.log(
      `  ${signature.slice(0, 10)} ${c.side.padEnd(5)} ${c.shape.padEnd(6)} ${c.status}` +
        (c.residualBps === null ? '' : `  residual ${c.residualBps} bps`),
    );
  }
}

/** A 165-byte SPL token account whose only meaningful field is the amount. */
function vaultBytes(amount: bigint): string {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

const comparedAll = cases.filter((c) => c.status === 'COMPARED');
const direct = comparedAll.filter((c) => c.shape === 'DIRECT');
const routed = comparedAll.filter((c) => c.shape === 'ROUTED');

/**
 * The two readings are not equally good, and mixing them hid that.
 *
 * MEASURED: the quote side came from the taker's own wrapped-quote token
 * account. That is a direct reading of the swap's proceeds.
 *
 * INFERRED: it came from the taker's native balance, which also moves for
 * priority fees, tips and any account rent paid in the same transaction. The
 * transaction fee is added back; nothing else can be, because nothing else is
 * separable from the outside.
 *
 * Splitting them turned out to be the whole explanation of the residuals: every
 * measured case is exactly zero, and every non-zero residual is an inferred one.
 * The headline is the measured set; the inferred set is reported beside it as
 * indicative and is not evidence about the model.
 */
const MEASURED_SOURCE = 'taker wrapped-quote account';
const compared = direct.filter((c) => c.quoteSource === MEASURED_SOURCE);
const inferred = direct.filter((c) => c.quoteSource !== MEASURED_SOURCE);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
};

const summary = {
  provenance: currentProvenance({ strategyVersion: 'delayed-momentum-v0.6.0', schemaVersion: 'schema-v34' }),
  endpoint: host,
  attempted: cases.length,
  compared: compared.length,
  buys: compared.filter((c) => c.side === 'buy').length,
  sells: compared.filter((c) => c.side === 'sell').length,
  exact: compared.filter((c) => c.residualBps === 0).length,
  medianResidualBps: median(compared.map((c) => c.residualBps).filter((n): n is number => n !== null)),
  directTotal: direct.length,
  inferredQuote: inferred.length,
  inferredMedianResidualBps: median(inferred.map((c) => c.residualBps).filter((n): n is number => n !== null)),
  routed: routed.length,
  routedMedianResidualBps: median(routed.map((c) => c.residualBps).filter((n): n is number => n !== null)),
  attributionUncertain: cases.filter((c) => c.status === 'ATTRIBUTION_UNCERTAIN').length,
  cases,
  note:
    'Reserves before the swap come from meta.preTokenBalances, which the transaction carries, so no ' +
    'archival access is needed. A residual here is the model disagreeing with the CHAIN rather than ' +
    'with another copy of this system. Only DIRECT single-hop swaps whose taker-side quantity could be ' +
    'isolated count toward the headline; the rest are kept with their numbers and excluded.',
  caveat:
    'The comparison is against the TAKER delta, not the pool vault delta. A first pass used the vault and ' +
    'found a residual of exactly -123 bps, which is the protocol and creator fee leaving the vault for ' +
    'accounts that are not the taker. Where the quote side had to be read from the native balance it is ' +
    'net of the transaction fee, and quoteSource records which reading each case used. A routed swap ' +
    'whose fee payer is not the beneficiary is reported as NO_TAKER_DELTA rather than attributed.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/landed-parity.json', JSON.stringify(summary, null, 2));

console.log(`\nattempted ${summary.attempted}  direct ${summary.directTotal}`);
console.log(`  MEASURED quote (headline)  ${summary.compared}  exact ${summary.exact}  median ${summary.medianResidualBps} bps`);
console.log(`  INFERRED quote (indicative) ${summary.inferredQuote}  median ${summary.inferredMedianResidualBps} bps`);
console.log(`  routed ${summary.routed}   attribution uncertain ${summary.attributionUncertain}`);
console.log('artifacts/landed-parity.json');
db.close();
