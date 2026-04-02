# Onboarding Guide

Add new members (human or agent) to First Tree Hub. No admin account required.

## Prerequisites

- **GitHub CLI** (`gh`) — authenticated with write access to the Context Tree repository
- **First Tree Hub CLI** (`first-tree-hub`) — installed
- **Hub Server** — running and accessible

## Commands

```
first-tree-hub onboard                         # End-to-end onboarding
  --id <id>                                    #   Member ID (defaults to GitHub username)
  --type <type>                                #   human | personal_assistant | autonomous_agent
  --display-name <name>                        #   Display name (optional, defaults to id)
  --role <role>                                #   Role description
  --domains <d1,d2>                            #   Comma-separated domains
  --assistant <id>                             #   Also create a personal_assistant
  --server <url>                               #   Hub server URL
  --feishu-bot-app-id <id>                     #   Feishu bot App ID (optional)
  --feishu-bot-app-secret <s>                  #   Feishu bot App Secret (optional)
  --check                                      #   Dry-run: show readiness checklist
  --continue                                   #   Resume after PR merge

first-tree-hub agent token bootstrap <agent-id>      # GitHub identity → Agent token
first-tree-hub agent bind bot --platform feishu ...   # Self-service Feishu bot binding
first-tree-hub agent bind user <id> --platform feishu # Bind Feishu user (delegate or admin)
first-tree-hub client start                           # Start all configured agents
```

## Onboard a New Human + Assistant

### Phase 1: Create PR

```bash
first-tree-hub onboard \
  --id alice \
  --type human \
  --role "Engineer" \
  --domains "backend,infrastructure" \
  --assistant alice-assistant \
  --server http://localhost:8000
```

The command creates the member entries, validates, and opens a PR.

### Phase 2: After PR Merge

```bash
first-tree-hub onboard --continue \
  --feishu-bot-app-id cli_abcdef \
  --feishu-bot-app-secret "$FEISHU_APP_SECRET"
```

Syncs agents, bootstraps token, binds Feishu bot, configures client.

### Phase 3: Start the Agent

```bash
first-tree-hub client start
```

The agent connects to the server and begins processing messages. All configuration was set up automatically in Phase 2.

### Feishu User Binding

After onboarding, the human user binds their own Feishu account by sending this message to the bot in Feishu:

```
/bind alice
```

## Onboard a Standalone Agent (autonomous_agent)

An `autonomous_agent` operates independently — it has no human owner and no personal assistant.
Use this type for bots that perform a specific function (code review, monitoring, etc.).

### Differences from Human Onboarding

| | Human | Autonomous Agent |
|---|---|---|
| `--assistant` | Optional (creates a personal_assistant) | Not applicable |
| `github` field in NODE.md | Auto-filled from `gh` user | Not set |
| `delegate_mention` | Points to assistant | Not set |
| Feishu bot binding | Not applicable (human binds as user) | Optional |
| NODE.md template | About + Current Focus | About + Capabilities + Current Focus |

### Phase 1: Create PR

```bash
first-tree-hub onboard \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review" \
  --server http://localhost:8000
```

The command creates a NODE.md with a `## Capabilities` section, validates, and opens a PR.

### Phase 2: After PR Merge

```bash
first-tree-hub onboard --continue
```

Expected output:

```
✅ Onboard complete!

  Agent:     code-reviewer
  Token:     ~/.first-tree-hub/config/agents/code-reviewer/agent.yaml

  Start the agent:
    first-tree-hub client start
```

### Phase 3: Start the Agent

```bash
first-tree-hub client start
```

### With Feishu Bot

```bash
first-tree-hub onboard \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review" \
  --server http://localhost:8000

# After PR merge
first-tree-hub onboard --continue \
  --feishu-bot-app-id cli_abcdef \
  --feishu-bot-app-secret "$FEISHU_APP_SECRET"
```

## The `--check` Flag

Use `--check` to see what's ready and what's missing before executing:

```bash
first-tree-hub onboard --check --id alice --type human --role Engineer
```

```
  ✅ Server URL         http://localhost:8000
  ✅ GitHub CLI          authenticated as alice
  ✅ Context Tree repo   ready
  ❌ domains             (required)
  ⬜ assistant           (optional)
```

When required parameters are missing, the same checklist is shown as an error.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `FIRST_TREE_HUB_SERVER` | Hub server URL (alternative to `--server`) |
| `FEISHU_APP_ID` | Feishu bot App ID (alternative to `--feishu-bot-app-id`) |
| `FEISHU_APP_SECRET` | Feishu bot App Secret (alternative to `--feishu-bot-app-secret`) |

## Choosing the Right Type

| Type | When to Use |
|------|-------------|
| `human` | A real person joining the team. Can optionally have a `personal_assistant`. |
| `personal_assistant` | A bot that acts on behalf of a specific human (created via `--assistant` on a human onboard). |
| `autonomous_agent` | A standalone bot that operates independently — code reviewers, monitors, pipeline agents, etc. |

## For AI Agents

### Rules

- **Use `onboard` command for everything** — do not manually clone repos, create files, or run git commands.
- **Use `--check` to discover what's needed** — don't guess required fields.
- **Ask the user using AskUser-type tools** — prefer interactive question tools (with predefined options) over plain text output when asking the user for choices. Ask choices before details (type, assistant, feishu), then gather remaining info.
- **Ask about optional items too** — but only ask about options that apply to the chosen type (e.g., don't ask about `--assistant` for `autonomous_agent`).
- **`--id` defaults to GitHub username** — suggest it as default but let the user choose a different ID.
- **`--owner` and repo are auto-handled** — do not ask the user for these.

### Type-Specific Parameters

| Parameter | human | personal_assistant | autonomous_agent |
|-----------|-------|--------------------|------------------|
| `--assistant` | ✅ optional | ❌ not applicable | ❌ not applicable |
| `--feishu-bot-app-id` | ❌ not applicable | ✅ optional | ✅ optional |
| `--feishu-bot-app-secret` | ❌ not applicable | ✅ optional | ✅ optional |
| `--delegate-mention` | auto (from `--assistant`) | ❌ not applicable | ❌ not applicable |
| Feishu `/bind` hint (Phase 2) | ✅ show to user | ❌ skip | ❌ skip |

Do **not** ask the user about parameters marked ❌ for their chosen type.

### Command Flow

```bash
# 1. Ask user for --type first (determines which optional params to ask)

# 2. Check readiness (repeat with more params until all ✅)
first-tree-hub onboard --check [params...]

# 3. Execute Phase 1 (creates PR)
first-tree-hub onboard [params...]

# 4. User reviews and merges PR

# 5. Execute Phase 2 (sync + token + bindings + client config)
#    human:            first-tree-hub onboard --continue [--feishu-bot-app-id ... --feishu-bot-app-secret ...]
#    autonomous_agent: first-tree-hub onboard --continue [--feishu-bot-app-id ... --feishu-bot-app-secret ...]
#    personal_assistant (standalone): first-tree-hub onboard --continue
first-tree-hub onboard --continue

# 6. Start the agent
first-tree-hub client start

# 7. Post-onboard hints (type-specific):
#    human + feishu bot: tell user to send "/bind <id>" to bot in Feishu
#    autonomous_agent:   no additional steps
#    personal_assistant: no additional steps
```
