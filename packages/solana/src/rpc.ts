import { z } from 'zod';
import { classifyHolder, loadEntityRegistry, type HolderClass } from './entity-registry.js';
import { fetchJson, SourceFetchError } from '../../adapters/src/http.js';
import type { RateLimiter } from '../../adapters/src/ratelimit.js';
import { assertPubkey, base58Encode as base58EncodeBytes } from './base58.js';
import { decodeMint, MintDecodeError, type DecodedMint } from './mint.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Minimal Solana JSON-RPC client.
 *
 * Deliberately not @solana/web3.js: we need four read methods, and every
 * dependency in this path is a dependency that can be compromised into
 * lying to us about mint authority. The surface here is small enough to audit.
 *
 * The client is READ-ONLY. There is no sendTransaction method, so no code path
 * in observe, paper, replay or backtest can reach the network with a signature
 * even if a later bug tried to.
 */

const RPC_SOURCE = 'solana_rpc';
const SCHEMA_VERSION = '2026-08-11';
const PARSER_VERSION = '0.1.0';

const RpcErrorSchema = z.object({ code: z.number(), message: z.string() }).passthrough();

function rpcEnvelope<T extends z.ZodTypeAny>(result: T) {
  return z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      result: result.optional(),
      error: RpcErrorSchema.optional(),
    })
    .passthrough();
}

const AccountValueSchema = z
  .object({
    // base64 encoding is requested explicitly; jsonParsed would let the node
    // decide what the account means, and that is precisely our job.
    data: z.tuple([z.string(), z.literal('base64')]),
    executable: z.boolean(),
    lamports: z.number(),
    owner: z.string(),
    rentEpoch: z.union([z.number(), z.string()]).optional(),
    space: z.number().optional(),
  })
  .passthrough();

const GetAccountInfoSchema = rpcEnvelope(
  z.object({ context: z.object({ slot: z.number() }).passthrough(), value: AccountValueSchema.nullable() }).passthrough(),
);

const GetSlotSchema = rpcEnvelope(z.number());

const GetHealthSchema = rpcEnvelope(z.string());

const GetBalanceSchema = rpcEnvelope(
  z.object({ context: z.object({ slot: z.number() }).passthrough(), value: z.number() }).passthrough(),
);

const TokenAmountSchema = z
  .object({ amount: z.string(), decimals: z.number(), uiAmountString: z.string().optional() })
  .passthrough();

const GetTokenLargestAccountsSchema = rpcEnvelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z.array(TokenAmountSchema.extend({ address: z.string() })),
    })
    .passthrough(),
);

const GetTokenSupplySchema = rpcEnvelope(
  z.object({ context: z.object({ slot: z.number() }).passthrough(), value: TokenAmountSchema }).passthrough(),
);

const GetMultipleAccountsSchema = rpcEnvelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z.array(AccountValueSchema.nullable()),
    })
    .passthrough(),
);

