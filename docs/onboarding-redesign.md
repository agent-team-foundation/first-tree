# Hub Onboarding Redesign — Planning Doc

**Status:** Draft / Working doc. Delete or archive once Phase 4 lands.

**Branch:** `feat/first-tree-hub-onboarding`

**Companion:** `docs/onboarding-redesign-zh.md` (internal discussion version, Chinese).

---

## 1. Background and current state

### 1.1 Why this redesign

`docs/quickstart-zh.md` no longer matches the code on `origin/main`. The doc prescribes a `client connect` → New Agent → `agent add` sequence that doesn't exist in the running system; field labels, command shapes, and modal flows have all moved on (full drift list against `06e40fb`: "Generate Connect Command" button is now just `Generate` in a "Connect a computer" strip; `type` field on New Agent is hardcoded to `personal_assistant` and replaced by a "Where it runs" selector; "Pin to client" field is gone, replaced by automatic client probing; "Agent Created" dialog became a "Last step — connect your computer" modal emitting a combined one-liner). The doc only covers a hosted Hub; there is no quickstart for the self-hosted local-machine scenario despite `first-tree-hub server start` being a supported command. And the multi-account / `FIRST_TREE_HUB_HOME` machinery in the code is premature for the current product stage — without an explicit decision to defer it, any rewrite inherits the same confusion.

**Scope of this doc:** local scenario is drafted first (§ 2.1); hosted scenario is sketched in § 2.2 with several questions explicitly deferred. Everything in this doc is a working draft — call out anything that should be revisited.

### 1.2 Product principles (current take)

- **One human = one org = one member = one client.** Default invariant.
- **Server-side multi-tenancy stays** — `organizations` table, `members` join table, JWT scoped to org. ACL substrate for a hosted Hub serving multiple customers; NOT a user-visible "join multiple orgs" capability.
- **Client-side multi-account is deferred indefinitely.** No `profile` subcommand, no UI affordance; `FIRST_TREE_HUB_HOME` is an internal testing tool, not a documented product surface.
- **Login binds `(member, org)` at JWT issue time.** `auth.ts:50-51` already comments "this version: single org"; we do not change that.
- **Public docs assume single-account-per-machine.** Edge cases go into separate troubleshooting pages, not onboarding.
- **Local-version users are single-machine self-users.** Optimise for "install → run → use" with the fewest possible concepts. Authentication, org, password are hidden entirely. The "evaluator vs daily user" persona distinction is dropped — one audience. The CLI exposes two operational shapes (foreground vs `--service`) as parallel choices selected by user situation, not as default + opt-in.

### 1.3 Current code state (verified against `origin/main`)

**Server commands** (`packages/command/src/commands/server.ts`). `server start` launches Postgres via Docker (or `--database-url`), runs migrations, serves Web on port 8000 — but **does NOT auto-create an admin** (comment in `core/server.ts:28` claims it does; actual implementation skips). `server admin:create` is a separate command that creates `users` + `organizations` + `members` + first human `agents` row + `agent_configs` seed and prints the generated password once. `server doctor` / `status` / `db:migrate` / `stop` cover diagnostics and lifecycle.

**Web** (`packages/web/src/`). The Clients list page (`pages/clients.tsx`) has a `ConnectStrip` with a `Generate` button that mints a 10-minute single-use connect token. The New Agent flow (`components/new-agent-dialog.tsx`) hardcodes `type: "personal_assistant"`, probes `listClients()` after submit, and either auto-pins (1 client) or shows a "Choose a computer" picker (≥2). When no client is connected, `last-step-modal.tsx` emits a combined `npm install && agent add && client connect --token` one-liner and polls `agent.clientId` until set, then auto-routes to Workspace.

**Client CLI** (`packages/command/src/`). `client connect <url>` supports `--token` or interactive username/password and currently has a 60-line account-switch gate that decodes the new JWT, compares `memberId` with existing credentials, and prompts Replace/Cancel. `agent add [name] --agent-id <uuid>` writes per-agent `agent.yaml`. `core/client-runtime.ts:233-261` listens for `agent:pinned` server push and auto-writes the same yaml that `agent add` would, then starts the slot — comment explicitly says "mirror what `first-tree-hub agent add` does".

**Two real onboarding paths** in current code (the `quickstart-zh.md`-prescribed "middle path" of separate `connect` then `agent add` is unreachable):

- **Path A** (brand-new machine, no connected client): user creates an agent in Web → Last-step modal → copies one-liner → terminal runs `npm install + agent add + client connect --token` → modal polls and routes to Workspace.
- **Path B** (already-connected machine): user creates an agent in Web → server pins → WS push to client → client auto-registers → Web jumps to Workspace. Zero CLI.

## 2. Required changes

### 2.1 Local-scenario flow (draft)

A single new top-level command — `first-tree-hub start` — replaces today's three-step `server start` + `admin:create` + `client connect`. The command has two equally-supported operational shapes; the user picks the one that matches their situation. Neither is "the default"; the onboarding guide presents them as parallel choices.

| Operational shape | Pick this when… | What survives closing the terminal? |
|---|---|---|
| `first-tree-hub start` | "I want to run Hub in this terminal." Quick try, debugging a startup issue, SSH session, or Windows (no service support). | Postgres container only. CLI process owns server + embedded client; Ctrl+C stops both. |
| `first-tree-hub start --service` | "I want Hub running across reboots without a terminal." | Postgres + daemon (server + embedded client). Daemon auto-starts at next login. |

Both shapes share the same orchestration — Docker preflight, Postgres provisioning, migrations, auto-admin, embedded `ClientRuntime`, browser auto-open. They differ only in lifecycle: the foreground shape blocks until SIGINT; `--service` installs a launchd plist (macOS) or systemd-user unit (Linux), then exits.

**Authentication model — loopback trust (Q7):** the local product trusts loopback for admin authentication. Any HTTP request reaching `127.0.0.1:8000` (with no `X-Forwarded-*` headers) is treated as the local admin. The Web app's auth gate, on detecting no JWT in localStorage, redirects to a `/login` route that posts to a loopback-only `POST /api/v1/auth/local-bootstrap` endpoint and gets a standard access + refresh JWT pair. **No bootstrap token, no magic URL, no `?bootstrap=` query param, no CLI `login` command.** The bootstrap-token mechanism is reserved for hosted mode (where loopback trust does not apply).

