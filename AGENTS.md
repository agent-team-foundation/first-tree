# AGENTS.md

First Tree Hub — infrastructure for Agent Team: agent registration/authentication, messaging, external IM bridging, and an admin dashboard. Monorepo: Server + Client + Command + Shared + Web.

```
First Tree Hub ≠ Agents themselves (LLM agent logic lives outside First Tree Hub)
First Tree Hub ≠ Orchestration framework
First Tree Hub ≠ Context Tree
```

## Tech Stack

- **Server:** Fastify / Drizzle ORM / PostgreSQL / Zod
- **Client:** fetch + ws (SDK + AgentRuntime + pluggable Handlers)
- **Command:** Commander.js / @inquirer/prompts (unified CLI)
- **Shared:** Zod schemas + TypeScript types + config system
- **Web:** React 19 / Vite
- **Tooling:** pnpm (workspace) / Turborepo / Biome / Vitest / tsdown
- **Node.js:** minimum 22.16, recommended 24

## Common Commands

```bash
pnpm install                          # Install all dependencies
docker compose up -d                  # Start PostgreSQL (dev)

# One-command CLI start (interactive config + auto-migration + embedded Web)
pnpm --filter @agent-team-foundation/first-tree-hub dev -- server start

pnpm check && pnpm typecheck          # Run after every change
pnpm test                             # Vitest

pnpm --filter @first-tree-hub/server db:generate    # Generate migrations
pnpm --filter @first-tree-hub/server db:migrate     # Apply migrations
```

> Full CLI commands, env vars, and per-package dev scripts: [docs/cli-reference.md](docs/cli-reference.md). All other scripts (`format`, `build`, `db:studio`, per-package `dev` / `test`) are in each package's `package.json`.

## Local Testing Isolation

When exercising the CLI against a live hub on the same machine, always relocate the client home so tests do not clobber the production client's saved JWT credentials (`credentials.json`), client/agent config, workspaces, or cloned Context Tree:

```bash
export FIRST_TREE_HUB_HOME=/Users/<you>/.first-tree/hub-test
first-tree-hub connect <server-url>
first-tree-hub client start
```

- `FIRST_TREE_HUB_HOME` is read once at module load (`packages/shared/src/config/resolver.ts`) — export **before** starting the CLI.
- Repo `.env` is **not** auto-loaded by the CLI (only by Docker Compose). Inject via `set -a; source .env; set +a`, `node --env-file=...`, `direnv`, or an alias.
- Use an **absolute** path — `~` in env files is unreliable.
- Server port and PostgreSQL are shared with production by design; each isolated home registers as a separate `clientId`, keeping the two clients independent.

## Repo-Local Skill

- Use `skills/first-tree-hub-cli/SKILL.md` as the source-of-truth skill when the task is about the unified CLI, onboarding, config flows, runtime boundaries, or other behavior spanning `packages/command`, `packages/client`, `packages/server`, and `packages/shared`.
- `.agents/skills/first-tree-hub-cli/` and `.claude/skills/first-tree-hub-cli/` are symlinks to `skills/first-tree-hub-cli/`. No sync step is needed.

## Monorepo Structure

- `packages/shared/` — `@agent-team-foundation/first-tree-hub-shared` — Zod schemas + types + config system (internal, not published)
- `packages/server/` — `@first-tree-hub/server` — Fastify API server (private, bundled)
- `packages/client/` — `@first-tree-hub/client` — Agent SDK + Runtime (private, bundled)
- `packages/command/` — `@agent-team-foundation/first-tree-hub` — Unified CLI (**published**, the consumer-facing tarball)
- `packages/web/` — `@first-tree-hub/web` — React admin dashboard (private, bundled)
- `docs/` — [cli-reference.md](docs/cli-reference.md), [claim-agent-guide.md](docs/claim-agent-guide.md)

## Architecture Rules

**Five independent packages, Shared in common:** Server, Client, Command, Web are independently packaged and deployed, sharing types, Zod schemas, and config system via `@agent-team-foundation/first-tree-hub-shared`. Command is the unified CLI entry point, depending on Server and Client.

**Stateless Server:** All persistent data lives in PostgreSQL. Server holds no business state.

**PostgreSQL only:** No Redis / MQ. PG covers storage, queuing (SKIP LOCKED), and notifications (LISTEN/NOTIFY).

