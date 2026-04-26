# Hub Onboarding Redesign — Planning Doc

**Status:** Draft / Working doc. Delete or archive once Phase 4 lands.

**Branch:** `feat/first-tree-hub-onboarding`

**Companion:** `docs/onboarding-redesign-zh.md` (internal discussion version, Chinese).

---

## 1. Why

- `docs/quickstart-zh.md` no longer matches the code on `origin/main`. Concrete drift verified against `06e40fb`:
  - "Generate Connect Command" button label — actual label is just `Generate` / `Regenerate`, container titled "Connect a computer" (`packages/web/src/pages/clients.tsx:33-95`).
  - "Type: Personal Assistant" field on the New Agent form — `type` is hardcoded to `personal_assistant` in `packages/web/src/components/new-agent-dialog.tsx:135`; the user-visible field is "Where it runs" (Claude Code / Kael).
  - "Pin to client" field — removed; replaced by automatic client probing (`new-agent-dialog.tsx:210-243`).
  - "Agent Created" dialog with single `agent add` line — replaced by "Last step — connect your computer" modal that emits a combined `npm install && agent add && client connect` one-liner (`packages/web/src/components/last-step-modal.tsx:76-82`).
  - The doc's prescribed sequence (`client connect` first, then create agent, then `agent add`) does not exist in current code: either Path A (Last-step one-liner) or Path B (zero CLI via `agent:pinned`) is taken — never the doc's middle path.
- The doc only covers a hosted Hub (`https://first-tree.staging.unispark.dev`); there is no quickstart for the self-hosted local-machine scenario, despite `first-tree-hub server start` being a supported command.
- Multi-account / `FIRST_TREE_HUB_HOME` complexity in the code is premature for the current product stage. We need an explicit decision to defer it before doc rewrite, otherwise the doc inherits the same confusion.
- **Scope of this doc:** local scenario is locked first (Section 4.1, all decisions finalized); hosted scenario is deferred to a subsequent discussion (Section 4.2).

## 2. Product principles for this stage

- **One human = one org = one member = one client.** Default invariant.
- **Server-side multi-tenancy** stays — `organizations` table, `members` join table, JWT-scoped-to-org. This is the ACL substrate for hosted Hub serving multiple customers; it is NOT a user-visible "join multiple orgs" capability.
- **Client-side multi-account is deferred indefinitely.** No `profile` subcommand; no UI affordance; `FIRST_TREE_HUB_HOME` is treated as an internal testing tool, not a documented product surface.
- **Login binds (member, org) at JWT issue time.** `auth.ts:50-51` already comments "this version: single org" — we do not change that.
- Public docs assume single-account-per-machine. Edge cases go into separate troubleshooting pages, not onboarding.
- **Local-version users are single-machine self-users.** Optimize for "install → run → use" with the fewest possible concepts in their mental model. Authentication, org, password are hidden entirely. The "evaluator vs daily user" persona distinction is dropped — there is one audience. The CLI exposes two operational shapes (foreground vs `--service`) presented as parallel choices, not as default + opt-in: the user picks based on their situation (debug a startup issue, run on Windows, SSH session → foreground; want Hub to survive reboots → `--service`).

## 3. Current-state inventory (verified against `origin/main`)

### Server (`packages/command/src/commands/server.ts`)
- `server start` (line 21): launches Postgres via Docker (or `--database-url`), runs migrations, serves Web on port 8000. **Does NOT auto-create an admin** — comment in `core/server.ts:28` claims it does, but actual implementation skips that step.
- `server admin:create` (line 115): separate command. Creates `users` + `organizations` + `members` + first human `agents` row + `agent_configs` seed. Generates and prints password once.
- `server doctor` / `server status` / `server db:migrate` / `server stop`: diagnostics + lifecycle.

### Web (`packages/web/src/`)
- `pages/clients.tsx`: Clients list. Top of page has a `ConnectStrip` with a `Generate` button that hits `POST /connect-tokens` and prints `first-tree-hub client connect <url> --token <jwt>` inline (10-min, single-use token).
- `components/new-agent-dialog.tsx`: New Agent flow. `type` hardcoded to `personal_assistant`. Probes `listClients()` after submit:
  - 0 connected → falls through to Last-step modal.
  - 1 connected → auto-pins via `createAgent({clientId})`.
  - ≥2 connected → "Choose a computer" picker.
