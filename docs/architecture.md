# Architecture

**first-tree** is the unified CLI and infrastructure for agent teams: a pnpm
monorepo of Server + Client + Command + Shared + Web.

What first-tree is **not**:

- not an LLM agent itself (agent logic lives elsewhere)
- not an orchestration framework

## Monorepo Structure

- `packages/shared/` — `@first-tree/shared` — Zod schemas + types + config system (internal, not published)
- `packages/server/` — `@first-tree/server` — Fastify API server (private, bundled)
- `packages/client/` — `@first-tree/client` — Agent SDK + Runtime (private, bundled)
- `packages/web/` — `@first-tree/web` — React admin dashboard (private, bundled)
- `apps/cli/` — `first-tree` — Unified CLI (**published**, the consumer-facing tarball; binaries `first-tree` and `ft`)
- `docs/` — [quickstart.md](quickstart.md), [onboarding-guide.md](onboarding-guide.md), [cli-reference.md](cli-reference.md), [observability.md](observability.md), [migration/](migration/), [development/](development/), [troubleshooting/](troubleshooting/)
- `skills/` — repo-local skill payloads (`first-tree`, `first-tree-context`, `first-tree-onboarding`, `first-tree-sync`, `first-tree-write`); `skills/first-tree/` is the canonical published skill source

## Tech Stack

- **Server:** Fastify / Drizzle ORM / PostgreSQL / Zod
- **Client:** fetch + ws (SDK + AgentRuntime + pluggable Handlers)
- **Command:** Commander.js / @inquirer/prompts (unified CLI)
- **Shared:** Zod schemas + TypeScript types + config system
- **Web:** React 19 / Vite
- **Tooling:** pnpm (workspace) / Turborepo / Biome / Vitest / tsdown
- **Node.js:** minimum 22.16, recommended 24

## Architecture Rules

**Five independent packages, Shared in common:** Server, Client, Command, Web are independently packaged and deployed, sharing types, Zod schemas, and config system via `@first-tree/shared`. Command is the user-facing CLI for client / agent operations and depends only on Client + Shared; Server is shipped separately as the SaaS Docker image.

**Stateless Server:** All persistent data lives in PostgreSQL. Server holds no business state.

**PostgreSQL only:** No Redis / MQ. PG covers storage, queuing (SKIP LOCKED), and notifications (LISTEN/NOTIFY).

**Unified user-JWT auth:** A single user JWT (issued by `first-tree login <token>`, stored at `<channel-home>/config/credentials.json` — `~/.first-tree/` for prod, `~/.first-tree-staging/` for staging, `~/.first-tree-dev/` for dev; see [development/local-dev-isolation.md](development/local-dev-isolation.md)) authorizes both Web/Admin API calls and every agent the user manages on the client WebSocket. JWT shape, route classification, and middleware choice live in [development/http-path-conventions.md](development/http-path-conventions.md) — this section covers only the runtime *binding* facts not in that spec. Agents bind via `agents.client_id` + a server-pushed `agent:pinned` frame; **R-RUN** is re-evaluated at every `agent:bind` against the live `agents → manager → user` join (cross-org under one user is allowed; revoked memberships refuse the bind immediately). Switching user requires `first-tree login <token> --override`, which atomically transfers `clients.user_id` and unpins the previous owner's agents. Legacy per-agent tokens were retired by migration `0020`.

**Inbox is the Server/Client boundary:** Server writes to Inbox (fan-out on write); Client pulls / receives WebSocket notifications. At-least-once delivery; Client deduplicates.

**Agent identity is managed by the server:** Agents are created, updated, suspended, and deleted via the Admin API. Agent profile (markdown self-description) is stored in the `agents.profile` column. Context Tree integration is optional — when configured, Client injects organizational context into agent workspaces at startup.

**Adapter credentials:** Adapter (e.g. Kael) bot credentials are AES-256-GCM encrypted at the application layer. PG NOTIFY triggers adapter config hot-reload.

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
- **English everywhere on GitHub**: all code, comments, commits, PRs, issues, branch names, and CI logs — anything visible in the repo.
- **Run after changes**: `pnpm check && pnpm typecheck`

## Development Workflow

### New Feature Steps (Server)

Zod schema (in `shared`) → Drizzle table (if persistent) → service → API routes → `db:generate` + `db:migrate` → tests. Order matters: types flow left-to-right.

### New Feature Steps (Client)

SDK methods live in `sdk.ts`, handlers register in `handlers/`, runtime changes go in `runtime/` (AgentRuntime / AgentSlot / SessionManager). If shared types are involved, update `shared/` **first** or imports will break.

### New Feature Steps (Command)

1. Business logic → `core/` (exportable, no CLI-specific concerns)
2. CLI registration → `commands/` (thin arg parsing that calls `core/*`)
3. Wire into `cli/index.ts`
4. Export from **both** `core/index.ts` **and** `src/index.ts` — easy to forget, breaks external consumers
5. Config changes → schema in `shared/src/config/`

### Git Conventions

- **Branching**: trunk-based; feature branch → PR → squash merge → main
- **Branch naming**: `feat/xxx`, `fix/xxx`, `refactor/xxx`, `test/xxx`, `docs/xxx`, `chore/xxx`
- **Commit messages**: Conventional Commits — `feat: xxx`, `fix: xxx`, `refactor: xxx`, `test: xxx`, `docs: xxx`
- **Releases**: tag + GitHub Release
- **Do not edit `version` fields in any `package.json`.** Version bumps are handled by CI on tag push, or manually by a maintainer cutting a tag. Coding agents must not touch `version` as part of a feature/fix PR.
- Do not auto-commit; wait for user to test and confirm before committing

## Required Reading by Topic

- **HTTP routes / JWT / multi-org:** [development/http-path-conventions.md](development/http-path-conventions.md) — single source of truth for route naming, JWT shape, and middleware choice
- **Local testing isolation (parallel dev / staging / prod CLIs):** [development/local-dev-isolation.md](development/local-dev-isolation.md)
- **CLI surface (commands, env vars, per-package dev scripts):** [cli-reference.md](cli-reference.md)
