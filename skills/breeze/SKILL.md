---
name: breeze
description: Operate the `first-tree breeze` CLI — a proposal/inbox agent that turns explicit GitHub mentions and review requests into a live Claude Code statusline, a browsable inbox, an activity feed, and scheduled background work. Use whenever you need to run, start, stop, inspect, poll, or debug the breeze daemon; view or respond to GitHub-triggered breeze work from the terminal; or wire up the breeze statusline hook.
---

# Breeze — Operational Skill

This skill is the operational handbook for the `breeze` product. If you have
not yet loaded the `first-tree` entry-point skill, load that first — it
explains the toolkit layout and how the four skills relate. This skill
covers *how* to drive the `first-tree breeze` CLI.

## When To Use This Skill

Load this skill when the task involves any of:

- Running or inspecting the breeze daemon
- Viewing the GitHub notification inbox or the live activity feed
- Triggering a one-off notification poll
- Configuring, starting, or stopping the background daemon (launchd on macOS)
- Installing the breeze statusline hook into Claude Code
- Diagnosing a broken breeze install or a stuck claim

Breeze is designed for agents, not humans — most commands are idempotent
and safe to re-run.

## Core Concepts

- **Inbox** — the local store of explicit GitHub mentions and review requests, under `~/.breeze/`.
- **Daemon** — a long-running broker process that polls GitHub, keeps the
  inbox fresh, dispatches work to per-task agent runners, and serves a
  local HTTP/SSE endpoint on `127.0.0.1:7878` for the dashboard.
- **Runner** — a per-task worker spawned by the daemon for a single claim.
- **Claim** — exclusive lease on a notification so only one runner acts on it.
- **Statusline** — a sub-30 ms Claude Code statusline hook that prints a
  one-line summary of the inbox state.

## CLI Commands

### Primary (start here)

| Command | Purpose |
|---|---|
| `first-tree breeze install --allow-repo owner/repo` | First-run setup — checks `gh`/`jq`/`gh auth`, creates `~/.breeze/config.yaml` with defaults, and starts the daemon. The repo scope is required so breeze never falls back to scanning the whole account. (Wiring the Claude Code statusline is a separate manual step — see the Statusline section.) |
| `first-tree breeze start --allow-repo owner/repo` | Launch the daemon in the background (launchd on macOS, detached spawn elsewhere) |
| `first-tree breeze stop` | Stop the daemon and remove its lock |
| `first-tree breeze status` | Print the daemon lock + runtime/status.env |
| `first-tree breeze doctor` | One-screen diagnostic of the local install |
| `first-tree breeze watch` | Live TUI: status board + activity feed |
| `first-tree breeze poll` | Poll explicit GitHub mentions and review requests once (no daemon required) |

### Advanced (agents, debugging)

These are the daemon's foreground entrypoints and manual-cleanup helpers.
Humans normally only need the primary set above; reach for these when
debugging the pipeline or when `doctor` directs you to.

| Command | Purpose |
|---|---|
| `first-tree breeze run --allow-repo owner/repo` / `first-tree breeze daemon --allow-repo owner/repo` | Run the broker loop in the foreground. `start` is preferred for humans; `daemon` is invoked by launchd. |
| `first-tree breeze run-once --allow-repo owner/repo` | Run one poll cycle, wait for drain, then exit. Useful for debugging the daemon pipeline. |
| `first-tree breeze cleanup` | Remove stale workspaces and expired claims. Only run if `doctor` suggests it. |

### Hook / internal entry points (do not invoke directly)

These exist for compatibility or to be called *by other code*. Never
invoke them manually from a shell or from an agent action — they are
listed here only so you recognize what they are when you encounter them
in `ps`, config files, or log lines.

| Command | Why it exists |
|---|---|
| `first-tree breeze statusline` | Claude Code statusline hook. Claude Code should be pointed at the pre-bundled `dist/breeze-statusline.js` directly for sub-30 ms cold start (see the Statusline section below). The CLI shim exists for parity. |
| `first-tree breeze status-manager` | Internal helper used by the breeze runner to manage per-session status entries. Runners call it programmatically; no direct human or agent use. |
| `first-tree breeze poll-inbox` | Legacy alias for `poll`. Kept so existing scripts keep working; new callers should use `poll`. |

For full options on any command, run `first-tree breeze <command> --help`.

Any command that starts the daemon now requires an explicit `--allow-repo`
scope. Use exact repos (`owner/repo`) and/or owner globs (`owner/*`).

## Recommended Invocation

```bash
npx -p first-tree first-tree breeze <command>
```

This always runs the latest published version.

For the statusline hook (called many times per Claude Code session), use the
pre-bundled minimal entry point for sub-30 ms cold starts:

```bash
node /path/to/first-tree/dist/breeze-statusline.js
```

`first-tree breeze install` does **not** wire this up into Claude Code for
you. Configure the statusline hook manually after install if you want the
live inbox summary in your session UI.

## Environment

- `BREEZE_DIR` — override the default store root (`~/.breeze/`)
- `BREEZE_HOME` — override the default daemon private state dir
  (`~/.breeze/runner/`)

## Typical Flows

**First-time setup on a fresh machine:**

```bash
npx -p first-tree first-tree breeze install --allow-repo owner/repo
npx -p first-tree first-tree breeze start --allow-repo owner/repo
npx -p first-tree first-tree breeze status
```

If the daemon did not come up during install, run:

```bash
npx -p first-tree first-tree breeze start --allow-repo owner/repo
```

**Something looks wrong:**

```bash
npx -p first-tree first-tree breeze doctor
npx -p first-tree first-tree breeze status
npx -p first-tree first-tree breeze cleanup   # only if doctor suggests it
```

**Peek at activity without starting a daemon:**

```bash
npx -p first-tree first-tree breeze poll
npx -p first-tree first-tree breeze watch
```

## Related Skills

- `first-tree` — entry-point skill: methodology, references, routing. Load
  this first.
- `tree` — load if the task involves the Context Tree repo itself.
- `gardener` — load if the task involves automated responses to sync PR
  feedback on tree repos.
