import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectCandidateRiskFacts,
  admitCandidate,
  assertCollectedBeforeDecision,
  stratumOf,
  DEVELOPMENT_LIMITS,
} from '../../packages/intelligence/src/candidate-risk.js';
import { entityAdjustedConcentration, FactCollectedTooLate } from '../../packages/intelligence/src/risk-facts-order.js';
import { openDb } from '../../packages/storage/src/db.js';
import { insertCandidateRiskFacts, admissionTotals } from '../../packages/storage/src/trajectory-repo.js';
import { isQuotaExhausted, EndpointRefusalBreaker } from '../../packages/solana/src/rpc.js';
import type { DecodedMint } from '../../packages/solana/src/mint.js';

/**
 * The directive's P10 items 50 and 51.
 *
 * The finding is not that these gates were wrong. It is that they were never
 * consulted: a candidate reached `openTrajectory` on mechanics alone — canonical
 * pool, buy simulated, sell simulated — and whether the mint could freeze our
 * exit was neither checked nor stored against the trajectory that resulted.
 */

const MINT = '24fTiNwEG3dEusEjT1GfskFwKpYZhx6MDigceXt2pump';
const POOL = 'BSHanq7NmdY6j8u5YE9A3SUygj1bhavFqb73vadspkL3';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A renounced legacy mint: no authorities, no extensions, nothing hostile. */
const CLEAN_MINT: DecodedMint = {
  programId: TOKEN_PROGRAM,
  mintAuthority: null,
  supply: 1_000_000_000_000_000n,
  decimals: 6,
  isInitialized: true,
  freezeAuthority: null,
  extensions: [],
  transferFee: null,
  transferFeeConfig: null,
  hostileExtensions: [],
};

const facts = (over: Record<string, unknown> = {}) =>
  collectCandidateRiskFacts({
    mint: MINT,
    pool: POOL,
    nowMs: 1_000,
    decodedMint: CLEAN_MINT,
    isToken2022: false,
    hasTransferFeeExtension: false,
    transferFeeCurrentBps: null,
    transferFeeFutureBps: null,
    transferFeeWithheldAtoms: null,
    poolIsMayhemMode: false,
    isCashbackCoin: true,
    accumulatorWsolAta: 'Accum1111111111111111111111111111111111111',
    holderHistories: [],
    clusteredShare: 0,
    rawTopHolderShare: 0.2,
    holdersExamined: 19,
    canonicalPool: true,
    ...over,
  } as never);

describe('the empty-history vacuity, which reported UNMEASURED as safe', () => {
  it('calls an unexamined holder set INCOMPLETE, not a measured zero', () => {
    // This returned `MEASURED share 0` for an empty list, because the filter
    // that looks for incomplete histories finds nothing in an empty
    // collection. A caller that had examined no wallets at all therefore
    // passed the gate — the exact substitution the module exists to prevent.
    const v = entityAdjustedConcentration({ histories: [], clusteredShare: 0 });
    expect(v.kind).toBe('HISTORY_INCOMPLETE');
  });

  it('still measures when every history reached the earliest signature', () => {
    const v = entityAdjustedConcentration({
      histories: [{ reachedEarliestSignature: true, pagesWalked: 25, links: [] }],
      clusteredShare: 0.31,
    });
    expect(v).toEqual({ kind: 'MEASURED', entityAdjustedShare: 0.31 });
  });
});

