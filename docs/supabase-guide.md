# Using Supabase as Managed PostgreSQL

Supabase provides managed PostgreSQL that works with Agent Hub. This guide covers the setup and important caveats.

## Quick Start

1. Create a [Supabase](https://supabase.com) project (Free or Pro plan)
2. Go to **Project Settings → Database → Connection string → URI**
3. Copy the **direct connection** URL (port `5432`)

```bash
# Use the DIRECT connection URL (port 5432) — NOT the pooled URL (port 6543)
agent-hub server start --database-url "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
```

Or set it in your environment:

```bash
export AGENT_HUB_DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
agent-hub server start
```

## Important: Direct Connection vs Pooled Connection

Supabase offers two connection modes:

| Mode | Port | Agent Hub Compatible |
|------|------|---------------------|
| **Direct** | `5432` | Yes |
| **Pooled (Supavisor)** | `6543` | No |

**Agent Hub requires the direct connection (port 5432)** because:

- **LISTEN/NOTIFY** — Agent Hub uses PostgreSQL `LISTEN`/`NOTIFY` for real-time message delivery and config hot-reload. Connection poolers (PgBouncer/Supavisor) in transaction mode do not support `LISTEN`.
- **Advisory Locks** — Used to ensure single-instance Context Tree sync. Requires session-level locks, which don't work through transaction-mode poolers.

## Supabase Plan Recommendations

| Agents | Plan | Direct Connections | Monthly Cost |
|--------|------|-------------------|-------------|
| 1-5 | Free | ~20 | $0 |
| 5-20 | Pro (Micro) | ~60 | ~$35 |
| 20-50 | Pro (Small) | ~90 | ~$40 |
| 50+ | Pro (Medium) | ~120 | ~$85 |

Agent Hub uses 2 direct connections at minimum (1 for queries, 1 for LISTEN/NOTIFY).

## Docker Compose with Supabase

When using Supabase, you don't need the `postgres` service in docker-compose. Create a simplified compose file:

```yaml
services:
  server:
    build: .
    ports:
      - "${AGENT_HUB_PORT:-8000}:8000"
    environment:
      AGENT_HUB_DATABASE_URL: ${AGENT_HUB_DATABASE_URL}
      AGENT_HUB_HOST: "0.0.0.0"
      AGENT_HUB_PORT: "8000"
      AGENT_HUB_JWT_SECRET: ${AGENT_HUB_JWT_SECRET}
      AGENT_HUB_ENCRYPTION_KEY: ${AGENT_HUB_ENCRYPTION_KEY}
      AGENT_HUB_CONTEXT_TREE_REPO: ${AGENT_HUB_CONTEXT_TREE_REPO}
      AGENT_HUB_GITHUB_TOKEN: ${AGENT_HUB_GITHUB_TOKEN}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8000/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
    restart: unless-stopped
```

## Troubleshooting

### "prepared statement does not exist" errors

You're using the pooled connection (port 6543). Switch to the direct connection (port 5432).

### Connection timeouts

Supabase pauses inactive Free-tier databases after 7 days. Visit the Supabase dashboard to unpause.

### "too many connections" errors

Check your plan's connection limit. Agent Hub's LISTEN connection stays open permanently — this is expected and counts toward your limit.
