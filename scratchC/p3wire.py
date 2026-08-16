# -*- coding: utf-8 -*-
import io, sys


def rw(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) != 1:
            print('MISS(%d) in %s: %s' % (s.count(old), path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


# ---------------------------------------------- round trip: scope the output --
rw('packages/pipeline/src/sequential-round-trip.ts', [
    (
        '  readonly observe: readonly string[];',
        '''  readonly observe: readonly string[];
  /**
   * F8 — which observed accounts the run needs the BYTES of.
   *
   * The price-bearing set, essentially: the sell is BUILT from those bytes, so
   * they must come back in full. Everything else is observed for its balance,
   * its owner and whether it was created, none of which needs a payload.
   *
   * Omitting this returns every payload, which is what emitted ~280 MB on a
   * size surface and killed the worker.
   */
  readonly economicAccounts?: readonly string[];''',
    ),
    (
        """    const buy = await w.step({ label: 'buy', transactionBase64: req.buyTransactionBase64, observe: [...req.observe] });""",
        """    // The bytes the sell will be built from must come back; the rest need
    // only their balances. `priceBearingAccounts` is the floor, because
    // `buildSell` decodes exactly those.
    const economic = req.economicAccounts ?? req.priceBearingAccounts;
    const buy = await w.step(
      { label: 'buy', transactionBase64: req.buyTransactionBase64, observe: [...req.observe] },
      economic,
    );""",
    ),
    (
        '    const quoted = await w.observe(req.priceBearingAccounts);',
        '    const quoted = await w.observe(req.priceBearingAccounts, economic);',
    ),
    (
        """    const sell = await w.step({ label: 'sell', transactionBase64: sellBytes, observe: [...req.observe] });""",
        """    const sell = await w.step(
      { label: 'sell', transactionBase64: sellBytes, observe: [...req.observe] },
      economic,
    );""",
    ),
])

# --------------------------------- open-trajectory: keep the coherent snapshot --
rw('packages/pipeline/src/open-trajectory.ts', [
    (
        """  try {
    await captureCoherentSnapshotV2(
      rpc as never,""",
        """  let coherent;
  try {
    coherent = await captureCoherentSnapshotV2(
      rpc as never,""",
    ),
    (
        """      pubkey: p.taker,
      dataBase64: '',
      owner: '11111111111111111111111111111111',
      lamports: p.fundedWalletLamports ?? 500_000_000_000n,
      executable: false,
      rentEpoch: 0n,""",
        """      pubkey: p.taker,
      dataBase64: '',
      owner: '11111111111111111111111111111111',
      lamports: p.fundedWalletLamports ?? 500_000_000_000n,
      executable: false,
      // Exempt, like every funded system account on mainnet. Rent epoch 0
      // restores it as rent-PAYING, which is a different account.
      rentEpoch: RENT_EXEMPT_EPOCH,""",
    ),
    (
        """      snapshot: {
        programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
        accounts: withWallet as never,
        slot: snapshot.slot,
        unixTimestamp: snapshot.unixTimestamp,
      },""",
        """      snapshot: {
        programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
        accounts: withWallet as never,
        slot: snapshot.slot,
        unixTimestamp: snapshot.unixTimestamp,
        /**
         * F9 — the sysvars the COHERENT snapshot actually decoded.
         *
         * These were computed and discarded: the coherent capture ran purely as
         * a drift check and its clock, rent and epoch schedule went nowhere,
         * while the runtime derived `epoch = slot / 432_000` and left Rent at a
         * default. That is wrong by five epochs at today's slot, and a program
         * sizing an account it creates got a rent answer mainnet never gave.
         *
         * Required rather than optional: this caller DID capture exact state,
         * so accepting a derived clock would be an approximation wearing the
         * label of a capture.
         */
        clock: coherent.clock,
        rent: coherent.rent,
        epochSchedule: coherent.epochSchedule,
        requireExactSysvars: true,
        // Without the pool and its vaults this runtime is not the one we asked
        // for, and the failure would read as a fact about the token.
        requiredAccounts: priceBearing,
        requiredPrograms: [...SWAP_PROGRAM_IDS],
      },""",
    ),
    (
        '      priceBearingAccounts: priceBearing,',
        """      priceBearingAccounts: priceBearing,
      // F8 — the sell is built from these bytes. Everything else in `observe`
      // is watched for its balance and whether it was created, and needs no
      // payload at all.
      economicAccounts: priceBearing,""",
    ),
    (
        "import { observedTokenAtoms } from '../../simulator/src/sequential-runtime.js';",
        "import { observedTokenAtoms, RENT_EXEMPT_EPOCH } from '../../simulator/src/sequential-runtime.js';",
    ),
])
