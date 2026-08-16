# -*- coding: utf-8 -*-
import io, json

p = 'scripts/database-trajectory-status.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace(
    "import { loadSecrets, sourceCommitOrNull } from '../packages/domain/src/config.js';",
    "import { loadSecrets } from '../packages/domain/src/config.js';\nimport { sourceCommit } from '../packages/domain/src/provenance.js';",
)
s = s.replace('sourceCommit: sourceCommitOrNull(),', 'sourceCommit: sourceCommit(),')
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok script')

# ---- rewire package.json -------------------------------------------------
p = 'package.json'
s = io.open(p, encoding='utf-8').read()
pairs = [
    ('"trajectory:status": "tsx scripts/development-status.ts"',
     '"trajectory:status": "tsx scripts/database-trajectory-status.ts"'),
    ('"rate:budget-v2": "tsx scripts/trajectory-status.ts"',
     '"rate:budget-v2": "tsx scripts/not-implemented.ts rate:budget-v2"'),
    ('"reject:panel-v2": "tsx scripts/trajectory-status.ts"',
     '"reject:panel-v2": "tsx scripts/not-implemented.ts reject:panel-v2"'),
    ('"landed:parity-v2": "tsx scripts/pumpswap-parity-v3.ts"',
     '"landed:parity-v2": "tsx scripts/not-implemented.ts landed:parity-v2"'),
    ('"wss:status": "tsx scripts/direct-signal-status.ts"',
     '"wss:status": "tsx scripts/not-implemented.ts wss:status"'),
    ('"exploration:status": "tsx scripts/evidence-status.ts cohort"',
     '"exploration:status": "tsx scripts/not-implemented.ts exploration:status"'),
    # the old position-oriented status keeps a name of its own rather than
    # disappearing: it still answers a real question, just not this one.
    ('"trajectory:status": "tsx scripts/database-trajectory-status.ts"',
     '"development:status": "tsx scripts/development-status.ts",\n    "trajectory:status": "tsx scripts/database-trajectory-status.ts"'),
]
for old, new in pairs:
    assert s.count(old) == 1, old
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
json.loads(s)
print('ok package.json')
