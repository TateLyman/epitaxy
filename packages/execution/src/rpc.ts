import { z } from 'zod';
import { fetchJson, SourceFetchError } from '../../adapters/src/http.js';
import type { RateLimiter } from '../../adapters/src/ratelimit.js';
import { assertPubkey } from '../../solana/src/base58.js';

/**
 * The only transaction-sending client in the repository.
 *
 * `packages/solana/src/rpc.ts` is read-only on purpose, and it stays that way:
 * observe, paper, replay and backtest all import from there and therefore
 * cannot reach the network with a signature no matter how a future bug is
 * written. Every write method lives here instead, in a package that those
 * entry points do not import, so "cannot send" is a property of the import
 * graph rather than of anyone's discipline.
 */

const RPC_SOURCE = 'solana_rpc_write';
const SCHEMA_VERSION = '2026-08-11';
const PARSER_VERSION = '0.1.0';

const RpcErrorSchema = z.object({ code: z.number(), message: z.string() }).passthrough();

function envelope<T extends z.ZodTypeAny>(result: T) {
  return z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.number(), z.string(), z.null()]),
      result: result.optional(),
      error: RpcErrorSchema.optional(),
    })
    .passthrough();
}

const AccountSchema = z
  .object({
    data: z.tuple([z.string(), z.literal('base64')]),
    lamports: z.number(),
    owner: z.string(),
  })
  .passthrough();

const SimulateSchema = envelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z
        .object({
          err: z.unknown().nullable(),
          logs: z.array(z.string()).nullable(),
          unitsConsumed: z.number().optional(),
          accounts: z.array(AccountSchema.nullable()).nullable().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
);

const BlockhashSchema = envelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number() }).passthrough(),
    })
    .passthrough(),
);

const MultipleAccountsSchema = envelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z.array(AccountSchema.nullable()),
    })
    .passthrough(),
);

const BlockHeightSchema = envelope(z.number());

const SendSchema = envelope(z.string());

const StatusSchema = envelope(
  z
    .object({
      context: z.object({ slot: z.number() }).passthrough(),
      value: z.array(
        z
          .object({
            slot: z.number(),
            confirmations: z.number().nullable(),
            err: z.unknown().nullable(),
            confirmationStatus: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable(),
      ),
    })
    .passthrough(),
);

const TokenBalanceSchema = z
  .object({
    accountIndex: z.number(),
    mint: z.string(),
    owner: z.string().optional(),
    uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }).passthrough(),
  })
  .passthrough();

