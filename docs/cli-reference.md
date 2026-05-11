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
├── connect <token>
│   └── [--no-service]
├── server
│   ├── start [--port] [--host] [--database-url] [--no-interactive]
│   ├── stop
│   ├── status
│   ├── doctor
│   ├── db:migrate
│   └── admin:create [-u <username>] [-p <password>]
├── client
│   ├── connect <server-url> [--token <token>] [--no-service]   (legacy/self-host)
│   ├── start [--no-interactive] [--foreground]
│   ├── stop
│   ├── restart
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
└── update [--check] [--no-restart]
```

## connect

Top-level shortcut for SaaS users. Paste the connect token your Hub web
console shows in *Connect your computer*; the CLI decodes the token's
`iss` claim to derive the hub URL — no `--server-url` argument needed.

```bash
first-tree-hub connect eyJhbGciOi...           # default: install background service
first-tree-hub connect eyJhbGciOi... --no-service   # run inline until Ctrl+C
```

Hard-fails (no fallback) when the token is missing an `iss` claim or the
claim is not an `http(s)` URL — that prevents stale tokens from one
environment from accidentally re-targeting another. The legacy
`first-tree-hub client connect <url> --token <token>` form is still
available for self-host users who need the explicit URL.

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
# First-time setup: authenticate and start (use the command shown in the web
# "Connect a machine" dialog, which includes a one-time token)
first-tree-hub client connect <server-url> --token <token>

# Service lifecycle (delegates to systemd / launchd when a service is installed)
first-tree-hub client start          # Start the background service
first-tree-hub client start --foreground   # Run inline instead (debug / no-service users)
first-tree-hub client stop           # Stop the service (preserves auto-start on next login)
first-tree-hub client restart        # Restart the service

# Check environment readiness (includes background-service state)
first-tree-hub client doctor

# One-screen overview: CLI version, service state, hub URL, configured agents
first-tree-hub client status

# Transfer ownership of this machine's client.yaml to the currently
# logged-in user (run after a 4403 CLIENT_USER_MISMATCH on `client start`).
# Unpins the previous owner's agents from this machine in a single
# transaction; --confirm skips the interactive prompt.
first-tree-hub client claim --confirm
```

`client connect` automatically installs a background service on macOS (launchd) and Linux (`systemd --user`) so the computer stays online across reboots. Use `--no-service` to skip this and run inline (Ctrl+C to stop). Windows is not supported — `client connect` falls back to inline mode.

### Sharing a machine across users (`client claim`)

A `client.yaml` is bound to exactly one user. When a different user logs in
and runs `client start`, the WebSocket handshake refuses with code
`CLIENT_USER_MISMATCH` (close 4403) and the CLI prints a guide pointing at
`first-tree-hub client claim --confirm`. Running claim:

1. Updates `clients.user_id` to the calling JWT's user.
2. Unpins every agent whose manager belonged to the previous owner
   (`agents.client_id` ← NULL, presence reset to offline) — atomic.
3. Logs `event=client.owner_transfer` with the previous/new owner ids.

After claim, `client start` reconnects without further prompts. There is no
`--force` flag — interactive confirmation (or explicit `--confirm`) is
mandatory so a typo doesn't strip the previous owner's machine. See
[docs/decouple-client-from-identity-design-zh.md §4.4](decouple-client-from-identity-design-zh.md).

### Manual service operations

`client start / stop / restart` cover day-to-day service control. Install happens during `client connect`; uninstall is a manual OS-level step (see *Decommission* below). `client status` and `client doctor` report state.

**Tail logs:**

```bash
# Linux: journald is authoritative under the new unit (StandardOutput=journal)
journalctl --user -u first-tree-hub-client -f

# Or read the rotating NDJSON file the client itself writes:
tail -f ~/.first-tree/hub/logs/client.log

# Rotated files: .log + .log.1 ... .log.7, max 10 MB each
ls -lt ~/.first-tree/hub/logs/
```

Logs are NDJSON; pipe through `jq` for filtering by level/time.

**Decommission this machine (remove the background service + local credentials):**

```bash
# macOS
launchctl bootout gui/$UID/dev.first-tree-hub.client 2>/dev/null
rm -f ~/Library/LaunchAgents/dev.first-tree-hub.client.plist

# Linux
systemctl --user disable --now first-tree-hub-client.service
rm -f ~/.config/systemd/user/first-tree-hub-client.service
systemctl --user daemon-reload

# Both: clear local credentials and config
rm -rf ~/.first-tree/hub
```

