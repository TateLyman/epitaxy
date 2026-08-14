import { z } from 'zod';
import { classifyHolder, loadEntityRegistry, type HolderClass } from './entity-registry.js';
import { fetchJson, SourceFetchError } from '../../adapters/src/http.js';
import type { RateLimiter } from '../../adapters/src/ratelimit.js';
import {
  assertPubkey,
  base58Encode as base58EncodeBytes,
  base58Decode as base58DecodeBytes,
  BASE58_INSTRUCTION_DATA_MAX_LENGTH,
} from './base58.js';
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
const GetEpochInfoSchema = rpcEnvelope(z.object({ epoch: z.number() }).passthrough());
const GetSignaturesSchema = rpcEnvelope(
  z.array(z.object({ signature: z.string(), blockTime: z.number().nullable().optional() }).passthrough()),
);
const GetTransactionMetaSchema = rpcEnvelope(
  z
    .object({
      slot: z.number().optional(),
      blockTime: z.number().nullable().optional(),
      meta: z
        .object({
          err: z.unknown().nullable().optional(),
          fee: z.number().optional(),
          preTokenBalances: z.array(z.unknown()).nullable().optional(),
          postTokenBalances: z.array(z.unknown()).nullable().optional(),
          preBalances: z.array(z.number()).nullable().optional(),
          postBalances: z.array(z.number()).nullable().optional(),
          logMessages: z.array(z.string()).nullable().optional(),
          innerInstructions: z.array(z.unknown()).nullable().optional(),
        })
        .passthrough()
        .nullable(),
      transaction: z
        .object({
          message: z
            .object({ accountKeys: z.array(z.unknown()), instructions: z.array(z.unknown()).optional() })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .nullable(),
);
const GetTransactionSchema = rpcEnvelope(
  z
    .object({
      transaction: z
        .object({ message: z.object({ accountKeys: z.array(z.unknown()) }).passthrough() })
        .passthrough(),
    })
    .passthrough()
    .nullable(),
);

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

const GetBlockTimeSchema = rpcEnvelope(z.number().nullable());

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

export interface CoherentRawAccount {
  readonly pubkey: string;
  /** The slot the NODE served this batch at, not one the caller assumed. */
  readonly slot: number;
  readonly owner: string;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly dataBase64: string;
  /** null when the provider omitted it. Never silently 0. */
  readonly rentEpoch: bigint | null;
  readonly space: number | null;
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

  /**
   * The current epoch.
   *
   * A Token-2022 transfer-fee config carries an older and a newer schedule and
   * the epoch is what selects between them. Without it the decoder has to
   * assume the worst of the two, which is safe and is also wrong most of the
   * time — the newer schedule is usually not live yet, and grading every such
   * mint at its future fee rejects tokens for a cost nobody is paying.
   */
  async getEpoch(): Promise<bigint> {
    const env = await this.call('getEpochInfo', [{ commitment: 'confirmed' }], GetEpochInfoSchema);
    const value = this.unwrap(env, 'getEpochInfo').epoch;
    if (!Number.isSafeInteger(value)) {
      throw new RpcError('rpc_error', `getEpochInfo returned unsafe integer ${value}`);
    }
    return BigInt(value);
  }

  /**
   * Signatures for an address, oldest LAST as the RPC returns them.
   *
   * Bounded by the caller because an address with a long history is not one
   * this system needs the history of: the entity link it is looking for is the
   * account's FIRST transaction, and a token account that has thousands of them
   * is not a fresh holder of a fresh memecoin.
   */
  /**
   * `before` walks BACKWARD through history.
   *
   * Without it a caller can only ever see the newest page, and "the last entry
   * of the newest page" is not the oldest transaction — it is simply the oldest
   * of the most recent N. A pool needing 25 pages to reach its creation looks
   * identical to one created 30 signatures ago.
   */
  async getSignaturesForAddress(
    address: string,
    limit = 50,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null }[]> {
    assertPubkey(address, 'signatures address');
    const cfg: Record<string, unknown> = { limit, commitment: 'confirmed' };
    if (before !== undefined) cfg['before'] = before;
    const env = await this.call('getSignaturesForAddress', [address, cfg], GetSignaturesSchema);
    return this.unwrap(env, 'getSignaturesForAddress').map((r) => ({
      signature: r.signature,
      blockTime: r.blockTime ?? null,
    }));
  }

  /**
   * The fee payer of a transaction: account key zero, by definition.
   *
   * Null rather than a throw when the transaction cannot be read, because the
   * caller's correct response to "unknown funder" is to mark the holder's
   * history unknown — not to drop the holder, and certainly not to treat it as
   * independently funded.
   */
  async getTransactionFeePayer(signature: string): Promise<string | null> {
    const env = await this.call(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      GetTransactionSchema,
    );
    const tx = this.unwrap(env, 'getTransaction');
    if (tx === null) return null;
    const first = tx.transaction.message.accountKeys[0];
    if (typeof first === 'string') return first;
    if (typeof first === 'object' && first !== null && 'pubkey' in first) {
      const k = (first as { pubkey?: unknown }).pubkey;
      return typeof k === 'string' ? k : null;
    }
    return null;
  }

  /**
   * A transaction's instructions, in order, with their accounts resolved.
   *
   * P7 needs this because migration identity must come from an instruction's
   * OWN account list, not from the order strings happen to appear in the logs.
   * Log ordering is not an interface; it is an implementation detail of whatever
   * emitted it, and taking `mint` from the first base58 string and `pool` from
   * the second produced zero correct pairs out of three hundred.
   *
   * Inner (CPI) instructions are included and flattened in execution order,
   * because a migration invoked through a router appears only there.
   */
  async getTransactionInstructions(signature: string): Promise<{
    signature: string;
    slot: number | null;
    blockTime: number | null;
    failed: boolean;
    accountKeys: string[];
    tokenBalanceMints: string[];
    instructions: { programId: string; accounts: string[]; dataHex: string | null }[];
  } | null> {
    const env = await this.call(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      GetTransactionMetaSchema,
    );
    const tx = this.unwrap(env, 'getTransaction');
    if (tx === null || tx.meta === null || tx.meta === undefined) return null;

    const accountKeys = tx.transaction.message.accountKeys.map((k) => {
      if (typeof k === 'string') return k;
      const o = k as { pubkey?: unknown };
      return typeof o.pubkey === 'string' ? o.pubkey : '';
    });

    const readIx = (raw: unknown): { programId: string; accounts: string[]; dataHex: string | null } | null => {
      const o = raw as { programId?: unknown; accounts?: unknown; data?: unknown };
      if (typeof o.programId !== 'string') return null;
      const accounts = Array.isArray(o.accounts)
        ? o.accounts.filter((a): a is string => typeof a === 'string')
        : [];
      // jsonParsed leaves an unrecognised program's instruction data as a
      // base58 string. That is what carries the anchor discriminator, and
      // without it a swap against a pool is indistinguishable from the
      // instruction that created it. Null when the node returned a fully
      // parsed form with no raw data — refused rather than assumed.
      let dataHex: string | null = null;
      if (typeof o.data === 'string' && o.data.length > 0) {
        try {
          dataHex = Buffer.from(base58DecodeBytes(o.data, BASE58_INSTRUCTION_DATA_MAX_LENGTH)).toString('hex');
        } catch {
          dataHex = null;
        }
      }
      return { programId: o.programId, accounts, dataHex };
    };

    const instructions: { programId: string; accounts: string[]; dataHex: string | null }[] = [];
    for (const raw of tx.transaction.message.instructions ?? []) {
      const ix = readIx(raw);
      if (ix !== null) instructions.push(ix);
    }
    for (const group of tx.meta.innerInstructions ?? []) {
      const g = group as { instructions?: unknown };
      if (!Array.isArray(g.instructions)) continue;
      for (const raw of g.instructions) {
        const ix = readIx(raw);
        if (ix !== null) instructions.push(ix);
      }
    }

    const mints = new Set<string>();
    for (const rows of [tx.meta.preTokenBalances, tx.meta.postTokenBalances]) {
      for (const r of rows ?? []) {
        const m = (r as { mint?: unknown }).mint;
        if (typeof m === 'string') mints.add(m);
      }
    }

    return {
      signature,
      slot: tx.slot ?? null,
      blockTime: tx.blockTime ?? null,
      failed: tx.meta.err !== null && tx.meta.err !== undefined,
      accountKeys,
      tokenBalanceMints: [...mints],
      instructions,
    };
  }

  /**
   * A landed transaction, with the balance deltas the chain itself recorded.
   *
   * The point of this method is that `meta.preTokenBalances` carries the pool
   * vaults' contents BEFORE the swap. That is state at a historical slot, and
   * reading it normally needs an archival node — but the transaction carries
   * its own before-and-after, so a landed swap can be compared against a model
   * without any archival access at all.
   */
  async getTransactionWithMeta(signature: string): Promise<LandedTransaction | null> {
    const env = await this.call(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      GetTransactionMetaSchema,
    );
    const tx = this.unwrap(env, 'getTransaction');
    if (tx === null || tx.meta === null || tx.meta === undefined) return null;

    const balances = (rows: unknown[] | null | undefined): TokenBalanceRow[] =>
      (rows ?? []).flatMap((r) => {
        const o = r as {
          accountIndex?: number;
          mint?: string;
          owner?: string;
          uiTokenAmount?: { amount?: string };
        };
        if (typeof o.accountIndex !== 'number' || typeof o.mint !== 'string') return [];
        const amount = o.uiTokenAmount?.amount;
        if (typeof amount !== 'string') return [];
        return [{ accountIndex: o.accountIndex, mint: o.mint, owner: o.owner ?? null, amount: BigInt(amount) }];
      });

    const keys = tx.transaction.message.accountKeys.map((k) => {
      if (typeof k === 'string') return k;
      const o = k as { pubkey?: unknown };
      return typeof o.pubkey === 'string' ? o.pubkey : '';
    });

    return {
      signature,
      slot: tx.slot ?? null,
      blockTime: tx.blockTime ?? null,
      failed: tx.meta.err !== null && tx.meta.err !== undefined,
      feeLamports: BigInt(tx.meta.fee ?? 0),
      accountKeys: keys,
      preTokenBalances: balances(tx.meta.preTokenBalances),
      postTokenBalances: balances(tx.meta.postTokenBalances),
      preBalances: (tx.meta.preBalances ?? []).map((n) => BigInt(n)),
      postBalances: (tx.meta.postBalances ?? []).map((n) => BigInt(n)),
      logMessages: tx.meta.logMessages ?? [],
    };
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

  /**
   * A batched read that keeps what a coherent snapshot needs.
   *
   * `getMultipleAccountsRaw` drops the context slot and the rent epoch, so a
   * caller cannot tell whether two accounts it received were ever true at the
   * same time. That is the difference between a snapshot and a bag of reads:
   * this returns the slot the NODE says each batch was served at, so the caller
   * can enforce coherence instead of assuming it.
   *
   * `minContextSlot` makes the node refuse rather than serve a stale replica.
   * A refusal is information; a silently older account is a state that never
   * coexisted with the ones around it.
   */
  async getMultipleAccountsAtSlot(
    pubkeys: readonly string[],
    opts: { minContextSlot?: number; commitment?: 'confirmed' | 'finalized' } = {},
  ): Promise<{ contextSlot: number; accounts: Map<string, CoherentRawAccount | null> }> {
    const commitment = opts.commitment ?? 'confirmed';
    const out = new Map<string, CoherentRawAccount | null>();
    let low: number | null = null;
    let high: number | null = null;

    for (let i = 0; i < pubkeys.length; i += 100) {
      const chunk = pubkeys.slice(i, i + 100);
      for (const k of chunk) assertPubkey(k, 'account');
      const cfg: Record<string, unknown> = { encoding: 'base64', commitment };
      if (opts.minContextSlot !== undefined) cfg['minContextSlot'] = opts.minContextSlot;
      const env = await this.call('getMultipleAccounts', [chunk, cfg], GetMultipleAccountsSchema);
      const result = this.unwrap(env, 'getMultipleAccounts');
      if (result.value.length !== chunk.length) {
        throw new RpcError('rpc_error', `getMultipleAccounts returned ${result.value.length} of ${chunk.length}`);
      }
      const slot = result.context.slot;
      low = low === null || slot < low ? slot : low;
      high = high === null || slot > high ? slot : high;
      chunk.forEach((key, idx) => {
        const v = result.value[idx];
        out.set(
          key,
          v == null
            ? null
            : {
                pubkey: key,
                slot,
                owner: v.owner,
                executable: v.executable,
                lamports: BigInt(v.lamports),
                dataBase64: v.data[0],
                // Never hardcoded to 0. A wrong rent epoch changes whether an
                // account is rent-exempt in a replayed runtime.
                rentEpoch: v.rentEpoch === undefined ? null : BigInt(v.rentEpoch),
                space: v.space ?? null,
              },
        );
      });
    }
    return { contextSlot: high ?? low ?? 0, accounts: out };
  }

  /** The chain's own time for a slot. `Date.now()` is this machine's opinion. */
  async getBlockTime(slot: number): Promise<number | null> {
    const env = await this.call('getBlockTime', [slot], GetBlockTimeSchema);
    return this.unwrap(env, 'getBlockTime');
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
export interface TokenBalanceRow {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner: string | null;
  readonly amount: bigint;
}

export interface LandedTransaction {
  readonly signature: string;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly failed: boolean;
  readonly feeLamports: bigint;
  readonly accountKeys: readonly string[];
  /** What the chain recorded BEFORE the transaction. Ground truth, not a model. */
  readonly preTokenBalances: readonly TokenBalanceRow[];
  readonly postTokenBalances: readonly TokenBalanceRow[];
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly logMessages: readonly string[];
}

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
