# AGENTS.md

Agent Hub — centralized collaboration platform for Agent Team (Server + Client + Command + Shared + Web monorepo).

## Overview

Agent Hub is the infrastructure for Agent Team, providing agent registration/authentication, messaging, external IM bridging, and an admin dashboard.

```
Agent Hub ≠ Agents themselves (LLM agent logic lives outside Hub)
Agent Hub ≠ Orchestration framework
Agent Hub ≠ Context Tree
```

## Tech Stack

**Server:** Fastify / Drizzle ORM / PostgreSQL / Zod / bcrypt / jose / @fastify/websocket / @fastify/rate-limit

**Client:** fetch + ws (SDK + AgentRuntime + pluggable Handlers)

**Command:** Commander.js / @inquirer/prompts (unified CLI)

**Shared:** Zod schemas + TypeScript types + config system (shared across all packages)

**Web:** React 19 / Vite

**Tooling:** pnpm (workspace) / Turborepo / Biome / Vitest / tsdown / tsc

**Node.js:** minimum 22.16, recommended 24

## Common Commands

```bash
# Environment
pnpm install                          # Install all dependencies
docker compose up -d                  # Start PostgreSQL (dev)

# One-command start (CLI, interactive config + auto-migration + embedded Web)
pnpm --filter @unispark.ai/agent-hub dev -- server start

# Separate start (traditional dev)
pnpm --filter @agent-hub/server dev   # Start server (tsx watch, requires .env)
pnpm --filter @agent-hub/web dev      # Start web (Vite dev server)

# Quality
pnpm check                            # Biome lint + format check
pnpm format                           # Biome format
pnpm typecheck                        # tsc --noEmit
pnpm test                             # Vitest
pnpm --filter @agent-hub/server test  # Test (server only)

# Build
pnpm build                            # Turborepo orchestrated full build

# Database
pnpm --filter @agent-hub/server db:generate    # Generate migrations
pnpm --filter @agent-hub/server db:migrate     # Apply migrations
pnpm --filter @agent-hub/server db:studio      # Drizzle Studio
```

> Full CLI commands and environment variables: [docs/cli-reference.md](docs/cli-reference.md)

## Monorepo Structure

```
agent-hub/
├── package.json               # pnpm workspace root config
├── pnpm-workspace.yaml        # Workspace members
├── turbo.json                 # Turborepo task orchestration
├── tsconfig.json              # Root tsconfig (project references)
├── biome.json                 # Biome lint + format
├── docker-compose.yml         # Local dev PostgreSQL
│
├── docs/                          # Documentation
│   ├── cli-reference.md          # CLI commands + env var reference
│   └── claim-agent-guide.md      # Claim Agent setup guide
│
├── packages/
│   ├── shared/                # @agent-hub/shared — Shared Zod schemas + types + config system
│   ├── server/                # @agent-hub/server — Fastify API server
│   ├── client/                # @agent-hub/client — Agent SDK + Runtime
│   ├── command/               # @unispark.ai/agent-hub — Unified CLI (published package)
│   └── web/                   # @agent-hub/web — React admin dashboard
```

## Architecture Rules

**Five independent packages, Shared in common:** Server, Client, Command, Web are independently packaged and deployed, sharing types, Zod schemas, and config system via `@agent-hub/shared`. Command is the unified CLI entry point, depending on Server and Client.

**Stateless Server:** All persistent data lives in PostgreSQL. Server holds no business state.

**PostgreSQL only:** No Redis / MQ. PG covers storage, queuing (SKIP LOCKED), and notifications (LISTEN/NOTIFY).

**Dual-track auth isolation:**
- Agent Token (Bearer) → Agent API — machine credentials
- Admin JWT → Admin API — human credentials
- Two auth paths are **completely isolated**; localhost must authenticate too

**Inbox is the Server/Client boundary:** Server writes to Inbox (fan-out on write), Client pulls / receives WebSocket notifications. At-least-once delivery; Client is responsible for deduplication.

**Context Tree is the single source of agent identity:** Server syncs agent identities from the Context Tree GitHub repo via GraphQL API (on startup + periodic + manual trigger). Server reads only, never writes back; agents are suspended (not deleted) when removed from the tree; token management remains manual. PG advisory lock ensures single-instance sync.

**Adapter 1:1 identity binding:** External IM users (Feishu/Slack) map to human agents. Adapter credentials are AES-256-GCM encrypted at the application layer. PG NOTIFY triggers adapter config hot-reload.

**UUID v7 as Message ID:** Time-ordered; messages are immutable after creation.

## Coding Conventions

- **No `any`**: Use `unknown` + type narrowing
- **No `as` assertions**: Unless unavoidable with third-party libs; add comment explaining why
- **No `enum`**: Use `as const` objects for Zod compatibility
- **Type imports**: `import type { Foo } from ...`
- **Prefer `type`**: Use `interface` only when `extends` / `implements` is needed
- **Public APIs must have explicit return types**; internal functions may rely on inference
- **Barrel exports**: Each package's `src/index.ts` is the sole public entry point
- **Zod as single source of truth**: Define DTOs with Zod, derive types via `z.infer<typeof schema>`
- **Schema naming**: schemas in camelCase (`createAgentSchema`), types in PascalCase (`CreateAgent`)
- **Never hand-edit Drizzle migrations**: `drizzle-kit generate` to create, `drizzle-kit migrate` to apply
- **Custom error classes**: Services throw exceptions, API layer maps to HTTP status codes; no empty `catch {}`
- **Naming**: files `kebab-case.ts`, types `PascalCase`, variables/functions `camelCase`, constants `UPPER_SNAKE_CASE`
- **English everywhere on GitHub**: All GitHub-visible content must be in English — code, comments, JSDoc, TODO, commit messages, PR titles/descriptions, issue titles/descriptions, branch names, release notes, CI logs, and any other content visible in the repository
- **Run after changes**: `pnpm check && pnpm typecheck`

## Development Workflow

### New Feature Steps (Server)

1. Define Zod schema (`shared/src/schemas/`)
2. Define Drizzle table (`server/src/db/schema/`) — if persistence is needed
3. Implement service (`server/src/services/`)
4. Define API routes (`server/src/api/`)
5. Generate migration: `pnpm --filter @agent-hub/server db:generate`
6. Apply migration: `pnpm --filter @agent-hub/server db:migrate`
7. Write tests (`server/src/__tests__/`)

### New Feature Steps (Client)

1. New SDK method → add in `client/src/sdk.ts`
2. New handler type → implement and register in `client/src/handlers/`
3. Runtime changes → `client/src/runtime/` (AgentRuntime / AgentSlot / SessionManager)
4. If shared types are involved → update `shared/src/schemas/` first

### New Feature Steps (Command)

1. Add command module in `command/src/commands/`
2. Register command in `command/src/cli/index.ts`
3. If config changes are needed → update schema in `shared/src/config/`

### Git Conventions

- **Branching**: trunk-based; feature branch → PR → squash merge → main
- **Branch naming**: `feat/xxx`, `fix/xxx`, `refactor/xxx`, `test/xxx`, `docs/xxx`, `chore/xxx`
- **Commit messages**: Conventional Commits — `feat: xxx`, `fix: xxx`, `refactor: xxx`, `test: xxx`, `docs: xxx`
- **Releases**: tag + GitHub Release
- Do not auto-commit; wait for user to test and confirm before committing
