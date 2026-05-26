# First Tree Hub CLI Reference

## Prerequisites

```bash
npm install -g first-tree
first-tree --version
```

- Node.js `>= 22.16`
- `gh` authenticated when using `onboard`

## Commands

```
first-tree
├── connect <token> [--no-start]
├── client
│   ├── start [--no-interactive] [--foreground]
│   ├── stop
│   ├── restart
│   ├── status
│   ├── doctor
│   ├── list
│   ├── disconnect <clientId>
│   ├── claim [--confirm]
│   └── config
│       ├── show [key] [--show-secrets]
│       ├── set <key> <value>
│       └── get <key> [--show-secrets]
├── agent
│   ├── add [--agent-id <uuid>]
│   ├── remove <name>
│   ├── prune [--yes] [--dry-run] [--server]
│   ├── list [--remote] [--org <id>]
│   ├── create <name> --type <t> --client-id <id> [--runtime] [--display-name] [--org] [--server]
│   ├── claim <agentName>
│   ├── status [name]
│   ├── reset <name>
│   ├── session list <agent-name> [--state]
│   ├── session suspend <agent-name> <chat-id>
│   ├── session terminate <agent-name> <chat-id>
│   ├── config show <agent>
│   ├── config set-model <agent> <model>
│   ├── config append-prompt <agent> [-f <file>]
│   ├── config add-mcp <agent> --name --transport [--command --args | --url]
│   ├── config set-env <agent> <KEY=VALUE> [--sensitive]
│   ├── config add-repo <agent> <url> [--ref] [--path]
│   ├── config dry-run <agent> -f <patch.json>
│   ├── bind client <agentName> --client-id
│   ├── bind bot --platform feishu --app-id --app-secret
│   ├── bind user <humanAgentId> --platform feishu --feishu-id
│   └── workspace clean [agent-name] [--ttl]
├── chat
│   ├── list [-l <limit>] [--cursor] [--agent]
│   ├── history <chatId> [-l <limit>] [--cursor] [--agent]
│   ├── send <agentName> [message] [-f format] [-m <json>] [--agent]
│   ├── invite <agentName> [--agent]
│   └── open <agent-name> [--server]
├── org
│   └── bind-tree <url> [--org]
├── onboard [--check] [--continue]
│   [--id] [--type] [--display-name] [--role] [--domains]
│   [--delegate-mention]
│   [--assistant] [--server] [--feishu-bot-app-id] [--feishu-bot-app-secret]
└── update [--check] [--no-restart]
```

## connect

Single entry point. Paste the connect token your Hub web console shows
in *Connect your computer*; the CLI decodes the token's `iss` claim to
derive the hub URL — no `--server-url` argument needed.

```bash
first-tree login eyJhbGciOi...           # default: install background service
first-tree login eyJhbGciOi... --no-start   # run inline until Ctrl+C
```

Hard-fails (no fallback) when the token is missing an `iss` claim or the
claim is not an `http(s)` URL — that prevents stale tokens from one
environment from accidentally re-targeting another.

## client

Client runtime — connects all configured agents to the server. First-time
setup happens via the top-level `first-tree login <token>` (see
above); the commands below cover ongoing operation.

```bash
# Service lifecycle (delegates to systemd / launchd when a service is installed)
first-tree daemon start          # Start the background service
first-tree daemon start --foreground   # Run inline instead (debug / no-service users)
first-tree daemon stop           # Stop the service (preserves auto-start on next login)
first-tree daemon restart        # Restart the service

# Check environment readiness (includes background-service state)
first-tree daemon doctor

# One-screen overview: CLI version, service state, hub URL, configured agents
first-tree daemon status

# Hub-side client inventory and administration is exposed in the web admin UI
# (Computers tab). The legacy `client list` / `client disconnect` CLI verbs
# have been removed.

# View / modify this machine's client.yaml
first-tree config show
first-tree config show update.policy
first-tree config set update.policy auto

# Transfer ownership of this machine's client.yaml to the currently
# logged-in user (run after a 4403 CLIENT_USER_MISMATCH on `daemon start`).
# Unpins the previous owner's agents from this machine in a single
# transaction.
first-tree login <token> --override
```

`login <token>` automatically installs a background service on macOS (launchd) and Linux (`systemd --user`) so the computer stays online across reboots. Use `--no-start` to skip this and run inline (Ctrl+C to stop). Windows is not supported — `login` falls back to inline mode.

