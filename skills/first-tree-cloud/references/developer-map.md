# First Tree Developer Map

## Repo Entry Points

- `AGENTS.md` — architecture rules, conventions, package map, development workflow.
- `README.md` — product framing, quick start, top-level documentation links.
- `docs/cli-reference.md` — public command and environment variable reference.
- `docs/onboarding-guide.md` — end-to-end onboarding flow, including agent claim + Feishu binding.

## CLI Source Map

Phase 1A of the repo-merge refactor split the old monolithic command
files into namespace subdirectories. Each verb / subcommand lives in its
own file; helpers shared across namespaces live in `commands/_shared/`.

- `apps/cli/src/cli/index.ts` — top-level Commander program and dispatcher. Registers 5 top-level shortcuts + 5 active namespaces + 2 placeholder namespaces.
- **Top-level shortcuts** (single-verb files):
  - `apps/cli/src/commands/login.ts` — `login <token> [--no-start] [--override]`. Decodes the token's `iss` claim to derive the hub URL, persists `credentials.json`, writes `server.url` into `client.yaml`, installs the background daemon (unless `--no-start`). `--override` folds in the old `client claim` behavior (POST `/clients/:id/claim` + stale alias cleanup).
  - `apps/cli/src/commands/logout.ts` — `logout [--purge]`. Symmetric to `login`: stops the daemon + deletes `credentials.json`; `--purge` also wipes `client.yaml`.
  - `apps/cli/src/commands/status.ts` — top-level cross-subsystem overview (CLI version + service + hub + auth + agents).
  - `apps/cli/src/commands/doctor.ts` — top-level cross-subsystem readiness check. Phase 1A ships the daemon-side checks; Phase 3 wires in tree / git / claude-code binary checks via the same shared helper.
  - `apps/cli/src/commands/upgrade.ts` — `upgrade [--check] [--no-restart]`. Self-upgrade via the npm registry + refresh unit + restart daemon. Refuses to run from a source checkout.
- **Namespaces** (subdirectories with their own `index.ts` registrar):
  - `apps/cli/src/commands/daemon/` — daemon lifecycle (`start` / `stop` / `restart` / `status` / `doctor`). `daemon/start.ts` is the only command that loads `ClientRuntime`; it fails closed when no credentials exist, pointing the operator at `login`.
  - `apps/cli/src/commands/config/` — top-level local YAML editing (`show` / `set` / `get`). Promoted out of the old `client config` subgroup in Phase 1A.
  - `apps/cli/src/commands/agent/` — agent management. Subdirectories: `agent/bind/` (client/bot/user), `agent/workspace/` (clean), `agent/session/` (list + suspend/terminate), `agent/debug/` (hidden register), `agent/config/` (server-side runtime config: show / set-model / append-prompt / add-mcp / set-env / add-repo / dry-run). Top-level verbs: `add` / `remove` / `prune` / `list` / `create` / `claim` / `status` / `reset`.
  - `apps/cli/src/commands/chat/` — `send` / `invite` / `list` / `history` / `open`. Day-to-day messaging.
  - `apps/cli/src/commands/org/` — `bind-tree` (only command today).
  - `apps/cli/src/commands/tree/` — placeholder for the unified `tree` namespace; Phase 3 T3.1 wires this through to the shared `first-tree tree` surface.
  - `apps/cli/src/commands/github/` — placeholder for the unified `github` namespace; same Phase 3 trigger.
- **Shared helpers** (`apps/cli/src/commands/_shared/`):
  - `connect-token.ts` — `decodeJwtPayload`, `deriveHubUrlFromToken`, `HubUrlDerivationError`. Reused by `login` and any future caller that needs to introspect a connect token.
  - `local-agent.ts` — `resolveLocalAgent`, `createSdk`, `handleSdkError`, `readClientId`. Used by agent and chat namespaces to resolve the sender agent from the local config.
  - `resolve-agent.ts` — `resolveAgent` (cross-org `/me/managed-agents` lookup), used by every command that addresses a Hub agent by name.
  - `account-transfer.ts` — `postClaim` + `cleanupStaleAliasesAfterClaim`. Used by `login --override` to transfer machine ownership and prune the previous owner's local aliases.
  - `status-blocks.ts` — pure render blocks for `status` and `daemon status` (CLI version, service, hub, auth, agents).

## Reusable Core Logic

