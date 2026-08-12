# Audit baseline — HEAD `3155ea7`

Captured 2026-08-12 before any semantic change, per §P0 of the executable-truth
repair directive.

## Repository

| item | value |
|---|---|
| path | `C:\Users\lyman\tradseee` |
| remote | `https://github.com/TateLyman/epitaxy.git` |
| branch | `master` |
| local HEAD | `3155ea74795fd51279575803d17abeb293f20b08` |
| audited HEAD | `3155ea74795fd51279575803d17abeb293f20b08` |
| **local ahead of GitHub?** | **No.** Identical. Nothing to preserve from a newer local commit. |
| dirty at capture | the new directive file and `scripts/audit-baseline.ts` only |

## Process

Engine pid 12240 was running paper mode at capture, then stopped cleanly with
`TERMINATE_WHEN_FLAT` so that the invalidated window would stop accumulating
rows. It was flat, so the halt could not orphan anything.

## Database

| item | value |
|---|---|
| path | `./data/runtime.db` |
| WAL / SHM present | yes / yes |
| schema version | 7 |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 violations |
| `PRAGMA wal_checkpoint(PASSIVE)` | executed, recorded in the manifest |

### Positions

```
POSITION_CLOSED = 20
```

**No open position. No `EXIT_BLOCKED` position. Nothing to preserve.**

That query is deliberately written against `positions` directly rather than
through `openPositions()`, because `openPositions()` excludes `EXIT_BLOCKED` —
which is the §4.1 defect, and means every other health surface in this tree is
blind to exactly the state that most needs watching. The invariant this repair
introduces is checked here from first principles:

```sql
SELECT * FROM positions WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0
-- 0 rows
```

Had that returned anything, it would have been a position holding tokens that no
code path was managing.

## Backup

| item | value |
|---|---|
| method | `VACUUM INTO` — a consistent snapshot with WAL active |
| path | `data/backups/baseline-2026-08-12T21-30-42-164Z.db` |
| sha256 | `a4ece756733adbd02d411bc4bb2f7d8080c1901ed86fa3bdf91caa3df97a3e32` |
| integrity on read-back | `ok` |
| bounds check | **PASS** — `before ≤ backup ≤ after` on all 18 tables |

A naïve file copy of the same database was taken at the same instant and hashed:
`6f56ab8ffa79dd…`. It differs from the `VACUUM INTO` snapshot. That is the whole
argument for the method — with WAL active the main `.db` file is not a complete
database, and copying it alone silently drops the most recent and most relevant
rows.

The read-back verification asserts `before ≤ backup ≤ after` per table rather
than equality, because the engine was still writing during the capture. Equality
would have been the wrong assertion and would have failed for a correct backup.

## Endpoint classes

| source | class | key |
|---|---|---|
| Jupiter Swap/Token/Price | `https://api.jup.ag` | free API key active |
| Solana RPC | Helius, derived from `HELIUS_API_KEY` | free plan |
| Solana WSS | `SOLANA_RPC_WS` | **not wired into the engine** (§7.5 open) |

No credential values are printed anywhere in this document, the manifest, or the
capture script.

## Corpus at baseline

| table | rows |
|---|---|
| screenings | 181,000+ |
| quotes | 2,545 |
| position_marks | 603 |
| positions | 20 (all closed) |
| build_attempts | **0** |
| raw_payloads | **0** |
| run_contexts | 3 |
| ledger_entries | 10 |

The two zeros are the important ones. Under HEAD `3155ea7` the engine had never
completed a `/swap/v2/build` call against this database and had never retained a
raw payload, so **no row in this corpus is admissible as confirmatory evidence**
and the §P1 invalidation costs nothing that was real.

## Full manifest

`data/backups/baseline-2026-08-12T21-30-42-164Z.manifest.json` — SHA-256, sizes,
per-table counts at three points, max row identifiers and timestamps, all
position states, unmanaged-position query result, and every run context.
