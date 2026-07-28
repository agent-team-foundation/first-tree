# Contributing to first-tree

Thanks for helping out. This is a brief contributor guide; the deeper
architecture and per-package workflow live in [AGENTS.md](AGENTS.md).

## Repo layout

See [AGENTS.md](AGENTS.md) for the monorepo structure and
architecture rules. Quick map:

- `apps/cli/` — the published `first-tree` CLI.
- `packages/server/` — Fastify API server.
- `packages/client/` — Agent SDK + Runtime.
- `packages/web/` — React admin dashboard.
- `packages/shared/` — internal Zod schemas, types, config.
- `skills/` — per-skill markdown payloads.

## Local setup

- Node.js 22.13+ (24 recommended)
- pnpm 10+
- Docker (for local PostgreSQL via `docker-compose`)

Use [DEVELOPMENT.md](DEVELOPMENT.md) as the full local development entrypoint,
including `.env`, migrations, service URLs, and GitHub App setup links. The
minimal loop is:

```bash
pnpm install
docker compose up -d
pnpm --filter @first-tree/server dev
pnpm --filter @first-tree/web dev
```

## Required checks before opening a PR

```bash
pnpm check         # biome lint + format
pnpm typecheck
pnpm test
```

All three must be green. If your change touches the command surface,
update [docs/cli-reference.md](docs/cli-reference.md) in the same PR.

## Required reading by topic

- **HTTP routes / JWT / multi-org:** [docs/development/http-path-conventions.md](docs/development/http-path-conventions.md)
- **Running a dev CLI alongside your production install:** [docs/development/local-dev-isolation.md](docs/development/local-dev-isolation.md)

## Conventions

See [AGENTS.md](AGENTS.md) "Coding Conventions" and
"Git Conventions" sections — they are the source of truth.

Highlights:

- TypeScript: no `any`, no `as` assertions unless unavoidable, Zod as
  the single source of truth for DTOs.
- English everywhere on GitHub — code, comments, commits, PRs, issues,
  branch names, CI logs.
- Never hand-edit Drizzle migrations; use `drizzle-kit generate` /
  `drizzle-kit migrate`.

## PR checklist

- Branch name follows `feat/* | fix/* | refactor/* | test/* | docs/* | chore/*`.
- Commit messages follow Conventional Commits
  (`feat: ...`, `fix: ...`, `refactor: ...`, etc.).
- `pnpm check && pnpm typecheck && pnpm test` are all green locally.
- Do **not** edit `version` in any `package.json` — CI handles version
  bumps on tag push.
- If the PR changes the command surface, `docs/cli-reference.md` is
  updated in the same PR.

## Contributor license agreement

Every human commit author on a pull request must be covered by a Contributor
License Agreement before the change can be merged. Automated bot accounts are
exempt.

- **Individual contributors:** read the
  [Individual Contributor License Agreement (ICLA) v1.0](https://gist.githubusercontent.com/bestony/5a32ba8d5daa68b95adab6a9bba9c1cc/raw/dffb751c6fcb4c0d3b6df087e2353f149ab0e24b/icla.md),
  then post this exact comment on the pull request:
  `I have read the CLA Document and I hereby sign the CLA`.
- **Contributors signing for an organization:** have an authorized signatory
  complete the
  [Corporate Contributor License Agreement (CCLA) v1.0](https://gist.githubusercontent.com/bestony/5a32ba8d5daa68b95adab6a9bba9c1cc/raw/dffb751c6fcb4c0d3b6df087e2353f149ab0e24b/ccla.md)
  and email it to `legal@first-tree.ai`. The Foundation must verify the CCLA
  and the GitHub usernames listed in its Schedule A before those contributors
  are treated as covered.

The `CLA` workflow records ICLA signature metadata in
`signatures/version1/cla.json` on the dedicated `cla-signatures` branch. That
record includes the GitHub username and stable account, comment, repository,
and pull-request identifiers; the signature timestamp; and the profile name
and public email exposed by GitHub at signing time. The branch is only a
signature ledger; source changes continue to go through pull requests against
`main`.

## Filing issues

Bugs, feature ideas, and questions are all welcome. Please include:

- The CLI / server / web version you're on (`first-tree --version`,
  Docker image tag, browser).
- Minimal reproduction steps where possible.
- Logs or screenshots — see [docs/observability.md](docs/observability.md)
  for how to extract structured logs.

## Security

Do not file security reports as public issues. See [SECURITY.md](SECURITY.md)
for the coordinated disclosure process.
