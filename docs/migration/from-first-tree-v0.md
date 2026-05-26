# Migrating from `first-tree@0.4.x` to `first-tree@1.0.0`

If you were using the Context Tree / GitHub Scan CLI published as `first-tree`
on npm during the v0.4.x cycle, this is a same-name major version bump. The npm
package name does not change — what changes is the command surface, because
v1.0.0 ships a much wider top-level command set covering identity, messaging,
and collaboration alongside the existing `tree` and `github scan` namespaces.

## TL;DR

```bash
npm install -g first-tree@1.0.0
first-tree tree --help        # unchanged — Context Tree commands
first-tree github scan --help # unchanged — GitHub Scan daemon
first-tree --help             # shows the new top-level: login/logout/agent/chat/...
```

If you only used `first-tree tree` and `first-tree github scan`, your daily
flow is unchanged. The new top-level commands (`login`, `logout`, `agent`,
`chat`, `org`, `daemon`, `config`, `status`, `doctor`, `upgrade`) cover the
collaboration surface — see [onboarding-guide.md](../onboarding-guide.md)
and [cli-reference.md](../cli-reference.md) for the full command tree.

## Command renames inside `tree`

Phase 1B retired four legacy `tree` subcommand names. If your scripts reference
them, update:

| Old | New |
|---|---|
| `first-tree tree generate-codeowners` | `first-tree tree codeowners` |
| `first-tree tree install-claude-code-hook` | `first-tree tree claude-hook` |
| `first-tree tree inject-context` | `first-tree tree inject` |

The `hub` namespace under `tree` that some 0.4.x prereleases shipped has been
removed entirely. Functionality moved to the new top-level commands described
above.

## `first-tree github scan` is unchanged

GitHub Scan subcommands (`install`, `start`, `stop`, `status`, `poll`, `watch`,
`doctor`) are identical to v0.4.x.

## What's new in v1.0.0

* Single CLI binary covers Context Tree, GitHub Scan, and agent collaboration.
* Short alias `ft` for the binary (e.g. `ft tree status`).
* New top-level commands: `login`, `logout`, `agent`, `chat`, `org`, `daemon`,
  `config`, `status`, `doctor`, `upgrade`.
