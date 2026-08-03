# End-to-end tests (Momentic)

Browser-level tests that drive the real web app against a real server and
database. They complement — they do not replace — the per-package Vitest suites
described in [AGENTS.md](../AGENTS.md); deterministic behaviour still belongs in
product tests.

## Which environment runs what

| Environment | Target | Runs |
| --- | --- | --- |
| `first-tree-local` | `http://127.0.0.1:5173` | Registration + onboarding (needs the dev sign-in stub and database fixtures) |
| `first-tree-dev-cloud` | `https://dev.cloud.first-tree.ai` | Deployment smoke checks only |

The registration and onboarding tests **cannot** run against a deployed
environment, and this is by design rather than an omission:

- `auth/github/dev-callback`, the stub the tests sign up through, is gated on
  `NODE_ENV !== "production"` **and** an explicit `FIRST_TREE_DEV_CALLBACK_ENABLED`
  opt-in. It 404s on `dev.cloud.first-tree.ai`. Its sign-in page offers only real
  Google / GitHub OAuth, so automated sign-up there would mean driving a real
  identity provider with real credentials.
- The onboarding fixtures below write directly to PostgreSQL, which a deployed
  environment does not (and should not) expose.

So staging gets what it can support without credentials: that the app is served
and the sign-in entry point offers both identity providers. That still catches a
broken deploy, a broken bundle, or a misconfigured auth surface.

## Prerequisites

These tests need the full local stack from
[DEVELOPMENT.md](../DEVELOPMENT.md#quickstart) running:

```bash
docker compose up -d
DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/firsttree \
  pnpm --filter @first-tree/server db:migrate
pnpm --filter @first-tree/server dev          # :8000, enables the dev callback
pnpm --filter @first-tree/web dev --host 127.0.0.1   # :5173
```

The `first-tree-local` environment in [momentic.config.yaml](../momentic.config.yaml)
points at `http://127.0.0.1:5173` (Vite proxies `/api/v1` to the server) and
passes `DATABASE_URL` through for the fixtures below.

## Running

```bash
npx momentic run e2e/                              # everything
npx momentic run e2e/registration-new-user.test.yaml
npx momentic lint                                  # schema + file references
```

Each test carries its own `defaultEnv`, so the staging smoke check does not need
the local stack and the local tests do not touch staging.

## Tests

| Test | Env | Covers |
| --- | --- | --- |
| `registration-new-user.test.yaml` | local | A brand-new account is created and lands on onboarding step 1 |
| `onboarding-complete-setup.test.yaml` | local | The whole first-run journey: sign up → create team → connect a computer → create the first agent → start the kickoff chat → land in the workspace |
| `dev-cloud-sign-in-available.test.yaml` | dev-cloud | Staging serves the landing page and offers Google + GitHub sign-in |

`modules/sign-up-fresh-user.module.yaml` holds the shared sign-up flow. Each run
registers a **new** user (`e2e-user-<ms>`); reusing an identity would sign in as
the previous run's user instead of registering, so the tests are not idempotent
by design — they accumulate rows in the local dev database.

## Registration has no password path

First Tree accounts are created through GitHub / Google OAuth, so there is no
form to fill. The tests use `/api/v1/auth/github/dev-callback`, the product's own
localhost-only stub for the OAuth exchange, which the server `dev` script enables
via `FIRST_TREE_DEV_CALLBACK_ENABLED=1`. It is the real registration path with
the github.com round trip removed, and it 404s unless explicitly opted in
(and always in production).

## Fixtures, and what they stand in for

Two steps of onboarding wait on a *second machine* that a browser test does not
have: the First Tree client daemon, plus an installed coding-agent runtime.
`scripts/seed-connected-computer.js` and `scripts/seed-agent-online.js` seed the
rows that daemon would otherwise write.

The fixtures replace the machine, not the behaviour under test — every screen,
transition, API call and assertion around them is exercised for real. What they
do **not** cover is the daemon's own registration handshake and heartbeat; that
belongs to client/runtime tests.

Both fixtures write `last_seen_at` ahead of now on purpose. The server sweeps
connected clients and agents whose heartbeat is older than
`presenceCleanupSeconds` (60s by default — see `cleanupStaleClients` in
`packages/server/src/services/client.ts`). Without a heartbeat loop a plain
`NOW()` would decay mid-run and the flow would regress to "Your computer isn't
connected".

If onboarding ever stops depending on a connected daemon, delete the fixtures
rather than working around them.
