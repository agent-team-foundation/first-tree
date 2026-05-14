# Deployment Guide

This guide covers production deployment of First Tree Hub. For a quick local setup, see the [Quick Start](../README.md#quick-start) in the README.

## Overview

First Tree Hub has two deployable components:

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

These must be set for Docker / CI / `--no-interactive` deployments. Interactive mode (`first-tree-hub server start`) will prompt for missing values.

| Variable | Description |
|----------|-------------|
| `FIRST_TREE_HUB_DATABASE_URL` | PostgreSQL connection URL (Docker Compose provides this automatically) |
| `FIRST_TREE_HUB_HOST` | Bind address — **must be `0.0.0.0` for Docker** (default: `127.0.0.1`) |

### Server — Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRST_TREE_HUB_CONTEXT_TREE_GITHUB_TOKEN` | — | Optional deployment-level read token for private Context Tree repos configured in Team Settings |
| `FIRST_TREE_HUB_CONTEXT_TREE_GITHUB_TOKEN_REPOS` | — | Comma-separated GitHub repo allowlist (`owner/repo`) that may use the Context Tree read token |
| `FIRST_TREE_HUB_PORT` | `8000` | Server port |
| `FIRST_TREE_HUB_JWT_SECRET` | auto-generated | JWT signing secret |
| `FIRST_TREE_HUB_ENCRYPTION_KEY` | auto-generated | Adapter credential encryption key |
| `FIRST_TREE_HUB_ADMIN_PASSWORD` | auto-generated | Default admin password |
| `FIRST_TREE_HUB_CORS_ORIGIN` | — | Allowed origins (comma-separated) |
| `FIRST_TREE_HUB_RATE_LIMIT_MAX` | `100` | Global rate limit (req/min) |

### Client — Required

| Variable | Description |
|----------|-------------|
| `FIRST_TREE_HUB_SERVER_URL` | Server URL the client connects to |

### Client — Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRST_TREE_HUB_LOG_LEVEL` | `info` | Log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) |

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

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=first-tree-hub)

Railway auto-detects the Dockerfile, provisions PostgreSQL, and exposes the service with HTTPS. Configure Context Tree and GitHub integration per organization from Team Settings after the server is running.

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Render uses [render.yaml](../render.yaml) to create the web service and PostgreSQL database. You'll be prompted for required environment variables during setup.

## Client Setup

On each machine that runs agents:

```bash
# Install
npm install -g @agent-team-foundation/first-tree-hub

# Sign this machine into the Hub (auto-installs background service)
first-tree-hub connect <connect-token>

# Add an existing Hub agent to this client (dir keyed by its hub name).
first-tree-hub agent add --agent-id <agent-uuid>

# Start (omit if the background service is already running)
first-tree-hub client start
```

### Client with Docker

```bash
docker build -f Dockerfile.client -t first-tree-hub-client .
docker run -e FIRST_TREE_HUB_SERVER_URL=https://hub.example.com \
           -v ~/.first-tree/hub/config/agents:/root/.first-tree/hub/config/agents \
           first-tree-hub-client
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
      - run: npm install -g @agent-team-foundation/first-tree-hub
      - run: |
          first-tree-hub connect ${{ secrets.HUB_CONNECT_TOKEN }} --no-service
          first-tree-hub agent add --agent-id ${{ secrets.AGENT_UUID }}
          first-tree-hub client start
```

## Managed PostgreSQL (Supabase)

You can use [Supabase](https://supabase.com) instead of self-hosted PostgreSQL. **Use the direct connection URL (port 5432), not the pooled URL (port 6543)** — First Tree Hub requires `LISTEN/NOTIFY` which does not work through connection poolers.

## Health Checks

The server exposes `GET /healthz` at the root level (outside `/api/v1`). It returns:
- `200 {"status": "ok"}` — server and database are healthy
- `503 {"status": "error"}` — database unreachable

This endpoint is used by:
- Docker `HEALTHCHECK` (configured in Dockerfile)
- `docker-compose.production.yml` and `deploy/docker-compose.caddy.yml`
- Railway and Render health check configuration
- `first-tree-hub server doctor` and `first-tree-hub client doctor`

## Diagnostics

```bash
# On the server machine
first-tree-hub server doctor

# On a client machine
first-tree-hub client doctor
```

`server doctor` checks: Node.js version, Docker, configuration, database connectivity, server health.

`client doctor` checks: Node.js version, configuration, server reachability, agent configs, token validity, WebSocket connectivity.
