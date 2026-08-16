import io

p = 'apps/collector/src/trajectory-collect.ts'
c = io.open(p, encoding='utf-8').read()

# main() becomes one cycle.
c = c.replace('async function main(): Promise<void> {', 'async function runCycle(): Promise<void> {', 1)

# Args gain loop control.
c = c.replace(
    "  readonly once: boolean;\n  readonly maxOpen: number;\n}",
    "  readonly once: boolean;\n  readonly maxOpen: number;\n  readonly loop: boolean;\n  readonly intervalSeconds: number;\n}",
    1,
)
c = c.replace(
    "    maxOpen: num('--max-open', 5),\n  };",
    "    maxOpen: num('--max-open', 5),\n    // A daemon by default; --once is the escape hatch for a single pass.\n    loop: !argv.includes('--once'),\n    intervalSeconds: num('--interval', 300),\n  };",
    1,
)

# The daemon.
c = c.replace(
    'await main();',
    '''/**
 * P14 — the collector as a DAEMON.
 *
 * The mark-and-settle pass is already resumable: every invocation marks
 * whatever is due and settles whatever is complete, and all of its state lives
 * in the database. So a daemon is just that pass on a timer — no resident
 * scheduler, no in-memory queue, and a restart loses nothing but the current
 * sleep.
 *
 * That matters for horizons. A path only produces a real 60-minute mark if
 * something is alive to take it at sixty minutes; the first live run settled
 * eight paths whose marks were all fetched in one burst, giving five labels and
 * one instant. Running continuously is what makes the label true.
 *
 * This process still cannot trade. It owns no NAV, opens no capital-bearing
 * positions, imports no signer, and refuses to start in canary or live.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.loop) {
    await runCycle();
    return;
  }

  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\\n${sig}: finishing the current cycle, then stopping.`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(`collector daemon: every ${args.intervalSeconds}s until stopped`);
  let cycle = 0;

  while (!stopping) {
    cycle++;
    const started = Date.now();
    console.log(`\\n===== cycle ${cycle} @ ${new Date(started).toISOString()} =====`);
    try {
      await runCycle();
    } catch (e) {
      /**
       * A cycle that throws must not kill the daemon.
       *
       * An apparatus failure is a fact about this cycle, and stopping on it
       * would silently end collection at the first RPC hiccup — which then
       * reads later as "the market produced nothing" rather than "we stopped
       * looking".
       */
      console.error(`cycle ${cycle} failed: ${(e as Error).message.slice(0, 200)}`);
    }
    if (stopping) break;
    const elapsed = Date.now() - started;
    const wait = Math.max(0, args.intervalSeconds * 1_000 - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log('collector daemon stopped.');
}

await main();''',
    1,
)
io.open(p, 'w', encoding='utf-8', newline='\\n'.replace('\\n', chr(10))).write(c)
print('daemon added')
