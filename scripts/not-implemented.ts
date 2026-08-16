/**
 * P12/F22 — a command that does not do what it is named must SAY SO.
 *
 * Six commands were aliases for other scripts. `pnpm rate:budget-v2` ran the
 * trajectory status; `pnpm wss:status` ran the direct-signal status; `pnpm
 * landed:parity-v2` ran a NON-landed parity script. Each printed a plausible,
 * well-formatted report about something else, and each exited zero.
 *
 * That is worse than a missing command. A missing command is noticed the first
 * time somebody runs it. An alias produces output, gets pasted into a status
 * document, and becomes evidence for a capability that was never built — which
 * is the same defect class as a proof artifact standing in for a database.
 *
 * So the alias is replaced by a refusal that names the EXACT missing
 * prerequisite and exits non-zero. Nobody can mistake it for a result, and the
 * text says what would have to exist for the command to mean its name.
 */

export interface MissingCapability {
  readonly command: string;
  /** What the name promises. */
  readonly capability: string;
  /** What does not exist yet. Concrete enough to be actionable. */
  readonly prerequisite: string;
  /** What used to run under this name, so an old artifact can be recognised. */
  readonly previouslyAliasedTo?: string;
}

/**
 * Commands that USED to be here and now mean their names.
 *
 * Kept because an artifact carrying the old aliased output is still
 * mislabelled, and somebody reading a stale `wss-status.json` needs to know
 * which script produced it. Graduating a command must not erase the evidence
 * that its earlier output answered a different question.
 */
export const GRADUATED: readonly { command: string; nowRunsScript: string; previouslyAliasedTo: string }[] = [
  {
    command: 'rate:budget-v2',
    nowRunsScript: 'scripts/rate-budget-v2.ts',
    previouslyAliasedTo: 'scripts/trajectory-status.ts',
  },
  {
    command: 'wss:status',
    nowRunsScript: 'scripts/wss-status.ts',
    previouslyAliasedTo: 'scripts/direct-signal-status.ts',
  },
];

export const NOT_IMPLEMENTED: readonly MissingCapability[] = [
  {
    command: 'reject:panel-v2',
    capability: 'prospective samples collected AT REJECTION TIME',
    prerequisite:
      'a prospective_samples table written by the screening path at the moment of rejection. ' +
      '`reject_tracking` records that a token was rejected, not the state it was rejected on, ' +
      'and a panel scored from state fetched later is a different experiment.',
    previouslyAliasedTo: 'scripts/trajectory-status.ts',
  },
  {
    command: 'landed:parity-v2',
    capability: 'comparison against actual LANDED direct swaps',
    prerequisite:
      'at least one direct PumpSwap swap this system actually landed on mainnet. None exists: ' +
      'nothing here has ever signed or submitted. This command cannot mean its name before a ' +
      'canary, and a simulated round trip is not a landed swap.',
    previouslyAliasedTo: 'scripts/pumpswap-parity-v3.ts',
  },
  {
    command: 'exploration:status',
    capability: 'exploration entitlement and its consumption',
    prerequisite:
      'an entitlement ledger separate from cohort assignment. It aliased `cohort:status`, which ' +
      'answers which cells are under-filled, not how much exploration budget remains.',
    previouslyAliasedTo: 'scripts/evidence-status.ts cohort',
  },
];

function main(): void {
  const name = process.argv[2] ?? '';
  const entry = NOT_IMPLEMENTED.find((c) => c.command === name);

  if (entry === undefined) {
    console.error(`NOT_IMPLEMENTED was invoked for an unknown command: ${name || '(none given)'}`);
    console.error('Known: ' + NOT_IMPLEMENTED.map((c) => c.command).join(', '));
    process.exit(2);
  }

  console.error(`NOT_IMPLEMENTED: pnpm ${entry.command}`);
  console.error('');
  console.error(`  this command should report: ${entry.capability}`);
  console.error('');
  console.error('  missing prerequisite:');
  for (const line of wrap(entry.prerequisite, 72)) console.error(`    ${line}`);
  if (entry.previouslyAliasedTo !== undefined) {
    console.error('');
    console.error(`  it used to run ${entry.previouslyAliasedTo}, which answers a different`);
    console.error('  question. Any artifact carrying that output under this name is mislabelled.');
  }
  console.error('');
  process.exit(1);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

// Only when run as a command. Importing this file for its table must not exit.
if (process.argv[1]?.endsWith('not-implemented.ts') === true) main();
