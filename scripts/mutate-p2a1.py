"""Mutation check for the P2a.1 modules: impact, diagnostics, ATA rent,
admissibility and instruction policy.

A test that passes against a broken implementation is not evidence. Each
mutation below is a defect that would produce a plausible, confident, wrong
number -- which is the failure mode this whole session exists to remove -- and
the suite has to fail on every one of them.

Several are the ACTUAL historical defects: I1 is the parser that returned 0 for
an absent impact field, D3 is the ordering that let a provider outage be
recorded as a liquidity event, A1 is the automatic rent credit.
"""
import pathlib
import re
import subprocess
import sys

IMPACT = pathlib.Path('packages/domain/src/impact.ts')
DIAG = pathlib.Path('packages/domain/src/exitdiagnostic.ts')
ATA = pathlib.Path('packages/domain/src/ata.ts')
CONF = pathlib.Path('packages/research/src/confirmatory.ts')
POLICY = pathlib.Path('packages/solana/src/instructionpolicy.ts')

MUTATIONS = [
    (IMPACT, 'I1 the original defect: an absent impact field becomes 0',
     lambda s: s.replace(
         "      status: 'ABSENT',",
         "      status: 'OK',\n      signedPct: 0,\n      signedBps: 0,\n      adverseBps: 0,\n      favourableBps: 0,")),
    (IMPACT, 'I2 Math.abs on the signed impact, the defect this session is named after',
     lambda s: s.replace(
         '    adverseBps: signedBps < 0 ? -signedBps : 0,',
         '    adverseBps: Math.abs(signedBps),')),
    (IMPACT, 'I3 the sign convention is inverted, so adverse and favourable swap',
     lambda s: s.replace(
         '    adverseBps: signedBps < 0 ? -signedBps : 0,\n    favourableBps: signedBps > 0 ? signedBps : 0,',
         '    adverseBps: signedBps > 0 ? signedBps : 0,\n    favourableBps: signedBps < 0 ? -signedBps : 0,')),
    (IMPACT, 'I4 the range check is dropped, so a unit error passes as a market event',
     lambda s: s.replace('  if (asFraction < -1 || asFraction > 1) {', '  if (false) {')),
    (IMPACT, 'I5 the two fields are never cross-checked',
     lambda s: s.replace('  if (hasPercent && hasFraction) {', '  if (false) {')),
    (IMPACT, 'I6 percent is not scaled to a fraction',
     lambda s: s.replace(
         '  const asFraction = hasPercent ? Number(o.priceImpact) / PERCENT_TO_FRACTION : Number(o.priceImpactPct);',
         '  const asFraction = hasPercent ? Number(o.priceImpact) : Number(o.priceImpactPct);')),

    (DIAG, 'D1 an unbuildable exit is not diagnosed',
     lambda s: s.replace('  if (input.routeBuildable === false) {', '  if (false) {')),
    (DIAG, 'D2 an unknown buildability is treated as a failure',
     lambda s: s.replace('  if (input.routeBuildable === false) {', '  if (input.routeBuildable !== true) {')),
    (DIAG, 'D3 the original defect: a provider outage ranks below the economics',
     lambda s: s.replace('  if (input.providerFailed) {', '  if (false) {')),
    (DIAG, 'D4 an unknown adverse impact satisfies the cap',
     lambda s: s.replace(
         '  const adverse = input.impact?.adverseBps ?? null;',
         '  const adverse = input.impact?.adverseBps ?? 99_999;')),
    (DIAG, 'D5 the collapse boundary is exclusive',
     lambda s: s.replace(
         '  if (ratioBps !== null && ratioBps <= thresholds.collapseRatioBps) {',
         '  if (ratioBps !== null && ratioBps < thresholds.collapseRatioBps) {')),
    (DIAG, 'D6 a schema error is not allowed to outrank the economics',
     lambda s: s.replace(
         '  if (input.impact !== null && impactIsSchemaError(input.impact)) {', '  if (false) {')),
    (DIAG, 'D7 an unbuildable exit no longer disqualifies a row from confirmatory data',
     lambda s: s.replace(
         "  return isOurFault(d) || d === 'UNVERIFIABLE' || d === 'UNBUILDABLE_EXIT';",
         "  return isOurFault(d) || d === 'UNVERIFIABLE';")),
    (DIAG, 'D8 the value ratio is computed in floating point before the division',
     lambda s: s.replace(
         '  return Number((sellValue * 10_000n) / cost);',
         '  return Math.round((Number(sellValue) / Number(cost)) * 10_000) + 1;')),

    (ATA, 'A1 the original defect: rent is credited back automatically',
     lambda s: re.sub(
         r'export function settleAtaRent\(state: AtaState\): AtaRentVerdict \{',
         'export function settleAtaRent(state: AtaState): AtaRentVerdict {\n'
         '  return { ataRentRecoveredLamports: state.ataRentLockedLamports, ataRentLostLamports: 0n,'
         ' ataCloseFailureReason: null, detail: "assumed" };',
         s)),
    (ATA, 'A2 an unobserved withheld fee is treated as zero',
     lambda s: s.replace(
         '  if (state.withheldTransferFeeLamports === null) {', '  if (false) {')),
    (ATA, 'A3 an unobserved residual balance is treated as empty',
     lambda s: s.replace('  if (state.residualTokenAmount === null) {', '  if (false) {')),
    (ATA, 'A4 a close that was never built still earns the credit',
     lambda s: s.replace('  if (state.ataCloseBuildable !== true) {', '  if (false) {')),
    (ATA, 'A5 the close fee is not charged against the credit',
     lambda s: s.replace('  const net = locked - state.ataCloseFeeLamports;', '  const net = locked;')),

    (CONF, 'C1 a row with no build proof is admissible',
     lambda s: s.replace(
         "  if (row.bothLegsBuildable !== true) exclusions.push('NOT_BUILD_VALID');",
         "  if (row.bothLegsBuildable === false) exclusions.push('NOT_BUILD_VALID');")),
    (CONF, 'C2 a row with no raw payload is admissible',
     lambda s: s.replace(
         "  if (row.rawPayloadHash === null) exclusions.push('NO_RAW_PAYLOAD');", '')),
    (CONF, 'C3 regimes are pooled silently',
     lambda s: s.replace(
         '  if (regimes.length > 1) throw new PoolingRefused(regimes);', '')),
    (CONF, 'C4 an untagged row is folded in rather than counted as its own regime',
     lambda s: s.replace(
         "  const regimes = [...new Set(rows.map((r) => r.dataRegimeId ?? 'UNTAGGED'))].sort();",
         "  const regimes = [...new Set(rows.map((r) => r.dataRegimeId).filter((r) => r !== null))].sort();")),
    (CONF, 'C5 mark-level resampling is permitted',
     lambda s: s.replace(
         "  if ((VALID_RESAMPLING_UNITS as readonly string[]).includes(unit)) return unit as ResamplingUnit;",
         "  return unit as ResamplingUnit;")),
    (CONF, 'C6 the counterfactual fills at its own trigger quote',
     lambda s: s.replace(
         '      if (candidate.quoteId !== null && candidate.quoteId === mark.quoteId) {\n'
         '        throw new TriggerQuoteReused(candidate.quoteId);\n      }', '')),
    (CONF, 'C7 latency is not applied, so the fill can precede the decision reaching the chain',
     lambda s: s.replace(
         '    const earliestFillUtcMs = mark.observedUtcMs + latencyMs;',
         '    const earliestFillUtcMs = mark.observedUtcMs;')),
    (CONF, 'C8 an unbuildable later quote rescues a blocked exit',
     lambda s: s.replace(
         '      if (candidate.routeBuildable !== true) continue;',
         '      if (candidate.routeBuildable === false) { /* accepted anyway */ }')),
    (CONF, 'C9 a policy may be ranked on any sample size',
     lambda s: s.replace(
         '  return validTrades >= MIN_VALID_TRADES_FOR_SELECTION',
         '  return validTrades >= 0')),

    (POLICY, 'P1 an unexpected co-signer is permitted',
     lambda s: s.replace('    if (s !== limits.expectedSigner) {', '    if (false) {')),
    # `null ?? {...}` is a no-op, so the earlier form of this mutation proved
    # nothing and survived while the code was correct. Falling through the
    # limit-only branch makes the neither-case return no violation, which is
    # the actual defect.
    (POLICY, 'P2 a response with neither a unit limit nor a price is permitted',
     lambda s: s.replace('  if (unitLimit !== null) {', '  if (true) {')),
    (POLICY, 'P5 an unaffordable compute price is permitted',
     lambda s: s.replace('        capped < MIN_PLAUSIBLE_COMPUTE_UNITS', '        false')),
    (POLICY, 'P6 the affordable limit ignores our own fee cap',
     lambda s: s.replace(
         '    const affordable = Number((maxPriorityFeeLamports * 1_000_000n) / unitPriceMicroLamports);',
         '    const affordable = MAX_COMPUTE_UNITS;')),
    (POLICY, 'P7 a limit with no price is refused, so every cheap route is rejected',
     lambda s: s.replace(
         '  if (unitLimit !== null) {\n    return { unitLimit, unitPriceMicroLamports: null, affordableUnitLimit: unitLimit, violation: null };',
         '  if (false) {\n    return { unitLimit, unitPriceMicroLamports: null, affordableUnitLimit: unitLimit, violation: null };')),
    (POLICY, 'P3 an unknown program is permitted',
     lambda s: s.replace('    if (!allowed.has(program)) {', '    if (false) {')),
    (POLICY, 'P4 instruction-level approval claims full transaction coverage',
     lambda s: s.replace(
         "export const INSTRUCTION_POLICY_COVERAGE = 'instructions-only';",
         "export const INSTRUCTION_POLICY_COVERAGE = 'full-transaction';")),
]

