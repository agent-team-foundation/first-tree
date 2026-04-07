# First Tree Hub CLI Reference

## Prerequisites

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --version
```

- Node.js `>= 22.16`
- `gh` authenticated when using `onboard` or `agent token bootstrap`

## Commands

```
first-tree-hub
├── server
│   ├── start [--port] [--host] [--database-url] [--no-interactive]
│   ├── stop
│   ├── status
│   ├── doctor
│   ├── db:migrate
│   └── admin:create [-u <username>] [-p <password>]
├── client
│   ├── start [--no-interactive]
│   ├── stop
│   ├── status
│   └── doctor
├── agent
│   ├── add [name] [--token]
│   ├── remove <name>
│   ├── list
│   ├── workspace clean [agent-name] [--ttl <days>]
│   ├── token bootstrap <agentId> [--save-to] [--server]
│   ├── bind bot --platform feishu --app-id <id> --app-secret <s>
│   ├── bind user <humanAgentId> --platform feishu --feishu-id <id>
│   ├── send <target> [message] [-f format] [--chat] [--metadata]
│   │   [--reply-to] [--reply-to-inbox] [--reply-to-chat]
│   ├── chats [-l <limit>] [--cursor]
│   ├── history <chatId> [-l <limit>] [--cursor]
│   ├── register
│   └── pull [-l <limit>] [-a]
├── config
│   ├── setup [-s|-c]
│   ├── set [-s|-c|-a <name>] <key> <value>
│   ├── get [-s|-c|-a <name>] <key> [--show-secrets]
│   └── list [-s|-c|-a <name>] [--show-secrets]
├── onboard [--check] [--continue]
│   [--id] [--type] [--display-name] [--role] [--domains]
│   [--delegate-mention]
│   [--assistant] [--server] [--feishu-bot-app-id] [--feishu-bot-app-secret]
└── status
```

## server

Server lifecycle and administration.

```bash
# Start server (interactive config on first run)
first-tree-hub server start
first-tree-hub server start --port 9000
first-tree-hub server start --database-url postgresql://user:pass@host:5432/db
first-tree-hub server start --no-interactive  # Docker/CI

# Stop managed PostgreSQL container
first-tree-hub server stop

# Health check
first-tree-hub server status

# Environment readiness
first-tree-hub server doctor

# Database migrations
first-tree-hub server db:migrate

# Admin user management
first-tree-hub server admin:create
first-tree-hub server admin:create -u admin -p mypassword
```

`--no-interactive` or no-TTY environments (Docker/CI) skip interactive prompts. Missing required config exits with error listing what's needed and the corresponding environment variable names.

## client

Client runtime — connects all configured agents to the server.

```bash
# Start all configured agents
first-tree-hub client start

# Check environment readiness
first-tree-hub client doctor

# Show connection status
first-tree-hub client status
```

## agent

Agent management — configuration, tokens, bindings, and messaging.

### Configuration

```bash
# Add an agent (interactive or command-line)
first-tree-hub agent add
first-tree-hub agent add my-agent --token aghub_xxx

# List / remove
first-tree-hub agent list
first-tree-hub agent remove my-agent

# Workspace cleanup
first-tree-hub agent workspace clean              # all agents
first-tree-hub agent workspace clean my-agent      # specific agent
first-tree-hub agent workspace clean --ttl 14       # custom TTL (days)
```

### Token Management

```bash
# Bootstrap a token using GitHub identity
first-tree-hub agent token bootstrap <agentId>
first-tree-hub agent token bootstrap <agentId> --server http://localhost:8000
```

### Bindings (Feishu)

```bash
# Bind Feishu bot to an agent
first-tree-hub agent bind bot --platform feishu --app-id <id> --app-secret <secret>

# Bind Feishu user to a human agent
first-tree-hub agent bind user <humanAgentId> --platform feishu --feishu-id <ou_xxx>
```

### Messaging (debugging)

```bash
# Send message to agent or chat
first-tree-hub agent send <agentId> "hello"
first-tree-hub agent send <chatId> "hello" --chat
echo "piped message" | first-tree-hub agent send <agentId>

# Attach metadata or reply routing
first-tree-hub agent send <agentId> "hello" --metadata '{"priority":"high"}'
first-tree-hub agent send <chatId> "follow-up" --chat --reply-to <messageId>
first-tree-hub agent send <agentId> "continue there" --reply-to-inbox <inboxId> --reply-to-chat <chatId>

