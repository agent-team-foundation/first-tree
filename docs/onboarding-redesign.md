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

#### End-to-end journey (the experience we are designing for)

**Prerequisites the user must satisfy before anything happens:**
- Node.js ≥ 22.16
- Docker Engine or Docker Desktop installed and running

**Step 1 — Install (once)**
```
npm install -g @agent-team-foundation/first-tree-hub
```
After: `first-tree-hub` is on PATH. `~/.first-tree/hub/` does NOT exist yet.

**Step 2 — First run**
```
first-tree-hub start
```
What happens behind the scenes:
1. Docker preflight (`isDockerAvailable()`); fail fast with actionable message if absent.
2. `ensurePostgres` — pull image + start `first-tree-hub-postgres` container (5–10s on first run).
3. `runMigrations` — Drizzle creates ~32 tables.
4. `hasUser()` returns false → `createOwner()` silently creates user + org `default` + member + first human agent. Username = sanitised `os.userInfo().username` (fallback `admin`); password is random and never displayed.
5. Sign a single-use bootstrap JWT for that admin (10-min TTL).
6. `buildApp` + `app.listen` on `127.0.0.1:8000`.
7. In-process: `new ClientRuntime(...)` connects via loopback WS, registers as this machine's client, persists `client.yaml` + `credentials.json`.
8. Print the magic URL prominently; block on SIGINT.

After Step 2, the disk state is:
```
~/.first-tree/hub/
├── config/{server,client}.yaml
├── config/credentials.json (mode 0600)
├── logs/, data/
└── (no agents/<name>/ yet)
```
The `clients` table has one row (this computer); `agents` has the admin's human row only.

**Step 3 — Click the magic link**

User cmd-clicks (or copy-pastes) the printed URL. Browser:
1. Loads the React Web app served by the same fastify (`dist/web/index.html`).
2. App detects `?bootstrap=<token>` query param.
3. POSTs the token to `POST /api/v1/auth/bootstrap` → receives standard access + refresh JWT.
4. Stores tokens; `history.replaceState` removes the query param so it cannot leak via screenshots / refresh.
5. Routes to Workspace — empty state, no agent yet.

The user has now signed in without ever seeing username, password, or org.

**Step 4 — Create the first agent**

Workspace → Agents → `+ New Agent` → enter a name (e.g., `my-assistant`) → Create.

What happens:
1. Web `listClients()` finds 1 connected client (the embedded one).
2. Web calls `createAgent({name, type: "personal_assistant", clientId: <thisClient>})`.
3. Server inserts the agents row, pinned, R-RUN check passes.
4. Server emits WS `agent:pinned` to the embedded client.
5. Client `handleAgentPinned()` writes `~/.first-tree/hub/config/agents/my-assistant/agent.yaml`, instantiates `AgentSlot`, opens its own agent WS.
6. Web sees `agent.clientId` is set, routes to Workspace with the agent active.

Total elapsed time: 1–2 seconds. No Last-step modal, no terminal step.

**Step 5 — Chat with the agent**

User types in the center column. Message → server inbox → WS → AgentSlot handler → spawn Claude Code subprocess with cwd `~/.first-tree/hub/data/workspaces/my-assistant/` → stream response back through the same path. First message slow (cold-start), follow-ups in the same session fast.

**Step 6 — Stop (Ctrl+C)**

In the terminal that ran `start`:
- Embedded `ClientRuntime` stops slots and closes WS.
- Fastify closes.
- Process exits.
- **Postgres container is left running** (Docker `ps` still shows it).
- Final stdout line: `(database container kept; first-tree-hub server stop to also stop it)`.

Disk state preserved entirely; agents and messages are persistent across sessions.

**Step 7 — Subsequent runs (next day, after reboot, etc.)**

User opens Docker Desktop (or ensures Docker daemon is up), then:
```
first-tree-hub start
```
This time:
- `ensurePostgres` finds the existing container, reuses it. Boot is much faster (~2–3s).
- `hasUser()` is now true → skip admin creation entirely.
- Server still signs a **fresh** bootstrap token and prints a new magic URL.
- Embedded client connects, server replays `agent:pinned` for the existing `my-assistant`, slot starts on its own.
- Click the new URL → land in Workspace, the agent is already there with full chat history.

#### Total commands the user types, ever

| When | Command |
|---|---|
| First time on this machine | `npm install -g @agent-team-foundation/first-tree-hub` |
| Every run, including the first | `first-tree-hub start` |

That is the complete CLI surface for a local-version user. Everything else is hidden.

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

(Old C6 client-retry-backoff and C7 localhost-no-service are removed — both made moot by C2's embedded-client model.)

## 5. Sequencing

- **Phase 1 (local-scenario, fully spec'd).** C2 (`first-tree-hub start` + bootstrap endpoint + Web URL handler) + minimal D1 update for the local section + README Quick Start update. Independently shippable; doesn't depend on any hosted decision.
- **Phase 2 (hosted-scenario simplifications, fully spec'd).** C1 + C3 — both touch the connect/Last-step pair, share a testing scope. D1 hosted section using Path A first-time / Path B add-machine framing (Qh-2). D2 mirror in English.
- **Phase 3 (Hub-internal cleanup).** D3, D4, C4 — each can be its own small PR.
- **Phase 4 (deferred-question follow-ups).** Re-open Qh-1, Qh-5, Qh-6, Qh-7 in a separate session. C5 lands its core (no default-flag commitment) here, then flips on Qh-6.

## 6. Decisions log

### Local scenario

| ID | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | Auto-admin + bootstrap UX | Username/password/org never shown to user. No persistence in cleartext. Fresh URL on every `start`. No recovery command (Ctrl+C + restart). | Smallest CLI surface; restart frequency for evaluators is months apart |
| Q2 | Server as service | No (Q2-A). Foreground only. | Local user is evaluator; server-service complexity not justified |
| Q3 | Client connect mode | Moot — local flow has no separate `client connect` step | Resolved by C2 embedding the client in `start` |
| Q4 | Docker prereq UX | Q4-A: check at top of `start`, fail fast with the existing actionable message | Existing message is good; only timing needs fixing |
| Q5 | Single-command `first-tree-hub start` | Yes. Q5-a: name `start`. Q5-b: fresh URL each run. Q5-c: PG stays on Ctrl+C. Q5-d: replaces `server start` in user docs. | All four sub-decisions confirmed in turn |

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
- Server-as-service install (`first-tree-hub server service install` etc.)
- `admin:reset` / `login` / `show-credentials` commands (deferred until real demand surfaces)
- Org provisioning UI (currently operator-side via `server admin:create` / admin API)

### Future discussion items (intent exists, not blocking current scope)
- **Default port migration.** Leaning toward changing the default from `8000` (commonly occupied on dev machines by Django, FastAPI, etc.) to a less-common port (e.g., `8473`). Deferred to keep the onboarding redesign focused; current scope keeps `8000` and adds a friendly `EADDRINUSE` message + `--port` flag (see C2). Revisit when local-version usage data shows port collision is a frequent friction point.
