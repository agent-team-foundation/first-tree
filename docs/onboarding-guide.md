# Onboarding Guide

This guide covers how to add new members (human or agent) to First Tree Hub, create tokens, and bind Feishu accounts. It is written for both human operators and AI agents (e.g., Claude Code).

No admin account is required — onboarding uses your GitHub identity for authorization.

## Prerequisites

- **GitHub CLI** (`gh`) authenticated with write access to the Context Tree repository
- **First Tree Hub CLI** (`first-tree-hub`) installed
- **Hub Server** running and accessible

The CLI auto-discovers the Context Tree repository from the server. A local clone is needed for member creation — the CLI will tell you how to get one if not found.

## Key Concepts

**NODE.md fields** used by onboarding:

- **`owners`**: Who can manage this agent (bootstrap tokens, approve changes). Auto-filled from your `gh` CLI identity.
- **`github`**: Which GitHub user IS this agent (for webhook routing). Only set for human agents. Auto-filled from your `gh` CLI identity.
- **`delegate_mention`**: Which assistant acts on behalf of this human. Set automatically when you use `--assistant`.

The `--owner` parameter is auto-detected from `gh api /user` — you don't need to provide it manually.

## Quick Reference: Commands

```
first-tree-hub
├── onboard                              # End-to-end onboarding (orchestration)
│   ├── --id <id>                        #   Member ID (directory name)
│   ├── --type <type>                    #   human | personal_assistant | autonomous_agent
│   ├── --display-name <name>            #   Display name (optional, defaults to id)
│   ├── --role <role>                    #   Role description
│   ├── --domains <d1,d2>               #   Comma-separated domains
│   ├── --owner <github-user>            #   GitHub username (auto-detected from gh CLI)
│   ├── --assistant <id>                 #   Also create a personal_assistant
│   ├── --server <url>                   #   Hub server URL (or use env/config)
│   ├── --repo <path>                    #   Context Tree local repo path (auto-discovered)
│   ├── --feishu-bot-app-id <id>         #   Feishu bot App ID
│   ├── --feishu-bot-app-secret <s>      #   Feishu bot App Secret
│   ├── --feishu-search <name>           #   Search Feishu user by name to bind
│   ├── --feishu-user-select <n>         #   Select from search results
│   ├── --check                          #   Dry-run: show readiness checklist
│   └── --continue                       #   Resume after PR merge
│
├── agent                                # Context Tree member operations (atomic)
│   ├── create <id> [options]            #   Create member NODE.md
│   ├── verify [--repo <path>]           #   Run context-tree verify
│   └── submit-pr [--repo <path>]        #   Commit + push + create PR
│
├── token
│   └── bootstrap <agent-id>             #   GitHub identity → Agent token
│       └── [--save-to agent|<file>]     #     Default: save to agent config
│
├── feishu
│   └── search <query>                   #   Search Feishu users
│       ├── [--by name|email|mobile]     #     Search field (default: name)
│       └── [--json]                     #     Machine-readable output
│
├── bind-bot                             #   Bind Feishu bot (self-service)
│   ├── --platform feishu
│   ├── --app-id <id>
│   └── --app-secret <secret>
│
└── bind-user <human-id>                 #   Bind Feishu user
    ├── --platform feishu
    ├── [--feishu-id <ou_xxx>]           #     Direct Feishu user ID
    ├── [--search <name>]                #     Or search by name
    └── [--select <n>]                   #     Select from search results
```

## The `--check` Flag

All onboard operations support `--check` for a dry-run readiness report. This is the recommended first step — especially useful for AI agents that need to know what information to ask the user for.

```bash
first-tree-hub onboard --check \
  --id zhangsan --type human --role Engineer
```

Output:

```
Onboard Check: zhangsan (human)

Environment:
  ✅ Server URL         http://localhost:8000 (from config)
  ✅ Server reachable   yes
  ✅ Context Tree repo  /home/bai/dev/first-tree-context (from server)
  ✅ GitHub CLI          gh authenticated as yuezengwu

Member:
  ✅ id                 zhangsan
  ✅ type               human
  ✅ role               Engineer
  ❌ domains            (required) comma-separated list, e.g. "backend,infra"
  ❌ owner              (required) GitHub username
  ⬜ display-name       (optional, defaults to "zhangsan")
  ⬜ delegate-mention   (optional) personal_assistant agent ID
  ⬜ assistant          (optional) also create a personal_assistant

Feishu:
  ⬜ feishu-search      (optional) search Feishu user to bind
  ⬜ feishu-bot-app-id  (optional) Feishu bot App ID for assistant

Conflicts:
  ✅ ID "zhangsan" not taken in Context Tree
```

Icons: ✅ ready, ❌ missing (required), ⚠️ missing (recommended), ⬜ missing (optional).

When `--check` is not used but required parameters are missing, the same checklist is printed as an error — so agents always get full information in one round.

## Scenario 1: Onboard a New Human + Personal Assistant

This is the most common scenario.

### Phase 1: Create Context Tree PR

