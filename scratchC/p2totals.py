# -*- coding: utf-8 -*-
import io

p = 'apps/collector/src/trajectory-collect.ts'
s = io.open(p, encoding='utf-8').read()
old = "  console.log('totals                : marks', counts.marks, 'outcomes', counts.outcomes, 'settled', counts.settled);"
new = (
    "  console.log(\n"
    "    'totals                : marks',\n"
    "    counts.marks,\n"
    "    'outcomes',\n"
    "    counts.outcomes,\n"
    "    'settled',\n"
    "    counts.settled,\n"
    "    'plans',\n"
    "    accountPlanCount(db),\n"
    "  );"
)
assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
