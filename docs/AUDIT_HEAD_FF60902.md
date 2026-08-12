# Audit baseline — HEAD `ff60902`

Captured 2026-08-12 before any semantic change, per §0.

## Repository

| item | value |
|---|---|
| path | `C:\Users\lyman\tradseee` |
| remote | `https://github.com/TateLyman/epitaxy.git` |
| branch | `master` |
| local HEAD | `ff60902e407fc15339bc7c03e33308da5c0aebe7` |
| audited HEAD | `ff60902e407fc15339bc7c03e33308da5c0aebe7` |
| **local ahead of GitHub?** | **No.** Identical. Nothing newer to preserve. |
| dirty at capture | the new directive file only |
| node / pnpm | v24.12.0 / 11.13.0 (**deprecated — see below**) |

## Process and positions

Engine pid 14096, paper mode, context `7952072ac025`, regime
`delayed-momentum-v0.4.0/10s/build/52d37d3bbcd3`, no halt file.

```
POSITION_CLOSED = 20
```

**No open position. No `EXIT_BLOCKED` position. No position holding tokens.**

```sql
SELECT * FROM positions WHERE closed_utc_ms IS NULL AND CAST(token_amount AS INTEGER) > 0
-- 0 rows
```

Shadow books at capture: `alpha_shadow` and `canary_shadow`, both live and
accumulating. 1567 execution observations, 1338 policy-valid (85%), **0
simulated**.

## Database

| item | value |
|---|---|
| path | `./data/runtime.db` |
| WAL / SHM | present / present |
| schema version | 9 |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 violations |
| backup | `data/backups/baseline-2026-08-12T23-32-44-016Z.db` |
| backup sha256 | `a21349418835a69f250ab20fd610c181266b24d3dc2cd69165a336b3fe804e9d` |
| read-back integrity | `ok` |
| bounds check | **PASS** — `before ≤ backup ≤ after` on all 18 tables |
| naïve file copy, same instant | `53fb41193c101989…` — **differs**, which is the argument for `VACUUM INTO` |

## CI

**Red, and had been since it was added.** Runs `31647271678` and `31647059747`
both failed on `ubuntu-latest`:

```
SignerError: keypair /tmp/signer-m4Cl1N/good.json is group/world accessible (mode 644)
```

The signer is correct. `writeFileSync` honours the umask, so every key fixture
landed at 0644 on Linux, and every signer test died on the permission check
before reaching its intended assertion. It passed on Windows because NTFS does
not carry POSIX mode bits — a Windows-only CI was not a smaller version of the
matrix, it was a different one.

The registry also emitted, in the same log:

```
WARN deprecated pnpm@11.13.0: This is a broken version. Please install pnpm v11.13.1 or newer
```

Confirmed independently: `pnpm@11.21.0` is `latest` and `latest-11` and carries
no deprecation.

## Branch protection

**Cannot be set, and this is an operator blocker.**

```
GET /repos/TateLyman/epitaxy/branches/master/protection
403: Upgrade to GitHub Pro or make this repository public to enable this feature.
```

Branch protection on a private repository requires GitHub Pro. Neither
alternative is mine to choose: making a trading repository public is a security
decision, and paying for Pro is a spending decision. See §"Operator actions" in
the final report.

## WSL and disk

| item | value |
|---|---|
| WSL | WSL2, default distribution `Ubuntu-24.04`, **Running** |
| kernel | 6.18.33.1-microsoft-standard-WSL2 |
| node / pnpm in WSL | v24.16.0 / 11.13.0 |
| free disk | 936 GB of 1.9 TB |

WSL was already installed and running, so §6.1 needed no reboot and no operator
action. A Linux checkout was made at `~/epitaxy` with its own `node_modules`,
because the Windows tree's native binaries (rollup) cannot load under Linux.

## Endpoint classes

| source | class | key |
|---|---|---|
| Jupiter Swap/Token/Price | `https://api.jup.ag` | free API key active |
| Solana RPC | Helius, derived from `HELIUS_API_KEY` | free plan |
| Solana WSS | `SOLANA_RPC_WS` | **not wired into the engine** (§13 open) |

No credential value appears in this document, the manifest, or any capture
script.

## Full manifest

`data/backups/baseline-2026-08-12T23-32-44-016Z.manifest.json` — SHA-256, sizes,
per-table counts at three points, max row identifiers and timestamps, every
position state, the unmanaged-position query result, and all run contexts.
