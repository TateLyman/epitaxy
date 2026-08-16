# -*- coding: utf-8 -*-
import io, sys


def edit(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if s.count(old) != 1:
            print('MISS(%d) in %s: %s' % (s.count(old), path, old[:90].replace('\n', ' | ')))
            sys.exit(1)
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)


# ---- the shared reader, plus the refusal ----------------------------------
edit('packages/simulator/src/sequential-runtime.ts', [
    (
        '''export class SequentialRuntimeUnavailable extends Error {''',
        '''/**
 * F8 — somebody read a balance out of an account whose bytes were never asked for.
 *
 * `dataBase64: null` means NOT REQUESTED. It is not an empty account and it is
 * not a zero balance, and the difference is the whole reason output scoping is
 * safe to do at all: an account nobody fetched must refuse rather than report
 * identically to one that holds nothing.
 *
 * This is an apparatus defect — the caller declared the wrong economic set —
 * and never a fact about the token.
 */
export class ObservedBytesNotRequested extends Error {
  constructor(readonly pubkey: string) {
    super(
      `the bytes of ${pubkey} were never requested, so nothing can be decoded from it. ` +
        'Name it in the economic set of the observe/step that produced this account.',
    );
    this.name = 'ObservedBytesNotRequested';
  }
}

export function observedBytes(a: { pubkey: string; dataBase64: string | null }): Buffer {
  if (a.dataBase64 === null) throw new ObservedBytesNotRequested(a.pubkey);
  return Buffer.from(a.dataBase64, 'base64');
}

/**
 * The SPL token amount an observed account holds.
 *
 * `undefined` is an account the run never saw, which is genuinely zero. Bytes
 * that were not requested REFUSE, via `observedBytes`.
 */
export function observedTokenAtoms(
  a: { pubkey: string; dataBase64: string | null } | undefined,
): bigint {
  if (a === undefined) return 0n;
  const b = observedBytes(a);
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
}

export class SequentialRuntimeUnavailable extends Error {''',
    ),
    (
        '''    const existed = prior !== undefined && (prior.lamports > 0 || prior.dataBase64.length > 0);
    if (existed || a.lamports <= 0) continue;''',
        '''    const existed = prior !== undefined && (prior.lamports > 0n || prior.dataLen > 0);
    if (existed || a.lamports <= 0n) continue;''',
    ),
    (
        '''    const bytes = BigInt(Buffer.from(a.dataBase64, 'base64').length);
    const rent = rentExemptLamports(bytes);
    const actual = BigInt(a.lamports);''',
        '''    // `dataLen` rather than the payload, so rent is measurable for an account
    // whose bytes the caller never asked for. Length is always reported.
    const bytes = BigInt(a.dataLen);
    const rent = rentExemptLamports(bytes);
    const actual = a.lamports;''',
    ),
])

# ---- accountSourceOf must refuse an account with no bytes ------------------
edit('packages/solana/src/pumpswap-offline.ts', [
    (
        '''  records: readonly { pubkey: string; owner: string; dataBase64: string; lamports: bigint | number }[],
): AccountBytesSource {
  const map = new Map<string, AccountBytes>();
  for (const r of records) {
    map.set(r.pubkey, {
      owner: r.owner,
      dataBase64: r.dataBase64,''',
        '''  records: readonly {
    pubkey: string;
    owner: string;
    /** Null means the observation did not request this account's bytes. */
    dataBase64: string | null;
    lamports: bigint | number;
  }[],
): AccountBytesSource {
  const map = new Map<string, AccountBytes>();
  for (const r of records) {
    // An account whose bytes were never fetched must not enter a source that
    // the next leg is BUILT from. Treating it as empty would quote a pool with
    // no reserves and call the answer a market fact.
    if (r.dataBase64 === null) {
      throw new Error(
        `accountSourceOf: ${r.pubkey} carries no bytes (they were not requested), ` +
          'so it cannot back a build. Name it in the economic set.',
      );
    }
    map.set(r.pubkey, {
      owner: r.owner,
      dataBase64: r.dataBase64,''',
    ),
])

# ---- the three local token readers -----------------------------------------
edit('packages/pipeline/src/open-trajectory.ts', [
    (
        '''const tokenAmountAt = (a: { dataBase64: string } | undefined): bigint => {
  if (a === undefined) return 0n;
  const b = Buffer.from(a.dataBase64, 'base64');
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
};''',
        '''const tokenAmountAt = observedTokenAtoms;''',
    ),
])

edit('packages/pipeline/src/sequential-round-trip.ts', [
    (
        '''const tokenAmount = (a: { dataBase64: string } | undefined): bigint | null => {''',
        '''const tokenAmount = (a: { pubkey: string; dataBase64: string | null } | undefined): bigint | null => {''',
    ),
])

edit('scripts/size-cost-surface.ts', [
    (
        '''const tokenAmountAt = (a: { dataBase64: string } | undefined): bigint => {
  if (a === undefined) return 0n;
  const b = Buffer.from(a.dataBase64, 'base64');
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
};''',
        '''const tokenAmountAt = observedTokenAtoms;''',
    ),
    (
        '''          const before = trip.buy?.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0;
          const after = trip.close?.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0;
          const net = BigInt(after) - BigInt(before);''',
        '''          const before = trip.buy?.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0n;
          const after = trip.close?.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0n;
          const net = after - before;''',
    ),
])

edit('scripts/live-one-pass-trajectory.ts', [
    (
        '''      const wsolLamports =
        wsolAtClose === undefined
          ? 0n
          : (() => {
              const b = Buffer.from(wsolAtClose.dataBase64, 'base64');
              return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
            })();''',
        '''      const wsolLamports = observedTokenAtoms(wsolAtClose);''',
    ),
    (
        '''      const residualAtoms =
        residualAcct === undefined
          ? 0n
          : (() => {
              const b = Buffer.from(residualAcct.dataBase64, 'base64');
              return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
            })();''',
        '''      const residualAtoms = observedTokenAtoms(residualAcct);''',
    ),
])

edit('scripts/one-pass-sequential-proof.ts', [
    (
        '''      lamports: a?.lamports,
      owner: a?.owner,
      expectedLamports: 5_000_000,
      matches: a?.lamports === 5_000_000 && a?.owner === SYSTEM_PROGRAM,''',
        '''      lamports: a?.lamports.toString() ?? null,
      owner: a?.owner,
      expectedLamports: '5000000',
      matches: a?.lamports === 5_000_000n && a?.owner === SYSTEM_PROGRAM,''',
    ),
])

edit('scripts/sequential-runtime-proof.ts', [
    (
        '''const balanceOf = (accs: readonly { pubkey: string; lamports: number }[], k: string): number | null =>
  accs.find((a) => a.pubkey === k)?.lamports ?? null;''',
        '''const balanceOf = (accs: readonly { pubkey: string; lamports: bigint }[], k: string): string | null =>
  accs.find((a) => a.pubkey === k)?.lamports.toString() ?? null;''',
    ),
])
