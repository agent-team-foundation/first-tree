# End-to-end tests (Momentic)

Browser-level tests that drive the real web app against a real server and
database.

## What this is

Optional tooling, not a QA layer. The QA contract in [AGENTS.md](../AGENTS.md) is
unchanged: deterministic behaviour belongs in per-package Vitest suites,
agent-skill regression in `@first-tree/skill-evals`, and judgment / live /
cross-surface validation in committed `@first-tree/qa` cases.

The journeys these tests walk are owned by the cases
[`registration-first-run-onboarding`](../packages/qa/cases/cross-surface/registration-first-run-onboarding.md)
and
[`external-context-current-session-handoff`](../packages/qa/cases/cross-surface/external-context-current-session-handoff.md).
The Agent Detail journey is owned by
[`agent-detail-availability-and-capabilities`](../packages/qa/cases/cross-surface/agent-detail-availability-and-capabilities.md).
The Chat Summary switching journey is owned by
[`chat-summary-chat-switch-reentry`](../packages/qa/cases/web/chat-summary-chat-switch-reentry.md).
The GitHub install identity-gate journey is owned by
[`github-settings-connection-panel`](../packages/qa/cases/cross-surface/github-settings-connection-panel.md).
Those cases remain the contracts and the place judgement lives. This directory
is one way to execute parts of them unattended, in the same spirit as the
fixtures and environment recipes under `packages/qa` — useful for a quick
regression pass, not a substitute for the cases and not a new authority over
what "validated" means.

Two limits follow from that and are deliberate:

- It is **not a CI gate** and is not wired into any workflow. Steps resolve from
  natural-language descriptions through a hosted model and some assertions are
  model-evaluated, so a red run is a signal to investigate, not a merge blocker.
- It covers selected visible journeys: registration, the connect-computer gate,
  the Web setup-prompt dialog, and the GitHub install identity gate before and
  after account linking. It does not drive real provider OAuth, GitHub App
  installation or owner approval, degraded provider states, or the evidence
  judgement the cases ask for.

A stable invariant that Vitest could assert still belongs in Vitest. Do not move
a check here to escape a flaky product test.

Run determinism is maximised where the tool allows: `momentic.config.yaml`
disables assertion memory and beta failure recovery, so a run executes only the
steps committed in this directory, and pins the agent versions.

## Prerequisites

### 1. Momentic account (external service)

The runner is a hosted product, not a local library. You need an account and a
local login before any of this works:

```bash
npx momentic@3.42.0 login             # writes ~/.momentic/auth.json
npx momentic@3.42.0 install-browsers  # one-time browser download
```

CI would additionally need a `MOMENTIC_API_KEY` secret.

**What leaves your machine.** Resolving a natural-language step and evaluating a
model-backed assertion sends page context — DOM snapshot and screenshot — to
Momentic's service. Runs against `local` therefore transmit whatever is on
screen in your local dev app. That is fine for the disposable `e2e-user-<ms>`
identities these tests create, but do not point this suite at an environment
holding real user data. `npx momentic results upload` additionally publishes a
run's screenshots and video to the Momentic dashboard; nothing is uploaded
unless you run that command.

### 2. Local First Tree stack

