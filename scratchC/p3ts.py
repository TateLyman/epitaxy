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


# ============================================================ runtime types ==
edit('packages/simulator/src/sequential-runtime.ts', [
    (
        '''export interface FrozenRuntimeSnapshot {
  readonly programs: readonly LoadedProgram[];
  readonly accounts: readonly FrozenAccount[];
  /** The slot and wall time the snapshot was taken at. */
  readonly slot: number | null;
  readonly unixTimestamp: number | null;
}''',
        '''/**
 * F9 — the sysvars EXACTLY as the chain had them.
 *
 * Without these the worker derives `epoch = slot / 432_000` and leaves Rent and
 * EpochSchedule at the runtime default. Epoch-by-division is wrong across the
 * warmup epochs, and a program that reads Rent to size an account it creates
 * gets a different answer than mainnet gave it. Neither shows up as an error —
 * they show up as an economic number that is quietly not the chain's.
 *
 * These are the shapes `decodeClock`/`decodeRent`/`decodeEpochSchedule` in
 * packages/solana/src/coherent-snapshot.ts already return.
 */
export interface ExactClock {
  readonly slot: string;
  readonly epochStartTimestamp: string;
  readonly epoch: string;
  readonly leaderScheduleEpoch: string;
  readonly unixTimestamp: string;
}

export interface ExactRent {
  readonly lamportsPerByteYear: string;
  readonly exemptionThreshold: number;
  readonly burnPercent: number;
}

export interface ExactEpochSchedule {
  readonly slotsPerEpoch: string;
  readonly leaderScheduleSlotOffset: string;
  readonly warmup: boolean;
  readonly firstNormalEpoch: string;
  readonly firstNormalSlot: string;
}

export interface FrozenRuntimeSnapshot {
  readonly programs: readonly LoadedProgram[];
  readonly accounts: readonly FrozenAccount[];
  /** The slot and wall time the snapshot was taken at. */
  readonly slot: number | null;
  readonly unixTimestamp: number | null;

  /** F9 — restored verbatim when present. Nothing is derived from them. */
  readonly clock?: ExactClock | null;
  readonly rent?: ExactRent | null;
  readonly epochSchedule?: ExactEpochSchedule | null;
  /** Refuse rather than derive, for a caller that DID capture exact state. */
  readonly requireExactSysvars?: boolean;

  /**
   * Without these this runtime is not the one the caller asked for.
   *
   * A missing account is not a note in an incompleteness list somebody might
   * read later. The transaction fails with an error that reads as a fact about
   * the token, so init refuses instead.
   */
  readonly requiredAccounts?: readonly string[];
  readonly requiredPrograms?: readonly string[];
}''',
    ),
    (
        '''export interface ObservedAccount {
  readonly pubkey: string;
  readonly lamports: number;
  readonly owner: string;
  readonly dataBase64: string;
  readonly dataSha256: string;
}''',
        '''export interface ObservedAccount {
  readonly pubkey: string;
  /** F7 — a u64. Never a `number`, in either direction across the wire. */
  readonly lamports: bigint;
  readonly owner: string;
  readonly executable: boolean;
  /** u64::MAX for a rent-exempt account, which is every mainnet account here. */
  readonly rentEpoch: bigint;
  readonly dataLen: number;
  /**
   * F8 — the bytes, and only for accounts the caller declared economic.
   *
   * Null means "not requested", NOT "empty". Everything else about the account
   * is still reported, which is enough to detect any change and enough to price
   * a wallet.
   */
  readonly dataBase64: string | null;
  readonly dataSha256: string;
  /**
   * F10 — the COMPLETE identity: owner, lamports, executability, rent epoch,
   * length and data.
   *
   * The survival check compared `dataSha256` alone, so a sell could execute
   * against a state whose owner and balance had both changed and the assertion
   * still passed. Those are the fields a runtime consults before it will
   * execute against the account at all.
   */
  readonly accountHash: string;
}''',
    ),
    (
        '''  return (raw as Record<string, unknown>[]).map((a) => ({
    pubkey: String(a['pubkey'] ?? ''),
    lamports: Number(a['lamports'] ?? 0),
    owner: String(a['owner'] ?? ''),
    dataBase64: String(a['data_base64'] ?? ''),
    dataSha256: String(a['data_sha256'] ?? ''),
  }));''',
        '''  return (raw as Record<string, unknown>[]).map((a) => ({
    pubkey: String(a['pubkey'] ?? ''),
    lamports: BigInt(String(a['lamports'] ?? '0')),
    owner: String(a['owner'] ?? ''),
    executable: a['executable'] === true,
    rentEpoch: BigInt(String(a['rent_epoch'] ?? '0')),
    dataLen: Number(a['data_len'] ?? 0),
    dataBase64: a['data_base64'] === undefined ? null : String(a['data_base64']),
    dataSha256: String(a['data_sha256'] ?? ''),
    accountHash: String(a['account_hash'] ?? ''),
  }));''',
    ),
    (
        '''      // The worker takes u64; a lamport count is never fractional.
      lamports: Number(a.lamports),
      executable: a.executable ?? false,
      rent_epoch: Number(a.rentEpoch ?? 0n),
    })),
    slot: opts.snapshot.slot,
    unix_timestamp: opts.snapshot.unixTimestamp,
    steps: opts.steps.map((s) => ({
      label: s.label,
      transaction_base64: s.transactionBase64,
      observe: [...s.observe],
    })),
    max_compute_units: opts.maxComputeUnits ?? 1_400_000,
  };''',
        '''      // F7 — decimal strings. `rent_epoch` for a rent-exempt account is
      // u64::MAX, and through a JSON number that returns 1615 short of itself.
      lamports: a.lamports.toString(),
      executable: a.executable ?? false,
      rent_epoch: (a.rentEpoch ?? RENT_EXEMPT_EPOCH).toString(),
    })),
    slot: opts.snapshot.slot === null ? null : String(opts.snapshot.slot),
    unix_timestamp: opts.snapshot.unixTimestamp === null ? null : String(opts.snapshot.unixTimestamp),
    clock: exactClock(opts.snapshot),
    rent: exactRent(opts.snapshot),
    epoch_schedule: exactEpochSchedule(opts.snapshot),
    steps: opts.steps.map((s) => ({
      label: s.label,
      transaction_base64: s.transactionBase64,
      observe: [...s.observe],
    })),
    max_compute_units: String(opts.maxComputeUnits ?? 1_400_000),
  };''',
    ),
    (
        '''        transactionError: (s['transaction_error'] as string | null) ?? null,
        computeUnitsConsumed: (s['compute_units_consumed'] as number | null) ?? null,''',
        '''        transactionError: (s['transaction_error'] as string | null) ?? null,
        computeUnitsConsumed:
          s['compute_units_consumed'] === null || s['compute_units_consumed'] === undefined
            ? null
            : Number(s['compute_units_consumed']),''',
    ),
    (
        '''export class SequentialRuntimeUnavailable extends Error {''',
        '''/**
 * The rent epoch the chain uses for an account it considers exempt.
 *
 * Defaulting to 0 — which is what the protocol did — restores every mainnet
 * account as rent-PAYING. That is a different account.
 */
export const RENT_EXEMPT_EPOCH = 18_446_744_073_709_551_615n;

export function exactClock(s: FrozenRuntimeSnapshot): Record<string, string> | null {
  const c = s.clock;
  if (c === null || c === undefined) return null;
  return {
    slot: c.slot,
    epoch_start_timestamp: c.epochStartTimestamp,
    epoch: c.epoch,
    leader_schedule_epoch: c.leaderScheduleEpoch,
    unix_timestamp: c.unixTimestamp,
  };
}

export function exactRent(s: FrozenRuntimeSnapshot): Record<string, unknown> | null {
  const r = s.rent;
  if (r === null || r === undefined) return null;
  return {
    lamports_per_byte_year: r.lamportsPerByteYear,
    exemption_threshold: r.exemptionThreshold,
    burn_percent: r.burnPercent,
  };
}

export function exactEpochSchedule(s: FrozenRuntimeSnapshot): Record<string, unknown> | null {
  const e = s.epochSchedule;
  if (e === null || e === undefined) return null;
  return {
    slots_per_epoch: e.slotsPerEpoch,
    leader_schedule_slot_offset: e.leaderScheduleSlotOffset,
    warmup: e.warmup,
    first_normal_epoch: e.firstNormalEpoch,
    first_normal_slot: e.firstNormalSlot,
  };
}

export class SequentialRuntimeUnavailable extends Error {''',
    ),
])
