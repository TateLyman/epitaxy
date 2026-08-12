import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { base58Encode } from '../../solana/src/base58.js';
import {
  evaluateTransactionPolicy,
  defaultLimits,
  type PolicyLimits,
  type PolicyResult,
} from '../../solana/src/txpolicy.js';
import { decodeTransaction, type DecodedTransaction } from '../../solana/src/transaction.js';
import { evaluateBinding, type BindingResult } from './binding.js';
import type { EffectVerdict } from './effect.js';
import type { TradeIntent } from '../../domain/src/types.js';

/**
 * The signer.
 *
 * It has exactly one entry point and that entry point does not accept a
 * transaction on its own. A function that takes bytes and returns a signature
 * is a remote code execution primitive pointed at our own wallet; the router
 * would only have to be wrong once. So signing requires the bytes AND the
 * intent that asked for them AND independent evidence of what the bytes will
 * do, and the three must agree.
 *
 * There is no "force" parameter and no way to obtain the private key from
 * outside this module. The key material is held in a KeyObject, which does not
 * serialise back to bytes through any accessor this class exposes.
 */

/** PKCS#8 prefix for a raw Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SOLANA_KEYPAIR_BYTES = 64;
const SEED_BYTES = 32;
const SIGNATURE_BYTES = 64;

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}

export type SignRefusalKind = 'policy' | 'binding' | 'effect' | 'wrong_signer';

export type SignOutcome =
  | {
      readonly signed: true;
      readonly transactionBase64: string;
      readonly signature: string;
      readonly decoded: DecodedTransaction;
    }
  | {
      readonly signed: false;
      readonly kind: SignRefusalKind;
      readonly detail: string;
      readonly policy: PolicyResult | null;
      readonly binding: BindingResult | null;
    };

function loadKeypairFile(path: string): { seed: Buffer; declaredPublicKey: Buffer } {
  const stat = statSync(path);
  if (!stat.isFile()) throw new SignerError(`keypair path ${path} is not a file`);
  // A world-readable key on a multi-user host is already compromised; refusing
  // here is the last moment at which that is cheap to fix.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new SignerError(`keypair ${path} is group/world accessible (mode ${(stat.mode & 0o777).toString(8)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SignerError(`keypair ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== SOLANA_KEYPAIR_BYTES) {
    throw new SignerError(`keypair ${path} must be a ${SOLANA_KEYPAIR_BYTES}-byte JSON array`);
  }
  for (const b of parsed) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new SignerError(`keypair ${path} contains a non-byte element`);
    }
  }
  const bytes = Buffer.from(parsed as number[]);
  return { seed: bytes.subarray(0, SEED_BYTES), declaredPublicKey: bytes.subarray(SEED_BYTES) };
}

export class Signer {
  private readonly key: KeyObject;
  readonly publicKey: string;

  private constructor(key: KeyObject, publicKey: string) {
    this.key = key;
    this.publicKey = publicKey;
  }

  /**
   * Loads a Solana keypair file. The public half stored in the file is checked
   * against the half derived from the seed rather than trusted: a file whose
   * two halves disagree would otherwise make us report one address while
   * signing as another, and every balance check downstream would be looking at
   * the wrong wallet.
   */
  static fromFile(path: string): Signer {
    const { seed, declaredPublicKey } = loadKeypairFile(path);
    const key = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    const derived = spki.subarray(spki.length - SEED_BYTES);
    if (!derived.equals(declaredPublicKey)) {
      throw new SignerError(
        `keypair ${path} is inconsistent: stored public key ${base58Encode(new Uint8Array(declaredPublicKey))} ` +
          `does not match the key derived from its secret half`,
      );
    }
    return new Signer(key, base58Encode(new Uint8Array(derived)));
  }

  limitsFor(maxPriorityFeeLamports: bigint): PolicyLimits {
    return defaultLimits(this.publicKey, maxPriorityFeeLamports);
  }

  /**
   * The only way to produce a signature.
   *
   * `effect` is supplied by the caller because verifying it requires the
   * network, and the signer must remain a pure function of things it has been
   * shown. It is not optional: a caller that cannot establish what the
   * transaction does gets a refusal, not a signature.
   */
  sign(args: {
    readonly raw: Uint8Array;
    readonly intent: TradeIntent;
    readonly effect: EffectVerdict;
    readonly nowUtcMs: number;
  }): SignOutcome {
    const { raw, intent, effect, nowUtcMs } = args;

    const policy = evaluateTransactionPolicy(raw, this.limitsFor(intent.maxPriorityFeeLamports));
    if (!policy.allowed || policy.decoded === null) {
      return {
        signed: false,
        kind: 'policy',
        detail: policy.violations.map((v) => `${v.violation}: ${v.detail}`).join('; '),
        policy,
        binding: null,
      };
    }

    const binding = evaluateBinding(policy.decoded, intent, nowUtcMs);
    if (!binding.bound) {
      return {
        signed: false,
        kind: 'binding',
        detail: binding.violations.map((v) => `${v.violation}: ${v.detail}`).join('; '),
        policy,
        binding,
      };
    }

    if (!effect.verified) {
      return {
        signed: false,
        kind: 'effect',
        detail: effect.refusals.map((r) => `${r.refusal}: ${r.detail}`).join('; '),
        policy,
        binding,
      };
    }

    const signature = edSign(null, Buffer.from(policy.decoded.messageBytes), this.key);
    if (signature.length !== SIGNATURE_BYTES) {
      throw new SignerError(`ed25519 produced ${signature.length} bytes`);
    }

    const signed = writeSignature(raw, signature);
    // Re-decoding proves the assembled bytes still parse to the same message we
    // signed. A signature written at the wrong offset would otherwise be
    // discovered by the cluster rather than by us.
    const recheck = decodeTransaction(signed);
    if (!Buffer.from(recheck.messageBytes).equals(Buffer.from(policy.decoded.messageBytes))) {
      throw new SignerError('signature placement altered the message body');
    }

    return {
      signed: true,
      transactionBase64: Buffer.from(signed).toString('base64'),
      signature: base58Encode(new Uint8Array(signature)),
      decoded: policy.decoded,
    };
  }
}

/**
 * Writes the signature into slot 0. The slot's position depends on the shortvec
 * length prefix, so it is computed from the bytes rather than assumed to be 1.
 */
export function writeSignature(raw: Uint8Array, signature: Uint8Array): Uint8Array {
  let prefixLen = 0;
  for (let i = 0; i < 3; i++) {
    prefixLen++;
    if (((raw[i] as number) & 0x80) === 0) break;
  }
  const out = new Uint8Array(raw);
  if (prefixLen + SIGNATURE_BYTES > out.length) {
    throw new SignerError('transaction is too short to hold a signature');
  }
  out.set(signature, prefixLen);
  return out;
}
