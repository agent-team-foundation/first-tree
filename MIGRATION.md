# Migration guide

Breaking changes that require user / ops action. Add new entries at the
top. Each section pins a single self-contained migration.

---

## Phase 2 — multi-env split (prod / staging / dev as independent CLIs)

**Affects**: every team member running a daemon connected to
`dev.cloud.first-tree.ai` (today's "staging" via the single
`first-tree` package). Local-dev users who use `scripts/dev-cli.sh` are
auto-migrated by the replacement `scripts/dev-install.sh`.

**Why**: prod and staging daemons need to coexist on the same machine
with independent auto-update tracks. A single npm package can't host
that — one global install per package name. We split into three
packages and home dirs, one per channel:

| Layer | Before (single pkg) | prod | staging | dev |
| --- | --- | --- | --- | --- |
| npm package | `first-tree` | `first-tree` | `first-tree-staging` | (not published) |
| bin name | `first-tree` / `ft` | `first-tree` / `ft` | `first-tree-staging` / `fts` | `first-tree-dev` / `ftd` |
| Default home | `~/.first-tree/hub/` | `~/.first-tree/` | `~/.first-tree-staging/` | `~/.first-tree-dev/` |
| systemd unit | `first-tree-client.service` | `first-tree.service` | `first-tree-staging.service` | `first-tree-dev.service` |
| launchd label | `dev.first-tree.client` | `first-tree` | `first-tree-staging` | `first-tree-dev` |
| Default server | (set at login time) | `cloud.first-tree.ai` | `dev.cloud.first-tree.ai` | `127.0.0.1:8000` |

Auto-update is now gated on a channel-mismatch guard: a binary refuses
to install a target version whose channel does not match its own (e.g.
prod CLI refuses `…-staging.X.Y`). Misconfigured servers can no
longer brick a connected daemon by advertising a cross-channel version.

### Team-member staging migration

Get a fresh connect-token from <https://dev.cloud.first-tree.ai/clients>
(**Connect computer** button), then run on each machine. **Data
preservation**: every step is `mv`-only — `credentials.json`,
`client.yaml`, workspaces, logs, and session state all move bit-for-bit.

#### Linux (systemd)

```bash
TOKEN=<paste-token-here>

# 1. Stop + remove the old service unit
systemctl --user stop first-tree-client.service 2>/dev/null || true
systemctl --user disable first-tree-client.service 2>/dev/null || true
rm -f ~/.config/systemd/user/first-tree-client.service \
      ~/.config/systemd/user/first-tree-hub-client-dev.service
systemctl --user daemon-reload

# 2. Move the home dir (data preserved)
mv ~/.first-tree/hub ~/.first-tree-staging

# 3. Switch CLI package
npm uninstall -g first-tree 2>/dev/null || true
npm install -g first-tree-staging

# 4. Re-login — rewrites first-tree-staging.service and starts the daemon
first-tree-staging login "$TOKEN"

# 5. Verify
systemctl --user status first-tree-staging.service
first-tree-staging status
```

#### macOS (launchd)

```bash
TOKEN=<paste-token-here>

# 1. Stop + remove the old plist
launchctl bootout gui/$(id -u)/dev.first-tree.client 2>/dev/null || true
rm -f ~/Library/LaunchAgents/dev.first-tree.client.plist

# 2-4. Same as Linux above

# 5. Verify
launchctl list | grep first-tree
first-tree-staging status
```

### Rollback

If `npm install -g first-tree-staging` or `first-tree-staging login`
fails after step 2 has already moved your home dir, the original layout
is one `mv` away (everything is preserved bit-for-bit since the migration
never copies):

```bash
mv ~/.first-tree-staging ~/.first-tree/hub
npm install -g first-tree         # restore the old package
first-tree login "$TOKEN"          # rewrites the original service unit
```

### What does NOT migrate (intentional)

- `~/.first-tree/hub-dev/` — dev workspace data. `scripts/dev-install.sh`
  on first run auto-`mv`s this to `~/.first-tree-dev/`. Don't pre-move it.
- `~/.first-tree/hub.broken-snapshot-*` — historical backups, untouched.
- `~/.first-tree/version-check.json` — CLI cache, rebuilt on next start.

### Adding a prod daemon later

Once you have a prod connect-token, install the prod package alongside
staging — they share zero state:

```bash
npm install -g first-tree
first-tree login <prod-token>
# → ~/.first-tree/, first-tree.service, prod cloud
```

Two daemons now run side-by-side. `first-tree-staging status` and
`first-tree status` report independently.

### Bin name break

The old `ft` short alias now belongs exclusively to the prod package.
Staging uses `fts`, dev uses `ftd`. Update any shell aliases / scripts.

### Server-side ops

Each cluster now sets one new env var: `FIRST_TREE_CHANNEL=prod|staging|dev`.
Web onboarding / "Connect computer" commands and the npm auto-update
poller derive package name and bin name from this single switch. The
old `FIRST_TREE_UPDATE_CHANNEL` env is removed (each package owns its
own `latest` dist-tag, no per-server channel selection needed).

---

## Phase 1A — commands tree restructure + env rename (PR #502)

**Affects**: everyone on a `first-tree` CLI from before this change, and
every production deployment of the `first-tree` server.

**Why**: pre-merge snapshot for the `first-tree` ↔ `first-tree` repo
consolidation (Phase 2 + 3). The CLI command surface and env names are
flipping to their post-merge shape now so the actual merge diff stays
small.

**Not included**: bin name (`first-tree`), npm name
(`first-tree`), and `program.name(...)` are
unchanged. Those flip at Phase 3 T3.2 when v1.0.0 ships as `first-tree`.

