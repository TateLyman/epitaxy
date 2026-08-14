import { decodeTransaction } from './transaction.js';
import type { SolanaRpc } from './rpc.js';

/**
 * P2 — capture everything a transaction needs to run somewhere else.
 *
 * "Somewhere else" is the sequential runtime, and the bar is higher than it
 * looks. A transaction needs its accounts, and it needs the executable CODE of
 * every program it invokes — which is not in the program account.
 *
 * An upgradeable program account holds a 4-byte discriminant and a pointer to
 * a ProgramData account; the ELF lives THERE, at offset 45. Restoring the
 * program account and setting `executable = true` gives the runtime a pointer
 * to nothing, and every route through it fails with an invalid-program error
 * that reads as a fact about the token.
 */

const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Programs the runtime provides itself. Fetching these would be pointless. */
const BUILTIN_PROGRAMS = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
]);
/** Programs LiteSVM loads through `with_spl_programs()`. */
const SPL_PROVIDED = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]);

export interface CapturedAccount {
  readonly pubkey: string;
  readonly dataBase64: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly executable: boolean;
  readonly rentEpoch: bigint;
}

export interface CapturedProgram {
  readonly programId: string;
  readonly elfBase64: string;
  /** Where the bytes came from, so a result can be audited. */
  readonly source: 'programdata' | 'direct';
  readonly programDataAddress: string | null;
}

