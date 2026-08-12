import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { surfpoolAvailable, SurfpoolSimulator, packageVersion } from '../packages/simulator/src/surfpool.js';
import { DeterministicFixtureSimulator } from '../packages/simulator/src/fixture.js';
import { isConfirmatorySimulation } from '../packages/simulator/src/types.js';

/**
 * Can this machine simulate, and would anything it produced be evidence?
 *
 * Two separate questions, reported separately, because the answer to the first
 * has been "no" for the whole life of this project and the answer to the second
 * stays "no" for longer.
 */

interface Line {
  readonly name: string;
  readonly value: string;
  readonly detail: string;
  readonly notable: boolean;
}

const out: Line[] = [];
const add = (name: string, value: string, detail: string, notable = false): void => {
  out.push({ name, value, detail, notable });
};

add('platform', `${process.platform}/${process.arch}`, `node ${process.version}`, false);

const avail = surfpoolAvailable();
add(
  'surfpool_available',
  avail.available ? 'yes' : 'no',
  avail.reason,
  !avail.available,
);

// WSL is the supported path on Windows. Report whether it exists rather than
// telling the operator to go and find out.
if (process.platform === 'win32') {
  let wsl = 'unavailable';
  try {
    const raw = execFileSync('wsl', ['-l', '-v'], { encoding: 'utf16le', stdio: ['ignore', 'pipe', 'ignore'] });
    const distros = raw
      .split('\n')
      .map((l) => l.replace(/\0/g, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('NAME'));
    wsl = distros.length > 0 ? distros.join(' | ') : 'no distributions';
  } catch {
    wsl = 'wsl not installed';
  }
  add('wsl', wsl.includes('Running') || wsl.includes('Stopped') ? 'present' : 'absent', wsl, !wsl.includes('Ubuntu'));
}

let bootMs: number | null = null;
let runtime: string | null = null;
let featureSet: string | null = null;
let simulateReachable = false;

if (avail.available) {
  const sim = new SurfpoolSimulator();
  const t0 = Date.now();
  try {
    await sim.start();
    bootMs = Date.now() - t0;
    runtime = sim.version.runtimeVersion;
    featureSet = sim.version.featureSet;

    // Deliberately garbage. A reachable endpoint must REJECT it; an endpoint
    // that accepted it would be answering a question it was not asked.
    const res = await sim.simulate('AQ==').catch((e: Error) => e.message);
    simulateReachable = true;
    add('simulate_endpoint', 'reachable', typeof res === 'string' ? res.slice(0, 90) : String(res.verdict), false);
  } catch (e) {
    add('surfpool_start', 'FAILED', (e as Error).message.slice(0, 140), true);
  } finally {
    await sim.stop().catch(() => undefined);
  }
  add('boot_ms', bootMs === null ? 'n/a' : String(bootMs), 'time to a live RPC endpoint', false);
  add('runtime', runtime ?? 'unknown', `feature-set ${featureSet ?? 'unknown'}`, runtime === null);
}

// The fixture path must work everywhere, including where the real one does not.
const fixture = new DeterministicFixtureSimulator(new Map());
await fixture.start();
const miss = await fixture.simulate('unrecorded');
await fixture.stop();
add(
  'fixture_simulator',
  miss.verdict === 'SIMULATOR_UNAVAILABLE' ? 'ok' : 'BROKEN',
  'an unrecorded transaction returns SIMULATOR_UNAVAILABLE, never a pass',
  miss.verdict !== 'SIMULATOR_UNAVAILABLE',
);
add(
  'fixture_is_evidence',
  isConfirmatorySimulation({ ...miss, verdict: 'SIMULATED_OK', snapshotHash: 'x' }) ? 'YES — BUG' : 'no',
  'a fixture pass can never be confirmatory, whatever else it satisfies',
  isConfirmatorySimulation({ ...miss, verdict: 'SIMULATED_OK', snapshotHash: 'x' }),
);

// The question the whole session turns on.
const canProduceConfirmatory = avail.available && simulateReachable;
add(
  'can_produce_confirmatory_simulation',
  canProduceConfirmatory ? 'mechanically yes' : 'no',
  canProduceConfirmatory
    ? 'a real SVM runs here. Parity against mainnet is a SEPARATE requirement and is not established by this check.'
    : 'no real SVM on this platform; every observation stays NOT_SIMULATED',
  !canProduceConfirmatory,
);

const width = Math.max(...out.map((l) => l.name.length));
console.log(`simulator doctor — ${new Date().toISOString()}\n`);
for (const l of out) {
  console.log(`${l.notable ? '!' : ' '} ${l.name.padEnd(width)}  ${l.value.padEnd(18)}  ${l.detail}`);
}
console.log(`\n${out.length} checks, ${out.filter((l) => l.notable).length} needing attention`);

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/simulator-doctor.json',
  JSON.stringify(
    {
      generatedUtc: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      surfpoolAvailable: avail.available,
      surfpoolReason: avail.reason,
      packageVersion: packageVersion(),
      bootMs,
      runtimeVersion: runtime,
      featureSet,
      simulateReachable,
      canProduceConfirmatorySimulation: canProduceConfirmatory,
      caveat:
        'A running SVM is not simulator parity. Confirmatory status additionally requires the parity ' +
        'corpus in docs/SIMULATOR_PARITY.md and every gate in the directive section 17.',
    },
    null,
    2,
  ),
);
console.log('\nwritten to artifacts/simulator-doctor.json');

if (!canProduceConfirmatory) process.exitCode = 1;
