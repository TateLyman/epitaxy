"""Mutation check for the drawdown halt (portfolio.ts) and peakNav (ledger.ts)."""
import pathlib
import re
import subprocess
import sys

PORT = pathlib.Path('packages/strategy/src/portfolio.ts')
LEDG = pathlib.Path('apps/engine/src/ledger.ts')

MUTATIONS = [
    (PORT, 'D1 the original defect: drawdownHaltPct read by nothing',
     lambda s: re.sub(
         r'  if \(risk\.drawdownHaltPct > 0 && state\.peakNavLamports > 0n\) \{',
         '  if (false) {',
         s)),
    (PORT, 'D2 halt compares against starting NAV instead of peak',
     lambda s: s.replace(
         '    const drawdown = state.peakNavLamports - state.navLamports;',
         '    const drawdown = 0n;')),
    (PORT, 'D3 off-by-one at the boundary (> instead of >=)',
     lambda s: s.replace('    if (drawdown >= limit) {', '    if (drawdown > limit) {')),
    (PORT, 'D4 halt placed after the score gate, masking the real reason',
     lambda s: s.replace(
         "  if (opportunityScore < config.minOpportunityScore) {\n    return refuse('score_below_threshold'",
         "  if (opportunityScore < config.minOpportunityScore + 1) {\n    return refuse('score_below_threshold'")),
    (LEDG, 'P1 peak tracks the latest NAV rather than the maximum',
     lambda s: s.replace('    if (nav > peak) peak = nav;', '    peak = nav;')),
    (LEDG, 'P2 peak replayed in insert order rather than close order',
     lambda s: s.replace(
         "'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL ORDER BY closed_utc_ms',",
         "'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL ORDER BY rowid',")),
]

FILES = {PORT: PORT.read_text(encoding='utf-8'), LEDG: LEDG.read_text(encoding='utf-8')}
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
            ['npx', 'vitest', 'run', 'tests/unit/ledger.test.ts', 'tests/unit/portfolio.test.ts',
             'tests/property/sizing.property.test.ts', '--reporter=basic'],
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
