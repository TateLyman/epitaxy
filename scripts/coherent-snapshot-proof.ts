import { writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { base58Encode } from '../packages/solana/src/base58.js';
import {
  captureCoherentSnapshotV2,
  SnapshotIncoherent,
  type CoherentSnapshotV2,
} from '../packages/solana/src/coherent-snapshot.js';
import {
  canonicalPool,
  poolAddressesFrom,
  poolFactsFrom,
  accountSourceOf,
  GLOBAL_CONFIG_ADDR,
  FEE_CONFIG_ADDR,
} from '../packages/solana/src/pumpswap-offline.js';
import { feeTiersOf, tierFor } from '../packages/solana/src/fee-tiers.js';

/**
 * P2's required proof:
 *
 *   two independently decoded readers
 *   → same snapshot account set
 *   → same account hashes
 *   → same pool facts
 *   → same fee tier
 *
 * "Independent" means the two readers capture separately, at different wall
 * times, against the live chain — not one capture compared with itself. Two
 * captures of a MOVING pool will legitimately differ, and that is the point: the
 * proof is that when the underlying bytes are identical the derived facts are
 * identical, and when they are not, the snapshot SAYS so rather than blending
 * them. A blended set is the defect this module removes.
 */

function poolFactsOf(snap: CoherentSnapshotV2, pool: string) {
  const src = accountSourceOf(
    snap.accounts.map((a) => ({
      pubkey: a.pubkey,
      owner: a.owner,
      dataBase64: a.dataBase64,
      lamports: BigInt(a.lamports),
    })),
  );
  const facts = poolFactsFrom(src, pool);
  // The mechanics flags live on the addresses view, which decodes the pool's
  // mode fields; the facts view carries the reserves. Both are derived from the
  // SAME snapshot bytes, which is the property under proof.
  const addrs = poolAddressesFrom(src, pool);
  return {
    base: facts.baseReserve.toString(),
    quote: facts.quoteReserveRaw.toString(),
    virtualQuote: facts.virtualQuoteReserves.toString(),
    mayhem: addrs.isMayhemMode ?? null,
    cashback: addrs.isCashbackCoin ?? null,
  };
}

async function feeTierOf(snap: CoherentSnapshotV2, quoteTotal: bigint): Promise<number | null> {
  const row = snap.accounts.find((a) => a.pubkey === FEE_CONFIG_ADDR);
  if (row === undefined) return null;
  try {
    const { PumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
    const { PublicKey } = await import('@solana/web3.js');
    const decoded = new PumpAmmSdk().decodeFeeConfig({
      owner: new PublicKey(row.owner),
      data: Buffer.from(row.dataBase64, 'base64'),
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    });
    return tierFor(feeTiersOf(decoded), quoteTotal)?.roundTripBps ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);

  // A live migrated mint from the corpus: a proof against a fixture proves the
  // fixture.
  const db = new DatabaseSync(secrets.databasePath, { readOnly: true });
  const mints = (db.prepare('SELECT DISTINCT mint FROM screenings ORDER BY rowid DESC LIMIT 400').all() as {
    mint: string;
  }[]).map((r) => r.mint);
  db.close();

  let target: { mint: string; pool: string } | null = null;
  for (const mint of mints) {
    const pool = canonicalPool(mint);
    try {
      await rpc.getAccountRaw(pool);
      target = { mint, pool };
      break;
    } catch {
      /* most Pump mints never migrate; that is a fact about the stream */
    }
  }
  if (target === null) throw new Error('no migrated mint in the sampled corpus to prove against');

  const poolRaw = await rpc.getAccountRaw(target.pool);
  const addrs = poolAddressesFrom(
    accountSourceOf([
      { pubkey: target.pool, owner: poolRaw.owner, dataBase64: poolRaw.dataBase64, lamports: poolRaw.lamports },
    ]),
    target.pool,
  );

  const request = {
    economicAccounts: [target.pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount, target.mint],
    feeConfig: FEE_CONFIG_ADDR,
    staticAccounts: [GLOBAL_CONFIG_ADDR],
    requireDecodable: [target.pool, addrs.poolBaseTokenAccount, addrs.poolQuoteTokenAccount],
    commitment: 'confirmed' as const,
  };

  // Two independent readers. Separate capture calls, separate batches, separate
  // slots, decoded separately.
  const readerA = await captureCoherentSnapshotV2(rpc as never, request, base58Encode);
  const readerB = await captureCoherentSnapshotV2(rpc as never, request, base58Encode);

  const setA = readerA.accounts.map((a) => a.pubkey).sort();
  const setB = readerB.accounts.map((a) => a.pubkey).sort();
  const sameSet = JSON.stringify(setA) === JSON.stringify(setB);

  const hashesA = Object.fromEntries(readerA.accounts.map((a) => [a.pubkey, a.hash]));
  const hashesB = Object.fromEntries(readerB.accounts.map((a) => [a.pubkey, a.hash]));
  const changed = setA.filter((k) => hashesA[k] !== hashesB[k]);

  const factsA = poolFactsOf(readerA, target.pool);
  const factsB = poolFactsOf(readerB, target.pool);
  const tierA = await feeTierOf(readerA, BigInt(factsA.quote) + BigInt(factsA.virtualQuote));
  const tierB = await feeTierOf(readerB, BigInt(factsB.quote) + BigInt(factsB.virtualQuote));

  // The comparison has to be made over the ECONOMIC accounts alone.
  //
  // Comparing over ALL accounts makes the assertion vacuous: the Clock sysvar
  // advances every slot, so `bytesIdentical` is false on every run and a
  // "!bytesIdentical || ..." clause short-circuits to true without ever testing
  // the derivation. A proof that cannot fail is not a proof.
  const economicKeys = readerA.accounts.filter((a) => a.economicallyMutable).map((a) => a.pubkey);
  const economicChanged = economicKeys.filter((k) => hashesA[k] !== hashesB[k]);
  const bytesIdentical = changed.length === 0;
  const economicBytesIdentical = economicChanged.length === 0;
  const factsIdentical = JSON.stringify(factsA) === JSON.stringify(factsB);
  const tierIdentical = tierA === tierB;

  // Same price-bearing bytes ⇒ same price-bearing facts. When the pool DID move
  // the facts are allowed to differ; what is never allowed is a snapshot that
  // mixes the two states.
  const derivationIsAFunctionOfBytes = !economicBytesIdentical || (factsIdentical && tierIdentical);

  // Every capture is internally coherent, always. This is the real invariant.
  const coherentA = readerA.economicDriftSlots <= readerA.driftBoundSlots;
  const coherentB = readerB.economicDriftSlots <= readerB.driftBoundSlots;

  // And the negative case: a deliberately impossible drift bound must REFUSE
  // rather than blend, which is what the old capture did silently.
  let refusedWhenIncoherent: string | null = null;
  try {
    await captureCoherentSnapshotV2(
      rpc as never,
      { ...request, economicAccounts: [...request.economicAccounts], driftBoundSlots: -1 },
      base58Encode,
    );
  } catch (e) {
    refusedWhenIncoherent = e instanceof SnapshotIncoherent ? e.reason.slice(0, 120) : (e as Error).message.slice(0, 120);
  }

  const ok =
    sameSet && derivationIsAFunctionOfBytes && coherentA && coherentB && refusedWhenIncoherent !== null;

  const proof = {
    generatedForHost: host,
    mint: target.mint,
    pool: target.pool,
    readerA: {
      snapshotHash: readerA.snapshotHash,
      captureSlotLow: readerA.captureSlotLow,
      captureSlotHigh: readerA.captureSlotHigh,
      economicDriftSlots: readerA.economicDriftSlots,
      blockTimeUnix: readerA.blockTimeUnix,
      batchSlots: readerA.batchSlots,
      accounts: readerA.accounts.length,
      omissions: readerA.omissions,
      incompleteness: readerA.incompleteness,
      clockSlot: readerA.clock?.slot ?? null,
      rentLamportsPerByteYear: readerA.rent?.lamportsPerByteYear ?? null,
      slotsPerEpoch: readerA.epochSchedule?.slotsPerEpoch ?? null,
      feeConfigHash: readerA.feeConfigHash,
    },
    readerB: {
      snapshotHash: readerB.snapshotHash,
      captureSlotLow: readerB.captureSlotLow,
      captureSlotHigh: readerB.captureSlotHigh,
      economicDriftSlots: readerB.economicDriftSlots,
      blockTimeUnix: readerB.blockTimeUnix,
      batchSlots: readerB.batchSlots,
      accounts: readerB.accounts.length,
      feeConfigHash: readerB.feeConfigHash,
    },
    comparison: {
      sameAccountSet: sameSet,
      accountsWhoseBytesChangedBetweenCaptures: changed,
      economicAccountsWhoseBytesChanged: economicChanged,
      bytesIdentical,
      // The one that carries the weight. When this is true the derived facts
      // below are being genuinely tested rather than skipped.
      economicBytesIdentical,
      poolFactsA: factsA,
      poolFactsB: factsB,
      poolFactsIdentical: factsIdentical,
      feeTierA: tierA,
      feeTierB: tierB,
      feeTierIdentical: tierIdentical,
      derivationIsAFunctionOfBytes,
    },
    coherence: { readerAInternallyCoherent: coherentA, readerBInternallyCoherent: coherentB },
    refusedWhenBoundImpossible: refusedWhenIncoherent,
    ok,
  };

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/coherent-snapshot-proof.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof.comparison, null, 2));
  console.log('drift A/B:', readerA.economicDriftSlots, readerB.economicDriftSlots);
  console.log('refused when bound impossible:', refusedWhenIncoherent);
  console.log('ok:', ok);
  if (!ok) process.exitCode = 1;
}

await main();
