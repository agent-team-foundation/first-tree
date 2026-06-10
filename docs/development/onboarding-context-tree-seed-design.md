# Onboarding → build Context Tree from source repos (design)

Status: proposed · Date: 2026-06-10 · Depends on: PR #923 (`feat/context-tree-initializer`), enabled-by PR #925 (W1 tree verify on clean checkouts)

## 1. Goal

After a user creates their first agent during onboarding, the **new-tree**
path should actually result in a Context Tree that is **seeded from the bound
source repos** by that agent, using the `first-tree-seed` skill — asynchronously,
without blocking the agent from handling other chats, and as a natural part of
onboarding (the user does not babysit it).

## 2. Current state (verified in code)

The onboarding kickoff already *intends* this, but the new-tree path is broken
end to end. Three concrete gaps:

- **断点1 — WITHDRAWN after implementation review.** The original concern
  ("`runKickoff` drops `gitRepoUrls`, so sources never materialize") was based on
  the stale "gitRepos lives in agent config" model. In the current code: (a) the
  config PATCH endpoint **rejects** writing `gitRepos`
  (`config-service.ts` → `legacy_resource_config_disabled`); (b) the runtime
  `gitRepos` is **derived** from the agent's *effective resources*
  (`resources.ts` `resolveRuntimeConfig`), and a `recommended` **team** repo
  resource is `mode:"enabled"` for every org runtime agent by default; (c)
  `runKickoff` **already** creates the admin's selected repos as `recommended`
  team resources (the `orgWrites` block). So the admin new-tree agent's sources
  already flow → `prepareSourceRepos` materializes them, and creating those
  resources bumps the config version so the kickoff message refreshes the client
  config. **No gitRepos wiring is needed.** Residual gap: the invitee *picker*
  sub-state (invitee's own repos, never turned into resources) — an edge path,
  unrelated to new-tree seed; **deferred**, noted in the PR.

- **断点2 — on the new-tree path the seed skill is neither installed, surfaced,
  nor allowed.** The First-Tree family skills (incl. `first-tree-seed`) install
  and appear in the briefing **only when `contextTreePath !== null`**
  (`agent-briefing.ts:503`, `agent-bootstrap.ts:187`). A brand-new tree has no
  `org.context_tree` setting yet → `contextTreePath` is null → the agent is told
  *"binding a tree is an operator action, surface to a human"*
  (`agent-briefing.ts:475`). The kickoff prose also names a non-existent
  "first-tree onboarding skill" (`bootstrap-prose.ts`).

- **断点3 — seed assumes Cloud provisioned first; cloud layout doesn't match
  W1.** `first-tree-seed` refuses unless `.first-tree/workspace.json`
  (`{ tree, sources }`) exists, the tree is empty, and all sources are on disk
  (`skills/first-tree-seed/SKILL.md` self-check). In cloud the tree is cloned to
  a **separate** dir (`context-tree-repos/<hash>/`, not a workspace sibling),
  sources live under the agent home, and **no `.first-tree/workspace.json` is
  ever written** (only the local CLI `migrate-workspace` writes it).

Async note: a single agent already runs up to **5 concurrent sessions**
(`runtime/config.ts`), per-chat isolated, with "working" state protected up to
65 min. The seed task runs in the kickoff chat's own session; other chats stay
responsive. Onboarding itself does not block — kickoff stamps `completed`
right after sending the message. **No new background-task system is needed.**

## 3. Dependency: PR #923 (Cloud provisioning primitive)

`POST /api/v1/orgs/:orgId/context-tree/initialize` (admin-only) creates a
private GitHub repo via the **GitHub App ORG installation token**
(`POST /orgs/{org}/repos` — `createOrganizationRepo`), writes a **title-only
root `NODE.md`** (deliberately within `first-tree-seed`'s "placeholder root
counts as empty" carve-out), and persists `org.context_tree = { repo,
branch:"main" }`. Surfaced today only in Settings and `/context` unavailable
state — **not** wired into onboarding.

> Correction (verified against the *merged* #923, which changed after the
> initial review): the repo is created through the **org installation token**,
> not the signed-in user's OAuth token. The endpoint hard-requires an
> **Organization** installation with `repositorySelection: "all"` and the App's
> `Administration: write` + `Contents: write` repository permissions, and
> returns distinct status codes when those aren't met:
> - `409 organization_installation_required` — installation is a personal/User
>   account (so **personal-account users cannot use one-click new-tree** — a
>   real constraint of the Cloud-provision choice);
> - `409 selected_repositories_unsupported` — installed on selected repos only;
> - `403 installation_permissions_insufficient` — missing admin/contents write;
> - `503 no_installation` — no installation connected;
> - `409 ConflictError` — `org.context_tree` already set.

This resolves the architecture fork: **Cloud provisions the empty tree repo +
org binding; the agent seeds content.** This task builds on #923; it does not
add agent-driven repo creation.

## 4. Decisions (confirmed with owner)

1. **Cloud-provisions, single path** (build on #923). Agent-driven repo
   creation (the "variant G" host-`gh` fallback) is **dropped** — onboarding
   always provisions via `POST …/context-tree/initialize`. Owner accepted the
   external-customer trade-off this implies (see O3 below): the shared GitHub
   App must hold repo **Administration: write**, which every customer authorizes.
2. **Gap④ = Option A:** the cloud runtime makes the agent home a real W1
   workspace and writes `.first-tree/workspace.json`, so the skills stay
   layout-agnostic (no per-skill cloud branch, seed's self-check stays a real
   guard). The tree is exposed as a **sibling symlink** under the agent home
   pointing at the shared external clone, preserving the cross-agent dedup
   sharing.
3. **Timing = lazy re-resolution**, implemented at a single point in
   `SessionManager` (not the kickoff-UX reordering alternative). See §5.3.

## 5. Design

### 5.1 Web / onboarding

- **No gitRepos write (断点1 withdrawn).** Sources already flow to the admin
  agent via the `recommended` team repo resources `runKickoff` creates; the
  config PATCH would reject a `gitRepos` write anyway. See §2.
- **Provision the tree for new-tree mode.** Call `provisionNewTree(orgId)` in
  `runKickoff`, gated on `treeMode === "new" && orgWrites?.organizationId`,
  BEFORE the chat is created. The helper calls `initializeContextTree` and, on a
  409, **discriminates by actual binding state** — not the status code, since
  the "already configured" `ConflictError` carries no discriminating `code`: if
  a tree now exists (`getContextTreeSetting().repo`), provisioning effectively
  succeeded → proceed; otherwise re-throw. This correctly handles BOTH the
  genuinely-already-provisioned case (detect→create race, or a retry after a
  later kickoff step failed — no confusing dead-end) AND the merged endpoint's
  other 409s (`organization_installation_required` /
  `selected_repositories_unsupported` mean *no tree was created* → re-throw the
  actionable error). Every non-409 error (e.g. `403`) propagates unchanged;
  nothing is half-created on failure (no chat yet). `AdminKickoff` also
  auto-detects an existing `context_tree` at form time and switches to the bind
  path, so this only fires when no tree was detected. *(Review-evolved: the
  initial draft swallowed all 409s, then re-threw all 409s; the state-check is
  the correct middle ground.)*
- **Fix BOTH kickoff prose builders (`bootstrap-prose.ts`).**
  - *New-tree* (`buildCreateBootstrap`): point the agent at `first-tree-seed`,
    framed as *"the tree repo is already provisioned — read your tree, then seed
    it from the bound source repos"* (drop "create the GitHub repo yourself /
    record the URL on the Hub").
  - *Bind / existing-tree* (`buildBindBootstrap`, O1): the W1 binding
    (`workspace.json`) is now written automatically by the runtime, so the agent
    no longer "binds the repo + opens a PR back to source." Its task reduces to
    *read the tree (`first-tree-context`) and, if warranted, reflect the new
    source into it.* Remove the manual-bind framing and the non-existent
    "first-tree onboarding skill" name.
  - 409 from `initialize` (tree already exists) is treated as success (O4);
    `AdminKickoff` already auto-detects an existing tree and switches to the
    bind path, so `initialize` only fires in new-mode with no existing tree.

### 5.2 Client runtime (Option A: W1 conformance + workspace.json)

Centralize in `ensureAgentBootstrap` (already per-session, already holds
`contextTreePath` + `currentSourceRepoNames`):

- When `contextTreePath !== null`:
  1. Ensure a stable sibling symlink `<workspace>/<TREE_DIR>` → `contextTreePath`
     (`TREE_DIR` = a fixed reserved name, e.g. `context-tree`; guard against
     collision with a source `localPath` of the same name).
  2. Write `<workspace>/.first-tree/workspace.json` =
     `{ tree: TREE_DIR, sources: [...currentSourceRepoNames] }`, validated with
     `workspaceManifestSchema` from `@first-tree/shared`. Idempotent — rewrite
     when tree/sources change.
- Reuse the shared schema + `WORKSPACE_MANIFEST_FILENAME` /
  `WORKSPACE_STATE_DIRNAME` constants; the client writes the file itself (it
  can't import the CLI's `writeWorkspaceManifest`).
- This is consistent with the codebase already treating `<agentHome>/.first-tree/`
  as active W1 state (see the withdrawn `v1-legacy-dot-first-tree` migration
  note in `workspace-migrations.ts`).

### 5.3 Timing — lazy re-resolution of an unbound tree

`contextTreeBinding` is resolved **once** at `AgentSlot.start()` and frozen into
`handlerConfig.contextTreePath`. A new tree set *after* the slot starts (the
onboarding case) is otherwise never picked up until a daemon restart.

Fix (corrected after review): **re-resolve at a single point in
`SessionManager.startNewSession`, before building `handlerCfg`** — not in each
handler (E1: `contextTreePath` is a per-handler const read at construction
[claude-code.ts:1372], and handlers are built per session, so patching
`this.config.handlerConfig` upgrades all three handlers for free). When
`handlerConfig.contextTreePath` is null, call `syncAgentContextTree(sdk)` (cheap:
dedup lock + clone cache) and **patch all three fields together**
(`contextTreePath` + `contextTreeRepoUrl` + `contextTreeBranch`, E2 — the
tree-write path uses `repoUrl`). Gate on "currently null" so the steady-state
path is untouched; the upgrade is monotonic and sticky for the slot's life.

The null→bound upgrade then **automatically** drives skill install + manifest
write: `ensureAgentBootstrap`'s existing `integrationNeverPinned` trigger
([agent-bootstrap.ts:150], G1) forces the full bootstrap whenever a
previously-tree-less agent first sees a non-null `contextTreePath` — no new
trigger condition needed.

Result for new-tree onboarding: kickoff sets `gitRepos` + provisions the tree +
sends the seed message → the kickoff message starts a session → config refresh
materializes sources, the now-non-null tree binding is resolved, family skills
install, briefing lists `first-tree-seed`, workspace.json is written → seed's
self-check (workspace.json present, tree empty placeholder, sources on disk)
passes → seed runs.

### 5.4 Async / non-blocking

No new machinery. Seed runs in the kickoff chat's session; the existing
5-concurrency + per-chat isolation keeps the agent responsive in other chats;
per-chat runtime state already lets the UI show "working" on that chat.

## 6. Out of scope (explicit)

- Server-side GitHub-App repo creation (Option B heavy path) — #923's user-OAuth
  approach supersedes it.
- A tree-destination picker UI (choose repo owner/name in onboarding) — future
  polish; #923 names the repo after the team.
- Rewriting `first-tree-seed`'s phased workflow — only the trigger preconditions
  are now satisfiable; the skill body is unchanged.

## 7. Testing

- **Web:** unit tests that `runKickoff` (new-tree) calls `updateAgentConfig`
  with the selected repos and `initialize` before sending the bootstrap; prose
  builder snapshot updates. UI test of the kickoff step states via the
  onboarding preview gallery.
- **Client runtime:** unit tests for the workspace.json writer + tree symlink
  (idempotent, collision guard, schema-valid) and for lazy re-resolution
  (null → bound upgrade installs skills + writes manifest; already-bound path
  unchanged). Cross-check the family-skill list test still passes.
- **Server:** rely on #923's initialize tests; add coverage only if we touch the
  endpoint.
- `pnpm check && pnpm typecheck && pnpm test`.

## 8. Open items / risks

- **O3 — GitHub App ORG-installation prerequisites (deployment-gated).** Because
  the merged endpoint creates the repo with the **org installation token** (see
  §3 correction), the prerequisites are on the installation, not a user OAuth
  token:
  - the App's repository permissions must include **`Administration: write`**
    (governs repo creation) **and `Contents: write`** (to write the root
    `NODE.md`) — owner reports Administration was set to write ✅; **verify
    `Contents: write` too**;
  - the team must install the App on a GitHub **Organization** with
    **all repositories** (not a personal account, not selected repos);
  - existing installations are re-prompted to accept new permissions; the change
    applies to future installs.
  #923's unit tests inject a mock `fetcher`, so green CI does NOT prove the live
  App can create repos — **smoke-test the real flow** (org install, all repos)
  and confirm a 201 + real private repo before relying on it. **Known
  constraint:** personal-account users get `409 organization_installation_required`
  and cannot use one-click new-tree — the kickoff now surfaces that actionable
  error (re-throw) instead of silently sending a broken seed message.
- **O2 — provider:** `first-tree-seed` is a Claude-Code-shaped skill; onboarding
  picks `runtimeProvider` (claude-code preferred, else codex). This PR validates
  the claude-code path; codex seeding is out of scope / flagged, not assumed.
- **Dependency #923 must merge (or base on its head).** Branch strategy: base on
  #923's head so the full flow is locally testable; rebase onto main when #923
  merges.
- **TREE_DIR naming / symlink portability** across the handlers' cwd
  conventions — covered by tests.
