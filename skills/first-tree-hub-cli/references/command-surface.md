# First Tree Hub Command Surface

## Quick Decision Guide

| User intent | Preferred entry point | Non-obvious note |
| --- | --- | --- |
| Install or verify the CLI on a fresh machine | `npm install -g @agent-team-foundation/first-tree-hub` then `first-tree-hub --version` | Requires Node.js `>= 22.16` |
| Bring up a full local Hub quickly | `first-tree-hub server start` | Interactive on first run; auto-provisions PostgreSQL with Docker, runs migrations, creates the default admin, and serves the web UI |
| Check whether a machine is ready for Hub | `first-tree-hub server doctor` / `client doctor` | `doctor` = readiness; top-level `status` = current state summary |
| See if the server is alive | `first-tree-hub server status` | Hits `/api/v1/health`; defaults to `http://localhost:8000` unless `FIRST_TREE_HUB_SERVER_URL` is set |
| Sign this computer into a Hub server | `first-tree-hub connect <token> [--no-service]` | Paste a connect token from the Hub web console; hub URL is derived from the token's `iss` claim. Stores a member JWT at `~/.first-tree/hub/credentials.json`, writes `client.yaml`, and (by default) installs the background service |
| Run the client inline instead of via service | `first-tree-hub client start` | Loads credentials written by `connect`; fails if there are none or if no agents are pinned to this client |
| Keep the computer online across reboots | `first-tree-hub connect <token>` (omit `--no-service`) | Auto-installs launchd on macOS or `systemd --user` on Linux; Windows unsupported (falls back to inline) |
| List machines the Hub currently sees | `first-tree-hub client list` | Server-side inventory of connected clients |
| Forcibly drop a machine from the Hub | `first-tree-hub client disconnect <clientId>` | Server-side admin action |
| View / edit this machine's client.yaml | `first-tree-hub client config show/set/get` | Local YAML editing; scope is implicit |
| Register a local alias for a Hub agent on this machine | `first-tree-hub agent add [--agent-id <uuid>]` | Local-only; a running client auto-registers any agent an admin pins to this `clientId`, so `agent add` is mostly for scripted or unattended setups |
| Create a fresh agent from the CLI | `first-tree-hub agent create <name> --type <t> --client-id <id>` | Writes to the Hub via Admin API and saves the local alias in one step |
| Take ownership of an existing agent | `first-tree-hub agent claim <agentName>` | Sets `managerId` to the signed-in member |
| Change an agent's runtime config (model, prompt, MCP, env, repos) | `first-tree-hub agent config <sub>` | Server-side edit via `/api/v1/admin/agents/:id/config` — affects the running agent everywhere |
| Day-to-day messaging | `first-tree-hub chat send/list/history/open` | Authenticates as the signed-in member (no agent-specific token) |
| Inspect session runtime state | `first-tree-hub agent status [name]`, `agent session list <name>`, `agent session <suspend\|terminate>` | Reads `/api/v1/admin/agents/activity`, `/admin/sessions/agents/...` |
| Reset an agent stuck in `error` state | `first-tree-hub agent reset <name>` | POSTs `reset-activity` |
| Clean old isolated chat workspaces | `first-tree-hub agent workspace clean` | Respects the session registry — only removes evicted or untracked chats |
| Onboard a new human or autonomous agent | `first-tree-hub onboard` | Guided flow; requires prior `connect <token>` for credentials |

## The Credential Model

Every CLI command that talks to the Hub reaches for `~/.first-tree/hub/credentials.json`. The file is written by `connect <token>` and contains `{ accessToken, refreshToken, serverUrl }` (mode `0600`). `ensureFreshAccessToken()` auto-refreshes against `/api/v1/auth/refresh` when the token is within 30 seconds of expiry, silently re-persists the result, and then returns the fresh access token.

