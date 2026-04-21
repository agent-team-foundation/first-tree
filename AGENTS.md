# AGENTS.md

First Tree Hub — centralized collaboration platform for Agent Team (Server + Client + Command + Shared + Web monorepo).

## Overview

First Tree Hub is the infrastructure for Agent Team, providing agent registration/authentication, messaging, external IM bridging, and an admin dashboard.

```
First Tree Hub ≠ Agents themselves (LLM agent logic lives outside First Tree Hub)
First Tree Hub ≠ Orchestration framework
First Tree Hub ≠ Context Tree
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
pnpm --filter @agent-team-foundation/first-tree-hub dev -- server start

# Separate start (traditional dev)
pnpm --filter @first-tree-hub/server dev   # Start server (tsx watch, requires .env)
pnpm --filter @first-tree-hub/web dev      # Start web (Vite dev server)

# Quality
pnpm check                            # Biome lint + format check
pnpm format                           # Biome format
pnpm typecheck                        # tsc --noEmit
pnpm test                             # Vitest
pnpm --filter @first-tree-hub/server test  # Test (server only)

# Build
pnpm build                            # Turborepo orchestrated full build

# Database
pnpm --filter @first-tree-hub/server db:generate    # Generate migrations
pnpm --filter @first-tree-hub/server db:migrate     # Apply migrations
pnpm --filter @first-tree-hub/server db:studio      # Drizzle Studio
```

> Full CLI commands and environment variables: [docs/cli-reference.md](docs/cli-reference.md)

## Local Testing Isolation

When exercising the CLI against a live hub on the same machine, always relocate the client home so tests do not clobber the production client's saved JWT credentials (`credentials.json`), client/agent config, workspaces, or cloned Context Tree:

```bash
export FIRST_TREE_HUB_HOME=/Users/<you>/.first-tree-hub-test
first-tree-hub connect <server-url>
first-tree-hub client start
```

- `FIRST_TREE_HUB_HOME` is read once at module load (`packages/shared/src/config/resolver.ts`). Export it **before** starting the CLI; changing it mid-process has no effect.
- The repo's `.env` is **not** auto-loaded by the CLI (only by Docker Compose). Use `set -a; source .env; set +a`, `node --env-file=...`, `direnv`, or an `alias` to inject env vars.
- Use an absolute path — `~` in env files is not reliably expanded and may be taken as a literal directory name.
- Server port and PostgreSQL are shared with production by design; each isolated home registers as a separate `clientId` on the server, so pinning test agents to it keeps the two clients independent.

## Repo-Local Skill

- Use `skills/first-tree-hub-cli/SKILL.md` as the source-of-truth skill when the task is about the unified CLI, onboarding, config flows, runtime boundaries, or other behavior spanning `packages/command`, `packages/client`, `packages/server`, and `packages/shared`.
- `.agents/skills/first-tree-hub-cli/` and `.claude/skills/first-tree-hub-cli/` are symlinks to `skills/first-tree-hub-cli/`. No sync step is needed.

## Monorepo Structure

```
first-tree-hub/
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
│   ├── shared/                # @agent-team-foundation/first-tree-hub-shared — Shared Zod schemas + types + config system
│   ├── server/                # @first-tree-hub/server — Fastify API server
│   ├── client/                # @first-tree-hub/client — Agent SDK + Runtime
│   ├── command/               # @agent-team-foundation/first-tree-hub — Unified CLI (published package)
│   └── web/                   # @first-tree-hub/web — React admin dashboard
```

## Architecture Rules

**Five independent packages, Shared in common:** Server, Client, Command, Web are independently packaged and deployed, sharing types, Zod schemas, and config system via `@agent-team-foundation/first-tree-hub-shared`. Command is the unified CLI entry point, depending on Server and Client.

**Stateless Server:** All persistent data lives in PostgreSQL. Server holds no business state.

**PostgreSQL only:** No Redis / MQ. PG covers storage, queuing (SKIP LOCKED), and notifications (LISTEN/NOTIFY).

