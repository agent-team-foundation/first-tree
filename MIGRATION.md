# Migration guide

Breaking changes that require user / ops action. Add new entries at the
top. Each section pins a single self-contained migration.

---

## Phase 1A — commands tree restructure + env rename (PR #502)

**Affects**: everyone on a Hub CLI from before this change, and every
production deployment of the Hub server.

**Why**: pre-merge snapshot for the `first-tree-hub` ↔ `first-tree` repo
consolidation (Phase 2 + 3). The CLI command surface and env names are
flipping to their post-merge shape now so the actual merge diff stays
small.

**Not included**: bin name (`first-tree-hub`), npm name
(`@agent-team-foundation/first-tree-hub`), and `program.name(...)` are
unchanged. Those flip at Phase 3 T3.2 when v1.0.0 ships as `first-tree`.

### 1. CLI users on a machine that already runs the daemon

You **must** reinstall the background daemon so launchd / systemd pick
up the new `daemon start --no-interactive` ExecStart and the new
`FIRST_TREE_SERVICE_MODE` env name. A bare `npm i -g` upgrade is not
enough on its own — the old unit file still on disk will try to spawn
the retired `client start` verb (now an `unknown command`).

```bash
first-tree-hub logout
first-tree-hub login <token>
```

`logout` stops the running daemon and clears credentials.
`login <token>` re-exchanges the connect token, rewrites the unit file
with the new ExecStart, and starts the daemon. Pass `--no-start` if you
want to skip the auto-install (for containers / CI).

Equivalent one-shot for users on the published CLI who upgrade via
`first-tree-hub upgrade`: nothing extra — `upgrade` already calls
`installClientService()` to refresh the unit file before restarting.
The reinstall above is only required for users who bypass that path
(direct `npm i -g`, dev source checkouts, custom installers).

### 2. CLI command renames

The pre-merge `client` / `connect` / `onboard` namespace has been
flattened into top-level verbs plus a `daemon` namespace. Folded /
deleted verbs are listed last; the table covers every public command
that changed.

| Old | New | Notes |
| --- | --- | --- |
| `first-tree-hub connect <token>` | `first-tree-hub login <token>` | `--no-service` renamed to `--no-start`. New `--override` flag folds in the retired `client claim`. |
| `first-tree-hub client claim --confirm` | `first-tree-hub login <token> --override` | Same server-side `POST /clients/:id/claim` + stale-alias cleanup, but folded into `login` so the operator does both steps with one command. |
| `first-tree-hub update [--check] [--no-restart]` | `first-tree-hub upgrade [--check] [--no-restart]` | Flags unchanged. |
| `first-tree-hub client start` | `first-tree-hub daemon start` | `daemon start` is **fail-closed** when no credentials exist — it exits 1 with a `NO_CREDENTIALS` error pointing at `login` instead of dropping into the interactive prompt path the old `client start` had. |
| `first-tree-hub client stop` | `first-tree-hub daemon stop` | — |
| `first-tree-hub client restart` | `first-tree-hub daemon restart` | — |
| `first-tree-hub client status` | `first-tree-hub daemon status` *or* top-level `first-tree-hub status` | `daemon status` is the local service view; the top-level `status` is the cross-subsystem overview (CLI version + service + hub + auth + agents). |
| `first-tree-hub client doctor` | `first-tree-hub daemon doctor` *or* top-level `first-tree-hub doctor` | Same split as `status`. |
| `first-tree-hub client config show/set/get` | `first-tree-hub config show/set/get` | Promoted out of the `client` namespace; flags / dot-notation unchanged. |
| `first-tree-hub client list` | (removed) | The Hub web admin's *Computers* tab is now the canonical surface. |
| `first-tree-hub client disconnect <clientId>` | (removed) | Same — *Computers* tab → Disconnect. |
| `first-tree-hub onboard [...]` | (sequence: `login` + `agent create` + optional `agent bind bot|user` + `daemon start`) | Each verb fails / recovers independently. See `docs/onboarding-guide.md` for the full sequence. |
| New: `first-tree-hub logout [--purge]` | — | Symmetric to `login`. Stops the daemon + deletes `credentials.json`. `--purge` also deletes `client.yaml`. |
| New placeholder: `first-tree-hub tree` | — | Visible in `--help` with description `"(Phase 3 — not yet implemented)"`. Wired in Phase 3 T3.1. |
| New placeholder: `first-tree-hub github` | — | Same. |