TESTS = [
    'tests/unit/p10-regressions.test.ts',
    'tests/unit/p16-repair.test.ts',
    'tests/unit/buildability.test.ts',
    'tests/unit/exitoutcome.test.ts',
]

FILES = {p: p.read_text(encoding='utf-8') for p in (IMPACT, DIAG, ATA, CONF, POLICY)}
unapplied, survived = [], []

try:
    for path, name, mutate in MUTATIONS:
        mutated = mutate(FILES[path])
        if mutated == FILES[path]:
            unapplied.append(name)
            print(f'!! {name}: PATTERN DID NOT MATCH — mutation not applied')
            continue
        path.write_text(mutated, encoding='utf-8')
        r = subprocess.run(
            ['npx', 'vitest', 'run', *TESTS, '--reporter=basic'],
            capture_output=True, text=True, shell=True,
        )
        out = re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
        m = re.search(r'Tests\s+(\d+) failed', out)
        n = int(m.group(1)) if m else 0
        # A mutation that makes the file fail to PARSE is not a caught mutation;
        # it is a broken script. Detect it so it cannot be mistaken for coverage.
        broken = 'Failed to load' in out or 'Transform failed' in out
        path.write_text(FILES[path], encoding='utf-8')
        if broken:
            unapplied.append(f'{name} (mutation did not compile)')
            print(f'!! {name}: MUTATION DID NOT COMPILE — proves nothing')
        elif n == 0:
            survived.append(name)
            print(f'SURVIVED  {name}  <-- not covered')
        else:
            print(f'caught    {name}  ({n} failing test(s))')
finally:
    for path, original in FILES.items():
        path.write_text(original, encoding='utf-8')
    print(f'\nrestored {len(FILES)} files')

if unapplied or survived:
    print(f'\nFAILED: {len(unapplied)} unapplied, {len(survived)} survived')
    sys.exit(1)
print(f'\nall {len(MUTATIONS)} mutations caught')
