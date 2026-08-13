import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * P22 — the two ledgers must remain machine-readable.
 *
 * `MULTIPLE_TESTING_LEDGER.csv` had two rows whose free text contained
 * unescaped commas, so they parsed as 18 and 20 columns against a 16-column
 * header. A ledger that does not parse consistently is a ledger nobody reads
 * programmatically, and its whole purpose is to be read by someone checking
 * whether a threshold was moved after looking at the corpus.
 */

/** Minimal RFC-4180 splitter. Enough to catch the defect this exists for. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('P22 — the ledgers parse', () => {
  for (const path of ['docs/MULTIPLE_TESTING_LEDGER.csv', 'docs/FAILURE_REGISTER.csv']) {
    it(`${path} has one column count`, () => {
      const rows = parseCsv(readFileSync(path, 'utf8')).filter((r) => r.some((f) => f.trim() !== ''));
      const header = rows[0];
      expect(header).toBeDefined();
      const widths = new Set(rows.map((r) => r.length));
      expect(widths, `expected every row to have ${header?.length} columns`).toEqual(new Set([header?.length]));
    });

    it(`${path} has unique ids`, () => {
      const rows = parseCsv(readFileSync(path, 'utf8')).filter((r) => r.some((f) => f.trim() !== ''));
      const ids = rows.slice(1).map((r) => r[0]);
      // A duplicate id means two different findings answer to one name, and
      // whichever is read second silently replaces the first.
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('the testing ledger records this session as an invalidation, not a calibration', () => {
    const text = readFileSync('docs/MULTIPLE_TESTING_LEDGER.csv', 'utf8');
    // The distinction the ledger exists to preserve: a threshold moved because
    // a provider never populates a field spends no alpha; one moved because
    // returns improved spends alpha and needs a hold-out.
    expect(text).toContain('MT027');
    expect(text).toContain('INSTRUMENT_DEVELOPMENT');
    expect(text).toMatch(/No threshold was changed/i);
  });

  it('the failure register carries the simulation-setup defect', () => {
    const text = readFileSync('docs/FAILURE_REGISTER.csv', 'utf8');
    expect(text).toContain('S040');
    expect(text).toMatch(/does not describe the leg/i);
    // And the one where a gate could never pass, which is a failure mode worth
    // naming precisely because it looks like rigour.
    expect(text).toContain('a gate that can never pass');
  });
});
