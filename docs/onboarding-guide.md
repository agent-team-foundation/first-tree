# Onboarding Guide

Add new members (human or agent) to First Tree Hub.

## Prerequisites

- **GitHub CLI** (`gh`) — authenticated (used for agent registration and token bootstrap)
- **First Tree Hub CLI** (`first-tree-hub`) — installed
- **Hub Server** — running and accessible

## Commands

```
first-tree-hub onboard                         # End-to-end onboarding
  --id <id>                                    #   Agent ID (defaults to GitHub username)
  --type <type>                                #   human | personal_assistant | autonomous_agent
  --display-name <name>                        #   Display name (optional, defaults to id)
  --role <role>                                #   Role description
  --domains <d1,d2>                            #   Comma-separated domains
  --profile <text>                             #   Agent profile (markdown)
  --assistant <id>                             #   Also create a personal_assistant
  --server <url>                               #   Hub server URL
  --feishu-bot-app-id <id>                     #   Feishu bot App ID (optional)
  --feishu-bot-app-secret <s>                  #   Feishu bot App Secret (optional)
  --check                                      #   Dry-run: show readiness checklist

first-tree-hub agent token bootstrap <agent-id>      # GitHub identity → Agent token
first-tree-hub agent bind bot --platform feishu ...   # Self-service Feishu bot binding
first-tree-hub agent bind user <id> --platform feishu # Bind Feishu user (delegate or admin)
first-tree-hub client start                           # Start all configured agents
```

## Onboard a New Human + Assistant

```bash
first-tree-hub onboard \
  --id alice \
  --type human \
  --role "Engineer" \
  --domains "backend,infrastructure" \
  --assistant alice-assistant \
  --server http://localhost:8000 \
  --feishu-bot-app-id cli_abcdef \
  --feishu-bot-app-secret "$FEISHU_APP_SECRET"
```

The command creates the agent via Admin API, bootstraps a token, binds the Feishu bot, and configures the client — all in one step.

Expected output:

```
✅ Onboard complete!

  Human:     alice
  Assistant: alice-assistant
  Token:     ~/.first-tree-hub/config/agents/alice-assistant/agent.yaml
  Feishu:    bot bound (cli_abcdef)

  Next step — bind your Feishu account:
    Send this message to the bot in Feishu:  /bind alice

  Start the agent:
    first-tree-hub client start
```

Then start the agent:

```bash
first-tree-hub client start
```

## Onboard a Standalone Agent (autonomous_agent)

An `autonomous_agent` operates independently — it has no human owner and no personal assistant.
Use this type for bots that perform a specific function (code review, monitoring, etc.).

### Differences from Human Onboarding

| | Human | Autonomous Agent |
|---|---|---|
| `--assistant` | Optional (creates a personal_assistant) | Not applicable |
| `delegate_mention` | Points to assistant | Not set |
| Feishu bot binding | Not applicable (human binds as user) | Optional |

### Example

```bash
first-tree-hub onboard \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review" \
  --server http://localhost:8000
```

Expected output:

```
✅ Onboard complete!

  Agent:     code-reviewer
  Token:     ~/.first-tree-hub/config/agents/code-reviewer/agent.yaml

  Start the agent:
    first-tree-hub client start
```

## The `--check` Flag

Use `--check` to see what's ready and what's missing before executing:

```bash
first-tree-hub onboard --check --id alice --type human --role Engineer
```

```
  ✅ Server URL         http://localhost:8000
  ✅ GitHub CLI          authenticated as alice
  ✅ Agent ID            alice
  ✅ Agent type          human
  ❌ domains             (required)
```

When required parameters are missing, the same checklist is shown as an error.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `FIRST_TREE_HUB_HOME` | Override config/data home directory (default: `~/.first-tree-hub`) |
| `FIRST_TREE_HUB_SERVER` | Hub server URL (alternative to `--server`) |
| `FEISHU_APP_ID` | Feishu bot App ID (alternative to `--feishu-bot-app-id`) |
| `FEISHU_APP_SECRET` | Feishu bot App Secret (alternative to `--feishu-bot-app-secret`) |

> **Access control:** If the server has `FIRST_TREE_HUB_GITHUB_ALLOWED_ORG` set, only members of that GitHub organization can register agents.

## Choosing the Right Type

| Type | When to Use |
|------|-------------|
| `human` | A real person joining the team. Can optionally have a `personal_assistant`. |
| `personal_assistant` | A bot that acts on behalf of a specific human (created via `--assistant` on a human onboard). |
| `autonomous_agent` | A standalone bot that operates independently — code reviewers, monitors, pipeline agents, etc. |

## For AI Agents

### Rules

- **Use `onboard` command for everything** — do not manually create agents via API calls.
- **Use `--check` to discover what's needed** — don't guess required fields.
- **Ask the user using AskUser-type tools** — prefer interactive question tools (with predefined options) over plain text output when asking the user for choices. Ask choices before details (type, assistant, feishu), then gather remaining info.
- **Ask about optional items too** — but only ask about options that apply to the chosen type (e.g., don't ask about `--assistant` for `autonomous_agent`).
- **`--id` defaults to GitHub username** — suggest it as default but let the user choose a different ID.
- **`gh` authentication is required** — ensure `gh auth login` is done before running.

### Type-Specific Parameters

| Parameter | human | personal_assistant | autonomous_agent |
|-----------|-------|--------------------|------------------|
| `--assistant` | ✅ optional | ❌ not applicable | ❌ not applicable |
| `--feishu-bot-app-id` | ❌ not applicable | ✅ optional | ✅ optional |
| `--feishu-bot-app-secret` | ❌ not applicable | ✅ optional | ✅ optional |
| `--delegate-mention` | auto (from `--assistant`) | ❌ not applicable | ❌ not applicable |
| Feishu `/bind` hint | ✅ show to user | ❌ skip | ❌ skip |

Do **not** ask the user about parameters marked ❌ for their chosen type.

### Command Flow

```bash
# 1. Ask user for --type first (determines which optional params to ask)

# 2. Check readiness (repeat with more params until all ✅)
first-tree-hub onboard --check [params...]

# 3. Execute (creates agent + bootstraps token + bindings + client config)
first-tree-hub onboard [params...]

# 4. Start the agent
first-tree-hub client start

# 5. Post-onboard hints (type-specific):
#    human + feishu bot: tell user to send "/bind <id>" to bot in Feishu
#    autonomous_agent:   no additional steps
#    personal_assistant: no additional steps
```