#### Output the user sees — foreground shape

```
$ first-tree-hub start
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Server listening at http://127.0.0.1:8000
✓ Client connected as this computer

  Opening browser at http://127.0.0.1:8000

Press Ctrl+C to stop.
(Postgres container is kept running. To also stop it: first-tree-hub server stop)
```

#### Output the user sees — service shape

```
$ first-tree-hub start --service
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Service installed
✓ Service running

  Opening browser at http://127.0.0.1:8000

(Service runs in the background and auto-starts at next login.)

$ ▮
```

#### End-to-end journey (the experience we are designing for)

**Prerequisites the user must satisfy before anything happens:**
- Node.js ≥ 22.16
- Docker Engine or Docker Desktop installed and running

**Step 1 — Install (once)**
```
npm install -g @agent-team-foundation/first-tree-hub
```
After: `first-tree-hub` is on PATH. `~/.first-tree/hub/` does NOT exist yet.

**Step 2 — First run (pick a shape)**

```
first-tree-hub start              # foreground shape
# or
first-tree-hub start --service    # service shape
```

Behind the scenes the two shapes share the **install-time** work but split who does what after that. **Pattern B (industry-standard for service install: setup at install time, not at boot time):**

Common install-time work (CLI process, both shapes):
1. Docker preflight (`isDockerAvailable()`); fail fast with the actionable message if absent.
2. `ensurePostgres` — pull image + start `first-tree-hub-postgres` container (5–10s on first run).
3. `runMigrations` — Drizzle applies any pending migrations.
4. `hasUser()` returns false → `createAdmin()` silently creates user + org `default` + member + first human agent. Username = sanitised `os.userInfo().username` (fallback `admin`); password is random and never displayed.

Then the shapes diverge — **foreground**:
5. CLI process itself runs the server (`buildApp` + `app.listen` on `127.0.0.1:8000`) plus an embedded `ClientRuntime` registered as this machine's client. CLI hits the loopback-only `local-bootstrap` endpoint, gets a JWT pair, persists `client.yaml` + `credentials.json`, and instantiates `ClientRuntime` with that pair.
6. Open the user's browser at `http://127.0.0.1:8000` (unless `--no-open` / SSH / non-TTY); always print the URL to stdout as fallback.
7. Block until SIGINT.

**Service:**
5. Install platform service unit (launchd plist on macOS, systemd-user unit on Linux). The unit's `ProgramArguments` / `ExecStart` points at a hidden `first-tree-hub daemon` subcommand (the daemon entry point) with the configured `--port`.
6. Start the daemon. Daemon entry point:
   - **Schema version guard** — compare the migrations bundled in the binary against `__drizzle_migrations` table; mismatch → log error + exit 1 (so launchd / systemd surface the failure on subsequent restart loops).
   - `buildApp` + `app.listen` on `127.0.0.1:<port>`.
   - Embed `ClientRuntime`; obtain JWT via `obtainDaemonJWT()` (B2 three-tier fallback).
   - Block until SIGTERM, then graceful shutdown.
7. Parent CLI polls daemon `/healthz` for up to 10s. On failure: `service uninstall` rollback, print captured stderr (last ~20 lines from log), exit 1.
8. On success: parent CLI opens browser at `http://127.0.0.1:<port>`, exits 0. Daemon keeps running.

**The daemon does NOT** re-run `ensurePostgres`, `runMigrations`, or `createAdmin` — those are install-time only. On subsequent boots (auto-restart at user login), the daemon's only orchestration is the schema-version guard plus server + ClientRuntime startup. **This is intentional** — see § 4 Q11 for the Pattern B / 12-factor rationale.

After Step 2, the disk state is:
```
~/.first-tree/hub/
├── config/{server,client}.yaml
├── config/credentials.json    (mode 0600 — admin JWT pair, shared by daemon + out-of-band CLI)
├── logs/<rotating NDJSON>
└── data/
```
The `clients` table has one row (this computer); `agents` has the admin's human row only. In the service shape, a launchd plist or systemd-user unit is also registered.

**Step 3 — Browser opens automatically (same in both shapes)**

The browser loads `http://127.0.0.1:8000`. The Web app:
1. Loads from `dist/web/index.html` served by the same fastify.
2. Auth guard sees no JWT in localStorage → redirects to `/login`.
3. `/login` posts to `POST /api/v1/auth/local-bootstrap` (loopback-only). Server validates `req.ip ∈ {127.0.0.1, ::1}` and the request was not forwarded, then mints a standard access + refresh JWT pair for the local admin.
4. Web stores tokens in localStorage; redirects to Workspace — empty state, no agent yet.

The user has now signed in without ever seeing username, password, or org. **No bootstrap token in the URL; no `?bootstrap=` query param to clean up.**

**Step 4 — Create the first agent (same in both shapes)**

Workspace → Agents → `+ New Agent` → enter a name (e.g., `my-assistant`) → Create.

What happens:
1. Web `listClients()` finds 1 connected client (the embedded one — owned by the CLI process in foreground, by the daemon in service shape).
2. Web calls `createAgent({name, type: "personal_assistant", clientId: <thisClient>})`.
3. Server inserts the agents row, pinned, R-RUN check passes.
4. Server emits WS `agent:pinned` to the embedded client.
5. Client `handleAgentPinned()` writes `~/.first-tree/hub/config/agents/my-assistant/agent.yaml`, instantiates `AgentSlot`, opens its own agent WS.
6. Web sees `agent.clientId` is set, routes to Workspace with the agent active.

Total elapsed time: 1–2 seconds. No Last-step modal, no terminal step.

**Step 5 — Chat with the agent (same in both shapes)**

User types in the center column. Message → server inbox → WS → AgentSlot handler → spawn Claude Code subprocess with cwd `~/.first-tree/hub/data/workspaces/my-assistant/` → stream response back through the same path. First message slow (cold-start), follow-ups in the same session fast.

**Step 6 — Stop / leave**

- **Foreground:** Ctrl+C in the running terminal stops the embedded `ClientRuntime`, closes fastify, exits the process. Postgres container is left running. Final stdout line: `(database container kept; first-tree-hub server stop to also stop it)`. Closing the terminal without Ctrl+C also stops everything (parent process is killed by SIGHUP).
- **Service:** the CLI command already exited at the end of Step 2. Closing the terminal does nothing to the daemon. The browser tab can be closed too — JWT in localStorage persists (refresh-token TTL ≈ weeks; access token auto-refreshed on demand).

