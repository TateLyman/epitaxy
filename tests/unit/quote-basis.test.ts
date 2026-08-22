import { describe, expect, it } from 'vitest';
import {
  minOutputOnEffectBasis,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  WRAPPED_SOL,
} from '../../packages/execution/src/quote-basis.js';

const TOKEN = 'DnxGKJgFdQHCDnJpT8FvYMKxuAZyNC8cnTgXh1avmhdm';

/**
 * These numbers are from the first real trade (MT136), not invented. Three sells were refused
 * while a real position was open because the quote and the effect check were counting different
 * things, and the fourth only cleared by luck of a price move.
 */
describe('quote basis — the bound that refused three good sells', () => {
  it('reproduces the live refusal, and shows the fix clears it', () => {
    const quoted = 19_620_084n;          // what the aggregator said
    const simulated = 17_538_914n;       // what verifyEffect measured, net of rent
    const slippageBps = 300;

    // The old rule: slippage straight off the quote. It demanded more than the effect can report.
    const naive = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
    expect(simulated < naive).toBe(true);

    // The fix puts them on one basis first. A correct fill now passes.
    const fixed = minOutputOnEffectBasis({ outputMint: WRAPPED_SOL, quotedOut: quoted, slippageBps });
    expect(simulated >= fixed).toBe(true);
  });

  it('still refuses a genuinely bad fill', () => {
    const quoted = 19_620_084n;
    const bound = minOutputOnEffectBasis({ outputMint: WRAPPED_SOL, quotedOut: quoted, slippageBps: 300 });
    // Half the expected proceeds is not a slippage event, and must not pass.
    expect(quoted / 2n < bound).toBe(true);
  });

  it('adjusts by exactly one account rent, and only when selling into SOL', () => {
    const quoted = 10_000_000n;
    const sol = minOutputOnEffectBasis({ outputMint: WRAPPED_SOL, quotedOut: quoted, slippageBps: 0 });
    expect(sol).toBe(quoted - TOKEN_ACCOUNT_RENT_LAMPORTS);

    // Buying a token: the two bases already agree, so nothing is subtracted.
    const token = minOutputOnEffectBasis({ outputMint: TOKEN, quotedOut: quoted, slippageBps: 0 });
    expect(token).toBe(quoted);
  });

  it('never returns a negative bound on a dust-sized quote', () => {
    const dust = minOutputOnEffectBasis({ outputMint: WRAPPED_SOL, quotedOut: 1_000n, slippageBps: 300 });
    expect(dust).toBe(0n);
  });

  it('applies slippage on top of the basis correction, not instead of it', () => {
    const quoted = 20_000_000n;
    const b = minOutputOnEffectBasis({ outputMint: WRAPPED_SOL, quotedOut: quoted, slippageBps: 500 });
    const expected = ((quoted - TOKEN_ACCOUNT_RENT_LAMPORTS) * 9_500n) / 10_000n;
    expect(b).toBe(expected);
  });
});