- `components/last-step-modal.tsx`: Shown only when no connected client could absorb the new agent. Generates a combined one-liner `npm install && agent add && client connect --token`. Polls `agent.clientId` until it becomes set, then auto-routes to Workspace.

### Client (`packages/command/src/`)
- `commands/connect.ts`: `client connect <url>`. Supports `--token` (connect token) or interactive username/password. Has a 60-line **account-switch gate** that decodes the new JWT, compares `memberId` with existing credentials, prompts Replace/Cancel, and on Cancel prints a `FIRST_TREE_HUB_HOME` isolation guide. Installs the launchd / systemd-user service by default unless `--no-service`.
- `commands/agent.ts`: `agent add [name] --agent-id <uuid>` writes `~/.first-tree/hub/config/agents/<name>/agent.yaml`.
- `core/client-runtime.ts:233-261`: Listens for `agent:pinned` server push and auto-writes the same `agent.yaml` that `agent add` would have written, then starts the slot. Comment explicitly says "mirror what `first-tree-hub agent add` does".

### Two real onboarding paths
- **Path A** (brand-new machine, 0 connected clients): user creates agent in Web → Last-step modal → copies one-liner → terminal runs `npm install + agent add + client connect --token` → modal polls and routes to Workspace.
- **Path B** (already-connected machine): user creates agent in Web → server pins → server WS push → client auto-registers → Web jumps to Workspace. Zero CLI.

The middle path described in current `quickstart-zh.md` (separate `client connect` then `agent add`) is unreachable in current code.

## 4. Required changes

### 4.1 Local-scenario flow (FINALIZED)

A single new top-level command — `first-tree-hub start` — replaces today's three-step `server start` + `admin:create` + `client connect`. The command has two equally-supported operational shapes; the user picks the one that matches their situation. Neither is "the default"; the onboarding guide presents them as parallel choices.

| Operational shape | Pick this when… | What survives closing the terminal? |
|---|---|---|
| `first-tree-hub start` | "I want to run Hub in this terminal." Quick try, debugging a startup issue, SSH session, or Windows (no service support). | Postgres container only. CLI process owns server + embedded client; Ctrl+C stops both. |
| `first-tree-hub start --service` | "I want Hub running across reboots without a terminal." | Postgres + daemon (server + embedded client). Daemon auto-starts at next login. |

Both shapes share the same orchestration — Docker preflight, Postgres provisioning, migrations, auto-admin, embedded `ClientRuntime`, multi-layered URL delivery. They differ only in lifecycle: the foreground shape blocks until SIGINT; `--service` installs a launchd plist (macOS) or systemd-user unit (Linux), then exits.

#### Output the user sees — foreground shape

