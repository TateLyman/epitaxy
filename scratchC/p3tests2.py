# -*- coding: utf-8 -*-
import io

p = 'tests/unit/parity-v2-p24.test.ts'
s = io.open(p, encoding='utf-8').read()
old = "    const acct = { pubkey: 'a', dataBase64: '', owner: 'o', lamports: 10, dataSha256: '' };"
new = (
    "    const acct = {\n"
    "      pubkey: 'a',\n"
    "      dataBase64: '',\n"
    "      owner: 'o',\n"
    "      lamports: 10n,\n"
    "      executable: false,\n"
    "      rentEpoch: 0n,\n"
    "      dataLen: 0,\n"
    "      dataSha256: '',\n"
    "      accountHash: 'a-pre',\n"
    "    };"
)
assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