**Step 7 — Subsequent runs**

- **Foreground:** the user re-runs `first-tree-hub start` whenever they want Hub up. `ensurePostgres` reuses the existing container (~2–3s); `hasUser()` is true so admin creation is skipped; browser opens at `http://127.0.0.1:8000`; the auth guard either uses the existing JWT or auto-mints a fresh one via `local-bootstrap`.
- **Service:** nothing to do. Daemon auto-starts at login; Postgres container auto-starts when Docker daemon does. The user just opens `http://127.0.0.1:8000` — JWT still valid (or auto-minted by `/login` if absent / expired) → Workspace.

**Recovery (any shape, any time):** open `http://127.0.0.1:8000`. If JWT in localStorage is invalid or absent, the Web auth guard auto-mints a fresh one via `local-bootstrap`. **No CLI command is required for recovery.**

#### Total commands the user types, ever

| When | Command |
|---|---|
| First time on this machine | `npm install -g @agent-team-foundation/first-tree-hub` |
| Run / install Hub on this machine | `first-tree-hub start` (foreground) **or** `first-tree-hub start --service` (service) |
| Remove Hub from this machine (service shape) | `first-tree-hub service uninstall` |

Everything else is hidden. **No `login` command exists** — recovery is opening the browser; the auth guard auto-mints.

#### Behavior contract

1. **Preflight (Q4-A):** check Docker availability before any side effects. Missing → print actionable message (`core/server.ts:57-64`, with `re-run` line updated to `first-tree-hub start`) and exit immediately.
2. **Postgres:** provision via `ensurePostgres`, or reuse a running container.
3. **Migrations:** run via `runMigrations`.
4. **Auto-admin (Q1):** if `users` table is empty (`hasUser` returns false), silently `createOwner` — sanitised `os.userInfo().username` (fallback `admin`), org `default`, random password. **Never displayed, never persisted in cleartext.**
5. **Process-responsibility split (Q11):** Pattern B — install-time work (Docker preflight, `ensurePostgres`, `runMigrations`, `createAdmin`) lives in the CLI process; runtime work (server + embedded `ClientRuntime` + schema-version guard) lives wherever the runtime owner is. Concretely:

    | Step | Foreground | Service |
    |---|---|---|
    | Docker preflight | CLI | CLI (parent) |
    | `ensurePostgres` | CLI | CLI (parent) |
    | `runMigrations` | CLI | CLI (parent) |
    | `createAdmin` (if `!hasUser`) | CLI | CLI (parent) |
    | `initConfig` → auto-generate `client.id` to `client.yaml` (R2) | CLI | CLI (parent) |
    | Install platform service unit | n/a | CLI (parent) |
    | Schema-version guard | n/a (CLI just ran migrations) | daemon (on every boot) |
    | `buildApp` + `app.listen` | CLI | daemon |
    | Embedded `ClientRuntime` | CLI | daemon |
    | Call `local-bootstrap` for admin JWT | CLI | daemon (B2) |
    | Persist `credentials.json` | CLI | daemon |
    | Poll `/healthz`, open browser | n/a | CLI (parent) |
    | Block until shutdown | CLI (SIGINT) | daemon (SIGTERM) |
6. **Loopback-trust auth endpoint (Q7):** server exposes `POST /api/v1/auth/local-bootstrap` that mints a fresh access + refresh JWT pair for the local admin. The endpoint is gated on `req.ip ∈ {127.0.0.1, ::1}` AND no `X-Forwarded-*` headers present (defence against proxy bypass). Hosted-mode deployments disable this endpoint via config (e.g. `FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP=1`).
7. **Web `/login` route:** auth guard redirects unauthenticated requests to `/login`; `/login` calls `local-bootstrap` and on success stores the JWT pair in localStorage and redirects to `/`. Any visit to `localhost:8000` without a valid JWT auto-recovers without user action.
8. **Browser auto-open:** open `http://127.0.0.1:8000` via `open` / `xdg-open` / `start` unless `--no-open` / SSH session / non-TTY. Always print the URL to stdout as fallback.
9. **Foreground shape:** server + embedded client run in the CLI process; block until SIGINT. SIGINT stops both gracefully; **leaves Postgres container running**, with the hint to `first-tree-hub server stop`.
10. **Service shape (Q2):** install launchd plist (macOS) or systemd-user unit (Linux), hand the orchestration off to the daemon, parent polls daemon `/healthz` up to 10s (Q8). On failure: `service uninstall` rollback, print last ~20 lines of daemon stderr from log, exit 1 — **no half-installed state**. On success: parent exits 0; daemon hosts server + embedded client.
11. **`--port <n>`:** default `8000`. On `EADDRINUSE`: print `Port N is busy. Try 'first-tree-hub start --port <N+1>'.` and exit. No auto-fallback, no probing. In service shape, the `--port` is written into the platform unit file so the daemon binds the same port across reboots.
12. **`--no-open`:** opt out of browser auto-open. URL is still printed to stdout.
13. **Idempotency (service shape):** re-running `first-tree-hub start --service` when service is already installed and running: skip install, best-effort liveness check, open browser at `localhost:8000`, exit 0.
14. **Cross-shape collision:** running `start` while a service is already active (or vice versa) detects the conflict (port `8000` busy or service running). Friendly error: `Hub is already running as a service. Open http://127.0.0.1:8000 to log in, or run 'first-tree-hub service stop' first if you want to run inline.` Exit 1.

#### Service-mode management

After `start --service` installs the service, four commands manage it:

```
first-tree-hub service status            # running / installed-but-stopped / not-installed
first-tree-hub service logs [-f] [-n N]  # tail / follow rotating NDJSON log
first-tree-hub service stop              # stop daemon without uninstalling
first-tree-hub service uninstall         # remove plist/unit + stop daemon (Postgres untouched)
```

Service stop / uninstall does NOT touch the Postgres Docker container — that lifecycle is decoupled. **`uninstall` also leaves `~/.first-tree/hub/` intact** so a subsequent `start --service` can resume with the same admin / agents / chats; manual full reset is `rm -rf ~/.first-tree/hub`.