export class RpcError extends Error {
  constructor(
    readonly kind: 'rpc_error' | 'no_endpoint' | 'account_missing' | 'not_a_mint',
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RawAccount {
  readonly pubkey: string;
  readonly slot: number;
  readonly owner: string;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly dataBase64: string;
}

export interface MintFacts {
  readonly mint: string;
  readonly slot: number;
  readonly decoded: DecodedMint;
  readonly lamports: bigint;
}

export interface RpcEndpoints {
  readonly primary: string | null;
  readonly fallback: string | null;
}

export class SolanaRpc {
  private nextId = 1;

  constructor(
    private readonly limiter: RateLimiter,
    private readonly endpoints: RpcEndpoints,
  ) {}

  get configured(): boolean {
    return this.endpoints.primary !== null || this.endpoints.fallback !== null;
  }

  private urls(): string[] {
    return [this.endpoints.primary, this.endpoints.fallback].filter((u): u is string => u !== null);
  }

  private async call<T>(method: string, params: unknown[], schema: z.ZodType<T>): Promise<T> {
    const urls = this.urls();
    if (urls.length === 0) {
      throw new RpcError('no_endpoint', 'no Solana RPC endpoint configured (SOLANA_RPC_HTTP)');
    }
    let last: unknown = null;
    for (const url of urls) {
      try {
        const res = await fetchJson(this.limiter, {
          url,
          source: RPC_SOURCE,
          sourceType: 'direct_chain',
          bucket: 'solana_rpc',
          schema,
          schemaVersion: SCHEMA_VERSION,
          parserVersion: PARSER_VERSION,
          method: 'POST',
          body: { jsonrpc: '2.0', id: this.nextId++, method, params },
          timeoutMs: 12_000,
        });
        return res.data;
      } catch (e) {
        // Falling back is only legitimate for transport-level failures. A
        // schema drift means the response was understood and was wrong, and
        // asking a different host until one agrees with us is how a bug
        // becomes a silent policy change.
        last = e;
        if (e instanceof SourceFetchError && e.kind === 'schema_drift') throw e;
      }
    }
    throw last instanceof Error ? last : new RpcError('rpc_error', `all RPC endpoints failed for ${method}`);
  }

  private unwrap<R>(env: { result?: R; error?: { code: number; message: string } }, method: string): R {
    if (env.error) {
      throw new RpcError('rpc_error', `${method} failed: ${env.error.code} ${env.error.message.slice(0, 200)}`);
    }
    if (env.result === undefined) {
      throw new RpcError('rpc_error', `${method} returned neither result nor error`);
    }
    return env.result;
  }

  async getSlot(): Promise<number> {
    const env = await this.call('getSlot', [{ commitment: 'confirmed' }], GetSlotSchema);
    return this.unwrap(env, 'getSlot');
  }

  async getHealth(): Promise<string> {
    const env = await this.call('getHealth', [], GetHealthSchema);
    return this.unwrap(env, 'getHealth');
  }

  async getBalanceLamports(pubkey: string): Promise<bigint> {
    assertPubkey(pubkey, 'balance pubkey');
    const env = await this.call('getBalance', [pubkey, { commitment: 'confirmed' }], GetBalanceSchema);
    // JSON numbers are doubles; a balance above 2^53 would already have been
    // damaged by the parser, so refuse rather than persist a rounded lie.
    const value = this.unwrap(env, 'getBalance').value;
    if (!Number.isSafeInteger(value)) {
      throw new RpcError('rpc_error', `getBalance returned unsafe integer ${value}`);
    }
    return BigInt(value);
  }

  async getAccountRaw(pubkey: string): Promise<RawAccount> {
    assertPubkey(pubkey, 'account');
    const env = await this.call(
      'getAccountInfo',
      [pubkey, { encoding: 'base64', commitment: 'confirmed' }],
      GetAccountInfoSchema,
    );
    const result = this.unwrap(env, 'getAccountInfo');
    if (result.value === null) {
      throw new RpcError('account_missing', `${pubkey} has no account at confirmed commitment`);
    }
    return {
      pubkey,
      slot: result.context.slot,
      owner: result.value.owner,
      executable: result.value.executable,
      lamports: BigInt(result.value.lamports),
      dataBase64: result.value.data[0],
    };
  }

  async getTokenLargestAccounts(
    mint: string,
  ): Promise<{ slot: number; accounts: { address: string; amount: bigint }[] }> {
    assertPubkey(mint, 'mint');
    const env = await this.call(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
      GetTokenLargestAccountsSchema,
    );
    const result = this.unwrap(env, 'getTokenLargestAccounts');
    return {
      slot: result.context.slot,
      // Amounts arrive as decimal strings precisely because they can exceed
      // 2^53; parsing them as numbers first would corrupt them silently.
      accounts: result.value.map((v) => ({ address: v.address, amount: BigInt(v.amount) })),
    };
  }

  async getTokenSupply(mint: string): Promise<{ slot: number; amount: bigint; decimals: number }> {
    assertPubkey(mint, 'mint');
    const env = await this.call('getTokenSupply', [mint, { commitment: 'confirmed' }], GetTokenSupplySchema);
    const result = this.unwrap(env, 'getTokenSupply');
    return { slot: result.context.slot, amount: BigInt(result.value.amount), decimals: result.value.decimals };
  }

  /**
   * Resolves each token account to its owning wallet, and reports whether that
   * wallet is a plain System-Program-owned account or a program-derived one.
   */
  async getTokenAccountOwners(
    tokenAccounts: readonly string[],
  ): Promise<Map<string, { owner: string; systemOwned: boolean; ownerProgram: string | null }>> {
    const out = new Map<string, { owner: string; systemOwned: boolean; ownerProgram: string | null }>();
    if (tokenAccounts.length === 0) return out;

    const accounts = await this.getMultipleAccountsRaw(tokenAccounts);
    const ownerByTokenAccount = new Map<string, string>();
    for (const [address, account] of accounts) {
      if (account === null) continue;
      const data = Buffer.from(account.dataBase64, 'base64');
      if (data.length < SPL_ACCOUNT_OWNER_OFFSET + 32) continue;
      ownerByTokenAccount.set(
        address,
        base58EncodeBytes(new Uint8Array(data.subarray(SPL_ACCOUNT_OWNER_OFFSET, SPL_ACCOUNT_OWNER_OFFSET + 32))),
      );
    }

    const uniqueOwners = [...new Set(ownerByTokenAccount.values())];
    const ownerAccounts = await this.getMultipleAccountsRaw(uniqueOwners);
    const ownerProgram = new Map<string, string | null>();
    for (const owner of uniqueOwners) {
      const info = ownerAccounts.get(owner);
      // A wallet that has never been funded has no account at all; it is still
      // a wallet, not a program. An account the RPC did not return at all is a
      // different case and is reported as null so the caller can refuse to
      // guess -- see classifyHolder().
      ownerProgram.set(owner, info === null || info === undefined ? SYSTEM_PROGRAM_ID : info.owner);
    }

    for (const [tokenAccount, owner] of ownerByTokenAccount) {
      const program = ownerProgram.get(owner) ?? null;
      out.set(tokenAccount, { owner, systemOwned: program === SYSTEM_PROGRAM_ID, ownerProgram: program });
    }
    return out;
  }

  private async getMultipleAccountsRaw(
    pubkeys: readonly string[],
  ): Promise<Map<string, { owner: string; dataBase64: string } | null>> {
    const out = new Map<string, { owner: string; dataBase64: string } | null>();
    // getMultipleAccounts accepts at most 100 keys per call.
    for (let i = 0; i < pubkeys.length; i += 100) {
      const chunk = pubkeys.slice(i, i + 100);
      for (const k of chunk) assertPubkey(k, 'account');
      const env = await this.call(
        'getMultipleAccounts',
        [chunk, { encoding: 'base64', commitment: 'confirmed' }],
        GetMultipleAccountsSchema,
      );
      const result = this.unwrap(env, 'getMultipleAccounts');
      if (result.value.length !== chunk.length) {
        throw new RpcError('rpc_error', `getMultipleAccounts returned ${result.value.length} of ${chunk.length}`);
      }
      chunk.forEach((key, idx) => {
        const v = result.value[idx];
        out.set(key, v == null ? null : { owner: v.owner, dataBase64: v.data[0] });
      });
    }
    return out;
  }

  /**
   * The authoritative answer to "can this token be frozen, inflated, taxed or
   * seized". Provider-reported flags are a convenience; this is the fact.
   */
  async getMintFacts(mint: string): Promise<MintFacts> {
    const account = await this.getAccountRaw(mint);
    if (account.executable) {
      throw new RpcError('not_a_mint', `${mint} is an executable account, not a mint`);
    }
    const raw = Buffer.from(account.dataBase64, 'base64');
    return {
      mint,
      slot: account.slot,
      decoded: decodeMint(new Uint8Array(raw), account.owner),
      lamports: account.lamports,
    };
  }
}

export function isFailClosedDecodeError(e: unknown): e is MintDecodeError {
  return e instanceof MintDecodeError;
}

export interface HolderShare {
  readonly tokenAccount: string;
  readonly owner: string | null;
  readonly amount: bigint;
  readonly pctOfSupply: number;
  /**
   * WALLET | VERIFIED_PROGRAM_CONTROLLED | UNKNOWN.
   *
   * Replaces a boolean that had to answer two questions at once and got the
   * second one wrong: an unresolved owner was reported as program-controlled
   * and therefore excluded from wallet concentration, so a holder we failed to
   * look up made the token look SAFER. See entity-registry.ts.
   */
  readonly holderClass: HolderClass;
  readonly holderClassDetail: string;
  /** Program owning the holder's account. Null when unresolved. */
  readonly ownerProgram: string | null;
  /** True ONLY for verified market inventory. */
  readonly programControlled: boolean;
}

export interface ConcentrationFacts {
  readonly mint: string;
  readonly slot: number;
  readonly supply: bigint;
  readonly holders: readonly HolderShare[];
  /** Largest single independent wallet, as a percentage of supply. */
  readonly topWalletPct: number | null;
  /** Top ten independent wallets combined. */
  readonly topTenWalletPct: number | null;
  /** Supply in VERIFIED market inventory: pools, curves, vaults. */
  readonly programControlledPct: number;
  /**
   * Supply held by owners we could not classify.
   *
   * Counted INSIDE the wallet figures, and reported separately so the gate can
   * say how much of its own number rests on an unknown.
   */
  readonly unknownOwnerPct: number;
  /** Version stamp of the program registry used to classify. */
  readonly registryVersion: string;
}

const SPL_ACCOUNT_OWNER_OFFSET = 32;

/**
 * On-chain holder concentration.
 *
 * The provider-reported percentage is a convenience that is missing for most
 * fresh tokens and, where present, counts the liquidity pool as a holder. The
 * pool is not a whale that can dump on us — it is the counterparty we trade
 * against — so it is measured separately rather than blended in.
 *
 * Program-controlled inventory is identified structurally: a real wallet's
 * account is owned by the System Program, whereas a pool authority is a PDA
 * owned by its AMM. This is a shape test, not a hardcoded venue list, so a new
 * launchpad does not silently defeat it.
 */
export async function fetchConcentration(rpc: SolanaRpc, mint: string): Promise<ConcentrationFacts> {
  const [largest, supply] = await Promise.all([rpc.getTokenLargestAccounts(mint), rpc.getTokenSupply(mint)]);

  if (supply.amount <= 0n) {
    throw new RpcError('rpc_error', `mint ${mint} reports zero supply`);
  }

  const owners = await rpc.getTokenAccountOwners(largest.accounts.map((a) => a.address));

  const registry = loadEntityRegistry();
  const holders: HolderShare[] = largest.accounts.map((a) => {
    const o = owners.get(a.address) ?? null;
    const cls = classifyHolder(
      { owner: o?.owner ?? null, ownerProgram: o?.ownerProgram ?? null },
      registry,
    );
    return {
      tokenAccount: a.address,
      owner: o?.owner ?? null,
      amount: a.amount,
      pctOfSupply: Number((a.amount * 1_000_000n) / supply.amount) / 10_000,
      holderClass: cls.holderClass,
      holderClassDetail: cls.detail,
      ownerProgram: o?.ownerProgram ?? null,
      programControlled: cls.excludedFromWalletConcentration,
    };
  });

  // Only VERIFIED market inventory is excluded. An unresolved owner and a
  // creator-controlled PDA both count as wallets, because both can sell.
  const wallets = holders.filter((h) => !h.programControlled);
  const topWalletPct = wallets.length > 0 ? Math.max(...wallets.map((w) => w.pctOfSupply)) : null;
  const topTenWalletPct =
    wallets.length > 0
      ? wallets
          .map((w) => w.pctOfSupply)
          .sort((a, b) => b - a)
          .slice(0, 10)
          .reduce((a, b) => a + b, 0)
      : null;
  const programControlledPct = holders.filter((h) => h.programControlled).reduce((a, h) => a + h.pctOfSupply, 0);
  const unknownOwnerPct = holders
    .filter((h) => h.holderClass === 'UNKNOWN')
    .reduce((a, h) => a + h.pctOfSupply, 0);

  return {
    mint,
    slot: largest.slot,
    supply: supply.amount,
    holders,
    unknownOwnerPct,
    registryVersion: registry.version,
    topWalletPct,
    topTenWalletPct,
    programControlledPct,
  };
}

export { SPL_ACCOUNT_OWNER_OFFSET };
