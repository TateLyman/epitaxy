/**
 * Associated-token-account rent, as locked capital.
 *
 * P2a.1 §P5. The history of this number in this repository is a good example of
 * a correction overshooting:
 *
 *   P0  rent was charged as a pure sunk cost. That overstated the round-trip
 *       floor by roughly an order of magnitude and made every trade look
 *       unviable, because ~0.00204 SOL against a 0.02 SOL notional is 100bps
 *       of permanent cost that mostly is not permanent.
 *   P1  rent became refundable via `assumedRentRecoveryRate`. Directionally
 *       right, and it quietly became an AUTOMATIC credit: the model assumed the
 *       account could always be closed.
 *
 * It cannot always be closed. `CloseAccount` fails while the token account
 * holds any balance, and a Token-2022 account with withheld transfer fees
 * cannot be closed until those are harvested. Both conditions correlate exactly
 * with the case that matters — the position we could not fully sell — so the
 * automatic credit is largest precisely where it is least deserved.
 *
 * The model here is capital, not cost:
 *
 *   entry   debit rent, and hold it as LOCKED. It is not spent and it is not
 *           available; NAV is unchanged and free capital falls.
 *   open    stays locked. A position whose ATA rent has been credited back
 *           while the position is open is a position whose capital is being
 *           counted twice.
 *   exit    credited only if a close is STRUCTURALLY VALID after the full sell:
 *           zero token balance, no withheld fees, and a buildable close. Then
 *           the close's own transaction cost is charged against the credit.
 *
 * `assumedRentRecoveryRate` remains in the config as the SIZING assumption —
 * what fraction of rent to treat as at-risk when deciding whether a notional
 * clears its own overhead. It is not, and must never become, the accounting
 * answer for a position that has actually closed.
 */

export const ATA_ACCOUNTING_VERSION = 'ata-v1';

/** Why a close could not return the rent. Null when it could. */
export type AtaCloseFailure =
  /** Tokens remain in the account; CloseAccount will fail. */
  | 'NONZERO_TOKEN_BALANCE'
  /** Token-2022 withheld transfer fees must be harvested before close. */
  | 'WITHHELD_TRANSFER_FEES'
  /** A close transaction could not be constructed. */
  | 'CLOSE_NOT_BUILDABLE'
  /** The close was attempted and did not confirm. */
  | 'CLOSE_NOT_CONFIRMED'
  /** No ATA was created, so there is no rent to return. */
  | 'NO_ATA'
  /** We never established whether a close was possible. */
  | 'UNVERIFIED';

export interface AtaState {
  /** Whether creating an ATA was part of the entry. */
  readonly ataCreated: boolean;
  /** Rent debited at entry and held as locked capital. */
  readonly ataRentLockedLamports: bigint;
  /**
   * Whether a close transaction could be CONSTRUCTED. Null means never asked,
   * which is not the same as false and must not be credited either way.
   */
  readonly ataCloseBuildable: boolean | null;
  /** Whether a close was simulated successfully. Null means never attempted. */
  readonly ataCloseSimulated: boolean | null;
  /** Whether a close was actually submitted. Paper never sets this true. */
  readonly ataCloseAttempted: boolean;
  /** Whether a submitted close confirmed on chain. */
  readonly ataCloseConfirmed: boolean;
  /** Token units left in the account after the sell. Null means unknown. */
  readonly residualTokenAmount: bigint | null;
  /** Token-2022 withheld transfer fees. Null means unknown, not zero. */
  readonly withheldTransferFeeLamports: bigint | null;
  /** Cost of the close transaction itself. */
  readonly ataCloseFeeLamports: bigint;
}

export interface AtaRentVerdict {
  /** Lamports actually returned to free capital. Never negative. */
  readonly ataRentRecoveredLamports: bigint;
  /** Lamports written off. `locked - recovered + closeFee` when it failed. */
  readonly ataRentLostLamports: bigint;
  readonly ataCloseFailureReason: AtaCloseFailure | null;
  readonly detail: string;
}