The local tests need the full stack from
[DEVELOPMENT.md](../DEVELOPMENT.md#quickstart) running:

```bash
docker compose up -d
DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/firsttree \
  pnpm --filter @first-tree/server db:migrate
pnpm --filter @first-tree/server dev          # :8000, enables the dev callback
pnpm --filter @first-tree/web dev --host 127.0.0.1   # :5173
```

The `local` environment in [momentic.config.yaml](../momentic.config.yaml)
points at `http://127.0.0.1:5173` (Vite proxies `/api/v1` to the server) and
passes `DATABASE_URL` through for the fixtures below.

The runner is intentionally **not** a workspace dependency: it shares transitive
packages with the product graph, and adding it to the root manifest re-resolved
unrelated runtime dependencies. Invoke it through a pinned `npx` instead.

## Running

```bash
npx momentic@3.42.0 run e2e/                              # everything
npx momentic@3.42.0 run e2e/registration-new-user.test.yaml
npx momentic@3.42.0 lint                                  # schema + file references
```

Each test carries its own `defaultEnv`, so the staging smoke check does not need
the local stack and the local tests do not touch staging.

## Tests

| Test | Env | Covers |
| --- | --- | --- |
| `registration-new-user.test.yaml` | local | A brand-new account is created and lands on onboarding step 1 |
| `onboarding-complete-setup.test.yaml` | local | The whole first-run journey: sign up → create team → connect a computer → create the first agent → start the kickoff chat → land in the workspace → open the Team-scoped own-agent setup path |
| `settings-coding-agent-prompt-dialog.test.yaml` | local | A signed-in Team with a bound Context Tree opens the real setup prompt, reviews the provider-neutral handoff, and copies it from the dialog |
| `agent-detail-configuration.test.yaml` | local | A Team admin follows one agent from the directory through its availability and effective tools into shared resource Settings |
| `chat-summary-current-state.test.yaml` | local | Two real Workspace chats switch their readable current-state hierarchy and collapse back to a one-line preview |
| `github-install-identity-gate.test.yaml` | local | A Google/OIDC-style admin is gated from install until GitHub is linked, then returns to the same Team with Install as a separate action |
| `dev-cloud-sign-in-available.test.yaml` | first-tree-dev-cloud | Staging serves the landing page and offers Google + GitHub sign-in |

`modules/sign-up-fresh-user.module.yaml` holds the shared sign-up flow. Each run
registers a **new** user (`e2e-user-<ms>`); reusing an identity would sign in as
the previous run's user instead of registering, so the tests are not idempotent
by design — they accumulate rows in the local dev database.

## Which environment runs what

| Environment | Target | Runs |
| --- | --- | --- |
| `local` | `http://127.0.0.1:5173` | Registration + onboarding (needs the dev sign-in stub and database fixtures) |
| `first-tree-dev-cloud` | `https://dev.cloud.first-tree.ai` | Deployment smoke check only |

The registration and onboarding tests **cannot** run against a deployed
environment, and this is by design rather than an omission:

- `auth/github/dev-callback`, the stub the tests sign up through, is gated on
  `NODE_ENV !== "production"` **and** an explicit `FIRST_TREE_DEV_CALLBACK_ENABLED`
  opt-in. It 404s on `dev.cloud.first-tree.ai`. Its sign-in page offers only real
  Google / GitHub OAuth, so automated sign-up there would mean driving a real
  identity provider with real credentials.
- The onboarding fixtures below write directly to PostgreSQL, which a deployed
  environment does not (and should not) expose.

Staging therefore only gets what it can support without a First Tree account:
that the app is served and the sign-in entry point offers both identity
providers. (A Momentic account is still required, as above.) That still catches a
broken deploy, a broken bundle, or a misconfigured auth surface.

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
rows that daemon would otherwise write. The setup-prompt test also uses
`scripts/seed-context-tree-binding.js` to supply the bound-tree prerequisite;
provider repository creation and authorization are separate from the prompt
dialog journey under test.

The fixtures replace the machine, not the behaviour under test — every screen,
transition, API call and assertion around them is exercised for real. What they
do **not** cover is the daemon's own registration handshake and heartbeat; that
belongs to client/runtime tests.

Because they bypass the server's schema with raw SQL, they must mirror what the
real write produces or the test would advance through a state the daemon can
never reach. `seed-agent-online.js` therefore writes `runtime_state = 'idle'` and
`runtime_updated_at`, matching `publishAgentPresence` in
`packages/server/src/services/presence.ts`.

Both fixtures write `last_seen_at` ahead of now on purpose. The server sweeps
connected clients and agents whose heartbeat is older than
`presenceCleanupSeconds` (60s by default — see `cleanupStaleClients` in
`packages/server/src/services/client.ts`). Without a heartbeat loop a plain
`NOW()` would decay mid-run and the flow would regress to "Your computer isn't
connected".

`set-test-user-provider-mode.js` substitutes only the external provider callback
for the GitHub install identity-gate journey. It keeps the existing First Tree
user, Team, membership, and browser tokens intact while changing that user's
provider rows from Google-only to Google+GitHub. The visible Settings flow and
all capability queries still run through the real web and server. It does not
claim to validate github.com's login, consent, installation picker, or owner
approval UI; deterministic server integration tests own those state and
authorization boundaries.

If onboarding ever stops depending on a connected daemon, delete the fixtures
rather than working around them.
