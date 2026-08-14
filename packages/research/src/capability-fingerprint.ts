import { createHash } from 'node:crypto';

/**
 * P16 — a capability fingerprint that binds what it claims to bind.
 *
 * "PumpSwap" is not a capability. A pool with a Token-2022 base mint carrying a
 * transfer hook, at a different fee-config hash, built by a different SDK
 * version, is a different instrument that happens to share a program id — and
 * approving the program id approves all of them at once.
 *
 * So a fingerprint hashes every dimension that can change what a swap costs or
 * whether it lands. Anything absent is `null` and hashes as absent, because an
 * unknown dimension is not a matching one.
 *
 * A NARROW REVIEWED FINGERPRINT MAY BE APPROVED BEFORE GLOBAL PARITY. That is
 * the point of binding this tightly: approving one exactly-described instrument
 * is honest, and approving "PumpSwap" is a claim about instruments nobody has
 * measured.
 */

export interface CapabilityDimensions {
  readonly venueProgramId: string;
  /** Hash of the program's ACTUAL executable bytes, not the loader account. */
  readonly programDataHash: string | null;
  readonly poolLayoutVersion: string | null;
  readonly instructionDiscriminator: string | null;
  readonly feeConfigHash: string | null;
  readonly cashbackFlag: boolean | null;
  /** Whether the builder passes the accounts cashback actually requires. */
  readonly cashbackAccountsPresent: boolean | null;
  readonly mayhemFlag: boolean | null;
  readonly baseTokenProgram: string | null;
  readonly quoteTokenProgram: string | null;
  /** Sorted extension names. An unknown extension is a different instrument. */
  readonly tokenExtensions: readonly string[];
  readonly quoteMint: string | null;
  readonly builderVersion: string | null;
  readonly runtimeVersion: string | null;
}

export const UNBOUND = '<absent>';

/**
 * The fingerprint.
 *
 * Field names are hashed alongside values so that adding a dimension changes
 * every fingerprint — which is correct. A new dimension means the old ones no
 * longer fully describe the instrument, and silently keeping old approvals
 * valid would carry an approval across a change nobody reviewed.
 */
export function capabilityFingerprint(d: CapabilityDimensions): string {
  const h = createHash('sha256');
  const put = (name: string, v: unknown): void => {
    h.update(name);
    h.update('=');
    h.update(v === null || v === undefined ? UNBOUND : String(v));
    h.update(';');
  };
  put('venueProgramId', d.venueProgramId);
  put('programDataHash', d.programDataHash);
  put('poolLayoutVersion', d.poolLayoutVersion);
  put('instructionDiscriminator', d.instructionDiscriminator);
  put('feeConfigHash', d.feeConfigHash);
  put('cashbackFlag', d.cashbackFlag);
  put('cashbackAccountsPresent', d.cashbackAccountsPresent);
  put('mayhemFlag', d.mayhemFlag);
  put('baseTokenProgram', d.baseTokenProgram);
  put('quoteTokenProgram', d.quoteTokenProgram);
  put('tokenExtensions', [...d.tokenExtensions].sort().join(','));
  put('quoteMint', d.quoteMint);
  put('builderVersion', d.builderVersion);
  put('runtimeVersion', d.runtimeVersion);
  return h.digest('hex');
}

/** The parity a fingerprint must show before it may be approved. */
export const REQUIRED_PARITY = [
  'OFFICIAL_SDK_QUOTE',
  'EPITAXY_LOCAL_QUOTE',
  'DIRECT_INSTRUCTION_SIMULATION',
  'SEQUENTIAL_RUNTIME_EFFECT',
  'LANDED_DIRECT_SWAP',
] as const;
export type ParityCheck = (typeof REQUIRED_PARITY)[number];

export interface ParityEvidence {
  readonly check: ParityCheck;
  readonly agreed: boolean;
  /** Why it could not be run, when it could not. Never blank on a false. */
  readonly note: string | null;
}

export interface ApprovalDecision {
  readonly fingerprint: string;
  readonly approved: boolean;
  readonly missing: readonly ParityCheck[];
  readonly disagreed: readonly ParityCheck[];
  readonly reason: string;
}

/**
 * Approve a fingerprint, or say exactly what is missing.
 *
 * `LANDED_DIRECT_SWAP` is allowed to be absent ONLY when attribution is not
 * isolatable — a landed transaction that routed through an aggregator cannot
 * attribute its fill to one venue, and pretending it can is worse than not
 * having the check. Absence is recorded, never treated as agreement.
 */
export function approveFingerprint(
  fingerprint: string,
  evidence: readonly ParityEvidence[],
  opts: { landedAttributionIsolatable: boolean },
): ApprovalDecision {
  const byCheck = new Map(evidence.map((e) => [e.check, e]));
  const required = REQUIRED_PARITY.filter(
    (c) => c !== 'LANDED_DIRECT_SWAP' || opts.landedAttributionIsolatable,
  );

  const missing = required.filter((c) => !byCheck.has(c));
  const disagreed = required.filter((c) => byCheck.get(c)?.agreed === false);
  const approved = missing.length === 0 && disagreed.length === 0;

  return {
    fingerprint,
    approved,
    missing,
    disagreed,
    reason: approved
      ? `all ${required.length} required parity checks agree`
      : [
          missing.length > 0 ? `${missing.length} check(s) never ran: ${missing.join(', ')}` : null,
          disagreed.length > 0 ? `${disagreed.length} check(s) disagreed: ${disagreed.join(', ')}` : null,
        ]
          .filter((x) => x !== null)
          .join('; '),
  };
}

export class ConfigBytesAnachronism extends Error {
  constructor(what: string) {
    super(
      `refusing to interpret a historical transaction with current ${what} bytes: ` +
        'the config may have changed between then and now, and a fee decoded from the wrong table ' +
        'is a confident wrong number rather than a missing one',
    );
    this.name = 'ConfigBytesAnachronism';
  }
}

/**
 * Guard against reading a historical transaction with today's config.
 *
 * Allowed only when the config hash is PROVEN unchanged over the interval, or
 * when the transaction/event evidence carries the config itself.
 */
export function assertConfigUsableForHistorical(p: {
  what: string;
  currentConfigHash: string;
  configHashAtTransaction: string | null;
  configIncludedInEvidence: boolean;
}): void {
  if (p.configIncludedInEvidence) return;
  if (p.configHashAtTransaction !== null && p.configHashAtTransaction === p.currentConfigHash) return;
  throw new ConfigBytesAnachronism(p.what);
}

/** The landed-parity coverage the directive requires, as a checklist. */
export const LANDED_PARITY_DIMENSIONS = [
  'buy',
  'sell',
  'native_sol_quote',
  'wrapped_quote',
  'cashback',
  'noncashback',
  'legacy_token',
  'token_2022',
  'multiple_sizes',
  'multiple_pools',
  'current_programdata_hash',
  'current_fee_config_hash',
] as const;
export type LandedParityDimension = (typeof LANDED_PARITY_DIMENSIONS)[number];

export function landedParityCoverage(
  covered: readonly LandedParityDimension[],
): { complete: boolean; missing: readonly LandedParityDimension[] } {
  const have = new Set(covered);
  const missing = LANDED_PARITY_DIMENSIONS.filter((d) => !have.has(d));
  return { complete: missing.length === 0, missing };
}
