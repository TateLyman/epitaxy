import { randomUUID } from 'node:crypto';
import {
  SIMULATION_PROTOCOL_VERSION,
  computeRequestHash,
  verifyIdentity,
  IdentityMismatch,
  identityIsConfirmatoryGrade,
  type SimulationRequest,
  type SimulationResponse,
  type SimulatorIdentity,
} from './protocol.js';

/**
 * The Windows side of the wire.
 *
 * Every failure mode here resolves to `SIMULATOR_UNAVAILABLE`, never to a
 * statement about the token. A daemon that is down, out of date, or returning
 * something this engine cannot interpret is a fact about our infrastructure;
 * treating it as a route failure would poison the corpus with our own outages,
 * which is the mistake this project already made once with provider errors.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Identity this engine is pinned to. Null before the first pin. */
  readonly pinnedIdentity: Partial<SimulatorIdentity> | null;
  /** True when the caller intends the result to be confirmatory evidence. */
  readonly requirePinned: boolean;
  readonly timeoutMs?: number;
}

export class SimulatorUnavailable extends Error {
  constructor(reason: string) {
    super(`simulator unavailable: ${reason}`);
    this.name = 'SimulatorUnavailable';
  }
}

export class SimulationClient {
  constructor(private readonly opts: ClientOptions) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` };
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 90_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}${path}`, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new SimulatorUnavailable(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof SimulatorUnavailable) throw e;
      throw new SimulatorUnavailable((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean; inFlight: number; jobsRun: number }> {
    return (await this.call('/v1/health', { method: 'GET' })) as {
      ok: boolean;
      inFlight: number;
      jobsRun: number;
    };
  }

  async identity(): Promise<SimulatorIdentity> {
    const id = (await this.call('/v1/identity', { method: 'GET', headers: this.headers() })) as SimulatorIdentity;
    // Verified here rather than at the call site, so no caller can forget.
    verifyIdentity(id, this.opts.pinnedIdentity, this.opts.requirePinned);
    return id;
  }

  /**
   * Build a request with its own idempotency key.
   *
   * The jobId is derived from the request hash rather than random, so a retry
   * after a crash produces the same job id for the same work and the daemon's
   * idempotency actually engages. A random id would make every retry a new job
   * and quietly double-count.
   */
  buildRequest(fields: Omit<SimulationRequest, 'protocolVersion' | 'requestHash' | 'jobId'>): SimulationRequest {
    const withVersion = { ...fields, protocolVersion: SIMULATION_PROTOCOL_VERSION };
    const requestHash = computeRequestHash(withVersion);
    return { ...withVersion, requestHash, jobId: `job-${requestHash.slice(0, 32)}` };
  }

  async simulate(request: SimulationRequest): Promise<SimulationResponse> {
    const res = (await this.call('/v1/simulate', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
    })) as SimulationResponse;

    // The response must be about the request we sent. A daemon returning
    // someone else's job is a defect we must not average over.
    if (res.jobId !== request.jobId || res.requestHash !== request.requestHash) {
      throw new SimulatorUnavailable(
        `response identity mismatch: sent ${request.jobId}/${request.requestHash.slice(0, 12)}, ` +
          `got ${res.jobId}/${res.requestHash.slice(0, 12)}`,
      );
    }
    verifyIdentity(res.identity, this.opts.pinnedIdentity, this.opts.requirePinned);
    if (res.snapshotManifestHash !== request.snapshotManifestHash) {
      throw new SimulatorUnavailable('the daemon simulated against a different account snapshot');
    }
    return res;
  }
}

/**
 * May this response back a confirmatory row?
 *
 * Separate from "did it succeed", because those are different questions and
 * conflating them is how a development result becomes evidence. A JIT run
 * succeeds and is still not reproducible.
 */
export function responseIsConfirmatory(
  res: SimulationResponse,
  mode: SimulationRequest['mode'],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (res.status !== 'SIMULATED_OK') reasons.push(`status ${res.status}`);
  if (mode !== 'CONFIRMATORY_OFFLINE') reasons.push(`mode ${mode} is not reproducible`);
  if (res.jitFetchedAccounts.length > 0) reasons.push('accounts were fetched during the run and are not frozen');
  const grade = identityIsConfirmatoryGrade(res.identity);
  if (!grade.ok) reasons.push(...grade.reasons);
  if (res.blockhashReplacement !== null) {
    const r = res.blockhashReplacement;
    if (!r.instructionsUnchanged || !r.accountsUnchanged || !r.headerUnchanged) {
      reasons.push('the blockhash substitution changed more than the blockhash');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export { IdentityMismatch };
export function newJobId(): string {
  return `job-${randomUUID()}`;
}
