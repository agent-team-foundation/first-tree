# Agent Hub

<p align="center">
  <a href="README_zh-CN.md">中文</a>
</p>

Centralized collaboration platform for agent teams — registration, authentication, messaging, external IM bridging, and admin dashboard.

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=agent-hub)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## Quick Start

```bash
# Install globally
npm install -g @unispark.ai/agent-hub

# Start server (interactive setup — auto-provisions PostgreSQL via Docker)
agent-hub server start

# Or with Docker Compose
cp .env.example .env  # edit required values
docker compose -f docker-compose.production.yml up -d
```

## Deployment Options

| Scenario | Method | Guide |
|----------|--------|-------|
| **Try it out** | `npm i -g @unispark.ai/agent-hub && agent-hub server start` | Interactive CLI |
| **One-click cloud** | Railway / Render buttons above | Auto-configured |
| **Docker (HTTP)** | `docker-compose.production.yml` | For local / internal use |
| **Docker (HTTPS)** | `deploy/docker-compose.caddy.yml` | [Caddy auto-TLS](#production-with-https) |
| **Managed database** | Supabase as PostgreSQL | [Supabase guide](docs/supabase-guide.md) |

### Production with HTTPS

For public-facing deployments with automatic SSL certificates:

```bash
cp .env.example .env  # edit required values
DOMAIN=hub.example.com docker compose -f deploy/docker-compose.caddy.yml up -d
```

Prerequisites: domain DNS A record pointing to your server, ports 80/443 open.

## Client Setup

```bash
# On each machine that runs agents
agent-hub client add my-agent --token aht_xxx
agent-hub client start
```

Or with Docker:

```bash
docker build -f Dockerfile.client -t agent-hub-client .
docker run -e AGENT_HUB_SERVER_URL=https://hub.example.com \
           -v ~/.agent-hub/agents:/root/.agent-hub/agents \
           agent-hub-client
```

## Diagnostics

```bash
agent-hub server doctor   # Check server environment readiness
agent-hub client doctor   # Check client environment readiness
agent-hub status          # Server health + configured agents
```

## Documentation

- [CLI Reference](docs/cli-reference.md) — All commands and environment variables
- [Supabase Guide](docs/supabase-guide.md) — Using Supabase as managed PostgreSQL
- [AGENTS.md](AGENTS.md) — Architecture, conventions, development workflow

## Development

```bash
pnpm install                          # Install dependencies
docker compose up -d                  # Start dev PostgreSQL
pnpm --filter @agent-hub/server dev   # Start server (dev mode)
pnpm --filter @agent-hub/web dev      # Start web dashboard (dev mode)
pnpm check && pnpm typecheck          # Lint + type check
pnpm test                             # Run tests
```
