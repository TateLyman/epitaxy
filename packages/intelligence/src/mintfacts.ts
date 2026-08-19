import type { DecodedMint } from '../../solana/src/mint.js';
import { worstCaseTransferFee } from '../../solana/src/mint.js';

/**
 * What the chain says about a mint, as opposed to what a provider says.
 *
 * §15 — "wire authoritative direct mint facts into eligibility".
 *
 * The gates ask `info.audit.mintAuthorityDisabled`, which is Jupiter's opinion.
 * It is usually right and it is not authoritative: it can be stale, it can be
 * absent, and nothing in it is derived from bytes this system read. The mint
 * account is the fact.
 *
 * Three states everywhere, never two. `SAFE`, `HOSTILE` and `UNKNOWN` are
 * different answers, and collapsing UNKNOWN into either is the mistake this
 * whole file exists to prevent: an unread mint is not a clean mint, and a mint
 * with an extension this decoder has never seen is not a safe one.
 */

export type FactVerdict = 'SAFE' | 'HOSTILE' | 'UNKNOWN';

export interface MintFacts {
  /** Supply can still be inflated under an open position. */
  readonly mintAuthority: FactVerdict;
  /** Our exit can be disabled by the issuer. */
  readonly freezeAuthority: FactVerdict;
  /** A delegate that can move tokens out of any account, at any time. */
  readonly permanentDelegate: FactVerdict;
  /** New accounts start frozen, so an exit may be impossible from the start. */
  readonly defaultAccountState: FactVerdict;
  /** A hook program runs on every transfer and can refuse ours. */
  readonly transferHook: FactVerdict;
  /** The token cannot be transferred at all. */
  readonly nonTransferable: FactVerdict;
  /** Transfers can be paused by an authority. */
  readonly pausable: FactVerdict;
  /** Balances are hidden, so nothing about holders can be measured. */
  readonly confidential: FactVerdict;
  /** A transfer fee takes a cut of every trade, including the exit. */
  readonly transferFeeBps: number | null;
  /**
   * Why the mint could not be read, when it could not be.
   *
   * `decodeMint` THROWS on an extension newer than itself rather than returning
   * one, so an unknown extension arrives here as a decode failure and not as a
   * field. That is stronger than grading it: there is no decoded mint to grade.
   */
  readonly decodeFailure: string | null;
  readonly overall: FactVerdict;
  readonly reasons: readonly string[];
}

/**
 * Read the facts off a decoded mint.
 *
 * `null` means the mint was never read, which produces UNKNOWN across the board
 * rather than an optimistic default. That distinction is the point: this system
 * has repeatedly found that absent-means-safe is the direction errors travel.
 */
export function mintFacts(decoded: DecodedMint | null, decodeFailure: string | null = null): MintFacts {
  if (decoded === null) {
    return {
      mintAuthority: 'UNKNOWN',
      freezeAuthority: 'UNKNOWN',
      permanentDelegate: 'UNKNOWN',
      defaultAccountState: 'UNKNOWN',
      transferHook: 'UNKNOWN',
      nonTransferable: 'UNKNOWN',
      pausable: 'UNKNOWN',
      confidential: 'UNKNOWN',
      transferFeeBps: null,
      decodeFailure,
      overall: 'UNKNOWN',
      reasons: [
        decodeFailure === null
          ? 'the mint account was not read, so nothing about it is established'
          : `the mint account did not decode (${decodeFailure}), so nothing about it is established`,
      ],
    };
  }

  const reasons: string[] = [];
  const present = new Set(decoded.extensions.map((e) => e.name));

  const verdictFor = (name: string, label: string): FactVerdict => {
    if (present.has(name)) {
      reasons.push(`${label} is present`);
      return 'HOSTILE';
    }
    return 'SAFE';
  };

  // An authority that is set can act; one that is null cannot. This is read
  // from the account, so there is no third state for these two.
  const mintAuthority: FactVerdict = decoded.mintAuthority === null ? 'SAFE' : 'HOSTILE';
  if (mintAuthority === 'HOSTILE') reasons.push('mint authority is still set, so supply can be inflated');
  const freezeAuthority: FactVerdict = decoded.freezeAuthority === null ? 'SAFE' : 'HOSTILE';
  if (freezeAuthority === 'HOSTILE') reasons.push('freeze authority is still set, so an exit can be disabled');

  const facts = {
    mintAuthority,
    freezeAuthority,
    permanentDelegate: verdictFor('PermanentDelegate', 'a permanent delegate'),
    defaultAccountState: verdictFor('DefaultAccountState', 'a default account state'),
    transferHook: verdictFor('TransferHook', 'a transfer hook'),
    nonTransferable: verdictFor('NonTransferable', 'non-transferability'),
    pausable: verdictFor('Pausable', 'a pause authority'),
    confidential:
      present.has('ConfidentialTransferMint') || present.has('ConfidentialTransferFeeConfig')
        ? ('HOSTILE' as const)
        : ('SAFE' as const),
  };
  if (facts.confidential === 'HOSTILE') reasons.push('confidential transfers hide the balances this system measures');

  const fee = decoded.transferFeeConfig === null ? null : worstCaseTransferFee(decoded.transferFeeConfig);
  if (fee !== null && fee.basisPoints > 0) {
    reasons.push(`a transfer fee of up to ${fee.basisPoints} bps applies to every trade including the exit`);
  }

  const values = Object.values(facts);
  const overall: FactVerdict = values.includes('HOSTILE') ? 'HOSTILE' : values.includes('UNKNOWN') ? 'UNKNOWN' : 'SAFE';

  return {
    ...facts,
    transferFeeBps: fee?.basisPoints ?? null,
    decodeFailure: null,
    overall,
    reasons,
  };
}

