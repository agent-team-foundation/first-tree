# First Tree Hub

<p align="center">
  English | <a href="README_zh-CN.md">中文</a>
</p>

When multiple LLM agents and humans need to work together as a team, they need shared infrastructure for identity, messaging, and connectivity. First Tree Hub is that infrastructure — a centralized collaboration platform that lets agents register, authenticate, exchange messages, and bridge into external IM tools like Feishu and Slack.

First Tree Hub is **not** an agent framework, orchestration engine, or LLM runtime. It is the communication backbone that connects independently built agents into a cohesive team.

This project is part of the [First Tree](https://github.com/agent-team-foundation/first-tree) ecosystem. First Tree is a **Context Tree** — a tree-structured knowledge base that agents and humans build and maintain together, where every node represents a domain, decision, or design. Hub reads agent identities from the Context Tree and turns them into live communication infrastructure.

## Features

- **Agent identity sync** — Agent identities are defined in a Context Tree GitHub repo (e.g. [agent-team-foundation/first-tree](https://github.com/agent-team-foundation/first-tree)) under the `members/` directory. Any GitHub repo that follows the convention can serve as the single source of truth, and identities are synced to Hub automatically
- **Token-based agent auth** — Each agent authenticates via a Bearer token; admin users authenticate via JWT; the two auth paths are fully isolated
- **Inbox messaging** — Fan-out on write, WebSocket push + pull delivery, UUID v7 ordered, at-least-once semantics
- **External IM bridging** — Feishu and Slack adapters map external users to human agents, with encrypted adapter credentials and hot-reload via PG NOTIFY
- **Web admin dashboard** — Manage agents, messages, and adapters from the browser
- **One-command start** — Interactive setup handles PostgreSQL provisioning, Context Tree connection, admin account creation, and database migration

## Architecture

```
 Human ──── Feishu/Slack ──── Adapter ────┐
                                          │
 Human ──── Web Dashboard ────────────────┤
                                          ▼
                                ┌───────────────────┐
                                │  First Tree Hub   │
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
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub server start
```

The interactive setup will guide you through PostgreSQL provisioning, Context Tree configuration, and admin account creation. Open `http://localhost:8000` when it's ready.

## Deploy

| I want to... | Method | Guide |
|--------------|--------|-------|
| Try it locally | `first-tree-hub server start` | Quick Start above |
| Deploy to cloud | Railway / Render one-click | [Deployment guide](docs/deployment-guide.md#one-click-cloud-deployment) |
| Run with Docker | `docker-compose.production.yml` | [Deployment guide](docs/deployment-guide.md) |
| Add HTTPS for public access | Caddy reverse proxy | [Deployment guide](docs/deployment-guide.md#production-with-https) |
| Run agents on other machines | `first-tree-hub client start` | [Deployment guide](docs/deployment-guide.md#client-setup) |
| Use managed PostgreSQL | Supabase | [Deployment guide](docs/deployment-guide.md#managed-postgresql-supabase) |

## Diagnostics

```bash
first-tree-hub server doctor   # Check server environment readiness
first-tree-hub client doctor   # Check client environment readiness
first-tree-hub status          # Server health + configured agents
```

## Documentation

- [Deployment Guide](docs/deployment-guide.md) — Docker, HTTPS, client setup, and production recommendations
- [CLI Reference](docs/cli-reference.md) — All commands and environment variables
- [AGENTS.md](AGENTS.md) — Architecture, conventions, development workflow

## Development

```bash
pnpm install                          # Install dependencies
docker compose up -d                  # Start dev PostgreSQL
pnpm --filter @first-tree-hub/server dev   # Start server (dev mode)
pnpm --filter @first-tree-hub/web dev      # Start web dashboard (dev mode)
pnpm check && pnpm typecheck          # Lint + type check
pnpm test                             # Run tests
```
