import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, createPublicKey, verify as edVerify } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Signer, SignerError, writeSignature } from '../../packages/execution/src/signer.js';
import { evaluateBinding } from '../../packages/execution/src/binding.js';
import { decodeTransaction } from '../../packages/solana/src/transaction.js';
import { base58Encode, base58Decode } from '../../packages/solana/src/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../../packages/solana/src/transaction.js';
import { SYSTEM_PROGRAM, JUPITER_V6 } from '../../packages/solana/src/txpolicy.js';
import type { TradeIntent } from '../../packages/domain/src/types.js';
import type { EffectVerdict } from '../../packages/execution/src/effect.js';

/**
 * These tests exist because the signer is the only component whose failure is
 * unbounded. Every other defect in this system costs a trade; a signer defect
 * costs the wallet.
 */

const dir = mkdtempSync(join(tmpdir(), 'signer-'));

/**
 * Write a key fixture with permissions a real key would have.
 *
 * The signer refuses any keypair file that is group- or world-readable, which
 * is correct and is not up for negotiation. `writeFileSync` honours the process
 * umask, so on Linux these fixtures landed at mode 0644 and every test in this
 * file died on the permission check before reaching what it meant to assert.
 * The suite passed on Windows, where POSIX mode bits are not enforced, so the
 * defect was invisible until CI ran on ubuntu-latest.
 *
 * The fix belongs in the fixture. A test that has to weaken the signer to run
 * is a test that has stopped testing the signer. `chmod` is a no-op on Windows,
 * which is exactly the behaviour wanted: existing behaviour there, correct
 * behaviour on POSIX.
 */
function writeKeyFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  // `mode` on open() is masked by the umask, so it is asserted rather than
  // assumed. A umask of 0077 would give 0600 anyway; a umask of 0022 would not.
  chmodSync(path, 0o600);
}

function makeKeypairFile(name: string): { path: string; pubkey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pub = spki.subarray(spki.length - 32);
  const path = join(dir, name);
  writeKeyFile(path, JSON.stringify([...seed, ...pub]));
  return { path, pubkey: base58Encode(new Uint8Array(pub)) };
}

/** Minimal but genuinely wire-format-correct v0 transaction builder. */
function buildTx(opts: {
  feePayer: string;
  extraKeys?: string[];
  instructions: { program: string; accounts: number[]; data: number[] }[];
  numRequiredSignatures?: number;
}): Uint8Array {
  const programs = [...new Set(opts.instructions.map((i) => i.program))];
  const keys = [opts.feePayer, ...(opts.extraKeys ?? []), ...programs];
  const parts: number[] = [];
  parts.push(1); // shortvec: one signature
  for (let i = 0; i < 64; i++) parts.push(0);
  parts.push(0x80); // v0
  parts.push(opts.numRequiredSignatures ?? 1);
  parts.push(0);
  parts.push(programs.length);
  parts.push(keys.length);
  for (const k of keys) parts.push(...base58Decode(k));
  for (let i = 0; i < 32; i++) parts.push(1); // recent blockhash, non-zero
  parts.push(opts.instructions.length);
  for (const ix of opts.instructions) {
    parts.push(keys.indexOf(ix.program));
    parts.push(ix.accounts.length);
    parts.push(...ix.accounts);
    parts.push(ix.data.length);
    parts.push(...ix.data);
  }
  parts.push(0); // no address table lookups
  return new Uint8Array(parts);
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function u64le(n: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** SetComputeUnitLimit + SetComputeUnitPrice, producing a known priority fee. */
function computeBudgetIxs(units: number, microLamports: bigint) {
  return [
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: [2, ...u32le(units)] },
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: [3, ...u64le(microLamports)] },
  ];
}

function systemTransfer(lamports: bigint, fromIndex = 0) {
  return { program: SYSTEM_PROGRAM, accounts: [fromIndex, 1], data: [...u32le(2), ...u64le(lamports)] };
}

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: 'i1',
    idempotencyKey: 'k1',
    mint: MINT_B,
    side: 'buy',
    inputMint: MINT_A,
    outputMint: MINT_B,
    maxInputAmount: 50_000_000n,
    minOutputAmount: 1_000n,
    maxTotalFeeLamports: 3_000_000n,
    maxPriorityFeeLamports: 1_000_000n,
    deadlineUtcMs: 2_000_000_000_000,
    strategyVersion: 'test',
    riskSnapshotHash: 'h',
    createdUtcMs: 1_000,
    ...over,
  };
}

