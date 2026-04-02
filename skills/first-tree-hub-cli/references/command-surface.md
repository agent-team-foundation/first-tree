# First Tree Hub Command Surface

## Quick Decision Guide

| User intent | Preferred entry point | Non-obvious note |
| --- | --- | --- |
| Bring up a full local Hub quickly | `first-tree-hub server start` | Interactive on first run; can auto-provision PostgreSQL with Docker, run migrations, create the default admin, and serve the embedded web UI |
| Check whether a machine is ready for Hub | `first-tree-hub server doctor` or `first-tree-hub client doctor` | `doctor` is readiness-oriented; top-level `status` is a current-state summary |
| See if the server is alive | `first-tree-hub server status` | Hits `/api/v1/health`; defaults to `http://localhost:8000` unless `FIRST_TREE_HUB_SERVER_URL` is set |
| Start all configured agents | `first-tree-hub client start` | Loads every agent config under `~/.first-tree-hub/config/agents/` |
| Manage local config files | `first-tree-hub config ...` | Scope defaults to server unless `-c` or `-a <name>` is passed |
| Add or remove a local agent config | `first-tree-hub agent add/remove/list` | This is local configuration, not Context Tree identity management |
| Bootstrap an agent token from GitHub identity | `first-tree-hub agent token bootstrap <agentId>` | Requires `gh` auth and a Hub server that already knows the agent |
| Send or inspect debug messages as an agent | `first-tree-hub agent send/chats/history/pull/register` | Requires `FIRST_TREE_HUB_TOKEN`; these are low-level debugging utilities |
| Clean old isolated chat workspaces | `first-tree-hub agent workspace clean` | Removes stale workspaces only when there is no active non-evicted session |
| Onboard a new human or autonomous agent | `first-tree-hub onboard` | Creates a PR in the Context Tree repo, not in `first-tree-hub` itself |

## Command Families

### `server`

- `server start`
  - Best default for first-run local usage.
  - Prompts for missing required server config unless `--no-interactive` is used.
  - If no database URL is provided, it can auto-start a managed PostgreSQL container via Docker.
  - Runs migrations automatically.
  - Creates the default `admin` user if the database has none.
  - Resolves or builds the web dist so the server can host the admin UI.
- `server stop`
  - Only stops the managed PostgreSQL container used by the CLI workflow.
  - It does not stop an already-running standalone Fastify process.
- `server doctor`
  - Checks Node version, Docker availability, server config, database connectivity, GitHub token, Context Tree access, and server health.
- `server status`
  - Performs a health request against `/api/v1/health`.
- `server db:migrate`
  - Uses the configured database and applies migrations.
- `server admin:create`
  - Creates an admin user directly against the configured database.

### `client`

- `client start`
  - Initializes client config, loads all configured agents, creates a `ClientRuntime`, and keeps it alive until interrupted.
  - Fails if there are no configured agents.
- `client doctor`
  - Checks Node version, client config, server reachability, agent configs, token validity, and WebSocket reachability.
- `client status`
  - Lists configured local agents and masked tokens.
- `client stop`
  - Currently informational only; there is no daemon manager yet.

### `agent`

- `agent add [name]`
  - Writes `~/.first-tree-hub/config/agents/<name>/agent.yaml`.
  - Prompts interactively if name or token is missing.
- `agent remove <name>`
  - Deletes the agent config and also removes runtime workspaces and the saved session registry for that agent.
- `agent list`
  - Reads local configured agents and masks tokens in output.
- `agent workspace clean [agent-name] [--ttl <days>]`
  - Cleans stale workspace directories under `~/.first-tree-hub/data/workspaces/`.
  - Skips chat workspaces that still have an active session in the session registry.
- `agent token bootstrap <agentId>`
  - Uses GitHub identity and the server's bootstrap endpoint to create or retrieve an agent token.
  - `--save-to agent` stores the token in the local agent config by default.
- `agent bind ...`
  - Used for Feishu bindings. Read `docs/claim-agent-guide.md` when claim/bind flows matter.
- `agent send/chats/history/register/pull`
  - These are SDK-style debugging commands.
  - They require `FIRST_TREE_HUB_TOKEN`.
  - `send` supports direct target vs `--chat`, stdin piping, and reply metadata.
  - `pull` is the low-level inbox polling path.

### `config`

- `config setup`
  - Runs schema-driven interactive prompts for server or client config.
- `config set/get/list`
  - Supports `-s/--server`, `-c/--client`, and `-a <name>/--agent <name>`.
  - Defaults to server scope if no scope flag is provided.
  - `list` and `get` hide secret fields unless `--show-secrets` is passed.

### Top-Level `status`

- Summarizes:
  - Current server health
  - Database config presence
  - Number of local configured agents
  - Whether client config exists and what server URL it points to
- Use this when the user asks for a compact overall state, not a deep readiness diagnosis.

### `onboard`

- `onboard --check`
  - Shows readiness and missing inputs without making changes.
- `onboard`
  - Phase 1 workflow.
  - Resolves or clones the Context Tree repo using server configuration.
  - Creates or updates member `NODE.md` entries in the Context Tree.
  - Verifies the tree with `first-tree verify`.
  - Creates a branch, commit, push, and PR in the Context Tree repo.
- `onboard --continue`
  - Phase 2 workflow after the Context Tree PR is merged.
  - Waits for the server to sync the new agent.
  - Bootstraps the token.
  - Optionally binds a Feishu bot.
  - Writes `client.yaml` so `client start` works without extra setup.

## Config and Environment Model

### Config priority

1. CLI args
2. Environment variables
3. YAML config files
4. Auto-generated values
5. Built-in defaults

### Default config paths

- `~/.first-tree-hub/config/server.yaml`
- `~/.first-tree-hub/config/client.yaml`
- `~/.first-tree-hub/config/agents/<name>/agent.yaml`

### Default runtime paths

- `~/.first-tree-hub/data/sessions/`
- `~/.first-tree-hub/data/workspaces/`
- `~/.first-tree-hub/data/postgres/`

### Important environment variables

- Server:
  - `FIRST_TREE_HUB_DATABASE_URL`
  - `FIRST_TREE_HUB_PORT`
  - `FIRST_TREE_HUB_HOST`
  - `FIRST_TREE_HUB_JWT_SECRET`
  - `FIRST_TREE_HUB_ENCRYPTION_KEY`
  - `FIRST_TREE_HUB_CONTEXT_TREE_REPO`
  - `FIRST_TREE_HUB_GITHUB_TOKEN`
  - `FIRST_TREE_HUB_WEB_DIST_PATH`
- Client:
  - `FIRST_TREE_HUB_SERVER_URL`
  - `FIRST_TREE_HUB_LOG_LEVEL`
- Agent debugging:
  - `FIRST_TREE_HUB_TOKEN`
  - `FIRST_TREE_HUB_SERVER`

## When to Read Other Docs

- Read `docs/cli-reference.md` for the full public command reference.
- Read `docs/onboarding-guide.md` for onboarding examples and type-specific behavior.
- Read `docs/claim-agent-guide.md` for claim-agent and Feishu user binding flows.
- Read `docs/deployment-guide.md` when the request is about Docker, Railway, Render, Supabase, HTTPS, or multi-machine deployment.
