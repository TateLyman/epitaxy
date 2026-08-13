import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { BlobStore } from '../packages/storage/src/blobstore.js';
import { SimulationClient } from '../packages/simulator/src/client.js';
import { resolveSimulatorToken } from '../packages/simulator/src/token.js';
import { simulateLeg } from '../apps/engine/src/simulate-observation.js';

/**
 * `pnpm simulation:sell-proof` — the P2 repair, tested against the exact rows
 * that failed.
 *
 * P1 concluded the 43-of-43 sell failure was an instrument artifact: every job
 * was funded with SOL, whatever the transaction spent, so a sell was asked to
 * spend a token the simulator had never been given. That is a hypothesis about
 * a cause, and a hypothesis about a cause is worth exactly as much as the
 * experiment that separates it from the alternative.
 *
 * The alternative is that those routes genuinely could not be sold. This runs
 * the SAME stored bytes through the repaired setup. If the sells now execute,
 * the difference is the token provisioning and nothing else, because nothing
 * else changed about the transaction.
 *
 * Never fabricates a result. If the simulator is unreachable it says so and
 * proves nothing.
 */

const secrets = loadSecrets();
const db = openDb({ path: secrets.databasePath, skipBackup: true });
const blobs = new BlobStore();

// Constructed exactly as the engine constructs it, so this measures the same
// instrument the engine uses rather than a convenient stand-in.
const { token: simToken } = resolveSimulatorToken();
if (simToken.length === 0) {
  console.error('no simulator token; this proves nothing and will not pretend otherwise');
  process.exit(1);
}
const client = new SimulationClient({
  baseUrl: process.env['SIMULATORD_URL'] ?? 'http://127.0.0.1:8787',
  token: simToken,
  pinnedIdentity: null,
  requirePinned: false,
  timeoutMs: 120_000,
});

const taker = secrets.paperTakerPubkey;
if (taker === null) {
  console.error('PAPER_TAKER_PUBKEY unset; no route can be simulated for a specific holder');
  process.exit(1);
}

// Named for what it is. `TOKEN` reads as a credential to the secret scanner,
// and the fix for a scanner false positive is a better name, never a weaker scanner.
const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

interface Row {
  observation_id: string;
  mint: string;
  requested_amount: string;
  expected_output: string | null;
  minimum_output: string | null;
  route_labels: string | null;
  static_account_keys: string | null;
  transaction_error: string | null;
}

// The sells that failed, with bytes still on disk.
const failed = db
  .prepare(
    `SELECT o.observation_id, o.mint, o.requested_amount, o.expected_output, o.minimum_output,
            o.route_labels, o.static_account_keys, s.transaction_error
     FROM execution_observations o
     JOIN simulation_jobs s ON s.execution_observation_id = o.observation_id
     WHERE o.side = 'sell'
       AND s.status = 'SIMULATION_FAILED'
       AND o.exact_transaction_blob IS NOT NULL
     ORDER BY o.received_utc_ms DESC
     LIMIT 8`,
  )
  .all() as unknown as Row[];

console.log(`re-running ${failed.length} previously-failed sell(s) through the repaired setup\n`);

const results: unknown[] = [];
let nowOk = 0;
let stillFailed = 0;
let unavailable = 0;

for (const r of failed) {
  let keys: string[] = [];
  try {
    keys = JSON.parse(r.static_account_keys ?? '[]') as string[];
  } catch {
    keys = [];
  }
  const tokenProgram = keys.includes(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : LEGACY_TOKEN_PROGRAM;
  const amount = BigInt(r.requested_amount);

  // A fresh job id is required: the old row is keyed by (job_id, request_hash)
  // and the request bytes have deliberately changed. Reusing it would be a hash
  // conflict, which is the database correctly refusing to overwrite evidence.
  const outcome = await simulateLeg(db, blobs, client, r.observation_id, taker, {
    mode: 'DEVELOPMENT_JIT',
    side: 'sell',
    inputMint: r.mint,
    outputMint: WSOL,
    inputAmount: amount,
    inputTokenProgram: tokenProgram,
    fundingLamports: 200_000_000n,
    maxLamportsSpent: 20_000_000n,
    expectedOutput: r.expected_output === null ? null : BigInt(r.expected_output),
    minimumOutput: r.minimum_output === null ? null : BigInt(r.minimum_output),
    contextHash: 'sell-repair-proof',
  }).catch((e: unknown) => ({ simulated: false, attempt: { kind: 'error', reason: (e as Error).message } as never }));

  const attempt = outcome.attempt as { kind: string; status?: string; reason?: string; effectOk?: boolean } | null;
  const status = attempt?.kind === 'ok' ? (attempt.status ?? '?') : (attempt?.kind ?? 'none');
  if (status === 'SIMULATED_OK') nowOk += 1;
  else if (status === 'SIMULATION_FAILED') stillFailed += 1;
  else unavailable += 1;

  console.log(
    `  ${r.mint.slice(0, 10)}  amount=${amount}  ${(r.route_labels ?? '').slice(0, 20).padEnd(20)}  ` +
      `was=${(r.transaction_error ?? '').slice(0, 34).padEnd(34)}  now=${status}` +
      (attempt?.effectOk === undefined ? '' : `  effect=${attempt.effectOk ? 'OK' : 'REFUSED'}`),
  );
  results.push({
    observationId: r.observation_id,
    mint: r.mint,
    amount: amount.toString(),
    routeLabels: r.route_labels,
    previousError: r.transaction_error,
    nowStatus: status,
    effectOk: attempt?.effectOk ?? null,
    reason: attempt?.reason ?? null,
  });
}

console.log(`\n  now SIMULATED_OK   ${nowOk}`);
console.log(`  still failed       ${stillFailed}`);
console.log(`  unavailable/other  ${unavailable}`);

if (unavailable === failed.length) {
  console.log('\nThe simulator answered nothing. This run establishes nothing either way.');
} else if (nowOk > 0 && stillFailed === 0) {
  console.log(
    '\nThe same bytes that failed uniformly now execute. The only thing that changed\n' +
      'is that the taker was given the token the transaction spends, so the failure was\n' +
      'the setup and not the route.',
  );
} else if (nowOk === 0) {
  console.log(
    '\nThe sells still fail. The provisioning was necessary and is not sufficient, and\n' +
      'the P1 conclusion is not yet established. Do not close the invalidation.',
  );
}

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/sell-repair-proof.json',
  `${JSON.stringify({ generatedUtcMs: Date.now(), nowOk, stillFailed, unavailable, results }, null, 2)}\n`,
);
console.log('\nwrote artifacts/sell-repair-proof.json');
db.close();