**macOS lifecycle note:** the service installs into `~/Library/LaunchAgents/` (user agent, no `sudo`); it follows the user's login session — stops at logout, restarts at next login. For a personal machine this is fine; users who want it always-on (across logout) should not expect it from the user-agent install.

#### Recovery

| Situation | What to do |
|---|---|
| Lost the URL / new browser / cleared localStorage / JWT expired | Open `http://127.0.0.1:8000` — auth guard auto-mints |
| Daemon stopped or crashed (service shape) | `first-tree-hub start --service` (idempotent) |
| Foreground process exited and you want it back | `first-tree-hub start` |
| Service was uninstalled, want it back | `first-tree-hub start --service` |

#### User-visible surface (deliberately minimal)

The user **never sees** username, password, org name, JWTs, refresh tokens, `agent add`, `client connect`, launchd plist contents, systemd unit file paths, Postgres connection URLs, `credentials.json` location.

#### What does NOT exist (deliberately deferred)

- **`first-tree-hub login` command** — recovery is opening the browser; the loopback-trust model + Web `/login` auto-mint makes a CLI login redundant. CLI `login` and Web `/login` would share the exact same trust boundary (loopback access), so the CLI layer adds no security value.
- **Bare-command alias** — without `login`, there's no canonical "default action" to alias to. Bare `first-tree-hub` shows help.
- **Bootstrap token / magic URL with `?bootstrap=<token>`** — local mode trusts loopback for admin JWT minting. The bootstrap-token mechanism is reserved for hosted mode (email links etc.) where loopback trust does not apply.
- **Multi-layered URL delivery (clipboard copy, Cmd+click magic URLs)** — the URL is always just `http://127.0.0.1:8000`. No long base64 token to copy. Browser auto-open + stdout fallback is enough.
- **`admin:reset` command** — recovery is opening the browser or `start`.
- **`admin.json` cleartext file** — credentials never leave the DB (bcrypt hash only).
- **Server-as-service in the `server` namespace** (e.g. `server service install`) — only the unified top-level `service` namespace exists.
- **`--detach` flag** — `--service` covers the persistent-background case.
- **Windows service support** — foreground shape (`first-tree-hub start`) is the only path on Windows for now.
- **Multi-account on a single machine** — single-account-per-machine is the product invariant.

### 2.2 Hosted-scenario flow (draft, partial)

The hosted scenario does not get a single new top-level command (no equivalent of `first-tree-hub start`). Instead, the existing Web + CLI surface stays and is trimmed in three concrete places (Qh-2, Qh-3, Qh-4 below). Several adjacent questions are explicitly deferred (Qh-1, Qh-5, Qh-6, Qh-7) — see the bottom of this section.

#### Two lifecycle moments, two paths (Qh-2)

The hosted user docs do not pick a single canonical path. Two paths are recognised as serving distinct lifecycle moments:

- **First-time onboarding (Path A — Last-step modal):** A new hosted user has credentials, no client connected. Their natural goal is "use my assistant," not "set up infrastructure." They sign in, navigate to Agents, click `+ New Agent`. Because no client is connected, the Last-step modal appears with the install + connect command. They run it once on terminal; the modal detects connection; they land in Workspace. Path A is goal-driven and continues to be the implicit welcome flow.
- **Adding more machines (Path B — Connect-a-computer strip):** A user with an existing connected client wants to add another machine (laptop + desktop, etc.). They navigate to Clients → "Connect a computer" → click `Generate` → run the resulting `client connect --token` on the new machine. Future agent creates from Web auto-pin via `agent:pinned` (zero CLI). Path B is admin/infra-driven and applies once the user is past day-1 onboarding.

User-facing docs treat these as two separate paths organised by lifecycle moment; neither is "the canonical" — they apply at different times in the user's relationship with Hub.

A future UX upgrade — a first-class Web onboarding wizard that replaces the "modal interrupt" framing with an explicit guided welcome flow — is recognised but out of scope for this redesign. Path A's Last-step modal is the form we keep.

#### Last-step one-liner shape (Qh-3, C3 confirmed)

The Last-step modal one-liner drops the `agent add` segment. New chain:

```
npm install -g @agent-team-foundation/first-tree-hub && \
  first-tree-hub client connect <url> --token <jwt>
```

Server-side `agent:pinned` replay (`services/client.ts:147-149`) creates the local `agent.yaml` on its own once the client connects. The pre-existing chain's middle step was redundant and introduced an orphan-yaml failure mode: when `connect` was cancelled or failed mid-chain, the `agent.yaml` already on disk belonged to no real client, polluting the next attempt.

Implementation: edit the command string in `packages/web/src/components/last-step-modal.tsx:76-82`. ~5–10 LOC.

#### Account-switch gate simplification (Qh-4, C1 confirmed)

The 60-line gate in `packages/command/src/commands/connect.ts:78-242` is replaced with a one-line confirmation:

```
This computer already has Hub credentials. Replace? [y/N]
```

Removed: JWT decoding, member ID labels, organization labels, service status display, `FIRST_TREE_HUB_HOME` isolation guide. Loses the "same memberId reconnecting → silent proceed" niceity (must press Y), which is acceptable trade-off given single-account-per-machine is the product principle. ~50 LOC removed. `ClientOrgMismatchError`'s rotate-and-guide path becomes practically unreachable and can be cleaned up alongside.

#### Deferred for the hosted scenario

The following are recognised but not finalised in this redesign. Each is blocked on a decision outside this conversation; revisit in a follow-up session.