/**
 * Decide what the rent did.
 *
 * Fails closed at every unknown: a null balance, a null withheld-fee figure, or
 * an unasked buildability question all produce zero recovery. Unknown is not
 * safe, and the shape of this function is the whole point — the previous model
 * had no branch that could return zero.
 */
export function settleAtaRent(state: AtaState): AtaRentVerdict {
  const locked = state.ataRentLockedLamports;

  const fail = (reason: AtaCloseFailure, detail: string): AtaRentVerdict => ({
    ataRentRecoveredLamports: 0n,
    ataRentLostLamports: locked,
    ataCloseFailureReason: reason,
    detail,
  });

  if (!state.ataCreated || locked <= 0n) {
    return {
      ataRentRecoveredLamports: 0n,
      ataRentLostLamports: 0n,
      ataCloseFailureReason: 'NO_ATA',
      detail: 'no associated token account was created, so no rent was locked',
    };
  }

  if (state.residualTokenAmount === null) {
    return fail('UNVERIFIED', 'residual token balance was never observed; a close cannot be assumed to succeed');
  }
  if (state.residualTokenAmount > 0n) {
    return fail(
      'NONZERO_TOKEN_BALANCE',
      `${state.residualTokenAmount} token units remain; CloseAccount fails on a non-empty account`,
    );
  }

  if (state.withheldTransferFeeLamports === null) {
    return fail('UNVERIFIED', 'withheld transfer fees were never observed; a Token-2022 close may be blocked');
  }
  if (state.withheldTransferFeeLamports > 0n) {
    return fail(
      'WITHHELD_TRANSFER_FEES',
      `${state.withheldTransferFeeLamports} lamports of withheld transfer fees must be harvested before close`,
    );
  }

  if (state.ataCloseBuildable !== true) {
    return state.ataCloseBuildable === null
      ? fail('UNVERIFIED', 'no close transaction was ever built; recovery is unproven')
      : fail('CLOSE_NOT_BUILDABLE', 'a close transaction could not be constructed for this account');
  }

  // Submission only applies to modes that submit. Paper establishes structural
  // validity and stops there, which is why `ataCloseAttempted` false is not a
  // failure — but a close that WAS attempted and did not confirm is.
  if (state.ataCloseAttempted && !state.ataCloseConfirmed) {
    return fail('CLOSE_NOT_CONFIRMED', 'the close transaction was submitted and did not confirm');
  }

  // The close is not free. Charging its fee against the credit is why a
  // "recovered" rent is slightly less than the rent that was locked.
  const net = locked - state.ataCloseFeeLamports;
  if (net <= 0n) {
    return {
      ataRentRecoveredLamports: 0n,
      ataRentLostLamports: locked,
      ataCloseFailureReason: null,
      detail: `close fee ${state.ataCloseFeeLamports} consumes the whole ${locked} lamport rent; closing is not worth doing`,
    };
  }

  return {
    ataRentRecoveredLamports: net,
    ataRentLostLamports: locked - net,
    ataCloseFailureReason: null,
    detail: `close structurally valid on an empty account; ${net} lamports returned after a ${state.ataCloseFeeLamports} lamport close fee`,
  };
}

/**
 * The four recovery scenarios the directive requires alongside every result.
 *
 * If a strategy is only profitable at 100% recovery, that is a headline
 * deployment blocker rather than a footnote, so the sensitivity is computed
 * beside the headline instead of on request.
 */
export interface RecoveryScenarios {
  readonly full: bigint;
  readonly observed: bigint;
  readonly half: bigint;
  readonly none: bigint;
}

export function rentRecoveryScenarios(totalRentLockedLamports: bigint, observedRecoveredLamports: bigint): RecoveryScenarios {
  return {
    full: totalRentLockedLamports,
    observed: observedRecoveredLamports,
    half: totalRentLockedLamports / 2n,
    none: 0n,
  };
}
