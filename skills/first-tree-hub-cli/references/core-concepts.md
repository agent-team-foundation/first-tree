# First Tree Hub Core Concepts

## Product Boundary

First Tree Hub is shared infrastructure for agent teams.

- It provides agent identity management, authentication, messaging, adapter bridges, background agent runtime, and the admin dashboard.
- It is **not** the LLM agent runtime itself.
- It is **not** the orchestration framework.
- It is **not** the Context Tree.

Use this distinction consistently when explaining the system or choosing where a change belongs.

## Package Roles

- `packages/server` — Fastify API server, admin APIs, agent APIs, database access, adapters, notifications.
- `packages/client` — Agent SDK, client runtime, WebSocket connection management, workspace/session handling.
- `packages/command` — Unified CLI entry point plus reusable core orchestration helpers (auth, service install, onboard, doctor, Docker Postgres, Feishu binding).
- `packages/shared` — Zod schemas, TypeScript types, and the schema-driven config system shared across packages.
- `packages/web` — React admin dashboard served by the server.

The command package depends on server and client packages, but it is still an entry layer — keep business logic in reusable `core/*` modules instead of duplicating it in Commander handlers.

## Architecture Invariants

### PostgreSQL is the single persistent system

- Persistent business state lives in PostgreSQL.
- The server is otherwise stateless.
- There is no Redis or separate message queue in the intended design.

### Agent identity is managed by Hub

- Agent identities are created, updated, and owned via Admin API (used both by the web UI and by the CLI's `agent create` / `agent claim` / `onboard`).
- Agent profile (markdown self-description) is stored in the `agents.profile` column.
- Each agent has exactly one `clientId` — the machine that runs it. Bind with `agent bind client <name> --client-id <id>`; the field is immutable once set.
- Context Tree integration is optional — when configured, the client injects organizational context (`AGENT.md`, root `NODE.md`) into agent workspaces at startup.

### Inbox is the server-client boundary

- The server writes messages to inbox rows.
- Delivery is fan-out on write and **at-least-once**.
- Clients receive WebSocket notifications and can also pull via SDK.
- The client side is responsible for deduplication and session/workspace management.

### Auth uses one credential, everywhere

- Clients sign in once via `client connect`, which persists a member access JWT + refresh token in `~/.first-tree/hub/credentials.json`.
- Every subsequent CLI call runs through `ensureFreshAccessToken()`, which auto-refreshes 30s before expiry via `/api/v1/auth/refresh`.
- Admin actions, agent-owner actions, Feishu binding, `agent config` mutations, and SDK debug calls all use the same member JWT. Server enforcement is role-based.
- There is no separate admin JWT or per-agent bearer token in the current model. The legacy `FIRST_TREE_HUB_AGENT_TOKEN` / `FIRST_TREE_HUB_AGENT` env vars and `agent token bootstrap` command are gone.

### Messages are immutable and time-ordered

- Message IDs use UUID v7.
- Messages are treated as immutable after creation.

## Runtime Mental Model

### Server startup

`server start` is more than "run Fastify".

It can:

- collect missing config interactively
- provision PostgreSQL via Docker if the user did not provide one
- run migrations
- create the first admin account on an empty database
- discover or build the web dist
- start the server with a generated instance ID

### Client startup

`client start` runs every locally configured agent against one Hub server.

The client runtime:

- loads `~/.first-tree/hub/credentials.json` (member JWT + refresh)
- reads `client.yaml` for `server.url` and `client.id`
- reads every agent's local alias YAML to resolve `name → agentId`
- establishes WebSocket and HTTP communication, refreshing the access token on demand
- watches the agents config directory for hot-add
- manages session state and isolated chat workspaces
- optionally syncs a shared Context Tree clone for organizational context

The **background service** is installed automatically by `client connect` (skip with `--no-service`). It runs `client start --no-interactive` under launchd (macOS) or `systemd --user` (Linux), with logs at `~/.first-tree/hub/logs/`. This is how a machine stays online across reboots without a terminal. There is no `client service ...` CLI subcommand — `client doctor` shows current state, manual lifecycle ops go through `launchctl` / `systemctl` directly (see `docs/cli-reference.md`).

### Workspace bootstrap

When a handler starts, the client runtime bootstraps a per-chat workspace and writes `.agent/` files:

- `self.md` from the agent's `profile` field (stored in Hub).
- If Context Tree is configured:
  - `agent-instructions.md` from the root `AGENT.md`
  - `domain-map.md` from the root `NODE.md`

## Onboarding Mental Model

`onboard` is intentionally higher-level than the rest of the CLI.

- It creates the agent via Admin API, optionally creates a personal assistant, optionally binds a Feishu bot, and saves the local alias — all in one step.
- It uses the signed-in member's JWT (from `credentials.json`). If no credentials exist, it exits with a clear pointer to `client connect`.
- `--check` performs a dry-run that surfaces exactly which fields are missing, using the same check logic as the real path.

Do not replace `onboard` with ad hoc Admin API calls unless the user explicitly wants to bypass the supported flow for development or debugging.

## Common Misunderstandings to Avoid

- Do not say `agent add` creates an agent on the Hub. It only writes a local alias (`agents/<name>/agent.yaml`) mapping a friendly name to an existing `agentId`. Use `agent create` to create a server-side row.
- Do not say `client start` starts the server. It only runs configured agent clients against a server that must already be running.
- Do not say the Context Tree owns agent identity. Hub does. Context Tree is an optional organizational knowledge source.
- Do not frame the inbox as exactly-once delivery. The contract is at-least-once with client-side deduplication.
- Do not reach for `FIRST_TREE_HUB_AGENT_TOKEN` or `FIRST_TREE_HUB_AGENT`. Neither env var is read by the CLI anymore; all auth flows through `credentials.json`.
- Do not conflate `agent config ...` (server-side runtime configuration) with `config -a <name> ...` (local YAML editing for the alias file). Both are legitimate; they operate on different state.
