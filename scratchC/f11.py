# -*- coding: utf-8 -*-
import io

p = 'packages/solana/src/pumpswap-offline.ts'
s = io.open(p, encoding='utf-8').read()

old = """    try {
      feeConfig = sdk.decodeFeeConfig(toAccountInfo(feeRaw));
    } catch {
      feeConfig = null;
    }"""

new = """    try {
      feeConfig = sdk.decodeFeeConfig(toAccountInfo(feeRaw));
    } catch (e) {
      // F11 — present-but-undecodable REFUSES.
      //
      // "no dynamic fee config exists" and "the config exists and this build
      // cannot read it" are opposite facts, and substituting null merges them
      // into the first. The pricing that follows is then computed against the
      // static tier while the chain charges the dynamic one, and the difference
      // is a few basis points that show up as a strategy result.
      throw new FeeConfigUndecodable((e as Error).message);
    }"""

assert s.count(old) == 3, s.count(old)
s = s.replace(old, new)

anchor = 'export function accountSourceOf('
assert s.count(anchor) == 1
s = s.replace(
    anchor,
    '''/**
 * The fee config account exists and this build cannot read it.
 *
 * Never downgraded to "there is no fee config". The two produce different
 * prices, and only one of them is a fact about the pool.
 */
export class FeeConfigUndecodable extends Error {
  constructor(readonly detail: string) {
    super(
      `the PumpSwap fee config is present and did not decode (${detail.slice(0, 120)}). ` +
        'Refusing rather than pricing against the static tier, which is a different fee.',
    );
    this.name = 'FeeConfigUndecodable';
  }
}

''' + anchor,
    1,
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok: 3 sites refuse')
