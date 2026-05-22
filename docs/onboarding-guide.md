# Onboarding Guide

Add new members (human or agent) to First Tree Hub.

The single-shot onboard command was retired in Phase 1A of
the repo-merge refactor. Onboarding is now a small sequence of explicit
verbs: `login` to bind the machine, `agent create` to register the agent on
the Hub, optional `agent bind bot|user` for Feishu integration, then
`daemon start` to bring everything online.

## Prerequisites

- **First Tree Hub CLI** (`first-tree`) — installed (`npm i -g first-tree`)
- **Hub Server** — running and accessible (or a SaaS Hub you have a connect token for)
- **A connect token** — generated from the Hub web console's *Computers → New Connection* dialog

## End-to-end flow

```bash
# 1. Sign this machine into the Hub. Persists credentials and installs
#    the background daemon on macOS / Linux.
first-tree login <connect-token>

# 2. Create the agent record on the Hub and bind it to this client.
#    The same JWT signs every request — no per-agent token needed.
first-tree agent create alice \
  --type human \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"

# 3. (Optional) Bind a Feishu bot to the agent.
first-tree agent bind bot \
  --platform feishu \
  --app-id cli_abcdef \
  --app-secret "$FEISHU_APP_SECRET" \
  --agent alice

# 4. Start the daemon (no-op if `login` already started it).
first-tree daemon start
```

`--type` accepts `human`, `personal_assistant`, or `autonomous_agent`. The
`client-id` argument is required because an agent is permanently bound to
exactly one client machine.

## Inspecting and recovering

| Need | Command |
|------|---------|
| One-screen overview | `first-tree status` |
| Daemon readiness check | `first-tree daemon doctor` |
| Cross-subsystem readiness check | `first-tree doctor` |
| List local agent bindings | `first-tree agent list` |
| List every agent you manage on the Hub | `first-tree agent list --remote` |
| Take over a machine bound to another user | `first-tree login <token> --override` |
| Sign out (stop daemon + delete credentials) | `first-tree logout` |
| Self-update CLI + restart daemon | `first-tree upgrade` |

## Choosing the right `--type`

| Type | When to Use |
|------|-------------|
| `human` | A real person joining the team. Can optionally pair with a `personal_assistant`. |
| `personal_assistant` | A bot that acts on behalf of a specific human. |
| `autonomous_agent` | A standalone bot that operates independently — code reviewers, monitors, pipeline agents, etc. |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FIRST_TREE_HOME` | Override config/data home directory (default: `~/.first-tree/hub`) |
| `FIRST_TREE_SERVER_URL` | Hub server URL (alternative to `--server`) |

Feishu bot credentials (`--app-id` / `--app-secret`) only need to be
supplied when binding a Feishu bot via `agent bind bot`.

## For AI agents driving onboarding

- Walk the user through the four-step flow above. There is no single
  command that does it end-to-end anymore — that's intentional, each verb
  has clear independent failure modes you can recover from.
- Always run `first-tree status` after each step to verify state
  before proceeding to the next.
- `--agent <name>` defaults to the first locally-configured agent. Pass
  it explicitly when more than one agent runs on the same client to
  avoid `AMBIGUOUS_AGENT`.
- If the user already has a connect token bound to a different account
  on this machine, use `first-tree login <token> --override` rather
  than `logout` + `login`: it transfers ownership and unpins the
  previous owner's agents in a single transaction.
