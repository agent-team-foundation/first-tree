# Migrating from `first-tree-hub` (≤ v0.14.x) to `first-tree` v1.0.0

The `@agent-team-foundation/first-tree-hub` npm package has been renamed to
**`first-tree`** as part of the v1.0.0 release. The legacy package is deprecated
but continues to print a migration hint until at least 2026-12-31.

## TL;DR

```bash
npm uninstall -g @agent-team-foundation/first-tree-hub
npm install -g first-tree
first-tree --help
```

The new binary lives at `first-tree` (plus a short alias `ft`). Every command
you used to run as `first-tree-hub <verb>` now runs as `first-tree <verb>`.

## Why the rename

The hub CLI and the Context Tree / GitHub Scan CLI shipped as two separate
binaries (`first-tree-hub` and `first-tree`) until v1.0.0. v1.0.0 unifies both
into a single CLI under one publish target. See
[`docs/development/git-history.md`](../development/git-history.md) for the
mechanics of the source-repo merge.

## Top-level command map

| Old (`first-tree-hub`) | New (`first-tree`) |
| --- | --- |
| `first-tree-hub login <token>` | `first-tree login <token>` |
| `first-tree-hub login <token> --override` | `first-tree login <token> --override` (was hidden `claim`) |
| `first-tree-hub logout` | `first-tree logout` |
| `first-tree-hub status` | `first-tree status` |
| `first-tree-hub doctor` | `first-tree doctor` |
| `first-tree-hub upgrade` | `first-tree upgrade` (was `update` in even older versions) |
| `first-tree-hub client start` | `first-tree daemon start` |
| `first-tree-hub client stop` | `first-tree daemon stop` |
| `first-tree-hub client restart` | `first-tree daemon restart` |
| `first-tree-hub client status` | `first-tree daemon status` |
| `first-tree-hub client doctor` | `first-tree daemon doctor` |
| `first-tree-hub agent ...` | `first-tree agent ...` |
| `first-tree-hub chat ...` | `first-tree chat ...` |
| `first-tree-hub org ...` | `first-tree org ...` |
| `first-tree-hub config ...` | `first-tree config ...` |

> The CLI top-level was flattened in Phase 1A — the old `hub`/`client` prefixes
> are gone. `daemon` is the new home for client-lifecycle commands.

## Env-var rename

Phase 1A also dropped the `_HUB_` infix from environment variables. Update any
shell rc / CI script that sets these:

| Old | New |
| --- | --- |
| `FIRST_TREE_HUB_AGENT_ID` | `FIRST_TREE_AGENT_ID` |
| `FIRST_TREE_HUB_LOG_LEVEL` | `FIRST_TREE_LOG_LEVEL` |
| `FIRST_TREE_HUB_JSON` | `FIRST_TREE_JSON` |

`FIRST_TREE_HOME`, `FIRST_TREE_SERVICE_MODE`, `FIRST_TREE_COMMAND_VERSION`,
`FIRST_TREE_WEB_DIST_PATH` already had no `_HUB_` infix and are unchanged.

## Config / data directory

Your existing data still lives under `~/.first-tree/hub/` after upgrading. The
CLI runs a one-shot home migration on first launch if it detects an older
layout. The migration is idempotent and never throws — a `~/.first-tree/hub/`
that already matches the expected layout is a no-op.

## Backwards-compatible shim

`@agent-team-foundation/first-tree-hub@0.15.0` (the last published version of
the legacy package) prints:

```
This package has been renamed to 'first-tree'.

Install: npm i -g first-tree
Migration guide: https://github.com/agent-team-foundation/first-tree/blob/main/docs/migration/from-first-tree-hub.md

(This shim does NOT forward commands.)
```

…and exits 1. There is no automatic re-routing — users must explicitly install
the new package. This is intentional: a silent shim hides the migration from
your CI logs and ops dashboards.

## Going further

For the legacy `first-tree@0.4.x` users (the Context Tree / GitHub Scan CLI
released from the old `first-tree` repo), see
[from-first-tree-v0.md](from-first-tree-v0.md).
