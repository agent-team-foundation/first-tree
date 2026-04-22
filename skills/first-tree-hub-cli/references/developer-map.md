# First Tree Hub Developer Map

## Repo Entry Points

- `AGENTS.md` — architecture rules, conventions, package map, development workflow.
- `README.md` — product framing, quick start, top-level documentation links.
- `docs/cli-reference.md` — public command and environment variable reference.
- `docs/onboarding-guide.md` — end-to-end onboarding flow.
- `docs/claim-agent-guide.md` — claim + Feishu binding details.
- `docs/deployment-guide.md` — Docker, Railway, Render, Supabase, HTTPS, production.

## CLI Source Map

- `packages/command/src/cli/index.ts` — top-level Commander program and command registration.
- `packages/command/src/commands/server.ts` — `server start/stop/status/doctor/db:migrate/admin:create`.
- `packages/command/src/commands/client.ts` — `client start/stop/status/doctor`, the `client service install/status/uninstall` subgroup, and the Hub-side `client hub-list/hub-disconnect` commands. Delegates `client connect` registration to `commands/connect.ts`.
- `packages/command/src/commands/connect.ts` — `client connect <server-url>`: writes `server.url`, authenticates via connect token or interactive login, persists `credentials.json`, installs the background service by default.
- `packages/command/src/commands/agent.ts` — local aliases (`add/remove/list`), `create`, `claim`, `workspace clean`, `bind client/bot/user`, messaging (`send/chats/history/register/pull`), runtime status (`status/reset/sessions/session/chat`). Delegates `agent config` registration to `commands/agent-config.ts`.
- `packages/command/src/commands/agent-config.ts` — `agent config get/set-model/append-prompt/add-mcp/set-env/add-repo/dry-run`, all thin wrappers over `/api/v1/admin/agents/:id/config`.
- `packages/command/src/commands/config.ts` — scope-aware `config setup/set/get/list` for `server.yaml`, `client.yaml`, and `agents/<name>/agent.yaml`.
- `packages/command/src/commands/status.ts` — top-level overview command.
- `packages/command/src/commands/onboard.ts` — guided onboarding, argument-shape only.

## Reusable Core Logic

- `packages/command/src/core/server.ts` — orchestration for `server start` (config prompts, Docker Postgres, migrations, admin creation, web dist resolution).
- `packages/command/src/core/onboard.ts` — agent creation via Admin API, optional assistant creation, optional Feishu binding; provides `onboardCheck` / `onboardCreate` / `formatCheckReport` / `loadOnboardState` / `saveOnboardState`.
- `packages/command/src/core/bootstrap.ts` — credential persistence (`saveCredentials`, `loadCredentials`) and token freshness (`resolveAccessToken`, `ensureFreshAccessToken`), plus `resolveServerUrl` and `saveAgentConfig`. `ensureFreshAdminToken` is a back-compat alias of `ensureFreshAccessToken`.
- `packages/command/src/core/service-install.ts` — `installClientService`, `uninstallClientService`, `getClientServiceStatus`, `isServiceSupported`, `resolveCliInvocation`. Handles launchd (macOS) and `systemd --user` (Linux); marks other platforms as `unsupported`. Logs go to `~/.first-tree/hub/logs/`.
- `packages/command/src/core/client-runtime.ts` — the long-lived `ClientRuntime` used by `client start` and `client connect --no-service`. Watches the agents config dir for hot-add and uses `ensureFreshAccessToken` on every WebSocket handshake.
- `packages/command/src/core/doctor.ts` — readiness checks used by `server doctor` and `client doctor`: `checkNodeVersion`, `checkDocker`, `checkServerConfig`, `checkDatabase`, `checkServerHealth`, `checkServerReachable`, `checkClientConfig`, `checkAgentConfigs`, `checkWebSocket`.
- `packages/command/src/core/feishu.ts` — `bindFeishuBot`, `bindFeishuUser`.
- `packages/command/src/core/docker-postgres.ts` — `ensurePostgres`, `isDockerAvailable`, `stopPostgres` (CLI-managed Docker Postgres container).
- `packages/command/src/core/migrate.ts` — `runMigrations`.
- `packages/command/src/core/admin.ts` — `createOwner`, `hasUser` (direct DB access for seeding).
- `packages/command/src/core/prompt.ts` — `isInteractive`, `promptAddAgent`, `promptMissingFields` (schema-driven prompting).
- `packages/command/src/core/output.ts` — `fail`, `success`, `blank`, `status` helpers for consistent stderr/stdout output.

