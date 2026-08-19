import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CONCENTRATION_MAJORITY,
  KNOWN_PROGRAMS,
  THIN_MEDIAN_TRADERS,
  THIN_MEDIAN_TRADES,
  THIN_SAME_TRADE_FRACTION,
  assignVenue,
  assignVenueExcludingInfrastructure,
  bucketContained,
  bucketIntersects,
  canHoldAPool,
  costFloorKind,
  programFact,
  stateOf,
  thinVerdict,
  windowActivity,
  type ActivityBucket,
} from '../../packages/research/src/venue-classify.js';

/**
 * Phase H — the venue classifier.
 *
 * The rules under test were written to the ledger as MT097 and MT098 BEFORE the first
 * query was created, so these tests are checking an implementation against a fixed
 * specification rather than a specification against its results. The two that matter
 * most are the ones that keep the classifier honest about what it does not know: a
 * program nobody named must never acquire a name, and a venue whose fee schedule has not
 * been decoded must return UNKNOWN rather than a neighbour's floor.
 */

const bucket = (
  program: string,
  firstS: number,
  lastS: number,
  nTx = 1,
  nMoves = nTx,
): ActivityBucket => ({ program, bucket: Math.floor(firstS / 300), nTx, nMoves, firstS, lastS });

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const CURVE = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const FLUX = 'FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X';

describe('programFact', () => {
  it('names the programs a source named', () => {
    expect(programFact(PUMPSWAP)).toEqual({
      id: PUMPSWAP,
      name: 'pumpswap',
      kind: 'AMM',
      source: 'dune_project',
    });
    expect(programFact(CURVE).kind).toBe('CURVE');
    expect(programFact(JUPITER).kind).toBe('ROUTER');
    expect(programFact(TOKEN_2022).kind).toBe('TOKEN');
  });

  it('never invents a name for a program no source named', () => {
    const f = programFact(FLUX);
    expect(f.name).toBeNull();
    expect(f.kind).toBe('UNKNOWN');
    expect(f.source).toBeNull();
    expect(f.id).toBe(FLUX);
  });

  it('gives every known program a name and a source, so the table cannot rot into guesses', () => {
    for (const p of KNOWN_PROGRAMS) {
      expect(p.name).not.toBeNull();
      expect(p.source).not.toBeNull();
      expect(p.id.length).toBeGreaterThan(30);
    }
  });

  it('holds no duplicate program ids', () => {
    expect(new Set(KNOWN_PROGRAMS.map((p) => p.id)).size).toBe(KNOWN_PROGRAMS.length);
  });
});

describe('canHoldAPool', () => {
  it('admits venues and unnamed programs, and refuses infrastructure', () => {
    expect(canHoldAPool('AMM')).toBe(true);
    expect(canHoldAPool('CURVE')).toBe(true);
    expect(canHoldAPool('LAUNCHPAD')).toBe(true);
    // An unnamed program might be a venue. Excluding it would quietly drop the finding
    // the directive asks for: an unrecognised program with meaningful volume.
    expect(canHoldAPool('UNKNOWN')).toBe(true);
    expect(canHoldAPool('ROUTER')).toBe(false);
    expect(canHoldAPool('TOKEN')).toBe(false);
  });
});

describe('bucket overlap', () => {
  const w = { entryS: 1_000, exitS: 2_000 };

  it('counts a bucket that touches either edge', () => {
    expect(bucketIntersects(bucket('p', 500, 1_000), w)).toBe(true);
    expect(bucketIntersects(bucket('p', 2_000, 2_500), w)).toBe(true);
    expect(bucketIntersects(bucket('p', 500, 999), w)).toBe(false);
    expect(bucketIntersects(bucket('p', 2_001, 2_500), w)).toBe(false);
  });

  it('containment implies intersection but not the reverse', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 3_000 }), (a, b) => {
        const bk = bucket('p', Math.min(a, b), Math.max(a, b));
        if (bucketContained(bk, w)) expect(bucketIntersects(bk, w)).toBe(true);
      }),
    );
    expect(bucketContained(bucket('p', 500, 1_500), w)).toBe(false);
    expect(bucketIntersects(bucket('p', 500, 1_500), w)).toBe(true);
  });
});

