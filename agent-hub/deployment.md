---
title: "Deployment Architecture"
owners: [baixiaohang]
soft_links: [agent-hub/cli.md]
---

# Deployment Architecture

Agent Hub ships as a single npm package (`@agent-team-foundation/first-tree-hub`) containing Server, Client, Web, and CLI. Two commands to run: `server start` and `client start`.

---

## Design Goals

| Goal | Description |
|------|-------------|
| **One command to start** | `first-tree-hub server start` — from zero to running in under a minute. |
| **Single artifact** | Server + Web + CLI in one npm package. Web is embedded as static files served by Server. |
| **PostgreSQL only** | User provides a PG URL, or CLI auto-provisions one via Docker. |
| **Secure by default** | No default passwords. Credentials auto-generated. Secrets never enter the database. |
| **Local first** | Fully functional without internet. Public access is an infrastructure choice, not a requirement. |

---

## Deployment Scenarios

All scenarios use the same `server start` / `client start` commands. The difference is infrastructure:

| Scenario | PostgreSQL | Public Access | Process Management |
|----------|-----------|---------------|-------------------|
| **Local / eval** | Auto-provisioned (Docker) | None (localhost) | Foreground |
| **Single VPS** | Auto or managed | Caddy auto-HTTPS | systemd |
| **Home server** | Auto-provisioned | Cloudflare Tunnel | systemd |
| **Cloud platform** | Managed (Neon, Supabase) | Platform-provided | Platform-managed |

---

## Command Tree

Two core verbs — `server start` and `client start` — cover daily use. Everything else is auxiliary. For CLI architecture (core/cli separation, programmatic reuse), see [cli.md](cli.md).

```
first-tree-hub
├── server
│   ├── start [--port] [--database-url]     # Start server (interactive config on first run)
│   ├── stop                                 # Stop managed PG container
│   ├── status                               # Health check
│   ├── doctor                               # Environment readiness
│   ├── db:migrate                           # Run pending migrations
│   └── admin:create                         # Create admin user
├── client
│   ├── start                                # Start all configured agents
│   └── stop / status / doctor               # Lifecycle + diagnostics
├── agent
│   ├── add / remove / list                  # Agent config management
│   ├── token bootstrap                      # Bootstrap token via GitHub identity
│   ├── bind bot / bind user                 # Feishu bindings
│   ├── send / chats / history               # Messaging (debugging)
│   └── register / pull                      # Low-level SDK debugging
├── config
│   ├── setup                                # Interactive configuration
│   └── set / get / list                     # Manage config values
├── onboard [--check|--continue]             # Self-service onboarding
└── status                                   # Global overview
```

---

## Server Start Flow

```
$ first-tree-hub server start

  1. Load config (CLI args > env vars > ~/.first-tree-hub/server.yaml > auto-generate > defaults)
  2. Resolve PostgreSQL (--database-url or env → use directly; neither → Docker auto-provision)
  3. Run database migrations (Drizzle)
  4. Check admin account (exists → skip; missing → auto-create, print password once)
  5. Start Fastify server (in-process)
     /api/v1/*  → API routes
     /web/*     → Web SPA (embedded static files)
  6. Ctrl+C → graceful shutdown (PG container stays running)
```

Interactive behavior: with TTY, missing config triggers interactive prompts. Without TTY (Docker/CI), missing required config exits with error listing what's needed.

---

## Configuration System

Unified configuration abstraction — business code calls `getConfigValue()`, never reads env/files directly.

### Resolution Order

```
CLI arguments > Environment variables > Config files > Auto-generated > Defaults
```

### Config Files

```
~/.first-tree-hub/
├── config/
│   ├── server.yaml              # Server config (port, database, JWT secret, etc.)
│   ├── client.yaml              # Client config (server URL, log level)
│   └── agents/
│       ├── agent-a/agent.yaml   # Per-agent config (token, type, concurrency)
│       └── agent-b/agent.yaml
└── data/                        # Runtime data (system-managed)
```

### Environment Variables

All prefixed with `FIRST_TREE_HUB_`:

| Variable | Scope | Description |
|----------|-------|-------------|
| `FIRST_TREE_HUB_DATABASE_URL` | Server | PostgreSQL connection string |
| `FIRST_TREE_HUB_PORT` | Server | Server port |
| `FIRST_TREE_HUB_JWT_SECRET` | Server | Admin JWT signing key (auto-generated if missing) |
| `FIRST_TREE_HUB_ENCRYPTION_KEY` | Server | AES key for adapter credentials (auto-generated) |
| `FIRST_TREE_HUB_GITHUB_TOKEN` | Server | GitHub token for Context Tree sync |
| `FIRST_TREE_HUB_SERVER_URL` | Client | Server URL for agent connections |

---

## Architecture Boundary

Agent Hub manages the application. Infrastructure is the user's choice:

```
Agent Hub manages:                    User manages (infrastructure):
──────────────────────               ──────────────────────────────
Server process (Node.js)              Reverse proxy (Caddy / Nginx)
PostgreSQL provisioning               TLS certificates (Let's Encrypt)
Database migrations                   Tunnels (Cloudflare Tunnel)
Agent runtime                         Process supervision (systemd / Docker)
Configuration                         Firewall, DNS
```

---

## Multi-Instance Server

Server is stateless. Multiple instances need no special configuration:

```
       Load Balancer
            │
   ┌────────┼────────┐
   ▼        ▼        ▼
 Inst 1   Inst 2   Inst 3     ← all stateless
   │        │        │
   └────────┼────────┘
       PostgreSQL              ← single source of state
```

- Inbox concurrent consumption naturally supports multi-instance (SKIP LOCKED).
- Real-time notifications broadcast to all instances via PG LISTEN/NOTIFY.
- Instance failure: clients reconnect to other instances; messages persist in PG.