const GetTransactionSchema = envelope(
  z
    .object({
      slot: z.number(),
      blockTime: z.number().nullable().optional(),
      meta: z
        .object({
          err: z.unknown().nullable(),
          fee: z.number(),
          preBalances: z.array(z.number()),
          postBalances: z.array(z.number()),
          preTokenBalances: z.array(TokenBalanceSchema).nullable().optional(),
          postTokenBalances: z.array(TokenBalanceSchema).nullable().optional(),
        })
        .passthrough()
        .nullable(),
      transaction: z
        .object({ message: z.object({ accountKeys: z.array(z.unknown()) }).passthrough() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .nullable(),
);

export class ExecutionRpcError extends Error {
  constructor(
    readonly kind: 'rpc_error' | 'no_endpoint' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionRpcError';
  }
}

export interface SimulationOutcome {
  readonly slot: number;
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
  /** Post-execution state of the accounts requested, in request order. */
  readonly accounts: readonly ({ lamports: bigint; owner: string; dataBase64: string } | null)[];
}

export interface ConfirmedTransaction {
  readonly slot: number;
  readonly blockTimeUtcMs: number | null;
  readonly err: unknown;
  readonly feeLamports: bigint;
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
  readonly postTokenBalances: readonly { accountIndex: number; mint: string; owner: string | null; amount: bigint }[];
}

export class ExecutionRpc {
  private nextId = 1;

  constructor(
    private readonly limiter: RateLimiter,
    private readonly endpoints: { primary: string | null; fallback: string | null },
  ) {}

  get configured(): boolean {
    return this.endpoints.primary !== null;
  }

  /**
   * Writes go to the primary endpoint only. Failing over a send is how the same
   * transaction gets broadcast twice under a network partition; a send that
   * fails is retried by the state machine against the recorded signature, not
   * by silently asking a second host.
   */
  private async call<T>(method: string, params: unknown[], schema: z.ZodType<T>, write: boolean): Promise<T> {
    const urls = write
      ? [this.endpoints.primary]
      : [this.endpoints.primary, this.endpoints.fallback];
    const live = urls.filter((u): u is string => u !== null);
    if (live.length === 0) {
      throw new ExecutionRpcError('no_endpoint', `no RPC endpoint configured for ${method}`);
    }
    let last: unknown = null;
    for (const url of live) {
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
          timeoutMs: 15_000,
          maxAttempts: write ? 1 : 3,
        });
        return res.data;
      } catch (e) {
        last = e;
        if (e instanceof SourceFetchError && e.kind === 'schema_drift') throw e;
      }
    }
    throw last instanceof Error ? last : new ExecutionRpcError('rpc_error', `${method} failed`);
  }

  private unwrap<R>(env: { result?: R; error?: { code: number; message: string } }, method: string): R {
    if (env.error) {
      throw new ExecutionRpcError('rpc_error', `${method}: ${env.error.code} ${env.error.message.slice(0, 300)}`);
    }
    if (env.result === undefined) throw new ExecutionRpcError('rpc_error', `${method} returned no result`);
    return env.result;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const env = await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }], BlockhashSchema, false);
    return this.unwrap(env, 'getLatestBlockhash').value;
  }

  /**
   * Runs the transaction against current state without signing it. This is how
   * the intended effect is established: the amounts live inside an aggregator's
   * instruction data whose layout we cannot verify at signing time, but the
   * balances the transaction actually produces are observable.
   */
  async simulate(rawBase64: string, addresses: readonly string[]): Promise<SimulationOutcome> {
    for (const a of addresses) assertPubkey(a, 'simulation account');
    const config: Record<string, unknown> = {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      encoding: 'base64',
    };
    if (addresses.length > 0) {
      config['accounts'] = { encoding: 'base64', addresses: [...addresses] };
    }
    const env = await this.call('simulateTransaction', [rawBase64, config], SimulateSchema, false);
    const r = this.unwrap(env, 'simulateTransaction');
    return {
      slot: r.context.slot,
      err: r.value.err ?? null,
      logs: r.value.logs ?? [],
      unitsConsumed: r.value.unitsConsumed ?? null,
      accounts: (r.value.accounts ?? []).map((a) =>
        a === null ? null : { lamports: BigInt(a.lamports), owner: a.owner, dataBase64: a.data[0] },
      ),
    };
  }

  /**
   * Current block height. Needed to prove a blockhash is dead: only then is a
   * missing transaction genuinely gone rather than merely not seen yet.
   */
  async getBlockHeight(): Promise<number> {
    const env = await this.call('getBlockHeight', [{ commitment: 'confirmed' }], BlockHeightSchema, false);
    return this.unwrap(env, 'getBlockHeight');
  }

  /** Pre-execution state, so a simulated post-state can be read as a delta. */
  async getAccounts(
    addresses: readonly string[],
  ): Promise<({ lamports: bigint; owner: string; dataBase64: string } | null)[]> {
    const out: ({ lamports: bigint; owner: string; dataBase64: string } | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      for (const a of chunk) assertPubkey(a, 'account');
      const env = await this.call(
        'getMultipleAccounts',
        [chunk, { encoding: 'base64', commitment: 'confirmed' }],
        MultipleAccountsSchema,
        false,
      );
      const r = this.unwrap(env, 'getMultipleAccounts');
      if (r.value.length !== chunk.length) {
        throw new ExecutionRpcError('rpc_error', `getMultipleAccounts returned ${r.value.length} of ${chunk.length}`);
      }
      for (const a of r.value) {
        out.push(a === null ? null : { lamports: BigInt(a.lamports), owner: a.owner, dataBase64: a.data[0] });
      }
    }
    return out;
  }

  /**
   * Broadcast. `skipPreflight` is false because a transaction rejected at
   * preflight costs nothing, while one that lands and fails costs the fee and
   * leaves a position in an unknown state.
   */
  async send(rawBase64: string): Promise<string> {
    const env = await this.call(
      'sendTransaction',
      [rawBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }],
      SendSchema,
      true,
    );
    return this.unwrap(env, 'sendTransaction');
  }

  async getSignatureStatus(
    signature: string,
  ): Promise<{ slot: number; err: unknown; confirmationStatus: string | null } | null> {
    const env = await this.call(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
      StatusSchema,
      false,
    );
    const v = this.unwrap(env, 'getSignatureStatuses').value[0];
    if (v === null || v === undefined) return null;
    return { slot: v.slot, err: v.err ?? null, confirmationStatus: v.confirmationStatus ?? null };
  }

  /** The authoritative record of what a landed transaction did to our balances. */
  async getConfirmedTransaction(signature: string): Promise<ConfirmedTransaction | null> {
    const env = await this.call(
      'getTransaction',
      [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
      GetTransactionSchema,
      false,
    );
    const r = this.unwrap(env, 'getTransaction');
    if (r === null || r.meta === null || r.meta === undefined) return null;
    const map = (
      rows: readonly z.infer<typeof TokenBalanceSchema>[] | null | undefined,
    ): { accountIndex: number; mint: string; owner: string | null; amount: bigint }[] =>
      (rows ?? []).map((t) => ({
        accountIndex: t.accountIndex,
        mint: t.mint,
        owner: t.owner ?? null,
        amount: BigInt(t.uiTokenAmount.amount),
      }));
    return {
      slot: r.slot,
      blockTimeUtcMs: r.blockTime == null ? null : r.blockTime * 1000,
      err: r.meta.err ?? null,
      feeLamports: BigInt(r.meta.fee),
      preBalances: r.meta.preBalances.map((n) => BigInt(n)),
      postBalances: r.meta.postBalances.map((n) => BigInt(n)),
      preTokenBalances: map(r.meta.preTokenBalances),
      postTokenBalances: map(r.meta.postTokenBalances),
    };
  }
}