describe('51 — concentration reaches the GATE, in two tiers', () => {
  it('admits on the raw tier when histories were not walked, and SAYS so in the stratum', () => {
    const f = facts();
    const a = admitCandidate(f);
    expect(a.admit).toBe(true);
    // No analysis can pool this with a candidate whose clustering was actually
    // measured, because the tier is part of the cell identity.
    expect(a.stratum).toContain('CONCENTRATION_RAW_ONLY');
  });

  it('the raw gate BITES: a token whose top holders own almost everything refuses', () => {
    const a = admitCandidate(facts({ rawTopHolderShare: 0.95 }));
    expect(a.admit).toBe(false);
    expect(a.refusals.join(' ')).toContain('can only UNDERSTATE clustering');
  });

  it('refuses when neither tier could be read, rather than treating null as low', () => {
    const a = admitCandidate(facts({ rawTopHolderShare: null }));
    expect(a.admit).toBe(false);
    expect(a.refusals.join(' ')).toContain('neither entity-adjusted nor raw');
  });

  it('uses the ENTITY-ADJUSTED share when the histories are complete', () => {
    const walked = [{ reachedEarliestSignature: true, pagesWalked: 25, links: [] }];
    const clean = admitCandidate(facts({ holderHistories: walked, clusteredShare: 0.3 }));
    expect(clean.admit).toBe(true);
    expect(clean.stratum).toContain('CONCENTRATION_ENTITY');

    // 0.6 is under the RAW limit of 0.8 and over the entity limit of 0.5. It
    // must refuse — otherwise the strong tier is decorative whenever the weak
    // one would have passed.
    const clustered = admitCandidate(facts({ holderHistories: walked, clusteredShare: 0.6 }));
    expect(clustered.admit).toBe(false);
    expect(clustered.refusals.join(' ')).toContain('entity-adjusted share');
  });

  it('refuses on an incomplete walk when raw-only admission is switched off', () => {
    const a = admitCandidate(facts(), { ...DEVELOPMENT_LIMITS, allowRawOnlyConcentration: false });
    expect(a.admit).toBe(false);
    expect(a.refusals.join(' ')).toContain('concentration unknown');
  });
});

describe('50 — Mayhem flow is not organic, and not zero', () => {
  it('grades a Mayhem venue CONTAMINATED_UNQUANTIFIED rather than subtracting a guess', () => {
    const f = facts({ poolIsMayhemMode: true });
    expect(f.breadth).toBe('CONTAMINATED_UNQUANTIFIED');
    expect(f.breadthCountsAsOrganic).toBe(false);
    // Admitted, and STRATIFIED. Excluding it outright discards a regime rather
    // than measuring it; pooling it describes neither.
    expect(admitCandidate(f).admit).toBe(true);
    expect(stratumOf(f)).toContain('/MAYHEM/');
  });

  it('an UNREAD venue is not organic either', () => {
    const f = facts({ poolIsMayhemMode: null });
    expect(f.breadth).toBe('UNKNOWN');
    expect(f.breadthCountsAsOrganic).toBe(false);
    expect(stratumOf(f)).toContain('MAYHEM_UNKNOWN');
  });

  it('only a venue read and found non-Mayhem counts as organic', () => {
    expect(facts({ poolIsMayhemMode: false }).breadthCountsAsOrganic).toBe(true);
  });
});

describe('unknown is not safe', () => {
  it('refuses a mint that did not decode, naming every unknown verdict', () => {
    const a = admitCandidate(facts({ decodedMint: null, mintDecodeFailure: 'unknown_extension' }));
    expect(a.admit).toBe(false);
    expect(a.refusals.join(' ')).toContain('unknown is not safe');
    expect(a.refusals.join(' ')).toContain('did not decode');
  });

  it('refuses a freeze authority that can disable our exit', () => {
    const hostile: DecodedMint = { ...CLEAN_MINT, freezeAuthority: POOL };
    const a = admitCandidate(facts({ decodedMint: hostile }));
    expect(a.admit).toBe(false);
    expect(a.refusals.join(' ')).toContain('disable our exit');
  });

  it('names EVERY failing fact, not the first', () => {
    const a = admitCandidate(facts({ decodedMint: null, rawTopHolderShare: null, canonicalPool: false }));
    // Collapsing six facts into one word is how 93% of a previous corpus became
    // uninformative.
    expect(a.refusals.length).toBeGreaterThan(3);
  });

  it('a Token-2022 mint with NO fee extension is NOT_APPLICABLE, not unknown', () => {
    const f = facts({ isToken2022: true, hasTransferFeeExtension: false });
    expect(f.transferFee.kind).toBe('NOT_APPLICABLE');
    expect(admitCandidate(f).admit).toBe(true);
  });

  it('a Token-2022 mint whose fee did not decode refuses', () => {
    const f = facts({ isToken2022: true, hasTransferFeeExtension: true, transferFeeCurrentBps: null });
    expect(f.transferFee.kind).toBe('UNMEASURED');
    expect(admitCandidate(f).admit).toBe(false);
  });
});

