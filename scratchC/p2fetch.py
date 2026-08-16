# -*- coding: utf-8 -*-
import io

p = 'packages/pipeline/src/open-trajectory.ts'
s = io.open(p, encoding='utf-8').read()

old = """  /**
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
  }"""

new = """  /**
   * P2 — every account the BUILT instruction touches is in the captured state.
   *
   * The snapshot was assembled from `swapAccountAddresses`, which RE-DERIVES
   * what it believes the leg will use. The plan says what it actually uses, and
   * on live pools the two differ by fifteen accounts: the SDK selects a fee
   * recipient from a list, derives ATAs under whichever token program the mint
   * uses, appends remaining accounts when cashback applies, and names the
   * builtin programs the instruction invokes. None of that is predictable from
   * a pool address, which is the whole of F12.
   *
   * An account missing from the runtime does not fail loudly. It executes as
   * uninitialised and answers with an error that reads as a fact about the
   * token, which is the substitution this module exists to prevent.
   *
   * So they are FETCHED, not guessed at a second time. This is a second read
   * rather than a second capture: the price-bearing accounts from the coherent
   * snapshot are untouched, and only accounts the plan named are added. Those
   * are fee recipients, ATAs and programs — none of them bear price, which is
   * the same boundary the coherent snapshot's drift bound already draws.
   */
  const capturedKeys = withWallet.map((a) => a.pubkey);
  let planAccounts = withWallet;
  let extraPrograms: typeof snapshot.programs = [];
  const missing = planAccountsNotCaptured(buyPlan, [...capturedKeys, p.taker]);
  const stillAbsent: string[] = [];

  if (missing.length > 0) {
    try {
      const probe = await p.captureSnapshot(missing, []);
      // An executable account restored through `set_account` populates no
      // program cache, and every route through it then fails with an invalid
      // program error. Programs go back through the program path.
      const execs = probe.accounts.filter((a) => a.executable === true).map((a) => a.pubkey);
      const extra = execs.length > 0 ? await p.captureSnapshot(missing, execs) : probe;

      const have = new Set(capturedKeys);
      planAccounts = [
        ...withWallet,
        ...extra.accounts.filter((a) => !have.has(a.pubkey)).map((a) => ({ ...a, rentEpoch: a.rentEpoch ?? RENT_EXEMPT_EPOCH })),
      ];
      extraPrograms = extra.programs.filter((x) => !snapshot.programs.some((y) => y.programId === x.programId));

      // Whatever is STILL missing does not exist on chain. That is a fact, not
      // a failure: the transaction is about to create it, and an account the
      // chain does not have cannot be captured from it.
      stillAbsent.push(...planAccountsNotCaptured(buyPlan, [...planAccounts.map((a) => a.pubkey), p.taker]));
    } catch (e) {
      return {
        ok: false,
        refusal: 'PLAN_ACCOUNT_UNCAPTURED',
        detail: `the built buy touches ${missing.length} uncaptured account(s) and the fetch failed: ${(e as Error).message.slice(0, 90)}`,
      };
    }
  }"""

assert s.count(old) == 1
s = s.replace(old, new, 1)

# use the merged account list and merged programs for the runtime snapshot
s = s.replace(
    """        programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
        accounts: withWallet as never,""",
    """        programs: [...snapshot.programs, ...extraPrograms].map((x) => ({
          programId: x.programId,
          elfBase64: x.elfBase64,
        })),
        accounts: planAccounts as never,""",
    1,
)

# and record what the chain simply does not have
s = s.replace(
    """      entryPlan: buyPlan,
      incompleteness: trip.incompleteness,""",
    """      entryPlan: buyPlan,
      incompleteness: [
        ...trip.incompleteness,
        // Named rather than dropped. An account the chain does not have is
        // correctly absent from the runtime, and the transaction creating it is
        // exactly the cold-setup cost P6 is trying to measure.
        ...stillAbsent.map((a) => `plan account absent on chain, created by the leg: ${a}`),
      ],""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
