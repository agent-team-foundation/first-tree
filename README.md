# First Tree

<p align="center">
  English | <a href="README_zh-CN.md">中文</a>
</p>

**First Tree** is the unified CLI for building and operating agent teams.
A single binary covers three concerns:

- **Context Tree** — a tree-structured knowledge base that agents and humans
  build and maintain together. Every node is a domain, decision, or design.
- **GitHub Scan** — a background daemon that watches GitHub notifications and
  dispatches per-task work to agent runners.
- **Hub agent collaboration** — identity, messaging, and external IM bridging
  for multi-agent teams (formerly the separate `first-tree-hub` CLI).

This repo is the result of merging `first-tree-hub` and `first-tree@0.4.x` into
a single source tree. See [`docs/development/git-history.md`](docs/development/git-history.md)
for the merge anchors.

## Install

```bash
npm install -g first-tree
first-tree --help
```

The binary lives at `first-tree`; a short alias `ft` is also installed.

## Top-level command tree

```
first-tree
├── login <token>           Sign this computer into the Hub
├── logout                  Disconnect from the Hub
├── status                  CLI / daemon / hub / auth overview
├── doctor                  Cross-subsystem readiness check
├── upgrade                 Upgrade to the latest published version
├── agent ...               Agent management (config, bindings, messaging)
├── chat ...                Chats and messaging (list, history, send, open)
├── org ...                 Organization-level operations
├── daemon ...              Background daemon (hub-client lifecycle)
├── config ...              View / modify this machine's client.yaml
├── tree ...                Context Tree onboarding, validation, automation
└── github scan ...         GitHub Scan daemon and inbox runtime
```

Run `first-tree <namespace> --help` for the full list under any namespace.

## Repo layout

- `apps/cli/` — the published CLI (`first-tree` / `ft`)
- `packages/shared/` — Zod schemas, types, config system (`@first-tree/shared`)
- `packages/server/` — Fastify API server (`@first-tree/server`; deployed as
  the Hub SaaS via Docker)
- `packages/client/` — Agent SDK + Runtime (`@first-tree/client`)
- `packages/web/` — React admin dashboard (`@first-tree/web`)
- `packages/github-scan/` — GitHub Scan daemon (`@first-tree/github-scan`)
- `packages/e2e/` — black-box e2e harness (`@first-tree/e2e`)
- `skills/` — per-skill markdown payloads (e.g. `first-tree`,
  `first-tree-github-scan`, `first-tree-sync`, `first-tree-write`)

## Documentation

- [CLI Reference](docs/cli-reference.md) — every command and environment variable
- [docs/tree/](docs/tree/) — Context Tree concepts and migration history
- [docs/migration/](docs/migration/) — coming from the old CLI names?
  - [from-first-tree-hub.md](docs/migration/from-first-tree-hub.md) for users of `first-tree-hub` (the legacy collaboration CLI)
  - [from-first-tree-v0.md](docs/migration/from-first-tree-v0.md) for users of `first-tree@0.4.x` (the legacy Context Tree CLI)
- [docs/development/git-history.md](docs/development/git-history.md) — how to
  navigate history across the repo-merge boundary

## Development

```bash
pnpm install                                # Install dependencies
docker compose up -d                        # Dev PostgreSQL
pnpm --filter @first-tree/server dev        # Server (dev mode)
pnpm --filter @first-tree/web dev           # Admin dashboard (dev mode)
pnpm check && pnpm typecheck                # Lint + type check
pnpm test                                   # Tests
```

See [AGENTS.md](AGENTS.md) for architecture, conventions, and the per-package
development workflow.