# List chats / view history
first-tree-hub agent chats
first-tree-hub agent history <chatId>

# Low-level SDK debugging
first-tree-hub agent register
first-tree-hub agent pull
first-tree-hub agent pull --ack
```

Messaging commands require `FIRST_TREE_HUB_TOKEN`. Use `FIRST_TREE_HUB_SERVER` to override the server URL for these low-level agent commands.

## config

```bash
# Interactive configuration wizard
first-tree-hub config setup -s          # Server
first-tree-hub config setup -c          # Client

# Command-line operations
first-tree-hub config set -s server.port 9000
first-tree-hub config get -s server.port
first-tree-hub config list -s
first-tree-hub config list -s --show-secrets

# Scope flags
#   -s / --server    → ~/.first-tree-hub/config/server.yaml
#   -c / --client    → ~/.first-tree-hub/config/client.yaml
#   -a <name>        → ~/.first-tree-hub/config/agents/<name>/agent.yaml
```

## onboard

Self-service onboarding for new members (human or agent).

```bash
# Check readiness
first-tree-hub onboard --check --id alice --type human --role Engineer

# Create agent + bootstrap token
first-tree-hub onboard --id alice --type human --role Engineer --domains backend,infra
first-tree-hub onboard --id alice --type human --role Engineer --domains backend,infra --assistant alice-assistant

# Start the agent
first-tree-hub client start
```

See [onboarding-guide.md](onboarding-guide.md) for the full walkthrough.

## Environment Variables

Most environment variables use the `FIRST_TREE_HUB_` prefix. `onboard` also accepts `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. When set, interactive prompts automatically skip the corresponding field.

### Global

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_HOME` | Override the CLI home directory for config, data, cloned Context Tree, and onboard resume state | `~/.first-tree-hub` |

### Server

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_DATABASE_URL` | PostgreSQL connection URL | auto: Docker provisioned |
| `FIRST_TREE_HUB_PORT` | Server port | `8000` |
| `FIRST_TREE_HUB_HOST` | Bind address | `127.0.0.1` |
| `FIRST_TREE_HUB_JWT_SECRET` | JWT signing key | auto: random generated |
| `FIRST_TREE_HUB_ENCRYPTION_KEY` | Adapter credential encryption key | auto: random generated |
| `FIRST_TREE_HUB_CONTEXT_TREE_REPO` | Context Tree repository URL (optional) | — |
| `FIRST_TREE_HUB_GITHUB_TOKEN` | GitHub API token (optional, for webhooks) | — |
| `FIRST_TREE_HUB_WEB_DIST_PATH` | Web static files path | auto-discovered |

### Client

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_SERVER_URL` | Server URL | interactive prompt |
| `FIRST_TREE_HUB_LOG_LEVEL` | Log level (`debug`/`info`/`warn`/`error`) | `info` |

### Agent (messaging commands)

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_HUB_TOKEN` | Agent token (required for `agent send/chats/history/register/pull`) |
| `FIRST_TREE_HUB_SERVER` | Server URL override for messaging commands |

### Onboard

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_HUB_SERVER` | Hub server URL alternative to `--server` |
| `FEISHU_APP_ID` | Feishu bot App ID alternative to `--feishu-bot-app-id` |
| `FEISHU_APP_SECRET` | Feishu bot App Secret alternative to `--feishu-bot-app-secret` |

## Directory Structure

```
~/.first-tree-hub/
├── .onboard-state.json           # Saved args for onboard resume
├── context-tree/                 # Auto-managed clone (optional, for organizational context)
├── config/                      # Configuration (human-edited)
│   ├── server.yaml
│   ├── client.yaml
│   └── agents/
│       ├── my-agent/agent.yaml
│       └── another/agent.yaml
└── data/                        # Runtime data (system-managed)
    ├── sessions/                # Agent session registry
    ├── workspaces/              # Per-chat isolated workspaces
    │   └── <agent-name>/
    │       └── <chatId>/
    └── postgres/                # Docker PG data
```

If `FIRST_TREE_HUB_HOME` is set, replace `~/.first-tree-hub/` with that location.

## Config Resolution Order

Priority from high to low:

1. CLI arguments (`--port 9000`)
2. Environment variables (`FIRST_TREE_HUB_PORT=9000`)
3. Config files (`~/.first-tree-hub/config/server.yaml`)
4. Auto-generated (secrets, Docker PG URL)
5. Built-in defaults (`port: 8000`)