```bash
first-tree-hub onboard \
  --id zhangsan \
  --type human \
  --display-name "Zhang San" \
  --role "Engineer" \
  --domains "backend,infrastructure" \
  --owner zhangsan-gh \
  --assistant zhangsan-assistant
```

The command will:

1. Query the server for Context Tree repo info, find local clone
2. Create `members/zhangsan/NODE.md` and `members/zhangsan-assistant/NODE.md`
3. Run `context-tree verify` to validate
4. Create a git branch, commit, push, and open a PR
5. Print the PR URL and pause

### Phase 2: After PR Merge

```bash
first-tree-hub onboard --continue \
  --feishu-bot-app-id cli_abcdef \
  --feishu-bot-app-secret "$FEISHU_APP_SECRET" \
  --feishu-search "Zhang San"
```

This will:

1. Wait for the server to sync the new members
2. Bootstrap a token for `zhangsan-assistant` using your GitHub identity (via `gh auth token`)
3. Save the token to `~/.first-tree-hub/agents/zhangsan-assistant/agent.yaml`
4. Bind the Feishu bot to `zhangsan-assistant`
5. Search Feishu for "Zhang San" and print results:

```
Feishu user search results for "Zhang San":
  1. Zhang San (ou_abc123) Engineering
  2. Zhang Sanfeng (ou_def456) Product

Use --feishu-user-select <n> to confirm binding.
```

Then confirm:

```bash
first-tree-hub onboard --continue --feishu-user-select 1
```

### Agent Flow (for Claude Code, etc.)

Agents use the same commands. The recommended pattern:

1. Run `onboard --check` with whatever info is available
2. Read the checklist, ask the user for all ❌ items in one question
3. Run `onboard --check` again to verify everything is ✅
4. Run `onboard` (without `--check`) to execute

**Example agent conversation:**

```
User:   Add zhangsan to the hub

Agent:  → runs: first-tree-hub onboard --check --id zhangsan
        → checklist shows: ❌ type, role, domains, owner

Agent:  I need a few details:
        1. Type? (human / personal_assistant / autonomous_agent)
        2. Role?
        3. Domains?
        4. GitHub username?
        5. Create a personal assistant?
        6. Bind Feishu?

User:   Human, backend engineer, backend + infra, GitHub is zhangsan-gh,
        yes assistant, yes feishu, bot creds in env vars

Agent:  → runs: first-tree-hub onboard --check --id zhangsan --type human
                --role "Backend Engineer" --domains "backend,infra"
                --assistant zhangsan-assistant
                --feishu-bot-app-id "$FEISHU_APP_ID"
                --feishu-bot-app-secret "$FEISHU_APP_SECRET"
        → all ✅

Agent:  All ready. Creating PR now.
        → runs: first-tree-hub onboard [same params without --check]
        → PR created: https://github.com/...
        Please review and merge the PR, then tell me to continue.

User:   Merged

Agent:  → runs: first-tree-hub onboard --continue
        → sync ✅ → token ✅ → feishu bot ✅
        → Onboard complete! To bind your Feishu account,
          send "/bind zhangsan" to the bot in Feishu.
```

## Scenario 2: Onboard a Standalone Agent

```bash
first-tree-hub onboard \
  --id code-reviewer \
  --type autonomous_agent \
  --display-name "Code Reviewer" \
  --role "Automated Code Review" \
  --domains "code-review,testing" \
  --owner zhangsan-gh

# After PR merge
first-tree-hub onboard --continue
```

No Feishu binding needed — token is bootstrapped and saved automatically.

## Scenario 3: Bind Feishu for an Existing Member

These atomic commands work independently of the `onboard` flow.

### Agent binds its own Feishu bot (self-service)

```bash
FIRST_TREE_HUB_TOKEN=aghub_xxx \
  first-tree-hub bind-bot \
  --platform feishu \
  --app-id cli_abcdef \
  --app-secret "$FEISHU_APP_SECRET"
```

### Assistant binds owner's Feishu user (delegate)

Requires the human's `delegate_mention` field pointing to this assistant.

```bash
# Search
FIRST_TREE_HUB_TOKEN=$ASSISTANT_TOKEN \
  first-tree-hub feishu search "Zhang San"

# Bind
FIRST_TREE_HUB_TOKEN=$ASSISTANT_TOKEN \
  first-tree-hub bind-user zhangsan \
  --platform feishu \
  --feishu-id ou_abc123
```

### Admin binds Feishu user

Admin can bind any agent without delegate_mention restrictions:

```bash
first-tree-hub admin login
first-tree-hub admin bind-user zhangsan \
  --platform feishu \
  --search "Zhang San" --select 1
```

## Scenario 4: Re-bootstrap a Token

If an agent's token is lost, the owner must first revoke all existing tokens (via admin or web UI), then re-bootstrap:

```bash
first-tree-hub token bootstrap zhangsan-assistant --save-to agent
```

This uses `gh auth token` to prove GitHub identity and checks the `owners` field.

## Authentication Summary

