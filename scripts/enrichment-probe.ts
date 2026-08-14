/**
 * A direct exercise of the P11 enrichment paths, against real mints.
 *
 * Both `measureMayhem` and `measureEntities` run only for candidates that reach
 * the quote stage, and eligibility is about a quarter of one per cent. Waiting
 * for the live loop to exercise them is waiting for a coin flip that lands once
 * an hour, and "it did not run yet" is indistinguishable from "it does not
 * work".
 *
 * This calls the same functions on the same inputs, writes to the same tables,
 * and reports what it found — so the wiring is demonstrated rather than
 * asserted. Read-mostly: it writes only the two enrichment tables.
 */
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc, fetchConcentration } from '../packages/solana/src/rpc.js';
import { canonicalPool, poolAddressesFrom, accountSourceOf } from '../packages/solana/src/pumpswap-offline.js';
import { mayhemFactsOf, breadthUsability } from '../packages/solana/src/mayhem.js';
import { buildEntityLinks, entityConcentrationFrom } from '../packages/intelligence/src/entity-links.js';

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath });
if (secrets.rpcHttp === null) {
  console.error('an RPC endpoint is required');
  process.exit(1);
}
const rpc = new SolanaRpc(RateLimiter.fromConfig(true), {
  primary: secrets.rpcHttp,
  fallback: secrets.rpcHttpFallback,
});

const LIMIT = Number(process.env['PROBE_MINTS'] ?? 4);
/**
 * Mints that are known to have a canonical pool, when the caller supplies them.
 *
 * A pre-migration mint has no pool, so its Mayhem mode reads null and its
 * entity concentration has nothing to cluster. Probing a random recent mint
 * therefore exercises the "not established" branch and nothing else, which
 * demonstrates the refusal but not the reading.
 */
const explicit = (process.env['PROBE_MINTS_LIST'] ?? '').split(',').filter((x) => x.length > 0);
const mints =
  explicit.length > 0
    ? explicit.map((mint) => ({ mint }))
    : (db
        .prepare(
          `SELECT DISTINCT mint FROM execution_observations
            WHERE side='buy' AND exact_transaction_blob IS NOT NULL AND received_utc_ms > ?
            ORDER BY received_utc_ms DESC LIMIT ?`,
        )
        .all(Date.now() - 7 * 86_400_000, LIMIT * 8) as { mint: string }[]);

let done = 0;
for (const { mint } of mints) {
  if (done >= LIMIT) break;

  // ---- Mayhem, from the pool the pricing already decodes -----------------
  const poolKey = canonicalPool(mint);
  let isMayhem: boolean | null = null;
  try {
    const raw = await rpc.getAccountRaw(poolKey);
    isMayhem = poolAddressesFrom(
      accountSourceOf([{ pubkey: poolKey, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
      poolKey,
    ).isMayhemMode;
  } catch {
    isMayhem = null;
  }
  const f = mayhemFactsOf({ mint, nowUtcMs: Date.now(), poolIsMayhemMode: isMayhem });
  const breadth = breadthUsability(f);
  db.prepare(
    `INSERT INTO mayhem_facts (mint, observed_utc_ms, enabled, agent_state, source)
     VALUES (?,?,?,?,?)
     ON CONFLICT(mint) DO UPDATE SET observed_utc_ms=excluded.observed_utc_ms,
       enabled=excluded.enabled, agent_state=excluded.agent_state, source=excluded.source`,
  ).run(mint, f.observedUtcMs, f.enabled === null ? null : f.enabled ? 1 : 0, `${breadth.usability}: ${breadth.reason}`.slice(0, 400), f.source);

  // ---- entity links, from real funding history ---------------------------
  let entityLine = 'concentration unavailable';
  try {
    const facts = await fetchConcentration(rpc, mint);
    const holders = facts.holders
      .filter((h) => h.owner !== null && !h.programControlled)
      .map((h) => ({ address: h.owner as string, amount: h.amount }));
    if (holders.length >= 2) {
      const built = await buildEntityLinks(
        {
          oldestSignatures: async (address, limit) => (await rpc.getSignaturesForAddress(address, 50)).slice(-limit),
          feePayerOf: (signature) => rpc.getTransactionFeePayer(signature),
        },
        holders,
        { maxHolders: 10 },
      );
      const r = entityConcentrationFrom(built);
      db.prepare(
        `INSERT INTO entity_concentration
           (mint, measured_utc_ms, address_count, entity_count, unknown_history_count, trustworthy,
            top_entity_1_bps, top_entity_5_bps, top_entity_10_bps, top_entity_20_bps,
            top_address_1_bps, top_address_5_bps, top_address_10_bps, top_address_20_bps, links_built, detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET measured_utc_ms=excluded.measured_utc_ms,
           entity_count=excluded.entity_count, links_built=excluded.links_built, detail=excluded.detail`,
      ).run(
        mint,
        Date.now(),
        r.addressCount,
        r.entityCount,
        r.unknownHistoryCount,
        r.trustworthy ? 1 : 0,
        r.topEntityBps[1],
        r.topEntityBps[5],
        r.topEntityBps[10],
        r.topEntityBps[20],
        r.topAddressBps[1],
        r.topAddressBps[5],
        r.topAddressBps[10],
        r.topAddressBps[20],
        built.links.length,
        [r.detail, ...built.notes].join(' | ').slice(0, 500),
      );
      entityLine =
        `addr ${r.addressCount} -> ent ${r.entityCount}, links ${built.links.length}, ` +
        `top10 ${r.topAddressBps[10]} -> ${r.topEntityBps[10]} bps, trustworthy ${r.trustworthy}`;
    } else {
      entityLine = `only ${holders.length} non-program holder(s)`;
    }
  } catch (e) {
    entityLine = `concentration failed: ${(e as Error).message.slice(0, 70)}`;
  }

  console.log(`${mint.slice(0, 12)}  mayhem=${f.enabled} (${f.source})  ${breadth.usability}`);
  console.log(`              ${entityLine}`);
  done += 1;
}

console.log(`\nprobed ${done} mint(s)`);
db.close();
