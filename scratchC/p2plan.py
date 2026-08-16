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
        "import type { RawInstruction } from '../../solana/src/instructionpolicy.js';",
        "import type { RawInstruction } from '../../solana/src/instructionpolicy.js';\n"
        "import { freezeAccountPlan, planAccountsNotCaptured, type AccountPlan } from '../../solana/src/account-plan.js';",
    ),
    (
        """  let buyBytes: string;
  try {
    const built = await buildBuyFrom(preSrc, {
      poolKey: pool,
      user: p.taker,
      quoteLamports: p.notionalLamports,
      slippagePct: p.slippagePct,
    });
    buyBytes = encode(built.instructions as unknown[], p.taker, blockhash);
  } catch (e) {
    return { ok: false, refusal: 'BUY_BUILD_FAILED', detail: (e as Error).message.slice(0, 160) };
  }""",
        """  let buyBytes: string;
  let buyPlan: AccountPlan;
  try {
    const built = await buildBuyFrom(preSrc, {
      poolKey: pool,
      user: p.taker,
      quoteLamports: p.notionalLamports,
      slippagePct: p.slippagePct,
    });
    const raw = (built.instructions as (TransactionInstruction | RawInstruction)[]).map(toRaw);
    // Frozen from the SAME array that is encoded on the next line. Not a
    // rebuild, not a re-derivation: the plan describes these bytes.
    buyPlan = freezeAccountPlan('buy', raw);
    buyBytes = encode(built.instructions as unknown[], p.taker, blockhash);
  } catch (e) {
    return { ok: false, refusal: 'BUY_BUILD_FAILED', detail: (e as Error).message.slice(0, 160) };
  }

  /**
   * P2 — every account the BUILT instruction touches is in the captured state.
   *
   * The snapshot was assembled from `swapAccountAddresses`, which re-derives
   * what it believes the leg will use. The plan says what it actually uses, and
   * the two can differ: the SDK selects a fee recipient from a list, derives
   * ATAs under whichever token program the mint uses, and appends remaining
   * accounts when cashback applies. None of those are predictable from the
   * pool address.
   *
   * An account missing from the runtime does not fail loudly. It executes as
   * uninitialised and produces an error that reads as a fact about the token,
   * which is the substitution this whole module exists to prevent.
   */
  const capturedKeys = snapshot.accounts.map((a) => a.pubkey);
  const uncaptured = planAccountsNotCaptured(buyPlan, [...capturedKeys, p.taker]);
  if (uncaptured.length > 0) {
    return {
      ok: false,
      refusal: 'PLAN_ACCOUNT_UNCAPTURED',
      detail: `the built buy touches ${uncaptured.length} account(s) the snapshot never fetched: ${uncaptured.slice(0, 3).join(', ')}`,
    };
  }""",
    ),
    (
        """      takerCreditAtoms: takerCredit,
      incompleteness: trip.incompleteness,""",
        """      takerCreditAtoms: takerCredit,
      // P2 — the exact plan of the bytes that ran, not a description of what a
      // rebuild would probably produce.
      entryPlan: buyPlan,
      incompleteness: trip.incompleteness,""",
    ),
])