describe('assignVenue, the preregistered MT097 rule', () => {
  const w = { entryS: 1_000, exitS: 2_000 };

  it('picks the program with the most transactions inside the window', () => {
    const a = assignVenue([bucket(PUMPSWAP, 1_100, 1_200, 5), bucket(CURVE, 1_300, 1_400, 9)], w);
    expect(a.program).toBe(CURVE);
    expect(a.nTx).toBe(9);
    expect(a.basis).toBe('IN_WINDOW');
    expect(a.tied).toBe(false);
  });

  it('ignores activity outside the window when there is activity inside it', () => {
    const a = assignVenue([bucket(PUMPSWAP, 1_100, 1_200, 1), bucket(CURVE, 2_500, 2_600, 99)], w);
    expect(a.program).toBe(PUMPSWAP);
  });

  it('breaks a transaction tie on moves, then on program id, so row order never decides', () => {
    const byMoves = assignVenue([bucket(PUMPSWAP, 1_100, 1_200, 4, 4), bucket(CURVE, 1_300, 1_400, 4, 7)], w);
    expect(byMoves.program).toBe(CURVE);
    expect(byMoves.tied).toBe(false);

    const one = assignVenue([bucket(PUMPSWAP, 1_100, 1_200, 4, 4), bucket(CURVE, 1_300, 1_400, 4, 4)], w);
    const other = assignVenue([bucket(CURVE, 1_300, 1_400, 4, 4), bucket(PUMPSWAP, 1_100, 1_200, 4, 4)], w);
    expect(one.program).toBe(other.program);
    expect(one.tied).toBe(true);
  });

  it('falls back to the last activity before entry, then to the first after exit', () => {
    const before = assignVenue([bucket(PUMPSWAP, 100, 200), bucket(CURVE, 300, 400)], w);
    expect(before.program).toBe(CURVE);
    expect(before.basis).toBe('LAST_BEFORE_ENTRY');
    expect(before.nTx).toBe(0);

    const after = assignVenue([bucket(CURVE, 5_000, 5_100), bucket(PUMPSWAP, 3_000, 3_100)], w);
    expect(after.program).toBe(PUMPSWAP);
    expect(after.basis).toBe('FIRST_AFTER_EXIT');
  });

  it('reports no activity as null rather than as a venue', () => {
    const a = assignVenue([], w);
    expect(a.program).toBeNull();
    expect(a.basis).toBe('NO_ACTIVITY');
  });

  it('the refinement excludes routers and token programs, and the preregistered rule does not', () => {
    const buckets = [bucket(JUPITER, 1_100, 1_200, 50), bucket(PUMPSWAP, 1_300, 1_400, 3)];
    expect(assignVenue(buckets, w).program).toBe(JUPITER);
    expect(assignVenueExcludingInfrastructure(buckets, w).program).toBe(PUMPSWAP);
  });

  it('the refinement keeps an unnamed program, which may well be the venue', () => {
    const buckets = [bucket(TOKEN_2022, 1_100, 1_200, 50), bucket(FLUX, 1_300, 1_400, 3)];
    expect(assignVenueExcludingInfrastructure(buckets, w).program).toBe(FLUX);
  });
});

describe('windowActivity', () => {
  const w = { entryS: 1_000, exitS: 2_000 };

  it('counts generously across straddling buckets and strictly within contained ones', () => {
    const a = windowActivity([bucket(PUMPSWAP, 900, 1_100, 10), bucket(PUMPSWAP, 1_200, 1_300, 4)], w);
    expect(a.nTxGenerous).toBe(14);
    expect(a.nTxStrict).toBe(4);
  });

  it('the generous count is never below the strict one', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 300 }), fc.integer({ min: 1, max: 20 })),
          { maxLength: 12 },
        ),
        (specs) => {
          const buckets = specs.map(([start, len, n]) => bucket(PUMPSWAP, start, start + len, n));
          const a = windowActivity(buckets, w);
          expect(a.nTxGenerous).toBeGreaterThanOrEqual(a.nTxStrict);
        },
      ),
    );
  });

  it('claims one shared trade only when nothing at all follows entry', () => {
    expect(windowActivity([bucket(PUMPSWAP, 100, 900, 5)], w).sameTradeCertain).toBe(true);
    expect(windowActivity([], w).sameTradeCertain).toBe(true);
    // A single trade one second after entry is enough to refuse the claim.
    expect(windowActivity([bucket(PUMPSWAP, 1_001, 1_001, 1)], w).sameTradeCertain).toBe(false);
    // Activity strictly after the exit does not bear on the two legs.
    expect(windowActivity([bucket(PUMPSWAP, 2_001, 2_500, 9)], w).sameTradeCertain).toBe(true);
  });
});

