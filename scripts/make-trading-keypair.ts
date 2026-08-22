/**
 * Generate a Solana keypair for the canary calibration run.
 *
 * WHY THIS EXISTS AS A SCRIPT rather than a shell one-liner: the file format is not obvious and
 * getting it wrong produces a key that looks fine and cannot sign. A Solana keypair file is a
 * JSON array of 64 bytes — the 32-byte ed25519 SEED followed by the 32-byte PUBLIC key — and
 * `packages/execution/src/signer.ts` validates exactly that, including checking that the stored
 * public half actually derives from the secret half.
 *
 * WHAT THIS PRINTS: the public key only. The secret never reaches stdout, a log, or the model.
 *
 * WHERE IT WRITES: outside the repository by default, so it can never be committed and never
 * matches a `Read()` glob that would pull it into a transcript.
 *
 * REFUSES TO OVERWRITE. A keypair file that already holds funds must not be silently replaced —
 * that is an irreversible loss of whatever is in it.
 */
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { base58Encode } from '../packages/solana/src/base58.js';

const arg = (n: string): string | null => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const out = resolve(arg('out') ?? `${homedir()}/.solmeme/canary-keypair.json`);

if (existsSync(out)) {
  console.error(`REFUSING: ${out} already exists.`);
  console.error('If it holds funds, overwriting it destroys them. Move it aside yourself first.');
  process.exit(2);
}

const { privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
if (jwk.d === undefined || jwk.x === undefined) throw new Error('ed25519 jwk export lacked d or x');
const seed = Buffer.from(jwk.d, 'base64url');
const pub = Buffer.from(jwk.x, 'base64url');
if (seed.length !== 32 || pub.length !== 32) throw new Error(`expected 32/32, got ${seed.length}/${pub.length}`);

// Prove the pair actually signs before writing it. A keypair that cannot sign is worse than none:
// it fails at the moment funds are already in it.
const msg = Buffer.from('solmeme canary keypair self-test');
if (!verify(null, msg, createPublicKey(privateKey), sign(null, msg, privateKey))) {
  throw new Error('generated key failed its own sign/verify check');
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
try { chmodSync(out, 0o600); } catch { /* Windows ACLs differ; the signer's own check reports it */ }

console.log('');
console.log('  KEYPAIR CREATED');
console.log(`  file        ${out}`);
console.log(`  PUBLIC KEY  ${base58Encode(new Uint8Array(pub))}`);
console.log('');
console.log('  ^ that is the address to fund. The secret half is in the file above and was');
console.log('    never printed. Back that file up before sending anything to this address:');
console.log('    lose it and the funds are gone permanently.');
console.log('');
console.log('  NEXT: point TRADING_KEYPAIR_PATH at that file in .env, then run');
console.log('    npx tsx scripts/doctor.ts --mode=canary');
console.log('  yourself — the guard blocks me from running it.');
console.log('');