### 1. CLI users on a machine that already runs the daemon

You **must** reinstall the background daemon so launchd / systemd pick
up the new `daemon start --no-interactive` ExecStart and the new
`FIRST_TREE_SERVICE_MODE` env name. A bare `npm i -g` upgrade is not
enough on its own — the old unit file still on disk will try to spawn
the retired `client start` verb (now an `unknown command`).

```bash
first-tree logout
first-tree login <code>
```

`logout` stops the running daemon and clears credentials.
`login <code>` re-exchanges the connect token, rewrites the unit file
with the new ExecStart, and starts the daemon. Pass `--no-start` if you
want to skip the auto-install (for containers / CI).

Equivalent one-shot for users on the published CLI who upgrade via
`first-tree upgrade`: nothing extra — `upgrade` already calls
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
| `first-tree connect <token>` | `first-tree login <code>` | `--no-service` renamed to `--no-start`. |
| `first-tree client claim --confirm` | (removed) | There is no longer a client ownership transfer command. To switch this machine to another account, run `first-tree login <code>` with the new account and confirm the local-client switch. `logout --purge` retires the current server client before deleting local state and is not the normal account-switch path. |
| `first-tree update [--check] [--no-restart]` | `first-tree upgrade [--check] [--no-restart]` | Flags unchanged. |
| `first-tree client start` | `first-tree daemon start` | `daemon start` is **fail-closed** when no credentials exist — it exits 1 with a `NO_CREDENTIALS` error pointing at `login` instead of dropping into the interactive prompt path the old `client start` had. |
| `first-tree client stop` | `first-tree daemon stop` | — |
| `first-tree client restart` | `first-tree daemon restart` | — |
| `first-tree client status` | `first-tree daemon status` *or* top-level `first-tree status` | `daemon status` is the local service view; the top-level `status` is the cross-subsystem overview (CLI version + service + server + auth + agents). |
| `first-tree client doctor` | `first-tree daemon doctor` *or* top-level `first-tree doctor` | Same split as `status`. |
| `first-tree client config show/set/get` | `first-tree config show/set/get` | Promoted out of the `client` namespace; flags / dot-notation unchanged. |
| `first-tree client list` | (removed) | The web console's *Computers* tab is now the canonical surface. |
| `first-tree client disconnect <clientId>` | (removed) | Same — *Computers* tab → Disconnect. |
| `first-tree onboard [...]` | (sequence: `login` + `agent create` + optional `agent bind bot|user` + `daemon start`) | Each verb fails / recovers independently. See `docs/onboarding-guide.md` for the full sequence. |
| New: `first-tree logout [--purge]` | — | Symmetric to `login`. Stops the daemon + deletes `credentials.json`, including live `daemon start --foreground` runtimes for the active client. `--purge` first retires the current server client, suspending/unpinning agents routed through that client; those agents can later be moved to a connected computer/runtime from Web. It then deletes `client.yaml`, local agent configs, agent workspaces, and session state. |
| New placeholder: `first-tree tree` | — | Visible in `--help` with description `"(Phase 3 — not yet implemented)"`. Wired in Phase 3 T3.1. |
| New placeholder: `first-tree github` | — | Same. |

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
| `FIRST_TREE_HUB_RATE_LIMIT_MAX` | `FIRST_TREE_RATE_LIMIT_MAX` |
| `FIRST_TREE_HUB_AUTH_*_TOKEN_EXPIRY` | `FIRST_TREE_AUTH_*_TOKEN_EXPIRY` |
| `FIRST_TREE_HUB_INBOX_*` | `FIRST_TREE_INBOX_*` |
| `FIRST_TREE_HUB_GITHUB_OAUTH_*` | `FIRST_TREE_GITHUB_OAUTH_*` |
| `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` | `FIRST_TREE_DEV_CALLBACK_ENABLED` |
| `FIRST_TREE_HUB_GITHUB_APP_*` | `FIRST_TREE_GITHUB_APP_*` |
| `FIRST_TREE_HUB_GITHUB_API_BASE_URL` | `FIRST_TREE_GITHUB_API_BASE_URL` |
| `FIRST_TREE_HUB_OTEL_*` | `FIRST_TREE_OTEL_*` |
| `FIRST_TREE_HUB_LOG_LEVEL` | `FIRST_TREE_LOG_LEVEL` |

Only the global `FIRST_TREE_RATE_LIMIT_MAX` limit is read. Legacy per-route
rate-limit variables such as login, webhook, agent-message, and Context Tree
snapshot caps are ignored.

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
| `FIRST_TREE_HUB_UPDATE_*` | `FIRST_TREE_UPDATE_*` | Phase 1A self-update settings. The historical update-channel knob is later retired by Phase 2; server channel identity is `FIRST_TREE_CHANNEL`. |

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
followed by `login <code>`:

```bash
# CLI side — should all be green:
first-tree status                 # CLI version + service + server + auth + agents
first-tree daemon doctor          # service + agent configs + WS reachability
first-tree --help                 # 5 top-level verbs + 7 namespaces

# Server side — liveness (process) and readiness (boot stages + DB):
curl -sf https://<server-public-url>/healthz | jq
curl -sf https://<server-public-url>/readyz | jq
```

If `daemon doctor` reports "service installed, inactive" persistently
after `login`, run `journalctl --user -u first-tree-client -n 50`
(Linux) or `cat ~/.first-tree/hub/logs/client.stderr.log` (macOS) — a
stale unit file from before the upgrade may still be on disk. Re-run
`first-tree logout && first-tree login <code>` to force a
clean rewrite.
