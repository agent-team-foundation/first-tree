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
- **Local-version users are evaluators / single-machine self-users.** Optimize for "install → run → use" with the fewest possible concepts in their mental model. Authentication, org, password, service install — all hidden by default.

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

A single new top-level command replaces today's three-step `server start` + `admin:create` + `client connect` for all local users.

```
$ first-tree-hub start
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Server listening at http://127.0.0.1:8000
✓ Client connected as this computer

  Open this URL to log in:
    http://127.0.0.1:8000/?bootstrap=eyJhbGc...

Press Ctrl+C to stop.
(Postgres container is kept running. To also stop it: first-tree-hub server stop)
```

**Behavior contract:**

1. **Preflight (Q4-A):** check Docker availability. Missing → print existing actionable message (`core/server.ts:57-64`, with `re-run` line updated to `first-tree-hub start`) and exit immediately, before any other output.
2. **Postgres:** provision via existing `ensurePostgres`, or reuse a running container.
3. **Migrations:** run via existing `runMigrations`.
4. **Auto-admin (Q1):** if `users` table is empty (`hasUser` returns false), create admin silently — `os.userInfo().username` sanitised (fallback `admin`), org `default`, random password generated. **Username, password, org are never shown to the user and never persisted in cleartext.**
5. **Bootstrap token (Q5-b):** sign a fresh bootstrap token for the admin on every run, single-use, 10-minute TTL. Print the magic URL prominently in stdout.
6. **Server start:** existing `buildApp` + `app.listen` on `127.0.0.1:8000`.
7. **Embedded client (Q5):** in the same Node process, instantiate a `ClientRuntime` pointed at the local server, using the admin's JWT in-memory for the WS handshake. Persist `client.yaml` and `credentials.json` so out-of-band CLI commands (`first-tree-hub agent ...`) keep working.
8. **No client service install (Q5):** the embedded client lives and dies with this process; no launchd/systemd unit.
9. **SIGINT (Q5-c):** gracefully stop the embedded `ClientRuntime`, close fastify, exit. **Leave the Postgres container running.** The closing message tells the user how to also stop Postgres.

**User-visible surface (deliberately minimal):**

- The command: `first-tree-hub start`
- The bootstrap URL printed each run
- A "Press Ctrl+C to stop" line
- Nothing else

The user **never sees** username, password, org name, JWTs, refresh tokens, `agent add`, `client connect`, service install/uninstall, Postgres URL, etc.

**Recovery (if the URL is lost or cookies expire):** Ctrl+C, run `start` again. Each invocation prints a fresh URL.

**What does NOT exist (deliberately deferred):**

- `admin:reset` command — not needed; recovery is restart.
- `login` / `bootstrap-url` command — not needed; restart frequency is low (estimated months between events for typical evaluators).
- `admin.json` cleartext file — credentials never leave the DB (bcrypt hash only).
- Server-as-service — early stage; daily-driver users can keep terminal open or use their own backgrounding (tmux, screen).
- Server `--detach` flag — same reasoning.

### 4.2 Hosted-scenario flow

**Status:** Discussion deferred to a subsequent session. The current implementation (Web `Generate` token, New Agent dialog with auto-pin, Last-step modal one-liner, `client connect` with token) remains in place until then.

Items that need decision before the hosted scenario can be doc-rewritten:

- Whether to simplify the account-switch gate (C1)
- Whether to drop `agent add` from the Last-step one-liner (C3)
- How org provisioning is documented (operator runbook? out-of-scope of user docs?)
- Whether to keep the Web "Generate Connect Command" strip or rely on Last-step modal exclusively

### 4.3 Documentation (D1–D4)

- **D1.** Rewrite `docs/quickstart-zh.md`. Local section uses 4.1's flow exclusively; hosted section pending 4.2.
- **D2.** Update `docs/onboarding-guide.md` (English). Drop legacy `agent token bootstrap` references. Mirror D1 structure.
- **D3.** Move `Local Testing Isolation` out of public `CLAUDE.md` to `docs/dev/testing-isolation.md`. Stop documenting `FIRST_TREE_HUB_HOME` in user-facing docs.
- **D4.** `docs/multi-tenancy-hardening-design.md:18` — drop "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" parenthetical. Replace with "deferred indefinitely".

### 4.4 Code changes (C1–C5)

