# First Tree Hub Core Concepts

## Product Boundary

First Tree Hub is shared infrastructure for agent teams.

- It provides identity sync, authentication, messaging, adapter bridges, and the admin dashboard.
- It is not the LLM agent runtime itself.
- It is not the orchestration framework.
- It is not the Context Tree.

Use this distinction consistently when explaining the system or choosing where a change belongs.

## Package Roles

- `packages/server`
  - Fastify API server, admin APIs, agent APIs, database access, sync jobs, adapters, notifications
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

### Context Tree is the source of identity truth

- Agent identities come from a Context Tree GitHub repo.
- The server syncs those identities on startup, periodically, and via manual trigger paths.
- Hub reads the tree and turns it into runtime identity records.
- Removed members are suspended rather than silently forgotten.

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
- syncs a shared Context Tree clone for local context hydration

### Workspace bootstrap

When a handler starts, the client runtime bootstraps a per-chat workspace and writes `.agent/` files.

If the Context Tree clone is available, it copies:

- `self.md` from the agent's `members/.../NODE.md`
- `agent-instructions.md` from the root `AGENT.md`
- `domain-map.md` from the root `NODE.md`

If the Context Tree is unavailable, it writes degraded-mode context so the runtime can continue without organizational metadata.

## Onboarding Mental Model

`onboard` is intentionally higher-level than the rest of the CLI.

- Phase 1 works in the Context Tree repo, not the Hub repo.
- Phase 2 waits for the server to sync the newly merged identity, then bootstraps runtime access.
- This is the supported path for creating new members because identity lives outside Hub itself.

Do not replace this with ad hoc file creation or manual local git operations unless the user explicitly wants to bypass the normal flow for development or debugging.

## Common Misunderstandings to Avoid

- Do not say that `agent add` creates an identity in Hub. It only creates local client config.
- Do not say that `client start` starts the server. It only runs configured agent clients.
- Do not say that Hub owns organizational truth. The Context Tree does.
- Do not frame the inbox as exactly-once delivery. The contract is at-least-once with client-side deduplication.
- Do not mix up admin and agent credentials.
