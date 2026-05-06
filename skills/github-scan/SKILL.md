---
name: github-scan
version: 0.3.0
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Operate the `first-tree github scan` CLI — the GitHub notification daemon and inbox runtime. Use whenever you need to run, start, stop, inspect, poll, or debug github-scan; view or respond to GitHub-triggered work from the terminal; or wire up the github-scan statusline hook.
---

# GitHub Scan — Operational Skill

This skill is the operational handbook for the `github-scan` product. If you
have not yet loaded the `first-tree` entry-point skill, load that first — it
explains the toolkit layout and the current canonical First Tree skill set.
This skill covers _how_ to drive the `first-tree github scan` CLI.

## When To Use This Skill

Load this skill when the task involves any of:

- Running or inspecting the github-scan daemon
- Viewing the GitHub notification inbox or the live activity feed
- Triggering a one-off notification poll
- Configuring, starting, or stopping the background daemon (launchd on macOS)
- Installing the github-scan statusline hook into Claude Code
- Diagnosing a broken github-scan install or a stuck claim

GitHub Scan is designed for agents, not humans — most commands are idempotent
and safe to re-run.

## Core Concepts

- **Inbox** — the local store of explicit GitHub mentions and review requests, under `~/.first-tree/github-scan/`.
- **Daemon** — a long-running broker process that polls GitHub, keeps the
  inbox fresh, dispatches work to per-task agent runners, and serves a
  local HTTP/SSE endpoint on `127.0.0.1:7879` for the dashboard.
- **Runner** — a per-task worker spawned by the daemon for a single claim.
- **Claim** — exclusive lease on a notification so only one runner acts on it.
- **Statusline** — a sub-30 ms Claude Code statusline hook that prints a
  one-line summary of the inbox state.

## CLI Commands

### Primary (start here)

| Command                                                  | Purpose                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-tree github scan install --allow-repo owner/repo` | First-run setup — checks `gh`/`jq`/`gh auth`, creates `~/.first-tree/github-scan/config.yaml` with defaults, and starts the daemon. The repo scope is required so github-scan never falls back to scanning the whole account. (Wiring the Claude Code statusline is a separate manual step — see the Statusline section.) |
| `first-tree github scan start --allow-repo owner/repo`   | Launch the daemon in the background (launchd on macOS, detached spawn elsewhere)                                                                                                                                                                                                                                          |
| `first-tree github scan stop`                            | Stop the daemon and remove its lock                                                                                                                                                                                                                                                                                       |
| `first-tree github scan status`                          | Print the daemon lock + runtime/status.env                                                                                                                                                                                                                                                                                |
| `first-tree github scan doctor`                          | One-screen diagnostic of the local install                                                                                                                                                                                                                                                                                |
| `first-tree github scan watch`                           | Live TUI: status board + activity feed                                                                                                                                                                                                                                                                                    |
| `first-tree github scan poll`                            | Poll explicit GitHub mentions and review requests once (no daemon required)                                                                                                                                                                                                                                               |

### Advanced (agents, debugging)

These are the daemon's foreground entrypoints and manual-cleanup helpers.
Humans normally only need the primary set above; reach for these when
debugging the pipeline or when `doctor` directs you to.

| Command                                                                                                        | Purpose                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `first-tree github scan run --allow-repo owner/repo` / `first-tree github scan daemon --allow-repo owner/repo` | Run the broker loop in the foreground. `start` is preferred for humans; `daemon` is invoked by launchd. |
| `first-tree github scan run-once --allow-repo owner/repo`                                                      | Run one poll cycle, wait for drain, then exit. Useful for debugging the daemon pipeline.                |
| `first-tree github scan cleanup`                                                                               | Remove stale workspaces and expired claims. Only run if `doctor` suggests it.                           |

### Hook / internal entry points (do not invoke directly)

These exist for compatibility or to be called _by other code_. Never
invoke them manually from a shell or from an agent action — they are
listed here only so you recognize what they are when you encounter them
in `ps`, config files, or log lines.

| Command                                 | Why it exists                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-tree github scan statusline`     | Claude Code statusline hook. Claude Code should be pointed at the pre-bundled `dist/github-scan-statusline.js` directly for sub-30 ms cold start (see the Statusline section below). The CLI shim exists for parity. |
| `first-tree github scan status-manager` | Internal helper used by the github-scan runner to manage per-session status entries. Runners call it programmatically; no direct human or agent use.                                                                 |
| `first-tree github scan poll-inbox`     | Legacy alias for `poll`. Kept so existing scripts keep working; new callers should use `poll`.                                                                                                                       |

For full options on any command, run `first-tree github scan <command> --help`.

Any command that starts the daemon now requires an explicit `--allow-repo`
scope. Use exact repos (`owner/repo`) and/or owner globs (`owner/*`).

## Recommended Invocation

```bash
npx -p first-tree first-tree github scan <command>
```

This always runs the latest published version.

For the statusline hook (called many times per Claude Code session), use the
pre-bundled minimal entry point for sub-30 ms cold starts:

```bash
node /path/to/first-tree/dist/github-scan-statusline.js
```

`first-tree github scan install` does **not** wire this up into Claude Code for
you. Configure the statusline hook manually after install if you want the
live inbox summary in your session UI.

## Environment

- `GITHUB_SCAN_DIR` — override the default store root (`~/.first-tree/github-scan/`)
- `GITHUB_SCAN_HOME` — override the default daemon private state dir
  (`~/.first-tree/github-scan/runner/`)

## Typical Flows

**First-time setup on a fresh machine:**

```bash
npx -p first-tree first-tree github scan install --allow-repo owner/repo
npx -p first-tree first-tree github scan start --allow-repo owner/repo
npx -p first-tree first-tree github scan status
```

If the daemon did not come up during install, run:

```bash
npx -p first-tree first-tree github scan start --allow-repo owner/repo
```

**Something looks wrong:**

```bash
npx -p first-tree first-tree github scan doctor
npx -p first-tree first-tree github scan status
npx -p first-tree first-tree github scan cleanup   # only if doctor suggests it
```

**Peek at activity without starting a daemon:**

```bash
npx -p first-tree first-tree github scan poll
npx -p first-tree first-tree github scan watch
```

## Related Skills

- `first-tree` — entry-point skill: methodology, references, routing. Load
  this first.
- `first-tree-onboarding` — load if the task is first-time setup, repo
  binding, or daemon enablement.
- `first-tree-sync` / `first-tree-write` — load if a notification or daemon
  diagnosis turns into tree-maintenance work.
