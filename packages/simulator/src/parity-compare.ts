import type { SimulationResponse } from './protocol.js';

/**
 * §7.3 — do a JIT run and its offline replay agree?
 *
 * This is the question that decides whether an offline snapshot is a faithful
 * freeze of the chain state a route actually executed against. If the two
 * disagree, the snapshot is missing something, and every offline result taken
 * against it is a confident answer about a chain that never existed.
 *
 * Compared field by field rather than by hashing the whole response, because
 * "they differ" is not an actionable finding and "unitsConsumed differs by 12"
 * is. Timings, queue waits and the identity block are excluded: they are facts
 * about the run, not about the transaction.
 */

export interface FieldDiff {
  readonly field: string;
  readonly jit: string;
  readonly offline: string;
}

export interface ParityVerdict {
  readonly agrees: boolean;
  readonly diffs: readonly FieldDiff[];
  readonly comparedFields: number;
  /** Reasons this comparison could not establish anything, even if it agreed. */
  readonly disqualifiers: readonly string[];
}

function mapDiffs(field: string, a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k];
    const bv = b[k];
    // Absent on one side is a difference, not a match against zero.
    if (av !== bv) out.push({ field: `${field}[${k}]`, jit: av ?? 'absent', offline: bv ?? 'absent' });
  }
  return out;
}

export function compareRuns(jit: SimulationResponse, offline: SimulationResponse): ParityVerdict {
  const diffs: FieldDiff[] = [];
  const push = (field: string, a: unknown, b: unknown): void => {
    const av = JSON.stringify(a ?? null);
    const bv = JSON.stringify(b ?? null);
    if (av !== bv) diffs.push({ field, jit: av, offline: bv });
  };

  // Everything the directive requires the two runs to agree on.
  push('status', jit.status, offline.status);
  push('transactionError', jit.transactionError, offline.transactionError);
  push('unitsConsumed', jit.unitsConsumed, offline.unitsConsumed);
  push('logs', jit.logs, offline.logs);
  push('baseFeeLamports', jit.baseFeeLamports, offline.baseFeeLamports);
  push('priorityFeeLamports', jit.priorityFeeLamports, offline.priorityFeeLamports);
  push('rentCreatedLamports', jit.rentCreatedLamports, offline.rentCreatedLamports);
  push('rentRecoveredLamports', jit.rentRecoveredLamports, offline.rentRecoveredLamports);
  push('transferFeeLamports', jit.transferFeeLamports, offline.transferFeeLamports);
  push('withheldFeeLamports', jit.withheldFeeLamports, offline.withheldFeeLamports);
  push('createdAccounts', [...jit.createdAccounts].sort(), [...offline.createdAccounts].sort());
  push('closedAccounts', [...jit.closedAccounts].sort(), [...offline.closedAccounts].sort());
  push('boundsViolations', jit.boundsViolations, offline.boundsViolations);
  diffs.push(...mapDiffs('preSol', jit.preSolBalances, offline.preSolBalances));
  diffs.push(...mapDiffs('postSol', jit.postSolBalances, offline.postSolBalances));
  diffs.push(...mapDiffs('preToken', jit.preTokenBalances, offline.preTokenBalances));
  diffs.push(...mapDiffs('postToken', jit.postTokenBalances, offline.postTokenBalances));
  diffs.push(...mapDiffs('mutated', jit.mutatedAccountHashes, offline.mutatedAccountHashes));

  // Agreement is necessary and not sufficient. Two runs that both failed to
  // execute agree perfectly and prove nothing, which is the trap this list
  // exists to close.
  const disqualifiers: string[] = [];
  if (jit.status !== 'SIMULATED_OK') disqualifiers.push(`the JIT run was ${jit.status}, so there is nothing to reproduce`);
  if (offline.status !== 'SIMULATED_OK') disqualifiers.push(`the offline replay was ${offline.status}`);
  if (jit.exportOmissions.length > 0) {
    disqualifiers.push(`${jit.exportOmissions.length} account(s) could not be captured: ${jit.exportOmissions.slice(0, 3).join('; ')}`);
  }
  if (jit.exportedSnapshot.length === 0) disqualifiers.push('the JIT run exported no snapshot');
  if ((jit.unitsConsumed ?? 0) <= 0) disqualifiers.push('no compute units were consumed, so no program ran');

  return {
    agrees: diffs.length === 0,
    diffs,
    comparedFields: 18,
    disqualifiers,
  };
}