There are no separate admin or agent tokens. The member's JWT is used for every authenticated call — admin endpoints, Feishu binding, agent creation, agent config, messaging, SDK debugging, everything. The old `FIRST_TREE_HUB_AGENT_TOKEN` / `FIRST_TREE_HUB_AGENT` environment variables and the `agent token bootstrap` subcommand have been removed.

If `credentials.json` is missing or refresh fails, the CLI exits with a message pointing at `first-tree-hub connect <token>`. Do not paper over this with manual env vars — run `connect <token>`.

## Command Families

### `server`

Lifecycle for the Hub server process and its PostgreSQL backing store.

- `server start` — best default for first-run local usage. Prompts for missing config unless `--no-interactive` is set; can auto-start a Docker-managed PostgreSQL if no `--database-url` is provided; runs migrations; creates the default `admin` user on an empty database; resolves/builds the web dist so the admin UI is served.
- `server stop` — stops the CLI-managed PostgreSQL container only. It does **not** stop a standalone Fastify process.
- `server doctor` — Node version, Docker availability, server config, database connectivity, GitHub token, Context Tree access, server health.
- `server status` — simple health probe against `/api/v1/health`; defaults to `http://localhost:8000` unless `FIRST_TREE_HUB_SERVER_URL` is set.
- `server migrate` — applies migrations against the configured database.
- `server admin create` — creates a new owner/admin against the configured database (not via HTTP — direct DB access).

### `client`

Everything that is "this computer and its relationship to a Hub server". First-time setup lives at top-level `first-tree-hub connect <token>`.

- `client start` — foreground runtime loop. Loads credentials, initializes config, spins up `ClientRuntime`, watches the agents config directory for hot-add, and stays alive until SIGINT/SIGTERM.
- `client stop` — currently informational; prints the right Ctrl+C / `kill` hint. No daemon PID management yet.
- `client status` — lists locally configured agent aliases with their runtime and agent UUID.
- `client doctor` — Node version, client config, server reachability, agent configs, credential validity, WebSocket reachability, **and the background-service state** (running/inactive/not-installed/unsupported, with unit + log paths).
- `client list [--server <url>]` — enumerates clients currently known to the Hub server (`GET /api/v1/clients`), with hostname, agent count, and last-seen timestamp.
- `client disconnect <clientId> [--server <url>]` — POSTs `/api/v1/clients/:id/disconnect` to force-drop a WebSocket connection on the server side.
- `client config show [key]` / `set <key> <value>` / `get <key>` — view and modify this machine's `client.yaml` (scope is implicit). Add `--show-secrets` to un-mask secret fields on `show` / `get`.

### `agent`

Everything that is "about one or more agent records". Subcommands split into several groups.

**Local aliases**

- `agent add [name] [--agent-id <uuid>]` — writes `~/.first-tree/hub/config/agents/<name>/agent.yaml`. Prompts interactively when arguments are missing. Local-only; does not create an agent on the Hub.
- `agent remove <name>` — deletes the local alias, its workspaces under `data/workspaces/<name>/`, and its session registry file.
- `agent list` — prints every locally configured alias.

**Hub-side creation / ownership**

- `agent create <name> --type <human|personal_assistant|autonomous_agent> --client-id <id> [--runtime <r>] [--display-name <n>] [--server <url>]` — calls `POST /api/v1/admin/agents` then saves the local alias. Requires the target `client-id` to be a machine you own (run `connect <token>` on that machine first).
- `agent claim <agentName>` — sets `managerId` to the signed-in member via `PATCH /api/v1/admin/agents/:id`. Admins can claim any agent; non-admins can only self-claim unmanaged ones.

**Runtime configuration** (server-side — see also `agent-config.ts`)

