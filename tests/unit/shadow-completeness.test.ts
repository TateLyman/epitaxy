import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * §12.1 and §12.3 — structural guards on the shadow books.
 *
 * These read the engine source rather than running it, because `paper.ts` calls
 * `main()` at import time and cannot be imported by a test. That is a real
 * limitation and worth naming: a source-shape assertion is weaker than a
 * behavioural one, and it is here because the alternative is no guard at all.
 *
 * Both defects they cover are invisible in any single run and only show up as a
 * skew in the corpus months later.
 */

const paper = readFileSync('apps/engine/src/paper.ts', 'utf8');

describe('§12.1 every eligible signal opens both books', () => {
  it('opens the books before the portfolio sizing branch, not inside it', () => {
    const openCall = paper.indexOf('await openShadowBooks(');
    const refusalBranch = paper.indexOf('if (!sizing.allowed) {');
    expect(openCall).toBeGreaterThan(-1);
    expect(refusalBranch).toBeGreaterThan(-1);
    // The whole defect: opening only on refusal meant the books held exactly
    // the signals the portfolio rejected, so comparing them to portfolio
    // results compared the trades we turned down against the trades we took.
    expect(
      openCall,
      'openShadowBooks must run BEFORE the sizing branch, or the books are censored by our own acceptance',
    ).toBeLessThan(refusalBranch);
  });

  it('opens them exactly once, so an accepted signal cannot double-open', () => {
    const calls = paper.split('await openShadowBooks(').length - 1;
    expect(calls).toBe(1);
  });

  it('records whether the portfolio accepted, so the two populations stay separable', () => {
    // Both books contain every signal now, which is the point. The refusal
    // reason is what still lets anyone ask "how did the ones we took differ".
    expect(paper).toContain("'accepted_by_portfolio'");
  });
});

describe('§12.3 one fact costs one API call', () => {
  it('caches the entry observation by notional', () => {
    expect(paper).toContain('sharedEntry');
    expect(paper).toContain('sharedExit');
  });

  it('labels the shared row by what it is, not by whichever book asked first', () => {
    // A row labelled alpha_shadow_entry that both books reference is a lie to
    // whoever reads the corpus later.
    expect(paper).toContain("purpose: `shadow_entry`");
    expect(paper).toContain("purpose: `shadow_entry_roundtrip`");
    expect(paper).not.toContain('purpose: `${book}_entry`');
  });

  it('keys the exit cache on the token amount as well as the notional', () => {
    // Two books at the same notional acquire the same tokens, so they share.
    // Two books at DIFFERENT notionals acquire different amounts and must not.
    expect(paper).toContain('const exitKey = `${sizeKey}:${tokensIn.toString()}`');
  });
});

describe('§12.2 the database refuses a duplicate book/episode pair', () => {
  it('has the unique index, so dedup does not depend on the engine getting it right', () => {
    const db = readFileSync('packages/storage/src/db.ts', 'utf8');
    expect(db).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_episode ON shadow_positions(book, signal_episode_id)');
  });
});
