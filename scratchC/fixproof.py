# -*- coding: utf-8 -*-
import io

p = 'scripts/worker-exactness-proof.ts'
s = io.open(p, encoding='utf-8').read()
old = """      throughADoubleWouldHaveRead: Number(RENT_EXEMPT_EPOCH).toString(),
      lostToADouble: (BigInt(Number(RENT_EXEMPT_EPOCH)) - RENT_EXEMPT_EPOCH).toString(),"""
new = """      // What a JSON number would have carried, exactly and as printed.
      throughADoubleExactly: BigInt(Number(RENT_EXEMPT_EPOCH)).toString(),
      throughADoublePrintedAs: Number(RENT_EXEMPT_EPOCH).toString(),
      errorIntroducedByADouble: (BigInt(Number(RENT_EXEMPT_EPOCH)) - RENT_EXEMPT_EPOCH).toString(),"""
assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
