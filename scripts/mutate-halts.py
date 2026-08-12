"""Mutation check for the P2a.1 halt work: the four risk halts and halt modes."""
import pathlib
import re
import subprocess
import sys

PORT = pathlib.Path('packages/strategy/src/portfolio.ts')
HALT = pathlib.Path('packages/domain/src/halt.ts')

MUTATIONS = [
    (PORT, 'H1 the original defect: dailyLossHaltPct read by nothing',
     lambda s: s.replace('if (risk.dailyLossHaltPct > 0 &&', 'if (false &&')),
    (PORT, 'H2 the original defect: weeklyLossHaltPct read by nothing',
     lambda s: s.replace('if (risk.weeklyLossHaltPct > 0 &&', 'if (false &&')),
    (PORT, 'H3 the original defect: maxAggregatePlannedLossPct read by nothing',
     lambda s: s.replace('if (risk.maxAggregatePlannedLossPct > 0 &&', 'if (false &&')),
    (PORT, 'H4 a zero threshold halts everything instead of disabling the halt',
     lambda s: s.replace('if (risk.dailyLossHaltPct > 0 &&', 'if (risk.dailyLossHaltPct >= 0 &&')),
    (PORT, 'H5 daily halt reads the weekly window',
     lambda s: s.replace('-state.realizedTodayLamports >= pctOfNav(risk.dailyLossHaltPct)',
                         '-state.realizedWeekLamports >= pctOfNav(risk.dailyLossHaltPct)')),
    (PORT, 'H6 off-by-one at the halt boundary',
     lambda s: s.replace('-state.realizedTodayLamports >= pctOfNav(risk.dailyLossHaltPct)',
                         '-state.realizedTodayLamports > pctOfNav(risk.dailyLossHaltPct)')),
    (HALT, 'K1 the original defect: a halt terminates regardless of exposure',
     lambda s: re.sub(r'export function mayTerminate\(mode: HaltMode, openPositions: number\): boolean \{',
                      'export function mayTerminate(mode: HaltMode, openPositions: number): boolean {\n  return true;',
                      s)),
    (HALT, 'K2 a bare halt file defaults to the mode that can orphan a position',
     lambda s: s.replace("const DEFAULT_MODE: HaltMode = 'TERMINATE_WHEN_FLAT';",
                         "const DEFAULT_MODE: HaltMode = 'EMERGENCY_RECONCILE';")),
    (HALT, 'K3 exit management stops under every halt mode',
     lambda s: s.replace("return mode !== 'EMERGENCY_RECONCILE';", 'return false;')),
    (HALT, 'K4 an unreadable halt file is treated as no halt',
     lambda s: s.replace("      return { path, mode: DEFAULT_MODE, defaulted: true, rawLabel: null };",
                         '      return null;')),
]

FILES = {PORT: PORT.read_text(encoding='utf-8'), HALT: HALT.read_text(encoding='utf-8')}
unapplied, survived = [], []

try:
    for path, name, mutate in MUTATIONS:
        mutated = mutate(FILES[path])
        if mutated == FILES[path]:
            unapplied.append(name)
            print(f'!! {name}: PATTERN DID NOT MATCH')
            continue
        path.write_text(mutated, encoding='utf-8')
        r = subprocess.run(
            ['npx', 'vitest', 'run', 'tests/unit/riskenforcement.test.ts', 'tests/unit/halt.test.ts',
             'tests/unit/portfolio.test.ts', 'tests/unit/ledger.test.ts', '--reporter=basic'],
            capture_output=True, text=True, shell=True,
        )
        out = re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
        m = re.search(r'Tests\s+(\d+) failed', out)
        n = int(m.group(1)) if m else 0
        path.write_text(FILES[path], encoding='utf-8')
        if n == 0:
            survived.append(name)
            print(f'SURVIVED  {name}  <-- not covered')
        else:
            print(f'caught    {name}  ({n} failing test(s))')
finally:
    for path, original in FILES.items():
        path.write_text(original, encoding='utf-8')
    print('\nrestored both files')

if unapplied or survived:
    print(f'\nFAILED: {len(unapplied)} unapplied, {len(survived)} survived')
    sys.exit(1)
print('\nall mutations caught')
