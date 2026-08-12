"""Mutation check for tests/unit/ledger.test.ts.

Each mutation is a defect the suite claims to catch. Four of the five are
defects that were ACTUALLY IN THE TREE at some point, not invented ones.
A mutation that survives means the corresponding test does not test anything.
"""
import pathlib
import re
import subprocess
import sys

SRC = pathlib.Path('apps/engine/src/ledger.ts')

MUTATIONS = [
    (
        'M1 the original defect: the day never rolls',
        lambda s: s.replace(
            '  const today = utcDayStart(nowUtcMs);\n  if (today === ledger.dayStartUtcMs) return false;',
            '  const today = utcDayStart(nowUtcMs);\n  if (true) return false;',
        ),
    ),
    (
        'M2 roll zeroes the day instead of recomputing it',
        lambda s: s.replace(
            '  ledger.realizedTodayLamports = sumRealized(db, today);',
            '  ledger.realizedTodayLamports = 0n;',
        ),
    ),
    (
        'M3 the original defect: realised total summed through a double',
        lambda s: re.sub(
            r'  let total = 0n;\n  for \(const row of rows\) total \+= BigInt\(row\.r\);\n  return total;',
            '  let total = 0;\n  for (const row of rows) total += Number(row.r);\n  return BigInt(total);',
            s,
        ),
    ),
    (
        'M4 day boundary is local time, not UTC',
        lambda s: s.replace('setUTCHours(0, 0, 0, 0)', 'setHours(0, 0, 0, 0)'),
    ),
    (
        'M5 cutoff excludes positions closed exactly at midnight',
        lambda s: s.replace('AND closed_utc_ms >= ?', 'AND closed_utc_ms > ?'),
    ),
]

original = SRC.read_text(encoding='utf-8')
failed_to_apply = []
survived = []

try:
    for name, mutate in MUTATIONS:
        mutated = mutate(original)
        if mutated == original:
            failed_to_apply.append(name)
            print(f'!! {name}: PATTERN DID NOT MATCH — mutation not applied')
            continue
        SRC.write_text(mutated, encoding='utf-8')
        r = subprocess.run(
            ['npx', 'vitest', 'run', 'tests/unit/ledger.test.ts', '--reporter=basic'],
            capture_output=True, text=True, shell=True,
        )
        out = re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
        m = re.search(r'Tests\s+(\d+) failed', out)
        n = int(m.group(1)) if m else 0
        if n == 0:
            survived.append(name)
            print(f'SURVIVED  {name}  <-- the suite does not catch this')
        else:
            print(f'caught    {name}  ({n} failing test(s))')
finally:
    SRC.write_text(original, encoding='utf-8')
    print('\nrestored', SRC)

if failed_to_apply or survived:
    print('\nFAILED:', len(failed_to_apply), 'unapplied,', len(survived), 'survived')
    sys.exit(1)
print('\nall mutations caught')
