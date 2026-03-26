# Deployment Guide

This guide covers production deployment of Agent Hub. For a quick local setup, see the [Quick Start](../README.md#quick-start) in the README.

## Overview

Agent Hub has two deployable components:

| Component | What it does | Where to run |
|-----------|-------------|-------------|
| **Server** | API, web dashboard, PostgreSQL, IM adapters | One central location (cloud VM, PaaS, Docker host) |
| **Client** | Connects agents to server via WebSocket | Each machine that runs agents |

For a single developer, both run on the same machine. For a team, the server runs on a shared host and clients run on individual machines.

## Environment Variables

Copy the example file and fill in the required values:

```bash
cp .env.example .env
```

See [.env.example](../.env.example) for the full list with comments. See [CLI Reference](cli-reference.md) for command-level details.

### Server — Required

These must be set for Docker / CI / `--no-interactive` deployments. Interactive mode (`agent-hub server start`) will prompt for missing values.

| Variable | Description |
|----------|-------------|
| `AGENT_HUB_DATABASE_URL` | PostgreSQL connection URL (Docker Compose provides this automatically) |
| `AGENT_HUB_HOST` | Bind address — **must be `0.0.0.0` for Docker** (default: `127.0.0.1`) |
| `AGENT_HUB_CONTEXT_TREE_REPO` | Context Tree GitHub repo (URL or `owner/repo`) |
| `AGENT_HUB_GITHUB_TOKEN` | GitHub personal access token (repo scope) |
| `AGENT_HUB_GITHUB_WEBHOOK_SECRET` | GitHub webhook secret |

### Server — Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HUB_PORT` | `8000` | Server port |
| `AGENT_HUB_JWT_SECRET` | auto-generated | JWT signing secret |
| `AGENT_HUB_ENCRYPTION_KEY` | auto-generated | Adapter credential encryption key |
| `AGENT_HUB_ADMIN_PASSWORD` | auto-generated | Default admin password |
| `AGENT_HUB_CORS_ORIGIN` | — | Allowed origins (comma-separated) |
| `AGENT_HUB_RATE_LIMIT_MAX` | `100` | Global rate limit (req/min) |

### Client — Required

| Variable | Description |
|----------|-------------|
| `AGENT_HUB_SERVER_URL` | Server URL the client connects to |

### Client — Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HUB_LOG_LEVEL` | `info` | Log level (`debug` / `info` / `warn` / `error`) |

## Docker Compose (HTTP)

Suitable for internal networks or when running behind an existing reverse proxy.

```bash
cp .env.example .env    # fill in the required server variables
docker compose -f docker-compose.production.yml up -d
```

This starts the server (with embedded web dashboard) and PostgreSQL. The server listens on `http://localhost:8000`.

## Production with HTTPS

For public-facing deployments, use the Caddy configuration for automatic SSL certificates via Let's Encrypt.

**Prerequisites:**
- A domain name with DNS A record pointing to your server's public IP
- Ports 80 and 443 open

```bash
cp .env.example .env    # edit required values
DOMAIN=hub.example.com docker compose -f deploy/docker-compose.caddy.yml up -d
```

Caddy automatically obtains and renews SSL certificates. No manual certificate management required.

### Custom Caddy configuration

The default [Caddyfile](../deploy/Caddyfile) is minimal. To add custom headers, rate limiting, or other Caddy directives, edit `deploy/Caddyfile` before starting.

## One-Click Cloud Deployment

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=agent-hub)

Railway auto-detects the Dockerfile, provisions PostgreSQL, and exposes the service with HTTPS. Set these environment variables in Railway's dashboard:

- `AGENT_HUB_CONTEXT_TREE_REPO`
- `AGENT_HUB_GITHUB_TOKEN`

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Render uses [render.yaml](../render.yaml) to create the web service and PostgreSQL database. You'll be prompted for required environment variables during setup.

## Client Setup

On each machine that runs agents:

```bash
# Install
npm install -g @unispark.ai/agent-hub

# Configure server URL
agent-hub config set -c server.url https://hub.example.com

# Add agents
agent-hub client add my-agent --token aht_xxxxxxxxxxxx

# Start
agent-hub client start
```

### Client with Docker

```bash
docker build -f Dockerfile.client -t agent-hub-client .
docker run -e AGENT_HUB_SERVER_URL=https://hub.example.com \
           -v ~/.agent-hub/agents:/root/.agent-hub/agents \
           agent-hub-client
```

### Client in CI (GitHub Actions)

```yaml
jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install -g @unispark.ai/agent-hub
      - run: |
          agent-hub config set -c server.url ${{ secrets.HUB_URL }}
          agent-hub client add ci-agent --token ${{ secrets.AGENT_TOKEN }}
          agent-hub client start
```

## Managed PostgreSQL (Supabase)

You can use [Supabase](https://supabase.com) instead of self-hosted PostgreSQL. **Use the direct connection URL (port 5432), not the pooled URL (port 6543)** — Agent Hub requires `LISTEN/NOTIFY` which does not work through connection poolers.

## Health Checks

The server exposes `GET /healthz` at the root level (outside `/api/v1`). It returns:
- `200 {"status": "ok"}` — server and database are healthy
- `503 {"status": "error"}` — database unreachable

This endpoint is used by:
- Docker `HEALTHCHECK` (configured in Dockerfile)
- `docker-compose.production.yml` and `deploy/docker-compose.caddy.yml`
- Railway and Render health check configuration
- `agent-hub server doctor` and `agent-hub client doctor`

## Diagnostics

```bash
# On the server machine
agent-hub server doctor

# On a client machine
agent-hub client doctor
```

`server doctor` checks: Node.js version, Docker, configuration, database connectivity, GitHub token, Context Tree access, server health.

`client doctor` checks: Node.js version, configuration, server reachability, agent configs, token validity, WebSocket connectivity.
