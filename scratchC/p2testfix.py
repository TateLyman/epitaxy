# -*- coding: utf-8 -*-
import io

p = 'tests/unit/account-plan-p2.test.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace(
    "import { openDb } from '../../packages/storage/src/db.js';",
    "import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { openDb } from '../../packages/storage/src/db.js';",
    1,
)
s = s.replace(
    "    const d = openDb(':memory:');",
    "    const d = openDb({ path: join(mkdtempSync(join(tmpdir(), 'plan-')), 'x.db'), skipBackup: true });",
    1,
)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