describe('the facts precede the decision, by construction', () => {
  it('accepts facts collected before the trajectory opened', () => {
    const walked = [{ reachedEarliestSignature: true, pagesWalked: 25, links: [] }];
    const f = facts({ holderHistories: walked, clusteredShare: 0.1 });
    expect(() => assertCollectedBeforeDecision(f, f.collectedAtMs + 1)).not.toThrow();
  });

  it('THROWS on a fact stamped after the decision it supposedly informed', () => {
    // A gate reading a fact collected after selection is a post-hoc annotation
    // and the position was taken either way.
    const walked = [{ reachedEarliestSignature: true, pagesWalked: 25, links: [] }];
    const f = facts({ holderHistories: walked, clusteredShare: 0.1 });
    expect(() => assertCollectedBeforeDecision(f, f.collectedAtMs - 1)).toThrow(FactCollectedTooLate);
  });
});

describe('P10 persistence — refusals are stored, because they are the product', () => {
  const freshDb = () => openDb({ path: join(mkdtempSync(join(tmpdir(), 'p10-')), 'runtime.db'), skipBackup: true });

  it('stores a refused candidate with every reason', () => {
    const db = freshDb();
    const f = facts({ rawTopHolderShare: 0.95 });
    const a = admitCandidate(f);
    insertCandidateRiskFacts(db, f, a, null);
    const t = admissionTotals(db);
    expect(t.examined).toBe(1);
    expect(t.admitted).toBe(0);
    expect(t.topRefusals[0]?.reason).toContain('UNDERSTATE');
    db.close();
  });

  it('stores an unread Mayhem flag as NULL, never as 0', () => {
    const db = freshDb();
    const f = facts({ poolIsMayhemMode: null });
    insertCandidateRiskFacts(db, f, admitCandidate(f), null);
    const row = db.prepare('SELECT mayhem_enabled FROM candidate_risk_facts').get() as { mayhem_enabled: number | null };
    // A token neither venue could be read for has not been shown non-Mayhem.
    expect(row.mayhem_enabled).toBeNull();
    db.close();
  });

  it('re-examining the same mint later is a new observation, not an overwrite', () => {
    const db = freshDb();
    const a = facts();
    const b = facts({ nowMs: 2_000, rawTopHolderShare: 0.9 });
    insertCandidateRiskFacts(db, a, admitCandidate(a), null);
    insertCandidateRiskFacts(db, b, admitCandidate(b), null);
    // The facts were true at a time. A freeze authority renounced today must
    // not retroactively rewrite yesterday's refusal.
    expect(admissionTotals(db).examined).toBe(2);
    db.close();
  });

  it('counts strata apart, so nothing is pooled', () => {
    const db = freshDb();
    const plain = facts();
    const mayhem = facts({ nowMs: 2_000, poolIsMayhemMode: true });
    insertCandidateRiskFacts(db, plain, admitCandidate(plain), null);
    insertCandidateRiskFacts(db, mayhem, admitCandidate(mayhem), null);
    expect(admissionTotals(db).byStratum).toHaveLength(2);
    db.close();
  });
});

/**
 * A spent DAILY QUOTA is not a fact about the token.
 *
 * Measured on 2026-08-16: the collector spent a whole cycle refusing every
 * candidate with `the pool is not the canonical PumpSwap pool`, and the RPC
 * body said `daily request limit reached - upgrade your account`. Nothing was
 * wrong with the chain or the pools. The refusal histogram, read later, would
 * have said the chain had no canonical pools.
 */