**Unified user-JWT auth:** Single user JWT (issued by `client connect`, stored at `~/.first-tree/hub/config/credentials.json`) authorizes both Web/Admin API and every agent the user manages on the Client WebSocket. The WS session is **org-free** — it carries only `userId`. Agents bind via `agents.client_id` + a server-pushed `agent:pinned` frame; **R-RUN** is re-evaluated at every `agent:bind` against the live `agents → manager → user` join (cross-org under one user is allowed; revoked memberships refuse the bind immediately). Switching user requires `first-tree-hub client claim --confirm`, which atomically transfers `clients.user_id` and unpins the previous owner's agents. Per-agent `aghub_*` tokens retired by migration `0020`. Web `/auth/switch-org` returns 204 only — the web client persists `localStorage.selectedOrganizationId` and rederives auth state from `/me memberships`; no token swap, WS bindings unaffected. See [docs/decouple-client-from-identity-design-zh.md](docs/decouple-client-from-identity-design-zh.md).

**Inbox is the Server/Client boundary:** Server writes to Inbox (fan-out on write), Client pulls / receives WebSocket notifications. At-least-once delivery; Client is responsible for deduplication.

**Agent identity is managed by Hub:** Agents are created, updated, suspended, and deleted via Admin API. Agent profile (markdown self-description) is stored in the `agents.profile` column. Context Tree integration is optional — when configured, Client injects organizational context (AGENT.md, root NODE.md) into agent workspaces at startup.

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

External projects (e.g. context-tree) import core via `import { startServer, checkDatabase } from "@agent-team-foundation/first-tree-hub"` — this is why `core/` must stay CLI-free.

### Git Conventions

- **Branching**: trunk-based; feature branch → PR → squash merge → main
- **Branch naming**: `feat/xxx`, `fix/xxx`, `refactor/xxx`, `test/xxx`, `docs/xxx`, `chore/xxx`
- **Commit messages**: Conventional Commits — `feat: xxx`, `fix: xxx`, `refactor: xxx`, `test: xxx`, `docs: xxx`
- **Releases**: tag + GitHub Release
- Do not auto-commit; wait for user to test and confirm before committing

### Versioning

- **Bump `packages/command`** on every PR that touches `command` / `client` / `server` / `web` / `shared` — this is the consumer-facing tarball.
- **Never bump** `private: true` packages (`shared` / `client` / `server` / `web`) — `tsdown` inlines them into the `command` tarball; their `version` is inert.

Full policy (how to pick the next version, anti-patterns, bash recipes): [docs/versioning-and-publishing.md](docs/versioning-and-publishing.md).

<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->
## First Tree integration

> Managed block — regenerated by `first-tree` tooling. Do not edit by hand.

This repo is a workspace member. Keep all Context Tree files only in the shared `first-tree-context` repo and follow the workspace root's binding for shared context updates in workspace `first-tree-all`.

### Binding

- **Tree repo:** `first-tree-context` (shared)
- **Binding mode:** `workspace-member`
- **Entrypoint:** `/workspaces/first-tree-all/repos/first-tree-hub`
- **Workspace ID:** `first-tree-all`
- **Tree repo URL:** <https://github.com/agent-team-foundation/first-tree-context>
- **Source state:** `.first-tree/local-tree.json`

<!--
FIRST-TREE-SOURCE-INTEGRATION: workspace member bound to shared tree repo `first-tree-context`
FIRST-TREE-TREE-REPO: `first-tree-context`
FIRST-TREE-TREE-MODE: `shared`
FIRST-TREE-BINDING-MODE: `workspace-member`
FIRST-TREE-TREE-REPO-URL: `https://github.com/agent-team-foundation/first-tree-context`
FIRST-TREE-ENTRYPOINT: `/workspaces/first-tree-all/repos/first-tree-hub`
FIRST-TREE-WORKSPACE-ID: `first-tree-all`
FIRST-TREE-SOURCE-STATE: `.first-tree/local-tree.json`
-->

### Before every task

- Read `.first-tree/local-tree.json` first. If it exists, resolve its `tree.localPath` value from this repo root and treat that checkout as the canonical local tree repo.
- If that configured checkout exists locally, update it before you read anything else.
- If the configured checkout is missing, clone a temporary working copy from `https://github.com/agent-team-foundation/first-tree-context` into `.first-tree/tmp/first-tree-context/`, use it for the current task, and delete it before you finish.
- Never commit anything under `.first-tree/tmp/` to this repo. It is local-only workspace state.

### After every task

- Always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, ownership, or shared workspace relationships, open a PR in the tree repo first. Then open the source/workspace code PR.
- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.
<!-- END FIRST-TREE-SOURCE-INTEGRATION -->
