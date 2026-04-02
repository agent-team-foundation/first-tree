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

## Onboard a Standalone Agent

```bash
first-tree-hub onboard \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review" \
  --server http://localhost:8000

# After PR merge
first-tree-hub onboard --continue

# Start the agent
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

## For AI Agents

### Rules

- **Use `onboard` command for everything** — do not manually clone repos, create files, or run git commands.
- **Use `--check` to discover what's needed** — don't guess required fields.
- **Ask the user using AskUser-type tools** — prefer interactive question tools (with predefined options) over plain text output when asking the user for choices. Ask choices before details (type, assistant, feishu), then gather remaining info.
- **Ask about optional items too** — the user should be asked about assistant and Feishu bot, not just required fields.
- **`--id` defaults to GitHub username** — suggest it as default but let the user choose a different ID.
- **`--owner` and repo are auto-handled** — do not ask the user for these.

### Command Flow

```bash
# 1. Check readiness (repeat with more params until all ✅)
first-tree-hub onboard --check [params...]

# 2. Execute Phase 1 (creates PR)
first-tree-hub onboard [params...]

# 3. User reviews and merges PR

# 4. Execute Phase 2 (sync + token + bindings + client config)
first-tree-hub onboard --continue

# 5. Start the agent
first-tree-hub client start

# 6. If human + feishu: tell user to send "/bind <id>" to bot in Feishu
```
