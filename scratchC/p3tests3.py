# -*- coding: utf-8 -*-
import io

p = 'tests/unit/sequential-round-trip-p3.test.ts'
s = io.open(p, encoding='utf-8').read()

old = """function observed(pubkey: string, dataBase64: string, sha: string) {
  return { pubkey, lamports: 1_000, owner: 'Sys', dataBase64, dataSha256: sha };
}"""

new = """function observed(pubkey: string, dataBase64: string, sha: string) {
  return {
    pubkey,
    lamports: 1_000n,
    owner: 'Sys',
    executable: false,
    rentEpoch: 18_446_744_073_709_551_615n,
    dataLen: Buffer.from(dataBase64, 'base64').length,
    dataBase64,
    dataSha256: sha,
    // F10 — the survival check compares the COMPLETE account, so the fixture's
    // notion of "this account moved" has to live here too. Deriving it from
    // `sha` keeps every existing case saying exactly what it said before.
    accountHash: `h:${sha}`,
  };
}"""

assert s.count(old) == 1
s = s.replace(old, new)
# ObserveResult literals gain the instance field
s = s.replace(
    "unobserved: [], stateHash: 'qh' }",
    "unobserved: [], stateHash: 'qh', instanceId: 'inst-1' }",
)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
