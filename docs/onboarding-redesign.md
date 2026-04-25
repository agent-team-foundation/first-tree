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

## 2. Product principles for this stage

- **One human = one org = one member = one client.** Default invariant.
- **Server-side multi-tenancy** stays — `organizations` table, `members` join table, JWT-scoped-to-org. This is the ACL substrate for hosted Hub serving multiple customers; it is NOT a user-visible "join multiple orgs" capability.
- **Client-side multi-account is deferred indefinitely.** No `profile` subcommand; no UI affordance; `FIRST_TREE_HUB_HOME` is treated as an internal testing tool, not a documented product surface.
- **Login binds (member, org) at JWT issue time.** `auth.ts:50-51` already comments "this version: single org" — we do not change that.
- Public docs assume single-account-per-machine. Edge cases go into separate troubleshooting pages, not onboarding.

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

### 4.1 Documentation (D1–D4)

- **D1.** Rewrite `docs/quickstart-zh.md`. Split into two scenarios:
  - **Scenario 1: 本地自建** — `server start` (Docker prerequisite) → first-admin creation → Web login → fall through to common "connect + create agent" section.
  - **Scenario 2: 托管 Hub** — open URL provided by org admin → log in → fall through to common section.
  - **Common section** — Path A (no client yet) and Path B (already connected) explicitly. No multi-account section.
  - Workspace three-column intro retained.
- **D2.** Reconcile `docs/onboarding-guide.md` (English). It still references the legacy `agent token bootstrap` flow which was removed in PRs #95/#108. Either rewrite to mirror D1, or delete and replace with a new English `onboarding.md`.
- **D3.** Move the `Local Testing Isolation` section out of `CLAUDE.md` to an internal-only contributor doc (`docs/dev/testing-isolation.md`). Public-facing files stop documenting `FIRST_TREE_HUB_HOME`.
- **D4.** `docs/multi-tenancy-hardening-design.md:18` lists "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" in non-goals. Drop the parenthetical — replace with "deferred indefinitely" so we do not pre-commit to a name.

### 4.2 Code (C1–C5)

- **C1.** Strip the account-switch gate in `packages/command/src/commands/connect.ts:78-242`. Replace with a single Y/N prompt: "This computer already has Hub credentials. Replace?" — no JWT decoding, no isolation guide. ~50 LOC removed.
- **C2.** `server start` auto-creates the first admin when `users` table is empty. Behavior:
  - Detect via `hasUser()` (`core/admin.ts:10`).
  - Prompt for username (default suggestion: `os.userInfo().username`).
  - Generate password via `randomBytes(12).base64url()` (same as today).
  - Print credentials block once before "Server running at …".
  - Skip if `--no-interactive`.
- **C3.** `last-step-modal.tsx` one-liner drops the `agent add` segment. Rationale: `client connect` triggers `client:register`, server already knows about the new client and replays pinned agents via `agent:pinned`; `agent add` in the chain is defensive duplication that creates the orphan-yaml failure mode if `connect` is cancelled or fails.
  - New chain: `npm install -g @agent-team-foundation/first-tree-hub && first-tree-hub client connect <url> --token <jwt>`.
  - Server-side: `services/client.ts:147-149` already replays missed `agent:pinned` notifications on registration, so the auto-add fires immediately after connect succeeds.
- **C4.** Fix `LOG_DIR` in `packages/command/src/core/service-install.ts:47`. Currently `join(DEFAULT_HOME_DIR, "logs")` resolves at module-load time using the env var as it was when the module first loaded — this is wrong for any process that runs with a different `FIRST_TREE_HUB_HOME` than the install-time process. Resolve via a function call at use-site.
- **C5.** Add `first-tree-hub client logout`. Behavior:
  - Delete `credentials.json`.
  - Optionally tear down the launchd / systemd service (prompt or `--keep-service`).
  - POST `/api/v1/clients/<self>/disconnect` so server marks the row offline immediately.
  - Print clear next-step ("To use this computer again, run `client connect <url>`").

## 5. Sequencing

- **Phase 1 (Doc only, zero code risk).** D1, D2. Establishes the source of truth users actually read.
- **Phase 2 (Local happy path).** C2. Removes the manual `admin:create` step that exists today. Updates D1 if needed.
- **Phase 3 (Onboarding simplification).** C1 + C3 together — both touch the connect/last-step pair, share testing scope.
- **Phase 4 (Cleanup).** D3, D4, C4, C5. Independent, can be split into separate PRs.

## 6. Open decisions

- **Q1.** Doc filename. Keep `docs/quickstart-zh.md` (smaller blast radius — README links unchanged), or rename to `docs/onboarding-zh.md` (clearer)?
- **Q2.** English counterpart. Rewrite `docs/onboarding-guide.md` in place, or replace with a new doc named `docs/onboarding.md`?
- **Q3.** C3 timing. Drop `agent add` from the one-liner in Phase 3, or hold until field testing confirms `agent:pinned` reliably fires post-`client connect`?
- **Q4.** C2 admin-create UX. Pure interactive prompt, or also accept `--admin-username` / `--admin-password` flags for CI? `--no-interactive` already skips today.
- **Q5.** C5 default service handling. Default to tearing down the service on logout (matches user mental model "log me out"), or default to keeping it (matches "service-install is a separate concern")?

## 7. Out of scope (recorded for later)

- `first-tree-hub profile` multi-account UX.
- Per-profile launchd/systemd unit names.
- Multi-org login UI (let the user pick which membership to use).
- Cross-Hub federation / multi-Hub credential management.
- Self-service registration / signup flow.
- Email-invite / link-invite for new members (today admin creates member + hands password offline).
