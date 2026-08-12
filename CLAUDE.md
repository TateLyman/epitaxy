# solmeme

Solana memecoin trading research system. Default mode is `observe`, which cannot take a position.

## Commands

```
pnpm doctor      preflight: node, sqlite, config, storage, secrets, provider reachability
pnpm observe     discover, screen, and store decisions; never transacts
pnpm paper       simulate fills against live executable quotes; never signs
pnpm replay      re-derive stored decisions from their snapshots and diff
pnpm backtest    chronological cost-aware evaluation
pnpm report      HTML/JSON reports
pnpm status      what the engine is doing right now
pnpm health      liveness and freshness
pnpm reconcile   rebuild position state from the chain
pnpm canary      tiny mainnet execution — gated, run by a human
pnpm live        full execution — gated, run by a human
pnpm kill        block new entries and attempt policy-compliant exits
pnpm check       typecheck + secretscan + test
```

Mode comes from `--mode=`, never from a `MODE=` prefix. An inline assignment in a
package.json script silently does nothing under cmd.exe, so `modeFromArgv()` is the
only supported path.

## Architecture

TypeScript monorepo run directly through `tsx`. No build step and no `dist/` — imports
are relative and carry a `.js` suffix per ESM resolution.

```
packages/domain        config, types, bigint amount math
packages/adapters      HTTP, rate limiting, Jupiter client and schemas
packages/solana        base58, mint decoding, transaction decoding, tx policy, RPC
packages/intelligence  risk gates (cheap, quote, concentration)
packages/strategy      screening, scoring, sizing, exits
packages/pipeline      the cycle that turns discovery into stored decisions
packages/execution     signer, policy binding, effect, state machine, deployment gates
packages/storage       SQLite schema, repositories, process lock
packages/research      replay, backtest, report
apps/collector         observe
apps/engine            paper
apps/executor          canary and live, reconcile
```

## Invariants

These are not preferences. Breaking one is a defect regardless of what it enables.

- **`bigint` for every token amount.** Never a float for lamports, raw units, fees, or
  balances. Amounts persist as TEXT because SQLite INTEGER is 64-bit *signed*.
- **The signer never accepts an arbitrary serialized transaction.** Policy, binding, and
  effect all pass, or nothing is signed.
- **Observe and paper cannot trade.** Neither imports `packages/execution/`. The e2e
  suite asserts the capital-bearing tables are empty against the database, not against
  the code path.
- **Live requires an acknowledgement file outside the repository.** No combination of
  gates can all-pass without it.
- **Rejections are the product.** A screening row is written for every token screened,
  and a snapshot for every screening. A filter whose rejects are not stored can never be
  evaluated.
- **Every decision is re-derivable from its snapshot.** If replay diverges, either the
  snapshot is incomplete or the strategy changed. Both are defects until explained.
- **Absence of a provider field is a fact about the provider, not about the token.** It
  is graded as soft risk. It never hard-vetoes, and it is never treated as safe.
- **Fail closed.** Anything that cannot be fully decoded, verified, or explained is
  refused rather than partially interpreted.
- **No LLM in the live hot path.** Token names, symbols, and metadata are display-only
  data and are never interpreted as instructions or dereferenced as URLs.
- **Never fabricate a fill, a test pass, a performance number, or an endpoint response.**

## Forbidden

- Signing anything the three checks did not clear, or adding a bypass to them.
- Running `pnpm canary` or `pnpm live`, or creating the live acknowledgement file. Both
  spend real funds and are a human act. `.claude/hooks/guard.mjs` blocks them.
- Widening a risk cap, weakening a gate, or removing the acknowledgement requirement
  without it being an explicit, reviewed change.
- Reading `.env`, keypair files, SSH keys, or credential stores. Denied in
  `.claude/settings.json`.
- Deleting the database. It is the research corpus and it is not reproducible.
- Leverage, martingale, averaging down, or competing in a first-block latency race.
- Raising a timeout or deleting a test to make a suite pass. Find out why it failed.

## Testing

`pnpm test` runs unit, property, replay, chaos, and e2e suites. It must complete in
seconds — if it hangs, that is the bug.

`tests/setup.ts` bounds fast-check globally. A property search runs *synchronously*, so a
false property blocks the event loop and `testTimeout` can never fire; the guard has to
live inside fast-check. Do not remove it to make a test pass.

Write test doubles against the real return type. A stub returning a shape the real client
never returns produces failures that look like production defects.

## Changing a threshold

Any threshold changed after looking at the corpus goes in `docs/MULTIPLE_TESTING_LEDGER.csv`
before the change lands, with the sample it was chosen on. Distinguish availability-driven
changes (a provider never populates the field) from outcome-driven ones (returns improved).
The second spends alpha and needs a hold-out.

## Docs

`docs/STATUS.md` states what is operational, what is disabled, what evidence exists, and
what is unproven. Keep it current, and never write "production ready" without naming the
tests, sample, mode, and open risks behind the claim.
