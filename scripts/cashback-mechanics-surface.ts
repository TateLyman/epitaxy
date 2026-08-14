import { writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { base58Encode } from '../packages/solana/src/base58.js';
import {
  userVolumeAccumulatorPda,
  globalVolumeAccumulatorPda,
  accumulatorWsolAta,
  decodeUserVolumeAccumulator,
  cashbackPositionFrom,
  cashbackAccrualRefusal,
  mechanicsStratum,
  claimIsWorthwhile,
  CashbackUndecodable,
} from '../packages/solana/src/cashback.js';
import { canonicalPool, poolAddressesFrom, accountSourceOf, WSOL_MINT, FEE_CONFIG_ADDR } from '../packages/solana/src/pumpswap-offline.js';
import { feeTiersOf, tierFor } from '../packages/solana/src/fee-tiers.js';
import { TOKEN_PROGRAM } from '../packages/solana/src/pda.js';

/**
 * P6 — the cashback mechanics surface, and a cross-check of every derivation
 * against the SDK's own.
 *
 * A PDA I derived from seeds I read out of an IDL is a claim about the IDL. The
 * SDK ships its own derivation; if the two disagree, mine is wrong, and finding
 * that out here is much cheaper than finding it out from an
 * `InvalidCashbackAccumulator` on a transaction that spent money.
 */

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const { rpc, host } = researchRpc(secrets as never);

  // 1. Cross-check the derivations against the shipped SDK.
  const sdk = await import('@pump-fun/pump-swap-sdk');
  const { PublicKey } = await import('@solana/web3.js');
  const sampleUser = 'CVXFtBqZTNPNMqTPGgFxTCJKGSPkyEBHYWTmXVvQsFtR';

  // `pumpAmmPda` returns a PublicKey directly, not an [address, bump] tuple.
  const mine = userVolumeAccumulatorPda(sampleUser);
  const theirs = (sdk as unknown as { userVolumeAccumulatorPda: (u: unknown) => { toBase58(): string } })
    .userVolumeAccumulatorPda(new PublicKey(sampleUser))
    .toBase58();
  const globalMine = globalVolumeAccumulatorPda();
  const globalTheirs = (sdk as unknown as { GLOBAL_VOLUME_ACCUMULATOR_PDA: { toBase58(): string } })
    .GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58();

  // And the ATA, which the SDK derives with allowOwnerOffCurve — the accumulator
  // is a PDA, so a derivation that refuses off-curve owners would be wrong here.
  //
  // `coinCreatorVaultAtaPda` IS `getAssociatedTokenAddressSync(quoteMint, owner,
  // true, quoteTokenProgram)` — the same call the SDK makes for the accumulator
  // ATA. Passing the accumulator PDA as the owner cross-checks the identical
  // derivation without adding @solana/spl-token as a dependency.
  const ataMine = accumulatorWsolAta(mine, WSOL_MINT, TOKEN_PROGRAM);
  const ataTheirs = (
    sdk as unknown as {
      coinCreatorVaultAtaPda: (owner: unknown, mint: unknown, program: unknown) => { toBase58(): string };
    }
  )
    .coinCreatorVaultAtaPda(new PublicKey(theirs), new PublicKey(WSOL_MINT), new PublicKey(TOKEN_PROGRAM))
    .toBase58();

  const derivations = {
    userVolumeAccumulator: { mine, sdk: theirs, agree: mine === theirs },
    globalVolumeAccumulator: { mine: globalMine, sdk: globalTheirs, agree: globalMine === globalTheirs },
    accumulatorWsolAta: { mine: ataMine, sdk: ataTheirs, agree: ataMine === ataTheirs },
  };

  // 2. The fee/cashback surface across every official tier.
  const feeRaw = await rpc.getAccountRaw(FEE_CONFIG_ADDR);
  const decodedFeeConfig = new sdk.PumpAmmSdk().decodeFeeConfig({
    owner: new PublicKey(feeRaw.owner),
    data: Buffer.from(feeRaw.dataBase64, 'base64'),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  const tiers = feeTiersOf(decodedFeeConfig).map((t) => ({
    marketCapLamportsThreshold: t.marketCapLamportsThreshold.toString(),
    lpBps: t.fees.lpFeeBps,
    protocolBps: t.fees.protocolFeeBps,
    creatorBps: t.fees.creatorFeeBps,
    perLegTotalBps: t.fees.totalBps,
    roundTripBps: t.roundTripBps,
    // Cashback can only ever return the CREATOR portion, and only on the BUY
    // leg, because `sell` carries no volume accumulator account in the IDL. So
    // the recoverable amount is one leg's creator fee, not two.
    creatorBpsPerLeg: t.fees.creatorFeeBps,
    maxCashbackRecoverableRoundTripBps: t.fees.creatorFeeBps,
    roundTripBpsIfCashbackFullyRecovered: t.roundTripBps - t.fees.creatorFeeBps,
  }));

  // 3. Live cashback coins from the corpus, with their real accumulator state.
  const db = new DatabaseSync(secrets.databasePath, { readOnly: true });
  const mints = (db.prepare('SELECT DISTINCT mint FROM screenings ORDER BY rowid DESC LIMIT 600').all() as {
    mint: string;
  }[]).map((r) => r.mint);
  db.close();

  const coins: unknown[] = [];
  for (const mint of mints) {
    if (coins.length >= 8) break;
    let pool: string;
    try {
      pool = canonicalPool(mint);
    } catch {
      continue;
    }
    let raw;
    try {
      raw = await rpc.getAccountRaw(pool);
    } catch {
      continue;
    }
    let addrs;
    try {
      addrs = poolAddressesFrom(
        accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
        pool,
      );
    } catch {
      continue;
    }

    const quoteTotal = 0n;
    const tier = tierFor(feeTiersOf(decodedFeeConfig), quoteTotal);
    const stratum = mechanicsStratum({ canonicalPool: true, cashbackCoin: addrs.isCashbackCoin === true });
    const ata = accumulatorWsolAta(userVolumeAccumulatorPda(sampleUser), WSOL_MINT, TOKEN_PROGRAM);

    coins.push({
      mint,
      pool,
      isCashbackCoin: addrs.isCashbackCoin,
      isMayhemMode: addrs.isMayhemMode,
      quoteMint: addrs.quoteMint,
      stratum,
      bottomTierRoundTripBps: tier?.roundTripBps ?? null,
      accumulatorWsolAtaForSampleUser: ata,
      // The fail-closed check, evaluated for a builder that forgot the account.
      refusalWhenBuilderOmitsTheAccount: cashbackAccrualRefusal({
        isCashbackCoin: addrs.isCashbackCoin === true,
        remainingAccounts: [],
        expectedAccumulatorWsolAta: ata,
      }),
      refusalWhenBuilderIncludesIt: cashbackAccrualRefusal({
        isCashbackCoin: addrs.isCashbackCoin === true,
        remainingAccounts: [ata],
        expectedAccumulatorWsolAta: ata,
      }),
    });
  }

  // 4. A real accumulator, if the sample user has one. Absence is a fact too.
  const accumulatorAddr = userVolumeAccumulatorPda(sampleUser);
  let accumulatorState: unknown = { exists: false, note: 'the sample user has never traded a cashback coin' };
  try {
    const a = await rpc.getAccountRaw(accumulatorAddr);
    const decoded = decodeUserVolumeAccumulator(Buffer.from(a.dataBase64, 'base64'), base58Encode);
    const ataAddr = accumulatorWsolAta(accumulatorAddr, WSOL_MINT, TOKEN_PROGRAM);
    let wsol: bigint | null = null;
    try {
      const w = await rpc.getAccountRaw(ataAddr);
      wsol = Buffer.from(w.dataBase64, 'base64').readBigUInt64LE(64);
    } catch {
      wsol = null;
    }
    const pos = cashbackPositionFrom({ accumulator: decoded, accumulatorWsolLamports: wsol });
    accumulatorState = {
      exists: true,
      address: accumulatorAddr,
      cashbackEarned: decoded.cashbackEarned.toString(),
      totalCashbackClaimed: decoded.totalCashbackClaimed.toString(),
      currentSolVolume: decoded.currentSolVolume.toString(),
      needsClaim: decoded.needsClaim,
      accruedLamports: pos.accruedLamports.toString(),
      claimableLamports: pos.claimableLamports.toString(),
      claimedLamports: pos.claimedLamports.toString(),
      caveats: pos.caveats,
    };
  } catch (e) {
    if (e instanceof CashbackUndecodable) accumulatorState = { exists: true, undecodable: e.reason };
  }

  const surface = {
    host,
    derivationsCrossCheckedAgainstSdk: derivations,
    idlFacts: {
      sellHasNoVolumeAccumulator: true,
      sellHasNoVolumeAccumulatorNote:
        'Only `buy` carries user_volume_accumulator in the pump_amm IDL. Cashback accrues on BUY volume, not round-trip volume.',
      accumulatorWsolAtaIsOptionalRemainingAccount: true,
      buyDocs:
        'For cashback coins, optionally pass user_volume_accumulator_wsol_ata as remaining_accounts[0]. If provided and valid, the ATA will be initialized if needed.',
      failClosedConsequence:
        'Optional means a builder that omits it still lands a valid trade that accrues nothing, and the creator fee goes to the creator.',
      claimCashbackAccounts: [
        'user',
        'user_volume_accumulator',
        'quote_mint',
        'quote_token_program',
        'user_volume_accumulator_wsol_token_account',
        'user_wsol_token_account',
        'system_program',
        'event_authority',
        'program',
      ],
    },
    feeAndCashbackSurface: tiers,
    liveCoins: coins,
    sampleAccumulator: accumulatorState,
    claimAmortisation: {
      tinyClaimIsALoss: claimIsWorthwhile({ claimableLamports: 900n, claimCostLamports: 5_000n }),
      realClaimIsWorthwhile: claimIsWorthwhile({
        claimableLamports: 400_000n,
        claimCostLamports: 5_000n,
        amortisedOverTrajectories: 40,
      }),
    },
    ok:
      derivations.userVolumeAccumulator.agree &&
      derivations.globalVolumeAccumulator.agree &&
      derivations.accumulatorWsolAta.agree,
  };

  mkdirSync('artifacts', { recursive: true });
  // Decimal strings, never Number: a lamport figure that crossed a double would
  // be silently wrong in exactly the artifact meant to be authoritative.
  const asDecimalStrings = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  writeFileSync('artifacts/cashback-mechanics-surface.json', JSON.stringify(surface, asDecimalStrings, 2) + '\n');
  console.log('derivations agree with the SDK:', JSON.stringify(derivations, null, 2));
  console.log('fee tiers:', tiers.length);
  console.log('  bottom tier:', JSON.stringify(tiers[0]));
  console.log('  top tier   :', JSON.stringify(tiers[tiers.length - 1]));
  console.log('live coins sampled:', coins.length);
  console.log('cashback coins    :', coins.filter((c) => (c as { isCashbackCoin: boolean }).isCashbackCoin).length);
  console.log('sample accumulator:', JSON.stringify(accumulatorState));
  console.log('ok:', surface.ok);
  if (!surface.ok) process.exitCode = 1;
}

await main();