### 3. Production server env rename (zero-alias breaking)

**All `FIRST_TREE_HUB_*` env vars are renamed to `FIRST_TREE_*`.** There
is **no fallback alias**: the server reads only the new names. Helm
charts, docker-compose files, k8s Secrets, and CI secret stores must be
updated **in the same window** as the server image lands, or the
process will boot with missing required envs (`FIRST_TREE_DATABASE_URL`
/ `FIRST_TREE_JWT_SECRET` / `FIRST_TREE_ENCRYPTION_KEY` will trip
`boot-guards.ts` and refuse to start).

Mechanical rename rule: drop the `_HUB` segment. Examples:

| Old | New |
| --- | --- |
| `FIRST_TREE_HUB_DATABASE_URL` | `FIRST_TREE_DATABASE_URL` |
| `FIRST_TREE_HUB_PORT` | `FIRST_TREE_PORT` |
| `FIRST_TREE_HUB_HOST` | `FIRST_TREE_HOST` |
| `FIRST_TREE_HUB_JWT_SECRET` | `FIRST_TREE_JWT_SECRET` |
| `FIRST_TREE_HUB_ENCRYPTION_KEY` | `FIRST_TREE_ENCRYPTION_KEY` |
| `FIRST_TREE_HUB_PUBLIC_URL` | `FIRST_TREE_PUBLIC_URL` |
| `FIRST_TREE_HUB_CORS_ORIGIN` | `FIRST_TREE_CORS_ORIGIN` |
| `FIRST_TREE_HUB_WEB_DIST_PATH` | `FIRST_TREE_WEB_DIST_PATH` |
| `FIRST_TREE_HUB_TRUST_PROXY` | `FIRST_TREE_TRUST_PROXY` |
| `FIRST_TREE_HUB_WS_MAX_PAYLOAD` | `FIRST_TREE_WS_MAX_PAYLOAD` |
| `FIRST_TREE_HUB_WORKSPACES_ROOT` | `FIRST_TREE_WORKSPACES_ROOT` |
| `FIRST_TREE_HUB_POLLING_INTERVAL_SECONDS` | `FIRST_TREE_POLLING_INTERVAL_SECONDS` |
| `FIRST_TREE_HUB_PRESENCE_CLEANUP_SECONDS` | `FIRST_TREE_PRESENCE_CLEANUP_SECONDS` |
| `FIRST_TREE_HUB_NOTIFICATION_WEBHOOK_URL` | `FIRST_TREE_NOTIFICATION_WEBHOOK_URL` |
| `FIRST_TREE_HUB_GIT_CLONE_TIMEOUT_MS` | `FIRST_TREE_GIT_CLONE_TIMEOUT_MS` |
| `FIRST_TREE_HUB_MAX_RETRY_COUNT` | `FIRST_TREE_MAX_RETRY_COUNT` |
| `FIRST_TREE_HUB_RATE_LIMIT_*` | `FIRST_TREE_RATE_LIMIT_*` |
| `FIRST_TREE_HUB_AUTH_*_TOKEN_EXPIRY` | `FIRST_TREE_AUTH_*_TOKEN_EXPIRY` |
| `FIRST_TREE_HUB_INBOX_*` | `FIRST_TREE_INBOX_*` |
| `FIRST_TREE_HUB_GITHUB_OAUTH_*` | `FIRST_TREE_GITHUB_OAUTH_*` |
| `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` | `FIRST_TREE_DEV_CALLBACK_ENABLED` |
| `FIRST_TREE_HUB_GITHUB_APP_*` | `FIRST_TREE_GITHUB_APP_*` |
| `FIRST_TREE_HUB_GITHUB_API_BASE_URL` | `FIRST_TREE_GITHUB_API_BASE_URL` |
| `FIRST_TREE_HUB_OTEL_*` | `FIRST_TREE_OTEL_*` |
| `FIRST_TREE_HUB_LOG_LEVEL` | `FIRST_TREE_LOG_LEVEL` |

