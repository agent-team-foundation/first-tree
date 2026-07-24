---
id: legacy-github-scan-launchd-retirement
description: Validate that the CLI automatically retires a stranded legacy github-scan launchd runner at its startup boundary, idempotently and without polluting command output.
areas: [cross-surface]
surfaces: [cli]
---

# Legacy GitHub-Scan Launchd Retirement

## Goal

Confirm on macOS that a stranded legacy `github-scan` launchd runner (label
`com.first-tree.github-scan.runner.*`, plist under
`~/.first-tree/github-scan/runner/launchd/`) is booted out and its plist
removed by the CLI's automatic startup boundary — the root preAction sweep
that fires on the first real command of a process, including the `daemon
start` the service wrapper execs — with no manual `launchctl` surgery, no
effect on command output (`--json` included), and safe repeated runs.

This is boot/health-path behavior: deterministic coverage lives in the CLI
package's Vitest suites; this case validates the real launchd interaction
those tests mock.

## Preconditions

- macOS host with an interactive GUI login session (launchd `gui/<uid>`
  domain available); no real legacy github-scan install present.
- A build of the CLI under test on `PATH`, plus a throwaway
  `FIRST_TREE_HOME`-independent prod home: the sweep always targets
  `~/.first-tree`, so run as a disposable macOS user if the operator's own
  `~/.first-tree` must stay untouched.
- Do not run against a machine whose `~/.first-tree/github-scan/` holds data
  the operator wants preserved (the sweep leaves config/logs alone by design,
  but the case fakes plists in the runner directory).

## Operate

1. Fake a stranded runner: write
   `~/.first-tree/github-scan/runner/launchd/com.first-tree.github-scan.runner.<user>.default.plist`
   with a legacy-shaped body (`KeepAlive: true`, `ProgramArguments` pointing
   at a harmless long-running command such as `sleep 600`), then
   `launchctl bootstrap gui/$(id -u) <plist>` so the label is really loaded.
2. Run any ordinary CLI command (for example `status`). Then run
   `daemon doctor` and a `--json` command.
3. Re-run the same command twice more (idempotency), once immediately and once
   after deleting `~/.first-tree/state/legacy-github-scan-launchd.json` if it
   exists.
4. Add an unrelated plist (label outside the legacy prefix) to the same
   directory and repeat step 2.

## Observe

- After step 2: `launchctl print gui/$(id -u)/<label>` reports the label gone,
  the plist file is removed, and the empty `launchd/` directory is pruned.
  The command's stdout/stderr is byte-identical to a run on a clean machine
  (no sweep output; `--json` stays parseable).
- `daemon doctor` shows the `Legacy github-scan` line: failing with the manual
  `launchctl bootout` hint while residue exists, ok once clean.
- Step 3 produces no further launchctl activity or output changes.
- Step 4: the unrelated plist survives untouched, the sweep does not boot its
  label out, and `daemon doctor` reports it as an unrelated plist left
  untouched while the cooldown stamp under `~/.first-tree/state/` suppresses
  per-command retries.

## Cleanup

Remove any leftover fake plists, `launchctl bootout gui/$(id -u)/<label>` any
label the case bootstrapped, and delete the cooldown stamp.