describe('thinVerdict, the preregistered MT098 bar', () => {
  const thick = { medianTradesPerMint: 500, medianTradersPerMint: 100, sameTradeFraction: 0.01 };

  it('passes data that is thin on none of the three clauses', () => {
    expect(thinVerdict(thick)).toEqual({ thin: false, reasons: [] });
  });

  it('fires on each clause on its own, at the bar', () => {
    expect(thinVerdict({ ...thick, medianTradesPerMint: THIN_MEDIAN_TRADES }).thin).toBe(true);
    expect(thinVerdict({ ...thick, medianTradersPerMint: THIN_MEDIAN_TRADERS }).thin).toBe(true);
    expect(thinVerdict({ ...thick, sameTradeFraction: THIN_SAME_TRADE_FRACTION }).thin).toBe(true);
  });

  it('does not fire just above each bar', () => {
    expect(thinVerdict({ ...thick, medianTradesPerMint: THIN_MEDIAN_TRADES + 1 }).thin).toBe(false);
    expect(thinVerdict({ ...thick, medianTradersPerMint: THIN_MEDIAN_TRADERS + 1 }).thin).toBe(false);
    expect(thinVerdict({ ...thick, sameTradeFraction: THIN_SAME_TRADE_FRACTION - 0.001 }).thin).toBe(false);
  });

  it('names every clause that fired, never just the first', () => {
    const v = thinVerdict({ medianTradesPerMint: 1, medianTradersPerMint: 1, sameTradeFraction: 0.9 });
    expect(v.thin).toBe(true);
    expect(v.reasons).toHaveLength(3);
  });
});

describe('stateOf', () => {
  const notThin = { thin: false, reasons: [] as string[] };

  it('locates a venue when one named program carries a majority on non-thin data', () => {
    const s = stateOf({ topShareOfSummedReturn: 0.587, topIsNamed: true, topThin: notThin });
    expect(s.state).toBe('VENUE_LOCATED');
    expect(s.why).toContain('58.7%');
  });

  it('calls thin data an artifact even when it concentrates completely', () => {
    const s = stateOf({
      topShareOfSummedReturn: 0.99,
      topIsNamed: true,
      topThin: { thin: true, reasons: ['median trades per mint 2 <= 3'] },
    });
    expect(s.state).toBe('DISCOVERY_ARTIFACT');
    expect(s.why).toContain('median trades per mint 2 <= 3');
  });

  it('calls a figure diffuse at or below the majority bar', () => {
    expect(stateOf({ topShareOfSummedReturn: CONCENTRATION_MAJORITY, topIsNamed: true, topThin: notThin }).state).toBe(
      'DIFFUSE_NO_VENUE',
    );
    expect(stateOf({ topShareOfSummedReturn: 0.2, topIsNamed: false, topThin: notThin }).state).toBe(
      'DIFFUSE_NO_VENUE',
    );
  });

  it('locates an unnamed program too, and says so', () => {
    const s = stateOf({ topShareOfSummedReturn: 0.8, topIsNamed: false, topThin: notThin });
    expect(s.state).toBe('VENUE_LOCATED');
    expect(s.why).toContain('unnamed but identified');
  });
});

describe('costFloorKind', () => {
  it('returns a floor only for the two venues whose schedule is decoded', () => {
    expect(costFloorKind(CURVE)).toBe('FLAT_2_50_PCT');
    expect(costFloorKind(PUMPSWAP)).toBe('PUMPSWAP_TIER_SCHEDULE');
  });

  it('returns UNKNOWN for every other venue, including the one carrying 44% of the return', () => {
    expect(costFloorKind(FLUX)).toBe('UNKNOWN');
    expect(costFloorKind('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')).toBe('UNKNOWN');
    expect(costFloorKind('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')).toBe('UNKNOWN');
    expect(costFloorKind(null)).toBe('UNKNOWN');
  });

  it('never returns a floor for a venue merely because a neighbour has one', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 32, maxLength: 44 }), (id) => {
        if (id === CURVE || id === PUMPSWAP) return;
        expect(costFloorKind(id)).toBe('UNKNOWN');
      }),
    );
  });
});
