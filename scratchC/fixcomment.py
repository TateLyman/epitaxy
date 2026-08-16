# -*- coding: utf-8 -*-
import io

CORRECT_RS = '''/// F7 -- every u64 and i64 on this wire is a DECIMAL STRING.
///
/// JSON has exactly one number type and it is an IEEE double. `rent_epoch` for
/// a rent-exempt account is u64::MAX = 18446744073709551615, which no double
/// can represent: the nearest one is 2^64, so the value returns ONE HIGHER than
/// it went in and prints as 18446744073709552000. Nothing raises. Both ends
/// agree on a number the chain never produced.'''

pairs = [
    (
        'offline-worker/src/main.rs',
        '''/// F7 -- every u64 and i64 on this wire is a DECIMAL STRING.
///
/// JSON has exactly one number type and it is an IEEE double. `rent_epoch` for
/// a rent-exempt account is u64::MAX, and through a double that returns as
/// 18446744073709552000 -- a value the chain never produced, differing from the
/// truth by 1615. Nothing raises; both ends agree on a wrong number.''',
        CORRECT_RS,
    ),
    (
        'packages/simulator/src/sequential-runtime.ts',
        '''      // F7 — decimal strings. `rent_epoch` for a rent-exempt account is
      // u64::MAX, and through a JSON number that returns 1615 short of itself.''',
        '''      // F7 — decimal strings. `rent_epoch` for a rent-exempt account is
      // u64::MAX, which no double can hold: it comes back one higher and prints
      // as 18446744073709552000.''',
    ),
    (
        'packages/simulator/src/sequential-worker.ts',
        '''        // F7 — decimal strings. u64::MAX through a JSON double comes back
        // 1615 short of itself, silently, on the economic path.''',
        '''        // F7 — decimal strings. u64::MAX through a JSON double comes back one
        // higher than it went in, silently, on the economic path.''',
    ),
    (
        'scripts/worker-exactness-proof.ts',
        ''' * The one that mattered most is F7. `rent_epoch` for a rent-exempt account is
 * u64::MAX; through a JSON number it returns 1615 short of itself, silently, at
 * both ends. This proof asserts the exact value survives, which is the only way
 * to know the wire is not quietly rounding money-adjacent integers.''',
        ''' * The one that mattered most is F7. `rent_epoch` for a rent-exempt account is
 * u64::MAX = 18446744073709551615, and no double can represent it -- the
 * nearest is 2^64, so it comes back one higher and prints as
 * 18446744073709552000. Nothing raises at either end. This proof asserts the
 * exact value survives, which is the only way to know the wire is not quietly
 * rounding money-adjacent integers.''',
    ),
]

for path, old, new in pairs:
    s = io.open(path, encoding='utf-8').read()
    assert s.count(old) == 1, (path, s.count(old))
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
    print('ok', path)
