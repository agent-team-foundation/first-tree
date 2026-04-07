# First Tree Hub Core Concepts

## Product Boundary

First Tree Hub is shared infrastructure for agent teams.

- It provides agent identity management, authentication, messaging, adapter bridges, and the admin dashboard.
- It is not the LLM agent runtime itself.
- It is not the orchestration framework.
- It is not the Context Tree.

Use this distinction consistently when explaining the system or choosing where a change belongs.

## Package Roles

- `packages/server`
  - Fastify API server, admin APIs, agent APIs, database access, adapters, notifications
- `packages/client`
  - Agent SDK, runtime, WebSocket connection management, workspace/session handling
- `packages/command`
  - Unified CLI entry point plus reusable core orchestration helpers
- `packages/shared`
  - Zod schemas, TypeScript types, and schema-driven config system shared across packages
- `packages/web`
  - React admin dashboard served by the server

The command package depends on server and client packages, but it is still an entry layer. Keep business logic in reusable core modules instead of duplicating it in Commander handlers.

## Architecture Invariants

### PostgreSQL is the single persistent system

- Persistent business state lives in PostgreSQL.
- The server is otherwise stateless.
- There is no Redis or separate message queue in the intended design.

### Agent identity is managed by Hub

- Agent identities are created, updated, and managed via Admin API.
- Agent profile (markdown self-description) is stored in the `agents.profile` column.
- Context Tree integration is optional — when configured, Client injects organizational context (AGENT.md, root NODE.md) into agent workspaces at startup.

### Inbox is the server-client boundary

- The server writes messages to inbox rows.
- Delivery is fan-out on write and at-least-once.
- Clients receive WebSocket notifications and can also pull.
- The client side is responsible for deduplication and session/workspace management.

### Auth paths are isolated

- Agent API uses agent Bearer tokens.
- Admin API uses admin JWT.
- These are separate security domains even on localhost.

### Messages are immutable and time-ordered

- Message IDs use UUID v7.
- Messages are treated as immutable after creation.

## Runtime Mental Model

### Server startup

`server start` is more than "run Fastify".

It can:

- collect missing config interactively
- provision PostgreSQL if the user did not provide one
- run migrations
- create the first admin account
- discover or build the web dist
- start the server with a generated instance ID

### Client startup

`client start` runs all locally configured agents against one Hub server.

The client runtime:

- reads `client.yaml`
- reads all configured agent YAML files
- establishes WebSocket and HTTP communication
- manages session state and isolated chat workspaces
- optionally syncs a shared Context Tree clone for organizational context

### Workspace bootstrap

When a handler starts, the client runtime bootstraps a per-chat workspace and writes `.agent/` files.

- `self.md` from the agent's `profile` field (stored in Hub)
- If Context Tree is configured:
  - `agent-instructions.md` from the root `AGENT.md`
  - `domain-map.md` from the root `NODE.md`

## Onboarding Mental Model

`onboard` is intentionally higher-level than the rest of the CLI.

- It creates the agent via Admin API and bootstraps the token in a single step.
- Admin credentials are required (`FIRST_TREE_HUB_ADMIN_TOKEN` or `FIRST_TREE_HUB_ADMIN_USERNAME` + `FIRST_TREE_HUB_ADMIN_PASSWORD`).
- This is the supported path for creating new members.

Do not replace this with ad hoc API calls unless the user explicitly wants to bypass the normal flow for development or debugging.

## Common Misunderstandings to Avoid

- Do not say that `agent add` creates an identity in Hub. It only creates local client config.
- Do not say that `client start` starts the server. It only runs configured agent clients.
- Do not say that the Context Tree owns agent identity. Hub does. Context Tree is an optional organizational knowledge source.
- Do not frame the inbox as exactly-once delivery. The contract is at-least-once with client-side deduplication.
- Do not mix up admin and agent credentials.