| Command | Auth Method | Who Can Use |
|---------|-------------|-------------|
| `onboard` (Phase 1) | GitHub CLI (`gh`) | Anyone with repo write access |
| `onboard --continue` | GitHub Token (auto via `gh`) | Users listed in `owners` field |
| `token bootstrap` | GitHub Token (auto via `gh`) | Users listed in `owners` field |
| `bind-bot` | Agent Token (self-service) | The agent itself (non-human only) |
| `bind-user` (no admin) | Agent Token + delegate_mention | The human's delegate assistant |
| `bind-user` (admin) | Admin JWT | Admin users |
| `feishu search` | Agent Token | Any authenticated agent |

No admin account is needed for the standard onboarding flow.

## Configuration Discovery

The CLI resolves configuration in this order:

| Config | Resolution Order |
|--------|------------------|
| Server URL | `--server` flag → `FIRST_TREE_HUB_SERVER` env → `~/.first-tree-hub/client.yaml` |
| Context Tree repo | `--repo` flag → `FIRST_TREE_HUB_CONTEXT_TREE_REPO` env → auto-discover from server via `GET /api/v1/context-tree/info` |

On first use, provide `--server`. The value is saved to config for future use.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `FIRST_TREE_HUB_TOKEN` | Agent bearer token (for bind-bot, bind-user, feishu search) |
| `FIRST_TREE_HUB_SERVER` | Hub server URL |
| `FIRST_TREE_HUB_CONTEXT_TREE_REPO` | Context Tree local repo path (overrides auto-discovery) |
| `FEISHU_APP_ID` | Feishu bot App ID (avoids passing on command line) |
| `FEISHU_APP_SECRET` | Feishu bot App Secret (avoids passing on command line) |

## Troubleshooting

**`token bootstrap` returns 404**: Agent has not been synced yet. Wait for auto-sync or ask an admin to trigger sync.

**`token bootstrap` returns 409**: Agent already has an active token. Revoke existing tokens first via admin or web UI.

**`token bootstrap` returns 403**: Your GitHub username is not in the agent's `owners` list in NODE.md.

**`feishu search` returns 503**: No active Feishu bot is configured in the system. Bind a bot first.

**`bind-user` returns 403**: Your agent is not the target human's `delegate_mention`. Ask an admin to do the binding instead.

**Server URL not configured**: Provide via `--server <url>`, `FIRST_TREE_HUB_SERVER` env var, or `first-tree-hub config set server.url <url>`.

**Context Tree repo not found**: Either clone it (`gh repo clone <org>/<repo>`) and provide `--repo <path>`, or set `FIRST_TREE_HUB_CONTEXT_TREE_REPO`.

## For AI Agents

If you are an AI agent (e.g., Claude Code) performing onboarding on behalf of a user, follow this workflow:

### Recommended Flow

1. Run `first-tree-hub onboard --check` with whatever parameters you have.
2. Read the checklist output. Ask the user for **all ❌ (required) items in one question** — do not ask one at a time.
3. Run `--check` again with the full parameters to verify all ✅.
4. Run `first-tree-hub onboard` (without `--check`) to create the Context Tree PR.
5. Tell the user the PR URL and ask them to review and merge.
6. After the user confirms the PR is merged, run `first-tree-hub onboard --continue`.
7. Report the result and tell the user to send `/bind <agent-id>` in Feishu if Feishu binding is needed.

### Key Behaviors

- **`--check` mode** outputs a full readiness checklist. Use it to gather all missing info in one round instead of failing one parameter at a time.
- **`--owner` is auto-detected** from `gh api /user`. You do not need to ask the user for their GitHub username.
- **Context Tree repo is auto-cloned** to `~/.first-tree-hub/context-tree/`. You do not need to ask for a repo path.
- **Structured output**: stdout produces JSON (`{ ok, data }` or `{ ok, error }`). stderr produces human-readable progress messages. Parse stdout for programmatic decisions.
- **State file** (`~/.first-tree-hub/.onboard-state.json`) persists across runs. If a previous run failed, the next `--check` will reflect already-entered values.
- **Feishu user binding** is not part of the onboard flow. After onboarding, the user self-binds by sending `/bind <agent-id>` to the Feishu bot.

### Example Minimal Interaction

```
User:   Help me onboard a new member "alice" as an engineer

Agent:  I'll check what's needed.
        → runs: first-tree-hub onboard --check --id alice --type human --role Engineer
        → ❌ domains missing

Agent:  What domains is alice responsible for?

User:   backend, databases

Agent:  → runs: first-tree-hub onboard --check --id alice --type human
                --role Engineer --domains "backend,databases"
        → all ✅
        → runs: first-tree-hub onboard --id alice --type human
                --role Engineer --domains "backend,databases"
        → PR created

Agent:  PR created: https://github.com/org/repo/pull/5
        Please review and merge, then tell me to continue.

User:   Done

Agent:  → runs: first-tree-hub onboard --continue
        → ✅ Onboard complete!

Agent:  Alice is onboarded. To bind Feishu, send "/bind alice" to the bot.
```
