# First Tree Core

<p align="center">
  <a href="README_zh-CN.md">中文</a>
</p>

Centralized collaboration platform for agent teams — registration, authentication, messaging, external IM bridging, and admin dashboard.

```
 Human ──── Feishu/Slack ──── Adapter ────┐
                                          │
 Human ──── Web Dashboard ────────────────┤
                                          ▼
                                ┌───────────────────┐
                                │  First Tree Core  │
                                │      Server       │◄── GitHub (Context Tree)
                                │    + Web + DB     │
                                └─────────┬─────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                     ┌─────────┐    ┌─────────┐    ┌─────────┐
                     │ Client  │    │ Client  │    │ Client  │
                     │(Agent A)│    │(Agent B)│    │(Agent C)│
                     │   Dev   │    │   CI    │    │  Prod   │
                     └─────────┘    └─────────┘    └─────────┘
```

**Server** is the central hub: API, web dashboard, PostgreSQL, and IM adapters — all in one process.
**Clients** connect agents to the server via WebSocket. Each client can run on a different machine.

## Quick Start

```bash
npm install -g @agent-team-foundation/first-tree-core
first-tree-core server start
```

The interactive setup will guide you through PostgreSQL provisioning, Context Tree configuration, and admin account creation. Open `http://localhost:8000` when it's ready.

## Deploy

| I want to... | Method | Guide |
|--------------|--------|-------|
| Try it locally | `first-tree-core server start` | Quick Start above |
| Deploy to cloud | Railway / Render one-click | [Deployment guide](docs/deployment-guide.md#one-click-cloud-deployment) |
| Run with Docker | `docker-compose.production.yml` | [Deployment guide](docs/deployment-guide.md) |
| Add HTTPS for public access | Caddy reverse proxy | [Deployment guide](docs/deployment-guide.md#production-with-https) |
| Run agents on other machines | `first-tree-core client start` | [Deployment guide](docs/deployment-guide.md#client-setup) |
| Use managed PostgreSQL | Supabase | [Deployment guide](docs/deployment-guide.md#managed-postgresql-supabase) |

## Diagnostics

```bash
first-tree-core server doctor   # Check server environment readiness
first-tree-core client doctor   # Check client environment readiness
first-tree-core status          # Server health + configured agents
```

## Documentation

- [Deployment Guide](docs/deployment-guide.md) — Docker, HTTPS, client setup, and production recommendations
- [CLI Reference](docs/cli-reference.md) — All commands and environment variables
- [AGENTS.md](AGENTS.md) — Architecture, conventions, development workflow

## Development

```bash
pnpm install                          # Install dependencies
docker compose up -d                  # Start dev PostgreSQL
pnpm --filter @first-tree-core/server dev   # Start server (dev mode)
pnpm --filter @first-tree-core/web dev      # Start web dashboard (dev mode)
pnpm check && pnpm typecheck          # Lint + type check
pnpm test                             # Run tests
```
