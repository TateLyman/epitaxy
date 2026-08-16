# -*- coding: utf-8 -*-
import io, sys


def rw(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) < 1:
            print('MISS in %s: %s' % (path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


rw('packages/pipeline/src/open-trajectory.ts', [
    (
        "import type { SequentialWorker } from '../../simulator/src/sequential-worker.js';",
        "import type { SequentialWorker } from '../../simulator/src/sequential-worker.js';\n"
        "import { observedTokenAtoms } from '../../simulator/src/sequential-runtime.js';",
    ),
])

rw('scripts/live-one-pass-trajectory.ts', [
    (
        "import { createdAccountRentAcross } from '../packages/simulator/src/sequential-runtime.js';",
        "import { createdAccountRentAcross, observedTokenAtoms } from '../packages/simulator/src/sequential-runtime.js';",
    ),
])

rw('scripts/size-cost-surface.ts', [
    (
        "import { createdAccountRentAcross } from '../packages/simulator/src/sequential-runtime.js';",
        "import { createdAccountRentAcross, observedTokenAtoms } from '../packages/simulator/src/sequential-runtime.js';",
    ),
])

rw('packages/pipeline/src/sequential-round-trip.ts', [
    (
        "import type { FrozenRuntimeSnapshot, SequentialStepResult } from '../../simulator/src/sequential-runtime.js';",
        "import type { FrozenRuntimeSnapshot, SequentialStepResult } from '../../simulator/src/sequential-runtime.js';\n"
        "import { observedBytes } from '../../simulator/src/sequential-runtime.js';",
    ),
    (
        "  const b = Buffer.from(a.dataBase64, 'base64');",
        "  const b = observedBytes(a);",
    ),
])

rw('scripts/sequential-runtime-proof.ts', [
    (
        """const sequential =
  observed.step1.postB === Number(LAMPORT) &&
  observed.step2.preB === Number(LAMPORT) &&
  observed.step2.postB === 3 * Number(LAMPORT);""",
        """const sequential =
  observed.step1.postB === String(LAMPORT) &&
  observed.step2.preB === String(LAMPORT) &&
  observed.step2.postB === String(3n * BigInt(LAMPORT));""",
    ),
])
