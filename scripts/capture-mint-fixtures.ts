import { writeFileSync, mkdirSync } from 'node:fs';
import { RateLimiter } from '../packages/adapters/src/ratelimit.js';
import { SolanaRpc } from '../packages/solana/src/rpc.js';
import { decodeMint } from '../packages/solana/src/mint.js';

/**
 * Captures real mainnet mint accounts as offline fixtures.
 *
 * The decoder's unit tests must run without a network, but they must also test
 * bytes that actually occur on mainnet rather than bytes we invented to match
 * our own reading of the layout.
 */

const TARGETS: Record<string, string> = {
  wsol: 'So11111111111111111111111111111111111111112',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // Token-2022 with TransferFeeConfig and metadata extensions.
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  // Token-2022, widely held.
  usdg: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
};

async function main(): Promise<void> {
  const limiter = RateLimiter.fromConfig(false);
  const endpoint = process.env['SOLANA_RPC_HTTP'] ?? 'https://api.mainnet-beta.solana.com';
  const rpc = new SolanaRpc(limiter, { primary: endpoint, fallback: null });

  mkdirSync('tests/fixtures/mints', { recursive: true });
  const summary: Record<string, unknown> = {};

  for (const [name, mint] of Object.entries(TARGETS)) {
    try {
      const account = await rpc.getAccountRaw(mint);
      writeFileSync(
        `tests/fixtures/mints/${name}.json`,
        JSON.stringify({ mint, owner: account.owner, slot: account.slot, dataBase64: account.dataBase64 }, null, 2),
      );
      const d = decodeMint(new Uint8Array(Buffer.from(account.dataBase64, 'base64')), account.owner);
      summary[name] = {
        mint,
        slot: account.slot,
        program: d.programId,
        decimals: d.decimals,
        supply: String(d.supply),
        mintAuthority: d.mintAuthority,
        freezeAuthority: d.freezeAuthority,
        extensions: d.extensions.map((e) => `${e.discriminant}:${e.name}`),
        transferFee: d.transferFee ? { bps: d.transferFee.basisPoints, max: String(d.transferFee.maximumFee) } : null,
        hostile: d.hostileExtensions,
      };
      console.log(name, JSON.stringify(summary[name], null, 1));
    } catch (e) {
      console.error(`FAILED ${name} (${mint}):`, (e as Error).message);
      summary[name] = { mint, error: (e as Error).message };
    }
  }

  writeFileSync('tests/fixtures/mints/summary.json', JSON.stringify(summary, null, 2));
}

void main();