**Unified user-JWT auth:** A single member JWT — issued by `first-tree-hub client connect` and stored at `~/.first-tree-hub/config/credentials.json` — authorizes both the Web/Admin API and every agent the signed-in user manages on the Client WebSocket. Per-agent `aghub_*` tokens and the `agent_tokens` table were retired by migration [`0020_unified_user_token`](packages/server/drizzle/0020_unified_user_token.sql) ([#95](https://github.com/agent-team-foundation/first-tree-hub/pull/95)); agents now bind via `agents.client_id` plus a server-pushed `agent:pinned` frame on the first-bind path (auto-pin, [#108](https://github.com/agent-team-foundation/first-tree-hub/pull/108)), and scope is enforced by Rule **R-RUN** in `packages/server/src/services/agent.ts`. No default passwords; localhost must authenticate too.

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
- **English everywhere on GitHub**: All GitHub-visible content must be in English — code, comments, JSDoc, TODO, commit messages, PR titles/descriptions, issue titles/descriptions, branch names, release notes, CI logs, and any other content visible in the repository
- **Run after changes**: `pnpm check && pnpm typecheck`

## Development Workflow

### New Feature Steps (Server)

1. Define Zod schema (`shared/src/schemas/`)
2. Define Drizzle table (`server/src/db/schema/`) — if persistence is needed
3. Implement service (`server/src/services/`)
4. Define API routes (`server/src/api/`)
5. Generate migration: `pnpm --filter @first-tree-hub/server db:generate`
6. Apply migration: `pnpm --filter @first-tree-hub/server db:migrate`
7. Write tests (`server/src/__tests__/`)

### New Feature Steps (Client)

1. New SDK method → add in `client/src/sdk.ts`
2. New handler type → implement and register in `client/src/handlers/`
3. Runtime changes → `client/src/runtime/` (AgentRuntime / AgentSlot / SessionManager)
4. If shared types are involved → update `shared/src/schemas/` first

### New Feature Steps (Command)

1. Add core logic in `command/src/core/` — all exportable business logic lives here
2. Add CLI command module in `command/src/commands/` — thin arg parsing layer only
3. Register command in `command/src/cli/index.ts`
4. Export new core functions from `command/src/core/index.ts` and `command/src/index.ts`
5. If config changes are needed → update schema in `shared/src/config/`

**Command package structure:**
- `src/core/` — exportable core functions (server start, doctor, admin, migrate, docker, prompts)
- `src/cli/` — Commander.js CLI entry point + CLI-specific output helpers
- `src/commands/` — individual command registrations (thin: arg parsing → `core/*` calls)
- `src/index.ts` — barrel export: re-exports `core/*` + SDK for external consumers

External CLI projects (e.g. context-tree) can `import { startServer, checkDatabase } from "@agent-team-foundation/first-tree-hub"` to reuse core logic with their own arg parsing.

### Git Conventions

- **Branching**: trunk-based; feature branch → PR → squash merge → main
- **Branch naming**: `feat/xxx`, `fix/xxx`, `refactor/xxx`, `test/xxx`, `docs/xxx`, `chore/xxx`
- **Commit messages**: Conventional Commits — `feat: xxx`, `fix: xxx`, `refactor: xxx`, `test: xxx`, `docs: xxx`
- **Releases**: tag + GitHub Release
- Do not auto-commit; wait for user to test and confirm before committing

### Versioning & Publishing

A release reaches downstream consumers only when the published package's
`version` advances. The npm registry refuses to overwrite an existing
version, and `npm ci` resolves strictly by the version pin — so a new
build that ships under an unchanged version is invisible to anyone
running `npm ci` / `npm install`. Treat the version bump as a required
part of every shipped change, not a release-time afterthought.

#### Which package's version actually ships

Two packages are published to npm; the rest are `private: true` and
bundled into the published artifacts at build time via `tsdown`. The
private packages' `version` fields are inert — bumping them has no
effect on what downstream consumers receive.

| Package | Path | Published | Bump rule |
|---|---|---|---|
| `@agent-team-foundation/first-tree-hub` | `packages/command` | Yes (`publishConfig.access: public`) | **Bump on every PR that changes any source file in `command`, `client`, `server`, `web`, or `shared`.** This tarball is the unified CLI consumers install; without a new version the bundled change cannot reach `npm ci`. |
| `@agent-team-foundation/first-tree-hub-shared` | `packages/shared` | Yes | **Bump when the externally-importable surface of `shared` changes** — exported Zod schemas, types, or constants that another npm package could consume. Internal-only edits to `shared` still require the `command` bump above; they do not require a `shared` bump. |
| `@first-tree-hub/client` | `packages/client` | No (`private: true`) | Do not bump — version is inert. Bump `command` instead. |
| `@first-tree-hub/server` | `packages/server` | No (`private: true`) | Do not bump — version is inert. Bump `command` instead. |
| `@first-tree-hub/web` | `packages/web` | No (`private: true`) | Do not bump — version is inert. Bump `command` instead. |

#### Choosing the next version

1. Read the **published** `latest` from the registry — it may be ahead of
   `main` if a release shipped between PRs:
   ```bash
   npm view @agent-team-foundation/first-tree-hub version
   ```
2. Pick `max(npm latest, current main) + 1` patch — never reuse a
   version that already exists on npm.
3. Default to **patch** bumps for additive changes, fixes, and internal
   refactors. Reserve **minor** bumps for breaking changes to the CLI's
   public surface (commands, flags, exit codes, on-disk file layouts
   under `~/.first-tree-hub/`).
4. Apply the same rule to `shared`: query npm, pick the next available
   patch, prefer patch over minor.

#### Anti-pattern

Bumping a `private: true` package (`client` / `server` / `web`) on a PR
that changes its source. pnpm publish only ships `command` and `shared`,
and `tsdown` inlines the private packages into the `command` tarball at
build time — so the private package's `version` field never reaches the
registry. Bump **`packages/command`** instead; that is the artifact
whose version pins the release downstream `npm ci` will see.

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
