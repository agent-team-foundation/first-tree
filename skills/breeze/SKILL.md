---
name: breeze
description: Operate the `first-tree breeze` CLI — a proposal/inbox agent that turns GitHub notifications into a live Claude Code statusline, a browsable inbox, an activity feed, and scheduled background work. Use whenever you need to run, start, stop, inspect, poll, or debug the breeze daemon; view or respond to GitHub notifications from the terminal; or wire up the breeze statusline hook.
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

- **Inbox** — the local store of GitHub notifications, under `~/.breeze/`.
- **Daemon** — a long-running broker process that polls GitHub, keeps the
  inbox fresh, dispatches work to per-task agent runners, and serves a
  local HTTP/SSE endpoint on `127.0.0.1:7878` for the dashboard.
- **Runner** — a per-task worker spawned by the daemon for a single claim.
- **Claim** — exclusive lease on a notification so only one runner acts on it.
- **Statusline** — a sub-30 ms Claude Code statusline hook that prints a
  one-line summary of the inbox state.

## CLI Commands

### Foreground daemon

| Command | Purpose |
|---|---|
| `first-tree breeze run` (alias `daemon`) | Run the broker loop forever in the foreground |
| `first-tree breeze run-once` | Run one poll cycle, wait for drain, then exit |

### Background lifecycle

| Command | Purpose |
|---|---|
| `first-tree breeze start` | Launch the daemon in the background (via launchd on macOS) |
| `first-tree breeze stop` | Stop the daemon and remove its lock |

### Diagnostics

| Command | Purpose |
|---|---|
| `first-tree breeze status` | Print the daemon lock + runtime/status.env |
| `first-tree breeze doctor` | One-screen diagnostic of the local install |
| `first-tree breeze cleanup` | Remove stale workspaces and expired claims |

### One-shot commands (no daemon required)

| Command | Purpose |
|---|---|
| `first-tree breeze poll` (alias `poll-inbox`) | Poll GitHub notifications once and update the inbox |
| `first-tree breeze watch` | Live TUI: status board + activity feed |
| `first-tree breeze statusline` | Claude Code statusline hook (single-line output) |
| `first-tree breeze status-manager` | Manage per-session status entries |

### Installer

| Command | Purpose |
|---|---|
| `first-tree breeze install` | Run the breeze setup script (first-run only) |

For full options on any command, run `first-tree breeze <command> --help`.

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

The `first-tree breeze install` command wires this up into the local
Claude Code config.

## Environment

- `BREEZE_DIR` — override the default store root (`~/.breeze/`)
- `BREEZE_HOME` — override the default daemon private state dir
  (`~/.breeze/runner/`)

## Typical Flows

**First-time setup on a fresh machine:**

```bash
npx -p first-tree first-tree breeze install
npx -p first-tree first-tree breeze start
npx -p first-tree first-tree breeze status
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
