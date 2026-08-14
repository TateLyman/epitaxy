import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './pda.js';

/**
 * Which token program owns a mint, from the transaction itself.
 *
 * The associated token address is derived FROM the program, so exactly one of
 * the two derivations can appear among a compiled transaction's accounts. That
 * makes this authoritative without an RPC call.
 *
 * Returns null when neither appears. Null is the honest answer: the previous
 * production heuristic — "is the Token-2022 program id among the keys?" — is
 * true whenever any account in the transaction is a Token-2022 account, which
 * on a routed swap is regularly some other mint's, and it silently answers for
 * a mint it never looked at.
 */
export function tokenProgramFromTransaction(
  accounts: readonly string[],
  owner: string,
  mint: string,
): string | null {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      if (accounts.includes(associatedTokenAddress(owner, mint, program))) return program;
    } catch {
      /* an address we cannot derive is not the one in the transaction */
    }
  }
  return null;
}