- `agent config show <agent>` — prints the current `AgentRuntimeConfig` (model, prompt.append, mcpServers, env, gitRepos) with secrets masked.
- `agent config set-model <agent> <model>` — replaces the `model` field (e.g. `claude-opus-4-7`).
- `agent config append-prompt <agent> [-f <file>]` — replaces the `prompt.append` text; reads stdin if `-f` is absent.
- `agent config add-mcp <agent> --name <n> --transport <stdio|http|sse> [--command / --args] [--url]` — replace-by-name semantics; use `stdio` for `--command`/`--args`, or `http`/`sse` for `--url`.
- `agent config set-env <agent> <KEY=VALUE> [--sensitive]` — replace-by-key semantics. `--sensitive` encrypts at rest and masks in echo.
- `agent config add-repo <agent> <url> [--ref <r>] [--path <p>]` — adds (or replaces by URL) a Git repo for the agent's worktree set.
- `agent config dry-run <agent> -f <patch.json>` — validates a partial payload against the current version and prints the diff without persisting.

All `agent config` subcommands call `GET`/`PATCH`/`POST dry-run` on `/api/v1/admin/agents/:id/config`, enforce optimistic concurrency by sending `expectedVersion`, and require the signed-in member to have admin scope on the target.

**Workspaces**

- `agent workspace clean [agent-name] [--ttl <days>]` — removes workspace directories under `~/.first-tree/hub/data/workspaces/<name>/` that are older than TTL (default 7 days) and not currently referenced by an active session in the registry.

**Bindings**

- `agent bind client <agentName> --client-id <id>` — first-time bind of an agent to a client machine. The `clientId` field on the agent is immutable once set, so this is a one-shot operation; use it for seeding, scripting, or recovery.
- `agent bind bot --platform feishu --app-id <id> --app-secret <s>` — binds a Feishu bot to this agent (self-service via the adapter API).
- `agent bind user <humanAgentId> --platform feishu --feishu-id <ou_xxx>` — binds a Feishu user to a human agent for `delegate_mention` routing.

**Sessions**

- `agent status [name]` — reads `/api/v1/admin/agents/activity` for a live snapshot (running count, state breakdown, per-agent runtime + session count).
- `agent reset <name>` — POSTs `reset-activity` to move an agent out of `error` state.
- `agent session list <agent-name> [--state <s>]` — lists sessions via `/api/v1/admin/sessions/agents/:id`.
- `agent session suspend|terminate <agent-name> <chat-id>` — POSTs the corresponding session lifecycle endpoint.

**Low-level SDK debug (hidden from `agent --help`)**

- `agent debug register` — proxies `sdk.register()` for identity confirmation.
- `agent debug pull [-l] [--ack]` — low-level inbox polling; `--ack` acknowledges all returned entries.

Day-to-day messaging — `chat send / list / history / open` — lives in the `chat` command group below.

### `chat`

Messaging surface for agents and operators. All four subcommands accept
`--agent <name>` to select the SENDER when multiple agents are configured
locally (single-agent installs can omit it).

- `chat send <agentName> [message] [-f format] [--direct] [-m '<json>'] [--reply-to] [--reply-to-inbox] [--reply-to-chat]` — sends a message to an agent by name. Defaults to the sender's current chat; pass `--direct` to open/reuse a direct chat when the recipient is not a member. Reads from stdin when `[message]` is omitted.
- `chat list [-l <limit>] [--cursor]` — list chats this agent participates in (cursor-paginated, 1–100 per page).
- `chat history <chatId> [-l <limit>] [--cursor]` — show history for a chat (cursor-paginated, 1–100 per page).
- `chat open <agent-name>` — opens an admin-scoped REPL against the agent: creates a DM chat, polls messages every 2s, writes to the chat, exits on Ctrl+C.

### `client config`

Local YAML editing for this machine's `client.yaml`. Scope is implicit;
there are no `-s` / `-c` / `-a` flags.

- `client config show [key] [--show-secrets]` — without a key, flat dump of every value; with a key, print one dotted value. Secret fields mask unless `--show-secrets`.
- `client config set <key> <value>` — sets a dotted key. Values matching `^\d+$`, `true`, or `false` are auto-coerced.
- `client config get <key> [--show-secrets]` — alias for `show <key>` (kept for scripts that pre-date the rename).

Server-side YAML (`server.yaml`) is configured via env vars or by
hand-editing the file. Agent-side runtime configuration lives under
`agent config ...`, which mutates the Hub database via the admin API, not
a local file.