```
$ first-tree-hub start
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Server listening at http://127.0.0.1:8000
✓ Client connected as this computer

  Opening browser...
  (or open this URL: http://127.0.0.1:8000/?bootstrap=eyJhbGc...)

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

  Opening browser...
  (or open this URL: http://127.0.0.1:8000/?bootstrap=eyJhbGc...)

(Service runs in the background and auto-starts at next login.)
(Need a fresh URL later? first-tree-hub login)

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

Behind the scenes (both shapes share these steps):
1. Docker preflight (`isDockerAvailable()`); fail fast with the actionable message if absent.
2. `ensurePostgres` — pull image + start `first-tree-hub-postgres` container (5–10s on first run).
3. `runMigrations` — Drizzle creates ~32 tables.
4. `hasUser()` returns false → `createOwner()` silently creates user + org `default` + member + first human agent. Username = sanitised `os.userInfo().username` (fallback `admin`); password is random and never displayed.
5. Bring the server up (`buildApp` + `app.listen` on `127.0.0.1:8000`) plus an embedded `ClientRuntime` registered as this machine's client. Persist `client.yaml` + `credentials.json`.
6. Sign a single-use bootstrap JWT for the admin (10-min TTL).
7. Multi-layered URL delivery — auto-open browser unless `--no-open` / SSH / non-TTY; print URL to stdout always; copy to clipboard unless `--no-clipboard`.

The shapes diverge after Step 2's shared work:
- **Foreground:** server + embedded client live in the CLI process; the process blocks until SIGINT.
- **Service:** install platform service unit, hand server + embedded client off to the daemon, parent polls daemon `/health` for up to 10s. On failure: roll back via `service uninstall`, print captured stderr (last ~20 lines from log), exit 1. On success: parent exits 0; daemon keeps running.

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

The auto-open (or user click on the printed URL, or paste from clipboard) loads `http://127.0.0.1:8000/?bootstrap=<token>`. The Web app:
1. Loads the React Web app served by the same fastify (`dist/web/index.html`).
2. Detects `?bootstrap=<token>` query param.
3. POSTs the token to `POST /api/v1/auth/bootstrap` → receives standard access + refresh JWT.
4. Stores tokens; `history.replaceState` removes the query param so it cannot leak via screenshots / refresh.
5. Routes to Workspace — empty state, no agent yet.

The user has now signed in without ever seeing username, password, or org.

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
- **Service:** the CLI command already exited at the end of Step 2. Closing the terminal does nothing to the daemon. The browser tab can be closed too — refresh-token cookie persists (TTL ≈ weeks).

**Step 7 — Subsequent runs**

- **Foreground:** the user re-runs `first-tree-hub start` whenever they want Hub up. `ensurePostgres` reuses the existing container (~2–3s); `hasUser()` is true so admin creation is skipped; a **fresh** bootstrap URL is delivered each time.
- **Service:** nothing to do. Daemon auto-starts at login; Postgres container auto-starts when Docker daemon does. The user just opens `http://127.0.0.1:8000` — cookies still valid → Workspace. If cookies expired or they're on a new browser: `first-tree-hub login` (or bare `first-tree-hub`) delivers a fresh URL the same way `start` does.

#### Total commands the user types, ever

| When | Command |
|---|---|
| First time on this machine | `npm install -g @agent-team-foundation/first-tree-hub` |
| Run / install Hub on this machine | `first-tree-hub start` (foreground) **or** `first-tree-hub start --service` (service) |
| Get a fresh login URL (occasionally) | `first-tree-hub login` (or bare `first-tree-hub`) |
| Remove Hub from this machine (service shape) | `first-tree-hub service uninstall` |

Everything else is hidden.

#### Behavior contract

1. **Preflight (Q4-A):** check Docker availability before any side effects. Missing → print actionable message (`core/server.ts:57-64`, with `re-run` line updated to `first-tree-hub start`) and exit immediately.
2. **Postgres:** provision via `ensurePostgres`, or reuse a running container.
3. **Migrations:** run via `runMigrations`.
4. **Auto-admin (Q1):** if `users` table is empty (`hasUser` returns false), silently `createOwner` — sanitised `os.userInfo().username` (fallback `admin`), org `default`, random password. **Never displayed, never persisted in cleartext.**
5. **Server + embedded client:** bring server up on `127.0.0.1:8000`, plus an embedded `ClientRuntime` registered as this machine's client. Persist `client.yaml` + `credentials.json` (admin JWT pair) so out-of-band CLI commands (`first-tree-hub agent ...`) keep working.
6. **Bootstrap token (Q5-b):** sign a fresh single-use bootstrap token for the admin on every run, 10-minute TTL.
7. **URL delivery (Q7):** multi-layered: (a) auto-open browser unless `--no-open` / SSH session / non-TTY; (b) always print URL to stdout (Cmd+click-friendly in modern terminals); (c) copy to clipboard unless `--no-clipboard` / clipboard tool unavailable.
8. **Foreground shape:** server + embedded client run in the CLI process; block until SIGINT. SIGINT stops both gracefully; **leaves Postgres container running**, with the hint to `first-tree-hub server stop`.
9. **Service shape (Q2):** install launchd plist (macOS) or systemd-user unit (Linux), hand the orchestration off to the daemon, parent polls daemon `/health` up to 10s (Q8). On failure: `service uninstall` rollback, print last ~20 lines of daemon stderr from log, exit 1 — **no half-installed state**. On success: parent exits 0; daemon hosts server + embedded client.
10. **`--port <n>`:** default `8000`. On `EADDRINUSE`: print `Port N is busy. Try 'first-tree-hub start --port <N+1>'.` and exit. No auto-fallback, no probing.
11. **`--no-open` / `--no-clipboard`:** opt out of browser auto-open / clipboard copy independently.
12. **Idempotency (service shape):** re-running `first-tree-hub start --service` when service is already installed and running:
    - Skip install
    - Best-effort daemon liveness check
    - Sign + deliver a fresh URL via the same multi-layered pattern
    - Exit 0