- **C1.** Strip the account-switch gate in `packages/command/src/commands/connect.ts:78-242`. Replace with a single Y/N "Replace existing credentials?" prompt. ~50 LOC removed. *Applies once C2 lands and `client connect` is hosted-only.*
- **C2.** Implement `first-tree-hub start` (new top-level command).
  - File: `packages/command/src/commands/start.ts`.
  - Server orchestration: refactor `core/server.ts:startServer` so the listen step is observable from the caller (or split into a `bootstrapServer()` returning `{app, config}` plus a separate listen call).
  - Auto-admin: reuse `core/admin.ts:hasUser` + `createOwner`.
  - New endpoint: `POST /api/v1/auth/bootstrap` — accepts a single-use bootstrap token, returns the standard access + refresh JWT pair (modeled after `/auth/connect-token`).
  - Web change: at the root route, detect `?bootstrap=<token>` query param, exchange via the new endpoint, store JWT, clean URL, redirect to Workspace.
  - Embedded client: in the same process, after `app.listen` resolves, instantiate `ClientRuntime` with `getAccessToken: () => <admin JWT in memory>`.
  - SIGINT handler stops both.
  - README "Quick Start" section updated to `npm install ... && first-tree-hub start`.
  - **Port handling:** default `8000` (unchanged), `--port <n>` flag accepted. On `EADDRINUSE`, catch and print "Port N is busy. Try `first-tree-hub start --port <N+1>`." instead of the raw Node stack. No auto-fallback, no probing — see Section 7 for the future port-default discussion.
- **C3.** Last-step modal one-liner drops the `agent add` segment. Server-side `agent:pinned` replay (`services/client.ts:147-149`) covers it. *Hosted-only; pending 4.2.*
- **C4.** Fix `LOG_DIR` in `packages/command/src/core/service-install.ts:47`. Resolve at use-site, not at module load.
- **C5.** Add `first-tree-hub client logout`:
  - Delete `credentials.json`.
  - Optional flag for service teardown.
  - POST `/api/v1/clients/<self>/disconnect` so server marks the row offline.
  - *Primarily for hosted-scenario users; revisit relevance after 4.2.*

(Old C6 client-retry-backoff and C7 localhost-no-service are removed — both made moot by C2's embedded-client model.)

## 5. Sequencing

Reorganized around the local-first scope:

- **Phase 1 (local-scenario complete).** C2 (`first-tree-hub start` + bootstrap endpoint + Web URL handler) + minimal D1 update for the local section + README Quick Start update.
- **Phase 2 (hosted-scenario alignment).** Conduct the deferred discussion to finalize 4.2. Land C1 / C3 / final D1 hosted section / D2.
- **Phase 3 (cleanup).** D3, D4, C4, C5 — independent, can each be its own PR.

## 6. Decisions log

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | Auto-admin + bootstrap UX | Username/password/org never shown to user. No persistence in cleartext. Fresh URL on every `start`. No recovery command (Ctrl+C + restart). | Smallest CLI surface; restart frequency for evaluators is months apart |
| Q2 | Server as service | No (Q2-A). Foreground only. | Local user is evaluator; server-service complexity not justified |
| Q3 | Client connect mode | Moot — local flow has no separate `client connect` step | Resolved by C2 embedding the client in `start` |
| Q4 | Docker prereq UX | Q4-A: check at top of `start`, fail fast with the existing actionable message | Existing message is good; only timing needs fixing |
| Q5 | Single-command `first-tree-hub start` | Yes. Q5-a: name `start`. Q5-b: fresh URL each run. Q5-c: PG stays on Ctrl+C. Q5-d: replaces `server start` in user docs. | All four sub-decisions confirmed in turn |

## 7. Out of scope / future considerations

### Hard out of scope (no current intent)
- `first-tree-hub profile` multi-account UX
- Per-profile launchd / systemd unit names
- Multi-org login UI (let the user pick which membership to use)
- Cross-Hub federation / multi-Hub credential management
- Self-service registration / signup flow
- Email-invite / link-invite for new members
- Server-as-service install (`first-tree-hub server service install` etc.)
- `admin:reset` / `login` / `show-credentials` commands (deferred until real demand surfaces)
- Org provisioning UI (currently operator-side via `server admin:create` / admin API)

### Future discussion items (intent exists, not blocking current scope)
- **Default port migration.** Leaning toward changing the default from `8000` (commonly occupied on dev machines by Django, FastAPI, etc.) to a less-common port (e.g., `8473`). Deferred to keep the onboarding redesign focused; current scope keeps `8000` and adds a friendly `EADDRINUSE` message + `--port` flag (see C2). Revisit when local-version usage data shows port collision is a frequent friction point.
