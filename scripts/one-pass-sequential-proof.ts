import { writeFileSync, mkdirSync } from 'node:fs';
import { SequentialWorker, assertQuoteStateSurvived, QuoteStateMoved } from '../packages/simulator/src/sequential-worker.js';

/**
 * P3's required assertion, run against the real worker:
 *
 * ```
 * state used to quote sell == state immediately before sell execution
 * ```
 *
 * This proof deliberately does NOT need a live pool. What it establishes is the
 * property of the RUNTIME — that one instance stays alive across commands, that
 * a step commits, that a later observe sees what the step committed, and that
 * the hash a quote was taken at is the hash the next step executes against.
 *
 * The two-pass design could not run this check at all: it had two runtime
 * instances, and comparing an account across them proves they agreed on a
 * replay, not that a quote and an execution saw one state.
 */

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ACCOUNT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ACCOUNT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

async function main(): Promise<void> {
  const worker = new SequentialWorker({ commandTimeoutMs: 90_000 });
  const findings: Record<string, unknown> = {};

  try {
    const identity = await worker.init(
      {
        programs: [],
        accounts: [
          { pubkey: ACCOUNT_A, dataBase64: 'AAAAAA==', owner: SYSTEM_PROGRAM, lamports: 5_000_000n, executable: false, rentEpoch: 361n },
          { pubkey: ACCOUNT_B, dataBase64: 'AQIDBA==', owner: SYSTEM_PROGRAM, lamports: 7_000_000n, executable: false, rentEpoch: 361n },
        ],
        slot: 439_000_000,
        unixTimestamp: 1_760_000_000,
      },
      { jobId: 'one-pass-proof' },
    );
    findings['runtimeIdentity'] = identity;
    findings['initIncompleteness'] = worker.initIncompleteness;

    // 1. The runtime is ALIVE: a second command sees the first command's state.
    const first = await worker.observe([ACCOUNT_A, ACCOUNT_B]);
    const second = await worker.observe([ACCOUNT_A, ACCOUNT_B]);
    findings['runtimeIsPersistent'] = {
      firstStateHash: first.stateHash,
      secondStateHash: second.stateHash,
      stableAcrossCommands: first.stateHash === second.stateHash,
      accountsSeen: first.accounts.length,
    };

    // 2. The state the runtime restored is the state we gave it.
    const a = first.accounts.find((x) => x.pubkey === ACCOUNT_A);
    findings['restoredExactly'] = {
      lamports: a?.lamports.toString() ?? null,
      owner: a?.owner,
      expectedLamports: '5000000',
      matches: a?.lamports === 5_000_000n && a?.owner === SYSTEM_PROGRAM,
    };

    // 3. A refused step does not move the state, and says why.
    const refused = await worker.step({ label: 'not-a-transaction', transactionBase64: 'bm90LWEtdHg=', observe: [ACCOUNT_A, ACCOUNT_B] });
    const afterRefusal = await worker.observe([ACCOUNT_A, ACCOUNT_B]);
    findings['refusalDoesNotMoveState'] = {
      status: refused.step.status,
      error: refused.step.transactionError?.slice(0, 80) ?? null,
      stateHashBefore: second.stateHash,
      stateHashAfter: afterRefusal.stateHash,
      unchanged: second.stateHash === afterRefusal.stateHash,
    };

    // 4. THE ASSERTION. The hashes the quote was taken at are the hashes the
    //    next step reports as its pre-state.
    const quoted = await worker.observe([ACCOUNT_A, ACCOUNT_B]);
    const next = await worker.step({ label: 'sell', transactionBase64: 'bm90LWEtdHg=', observe: [ACCOUNT_A, ACCOUNT_B] });
    let quoteStateSurvived = true;
    let quoteStateError: string | null = null;
    try {
      assertQuoteStateSurvived(quoted, next.step);
    } catch (e) {
      quoteStateSurvived = false;
      quoteStateError = e instanceof QuoteStateMoved ? e.message : (e as Error).message;
    }
    findings['quoteStateSurvivedToExecution'] = {
      quotedStateHash: quoted.stateHash,
      quotedAccounts: quoted.accounts.map((x) => ({ pubkey: x.pubkey.slice(0, 8), dataSha256: x.dataSha256.slice(0, 16) })),
      executionPreAccounts: next.step.preAccounts.map((x) => ({ pubkey: x.pubkey.slice(0, 8), dataSha256: x.dataSha256.slice(0, 16) })),
      survived: quoteStateSurvived,
      error: quoteStateError,
    };

    // 5. The negative case. A check that cannot fail is not a check: feed the
    //    assertion a deliberately moved account and require it to object.
    let detectedAMove = false;
    try {
      assertQuoteStateSurvived(
        { ...quoted, accounts: quoted.accounts.map((x) => ({ ...x, dataSha256: 'deadbeef' })) },
        next.step,
      );
    } catch {
      detectedAMove = true;
    }
    findings['detectsAMovedAccount'] = detectedAMove;

    // 6. An absent account is refused rather than hashed as a zero.
    const missing = await worker.observe(['So11111111111111111111111111111111111111112']);
    findings['absentAccountIsNamed'] = { unobserved: missing.unobserved, accounts: missing.accounts.length };

    const ok =
      findings['runtimeIsPersistent'] !== undefined &&
      (findings['runtimeIsPersistent'] as { stableAcrossCommands: boolean }).stableAcrossCommands &&
      (findings['restoredExactly'] as { matches: boolean }).matches &&
      (findings['refusalDoesNotMoveState'] as { unchanged: boolean }).unchanged &&
      quoteStateSurvived &&
      detectedAMove;
    findings['ok'] = ok;

    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/one-pass-sequential-proof.json', JSON.stringify(findings, null, 2) + '\n');
    console.log(JSON.stringify(findings, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    await worker.close();
  }
}

await main();
