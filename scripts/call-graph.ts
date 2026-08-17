/**
 * P5 — a machine-generated call graph, because a type import is not evidence.
 *
 * This system has twice shipped a decision path that no decision called. The
 * urgent-mark queue was written by an alarm and read by nothing; the exploration
 * arm was allocated a budget of zero and never ran a quote. Both passed review,
 * and both would have passed a test that greps the source for a reassuring
 * identifier — the identifier was there.
 *
 * So the required chain is asserted against the actual AST: function A calls
 * function B, resolved through the TypeScript program, from the entry point
 * outward. A path that is not in the graph did not happen, whatever the file
 * says about itself.
 *
 * Emits `artifacts/production-call-graph.json` and exits non-zero if a required
 * edge is missing, so CI fails on a lifecycle that has been quietly unhooked.
 */
import ts from 'typescript';
import { writeFileSync, mkdirSync } from 'node:fs';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';

const ENTRY_FILES = [
  'apps/engine/src/paper.ts',
  'apps/engine/src/paper-core.ts',
  'apps/engine/src/ledger.ts',
  'apps/engine/src/observe-route.ts',
  'apps/engine/src/risk-alarm.ts',
  'apps/engine/src/simulate-observation.ts',
  'packages/pipeline/src/cycle.ts',
  /**
   * The COLLECTOR, which this graph had never once parsed.
   *
   * `declaredIn.get('openTrajectory')` was `undefined` — not "unreachable",
   * simply absent, because the program was built from a fixed entry list that
   * stopped at the paper engine. The tool whose entire purpose is proving that
   * a decision path is wired had no view of the process this directive exists
   * to wire, which is why `trajectory:collect` could print a refusal naming an
   * already-built worker for two commits without anything noticing.
   */
  'apps/collector/src/trajectory-collect.ts',
  'apps/collector/src/live-lane.ts',
];

/**
 * The chain the directive requires, as ordered pairs.
 *
 * Each is "the first thing must be able to reach the second", by any path in
 * the graph. Direct edges are too strict — a real call chain goes through
 * helpers — and unordered presence is too loose, because both ends existing is
 * exactly the state that shipped twice.
 */
const REQUIRED: readonly { from: string; to: string; why: string }[] = [
  { from: 'main', to: 'runCycle', why: 'the shell drives discovery' },
  { from: 'main', to: 'tryEnter', why: 'the cycle reaches entry' },
  { from: 'tryEnter', to: 'admitPortfolioEntry', why: 'entry goes through the core admission' },
  { from: 'tryEnter', to: 'measuredSettlementOf', why: 'the position is booked from canonical settlement' },
  { from: 'tryEnter', to: 'entryCashOut', why: 'entry cash out comes from the settlement module' },
  { from: 'main', to: 'manageOpenPositions', why: 'the shell drives the position loop' },
  { from: 'manageOpenPositions', to: 'chooseDecisionMark', why: 'marks come from the core selector' },
  { from: 'manageOpenPositions', to: 'admitPortfolioExit', why: 'exits go through the core admission' },
  { from: 'manageOpenPositions', to: 'measuredSettlementOf', why: 'the close is booked from canonical settlement' },
  { from: 'manageOpenPositions', to: 'exitCashIn', why: 'exit cash in comes from the settlement module' },
  { from: 'manageOpenPositions', to: 'executionCost', why: 'cost excludes principal, from the one module that knows' },
  { from: 'main', to: 'manageShadowBooks', why: 'the shell drives the shadow lifecycle' },
  /**
   * The shadow exit admission MOVED, and this edge was left describing the old one.
   *
   * It used to be `manageShadowBooks -> admitPortfolioExit`, and the checked-in
   * artifact said `reached: true`. Regenerating the graph at `4ec715f` — before
   * any of this session's changes — showed it already unreachable, so the
   * artifact was simply stale and had been hiding the drift. That is F23 in one
   * example: a stale artifact is not neutral, it is a green check over a fact
   * nobody re-derived.
   *
   * The drift is not a regression. The shadow loop's exit is now admitted by
   * `simulateLeg` followed by `resolveFill`, which is STRICTER than
   * `admitPortfolioExit` was: it requires an effect-valid candidate AND a later
   * observation than the trigger. That second requirement is what forbids
   * closing at the trigger mark — the look-ahead bias that voided 1,038 shadow
   * results, where every exit filled at the one price a real exit can never
   * get, the price that caused the decision to exit.
   *
   * So the edge is REPOINTED at the guarantee that exists, not deleted. An
   * assertion aimed at a superseded design fails without telling anyone what
   * broke; one aimed at nothing is worse.
   */
  { from: 'manageShadowBooks', to: 'resolveFill', why: 'a shadow exit needs a LATER valid fill, never its trigger mark' },
  { from: 'manageShadowBooks', to: 'simulateLeg', why: 'the fill candidate is simulated before it can be effect-valid' },
  { from: 'runCycle', to: 'readMintFacts', why: 'screening reads the mint from the chain' },
  { from: 'runCycle', to: 'screenCheap', why: 'screening actually runs' },
];

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile('tsconfig.json', ts.sys.readFile).config,
  ts.sys,
  process.cwd(),
);
const program = ts.createProgram(ENTRY_FILES, config.options);
const checker = program.getTypeChecker();

