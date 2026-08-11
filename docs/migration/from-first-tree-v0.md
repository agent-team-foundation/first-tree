# Migrating from `first-tree@0.4.x` to `first-tree@1.0.0`

If you were using the Context Tree CLI published as `first-tree`
on npm during the v0.4.x cycle, this is a same-name major version bump. The npm
package name does not change — what changes is the command surface, because
v1.0.0 ships a much wider top-level command set covering identity, messaging,
and collaboration alongside the existing `tree` namespace.

## TL;DR

```bash
npm install -g first-tree@1.0.0
first-tree tree --help        # unchanged — Context Tree commands
first-tree --help             # shows the new top-level: login/logout/agent/chat/...
```

If you only used `first-tree tree`, your daily flow is unchanged. The new
top-level commands (`login`, `logout`, `agent`, `chat`, `org`, `daemon`,
`config`, `status`, `doctor`, `upgrade`) cover the collaboration surface —
see [onboarding-guide.md](../onboarding-guide.md) and
[cli-reference.md](../cli-reference.md) for the full command tree.

## `first-tree tree` namespace was retired in 2026-06

The `tree` subcommands (`init` / `migrate-to-w1` / `upgrade` / `status` /
`codeowners` / `claude-hook` / `inject` / `review` / `automation` /
`skill` groups) were deleted after PR #844. The cloud now owns workspace
+ tree provisioning, the client runtime inlines its own skill payload
install, and the deleted commands had no remaining caller. The only
surviving subcommand is `first-tree tree verify`, which still validates a
Context Tree's structure (used by tree-side CI and by humans inspecting a
tree by hand).

If your scripts call any of the deleted commands, replace them with:

- Workspace + tree provisioning → web console (operator action).
- Skill payload install → handled automatically by the client runtime at
  agent-session bootstrap. No CLI step required.
- Tree structure validation → `first-tree tree verify --tree-path PATH`.

## `first-tree github scan` was retired after v1.0

GitHub Scan is no longer part of the current CLI.

If a pre-retirement github-scan launchd runner is still installed on your
Mac, no manual `launchctl` surgery is needed: on the first run of a current
CLI version, the legacy `com.first-tree.github-scan.runner.*` service is
booted out of launchd and its plist directory under
`~/.first-tree/github-scan/runner/launchd/` is removed (only runner files
under this default path are removed; runners installed with a custom
`GITHUB_SCAN_DIR` / `GITHUB_SCAN_HOME` are booted out by label). This ends
the KeepAlive crash-loop and releases the legacy default port 7878.

## What's new in v1.0.0

* Single CLI binary covers Context Tree and agent collaboration.
* Short alias `ft` for the binary (e.g. `ft tree verify --tree-path <path>`).
* New top-level commands: `login`, `logout`, `agent`, `chat`, `org`, `daemon`,
  `config`, `status`, `doctor`, `upgrade`.
