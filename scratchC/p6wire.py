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


rw('packages/pipeline/src/open-trajectory.ts', [
    (
        "import { freezeAccountPlan, planAccountsNotCaptured, type AccountPlan } from '../../solana/src/account-plan.js';",
        "import { freezeAccountPlan, planAccountsNotCaptured, type AccountPlan } from '../../solana/src/account-plan.js';\n"
        "import {\n"
        "  classifyCreatedAccount,\n"
        "  summariseSetup,\n"
        "  requiresSharedAccountCreation,\n"
        "  type CreatedAccount,\n"
        "  type SetupEconomics,\n"
        "} from '../../solana/src/created-accounts.js';",
    ),
    (
        """  /**
   * P2/F12 — the exact plan of the bytes that ran.
   *
   * Ordered account metas, instruction data and the fee recipient the SDK
   * actually selected. Persisted so a replay compares against what happened
   * rather than against what a rebuild would probably produce.
   */
  readonly entryPlan: AccountPlan;""",
        """  /**
   * P2/F12 — the exact plan of the bytes that ran.
   *
   * Ordered account metas, instruction data and the fee recipient the SDK
   * actually selected. Persisted so a replay compares against what happened
   * rather than against what a rebuild would probably produce.
   */
  readonly entryPlan: AccountPlan;
  /**
   * P6 — every account the entry brought into existence, and who benefits.
   *
   * The size surface reported ZERO created-account rent on every row while
   * total drag ran to 0.010–0.012 SOL, because the accounts the transaction
   * created were not in anyone's observe list. An account nobody observed
   * reports identically to one that cost nothing.
   */
  readonly createdAccounts: readonly CreatedAccount[];
  readonly setup: SetupEconomics;
  /**
   * True when the entry had to open an account another trader's organic
   * transaction would have opened anyway — or one we could not classify.
   *
   * P6's stratum boundary. A candidate like this is COLD and does not belong in
   * the same average as a warm one, because most of its cost is a one-time
   * payment on behalf of everyone who trades the pool afterwards.
   */
  readonly requiresSharedSetup: boolean;""",
    ),
    (
        """  const facts = poolFactsFrom(preSrc, pool);""",
        """  /**
   * P6 — classify what the buy actually created.
   *
   * Present-and-absent are read from the step's own pre/post observation, so
   * this measures the transaction rather than re-deriving what it "should"
   * have done. `dataLen` is reported even for accounts whose bytes were
   * withheld, which is why scoping the worker output did not cost this.
   */
  const preByKey = new Map(trip.buy.preAccounts.map((a) => [a.pubkey, a]));
  const createdAccounts: CreatedAccount[] = [];
  for (const post of trip.buy.postAccounts) {
    const prior = preByKey.get(post.pubkey);
    const existed = prior !== undefined && (prior.lamports > 0n || prior.dataLen > 0);
    if (existed || post.lamports <= 0n) continue;
    createdAccounts.push(
      classifyCreatedAccount(
        { pubkey: post.pubkey, owner: post.owner, space: post.dataLen, lamports: post.lamports },
        {
          taker: p.taker,
          takerBaseAta: takerAta,
          takerQuoteAta: takerWsol,
          pool,
          poolBaseVault: addrs.poolBaseTokenAccount,
          poolQuoteVault: addrs.poolQuoteTokenAccount,
          baseMint: p.mint,
          quoteMint: WSOL_MINT,
          coinCreator: addrs.coinCreator,
        },
      ),
    );
  }
  const setup = summariseSetup(createdAccounts);

  const facts = poolFactsFrom(preSrc, pool);""",
    ),
    (
        """      entryPlan: buyPlan,
      incompleteness: [""",
        """      entryPlan: buyPlan,
      createdAccounts,
      setup,
      requiresSharedSetup: requiresSharedAccountCreation(createdAccounts),
      incompleteness: [""",
    ),
])
