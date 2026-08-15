import { describe, it, expect } from 'vitest';
import { assertQuoteStateSurvived, QuoteStateMoved } from '../../packages/simulator/src/sequential-worker.js';
import type { SequentialStepResult, ObservedAccount } from '../../packages/simulator/src/sequential-runtime.js';

/**
 * P3 — the state used to quote the sell is the state it executed against.
 *
 * The two-pass design could not run this check AT ALL. It ran the buy in
 * runtime instance A to learn what it produced, built the sell from that, then
 * ran buy-then-sell in a FRESH instance B. Comparing an account across two
 * instances proves they agreed on a replay; it does not prove that a quote and
 * an execution saw one state, because they were never in the same runtime.
 *
 * One persistent runtime makes the question answerable, and these tests are
 * about the answer being checked rather than assumed.
 */

const POOL = 'So11111111111111111111111111111111111111112';
const VAULT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
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
}

function sellStep(pre: ObservedAccount[]): SequentialStepResult {
  const s: SequentialStepResult = {
    label: 'sell',
    status: 'SIMULATED_OK',
    transactionError: null,
    computeUnitsConsumed: 100,
    logs: [],
    preAccounts: pre,
    postAccounts: [],
    unobserved: [],
  };
  return s;
}

const quoted = (accounts: ObservedAccount[]) => ({ accounts, unobserved: [], stateHash: 'quoted-hash', instanceId: null });

describe('P3 — the quote state must survive to execution', () => {
  it('passes when every quoted account is byte-identical at execution', () => {
    const q = quoted([acct(POOL, 'aaa'), acct(VAULT, 'bbb')]);
    expect(() => assertQuoteStateSurvived(q, sellStep([acct(POOL, 'aaa'), acct(VAULT, 'bbb')]))).not.toThrow();
  });

  it('FAILS when a price-bearing account moved between quote and execution', () => {
    // This is the whole point. A sell priced against reserves that changed
    // before it executed is not an exact sequential mechanic.
    const q = quoted([acct(POOL, 'aaa'), acct(VAULT, 'bbb')]);
    expect(() => assertQuoteStateSurvived(q, sellStep([acct(POOL, 'aaa'), acct(VAULT, 'MOVED')]))).toThrow(
      QuoteStateMoved,
    );
  });

  it('names WHICH account moved rather than only that something did', () => {
    const q = quoted([acct(POOL, 'aaa'), acct(VAULT, 'bbb')]);
    try {
      assertQuoteStateSurvived(q, sellStep([acct(POOL, 'aaa'), acct(VAULT, 'MOVED')]));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteStateMoved);
      expect((e as QuoteStateMoved).differing).toEqual([VAULT]);
    }
  });

  it('treats an account that vanished between quote and execution as moved', () => {
    // Absent is not "unchanged". A quoted account the execution never saw is a
    // state difference, and silently ignoring it is how a missing vault reads
    // as agreement.
    const q = quoted([acct(POOL, 'aaa'), acct(VAULT, 'bbb')]);
    expect(() => assertQuoteStateSurvived(q, sellStep([acct(POOL, 'aaa')]))).toThrow(QuoteStateMoved);
  });

  it('ignores accounts the execution observed but the quote never used', () => {
    // Observing MORE at execution is not a state change. Only the accounts the
    // quote actually rested on can invalidate it.
    const q = quoted([acct(POOL, 'aaa')]);
    expect(() => assertQuoteStateSurvived(q, sellStep([acct(POOL, 'aaa'), acct(VAULT, 'anything')]))).not.toThrow();
  });

  it('a check that cannot fail is not a check', () => {
    // Guards the assertion itself: if every input passed, the tests above would
    // be describing nothing.
    const q = quoted([acct(POOL, 'aaa')]);
    let threw = false;
    try {
      assertQuoteStateSurvived(q, sellStep([acct(POOL, 'different')]));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('an empty quote vacuously passes, which is why a caller must quote something', () => {
    // Documented rather than hidden: this function cannot tell the difference
    // between "nothing moved" and "nothing was quoted". The caller naming the
    // price-bearing accounts is what makes it meaningful.
    expect(() => assertQuoteStateSurvived(quoted([]), sellStep([acct(POOL, 'aaa')]))).not.toThrow();
  });
});