- `apps/cli/src/core/bootstrap.ts` — credential persistence (`saveCredentials`, `loadCredentials`) and token freshness (`resolveAccessToken`, `ensureFreshAccessToken`), plus `resolveServerUrl` and `saveAgentConfig`. `ensureFreshAdminToken` is a back-compat alias of `ensureFreshAccessToken`.
- `apps/cli/src/core/service-install.ts` — `installClientService`, `uninstallClientService`, `getClientServiceStatus`, `isServiceSupported`, `resolveCliInvocation`, plus the `startClientService` / `stopClientService` / `restartClientService` thin wrappers. Handles launchd (macOS) and `systemd --user` (Linux); marks other platforms as `unsupported`. Logs go to `~/.first-tree/hub/logs/`. The launchd plist / systemd unit templates spawn `daemon start --no-interactive`.
- `apps/cli/src/core/client-runtime.ts` — the long-lived `ClientRuntime` used by `daemon start` and `login`'s inline-run fallback. Watches the agents config dir for hot-add and uses `ensureFreshAccessToken` on every WebSocket handshake.
- `apps/cli/src/core/doctor.ts` — readiness checks used by `daemon doctor` and the top-level `doctor`: `checkNodeVersion`, `checkClientConfig`, `checkServerReachable`, `checkAgentConfigs`, `checkWebSocket`, `checkBackgroundService`, plus `reconcileAgentConfigs` (server-aware variant).
- `apps/cli/src/core/feishu.ts` — `bindFeishuBot`, `bindFeishuUser`.
- `apps/cli/src/core/agent-prune.ts` — `findStaleAliases`, `removeLocalAgent`, `formatStaleReason`. Used by `agent prune` and by `_shared/account-transfer.ts`.
- `apps/cli/src/core/prompt.ts` — `isInteractive`, `promptAddAgent`, `promptMissingFields` (schema-driven prompting).
- `apps/cli/src/core/output.ts` — `print.{result, fail, status, check, blank, line}` for consistent stderr / stdout output.

If you change command behavior, there is a good chance the real logic belongs in one of these core modules (or `commands/_shared/`) rather than in the command handler itself.

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
- `packages/server/src/api/auth/` — connect-token, refresh endpoints consumed by `login` and `ensureFreshAccessToken`.
- `packages/server/src/api/admin/` — agent admin, agent config, session, and client endpoints that the CLI calls.
- `packages/server/src/services/inbox.ts` — inbox push-claim / WS ack / silent-context bundling / timeout reset (adapter+kael consumers).

## Change Patterns

### Add or change a CLI command

1. Add the handler under the right namespace dir in `apps/cli/src/commands/` (`<verb>.ts` for a single command, `<ns>/<verb>.ts` for a namespace member). Keep handlers thin.
2. Move reusable logic into `apps/cli/src/core/` (cross-command) or `apps/cli/src/commands/_shared/` (cross-namespace within commands).
3. Register the command from the relevant namespace `index.ts`, then ensure that `index.ts` is registered from `apps/cli/src/cli/index.ts`.
4. Update barrel exports (`apps/cli/src/core/index.ts`, `apps/cli/src/index.ts`) if the functionality should be importable by other tools.
5. Update `docs/cli-reference.md` and `references/command-surface.md` in this skill.

### Change the credential / auth surface

1. Changes to login or refresh behavior touch `core/bootstrap.ts` and the `/api/v1/auth/*` routes.
2. Changes to the `login` flow touch `commands/login.ts` (and possibly `commands/_shared/connect-token.ts`, `commands/_shared/account-transfer.ts`) and (usually) `core/service-install.ts`.
3. Any change that adds or removes an auth env var must update `docs/cli-reference.md` and `references/command-surface.md` in this skill.

### Change onboarding behavior

The single-shot `onboard` command was retired in Phase 1A; onboarding is now a sequence of explicit verbs (`login` + `agent create` + optional `agent bind bot` + `daemon start`). To change onboarding behavior:

1. `commands/login.ts` for token exchange / `--override` flow.
2. `commands/agent/create.ts` for the Hub-side create + local bind step.
3. `commands/agent/bind/{bot,user}.ts` for IM bindings.
4. `docs/onboarding-guide.md` for user-facing changes.

### Change the background daemon

1. `core/service-install.ts` for platform-specific logic (launchd plist, systemd unit, log paths, CLI invocation resolution).
2. `commands/daemon/start.ts` for the foreground / supervisor-child branching and the fail-closed credential check.
3. `commands/login.ts` for the install-on-login behavior (`installClientService` invocation).
4. `core/doctor.ts` (`checkBackgroundService`) for what `daemon doctor` reports about service state.

### Change config behavior

1. Update the relevant schema under `packages/shared/src/config/`.
2. Check whether prompt text, defaults, env names, or secret masking rules also need changes.
3. Update `docs/cli-reference.md`.
4. Re-test the matching top-level `config` or `agent config` flows.

### Change messaging or agent runtime behavior

1. Start with `apps/cli/src/commands/agent/` (or `chat/`) if the CLI surface changes.
2. Inspect `packages/client/src/sdk.ts` and `packages/client/src/runtime/` if client runtime semantics change.
3. Inspect `packages/server/src/api/agent/` and `packages/server/src/services/` if server contracts change.
4. Update shared schemas in `packages/shared/src/schemas/` when payload shapes change.

## Validation Commands

Run the smallest relevant set first, then expand if the change touches cross-package behavior.

```bash
pnpm check
pnpm typecheck
pnpm --filter first-tree test
pnpm --filter @first-tree/client test
pnpm --filter @first-tree/server test
```

Use the package-specific commands when only one area changed, but keep in mind that the command package depends on shared behavior in `client`, `server`, and `shared`.

## External Consumption

The published CLI package is `first-tree`. Its public CLI binary is:

```bash
first-tree
```

Reusable code is also importable. When adding reusable CLI-adjacent behavior, preserve the separation:

- thin command handler for argument parsing
- reusable `core/*` function for behavior (or `commands/_shared/*` for command-only helpers shared across namespaces)
- re-export through `apps/cli/src/index.ts` when external callers need the API
