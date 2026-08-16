# -*- coding: utf-8 -*-
import io

p = 'packages/pipeline/src/open-trajectory.ts'
s = io.open(p, encoding='utf-8').read()

old = """      priceBearingAccounts: priceBearing,
      // F8 — the sell is built from these bytes. Everything else in `observe`
      // is watched for its balance and whether it was created, and needs no
      // payload at all.
      economicAccounts: priceBearing,"""

new = """      priceBearingAccounts: priceBearing,
      /**
       * F8 — every account whose BYTES something downstream decodes.
       *
       * The pool and its vaults because the sell is built from them; the two
       * token accounts because the acquired amount and the residual WSOL are
       * read out of them. The rest of `observe` — global config, fee
       * recipients, creator vaults, the wallet — is watched for its balance,
       * its owner and whether the transaction created it, and none of that
       * needs a payload.
       *
       * Getting this set wrong REFUSES by name rather than silently reading an
       * empty account as an empty balance. That is the only reason scoping the
       * output is safe to do at all.
       */
      economicAccounts: [...priceBearing, takerAta, takerWsol],"""

assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
