# -*- coding: utf-8 -*-
import io

p = 'packages/pipeline/src/open-trajectory.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace(
    """  | 'ENTRY_NOT_SOLE_VENUE'
  | 'RUNTIME_UNAVAILABLE';""",
    """  | 'ENTRY_NOT_SOLE_VENUE'
  /**
   * P2 — the built instruction touches an account the snapshot never fetched.
   *
   * A refusal rather than a warning, because the runtime would execute against
   * an uninitialised account and answer with something that reads as a fact
   * about the token.
   */
  | 'PLAN_ACCOUNT_UNCAPTURED'
  | 'RUNTIME_UNAVAILABLE';""",
    1,
)

s = s.replace(
    """  readonly takerCreditAtoms: bigint;
  readonly incompleteness: readonly string[];
  readonly openedUtcMs: number;
}""",
    """  readonly takerCreditAtoms: bigint;
  /**
   * P2/F12 — the exact plan of the bytes that ran.
   *
   * Ordered account metas, instruction data and the fee recipient the SDK
   * actually selected. Persisted so a replay compares against what happened
   * rather than against what a rebuild would probably produce.
   */
  readonly entryPlan: AccountPlan;
  readonly incompleteness: readonly string[];
  readonly openedUtcMs: number;
}""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