13. **Cross-shape collision:** running `start` while a service is already active (or vice versa) detects the conflict (port `8000` busy or service running flag). Friendly error: `Hub is already running as a service. Use 'first-tree-hub login' to log in, or 'first-tree-hub service stop' first if you want to run inline.` Exit 1.

#### Multi-layered URL delivery (Q7)

Each layer is best-effort and fails open to the next:

- **Auto-open browser** — uses `open` (macOS) / `xdg-open` (Linux) / `start` (Windows). Skipped when:
  - `--no-open` is passed
  - SSH session detected (`SSH_CLIENT` / `SSH_TTY` env)
  - stdout is not a TTY (CI, piped output)
- **Print to stdout** — always. Modern terminals (iTerm2, Terminal.app, VS Code, Warp, Alacritty) make printed URLs Cmd+click-friendly.
- **Copy to clipboard** — uses `pbcopy` (macOS), `xclip` / `wl-copy` (Linux), `clip` (Windows). Skipped when `--no-clipboard` or tool unavailable.

#### Bare command behavior (Q6)

```
first-tree-hub
```
With no subcommand, defaults to `login`. Rationale: after the one-time `first-tree-hub start`, the user's most frequent need is "give me a URL to log in" — bare command optimizes for that, not for the rare-but-disruptive `start` reinvocation. If neither a foreground process nor a daemon is running, prints `Hub is not running on this machine. Run 'first-tree-hub start' or 'first-tree-hub start --service' to bring it up.` and exits 1.

#### Service-mode management

After `start --service` installs the service, four commands manage it:

```
first-tree-hub service status            # running / installed-but-stopped / not-installed
first-tree-hub service logs [-f] [-n N]  # tail / follow rotating NDJSON log
first-tree-hub service stop              # stop daemon without uninstalling
first-tree-hub service uninstall         # remove plist/unit + stop daemon (Postgres untouched)
```

Service stop / uninstall does NOT touch the Postgres Docker container — that lifecycle is decoupled.

#### Recovery

| Situation | What to do |
|---|---|
| Cookie expired / new browser / lost URL | `first-tree-hub login` (or bare `first-tree-hub`) |
| Daemon stopped or crashed (service shape) | `first-tree-hub start --service` (idempotent) |
| Foreground process exited and you want it back | `first-tree-hub start` |
| Service was uninstalled, want it back | `first-tree-hub start --service` |

#### User-visible surface (deliberately minimal)

The user **never sees** username, password, org name, JWTs, refresh tokens, `agent add`, `client connect`, launchd plist contents, systemd unit file paths, Postgres connection URLs, `credentials.json` location.

#### What does NOT exist (deliberately deferred)

- `admin:reset` command — recovery is `start` (idempotent) or `login`.
- `admin.json` cleartext file — credentials never leave the DB (bcrypt hash only).
- Server-as-service in the `server` namespace (e.g. `server service install`) — only the unified top-level `service` namespace exists.
- `--detach` flag — `--service` covers the persistent-background case.
- Windows service support — foreground shape (`first-tree-hub start`) is the only path on Windows for now.
- Multi-account on a single machine — single-account-per-machine is the product invariant.

