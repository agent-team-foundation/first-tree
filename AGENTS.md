# AGENTS.md

**first-tree** — the unified CLI and infrastructure for agent teams. It is a pnpm monorepo for the CLI, server, client runtime, web app, docs, and agent-team tooling.

What first-tree is NOT:

- not an LLM agent itself (agent logic lives elsewhere)
- not an orchestration framework

## Tech Stack

- **Server:** Fastify / Drizzle ORM / PostgreSQL / Zod
- **Client:** fetch + ws (SDK + AgentRuntime + pluggable handlers)
- **Command:** Commander.js / @inquirer/prompts (unified CLI)
- **Shared:** Zod schemas + TypeScript types + config system
- **Web:** React 19 / Vite
- **Tooling:** pnpm / Turborepo / Biome / Vitest / tsdown
- **Node.js:** minimum 22.13, recommended 24

## Common Commands

```bash
pnpm install
docker compose up -d

pnpm --filter @first-tree/server dev
pnpm --filter @first-tree/web dev

pnpm check && pnpm typecheck
pnpm test

pnpm --filter @first-tree/server db:generate
pnpm --filter @first-tree/server db:migrate
```

Full CLI commands and env vars live in [docs/cli-reference.md](docs/cli-reference.md). Per-package scripts live in each package's `package.json`.

## Required Reading By Topic

- **HTTP routes, JWT auth, scope helpers, or multi-org behavior:** read [docs/development/http-path-conventions.md](docs/development/http-path-conventions.md) before editing. It is the single source of truth.
- **Onboarding kickoff/chat-start behavior:** read [docs/development/onboarding-kickoff-contract.md](docs/development/onboarding-kickoff-contract.md) before editing `/me/onboarding/kickoff`, `/orgs/:orgId/context-tree/setup-chat`, or the client inbound prompt formatting.
- **Running an in-tree CLI next to prod/staging:** use `scripts/dev-install.sh` and read [docs/development/local-dev-isolation.md](docs/development/local-dev-isolation.md).

## Repo-Local Skills

- `skills/first-tree-write/SKILL.md` — source-driven Context Tree authorship
- `skills/first-tree-read/SKILL.md` — task-scoped Context Tree reading
- `skills/first-tree-seed/SKILL.md` — one-time bootstrap for an empty tree
- `skills/first-tree-qa/SKILL.md` — complete-harness-first professional QA workflow

Operator-only flows such as `login`, `daemon install`, and `agent create` belong in [docs/cli-reference.md](docs/cli-reference.md) and [docs/onboarding-guide.md](docs/onboarding-guide.md), not in skills.

## Monorepo Structure

- `apps/cli/` — unified CLI source; CI publishes channel-specific packages
- `apps/doc-website/` — documentation website
- `packages/shared/` — `@first-tree/shared` schemas, types, and config
- `packages/server/` — `@first-tree/server` Fastify API server
- `packages/client/` — `@first-tree/client` SDK and AgentRuntime
- `packages/web/` — `@first-tree/web` React workspace
- `packages/skill-evals/` — eval tooling for repo-local skills
- `packages/qa/` — internal QA workflow assets for agent-run validation
- `docs/` — user, operator, development, migration, and troubleshooting docs
- `skills/` — repo-local skill payloads

## Architecture Rules

- **Package boundaries:** Server, Client, Command, and Web are independently packaged/deployed and share code through `@first-tree/shared`. The CLI is the user-facing command surface and depends only on Client + Shared. Server ships separately as the SaaS Docker image.
- **Server state:** Server is stateless. PostgreSQL is the only persistence/queue/notification backend; do not add Redis or MQ.
- **Unified user-JWT auth:** A single user JWT authorizes Web/Admin API calls and every agent the user manages on the client WebSocket. Route classification, JWT shape, and scope helpers live in [docs/development/http-path-conventions.md](docs/development/http-path-conventions.md). Channel homes live in [docs/development/local-dev-isolation.md](docs/development/local-dev-isolation.md). Agents bind via `agents.client_id` + `agent:pinned`; R-RUN is re-evaluated at every `agent:bind`. Switching users goes through `first-tree login <code>` and the local-client switch path; `logout --purge` retires the current server client and cuts its runtime routes before destructive local cleanup, after which cleared agents can be moved to a new connected runtime from Web.
- **Inbox boundary:** Server writes to Inbox; Client pulls / receives WebSocket notifications. Delivery is at-least-once; Client deduplicates.
- **Agent identity:** Agents are managed by the server Admin API. Agent profile markdown lives in `agents.profile`. Context Tree integration is optional and injected by Client at workspace startup.
- **Credentials:** Sensitive credentials are AES-256-GCM encrypted at the application layer via `services/crypto.ts`.
- **Messages:** Message IDs are UUID v7 and messages are immutable after creation.

