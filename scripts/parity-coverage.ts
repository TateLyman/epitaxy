/**
 * P14 — find the mints that would close the parity matrix's coverage gaps.
 *
 * The matrix sampled whatever recent mints had a canonical pool, and every one
 * turned out to be Token-2022 base, wrapped-SOL quote, sitting in the bottom fee
 * tier. Three cells were therefore untested, and "we did not sample one" is not
 * the same claim as "none exists" — `mint-facts-status` already showed 879
 * legacy SPL mints in the corpus.
 *
 * This selects candidates for each gap, from the corpus and the chain:
 *
 *   LEGACY_BASE      a pool whose base mint is legacy SPL Token
 *   NON_SOL_QUOTE    a pool quoting something other than wrapped SOL
 *   TIER_BOUNDARY    two pools straddling a dynamic-fee threshold
 *
 * It writes the list rather than running the matrix, so the selection is a
 * visible, reviewable artifact instead of a hidden filter inside a run.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc } from '../packages/solana/src/rpc.js';
import { PumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk';
import { PublicKey } from '@solana/web3.js';
import {
  accountSourceOf,
  poolAddressesFrom,
  poolFactsFrom,
  canonicalPool,
  WSOL_MINT,
} from '../packages/solana/src/pumpswap-offline.js';
import { feeTiersOf, tierForPool, boundaries } from '../packages/solana/src/fee-tiers.js';
import { TOKEN_PROGRAM } from '../packages/solana/src/mint.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const OVERRIDE = process.env['RPC_ENDPOINT'] ?? null;
const secrets = loadSecrets();
const endpoint = OVERRIDE ?? secrets.rpcHttp;
if (endpoint === null) {
  console.error('set RPC_ENDPOINT or configure an endpoint');
  process.exit(1);
}
const rpc = new SolanaRpc(RateLimiter.fromConfig(OVERRIDE === null), { primary: endpoint, fallback: null });
const db = openDb({ path: secrets.databasePath, readonly: true });

const SCAN = Number(process.env['COVERAGE_SCAN'] ?? 120);

interface Found {
  mint: string;
  pool: string;
  baseTokenProgram: string;
  quoteMint: string;
  baseReserve: string;
  quoteReserve: string;
  /** Effective quote reserve doubles as a market-cap proxy for tier selection. */
  effectiveQuoteLamports: string;
  tierThresholdLamports: string | null;
  tierRoundTripBps: number | null;
  categories: string[];
}

