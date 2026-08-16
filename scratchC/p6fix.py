# -*- coding: utf-8 -*-
import io

p = 'packages/solana/src/created-accounts.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace(
    """  // Not recognised. UNKNOWN is deliberately NOT "shared: false" — treating an
  // unclassified account as ours and recoverable is the optimistic default that
  // makes drag disappear.
  return { scope: 'UNKNOWN', recoverability: 'UNKNOWN', shared: false };""",
    """  // Not recognised.
  //
  // `shared` stays false because it is a CLAIM about who else benefits and we
  // have no basis for one. The safety comes from `recoverability: 'UNKNOWN'`,
  // which the summary counts and the warm gate refuses on — an unclassified
  // account is never assumed to be ours, closable, or free.
  return { scope: 'UNKNOWN', recoverability: 'UNKNOWN', shared: false };""",
)

s = s.replace(
    """export function requiresSharedAccountCreation(accounts: readonly CreatedAccount[]): boolean {
  return accounts.some((a) => a.sharedWithOtherTraders);
}""",
    """export function requiresSharedAccountCreation(accounts: readonly CreatedAccount[]): boolean {
  // An UNKNOWN account counts. We cannot show that it is ours and recoverable,
  // and "we did not recognise it" must not read the same as "it costs nothing"
  // — that is the same substitution that reported zero created-account rent on
  // every row of the size surface.
  return accounts.some(
    (a) => a.sharedWithOtherTraders || a.scope === 'UNKNOWN' || a.recoverability === 'UNKNOWN',
  );
}""",
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