- **Qh-1 — Source of truth for member identity.** The architecture proposal `first-tree-architecture-overview.20260423.md` § 3.1 + 3.3 establishes Context Tree `members/` as the source of truth (Hh-1.B direction). A natural extension surfaced in this discussion: **Hub Web becomes the friendly UI for editing `members/`**, writing via PR/commit to the tree repo, with sync reading back into the Hub DB. Implementation timing AND authentication mechanism (GitHub OAuth vs username/password vs other) are open. Today's `members.createMember` (DB-only) stays as the implementation until further decision. Note: the proposal § 3.3 lists "Members 同步" as ✅ landed, but the Hub-side sync code does not exist; the Hub README's claim about "synced to Hub automatically" is aspirational, not implemented. Both should be reconciled when this is picked up.
- **Qh-5 — Org provisioning docs.** Today all orgs are operator-provisioned via `server admin:create` or admin API; no self-service. User docs assume "you have credentials"; how/where to document operator-side provisioning is open. Likely outcome is a separate `docs/operator-runbook.md`, but not committed.
- **Qh-6 — `client logout` default behavior.** Whether `client logout` should also tear down the launchd/systemd service (matching "log me out") or leave it (matching "service install is a separate concern") is open. C5 below leaves the flag default unspecified pending this.
- **Qh-7 — Hosted end-to-end journey writeup.** The local scenario (§ 2.1) has a step-by-step journey. The hosted equivalent is contingent on Qh-1 (auth mechanism, "how does the user get their first credential") and is deferred until that resolves.

### 2.3 Documentation (D1–D4)

- **D1.** Rewrite `docs/quickstart-zh.md`. Local section uses § 2.1's flow exclusively; hosted section pending § 2.2. **Drop all `server start` mentions** from user-facing docs — replaced by `first-tree-hub start`. (`server start` itself stays in CLI for developers; just doesn't appear in user docs.)
  - **Add an "Upgrading" subsection** documenting the two-command upgrade flow (Pattern B / Q11):
    ```bash
    npm install -g @agent-team-foundation/first-tree-hub@latest
    first-tree-hub start --service
    ```
    Step 2 is required because npm doesn't know about launchd / systemd — daemon must be explicitly restarted to pick up new code. The same `start --service` invocation also runs any pending DB migrations. If the user forgets step 2, the running daemon stays on old code; the schema-version guard surfaces the mismatch on the next reboot via `service logs`.
- **D2.** Update `docs/onboarding-guide.md` (English). Drop legacy `agent token bootstrap` references. Mirror D1 structure.
- **D3.** Move `Local Testing Isolation` out of public `CLAUDE.md` to `docs/dev/testing-isolation.md`. Stop documenting `FIRST_TREE_HUB_HOME` in user-facing docs.
- **D4.** `docs/multi-tenancy-hardening-design.md:18` — drop "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" parenthetical. Replace with "deferred indefinitely".

### 2.4 Code changes (C1–C5)

- **C1.** Strip the account-switch gate in `packages/command/src/commands/connect.ts:78-242`. Replace with a single Y/N confirmation:
  - No credentials present → silent proceed (unchanged).
  - Credentials present → `This computer already has Hub credentials. Replace? [y/N]`. Default No.
  - Cancel → `Cancelled. Your existing setup is untouched.` Exit. **No** `FIRST_TREE_HUB_HOME` isolation guide.
  - Replace → overwrite credentials, continue.
  - **No** JWT decoding, member/org labels, or service status display.
  - ~50 LOC removed. `ClientOrgMismatchError`'s rotate-and-guide path becomes practically unreachable; clean up alongside.
- **C2.** Implement `first-tree-hub start` (new top-level command — foreground shape + the shared orchestration both shapes use).
  - File: `packages/command/src/commands/start.ts`.
  - Server orchestration: refactor `core/server.ts:startServer` so the listen step is observable from the caller (or split into a `bootstrapServer()` returning `{app, config}` plus a separate listen call).
  - Auto-admin: reuse `core/admin.ts:hasUser`. **Rename `createOwner` → `createAdmin`** — the existing name was misaligned with its actual behaviour (inserts `members.role = 'admin'`, not `'owner'`; the `'owner'` value never existed in the `members` schema — see [packages/server/src/db/schema/members.ts:22](packages/server/src/db/schema/members.ts:22) which documents the role enum as `"admin" | "member"`).
  - **New `findAdmin(databaseUrl)` in `core/admin.ts` (Q1):** returns `{userId, memberId, organizationId, agentId}` for the local admin. Query: earliest `members.role = 'admin'` row in the `default` org —
    ```sql
    SELECT u.id AS user_id, m.id AS member_id, m.organization_id, m.agent_id
    FROM members m
    JOIN users u ON u.id = m.user_id
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.role = 'admin' AND o.name = 'default'
    ORDER BY m.created_at ASC
    LIMIT 1
    ```
    Used by the `local-bootstrap` endpoint, the daemon's startup JWT recovery (B2), and out-of-band CLI auth (B3) — single source of truth for "who is this machine's admin".
  - **New endpoint `POST /api/v1/auth/local-bootstrap` (Q7):** loopback-only; mints a fresh access + refresh JWT pair for the local admin (resolved via `findAdmin()`). Three-gate check (A1):
    1. **`req.ip` ∈ `{127.0.0.1, ::1}`** — TCP-level loopback check.
    2. **No `X-Forwarded-*` header** — reject if any forwarding header present (defense against reverse-proxy bypass).
    3. **`Host` header** must equal `127.0.0.1:<port>` or `localhost:<port>` (using runtime `config.server.port`) — defense against DNS rebinding (attacker DNS for `evil.com` → 127.0.0.1; Host would be `evil.com:<port>`). This is the only check CORS does not cover, since DNS rebinding makes the response same-origin from the browser's view.
    Failures return 401. POST-only is via Fastify route registration (GET returns 405 automatically). Origin / Content-Type strict checks intentionally omitted — CORS default behaviour (we never set `Access-Control-Allow-Origin`) already prevents cross-origin JS from reading the response, making them redundant. Hosted-mode deployments set `FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP=1` and the route is not registered at all (404). **No bootstrap-token endpoint** for local mode — the bootstrap-token mechanism is reserved for hosted email links etc.
  - **Web `/login` route:** the auth guard redirects unauthenticated requests to `/login`; the `/login` component posts to `local-bootstrap`, stores the returned JWT pair in localStorage, and redirects to `/`. Visiting `localhost:8000` without a JWT auto-recovers — no user input required.
  - Embedded client: in the same process, after `app.listen` resolves, the CLI calls its own `local-bootstrap` endpoint to obtain the admin JWT pair, persists `client.yaml` + `credentials.json`, and instantiates `ClientRuntime` with `getAccessToken: () => <persisted token, auto-refreshed>`.
  - **`client.id` lifecycle (R2):** before any of the above, the CLI parent calls `initConfig({schema: clientConfigSchema})` (existing infrastructure in `packages/shared/src/config/`). This auto-generates `client.id` (`client_<8-hex>` per the `auto: "client-id"` field declaration in `client-config.ts:22-23`) on first run and writes it back to `client.yaml`; subsequent calls are idempotent. The embedded `ClientRuntime` (in either shape) reads the same `client.id` and uses the existing `client:register` WS handshake (`packages/server/src/api/agent/ws-client.ts:260-285`) to upsert into the `clients` table — `user_id` / `organization_id` are derived from the admin JWT's session by `clientService.registerClient`. **No new server-side registration logic is needed**; the embedded client uses the same protocol as `client connect`.
  - SIGINT handler stops both gracefully; leaves Postgres container running with the hint to `first-tree-hub server stop`.
  - **Browser auto-open:** open `http://127.0.0.1:8000` via `open` (macOS) / `xdg-open` (Linux) / `start` (Windows). Skipped when `--no-open` is passed, an SSH session is detected (`SSH_CLIENT` env), or stdout is not a TTY. Always print the URL to stdout as fallback. **No clipboard copy, no Cmd+click magic URL** — the URL is just `http://127.0.0.1:8000`, short enough to not need fancy delivery.
  - **Cross-shape collision detection:** before binding `:8000`, probe whether a daemon is already serving the port; if yes, print `Hub is already running as a service. Open http://127.0.0.1:8000 to log in, or run 'first-tree-hub service stop' first if you want to run inline.` and exit 1.
  - README "Quick Start" section updated to present both shapes (`start` and `start --service`) without designating a default.
  - **Port handling:** default `8000` (unchanged), `--port <n>` flag accepted. On `EADDRINUSE`, catch and print "Port N is busy. Try `first-tree-hub start --port <N+1>`." instead of the raw Node stack. No auto-fallback, no probing — see § 5 for the future port-default discussion.
  - **`server start` legacy command:** kept as a developer command (runs server only, no embedded client). Disappears from README and `docs/quickstart-zh.md`; `server --help` gets a one-line pointer "for end-user setup, see `first-tree-hub start`". Not deprecated, not warned.