### 4.2 Hosted-scenario flow (PARTIALLY FINALIZED)

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
- **Qh-7 — Hosted end-to-end journey writeup.** The local scenario (Section 4.1) has a step-by-step journey. The hosted equivalent is contingent on Qh-1 (auth mechanism, "how does the user get their first credential") and is deferred until that resolves.

### 4.3 Documentation (D1–D4)

- **D1.** Rewrite `docs/quickstart-zh.md`. Local section uses 4.1's flow exclusively; hosted section pending 4.2.
- **D2.** Update `docs/onboarding-guide.md` (English). Drop legacy `agent token bootstrap` references. Mirror D1 structure.
- **D3.** Move `Local Testing Isolation` out of public `CLAUDE.md` to `docs/dev/testing-isolation.md`. Stop documenting `FIRST_TREE_HUB_HOME` in user-facing docs.
- **D4.** `docs/multi-tenancy-hardening-design.md:18` — drop "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" parenthetical. Replace with "deferred indefinitely".

### 4.4 Code changes (C1–C5)

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
  - Auto-admin: reuse `core/admin.ts:hasUser` + `createOwner`.
  - New endpoint: `POST /api/v1/auth/bootstrap` — accepts a single-use bootstrap token, returns the standard access + refresh JWT pair (modeled after `/auth/connect-token`).
  - Web change: at the root route, detect `?bootstrap=<token>` query param, exchange via the new endpoint, store JWT, clean URL, redirect to Workspace.
  - Embedded client: in the same process, after `app.listen` resolves, instantiate `ClientRuntime` with `getAccessToken: () => <admin JWT in memory>`.
  - SIGINT handler stops both gracefully; leaves Postgres container running with the hint to `first-tree-hub server stop`.
  - **Multi-layered URL delivery (Q7):** new shared module `core/url-delivery.ts` — auto-open browser via `open` / `xdg-open` / `start` (skipped on `--no-open`, SSH session, non-TTY), always print URL to stdout, copy to clipboard via `pbcopy` / `xclip` / `wl-copy` / `clip` (skipped on `--no-clipboard` or tool unavailable). Shared by C2's foreground shape, C8's service shape, and C9's `login`.
  - **Cross-shape collision detection:** before binding `:8000`, probe whether a daemon is already serving the port; if yes, print the friendly redirect-to-`login` message and exit 1.
  - README "Quick Start" section updated to present both shapes (`start` and `start --service`) without designating a default.
  - **Port handling:** default `8000` (unchanged), `--port <n>` flag accepted. On `EADDRINUSE`, catch and print "Port N is busy. Try `first-tree-hub start --port <N+1>`." instead of the raw Node stack. No auto-fallback, no probing — see Section 7 for the future port-default discussion.
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
  - `first-tree-hub start --service` — install launchd plist (macOS) or systemd-user unit (Linux), hand the orchestration off to the daemon, parent polls daemon `/health` for up to 10s, deliver URL via the shared `core/url-delivery.ts`, then exit immediately. Subsequent reboots auto-start.
  - `first-tree-hub service install` — alias for `start --service` (Multica-style entry point).
  - `first-tree-hub service uninstall` — remove the plist/unit, stop the running service.
  - `first-tree-hub service status` — running / installed-but-stopped / not-installed.
  - `first-tree-hub service logs [-f] [-n N]` — print or follow rotating NDJSON log file under `~/.first-tree/hub/logs/`.
  - `first-tree-hub service stop` — stop daemon without uninstalling.
  - The daemon process invokes the same orchestration C2 implements — Docker preflight, auto-admin (first run), embedded ClientRuntime, server on `127.0.0.1:8000`. Difference vs foreground: stdout/stderr go to log files, not terminal. The daemon does **not** sign or print bootstrap URLs on its own — URL signing is always done by a parent CLI (`start --service` does it once before exit; `login` does it on demand). After the initial `start --service`, daemon auto-restarts at boot are silent: cookie persistence in the browser carries the user across reboots; `login` regenerates a URL when cookies actually expire.
  - **Health check + rollback (Q8):** parent process polls daemon `/health` up to 10s. On timeout / unhealthy: invoke `service uninstall`, print last ~20 lines of daemon stderr from log, exit 1. **No half-installed state.**
  - Postgres lifecycle stays decoupled — service stop/uninstall does NOT touch the Docker container.
