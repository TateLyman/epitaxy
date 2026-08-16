Eight defects, all on the wire or in the client. None was visible to any test, because every test spoke the same wrong protocol as the code.

## F7 — u64 crossed JSON as a number

`rent_epoch` for a rent-exempt account is `u64::MAX` = 18446744073709551615. No IEEE double can hold it — the nearest is 2^64 — so it came back **one higher** and printed as `18446744073709552000`. Nothing raised at either end.

Worse, the client **hardcoded `rent_epoch` to 0** on the way in, which restores every mainnet account as rent-*paying*. That is a different account.

Both directions are decimal strings now, and deserialization accepts a string **only**. Accepting a number "for compatibility" leaves the defect reachable from any caller that was not updated, which is the same as not fixing it.

## F8 — three leaks between jobs, and a queue that could corrupt silently

- `known` accumulated for the life of the **process**, so job two's state hash covered job one's accounts and moved for reasons belonging to a previous experiment.
- The host's byte counter was a process total, so job one could spend the allowance and job two die for it — and the death looked like a fact about job two.
- Every observed account shipped its full base64 payload. That is what put a size surface over **280 MB** and killed the worker.

All three reset on `Init`, the budget is per job, and `economic` names the accounts whose bytes are actually decoded.

Separately: a failed `stdin.write` rejected its promise and **left its slot in the queue**. Every later response was then paired with the wrong request, and each caller received a well-formed answer to somebody else's question.

## F9 — the sysvars were derived, and the exact ones were thrown away

The runtime computed `epoch = slot / 432_000`. At today's slot that is wrong by five epochs, and a program sizing an account it creates got a Rent answer mainnet never gave.

The coherent snapshot had **already decoded Clock, Rent and EpochSchedule exactly — and discarded them**. It ran purely as a drift check; nothing read its result. They are now restored verbatim, and the collector *requires* them rather than accepting a derived clock, because a caller that captured exact state and got a synthesis has an approximation wearing the label of a capture.

## F10 — the survival check compared data hashes

An account whose owner, balance, executability and rent epoch had all changed compared **equal**. Those are precisely the fields a runtime consults before it will execute against the account at all. The hash now covers the whole account, including absence.

## P3 — a missing required account was a note in a list

It now refuses, and a refused `init` leaves **no** runtime. Otherwise the transaction fails with an error that reads as a fact about the token.

## Why scoping output is safe

`dataBase64: null` means **not requested**. It is not an empty account and not a zero balance, and anything that tries to decode it throws by name. That is why getting the economic set wrong surfaced immediately as `the bytes of GgSuFAyZ… were never requested` rather than as a token that credited nothing.

## Evidence

```
pnpm worker:exactness-proof     allPassed: true, against the real binary
  rentEpochExact                true   (double would read 18446744073709552000)
  nonEconomicWithheldBytes      true   (1024 bytes withheld, length still reported)
  accountHashChanged            true   (same data, different owner/lamports)
  epochIsTheCapturedOne         1021   (derived would have been 1016)
  requiredAccountRefuses        true
  outputBudgetIsPerJob          refused within the job, cleared by Init
```

The collector then opened three trajectories on the new protocol with **identical acquired amounts** to the old one, so the exactness fixes changed the apparatus and not the mechanics.

```
typecheck   clean
secretscan  clean
tests       1,536 passed, 4 skipped, 107 files  (19 new)
```

The running daemon was refused by the new binary the moment it was rebuilt — `invalid type: integer` — which is the fail-closed protocol behaving correctly rather than silently misreading numbers.

Nothing funded, signed or submitted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