export interface CapturedSnapshot {
  readonly accounts: readonly CapturedAccount[];
  readonly programs: readonly CapturedProgram[];
  readonly slot: number;
  readonly unixTimestamp: number | null;
  /** Named accounts that could not be read. Absent is a fact, not an empty. */
  readonly missing: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Extract the ELF from an upgradeable ProgramData account.
 *
 * Layout: 4-byte enum discriminant (3 = ProgramData), 8-byte slot,
 * 1-byte Option<Pubkey> tag, 32-byte authority, then the ELF.
 */
export function elfFromProgramData(data: Buffer): Buffer | null {
  if (data.length < 45) return null;
  const discriminant = data.readUInt32LE(0);
  if (discriminant !== 3) return null;
  const elf = data.subarray(45);
  // Every Solana program is an ELF and every ELF starts \x7fELF.
  if (elf.length < 4 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) return null;
  return elf;
}

/** The ProgramData address an upgradeable program account points at. */
export function programDataAddressOf(data: Buffer): string | null {
  // 4-byte discriminant (2 = Program), then a 32-byte address.
  if (data.length < 36) return null;
  if (data.readUInt32LE(0) !== 2) return null;
  return bs58(data.subarray(4, 36));
}

/** Minimal base58, so this file does not depend on the encoder's shape. */
function bs58(bytes: Buffer): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

export interface CaptureOptions {
  /** Extra accounts to include beyond what the transaction names. */
  readonly extraAccounts?: readonly string[];
  /** Skip ELF capture for these, e.g. when the runtime provides them. */
  readonly skipPrograms?: readonly string[];
  /**
   * Programs the caller knows the transaction invokes.
   *
   * REQUIRED for a v0 transaction. `programIdIndex` indexes the CONCATENATION
   * of static keys and lookup-table-loaded addresses, so reading it against
   * the static keys alone finds only the outermost program — on a Jupiter
   * route that is Jupiter, and the venue program the route actually swaps
   * through is never seen. Measured: 1 program loaded of the several needed,
   * and every buy then failed with IncorrectProgramId.
   *
   * The build response names each instruction's program directly, so the
   * caller passes them rather than this file re-deriving them wrongly.
   */
  readonly extraPrograms?: readonly string[];
}

/**
 * Capture the state one or more transactions execute against.
 *
 * Accounts and programs are read at the CURRENT slot, which is what makes the
 * result a counterfactual: the question is what these bytes would do against
 * the market as it is now.
 */
export async function captureSnapshot(
  rpc: SolanaRpc,
  transactionsBase64: readonly string[],
  opts: CaptureOptions = {},
): Promise<CapturedSnapshot> {
  const notes: string[] = [];
  const missing: string[] = [];

  // ---- every address the transactions name ------------------------------
  const addresses = new Set<string>(opts.extraAccounts ?? []);
  const programIds = new Set<string>();

  for (const b64 of transactionsBase64) {
    let decoded;
    try {
      decoded = decodeTransaction(Buffer.from(b64, 'base64'));
    } catch (e) {
      notes.push(`a transaction did not decode: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    for (const k of decoded.staticAccountKeys) addresses.add(k);
    for (const t of decoded.addressTableLookups ?? []) addresses.add(t.accountKey);
    for (const ix of decoded.instructions) {
      const p = decoded.staticAccountKeys[ix.programIdIndex];
      // Only correct for indices inside the static range; see `extraPrograms`.
      if (p !== undefined) programIds.add(p);
    }
  }

  for (const p of opts.extraPrograms ?? []) {
    programIds.add(p);
    // A program is also an account, and the loader needs its bytes to find
    // ProgramData.
    addresses.add(p);
  }

  const skip = new Set(opts.skipPrograms ?? []);
  const slot = await rpc.getSlot();

  // ---- the accounts ------------------------------------------------------
  const accounts: CapturedAccount[] = [];
  for (const pubkey of addresses) {
    /**
     * The runtime supplies these itself.
     *
     * Restoring the SPL Token program account over LiteSVM's builtin fails
     * with `Instruction(MissingAccount)` and, worse, would replace a working
     * program with loader bytes. Measured as a note on every capture before
     * this skip existed.
     */
    if (BUILTIN_PROGRAMS.has(pubkey) || SPL_PROVIDED.has(pubkey)) continue;
    try {
      const raw = await rpc.getAccountRaw(pubkey);
      accounts.push({
        pubkey,
        dataBase64: raw.dataBase64,
        owner: raw.owner,
        lamports: raw.lamports,
        executable: raw.executable,
        rentEpoch: 0n,
      });
    } catch {
      // An account that does not exist yet is normal: an ATA the transaction
      // is about to create has no state to capture.
      missing.push(pubkey);
    }
  }

  /**
   * Every EXECUTABLE account is a program that needs its code.
   *
   * The instruction list is not enough and neither is `extraPrograms`. A
   * Jupiter route names only Jupiter as its instruction's program; PumpSwap,
   * Whirlpool and the Pump fee program are reached by CPI and appear nowhere
   * in the instruction list. They surface only as lookup-table addresses that
   * happen to be executable.
   *
   * Measured before this: one program loaded (Jupiter, 2.89 MB), the venue
   * programs restored as plain accounts, `set_account` refusing them with
   * Instruction(MissingAccount), and every buy failing inside the route.
   */
  for (const a of accounts) {
    if (a.executable) programIds.add(a.pubkey);
  }

  // ---- the executable CODE ----------------------------------------------
  const programs: CapturedProgram[] = [];
  for (const programId of programIds) {
    if (BUILTIN_PROGRAMS.has(programId) || SPL_PROVIDED.has(programId) || skip.has(programId)) continue;

    const acct = accounts.find((a) => a.pubkey === programId);
    if (acct === undefined) {
      notes.push(`program ${programId.slice(0, 8)} was not readable; its routes cannot run`);
      continue;
    }
    const data = Buffer.from(acct.dataBase64, 'base64');

    if (acct.owner === BPF_UPGRADEABLE_LOADER) {
      const pdAddress = programDataAddressOf(data);
      if (pdAddress === null) {
        notes.push(`program ${programId.slice(0, 8)} is upgradeable but names no ProgramData`);
        continue;
      }
      try {
        const pd = await rpc.getAccountRaw(pdAddress);
        const elf = elfFromProgramData(Buffer.from(pd.dataBase64, 'base64'));
        if (elf === null) {
          notes.push(`ProgramData ${pdAddress.slice(0, 8)} did not contain an ELF`);
          continue;
        }
        programs.push({
          programId,
          elfBase64: elf.toString('base64'),
          source: 'programdata',
          programDataAddress: pdAddress,
        });
      } catch (e) {
        notes.push(`ProgramData ${pdAddress.slice(0, 8)} unreadable: ${(e as Error).message.slice(0, 60)}`);
      }
      continue;
    }

    // A non-upgradeable program holds its own bytes.
    if (data.length > 4 && data[0] === 0x7f) {
      programs.push({ programId, elfBase64: acct.dataBase64, source: 'direct', programDataAddress: null });
    } else {
      notes.push(`program ${programId.slice(0, 8)} is owned by ${acct.owner.slice(0, 8)} and holds no ELF`);
    }
  }

  /**
   * An account whose ELF is loaded is NOT also restored as data.
   *
   * `add_program` populates the program cache; a later `set_account` over the
   * same key replaces it with loader bytes and undoes the load. The worker
   * guards this too, and doing it here as well means the job file never
   * contains the contradiction in the first place.
   */
  const loaded = new Set(programs.map((p) => p.programId));
  const restorable = accounts.filter((a) => !loaded.has(a.pubkey));

  return {
    accounts: restorable,
    programs,
    slot,
    unixTimestamp: Math.floor(Date.now() / 1000),
    missing,
    notes,
  };
}