export interface ProviderDisagreement {
  readonly field: string;
  readonly providerSaid: string;
  readonly chainSays: string;
}

/**
 * Where the provider disagrees with the chain.
 *
 * Worth recording rather than silently preferring one: a provider that is
 * wrong about mint authority is a provider whose other fields deserve less
 * weight, and that is a fact about the DATA SOURCE which no single token's row
 * would otherwise capture.
 *
 * The chain wins. It is not a vote.
 */
export function disagreements(
  facts: MintFacts,
  audit: { mintAuthorityDisabled?: boolean | null; freezeAuthorityDisabled?: boolean | null } | null,
): ProviderDisagreement[] {
  const out: ProviderDisagreement[] = [];
  if (audit === null) return out;
  const check = (field: string, providerDisabled: boolean | null | undefined, chain: FactVerdict): void => {
    if (providerDisabled === null || providerDisabled === undefined) return;
    if (chain === 'UNKNOWN') return;
    const chainDisabled = chain === 'SAFE';
    if (providerDisabled !== chainDisabled) {
      out.push({
        field,
        providerSaid: providerDisabled ? 'disabled' : 'live',
        chainSays: chainDisabled ? 'disabled' : 'live',
      });
    }
  };
  check('mintAuthority', audit.mintAuthorityDisabled, facts.mintAuthority);
  check('freezeAuthority', audit.freezeAuthorityDisabled, facts.freezeAuthority);
  return out;
}

/**
 * Is this mint's BEHAVIOUR safe to hold a position in?
 *
 * Extracted because the collector had it inline as
 *
 *     facts.mint2022.freezeAuthority === null ? true : null
 *
 * and `FactVerdict` is a STRING UNION — 'SAFE' | 'HOSTILE' | 'UNKNOWN' — so
 * that comparison is always false and the answer was permanently null. It is a
 * required input of both smart entry policies, so both were NOT_EVALUABLE on
 * every row ever collected, for a reason that had nothing to do with any token.
 * TypeScript does not object to comparing a string union against null, and no
 * test looked, because the expression lived inside a cycle loop that needs a
 * chain to run.
 *
 * Three states, and the third is the point:
 *
 *     true   every hostile capability was READ and found absent
 *     false  at least one hostile capability is PRESENT
 *     null   at least one could not be read
 *
 * `null` never collapses to `false`. "We could not read the mint" and "the mint
 * is hostile" are different facts, and only the second is a property of the
 * token; merging them would attribute an apparatus failure to an issuer.
 */
export function mintBehaviourSafe(facts: MintFacts): boolean | null {
  if (facts.overall === 'SAFE') return true;
  if (facts.overall === 'HOSTILE') return false;
  return null;
}
