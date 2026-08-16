# -*- coding: utf-8 -*-
import io, re, sys


def rw(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) < 1:
            print('MISS in %s: %s' % (path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


# ------------------------------------------------ sequential-worker-p3 tests --
rw('tests/unit/sequential-worker-p3.test.ts', [
    (
        """function acct(pubkey: string, dataSha256: string): ObservedAccount {
  const a: ObservedAccount = {
    pubkey,
    lamports: 1_000,
    owner: '11111111111111111111111111111111',
    dataBase64: 'AAAA',
    dataSha256,
  };
  return a;
}""",
        """/**
 * F10 — the survival check compares the COMPLETE account, so a fixture has to
 * carry one. `accountHash` follows `dataSha256` by default because most of
 * these cases are about the bytes moving; the cases that are about the OTHER
 * fields override it, which is exactly the distinction the old fixture could
 * not express.
 */
function acct(pubkey: string, dataSha256: string, over: Partial<ObservedAccount> = {}): ObservedAccount {
  const a: ObservedAccount = {
    pubkey,
    lamports: 1_000n,
    owner: '11111111111111111111111111111111',
    executable: false,
    rentEpoch: 18_446_744_073_709_551_615n,
    dataLen: 3,
    dataBase64: 'AAAA',
    dataSha256,
    accountHash: `h:${dataSha256}`,
    ...over,
  };
  return a;
}""",
    ),
])

s = io.open('tests/unit/sequential-worker-p3.test.ts', encoding='utf-8').read()
# every ObserveResult literal in this file needs the new field
s = re.sub(r"(unobserved: \[\], stateHash: '[^']*')( \})", r"\1, instanceId: null\2", s)
s = re.sub(r"(unobserved: \[\],\n(\s+)stateHash: '[^']*',)", r"\1\n\2instanceId: null,", s)
io.open('tests/unit/sequential-worker-p3.test.ts', 'w', encoding='utf-8', newline='\n').write(s)
print('observe results patched')

# ----------------------------------------------------- parity-v2-p24 tests ----
s = io.open('tests/unit/parity-v2-p24.test.ts', encoding='utf-8').read()
s = s.replace(
    """          lamports: 2_539_280,
          dataSha256: '',""",
    """          lamports: 2_539_280n,
          executable: false,
          rentEpoch: 0n,
          dataLen: 165,
          dataSha256: '',
          accountHash: 'vault-post',""",
)
s = s.replace(
    """          lamports: 1_000,
          dataSha256: '',""",
    """          lamports: 1_000n,
          executable: false,
          rentEpoch: 0n,
          dataLen: 165,
          dataSha256: '',
          accountHash: 'thin-post',""",
)
s = s.replace("postAccounts: [{ ...acct, lamports: 5_000_000 }],", "postAccounts: [{ ...acct, lamports: 5_000_000n }],")
io.open('tests/unit/parity-v2-p24.test.ts', 'w', encoding='utf-8', newline='\n').write(s)
print('ok tests/unit/parity-v2-p24.test.ts')