// The fee table, once.
let tiers: ReturnType<typeof feeTiersOf> = [];
try {
  const raw = await rpc.getAccountRaw(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  tiers = feeTiersOf(
    new PumpAmmSdk().decodeFeeConfig({
      owner: new PublicKey(raw.owner),
      data: Buffer.from(raw.dataBase64, 'base64'),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }),
  );
} catch (e) {
  console.error(`the fee config could not be read: ${(e as Error).message.slice(0, 80)}`);
}

/**
 * Legacy-base candidates come from the corpus, which already knows which mints
 * are legacy — that read was P11's whole point and it costs nothing here.
 */
const legacyMints = db
  .prepare(
    `SELECT mint FROM direct_mint_facts WHERE token_program = ? ORDER BY read_utc_ms DESC LIMIT ?`,
  )
  .all(TOKEN_PROGRAM, SCAN) as { mint: string }[];

const recentMints = db
  .prepare(
    `SELECT DISTINCT mint FROM execution_observations
      WHERE side='buy' AND received_utc_ms > ? ORDER BY received_utc_ms DESC LIMIT ?`,
  )
  .all(Date.now() - 7 * 86_400_000, SCAN) as { mint: string }[];

const seen = new Set<string>();
const found: Found[] = [];

async function examine(mint: string, wantedFrom: string): Promise<void> {
  if (seen.has(mint)) return;
  seen.add(mint);
  const pool = canonicalPool(mint);
  try {
    const poolRow = await (async () => {
      const raw = await rpc.getAccountRaw(pool);
      return { pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports };
    })();
    const addrs = poolAddressesFrom(accountSourceOf([poolRow]), pool);
    const vaults = await Promise.all(
      [addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount].map(async (pubkey) => {
        const raw = await rpc.getAccountRaw(pubkey);
        return { pubkey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports };
      }),
    );
    const facts = poolFactsFrom(accountSourceOf([poolRow, ...vaults]), pool);
    const effective = facts.quoteReserveRaw + facts.virtualQuoteReserves;
    // F15 - the tier is selected by MARKET CAP, not by quote reserve.
    const tier = tierForPool(tiers, {
      quoteReserveLamports: effective,
      baseReserveAtoms: facts.baseReserve,
      baseMintSupplyAtoms: facts.baseMintSupplyAtoms,
    }).tier;

    const categories: string[] = [];
    if (facts.baseTokenProgram === TOKEN_PROGRAM) categories.push('LEGACY_BASE');
    if (facts.quoteMint !== WSOL_MINT) categories.push('NON_SOL_QUOTE');
    if (tier !== null && tier.marketCapLamportsThreshold > 0n) categories.push('ABOVE_BOTTOM_TIER');
    if (categories.length === 0) return;

    found.push({
      mint,
      pool,
      baseTokenProgram: facts.baseTokenProgram,
      quoteMint: facts.quoteMint,
      baseReserve: facts.baseReserve.toString(),
      quoteReserve: facts.quoteReserveRaw.toString(),
      effectiveQuoteLamports: effective.toString(),
      tierThresholdLamports: tier === null ? null : tier.marketCapLamportsThreshold.toString(),
      tierRoundTripBps: tier?.roundTripBps ?? null,
      categories,
    });
    console.log(`  ${mint.slice(0, 12)} ${categories.join('+')} (from ${wantedFrom}) tier ${tier?.roundTripBps ?? '?'} bps`);
  } catch {
    // No pool, or unreadable. Neither is a finding.
  }
}

console.log(`scanning ${legacyMints.length} legacy and ${recentMints.length} recent mints for coverage gaps\n`);
for (const { mint } of legacyMints) await examine(mint, 'legacy');
for (const { mint } of recentMints) await examine(mint, 'recent');

const byCategory = (c: string): Found[] => found.filter((f) => f.categories.includes(c));
const aboveBottom = byCategory('ABOVE_BOTTOM_TIER');
/** False when the fee table itself could not be loaded. Not the same as "bottom". */
const bottomTierSeen = tiers.length > 0;

const summary = {
  provenance: currentProvenance({ strategyVersion: 'delayed-momentum-v0.6.0', schemaVersion: 'schema-v34' }),
  scanned: seen.size,
  found: found.length,
  legacyBase: byCategory('LEGACY_BASE').map((f) => f.mint),
  nonSolQuote: byCategory('NON_SOL_QUOTE').map((f) => f.mint),
  aboveBottomTier: aboveBottom.map((f) => ({ mint: f.mint, roundTripBps: f.tierRoundTripBps })),
  feeTableLoaded: bottomTierSeen,
  boundariesAvailable: bottomTierSeen ? boundaries(tiers).length : null,
  candidates: found,
  reading: [
    byCategory('LEGACY_BASE').length > 0
      ? `${byCategory('LEGACY_BASE').length} legacy-base pool(s) found — the cell is samplable`
      : 'no legacy-base pool found among the scanned mints; the corpus has legacy MINTS but they may not have pools',
    byCategory('NON_SOL_QUOTE').length > 0
      ? `${byCategory('NON_SOL_QUOTE').length} non-SOL-quote pool(s) found`
      : 'every pool scanned quotes wrapped SOL',
    !bottomTierSeen
      ? 'the fee config could not be read, so NO pool was assigned a tier; this says nothing about ' +
        'where they sit and must not be read as "all in the bottom tier"'
      : aboveBottom.length > 0
        ? `${aboveBottom.length} pool(s) above the bottom fee tier — a boundary straddle is possible`
        : 'every pool scanned sits in the bottom fee tier, so no straddle is available from this sample',
  ],
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/parity-coverage.json', JSON.stringify(summary, null, 2));

console.log(`\nscanned ${summary.scanned}  found ${summary.found}`);
for (const r of summary.reading) console.log(`  ${r}`);
console.log('\nartifacts/parity-coverage.json');
db.close();