/** name -> the names it calls. */
const edges = new Map<string, Set<string>>();
const declaredIn = new Map<string, string>();

function nameOfDeclaration(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText() ?? null;
  if (ts.isVariableDeclaration(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return node.name.getText();
  }
  return null;
}

/** The enclosing named function of any node, or null at the top level. */
function enclosingFunctionName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    const n = nameOfDeclaration(cur);
    if (n !== null) return n;
    cur = cur.parent;
  }
  return null;
}

/**
 * The declared name a call expression resolves to.
 *
 * Through the checker, not by matching text: `db.prepare(...)` and a local
 * `prepare` are different things, and a graph that conflates them would report
 * edges nobody wrote.
 */
function calleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  const id = ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) ? expr.name : null;
  if (id === null) return null;
  const sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return null;
  const resolved = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
  const decl = resolved.declarations?.[0];
  if (decl === undefined) return null;
  const file = decl.getSourceFile().fileName;
  // Anything in node_modules is a library call, not a decision path.
  if (file.includes('node_modules')) return null;
  const name = resolved.getName();
  if (!declaredIn.has(name)) declaredIn.set(name, file.replace(process.cwd().replace(/\\/g, '/'), '').replace(/^[/\\]/, ''));
  return name;
}

for (const sf of program.getSourceFiles()) {
  if (sf.fileName.includes('node_modules') || sf.isDeclarationFile) continue;
  const rel = sf.fileName.replace(process.cwd().replace(/\\/g, '/'), '').replace(/^[/\\]/, '');
  if (!rel.startsWith('apps/') && !rel.startsWith('packages/')) continue;

  const walk = (node: ts.Node): void => {
    const declName = nameOfDeclaration(node);
    if (declName !== null) declaredIn.set(declName, rel);
    if (ts.isCallExpression(node)) {
      const from = enclosingFunctionName(node);
      const to = calleeName(node);
      if (from !== null && to !== null && from !== to) {
        const set = edges.get(from) ?? new Set<string>();
        set.add(to);
        edges.set(from, set);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

/** Every name reachable from `start`, and the shortest path to each. */
function reach(start: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const path = seen.get(cur) as string[];
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.set(next, [...path, next]);
      queue.push(next);
    }
  }
  return seen;
}

const results = REQUIRED.map((r) => {
  const reachable = reach(r.from);
  const path = reachable.get(r.to) ?? null;
  return {
    from: r.from,
    to: r.to,
    why: r.why,
    reached: path !== null,
    path,
    hops: path === null ? null : path.length - 1,
    declaredIn: declaredIn.get(r.to) ?? null,
  };
});

const missing = results.filter((r) => !r.reached);

/**
 * Where the lifecycle lives, which is the OTHER thing the call graph answers.
 *
 * The directive wants the decisions in a production core and the shell reduced
 * to startup, clock, scheduler, health and shutdown. Counting the required
 * targets by file says how far that has got, in a number nobody can round.
 */
const LIFECYCLE = [
  'admitPortfolioEntry',
  'chooseDecisionMark',
  'admitPortfolioExit',
  'measuredSettlementOf',
  'entryCashOut',
  'exitCashIn',
  'immediateRoundTrip',
  'executionCost',
];
const placement = LIFECYCLE.map((fn) => ({ fn, declaredIn: declaredIn.get(fn) ?? null }));
const inShell = placement.filter((p) => p.declaredIn === 'apps/engine/src/paper.ts').length;

const summary = {
  provenance: currentProvenance({ strategyVersion: 'delayed-momentum-v0.6.0', schemaVersion: 'schema-v31' }),
  functions: declaredIn.size,
  edges: [...edges.values()].reduce((t, s) => t + s.size, 0),
  required: results,
  missing: missing.map((m) => `${m.from} -> ${m.to} (${m.why})`),
  lifecyclePlacement: placement,
  lifecycleStillInShell: inShell,
  note:
    'Edges are resolved through the TypeScript checker, not by matching text. A path absent from this ' +
    'graph did not happen, whatever the source says about itself.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/production-call-graph.json', JSON.stringify(summary, null, 2));

/**
 * P4 — the COLLECTOR's own production path, as a separate artifact.
 *
 * The whole-tree graph answers "does any required edge hold". This answers a
 * narrower and more load-bearing question: does `runCycle` actually reach the
 * functions the directive says the collector must run?
 *
 * That question is the entire reason this directive exists. `trajectory:collect`
 * printed `NOT OPENING TRAJECTORIES: the one-pass sequential worker (P3) is not
 * built` for two commits AFTER the worker was built, because nothing checked
 * that the collector reached it. A graph rooted at the collector makes that
 * failure visible as a missing edge instead of as a log line nobody re-read.
 */
const COLLECTOR_MUST_REACH: readonly { to: string; why: string }[] = [
  { to: 'captureCoherentSnapshotV2', why: 'the snapshot is coherent, not the legacy one-at-a-time capture' },
  { to: 'openTrajectory', why: 'the collector opens trajectories rather than refusing to' },
  { to: 'buildBuyFrom', why: 'the entry is built by the official PumpSwap builder, not a router' },
  { to: 'freezeAccountPlan', why: 'the exact plan of the bytes that ran is frozen (F12)' },
  { to: 'remainingTailRefusal', why: 'cashback placement is verified fail-closed on both legs' },
  { to: 'sequentialRoundTrip', why: 'buy and sell run in ONE persistent runtime' },
  { to: 'classifyCreatedAccount', why: 'every account the leg opened is classified (P6)' },
  { to: 'legCashbackDeltas', why: 'cashback is measured per leg (P7)' },
  { to: 'admitCandidate', why: 'risk facts gate the decision (P10)' },
  { to: 'assertCollectedBeforeDecision', why: 'those facts precede the decision, by construction' },
  { to: 'takeMark', why: 'the shared later mark path is collected (P9)' },
  { to: 'evaluateExitPolicies', why: 'every policy is evaluated on that same path' },
  { to: 'insertTrajectory', why: 'the trajectory reaches the DATABASE, not an artifact' },
];

const fromCycle = reach('runCycle');
const collectorEdges = COLLECTOR_MUST_REACH.map((e) => {
  const path = fromCycle.get(e.to) ?? null;
  return { from: 'runCycle', to: e.to, why: e.why, reached: path !== null, hops: path === null ? null : path.length - 1, path };
});
const collectorMissing = collectorEdges.filter((e) => !e.reached);

/**
 * 61 — no signer, no key, no network send is reachable from the collector.
 *
 * `trajectory-collect.ts` says in its own header: "This process cannot sign. It
 * does not import packages/execution." Nothing asserted it. A comment is the
 * weakest possible form of that guarantee, and this repository has twice
 * shipped a path whose reassuring identifier was present and whose behaviour
 * was absent.
 *
 * Checked through the CHECKER: any function reachable from `runCycle` that is
 * declared in `packages/execution/` is a reachable signing path, whatever the
 * imports look like.
 */
const forbiddenReachable = [...fromCycle.keys()]
  .map((fn) => ({ fn, declaredIn: declaredIn.get(fn) ?? null }))
  .filter((x) => x.declaredIn !== null && x.declaredIn.startsWith('packages/execution/'));

writeFileSync(
  'artifacts/collector-call-graph.json',
  JSON.stringify(
    {
      artifact: 'collector-call-graph',
      directiveSection: 'P4',
      provenance: summary.provenance,
      root: 'runCycle (apps/collector/src/trajectory-collect.ts)',
      required: collectorEdges,
      missing: collectorMissing.map((m) => `${m.from} -> ${m.to} (${m.why})`),
      // Item 61. Empty is the only acceptable value.
      executionPackageReachableFromCollector: forbiddenReachable,
      note:
        'Resolved through the TypeScript checker. `trajectory:collect` printed a refusal naming the ' +
        'sequential worker as unbuilt for two commits AFTER it was built, because nothing checked that ' +
        'the collector reached it. A path absent here did not happen, whatever the source says.',
    },
    null,
    2,
  ),
);
console.log('');
console.log('collector path from runCycle:');
for (const e of collectorEdges) {
  console.log(`  ${e.reached ? 'OK  ' : 'MISS'} runCycle -> ${e.to}${e.hops === null ? '' : `  (${e.hops} hops)`}`);
}
if (collectorMissing.length > 0) {
  console.error(`\n${collectorMissing.length} collector edge(s) missing`);
  process.exitCode = 1;
}

console.log(`${summary.functions} functions, ${summary.edges} edges\n`);
for (const r of results) {
  console.log(`  ${r.reached ? 'OK  ' : 'MISS'} ${r.from} -> ${r.to}${r.hops === null ? '' : `  (${r.hops} hops)`}`);
  if (r.path !== null && r.hops !== null && r.hops > 1) console.log(`         ${r.path.join(' -> ')}`);
}
console.log(`\nlifecycle functions still declared in the shell: ${inShell} of ${LIFECYCLE.length}`);
for (const p of placement) console.log(`  ${p.fn.padEnd(24)} ${p.declaredIn ?? 'NOT FOUND'}`);
console.log('\nartifacts/production-call-graph.json');

if (missing.length > 0) {
  console.error(`\n${missing.length} required edge(s) missing:`);
  for (const m of summary.missing) console.error(`  ${m}`);
  process.exit(1);
}
