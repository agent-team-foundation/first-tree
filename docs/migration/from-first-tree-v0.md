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

On macOS, a pre-retirement install may have left the background runner behind
as a launchd job (label `com.first-tree.github-scan.runner.<user>.<profile>`)
that crash-loops once the old entrypoint is gone and keeps re-binding its
legacy port 7878. Current CLI versions retire it automatically — on `npm`
upgrade and on the first run of any command, the stranded job is booted out
and its plist under `~/.first-tree/github-scan/runner/launchd/` removed —
and `first-tree daemon doctor` reports any residue it can still see. To clean
up by hand instead, boot out and remove each retired-namespace plist
individually — a machine can hold one plist per profile, and a plist must
only be deleted after its own job is confirmed gone, otherwise a still-loaded
job is stranded with no retry artifact:

```bash
uid="$(id -u)"
find ~/.first-tree/github-scan/runner/launchd -maxdepth 1 \
  -name 'com.first-tree.github-scan.runner.*.plist' 2>/dev/null |
while IFS= read -r plist; do
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  # Delete the plist only once launchd no longer knows the job.
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 || rm -- "$plist"
done
rmdir ~/.first-tree/github-scan/runner/launchd 2>/dev/null || true
```

Files outside that label namespace are left alone, and `rmdir` removes the
directory only once it is empty — the same guarantees the automatic sweep
gives. Legacy configuration and logs under `~/.first-tree/github-scan/` are
left in place either way; delete them yourself if you no longer want them.

## What's new in v1.0.0

* Single CLI binary covers Context Tree and agent collaboration.
* Short alias `ft` for the binary (e.g. `ft tree verify --tree-path <path>`).
* New top-level commands: `login`, `logout`, `agent`, `chat`, `org`, `daemon`,
  `config`, `status`, `doctor`, `upgrade`.