### `onboard`

High-level guided onboarding flow. Composes agent creation, optional assistant creation, and optional Feishu bot binding into one command. Supports a `--check` dry-run that prints the readiness checklist, and persists partial state to `~/.first-tree/hub/.onboard-state.json` so interactive re-runs pick up where they left off.

Important: `onboard` depends on a valid credential file. If `loadCredentials()` returns null, the command errors out and points at `first-tree-hub connect <token>`. It does **not** try to log the user in itself.

## Config and Environment Model

### Priority

1. CLI args
2. Environment variables
3. YAML config files
4. Auto-generated values (secrets, Docker PG URL, `client.id`)
5. Built-in defaults

### Paths

- Home: `~/.first-tree/hub` by default; override with `FIRST_TREE_HUB_HOME`.
- `$HOME/credentials.json` — member JWT + refresh token.
- `$HOME/config/server.yaml`
- `$HOME/config/client.yaml`
- `$HOME/config/agents/<name>/agent.yaml`
- `$HOME/.onboard-state.json`
- `$HOME/logs/` — background service stdout/stderr
- `$HOME/context-tree/` — optional organizational clone
- `$HOME/data/sessions/`, `$HOME/data/workspaces/<agent>/<chatId>/`, `$HOME/data/postgres/`

### Environment variables

**Global**
- `FIRST_TREE_HUB_HOME`

**Server**
- `FIRST_TREE_HUB_DATABASE_URL`
- `FIRST_TREE_HUB_PORT`
- `FIRST_TREE_HUB_HOST`
- `FIRST_TREE_HUB_JWT_SECRET`
- `FIRST_TREE_HUB_ENCRYPTION_KEY`
- `FIRST_TREE_HUB_CONTEXT_TREE_REPO`
- `FIRST_TREE_HUB_GITHUB_TOKEN`
- `FIRST_TREE_HUB_WEB_DIST_PATH`

**Client**
- `FIRST_TREE_HUB_SERVER_URL` — overrides `client.yaml`'s `server.url` at call time.
- `FIRST_TREE_HUB_LOG_LEVEL`

**Onboard**
- `FIRST_TREE_HUB_SERVER_URL`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`

No agent-specific token env vars exist anymore. If you see a guide or old script setting `FIRST_TREE_HUB_AGENT_TOKEN` or `FIRST_TREE_HUB_AGENT`, it's stale — the CLI ignores both.

## Admin API Endpoints the CLI Calls

Useful when debugging or when a user wants to script around the CLI. All calls authenticate with the member JWT.

- Auth: `POST /api/v1/auth/connect-token`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`
- Me: `GET /api/v1/me`
- Clients: `GET /api/v1/clients`, `POST /api/v1/clients/:id/disconnect`
- Agents (admin): `GET /api/v1/admin/agents`, `POST /api/v1/admin/agents`, `PATCH /api/v1/admin/agents/:id`
- Agent config: `GET|PATCH /api/v1/admin/agents/:id/config`, `POST /api/v1/admin/agents/:id/config/dry-run`
- Agent activity: `GET /api/v1/admin/agents/activity`, `POST /api/v1/admin/agents/activity/:name/reset-activity`
- Sessions: `GET /api/v1/admin/sessions/agents/:id`, `POST /admin/sessions/agents/:id/:chatId/{suspend|resume|terminate}`
- Admin chat: `POST /api/v1/admin/agents/:id/chats`, `GET|POST /api/v1/admin/chats/:id/messages`
- Health: `GET /api/v1/health`

## When to Read Other Docs

- `docs/cli-reference.md` — the canonical public flag/env reference.
- `docs/onboarding-guide.md` — end-to-end onboarding walkthrough and type-specific notes.
- `docs/claim-agent-guide.md` — claim + Feishu binding details.
- `docs/deployment-guide.md` — Docker, Railway, Render, Supabase, HTTPS, multi-machine.