const verified: EffectVerdict = {
  verified: true,
  refusals: [],
  lamportDelta: 50_000_000n,
  outputDelta: 5_000n,
  inputDelta: 50_000_000n,
  logs: [],
  unitsConsumed: 1000,
};

describe('keypair loading', () => {
  it('accepts a well-formed keypair and reports its public key', () => {
    const { path, pubkey } = makeKeypairFile('good.json');
    expect(Signer.fromFile(path).publicKey).toBe(pubkey);
  });

  it('refuses a keypair whose stored public half disagrees with its secret half', () => {
    const { path } = makeKeypairFile('bad.json');
    const other = makeKeypairFile('other.json');
    const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
    const swapped = [...bytes.slice(0, 32), ...base58Decode(other.pubkey)];
    const tampered = join(dir, 'tampered.json');
    writeKeyFile(tampered, JSON.stringify(swapped));
    expect(() => Signer.fromFile(tampered)).toThrow(SignerError);
  });

  it('refuses a group/world-readable key on POSIX, and says which mode it saw', () => {
    // The check that broke CI, asserted deliberately instead of by accident.
    // Skipped on Windows because NTFS does not carry POSIX mode bits and
    // `chmod` there is a no-op — a test that cannot fail is not a test.
    if (process.platform === 'win32') return;
    const loose = join(dir, 'loose.json');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const pub = spki.subarray(spki.length - 32);
    writeFileSync(loose, JSON.stringify([...seed, ...pub]));
    chmodSync(loose, 0o644);
    expect(statSync(loose).mode & 0o077).not.toBe(0);
    expect(() => Signer.fromFile(loose)).toThrow(/group\/world accessible/);
  });

  it('accepts the same key once its permissions are correct', () => {
    if (process.platform === 'win32') return;
    const fixed = join(dir, 'fixed.json');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const pub = spki.subarray(spki.length - 32);
    writeKeyFile(fixed, JSON.stringify([...seed, ...pub]));
    expect(statSync(fixed).mode & 0o077).toBe(0);
    expect(() => Signer.fromFile(fixed)).not.toThrow();
  });

  it('refuses a file that is not 64 bytes', () => {
    const short = join(dir, 'short.json');
    writeKeyFile(short, JSON.stringify(new Array(32).fill(0)));
    expect(() => Signer.fromFile(short)).toThrow(/64-byte/);
  });
});