To force-disconnect a client from the server side, use `client hub-disconnect <clientId>`.

**Repair after Node upgrade or binary move** (plist still points at the old path): re-run `first-tree-hub client connect <url>` — re-authentication is required, but it re-writes the unit file with the current binary path.

## agent

Agent management — configuration, tokens, bindings, and messaging.

### Configuration

```bash
# Register an existing Hub agent on this client (interactive or --agent-id).
# Optional: a running `first-tree-hub client start` auto-registers any agent
# the admin pins to this clientId via the Hub UI / API, so this command is
# only needed for unattended setups or scripted seeding.
#
# The local config dir is always keyed by the agent's name on the Hub —
# there is no separate "local alias" concept.
first-tree-hub agent add
first-tree-hub agent add --agent-id <uuid>

# List / remove (name = Hub agent name)
first-tree-hub agent list                           # locally configured agents on this machine
first-tree-hub agent list --remote                  # every agent you manage on the Hub (cross-org)
first-tree-hub agent list --org <organizationId>    # restrict the remote list to one org
first-tree-hub agent remove <name>

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

Messaging commands require an agent token (see Agent env vars below). Use `FIRST_TREE_HUB_SERVER_URL` to override the server URL for these low-level agent commands.

### Agent → user structured questions (Claude runtime)

Claude-runtime agents can pause execution mid-turn and prompt the operator with a structured `AskUserQuestion` (single- or multi-select, up to 4 parallel questions, optional HTML / Markdown previews per option). The Hub bridges this through the inbox so the question lands on the Web chat as a clickable card; the operator's choice is then fed back to the agent and the turn continues.

- **Activation**: automatic for any agent on `runtimeProvider: claude-code` — no CLI flag.
- **UI**: the question renders inline in the chat timeline as a card with three states (pending / answered / superseded).
- **Lifecycle**: a pending question is auto-superseded when the chat session is archived (`agent session terminate`) or when the owning client is reclaimed by a different user (`first-tree-hub client claim`). The agent receives a clean deny in either case.
- **Codex runtime**: not supported. The Codex SDK has no ask-user surface; codex-runtime agents that try to emit a question are rejected with HTTP 403 by the server (`assertSenderMayEmitQuestion`).

No CLI command is required to use the feature — it shows up automatically when a Claude-runtime agent calls `AskUserQuestion` during a turn.

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
#   -s / --server    → ~/.first-tree/hub/config/server.yaml
#   -c / --client    → ~/.first-tree/hub/config/client.yaml
#   -a <name>        → ~/.first-tree/hub/config/agents/<name>/agent.yaml
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

## update

Self-update for the CLI. Queries the npm registry for the latest published version, installs it globally, refreshes the systemd unit / launchd plist on top of the new bits, then restarts the client service.

```bash
first-tree-hub update              # Install latest + refresh unit + restart service
first-tree-hub update --check      # Only check; print "update available" or "already on latest"
first-tree-hub update --no-restart # Install latest + refresh unit, but leave the running service alone
```

`--no-restart` is for staged rollouts where the operator wants to time the cutover. Refusing to run from a source checkout (anywhere with a `.git` ancestor) is intentional — keeps a dev build from accidentally `npm i -g`-overwriting a prod global.

## Environment Variables

Most environment variables use the `FIRST_TREE_HUB_` prefix. `onboard` also accepts `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. When set, interactive prompts automatically skip the corresponding field.

