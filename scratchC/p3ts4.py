# -*- coding: utf-8 -*-
import io, re, sys


def edit(path, pairs, count=1):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) < 1:
            print('MISS(%d) in %s: %s' % (s.count(old), path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


def add_import(path, names):
    """Add names to the existing import from a sequential-runtime.js specifier."""
    s = io.open(path, encoding='utf-8').read()
    m = re.search(r"import \{([^}]*)\} from '([^']*sequential-runtime\.js)';", s)
    if m is None:
        print('no sequential-runtime import in', path)
        sys.exit(1)
    inner = m.group(1)
    for n in names:
        if n not in inner:
            inner = inner.rstrip() + ('' if inner.rstrip().endswith(',') else ',') + f'\n  {n},\n'
    s = s[:m.start(1)] + inner + s[m.end(1):]
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('import ok', path)


for p in [
    'packages/pipeline/src/open-trajectory.ts',
    'scripts/live-one-pass-trajectory.ts',
    'scripts/size-cost-surface.ts',
]:
    add_import(p, ['observedTokenAtoms'])

# open-trajectory: the wallet record is bigint everywhere else
edit('packages/pipeline/src/open-trajectory.ts', [
    (
        '''      accounts: readonly { pubkey: string; dataBase64: string; owner: string; lamports: bigint; executable?: boolean; rentEpoch?: bigint }[];''',
        '''      accounts: readonly {
        pubkey: string;
        dataBase64: string;
        owner: string;
        lamports: bigint;
        executable?: boolean;
        rentEpoch?: bigint;
      }[];''',
    ),
])

edit('packages/pipeline/src/sequential-round-trip.ts', [
    (
        """  const b = Buffer.from(a.dataBase64, 'base64');""",
        """  const b = observedBytes(a);""",
    ),
])
add_import('packages/pipeline/src/sequential-round-trip.ts', ['observedBytes'])

edit('scripts/sequential-runtime-proof.ts', [
    ('5_000_000,\n', "'5000000',\n"),
])