describe('the signer refuses before it signs', () => {
  let signer: Signer;
  let me: string;
  beforeAll(() => {
    const k = makeKeypairFile('signer.json');
    signer = Signer.fromFile(k.path);
    me = k.pubkey;
  });

  it('signs a transaction that satisfies policy, binding and effect', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(true);
  });

  it('refuses when the fee payer is someone else', () => {
    const other = makeKeypairFile('other2.json');
    const raw = buildTx({
      feePayer: other.pubkey,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) {
      expect(out.kind).toBe('policy');
      expect(out.detail).toContain('wrong_fee_payer');
    }
  });

  it('refuses a program nobody authorised', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: MINT_B, accounts: [0], data: [1] }],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) expect(out.detail).toContain('disallowed_program');
  });

  it('refuses a priority fee above the one the intent authorised', () => {
    // 1_400_000 units at 1_000_000 microlamports = 1_400_000 lamports, against
    // a default intent ceiling of 1_000_000.
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [
        ...computeBudgetIxs(1_400_000, 1_000_000n),
        { program: JUPITER_V6, accounts: [0, 1], data: [9] },
      ],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) expect(out.detail).toContain('priority_fee_too_high');
  });

  it('takes its priority-fee ceiling from the intent, so the two cannot disagree', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [
        ...computeBudgetIxs(1_400_000, 1_000_000n),
        { program: JUPITER_V6, accounts: [0, 1], data: [9] },
      ],
    });
    const out = signer.sign({
      raw,
      intent: intent({ maxPriorityFeeLamports: 2_000_000n }),
      effect: verified,
      nowUtcMs: 1_000_000,
    });
    expect(out.signed).toBe(true);
  });

  it('refuses an expired intent', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
    });
    const out = signer.sign({
      raw,
      intent: intent({ deadlineUtcMs: 500 }),
      effect: verified,
      nowUtcMs: 1_000_000,
    });
    expect(out.signed).toBe(false);
    if (!out.signed) {
      expect(out.kind).toBe('binding');
      expect(out.detail).toContain('intent_expired');
    }
  });

  it('refuses when more lamports leave the wallet than the intent permits', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [
        ...computeBudgetIxs(200_000, 1_000n),
        systemTransfer(900_000_000n),
        { program: JUPITER_V6, accounts: [0, 1], data: [9] },
      ],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) expect(out.detail).toContain('lamport_outflow_exceeds_intent');
  });

  it('ignores transfers that do not come from us', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [
        ...computeBudgetIxs(200_000, 1_000n),
        systemTransfer(900_000_000n, 1),
        { program: JUPITER_V6, accounts: [0, 1], data: [9] },
      ],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(true);
  });

  it('refuses when the effect could not be verified', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
    });
    const unverified: EffectVerdict = {
      verified: false,
      refusals: [{ refusal: 'simulation_unavailable', detail: 'rpc down' }],
      lamportDelta: null,
      outputDelta: null,
      inputDelta: null,
      logs: [],
      unitsConsumed: null,
    };
    const out = signer.sign({ raw, intent: intent(), effect: unverified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) expect(out.kind).toBe('effect');
  });

  it('refuses a transaction requiring a second signer', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
      numRequiredSignatures: 2,
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(false);
    if (!out.signed) expect(out.detail).toContain('extra_signers_required');
  });

  it('produces a signature that verifies against the message it claims to sign', () => {
    const raw = buildTx({
      feePayer: me,
      extraKeys: [MINT_A],
      instructions: [...computeBudgetIxs(200_000, 1_000n), { program: JUPITER_V6, accounts: [0, 1], data: [9] }],
    });
    const out = signer.sign({ raw, intent: intent(), effect: verified, nowUtcMs: 1_000_000 });
    expect(out.signed).toBe(true);
    if (!out.signed) return;

    const signed = Buffer.from(out.transactionBase64, 'base64');
    const decoded = decodeTransaction(new Uint8Array(signed));
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(base58Decode(signer.publicKey)),
    ]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = edVerify(null, Buffer.from(decoded.messageBytes), pub, Buffer.from(base58Decode(out.signature)));
    expect(ok).toBe(true);
  });
});

describe('signature placement', () => {
  it('writes into slot zero without disturbing the message', () => {
    const raw = buildTx({
      feePayer: MINT_A,
      instructions: [{ program: SYSTEM_PROGRAM, accounts: [0], data: [0] }],
    });
    const before = decodeTransaction(raw);
    const sig = new Uint8Array(64).fill(7);
    const after = decodeTransaction(writeSignature(raw, sig));
    expect(Buffer.from(after.messageBytes).equals(Buffer.from(before.messageBytes))).toBe(true);
  });
});

describe('binding is evaluated independently of policy', () => {
  it('reports the outflow it measured, not merely a verdict', () => {
    const raw = buildTx({
      feePayer: MINT_A,
      instructions: [...computeBudgetIxs(200_000, 1_000n), systemTransfer(12_345n)],
    });
    const r = evaluateBinding(decodeTransaction(raw), intent(), 1_000_000);
    expect(r.lamportOutflow).toBe(12_345n);
    expect(r.priorityFeeLamports).toBe(200n);
    expect(r.bound).toBe(true);
  });

  it('bounds a sell by fees alone, since its input is not SOL', () => {
    const raw = buildTx({
      feePayer: MINT_A,
      instructions: [...computeBudgetIxs(200_000, 1_000n), systemTransfer(50_000_000n)],
    });
    const sell = intent({ side: 'sell', inputMint: MINT_B, outputMint: MINT_A });
    const r = evaluateBinding(decodeTransaction(raw), sell, 1_000_000);
    expect(r.bound).toBe(false);
    expect(r.violations[0]?.violation).toBe('lamport_outflow_exceeds_intent');
  });

  it('refuses a System instruction whose transfer payload cannot be read', () => {
    const raw = buildTx({
      feePayer: MINT_A,
      instructions: [
        ...computeBudgetIxs(200_000, 1_000n),
        { program: SYSTEM_PROGRAM, accounts: [0, 1], data: [...u32le(2), 1, 2, 3] },
      ],
    });
    const r = evaluateBinding(decodeTransaction(raw), intent(), 1_000_000);
    expect(r.bound).toBe(false);
    expect(r.violations[0]?.violation).toBe('undecodable_system_transfer');
  });
});
