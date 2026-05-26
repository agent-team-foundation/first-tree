# First-Tree

<p align="center">
  English | <a href="README_zh-CN.md">中文</a>
</p>

**Agent teams run on First-Tree.**

first-tree routes work to the right agent, gives it the same context your
team has, and loops humans in only when the rules say so. Lives in your
GitHub. Open source.

## Install

```bash
npm install -g first-tree
first-tree --help
```

The binary lives at `first-tree`; a short alias `ft` is also installed.

## Top-level command tree

```
first-tree
├── login <token>           Sign this computer in
├── logout                  Stop the daemon and clear credentials
├── status                  CLI / daemon / server / auth overview
├── doctor                  Cross-subsystem readiness check
├── upgrade                 Upgrade to the latest published version
├── agent ...               Agent management (config, bindings, messaging)
├── chat ...                Chats and messaging (list, history, send, open)
├── org ...                 Organization-level operations
├── daemon ...              Background daemon lifecycle
├── config ...              View / modify this machine's client.yaml
├── tree ...                Context Tree onboarding, validation, automation
└── github scan ...         GitHub Scan daemon and inbox runtime
```

Run `first-tree <namespace> --help` for the full list under any namespace.

## Repo layout

- `apps/cli/` — the published CLI (`first-tree` / `ft`)
- `packages/shared/` — Zod schemas, types, config system (`@first-tree/shared`)
- `packages/server/` — Fastify API server (`@first-tree/server`; deployed as
  the SaaS via Docker)
- `packages/client/` — Agent SDK + Runtime (`@first-tree/client`)
- `packages/web/` — React admin dashboard (`@first-tree/web`)
- `packages/github-scan/` — GitHub Scan daemon (`@first-tree/github-scan`)
- `packages/e2e/` — black-box e2e harness (`@first-tree/e2e`)
- `skills/` — per-skill markdown payloads (`first-tree`, `first-tree-cloud`,
  `first-tree-github-scan`, `first-tree-sync`, `first-tree-write`,
  `first-tree-onboarding`)

## Documentation

- [Quickstart](docs/quickstart.md) — from signup to first chat
- [Onboarding Guide](docs/onboarding-guide.md) — CLI flow, SDK, troubleshooting
- [CLI Reference](docs/cli-reference.md) — every command and environment variable
- [Observability](docs/observability.md) — logs and OpenTelemetry traces
- [docs/development/](docs/development/) — contributor reference (HTTP / JWT, dev isolation)
- [docs/troubleshooting/](docs/troubleshooting/) — environment-specific gotchas
- [docs/migration/](docs/migration/) — coming from `first-tree@0.4.x`

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
development workflow. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR
workflow.

## License

[Apache 2.0](LICENSE)