## Coding Conventions

- Use `unknown` + type narrowing instead of `any`.
- Avoid `as` assertions; when unavoidable for third-party libraries, explain why nearby.
- Do not use `enum`; use `as const` objects and Zod-compatible literals.
- Use `import type`, prefer `type` over `interface` unless extension/implementation requires an interface, and give public APIs explicit return types.
- Each package's `src/index.ts` is its public entry point.
- Zod is the source of truth for DTOs; derive TypeScript types with `z.infer<typeof schema>`.
- Never hand-edit Drizzle migrations; use `drizzle-kit generate` and `drizzle-kit migrate`.
- Services throw exceptions and API layers map them to HTTP status codes; do not use empty `catch {}` blocks.
- Follow existing naming and Biome formatting.
- English everywhere on GitHub: code, comments, commits, PRs, issues, branch names, and CI logs.
- Run `pnpm check && pnpm typecheck` after changes. Run `pnpm test` before opening a PR unless the change is clearly docs-only.

## Development Workflow

- Update shared schemas/types first when a change crosses packages.
- Server features usually flow: shared schema -> Drizzle table (if persistent) -> service -> API route -> migration -> tests.
- Client SDK methods live in `sdk.ts`; handlers register in `handlers/`; runtime changes live under `runtime/`.
- CLI business logic belongs in `core/`; command files should stay thin and call `core/*`. Wire commands in `cli/index.ts`, and export public helpers from both `core/index.ts` and `src/index.ts`.
- Config changes belong in `shared/src/config/`.

## Testing & QA

- Route each check to its layer, in the same PR as the behavior: deterministic behavior -> product tests (Vitest per package; `pnpm test` before a PR); agent-skill regression -> `@first-tree/skill-evals`; judgment / live / cross-surface validation -> `@first-tree/qa` cases (`packages/qa/cases/`, prose prompts, not executable specs). If a check can be made stable, it belongs in product tests.
- Before a PR, self-check QA risk. If the change touches a cross-surface, runtime, provider/auth, WS/inbox, or boot/health path: find or add a matching case under `packages/qa/cases/` and flag in the PR that formal QA is warranted. Formal QA is human-requested, not a CI gate or auto runner; load `skills/first-tree-qa/SKILL.md` and follow `packages/qa/AGENTS.md` when asked to run it.
- When using `@first-tree/skill-evals`, agents may run only no-model code checks such as `eval:floor`; model-backed gate, quality, and periodic cases require an explicit human request. For repo-local skill changes, keep scope and verification minimal: do not add or rewrite eval cases without a confirmed contract change or reproduced regression. Review blocks only on in-scope requirement or constraint violations, regressions, safety risks, deterministic check failures, or contradictions; everything else is a non-blocking follow-up.

## Git Conventions

- Branching: trunk-based; feature branch -> PR -> squash merge -> main.
- Branch naming: CI accepts only `feat/xxx`, `fix/xxx`, `refactor/xxx`, `test/xxx`, `docs/xxx`, `chore/xxx`, or `merge/xxx`. Do not use agent/person prefixes such as `codex/xxx`.
- Commit messages: Conventional Commits, e.g. `feat: xxx`, `fix: xxx`, `refactor: xxx`, `test: xxx`, `docs: xxx`.
- Do not edit `version` fields in any `package.json`. Version bumps are handled by CI on tag push or by a maintainer cutting a tag.