- **C3.** Last-step modal one-liner drops the `agent add` segment.
  - New chain: `npm install -g @agent-team-foundation/first-tree-hub && first-tree-hub client connect <url> --token <jwt>`.
  - Rationale: server-side `agent:pinned` replay (`services/client.ts:147-149`) writes the local `agent.yaml` on its own once the client connects. The pre-existing middle step was redundant and introduced an orphan-yaml failure mode (when `connect` was cancelled or failed mid-chain).
  - Edit `packages/web/src/components/last-step-modal.tsx:76-82`. ~5–10 LOC.
- **C4.** Fix `LOG_DIR` in `packages/command/src/core/service-install.ts:47`. Resolve at use-site, not at module load.
- **C5.** Add `first-tree-hub client logout`. Core actions agreed:
  - POST `/api/v1/clients/<self>/disconnect` (best-effort, ignore failure).
  - Stop the running client process.
  - Delete `credentials.json`.
  - Print: `Logged out. To use this computer again: first-tree-hub client connect <url>`.
  - **Default flag for service teardown is pending Qh-6 (deferred).** Implementation can land the core actions and leave the service-teardown flag default unspecified, then flip to the Qh-6 decision when it arrives.
- **C8.** Add the service shape — `first-tree-hub start --service` and the `service` management subcommands. Equal-status with C2's foreground shape; not "opt-in" relative to a default.
  - `first-tree-hub start --service` — install launchd plist (macOS, into `~/Library/LaunchAgents/`, no `sudo`) or systemd-user unit (Linux, `~/.config/systemd/user/`), hand the orchestration off to the daemon, parent polls daemon `/healthz` for up to 10s, opens browser at `http://127.0.0.1:8000`, then exits. Subsequent **logins** auto-start (macOS user agent stops at logout / starts at login; Linux systemd-user behaves similarly unless `loginctl enable-linger` is set, which we don't require).
  - `first-tree-hub service install` — alias for `start --service` (Multica-style entry point).
  - `first-tree-hub service uninstall` — remove the plist/unit, stop the running service.
  - `first-tree-hub service status` — running / installed-but-stopped / not-installed.
  - `first-tree-hub service logs [-f] [-n N]` — print or follow rotating NDJSON log file under `~/.first-tree/hub/logs/`.
  - `first-tree-hub service stop` — stop daemon without uninstalling.
  - The daemon process invokes the same orchestration C2 implements — Docker preflight, auto-admin (first run), embedded ClientRuntime, server on `127.0.0.1:8000`. Difference vs foreground: stdout/stderr go to log files, not terminal. The daemon does **not** mint or print URLs on its own — auth recovery is the Web `/login` route any time the user opens the browser.
  - **Schema-version guard (Q11):** daemon's first action on boot is to compare the migrations bundled in its own binary (`packages/server/src/db/migrations/`) against `__drizzle_migrations` in the live DB. Mismatch (DB older than binary expects) → log a clear error: `Schema version mismatch. CLI v<version> expects migration <hash>, DB at <hash>. Run 'first-tree-hub start --service' to apply pending migrations.` and exit 1. This is the **only** orchestration the daemon does — it does NOT re-run `ensurePostgres`, `runMigrations`, or `createAdmin`. Those are install-time work owned by the CLI parent. See § 4 Q11 for the 12-factor rationale.
  - **Daemon startup auth (B2 / Q9):** after the schema-version guard passes, the daemon has no parent CLI on auto-restart, so it bootstraps its own JWT via a 3-tier fallback in `core/auth.ts:obtainDaemonJWT()` — called before `ClientRuntime` is instantiated:
    1. Read `credentials.json`. If access token's `exp` is still in the future → use directly.
    2. Else if refresh token still valid → POST `/api/v1/auth/refresh`, persist new pair, use.
    3. Else → POST `/api/v1/auth/local-bootstrap` (loopback access; the 3 A1 gates all pass for a same-process call), persist new pair, use.

    **Why not just always go through local-bootstrap on every boot:** that pollutes the refresh-token table (a laptop sleep/wake counts as a reboot), and the cached path is much faster. The local-bootstrap branch is the cold-start / token-revoked recovery path only.

    **Mid-runtime token expiry:** `ClientRuntime`'s existing auto-refresh loop handles normal renewal. **Contract:** if mid-runtime refresh fails (server lost the refresh row, etc.), `ClientRuntime.getAccessToken` should fall through to `local-bootstrap` rather than crashing the runtime — same path as B2 step 3.
  - **`--port` propagation:** when `--port <n>` is passed to `start --service`, write the value into the launchd plist `ProgramArguments` (or systemd unit `ExecStart`) so the daemon binds the same port across reboots. Changing port later requires `service uninstall && start --service --port <n>`.
  - **Health check + rollback (Q8):** parent process polls daemon `/healthz` up to 10s. On timeout / unhealthy: invoke `service uninstall`, print last ~20 lines of daemon stderr from log, exit 1. **No half-installed state.**
  - Postgres lifecycle stays decoupled — service stop/uninstall does NOT touch the Docker container.

(C9 removed — the `login` command and bare-command alias are no longer in scope. The Web `/login` route + loopback-only `local-bootstrap` endpoint cover every case `login` was meant to handle, with the same trust boundary and zero CLI involvement. See § 4 Q1 for rationale.)

- **B3 follow-up (no separate code change).** Earlier draft proposed a dedicated `obtainCliJWT()` helper to route out-of-band CLI auth through `local-bootstrap` and avoid the refresh-token race with a running daemon. That was over-spec: the race is **self-healing** if the existing CLI refresh helper (whatever auth path the agent commands already use) follows the standard pattern of "on 401-from-refresh → reread `credentials.json` → retry once". Daemon writes new tokens; CLI's stale in-memory pair fails refresh; CLI re-reads disk, picks up daemon's new pair, retries — all transparent. **Action:** ensure the CLI auth helper has the retry-on-stale-creds branch; no new endpoint route or sole-writer invariant needed.

(Old C6 client-retry-backoff and C7 localhost-no-service are removed — both made moot by C2's embedded-client model.)

## 3. Sequencing

- **Phase 1 (local-scenario, drafted) — split into 1a + 1b** (#14):
  - **Phase 1a — C2 only.** `first-tree-hub start` foreground shape + shared orchestration (Docker preflight, Postgres, migrations, auto-admin via renamed `createAdmin` + `findAdmin`) + `local-bootstrap` endpoint with the 3-gate middleware + Web `/login` route + browser auto-open. End-to-end demoable on `start` foreground; no platform-specific code. Independently shippable.
  - **Phase 1b — C8.** `--service` shape + `service` management subcommands + health-check + rollback (Q8) + daemon startup auth (B2/Q9). Adds launchd / systemd-user adapters. Depends on 1a.
  - Plus minimal D1 update for the local section + README Quick Start update — bundle into 1a (docs follow code).
  - **Phase 1 is smaller than the previous draft** — the dropped `login` command (C9), bootstrap-token endpoint, multi-layered URL delivery, and bare-command alias all collapse into the loopback-trust + Web `/login` model.
- **Phase 2 (hosted-scenario simplifications, drafted).** C1 + C3 — both touch the connect/Last-step pair, share a testing scope. D1 hosted section using Path A first-time / Path B add-machine framing (Qh-2). D2 mirror in English.
- **Phase 3 (Hub-internal cleanup).** D3, D4, C4 — each can be its own small PR.
- **Phase 4 (deferred-question follow-ups).** Re-open Qh-1, Qh-5, Qh-6, Qh-7 in a separate session. C5 lands its core (no default-flag commitment) here, then flips on Qh-6.

## 4. Decisions log

### Local scenario

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | Auto-admin + auth UX | Username/password/org never shown to user. No persistence in cleartext. Recovery via opening the browser at `localhost:8000` — auth guard auto-mints a fresh JWT pair via the loopback-only `local-bootstrap` endpoint. The endpoint resolves "the local admin" via `findAdmin()` — earliest `members.role = 'admin'` row in `default` org. **No CLI `login` command, no magic URL, no bootstrap token in local mode.** Side-cleanup: rename `createOwner` → `createAdmin` (function name was misaligned with the schema — `members.role` enum is `"admin" \| "member"`, no `"owner"` value). | "No password ever shown" is the load-bearing principle. CLI `login` and Web `/login` would share the exact same trust boundary (loopback access), so the CLI layer adds no security value. The simpler design has fewer moving parts (one endpoint, no token table, no URL delivery layer) and the same UX guarantees |
| Q2 | Server as service | **Two equally-supported shapes, no default.** `first-tree-hub start` runs foreground (server + embedded client in CLI process); `first-tree-hub start --service` installs launchd plist / systemd-user unit and hands the same orchestration to a daemon. The onboarding guide presents them as parallel choices selected by user situation, not as default + opt-in. | A foreground-only design forced daily users into tmux/nohup; a service-default design surprised users with launchd plist installs they didn't ask for. Both shapes are first-class because they serve different real situations: foreground for SSH / Windows / debug, service for persistence |
| Q3 | Client connect mode | Moot — local flow has no separate `client connect` step | Resolved by C2 embedding the client in `start` |
| Q4 | Docker prereq UX | Q4-A: check at top of `start`, fail fast with the existing actionable message | Existing message is good; only timing needs fixing |
| Q5 | Single-command `first-tree-hub start` | Yes. Q5-a: name `start`. Q5-b: each `start` invocation hands the user back into a logged-in browser. Q5-c: PG stays on Ctrl+C / `service stop` / `service uninstall`. Q5-d: replaces `server start` in user docs. | All four sub-decisions confirmed |
| Q7 | URL delivery + auth model | Single-step: open `http://127.0.0.1:8000` in the browser (via `open` / `xdg-open` / `start`, skipped on `--no-open` / SSH / non-TTY) + always print the URL to stdout. Web auth guard handles authentication via Web `/login` → `POST /api/v1/auth/local-bootstrap`. **Trust boundary: loopback access = local admin.** Endpoint hardened by 3 checks (A1): `req.ip ∈ {127.0.0.1, ::1}`, no `X-Forwarded-*` header, `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`}. The `Host` check is the load-bearing one against DNS rebinding (CORS handles cross-origin response reads on its own). | Earlier draft listed 5 gates including Origin and strict Content-Type. Trimmed back: CORS already prevents cross-origin JS from reading responses (we never set `Access-Control-Allow-Origin`), so Origin check is redundant in normal cross-origin attacks. Only DNS rebinding bypasses CORS — `Host` check is the unique defense. Endpoint is disabled (route unregistered) in hosted-mode deployments |
| Q8 | Service-shape health check + rollback | Parent process polls daemon `/healthz` for up to 10s after handing off. On timeout / unhealthy: invoke `service uninstall`, print last ~20 lines of daemon stderr from log, exit 1. **No half-installed state.** | Service-mode failures (Docker permission, port collision, broken plist) must surface in the parent's stdout; otherwise users are left with a half-installed service and a "nothing happened" terminal |
| Q9 | Daemon startup auth (B2) | 3-tier fallback in `core/auth.ts:obtainDaemonJWT()`: (1) cached access in `credentials.json` if `exp` still in future → use; (2) else call `/auth/refresh` with cached refresh token; (3) else call `/auth/local-bootstrap`. The same fallback applies to mid-runtime failures inside `ClientRuntime.getAccessToken`. | Daemon has no parent CLI on auto-restart, so it must self-bootstrap. Always going to `local-bootstrap` would pollute the refresh-token table on every laptop sleep/wake cycle; the cached path is the fast path. `local-bootstrap` is the cold-start / token-revoked recovery only. Same endpoint serves CLI (start), daemon (this), and out-of-band CLI (B3) — 3 callers, one source of truth |
| Q11 | Service-shape orchestration ownership (R1) | **Pattern B — install-time setup in CLI parent, not in daemon.** CLI parent owns: Docker preflight, `ensurePostgres`, `runMigrations`, `createAdmin`, install service unit. Daemon owns: schema-version guard (fail-fast on mismatch), server, embedded `ClientRuntime`, B2 self-bootstrap for JWT, SIGTERM handling. Upgrade flow is two manual commands: `npm install -g ...@latest && first-tree-hub start --service`. | Earlier draft floated Pattern A (daemon does the full orchestration on every boot, parent only installs + polls). Industry consensus is Pattern B: Postgres / Redis / MongoDB / 12-factor apps all do install-time setup separately from runtime. Migrations on every boot pollute startup time and violate the "run stage is not release stage" principle. Schema-version guard handles upgrade safety without forcing migrations into the daemon |
| ~~Q10~~ | ~~Out-of-band CLI auth (B3)~~ | **Removed as over-spec.** The original concern (daemon + CLI racing on refresh-token rotation) is self-healing if CLI auth follows the standard "401-on-refresh → reread `credentials.json` → retry once" pattern. No new endpoint, no special CLI auth path, no sole-writer invariant. | Earlier draft introduced `obtainCliJWT()` + a "daemon is sole writer" invariant. CORS-style overengineering — the race recovers in one retry, with worst-case UX being "first command after daemon refresh is 50ms slower" |
| ~~Q6~~ | ~~Bare `first-tree-hub` behavior~~ | **Removed.** With the `login` command dropped, there's no canonical action to alias bare invocation to. Bare `first-tree-hub` shows help, matching every other CLI. | n/a |

### Hosted scenario

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Qh-1 | Source of truth for member identity | **Deferred.** Architecture direction is Hh-1.B (Context Tree `members/` as SoT, Hub Web as friendly UI for editing it via PR/commit). Implementation timing + auth mechanism (OAuth vs password) open. Today's `members.createMember` (DB-only) stays until further decision. | Architectural decision, cross-product; needs separate session |
| Qh-2 | Path A vs Path B canonical | **Both.** Treat as two lifecycle moments: Path A (Last-step modal) is first-time onboarding; Path B (Connect-a-computer strip) is adding more machines. Doc structured by lifecycle moment, not "canonical vs alternative". Welcome-flow UX upgrade deferred. | A and B are different mental models for different stages, not competing options |
| Qh-3 | Drop `agent add` from one-liner (C3) | **Yes.** Two-command chain (install + connect). | Removes orphan-yaml failure mode; `agent:pinned` replay covers the dropped step |
| Qh-4 | Simplify account-switch gate (C1) | **Yes.** One-line Y/N replace prompt. No JWT decoding, no isolation guide. | Single-account-per-machine is the working assumption in this draft; the 60-line gate served a multi-account scenario we deferred |
| Qh-5 | Org provisioning docs | **Deferred.** Likely outcome: separate `docs/operator-runbook.md`. Today: user docs assume "you have credentials". | Not blocking other Qh items; needs follow-up |
| Qh-6 | `client logout` default service teardown | **Deferred.** C5 lands core actions (disconnect + stop process + clear creds); default flag for service teardown decided later. | Flag default doesn't block the command itself |
| Qh-7 | Hosted end-to-end journey writeup | **Deferred.** Blocked on Qh-1 (auth mechanism shapes how user gets first credential). | The journey writeup needs a settled credential flow |

## 5. Out of scope / future considerations

### Hard out of scope (no current intent)
- `first-tree-hub profile` multi-account UX
- Per-profile launchd / systemd unit names
- Multi-org login UI (let the user pick which membership to use)
- Cross-Hub federation / multi-Hub credential management
- Self-service registration / signup flow
- Email-invite / link-invite for new members
- A `server service` namespace (e.g. `first-tree-hub server service install`) — only the unified top-level `service` namespace exists, managing the daemon installed by `start --service`.
- `first-tree-hub login` command + bare-command alias — superseded by Web `/login` route + `local-bootstrap` endpoint; CLI layer would add no security value over loopback trust.
- Bootstrap token / magic URL with `?bootstrap=<token>` for local mode — replaced by loopback-trust admin minting. The bootstrap-token mechanism stays available for hosted mode (email links, etc.) where loopback trust does not apply.
- `admin:reset` / `show-credentials` commands — recovery is opening the browser or `start`; credentials never leave the DB in cleartext.
- Org provisioning UI (currently operator-side via `server admin:create` / admin API).
- Windows service support — foreground shape (`first-tree-hub start`) is the only path on Windows for now.

### Future discussion items (intent exists, not blocking current scope)
- **Default port migration.** Leaning toward changing the default from `8000` (commonly occupied on dev machines by Django, FastAPI, etc.) to a less-common port (e.g., `8473`). Deferred to keep the onboarding redesign focused; current scope keeps `8000` and adds a friendly `EADDRINUSE` message + `--port` flag (see C2). Revisit when local-version usage data shows port collision is a frequent friction point.