If you change command behavior, there is a good chance the real logic belongs in one of these core modules rather than in the command handler itself.

## Shared Config and Schema Files

- `packages/shared/src/config/server-config.ts` — server config schema, defaults, prompts, env names.
- `packages/shared/src/config/client-config.ts` — client config schema.
- `packages/shared/src/config/agent-config.ts` — agent (local alias) config schema.
- `packages/shared/src/config/resolver.ts` — config priority resolution, YAML reading/writing, auto-generation.
- `packages/shared/src/config/singleton.ts` — `initConfig`, `resetConfig`, `resetConfigMeta` (per-process singleton so command handlers can reinit between subcommands).

If a flag, env var, or config key changes, inspect these files and update docs accordingly.

## Client and Server Runtime Files

- `packages/client/src/sdk.ts` — the agent SDK surface used by debugging flows and runtime internals.
- `packages/client/src/runtime/runtime.ts` — runtime orchestration for configured agents.
- `packages/client/src/runtime/bootstrap.ts` — optional Context Tree clone sync and `.agent/` workspace bootstrap.
- `packages/client/src/runtime/session-manager.ts` — session lifecycle and dedup-sensitive message dispatch.
- `packages/server/src/app.ts` — server wiring, route registration, background jobs.
- `packages/server/src/api/auth/` — login, connect-token, refresh endpoints consumed by `client connect` and `ensureFreshAccessToken`.
- `packages/server/src/api/admin/` — agent admin, agent config, session, and client endpoints that the CLI calls.
- `packages/server/src/services/inbox.ts` — inbox poll/ack/renew behavior.

## Change Patterns

### Add or change a CLI command

1. Update or add the handler in `packages/command/src/commands/`.
2. Move reusable logic into `packages/command/src/core/`.
3. Register the command from `packages/command/src/cli/index.ts` if it is new.
4. Update barrel exports (`packages/command/src/core/index.ts`, `packages/command/src/index.ts`) if the functionality should be importable by other tools.
5. Update `docs/cli-reference.md`.

### Change the credential / auth surface

1. Changes to login or refresh behavior touch `core/bootstrap.ts` and the `/api/v1/auth/*` routes.
2. Changes to `client connect` flow touch `commands/connect.ts` and (usually) `core/service-install.ts`.
3. Any change that adds or removes an auth env var must update `docs/cli-reference.md` and `references/command-surface.md` in this skill.

### Change onboarding behavior

1. `commands/onboard.ts` for argument shape or interaction flow only.
2. `core/onboard.ts` for the actual behavior.
3. `docs/onboarding-guide.md` for user-facing changes.
4. `docs/claim-agent-guide.md` if claim / binding behavior changes.

### Change the background service

1. `core/service-install.ts` for platform-specific logic (launchd plist, systemd unit, log paths, CLI invocation resolution).
2. `commands/client.ts` (the `service` subcommand group) for CLI surface.
3. `commands/connect.ts` if `client connect` install-on-connect behavior changes.

### Change config behavior

1. Update the relevant schema under `packages/shared/src/config/`.
2. Check whether prompt text, defaults, env names, or secret masking rules also need changes.
3. Update `docs/cli-reference.md`.
4. Re-test the matching `config`, `server`, or `client` flows.

### Change messaging or agent runtime behavior

1. Start with `packages/command/src/commands/agent.ts` if the CLI surface changes.
2. Inspect `packages/client/src/sdk.ts` and `packages/client/src/runtime/` if client runtime semantics change.
3. Inspect `packages/server/src/api/agent/` and `packages/server/src/services/` if server contracts change.
4. Update shared schemas in `packages/shared/src/schemas/` when payload shapes change.

## Validation Commands

Run the smallest relevant set first, then expand if the change touches cross-package behavior.

```bash
pnpm check
pnpm typecheck
pnpm --filter @agent-team-foundation/first-tree-hub test
pnpm --filter @first-tree-hub/client test
pnpm --filter @first-tree-hub/server test
```

Use the package-specific commands when only one area changed, but keep in mind that the command package depends on shared behavior in `client`, `server`, and `shared`.

## External Consumption

The published CLI package is `@agent-team-foundation/first-tree-hub`. Its public CLI binary is:

```bash
first-tree-hub
```

Reusable code is also importable. When adding reusable CLI-adjacent behavior, preserve the separation:

- thin command handler for argument parsing
- reusable `core/*` function for behavior
- re-export through `packages/command/src/index.ts` when external callers need the API