describe('an apparatus failure is never reported as a property of the token', () => {
  it('names an unreadable pool APPARATUS, apart from a pool that is not canonical', () => {
    const unreadable = admitCandidate(
      facts({ canonicalPool: false, poolReadFailure: '[solana_rpc/rate_limited] HTTP 429: daily request limit reached' }),
    );
    expect(unreadable.refusals.join(' ')).toContain('APPARATUS');

    const absent = admitCandidate(facts({ canonicalPool: false }));
    expect(absent.refusals.join(' ')).toContain('not the canonical PumpSwap pool');
    expect(absent.refusals.join(' ')).not.toContain('APPARATUS');
  });

  it('tells a spent daily quota apart from a per-second rate limit', () => {
    // Both are HTTP 429 and they call for opposite responses: back off for the
    // first, stop for the second.
    expect(
      isQuotaExhausted(new Error('[solana_rpc/rate_limited] HTTP 429: daily request limit reached - upgrade your account')),
    ).toBe(true);
    expect(isQuotaExhausted(new Error('[solana_rpc/rate_limited] HTTP 429: too many requests, slow down'))).toBe(false);
    expect(isQuotaExhausted(new Error('HTTP 500: internal error'))).toBe(false);
  });
});

/**
 * A wording-independent breaker, because provider prose is not an interface.
 *
 * `isQuotaExhausted` was written against QuickNode's `daily request limit
 * reached` and missed Helius's `max usage reached` on the very next run. The
 * stop it guarded did not fire, and the cycle produced six apparatus refusals
 * instead of one honest line.
 */
describe('endpoint exhaustion is detected by BEHAVIOUR, not by vocabulary', () => {
  it('trips after consecutive rate-shaped refusals, whatever they say', () => {
    const b = new EndpointRefusalBreaker(3);
    expect(b.record(new Error('HTTP 429: something nobody has seen before'))).toBe(false);
    expect(b.record(new Error('HTTP 429: something nobody has seen before'))).toBe(false);
    expect(b.record(new Error('HTTP 429: something nobody has seen before'))).toBe(true);
    expect(b.consecutiveRefusals).toBe(3);
  });

  it('a success in between resets it, because that is ordinary rate limiting', () => {
    const b = new EndpointRefusalBreaker(3);
    b.record(new Error('HTTP 429'));
    b.record(new Error('HTTP 429'));
    b.record(null);
    expect(b.tripped).toBe(false);
    expect(b.consecutiveRefusals).toBe(0);
  });

  it('a token that simply has no pool NEVER trips a breaker about the endpoint', () => {
    // Conflating the two is the defect the breaker exists alongside, not a
    // second instance of it.
    const b = new EndpointRefusalBreaker(2);
    expect(b.record(new Error('no canonical PumpSwap pool on chain'))).toBe(false);
    expect(b.record(new Error('the pool account did not decode'))).toBe(false);
    expect(b.tripped).toBe(false);
  });

  it('still recognises both providers by name, for the clearer message', () => {
    expect(isQuotaExhausted(new Error('HTTP 429: daily request limit reached'))).toBe(true);
    expect(isQuotaExhausted(new Error('[solana_rpc/rate_limited] HTTP 429: max usage reached'))).toBe(true);
  });
});

/**
 * The ordering assertion checks WHEN, not HOW STRONG.
 *
 * It required `concentration.kind === 'MEASURED'` and so fired on every
 * admitted trajectory of the first live run, announcing that facts "were not
 * available before quote selection" about facts collected before selection that
 * had simply been decided on the cheaper tier. A correct run that looks broken
 * teaches an operator to ignore the warning.
 */
describe('the fact-order check is about timing, not about strength', () => {
  it('accepts a raw-tier concentration reading collected before the decision', () => {
    const f = facts(); // holderHistories: [] -> HISTORY_INCOMPLETE
    expect(f.concentration.kind).toBe('HISTORY_INCOMPLETE');
    expect(() => assertCollectedBeforeDecision(f, f.collectedAtMs + 1)).not.toThrow();
  });

  it('accepts an UNKNOWN mint reading, because the gate needs it to refuse', () => {
    const f = facts({ decodedMint: null, mintDecodeFailure: 'unknown_extension' });
    expect(() => assertCollectedBeforeDecision(f, f.collectedAtMs + 1)).not.toThrow();
    // And the ADMISSION still refuses it, which is the separation of concerns.
    expect(admitCandidate(f).admit).toBe(false);
  });

  it('still throws on a fact stamped AFTER the decision, which is its whole job', () => {
    const f = facts();
    expect(() => assertCollectedBeforeDecision(f, f.collectedAtMs - 1)).toThrow(FactCollectedTooLate);
  });
});
