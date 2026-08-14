import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { elfFromProgramData, programDataAddressOf } from '../../packages/solana/src/snapshot-capture.js';

/**
 * P24 items 37 and 38 — the runtime loads real code and restores real time.
 *
 * Both are properties of the Rust worker, and the worker needs WSL, so what is
 * asserted here is the half that can be: the bytes the driver hands it, and the
 * artifact the worker produced when it last ran. A test that shells into WSL
 * would be skipped on every machine that does not have it, which is the same as
 * not having the test.
 */

const PROOF = 'artifacts/sequential-runtime-proof.json';

interface Proof {
  litesvmVersion?: string;
  sequentialComplete?: boolean;
  sequentialPropertyHolds?: boolean;
  observed?: {
    step1?: { status?: string; preB?: number; postB?: number };
    step2?: { status?: string; preB?: number; postB?: number };
  };
  steps?: { label: string; status: string }[];
  [k: string]: unknown;
}

describe('P24 item 37 — the ELF comes from ProgramData, not the program account', () => {
  it('extracts the ELF at offset 45 and nowhere else', () => {
    // Layout: 4-byte discriminant (3 = ProgramData), 8-byte slot, 1-byte
    // Option tag, 32-byte authority, then the ELF.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 9, 9]);
    const acct = Buffer.alloc(45 + elf.length);
    acct.writeUInt32LE(3, 0);
    elf.copy(acct, 45);
    expect(elfFromProgramData(acct)?.equals(elf)).toBe(true);
  });

  it('refuses an account that is not ProgramData', () => {
    // A Program account holds a pointer, not code. Restoring it and calling
    // that program loading gives the runtime a pointer to nothing, and every
    // route through it fails with an error that reads as a fact about the token.
    const acct = Buffer.alloc(60);
    acct.writeUInt32LE(2, 0);
    expect(elfFromProgramData(acct)).toBeNull();
  });

  it('refuses ProgramData whose payload is not an ELF', () => {
    const acct = Buffer.alloc(60);
    acct.writeUInt32LE(3, 0);
    acct.write('not an elf', 45);
    expect(elfFromProgramData(acct)).toBeNull();
  });

  it('reads the ProgramData pointer out of a Program account', () => {
    const acct = Buffer.alloc(36);
    acct.writeUInt32LE(2, 0);
    acct.fill(1, 4, 36);
    const addr = programDataAddressOf(acct);
    expect(typeof addr).toBe('string');
    expect((addr ?? '').length).toBeGreaterThan(30);
  });

  it('will not read a pointer out of something that is not a Program account', () => {
    const acct = Buffer.alloc(36);
    acct.writeUInt32LE(3, 0);
    expect(programDataAddressOf(acct)).toBeNull();
  });

  it.skipIf(!existsSync(PROOF))('the last run names the binary that produced it', () => {
    // A result whose worker cannot be identified is not reproducible, and the
    // ELF loading path is the part of the worker most likely to change.
    const p = JSON.parse(readFileSync(PROOF, 'utf8')) as Proof;
    expect(String(p['binarySha256'] ?? '')).toMatch(/^[0-9a-f]{64}$/);
    expect(p['runtime']).toBe('litesvm');
  });
});

describe('P24 item 38 — the runtime restores Clock, lookup tables and blockhash', () => {
  it.skipIf(!existsSync(PROOF))('pins the LiteSVM version rather than floating it', () => {
    // 0.15.2 and 0.14.0 both fail to compile against their own resolved crate
    // sets, so the version is a verified fact and not a preference.
    const p = JSON.parse(readFileSync(PROOF, 'utf8')) as Proof;
    expect(p.litesvmVersion).toBe('0.6.1');
  });

  it.skipIf(!existsSync(PROOF))('step two sees what step one committed', () => {
    // The defining property, on arithmetic nobody can dispute: two transfers
    // into the same account, and the second one's PRE-state already holds the
    // first. Two fresh states would show the second starting from zero, which
    // is precisely the linked-leg defect.
    const p = JSON.parse(readFileSync(PROOF, 'utf8')) as Proof;
    const steps = p.steps ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((s) => s.status === 'SIMULATED_OK')).toBe(true);
    expect(p.sequentialComplete).toBe(true);
    expect(p.sequentialPropertyHolds).toBe(true);

    const one = p.observed?.step1;
    const two = p.observed?.step2;
    expect(one?.preB).toBe(0);
    expect(one?.postB).toBe(1_000_000_000);
    // The whole claim in one line: step 2 STARTED from what step 1 left.
    expect(two?.preB).toBe(one?.postB);
    // Two fresh states would have shown 0 -> 2 SOL rather than 1 -> 3.
    expect(two?.postB).toBe(3_000_000_000);
  });

  it('the sequential runtime job carries slot and wall time', async () => {
    // Restoring accounts without restoring Clock runs a swap against a
    // sysvar from whenever the runtime happened to start, and a program that
    // reads the clock - the volume accumulator does - then behaves as though
    // the trade were in a different epoch.
    const mod = await import('../../packages/simulator/src/sequential-runtime.js');
    const src = readFileSync('packages/simulator/src/sequential-runtime.ts', 'utf8');
    expect(typeof mod.runSequential).toBe('function');
    // The job schema is the contract with the worker; these two fields are what
    // the worker warps its Clock to.
    expect(src).toMatch(/slot:\s*opts\.snapshot\.slot/);
    expect(src).toMatch(/unix_timestamp:\s*opts\.snapshot\.unixTimestamp/);
  });
});
