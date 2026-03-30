---
title: "Unified CLI and Command Architecture"
owners: [baixiaohang]
soft_links: [agent-hub/deployment.md]
---

# Unified CLI and Command Architecture

The Command package (`@agent-team-foundation/first-tree-hub`) is the published npm package that users install. It is both a CLI tool and a programmatic library — external projects can import core functions without going through the command line.

---

## Why a Unified Package

Agent Hub has three runtime subsystems (Server, Client, Web), but users install **one thing**. The alternative — separate packages for server and client — forces users to manage version alignment, discover which packages exist, and read multiple READMEs. A single package with subcommands eliminates this:

```
npx @agent-team-foundation/first-tree-hub server start    # runs server
npx @agent-team-foundation/first-tree-hub client start    # runs client runtime
```

Web is embedded in Server as static files — no separate install or process.

---

## Core / CLI Separation

The Command package separates **reusable logic** from **argument parsing**:

```
command/src/
├── core/          # Exportable functions — the real logic
├── cli/           # Commander.js entry point — thin shell
└── commands/      # Individual command registrations — arg parsing → core calls
```

### Why this matters

The `core/` layer is designed to be imported by external projects. Context Tree's CLI, for example, can reuse Agent Hub's server startup and database management without forking or shelling out:

```typescript
import { startServer, checkDatabase } from "@agent-team-foundation/first-tree-hub"

// Programmatic server start with custom options
await startServer({ port: 9000, databaseUrl: "..." })
```

This is why `core/` has no CLI dependencies (no Commander.js, no terminal formatting). It exports pure functions that accept options and return results. The `commands/` layer is a thin translation from CLI arguments to `core/` function calls.

---

## Interactive-First Design

The CLI is designed for humans first, automation second:

- **With TTY (local terminal):** Missing configuration triggers interactive prompts — the CLI guides the user through setup on first run.
- **Without TTY (Docker / CI):** Prompts are skipped automatically. Missing required config exits with an error listing what's needed and the corresponding environment variable names.
- **`--no-interactive`:** Forces non-interactive mode even with a TTY.

This means `server start` on a fresh machine walks the user through database setup, admin account creation, and configuration — no README required. The same command in a Dockerfile uses environment variables and fails fast if something is missing.

---

## Doctor Diagnostics

`first-tree-hub status` runs a suite of health checks that verify the entire stack:

- Node.js version, Docker availability
- Database connectivity and migration status
- Server health and WebSocket connectivity
- Context Tree repo configuration and GitHub token
- Agent configurations and client connectivity

The doctor system exists because Agent Hub spans multiple concerns (database, server process, external API tokens, agent configs) and users need a single command to diagnose what's wrong. Each check is an independent function in `core/` — composable and testable.

---

## Command Structure

Two core verbs — `server start` and `client start` — cover daily use. Everything else is auxiliary setup, diagnostics, or management. See [deployment.md](deployment.md) for the full command tree, startup flow, and configuration system.