The complete mapping (every renamed env, grouped by surface — server /
CLI user-facing / CLI internal / build) lives in the design doc:
[`hub-env-rename-mapping.md`](https://github.com/agent-team-foundation/first-tree-context/blob/main/proposals/hub-env-rename-mapping.md).

### 4. CLI user-facing envs (users set these in their shell or service unit)

| Old | New | Notes |
| --- | --- | --- |
| `FIRST_TREE_HUB_HOME` | `FIRST_TREE_HOME` | CLI home directory override. Default `~/.first-tree/hub`. |
| `FIRST_TREE_HUB_DEV_HOME` | `FIRST_TREE_DEV_HOME` | `scripts/dev-cli.sh` override. |
| `FIRST_TREE_HUB_JSON` | `FIRST_TREE_JSON` | JSON output mode (equivalent to `--json`). |
| `FIRST_TREE_HUB_SERVER_URL` | `FIRST_TREE_SERVER_URL` | Per-call server URL override. |
| `FIRST_TREE_HUB_LOG_LEVEL` | `FIRST_TREE_LOG_LEVEL` | Logger level. |
| `FIRST_TREE_HUB_UPDATE_*` | `FIRST_TREE_UPDATE_*` | Self-update channel / policy / intervals. |

### 5. Agent runtime envs (CLI injects these; users don't set them)

`FIRST_TREE_HUB_AGENT_ID`, `_CHAT_ID`, `_ACCESS_TOKEN`, `_CLIENT_ID`,
`_INBOX_ID` → `FIRST_TREE_*` equivalents. Picked up automatically when
the CLI is upgraded — no action required on the agent side.

### 6. CLI internal envs (CLI sets these for its own subprocesses)

`FIRST_TREE_HUB_SERVICE_MODE` → `FIRST_TREE_SERVICE_MODE`. This is the
supervisor → child flag baked into the launchd plist and systemd unit
templates. **This is why §1 (reinstall the daemon) is mandatory** —
without rewriting the unit file, the supervisor will keep injecting the
old env name, which the new CLI no longer reads, so the child will boot
without knowing it's running under a supervisor and may recursively
delegate back to `systemctl/launchctl`.

### 7. Retired envs (no replacement)

`FIRST_TREE_HUB_AGENT_TOKEN`, `FIRST_TREE_HUB_AGENT`,
`FIRST_TREE_HUB_TOKEN`, and `FIRST_TREE_HUB_CLAUDE_CODE_EXECUTABLE` are
gone with no replacement — per-agent bearer tokens were retired in the
unified-user-token milestone, and `CLAUDE_CODE_EXECUTABLE` (no prefix)
is the real env name. Drop these from any shell rc / CI secret / agent
launch script you still maintain.

### 8. Code-symbol rename (downstream importers only)

The OTel tracing attribute constant renamed:

| Old | New |
| --- | --- |
| `FIRST_TREE_HUB_ATTR` constant | `FIRST_TREE_ATTR` |
| `FirstTreeHubAttrKey` type | `FirstTreeAttrKey` |
| `FirstTreeHubAttrName` type | `FirstTreeAttrName` |

Only relevant if you import `@first-tree/shared/observability` from
another package.

---

## Verification after migration

After updating the server deployment + CLI users running `logout`
followed by `login <token>`:

```bash
# CLI side — should all be green:
first-tree-hub status                 # CLI version + service + hub + auth + agents
first-tree-hub daemon doctor          # service + agent configs + WS reachability
first-tree-hub --help                 # 5 top-level verbs + 7 namespaces

# Server side — usual health check:
curl -sf https://<hub-public-url>/healthz | jq
```

If `daemon doctor` reports "service installed, inactive" persistently
after `login`, run `journalctl --user -u first-tree-hub-client -n 50`
(Linux) or `cat ~/.first-tree/hub/logs/client.stderr.log` (macOS) — a
stale unit file from before the upgrade may still be on disk. Re-run
`first-tree-hub logout && first-tree-hub login <token>` to force a
clean rewrite.