- **C9.** Add `first-tree-hub login` command + bare-command alias.
  - `first-tree-hub login` — connects to the running local server (foreground or daemon), signs a fresh single-use bootstrap token for the admin, delivers the magic URL via the shared `core/url-delivery.ts` (auto-open + stdout + clipboard).
  - **Bare command (Q6):** `first-tree-hub` with no subcommand defaults to `login`. If neither a foreground process nor a daemon is reachable on `:8000`, prints `Hub is not running on this machine. Run 'first-tree-hub start' or 'first-tree-hub start --service' to bring it up.` and exits 1.
  - Works whether `start` is running inline or as a service — the URL-signing path is the same.
  - ~20 LOC of new code: reuses existing `core/admin.ts` (find admin) + signs token via the same path C2 uses + uses the shared `core/url-delivery.ts`.

(Old C6 client-retry-backoff and C7 localhost-no-service are removed — both made moot by C2's embedded-client model.)

## 5. Sequencing

- **Phase 1 (local-scenario, fully spec'd).** C2 (`first-tree-hub start` foreground shape + shared orchestration + bootstrap endpoint + Web URL handler + multi-layered URL delivery) + C8 (`--service` shape + `service` management subcommands + health check / rollback) + C9 (`login` command + bare-command alias) + minimal D1 update for the local section + README Quick Start update. Independently shippable; doesn't depend on any hosted decision. Both shapes ship together so docs can present them as parallel choices.
- **Phase 2 (hosted-scenario simplifications, fully spec'd).** C1 + C3 — both touch the connect/Last-step pair, share a testing scope. D1 hosted section using Path A first-time / Path B add-machine framing (Qh-2). D2 mirror in English.
- **Phase 3 (Hub-internal cleanup).** D3, D4, C4 — each can be its own small PR.
- **Phase 4 (deferred-question follow-ups).** Re-open Qh-1, Qh-5, Qh-6, Qh-7 in a separate session. C5 lands its core (no default-flag commitment) here, then flips on Qh-6.

## 6. Decisions log

### Local scenario

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | Auto-admin + bootstrap UX | Username/password/org never shown to user. No persistence in cleartext. Fresh URL on every `start`. Cookie expiry / lost URL recovery via `first-tree-hub login`. | "No password ever shown" is the load-bearing principle; cookie persistence + on-demand `login` keeps it intact across reboots and new browsers |
| Q2 | Server as service | **Two equally-supported shapes, no default.** `first-tree-hub start` runs foreground (server + embedded client in CLI process); `first-tree-hub start --service` installs launchd plist / systemd-user unit and hands the same orchestration to a daemon. The onboarding guide presents them as parallel choices selected by user situation, not as default + opt-in. | A foreground-only design forced daily users into tmux/nohup; a service-default design surprised users with launchd plist installs they didn't ask for. Both shapes are first-class because they serve different real situations: foreground for SSH / Windows / debug, service for persistence |
| Q3 | Client connect mode | Moot — local flow has no separate `client connect` step | Resolved by C2 embedding the client in `start` |
| Q4 | Docker prereq UX | Q4-A: check at top of `start`, fail fast with the existing actionable message | Existing message is good; only timing needs fixing |
| Q5 | Single-command `first-tree-hub start` | Yes. Q5-a: name `start`. Q5-b: fresh URL each run. Q5-c: PG stays on Ctrl+C / `service stop` / `service uninstall`. Q5-d: replaces `server start` in user docs. | All four sub-decisions confirmed |
| Q6 | Bare `first-tree-hub` behavior | Aliases to `login`. If neither foreground process nor daemon is reachable, prints `Hub is not running... Run 'first-tree-hub start' or 'first-tree-hub start --service'` and exits 1. | After the one-time `start`, the dominant user need is "give me a URL"; bare command optimizes for that. gh-style precedent (bare command = primary action). Bare ≠ `start` is intentional: starting a service from a typo would be surprising |
| Q7 | URL delivery | Multi-layered, all best-effort: (a) auto-open browser via `open` / `xdg-open` / `start`, skipped on `--no-open` / SSH session / non-TTY; (b) always print URL to stdout (Cmd+click-friendly); (c) copy to clipboard via `pbcopy` / `xclip` / `wl-copy` / `clip`, skipped on `--no-clipboard` / tool unavailable. Shared module `core/url-delivery.ts` used by `start` (both shapes) and `login`. | Single-layer would fail on the wrong environment (auto-open broken in SSH; clipboard broken in containers; stdout invisible in service mode). Multi-layer always lands at least one path |
| Q8 | Service-shape health check + rollback | Parent process polls daemon `/health` for up to 10s after handing off. On timeout / unhealthy: invoke `service uninstall`, print last ~20 lines of daemon stderr from log, exit 1. **No half-installed state.** | Service-mode failures (Docker permission, port collision, broken plist) must surface in the parent's stdout; otherwise users are left with a half-installed service and a "nothing happened" terminal |

### Hosted scenario

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Qh-1 | Source of truth for member identity | **Deferred.** Architecture direction is Hh-1.B (Context Tree `members/` as SoT, Hub Web as friendly UI for editing it via PR/commit). Implementation timing + auth mechanism (OAuth vs password) open. Today's `members.createMember` (DB-only) stays until further decision. | Architectural decision, cross-product; needs separate session |
| Qh-2 | Path A vs Path B canonical | **Both.** Treat as two lifecycle moments: Path A (Last-step modal) is first-time onboarding; Path B (Connect-a-computer strip) is adding more machines. Doc structured by lifecycle moment, not "canonical vs alternative". Welcome-flow UX upgrade deferred. | A and B are different mental models for different stages, not competing options |
| Qh-3 | Drop `agent add` from one-liner (C3) | **Yes.** Two-command chain (install + connect). | Removes orphan-yaml failure mode; `agent:pinned` replay covers the dropped step |
| Qh-4 | Simplify account-switch gate (C1) | **Yes.** One-line Y/N replace prompt. No JWT decoding, no isolation guide. | Single-account-per-machine principle locked; the 60-line gate served a multi-account scenario we deferred |
| Qh-5 | Org provisioning docs | **Deferred.** Likely outcome: separate `docs/operator-runbook.md`. Today: user docs assume "you have credentials". | Not blocking other Qh items; needs follow-up |
| Qh-6 | `client logout` default service teardown | **Deferred.** C5 lands core actions (disconnect + stop process + clear creds); default flag for service teardown decided later. | Flag default doesn't block the command itself |
| Qh-7 | Hosted end-to-end journey writeup | **Deferred.** Blocked on Qh-1 (auth mechanism shapes how user gets first credential). | The journey writeup needs a settled credential flow |

## 7. Out of scope / future considerations

### Hard out of scope (no current intent)
- `first-tree-hub profile` multi-account UX
- Per-profile launchd / systemd unit names
- Multi-org login UI (let the user pick which membership to use)
- Cross-Hub federation / multi-Hub credential management
- Self-service registration / signup flow
- Email-invite / link-invite for new members
- A `server service` namespace (e.g. `first-tree-hub server service install`) — only the unified top-level `service` namespace exists, managing the daemon installed by `start --service`.
- `admin:reset` / `show-credentials` commands — recovery is `start` (idempotent) or `login`; credentials never leave the DB in cleartext.
- Org provisioning UI (currently operator-side via `server admin:create` / admin API).
- Windows service support — foreground shape (`first-tree-hub start`) is the only path on Windows for now.

### Future discussion items (intent exists, not blocking current scope)
- **Default port migration.** Leaning toward changing the default from `8000` (commonly occupied on dev machines by Django, FastAPI, etc.) to a less-common port (e.g., `8473`). Deferred to keep the onboarding redesign focused; current scope keeps `8000` and adds a friendly `EADDRINUSE` message + `--port` flag (see C2). Revisit when local-version usage data shows port collision is a frequent friction point.
