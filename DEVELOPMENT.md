# Local Development

This is the contributor entrypoint for running First Tree from a source
checkout. For architecture, ownership, and package-level conventions, keep
using [AGENTS.md](AGENTS.md). For the PR workflow, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Prerequisites

- Node.js 22.13 or newer. Node.js 24 is recommended.
- pnpm 10.x.
- Docker, for the local PostgreSQL service in [docker-compose.yml](docker-compose.yml).
- Optional: an HTTPS tunnel tool such as `ngrok`, `cloudflared`, or a similar
  service when testing real GitHub App callbacks and webhooks.

## Quickstart

From the repository root:

```bash
pnpm install
cp .env.example .env
docker compose up -d
DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/firsttree pnpm --filter @first-tree/server db:migrate
pnpm --filter @first-tree/server dev
pnpm --filter @first-tree/web dev --host 127.0.0.1
```

Run the server and web commands in separate terminals. The server command
loads the root `.env` file and enables the local dev GitHub callback stub via
its package script.

## Local URLs

- API server: `http://127.0.0.1:8000`
- Web workspace: `http://127.0.0.1:5173`
- Process liveness check: `http://127.0.0.1:8000/healthz` (does not query PostgreSQL)
- Bootstrap + database readiness check: `http://127.0.0.1:8000/readyz`
- Structured database diagnostic: `http://127.0.0.1:8000/api/v1/health`

Useful smoke checks:

```bash
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/readyz
curl http://127.0.0.1:8000/api/v1/health
```

## Minimal `.env`

For basic server and web development, these values are enough:

```dotenv
FIRST_TREE_DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/firsttree
FIRST_TREE_HOST=127.0.0.1
FIRST_TREE_PORT=8000
FIRST_TREE_CHANNEL=dev
```

The local `dev` channel can auto-generate `FIRST_TREE_JWT_SECRET` and
`FIRST_TREE_ENCRYPTION_KEY` when they are omitted. Set stable values only when
you need tokens or encrypted local rows to survive config regeneration.

The Vite web dev server proxies `/api/v1` to
`http://localhost:8000` by default. If your server is on another port or host,
start web with:

```bash
VITE_PROXY_TARGET=http://127.0.0.1:8001 pnpm --filter @first-tree/web dev --host 127.0.0.1
```

## GitHub Integration

A real GitHub App is not required for ordinary UI, API, CLI, or database work.
The local server's `dev` script enables `/api/v1/auth/github/dev-callback`,
which the login page can use to create a local test identity without a
github.com round trip.

Use [docs/development/local-github-app.md](docs/development/local-github-app.md)
when you need to test real GitHub OAuth, App installation, webhook ingestion,
installation-token flows, the repository picker, or one-click Context Tree
initialization.

## Local CLI Isolation

If you are developing the CLI or client runtime and need an in-tree
`first-tree-dev` command next to production or staging installs, use
[docs/development/local-dev-isolation.md](docs/development/local-dev-isolation.md).
That flow installs the dev binary and service into separate names and homes so
it does not touch `first-tree` or `first-tree-staging` state.

## Troubleshooting

### Stale `@first-tree/shared` Dist Builds

Some package exports resolve to `packages/shared/dist` when a built package is
loaded outside the TypeScript dev path. If a CLI, server, or test run appears
to use old shared schemas or channel config, rebuild shared:

```bash
pnpm --filter @first-tree/shared build
```

For broad changes, a full build is the simplest reset:

```bash
pnpm build
```

### Migration Env Var Naming

The running server reads `FIRST_TREE_DATABASE_URL`. Drizzle's CLI config reads
`DATABASE_URL`, so migration commands must pass `DATABASE_URL` explicitly even
when `.env` already contains `FIRST_TREE_DATABASE_URL`:

```bash
DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/firsttree pnpm --filter @first-tree/server db:migrate
```

Use the same rule for `db:generate`, `db:migrate`, and `db:studio`.

### Port Conflicts

The server defaults to port `8000`. Override it in `.env`:

```dotenv
FIRST_TREE_PORT=8001
```

Then point Vite at the new API target:

```bash
VITE_PROXY_TARGET=http://127.0.0.1:8001 pnpm --filter @first-tree/web dev --host 127.0.0.1
```

The web dev server defaults to port `5173`. If that port is busy, Vite prints
the alternate URL it selected. Use that URL in the browser.