### Sharing a machine across users (`login --override`)

A `client.yaml` is bound to exactly one user. When a different user logs in
and runs `daemon start`, the WebSocket handshake refuses with code
`CLIENT_USER_MISMATCH` (close 4403) and the CLI prints a guide pointing at
`first-tree login <token> --override`. Running override:

1. Updates `clients.user_id` to the calling JWT's user.
2. Unpins every agent whose manager belonged to the previous owner
   (`agents.client_id` ← NULL, presence reset to offline) — atomic.
3. Logs `event=client.owner_transfer` with the previous/new owner ids.

After override, `daemon start` reconnects without further prompts. The
`--override` flag is the explicit consent — a typo cannot strip the
previous owner's machine because the verb must be requested by name. See
[`agent-hub/claim-agent.md`](https://github.com/agent-team-foundation/first-tree-context/blob/main/agent-hub/claim-agent.md) and [`agent-hub/client-identity-binding.md`](https://github.com/agent-team-foundation/first-tree-context/blob/main/agent-hub/client-identity-binding.md).

### Manual service operations

`daemon start / stop / restart` cover day-to-day service control. Install happens during `first-tree login <token>`; uninstall is a manual OS-level step (see *Decommission* below). `daemon status` and `daemon doctor` report state.

**Tail logs:**

```bash
# Linux: journald is authoritative under the new unit (StandardOutput=journal)
journalctl --user -u first-tree-client -f

# Or read the rotating NDJSON file the client itself writes:
tail -f ~/.first-tree/logs/client.log

# Rotated files: .log + .log.1 ... .log.7, max 10 MB each
ls -lt ~/.first-tree/logs/
```

Logs are NDJSON; pipe through `jq` for filtering by level/time.

**Decommission this machine (remove the background service + local credentials):**

```bash
# macOS
launchctl bootout gui/$UID/dev.first-tree.client 2>/dev/null
rm -f ~/Library/LaunchAgents/dev.first-tree.client.plist

# Linux
systemctl --user disable --now first-tree-client.service
rm -f ~/.config/systemd/user/first-tree-client.service
systemctl --user daemon-reload

# Both: clear local credentials and config
rm -rf ~/.first-tree
```

To force-disconnect a client from the server side, use the Hub web admin UI (Computers tab → "Disconnect"). The CLI no longer ships an admin verb for this — it's a destructive cross-machine operation that lives in the admin surface.

**Repair after Node upgrade or binary move** (plist still points at the old path): re-run `first-tree login <token>` — re-authentication is required (paste a fresh connect token from the Hub web console), but the command rewrites the unit file with the current binary path.

## agent

Agent management — configuration, tokens, bindings, and messaging.

### Configuration

```bash
# Register an existing Hub agent on this client (interactive or --agent-id).
# Optional: a running `first-tree daemon start` auto-registers any agent
# the admin pins to this clientId via the Hub UI / API, so this command is
# only needed for unattended setups or scripted seeding.
#
# The local config dir is always keyed by the agent's name on the Hub —
# there is no separate "local alias" concept.
first-tree agent add
first-tree agent add --agent-id <uuid>

# List / remove (name = Hub agent name)
first-tree agent list                           # locally configured agents on this machine
first-tree agent list --remote                  # every agent you manage on the Hub (cross-org)
first-tree agent list --org <organizationId>    # restrict the remote list to one org
first-tree agent remove <name>

# Workspace cleanup
first-tree agent workspace clean              # all agents
first-tree agent workspace clean my-agent      # specific agent
first-tree agent workspace clean --ttl 14       # custom TTL (days)
```

### Bindings (Feishu)

```bash
# Bind Feishu bot to an agent
first-tree agent bind bot --platform feishu --app-id <id> --app-secret <secret>

# Bind Feishu user to a human agent
first-tree agent bind user <humanAgentId> --platform feishu --feishu-id <ou_xxx>
```

### Messaging — see the `chat` command group

Day-to-day messaging lives under `first-tree chat`. See the
[chat](#chat) section below. Low-level SDK debugging (`register` / `pull`)
moved to the hidden `agent debug` subgroup; run `first-tree agent
debug --help` to list those.

### Agent → user structured questions (Claude runtime)

Claude-runtime agents can pause execution mid-turn and prompt the operator with a structured `AskUserQuestion` (single- or multi-select, up to 4 parallel questions, optional HTML / Markdown previews per option). The Hub bridges this through the inbox so the question lands on the Web chat as a clickable card; the operator's choice is then fed back to the agent and the turn continues.

- **Activation**: automatic for any agent on `runtimeProvider: claude-code` — no CLI flag.
- **UI**: the question renders inline in the chat timeline as a card with three states (pending / answered / superseded).
- **Lifecycle**: a pending question is auto-superseded when the chat session is archived (`agent session terminate`) or when the owning client is reclaimed by a different user (`first-tree login <token> --override`). The agent receives a clean deny in either case.

## chat

Day-to-day messaging — send messages, list chats, view history, open an interactive REPL.

```bash
# Send a message to an agent (positional is the agent name).
# The recipient MUST already be a participant of your current chat.
first-tree chat send <agentName> "hello"
echo "piped message" | first-tree chat send <agentName>

# Pull a non-member into your current chat first, then send normally.
# Replaces the retired `chat send --direct` escape hatch — Hub keeps a single
# group-chat model, so there is no side-conversation fallback.
first-tree chat invite <agentName>
first-tree chat send <agentName> "now we can talk"

# Attach metadata
first-tree chat send <agentName> "hello" -m '{"priority":"high"}'

# List chats / view history
first-tree chat list
first-tree chat history <chatId>

# Open an interactive REPL chat with an agent
first-tree chat open <agent-name>
```

`chat invite <agentName>` adds the named agent to the chat identified by
`FIRST_TREE_CHAT_ID` (the chat the running agent session is bound to).
The lookup is org-scoped, so the named agent must live in the same
organization as the chat; cross-org adds return 404. The command only
works inside an agent session — there is no `--chat` override.

`--agent <name>` selects the SENDER when multiple agents are configured
locally (single-agent installs can omit it). The recipient is always the
positional argument.
- **Codex runtime**: not supported. The Codex SDK has no ask-user surface; codex-runtime agents that try to emit a question are rejected with HTTP 403 by the server (`assertSenderMayEmitQuestion`).

No CLI command is required to use the feature — it shows up automatically when a Claude-runtime agent calls `AskUserQuestion` during a turn.

## client config

Read / write the local `client.yaml` for this machine. Scope is implicit
(this client's YAML at `~/.first-tree/config/client.yaml`).

```bash
first-tree config show                    # print every key/value
first-tree config show update.policy      # print a single dotted key
first-tree config show --show-secrets     # un-mask secret fields
first-tree config set update.policy auto
first-tree config get update.policy       # alias for `show <key>`
```

Agent-side runtime configuration (model / prompt / MCP / env / repos)
lives in `first-tree agent config ...` and mutates the Hub database
via the admin API.

## Onboarding a new agent

The dedicated `onboard` command was retired in favor of explicit `agent`
verbs. Today onboarding is a sequence:

```bash
# 1. Log this machine into the Hub (one-time)
first-tree login <connect-token>

# 2. Create the agent record on the Hub + bind it to this client
first-tree agent create alice --type human --client-id <this-client-id>

# 3. Start the daemon (auto-installs on macOS/Linux via `login`)
first-tree daemon start
```

For Feishu bot / user bindings see `first-tree agent bind`.

## upgrade

Self-update for the CLI. Queries the npm registry for the latest published version, installs it globally, refreshes the systemd unit / launchd plist on top of the new bits, then restarts the client service.

```bash
first-tree upgrade              # Install latest + refresh unit + restart service
first-tree upgrade --check      # Only check; print "update available" or "already on latest"
first-tree upgrade --no-restart # Install latest + refresh unit, but leave the running service alone
```

`--no-restart` is for staged rollouts where the operator wants to time the cutover. Refusing to run from a source checkout (anywhere with a `.git` ancestor) is intentional — keeps a dev build from accidentally `npm i -g`-overwriting a prod global.

## Environment Variables

Most environment variables use the `FIRST_TREE_` prefix. `onboard` also accepts `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. When set, interactive prompts automatically skip the corresponding field.

### Global

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_HOME` | Override the CLI home directory for config, data, cloned Context Tree, and onboard resume state | channel-dependent: `~/.first-tree` (prod), `~/.first-tree-staging` (staging), `~/.first-tree-dev` (dev) |

### Server (SaaS internal)

These vars configure the SaaS-hosted server and are not exercised by the
public CLI. They are listed here for reference only — the `server` runtime
runs in the SaaS Docker image (`packages/server/dist/index.mjs`).

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_DATABASE_URL` | PostgreSQL connection URL | — (required) |
| `FIRST_TREE_PORT` | Server port | `8000` |
| `FIRST_TREE_HOST` | Bind address | `0.0.0.0` |
| `FIRST_TREE_JWT_SECRET` | JWT signing key | — (required) |
| `FIRST_TREE_ENCRYPTION_KEY` | Adapter credential encryption key | — (required) |
| `FIRST_TREE_WEB_DIST_PATH` | Web static files path. The Docker image presets this to `/app/packages/server/web-dist`. | — |
| `FIRST_TREE_PUBLIC_URL` | Public-facing hub URL. Stamped as the `iss` claim on connect tokens (so `connect <token>` derives the hub URL with no extra arg) and used to build invite-link URLs + the GitHub OAuth callback. **Required in production.** | request `Host` (dev only) |
| `FIRST_TREE_GITHUB_OAUTH_CLIENT_ID` | GitHub OAuth App client ID. Enables `/signup` + `/auth/github/start`. Both client id AND secret must be set together. | — |
| `FIRST_TREE_GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret. | — |
| `FIRST_TREE_GITHUB_OAUTH_DEV_CALLBACK` | Opt-in to the `/auth/github/dev-callback` shortcut (no-op github round-trip, dev only). Always disabled when `NODE_ENV=production`. | `false` |

### Client

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_SERVER_URL` | Server URL | interactive prompt |
| `FIRST_TREE_LOG_LEVEL` | Log level (`debug`/`info`/`warn`/`error`) | `info` |

### Agent (messaging commands)

Auth is the signed-in member's JWT — no per-agent token env vars. The
runtime injects these so an agent process can talk to the Hub without
extra setup:

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_ACCESS_TOKEN` | User member access JWT (short-lived). Injected by the runtime. |
| `FIRST_TREE_AGENT_ID` | The agent's own UUID — the CLI uses it to identify the SENDER. |
| `FIRST_TREE_CHAT_ID` | The chat the agent session is bound to. |
| `FIRST_TREE_SERVER_URL` | Server URL override for `chat send` / `chat list` / `chat history`. Falls back to client config. |

Per-agent bearer tokens are gone — logging in writes a member JWT to
`credentials.json` and every agent on that machine authenticates as
the signed-in member.

### Onboard

| Variable | Purpose |
|---------|------|
| `FIRST_TREE_SERVER_URL` | Hub server URL alternative to `--server` |
| `FEISHU_APP_ID` | Feishu bot App ID alternative to `--feishu-bot-app-id` |
| `FEISHU_APP_SECRET` | Feishu bot App Secret alternative to `--feishu-bot-app-secret` |

### Observability (server)

| Variable | Purpose | Default |
|---------|------|--------|
| `FIRST_TREE_LOG_LEVEL` | Log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) | `info` |
| `FIRST_TREE_OTEL_ENDPOINT` | OTLP/HTTP traces endpoint. Non-empty value enables tracing | `""` (disabled) |
| `FIRST_TREE_OTEL_HEADERS` | OTLP headers in `key1=val1,key2=val2` format (secret — typically holds the write token) | `""` |
| `FIRST_TREE_OTEL_ENVIRONMENT` | Deployment environment label (`development` / `staging` / `production` / …) — emitted as `deployment.environment.name` | `development` |

See [observability.md](observability.md) for the full config reference, backend cheat sheet, and troubleshooting recipes.

## Directory Structure

```
~/.first-tree/
├── .onboard-state.json           # Saved args for onboard resume
├── config/                      # Configuration (human-edited)
│   ├── client.yaml
│   └── agents/
│       ├── my-agent/agent.yaml
│       └── another/agent.yaml
└── data/                        # Runtime data (system-managed)
    ├── context-tree-repos/       # Server-managed readonly Context Tree mirrors
    ├── sessions/                # Agent session registry
    └── workspaces/              # Per-chat isolated workspaces
        └── <agent-name>/
            └── <chatId>/
```

If `FIRST_TREE_HOME` is set, replace `~/.first-tree/` with that location.

## Config Resolution Order

Priority from high to low:

1. CLI arguments
2. Environment variables (`FIRST_TREE_*`)
3. Config files (`~/.first-tree/config/client.yaml`)
4. Built-in defaults
