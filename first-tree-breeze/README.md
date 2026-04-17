# breeze

GitHub notifications inside Claude Code. See what needs your attention in the statusline, browse your inbox grouped by project, get AI-powered summaries and suggested actions, and respond without leaving your terminal.

```
/breeze: 52 PRs · 3 issues · 1 discussions (+2 new)
```

## What it does

1. **Polls GitHub** every 60 seconds for all your notifications (PRs, issues, discussions, review requests, mentions)
2. **Shows a summary** in your Claude Code statusline with a terminal bell on new items
3. **Type `/breeze`** to see your inbox grouped by project with clickable GitHub links
4. **Pick a notification** and the agent summarizes the context, suggests an action with a confidence level
5. **Act on it** in natural language ("approve this PR", "mark for human review", "this is handled")

breeze uses **GitHub labels** to track notification status. The source of truth lives on GitHub, not your laptop. This means the state is visible to your team, visible on github.com, and survives if you reinstall breeze.

## Install

```bash
git clone https://github.com/agent-team-foundation/breeze.git
cd breeze
./setup
```

The setup script:
- Creates `~/.breeze/` for local cache (inbox.json, activity log, claim locks)
- Symlinks the `/breeze`, `/breeze-watch`, `/breeze-upgrade` skills into `~/.claude/skills/`
- Starts the unified TypeScript daemon via `first-tree breeze start`. It refreshes `inbox.json` every 60s, dispatches agents on actionable items, and serves a live dashboard on `http://127.0.0.1:7878`

### Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated with `repo` scope
- [jq](https://jqlang.github.io/jq/) installed
- `first-tree` CLI installed globally (`npm i -g first-tree`)
- Claude Code

## Commands

- **`/breeze`** — open the inbox dashboard, pick a notification, act on it
- **`/breeze-watch`** — live activity log with clickable GitHub links, in a new terminal window
- **`/breeze-upgrade`** — pull the latest code (no restart needed)
- **`http://127.0.0.1:7878`** — live web dashboard served by the daemon

## Usage

In Claude Code, type `/breeze` to open your inbox grouped by project.

```
/breeze inbox — 15 new · 3 wip · 5 human · 50 done

### paperclip (10)
  1. [PR] feat: add OAuth support (review_requested)
     https://github.com/paperclipai/paperclip/pull/305
  2. [Issue] bug: broken login on mobile (mention)
     https://github.com/paperclipai/paperclip/issues/3700

### paperclip-tree (3)
  1. [PR] sync: add MCP server (author)
     https://github.com/serenakeyitan/paperclip-tree/pull/266
```

Pick a number. The agent loads the full context (PR diff, comment thread, issue body), summarizes it, and suggests an action. Tell it what to do in plain English.

## Notification Status

breeze tracks status using **GitHub labels** on the PR/issue/discussion:

| Label | Status | Meaning | Shows in statusline? |
|-------|--------|---------|---------------------|
| *(none)* | **new** | Needs action, no one's on it | Yes |
| `breeze:wip` | **wip** | Agent or human is actively working | No |
| `breeze:human` | **human** | Escalated to human judgment | No |
| `breeze:done` | **done** | Handled, no more action needed | No |

Additionally, PRs that are **merged** or **closed** on GitHub are treated as `done` automatically (no label needed).

The statusline only counts **new** notifications. The number is stable across terminals because state lives on GitHub — same labels, same count, every machine.

### Status commands

- `"resolve #3"` or `"mark #3 done"` — applies `breeze:done` label
- `"I'll handle this"` or `"escalate to human"` — applies `breeze:human` label
- `"working on it"` — applies `breeze:wip` label (agent lock)
- `"show wip"` or `"show done"` — filter by status

### Agent claim locks

When an agent starts working on a notification, it claims it with an atomic filesystem lock at `~/.breeze/claims/<id>/`. Other agents see the claim and skip it. Claims auto-expire after 5 minutes if the agent crashes.

## Config

Edit `~/.breeze/config.yaml`:

```yaml
repos:
  - all                    # or list specific repos: owner/repo1, owner/repo2
poll_interval: 60          # seconds between polls
footer: true               # append "sent via breeze" to comments
```

## How it works

```
GitHub API  →  Poller (launchd)  →  ~/.breeze/inbox.json  →  Statusline
     ↑                                     ↓
     │                              /breeze skill (dashboard + actions)
     │                                     ↓
     │                          claims/<id>/ (agent locks)
     │                                     ↓
     └──────────  gh label   ←──── apply breeze:{wip,human,done}
```

State lives on GitHub via labels. The local inbox.json is just a cache of what GitHub sent us plus the current label-derived status.

## Vision

GitHub goes agent-first.

Your agent talks to their agent. They handle the PRs, the comments, the issues, the discussions. They negotiate reviews, close dupes, push stuff through CI, ping you when it matters.

Agents handle 99%. Humans see 1%.

That 1% is the part that needs you — real decisions, real judgment. Everything else was never your job, you just got stuck doing it.

breeze is how we get there. See [DESIGN.md](DESIGN.md) for the architecture.

## License

MIT