### Global

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_HOME` | Override the CLI home directory for config, data, cloned Context Tree, and onboard resume state | `~/.first-tree/hub` |

### Server

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_DATABASE_URL` | PostgreSQL connection URL | auto: Docker provisioned |
| `FIRST_TREE_HUB_PORT` | Server port | `8000` |
| `FIRST_TREE_HUB_HOST` | Bind address | `127.0.0.1` |
| `FIRST_TREE_HUB_JWT_SECRET` | JWT signing key | auto: random generated |
| `FIRST_TREE_HUB_ENCRYPTION_KEY` | Adapter credential encryption key | auto: random generated |
| `FIRST_TREE_HUB_CONTEXT_TREE_GITHUB_TOKEN` | Optional deployment-level read token for private Context Tree repos configured in Team Settings. Only used by the server-managed Context Tree mirror for allowlisted `https://github.com/...` repos. | — |
| `FIRST_TREE_HUB_CONTEXT_TREE_GITHUB_TOKEN_REPOS` | Comma-separated GitHub repo allowlist (`owner/repo`) that may use `FIRST_TREE_HUB_CONTEXT_TREE_GITHUB_TOKEN`. Required before the token is applied to any org-configured repo. | — |
| `FIRST_TREE_HUB_WEB_DIST_PATH` | Web static files path | auto-discovered |
| `FIRST_TREE_HUB_PUBLIC_URL` | Public-facing hub URL. Stamped as the `iss` claim on connect tokens (so `connect <token>` derives the hub URL with no extra arg) and used to build invite-link URLs + the GitHub OAuth callback. **Required in production.** | request `Host` (dev only) |
| `FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID` | GitHub OAuth App client ID. Enables `/signup` + `/auth/github/start`. Both client id AND secret must be set together. | — |
| `FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret. | — |
| `FIRST_TREE_HUB_GITHUB_OAUTH_DEV_CALLBACK` | Opt-in to the `/auth/github/dev-callback` shortcut (no-op github round-trip, dev only). Always disabled when `NODE_ENV=production`. | `false` |

### Client

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_SERVER_URL` | Server URL | interactive prompt |
| `FIRST_TREE_HUB_LOG_LEVEL` | Log level (`debug`/`info`/`warn`/`error`) | `info` |

### Agent (messaging commands)

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_HUB_AGENT_TOKEN` | Agent bearer token. Highest priority. Injected automatically when running inside a Hub agent runtime. |
| `FIRST_TREE_HUB_AGENT` | Agent name. CLI looks up the token from `~/.first-tree/hub/agents/<name>/agent.yaml`. Used when token is not set explicitly. |
| `FIRST_TREE_HUB_SERVER_URL` | Server URL override for messaging commands. Falls back to client config. |

Resolution order for the agent token:

1. `FIRST_TREE_HUB_AGENT_TOKEN` — explicit value
2. `FIRST_TREE_HUB_AGENT` → lookup in `~/.first-tree/hub/agents/<name>/agent.yaml`
3. Error

### Onboard

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_HUB_SERVER_URL` | Hub server URL alternative to `--server` |
| `FEISHU_APP_ID` | Feishu bot App ID alternative to `--feishu-bot-app-id` |
| `FEISHU_APP_SECRET` | Feishu bot App Secret alternative to `--feishu-bot-app-secret` |

### Observability (server)

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HUB_LOG_LEVEL` | Log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) | `info` |
| `FIRST_TREE_HUB_OTEL_ENDPOINT` | OTLP/HTTP traces endpoint. Non-empty value enables tracing | `""` (disabled) |
| `FIRST_TREE_HUB_OTEL_HEADERS` | OTLP headers in `key1=val1,key2=val2` format (secret — typically holds the write token) | `""` |
| `FIRST_TREE_HUB_OTEL_ENVIRONMENT` | Deployment environment label (`development` / `staging` / `production` / …) — emitted as `deployment.environment.name` | `development` |

See [observability.md](observability.md) for the full config reference, backend cheat sheet, and troubleshooting recipes.

## Directory Structure

```
~/.first-tree/hub/
├── .onboard-state.json           # Saved args for onboard resume
├── config/                      # Configuration (human-edited)
│   ├── server.yaml
│   ├── client.yaml
│   └── agents/
│       ├── my-agent/agent.yaml
│       └── another/agent.yaml
└── data/                        # Runtime data (system-managed)
    ├── context-tree-repos/       # Server-managed readonly Context Tree mirrors
    ├── sessions/                # Agent session registry
    ├── workspaces/              # Per-chat isolated workspaces
    │   └── <agent-name>/
    │       └── <chatId>/
    └── postgres/                # Docker PG data
```

If `FIRST_TREE_HUB_HOME` is set, replace `~/.first-tree/hub/` with that location.

## Config Resolution Order

Priority from high to low:

1. CLI arguments (`--port 9000`)
2. Environment variables (`FIRST_TREE_HUB_PORT=9000`)
3. Config files (`~/.first-tree/hub/config/server.yaml`)
4. Auto-generated (secrets, Docker PG URL)
5. Built-in defaults (`port: 8000`)
