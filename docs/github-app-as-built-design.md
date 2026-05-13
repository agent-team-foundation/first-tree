# GitHub App Migration: As-Built Design

> **🔮 = deferred to the webhook PR** (a separate owner). Everything else shipped in **PR-322** (foundation) + **PR-323** (sign-in + UI); §2 has the per-decision / per-subsystem breakdown. References to "design doc §X" mean `docs/github-app-design-zh.md` (the upstream proposal on PR #295).

---

## 1. Problem & Motivation

### 1.1 Legacy setup (what is being removed)

Hub previously connected to GitHub through a pair of unrelated surfaces:

1. **OAuth App** — separate `clientId` / `clientSecret` for sign-in only. Issued never-expiring
   user-OAuth access tokens persisted in `auth_identities.metadata.accessToken`.
2. **Per-org webhook configuration** — each Hub team had its own row in
   `organization_settings` under namespace `github_integration`, holding an AES-encrypted
   `webhookSecretCipher` and an "allowed org" gate. The webhook URL was
   `POST /api/v1/webhooks/github/:orgId` (path-routed to the org).

The scheme worked but had three structural problems:

| Problem | Consequence |
|---|---|
| **Two GitHub identities to provision and rotate.** Operator had to register an OAuth App *and* configure webhooks per-repo for every customer org. | High setup friction; secret-rotation runbook had two surfaces; no single "off switch". |
| **Webhook secret stored per-org, encrypted at the application layer.** | Many secrets in the DB; key-rotation required re-encrypting every row; HMAC-key-leak blast radius was the entire `github_integration` namespace. |
| **No server-to-server identity for Hub to act on the user's repos.** Push-back / write actions (Phase 4 identity convergence) would have needed a *third* surface — a Personal Access Token per user, with manual scope juggling. | Future write features blocked behind a manual onboarding step. |

The OAuth-App + per-repo-webhook model also conflated *authentication* (who is this user) with
*ingress* (which repo just changed) — they share no identity, no rotation cycle, no operator surface.

### 1.2 Design goals

Replace the legacy OAuth-App + per-repo-webhook scheme with a **single GitHub App per Hub deployment**. The design targets:

1. **One credential surface, not three.** A GitHub App simultaneously provides user-OAuth for sign-in, webhook ingress (one endpoint, one HMAC secret), and server-to-server installation tokens. The operator provisions and rotates one thing — not an OAuth App + a per-org webhook secret + (eventually) a per-user PAT.

2. **Per-deployment config, not per-org.** The webhook secret moves from `organization_settings.github_integration.webhookSecretCipher` (one encrypted row per org) to a single env var. Webhook routing becomes a reverse-lookup on `installation.id → hub_organization_id` instead of URL-path routing. Org-level state shrinks to one binding row per org (`github_app_installations.hub_organization_id`).

3. **Combined sign-in + install in one redirect** (D1). First-time users authorize the App and install it in a single GitHub round-trip; returning users just re-authorize. No second redirect for the install.

4. **A foundation for future write-back.** The App mints installation tokens (1 h, scoped to the installed account's repos), available for Phase 4 identity convergence (`members:read` is already requested) and any future "Hub posts to GitHub" feature. The legacy model had no server-to-server identity at all.

5. **Lands in two phases, different owners.** Originally one PR (the closed PR-300); shipped as two:
   - **Phase 1 — sign-in + UI** (PR-322 + PR-323, both merged): GitHub App schema + service primitives; `/auth/github` rewritten to the App flow; Settings panel + admin API; auth-side legacy removal (the OAuth-App helpers, the `oauth.github` config block, the old webhook-secret Settings panel).
   - **Phase 2 — webhook + cleanup** (a separate PR, picked up by a different owner): the `/api/v1/webhooks/github` ingress endpoint + dispatch; webhook-side legacy removal (the per-org `/webhooks/github/:orgId` route, the `github_integration` namespace, migration `0038`).

   Until Phase 2 lands, `main` is in a short-lived, *safe* intermediate state — sign-in already uses the App, but the App's webhook URL has no handler yet (it just 404s; nothing is broken). Provisioning the App is a prerequisite to merging PR-323 — the six App env vars must be set before deploy, or sign-in returns 503. No customer is affected (the SaaS deployment isn't GA).

---

## 2. Decision Summary

Two groups: **§2.1** is the system shape — choices you can't change without redesigning; **§2.2** is the robustness / security hardening (mostly codex-review-driven) — implementation choices that make the shape safe, swappable in principle. D-numbers are stable identifiers cross-referenced from §4 / §6 / §7; the grouping just partitions them.

Status legend: ✅ shipped in PR-322 / PR-323 · 🔮 deferred to the webhook PR.

### 2.1 Architectural decisions (the system shape)

| # | Decision | Status | Rationale | Refs |
|---|---|---|---|---|
| **D1** | One GitHub App = one combined OAuth + install dialog. First-time installer gets `code + state + installation_id`; returning user gets `code + state`. | ✅ PR-323 | Single redirect; the App's "Request user authorization (OAuth) during installation" toggle is what makes this work. Avoids a second redirect for the install. | `services/github-app.ts:388-395`, `api/auth/github.ts:90-94` |
| **D2** | **1:1 binding** between a GitHub installation and a Hub team. Re-binding a different team to the same installation, or a different installation to the same team, is refused with `ConflictError`. | ✅ PR-322 (schema + service) + PR-323 (callback) | Avoids the multi-tenancy hairball where one webhook delivery would have to fan out to N orgs. The 1:1 invariant is enforced at three layers: `UNIQUE(installation_id)`, `UNIQUE(hub_organization_id)`, and a race-safe conditional UPDATE (D8). | `db/schema/github-app-installations.ts:97-100`, `services/github-app-installations.ts:145-213` |
| **D3** | **Per-deployment webhook secret**, not per-org. Single env var `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET`; the per-org `webhookSecretCipher` in `organization_settings.github_integration` goes away. | 🔮 webhook PR (env var declared in PR-322 but unused until the webhook handler consumes it; the legacy `webhookSecretCipher` deletion + migration `0038` ship with the webhook PR) | One secret to rotate; webhook routing is reverse-lookup on `installation.id` (D5), not URL path. Removes the entire app-layer-encrypted-webhook-secret surface. | `boot-guards.ts:31-87` (declared now), `drizzle/0038_drop_github_integration_namespace.sql` (webhook PR) |
| **D4** | **Mention-only routing** for content webhooks. Issues / PR / discussion events fan out only when the body / structural-mention field names an `@username` of a Hub agent with `delegate_mention` configured. All other content events 200-ack with no side effect. | 🔮 webhook PR | Aligns with the entity-clustering work in #304 (main). Avoids "noisy webhook" — Hub doesn't model every issue as a chat; only delegate-mentioned ones spawn one. | `api/webhooks/github-app.ts:200-215`, `api/webhooks/github.ts:431-440` |
| **D5** | **Webhook routing via reverse-lookup** of `installation.id` → `hub_organization_id` (not via URL path). | 🔮 webhook PR | Single tenant-wide URL means GitHub's "Webhook URL" field on the App settings page points to one place. `installation.id` is GitHub's stable routing key. | `api/webhooks/github-app.ts:174-198` |

### 2.2 Robustness & security decisions (mostly codex-review-driven)

| # | Decision | Status | Rationale | Refs |
|---|---|---|---|---|
| **D6** | **Webhook for an unbound install → 503 (not 200), and do NOT claim the delivery for dedup.** | 🔮 webhook PR | The race window between `installation: created` and the OAuth-callback bind is real. A 200-ack would make GitHub stop redelivering and burn the event in `processed_events`; 503-without-claim lets GitHub redeliver after the bind lands. | `api/webhooks/github-app.ts:184-197` (codex P1-6) |
| **D7** | **Resolve the binding BEFORE claiming the delivery for dedup.** | 🔮 webhook PR | Same root cause as D6: claiming first means a "no-binding-yet" event is permanently marked processed. | `api/webhooks/github-app.ts:165-200` |
| **D8** | **Race-safe `bindInstallationToOrg` via conditional UPDATE.** Two concurrent callbacks for the same unbound installation cannot both succeed; the loser sees 0 rows updated and gets a structured error. | ✅ PR-322 | TOCTOU was real with the prior SELECT-then-UPDATE shape. Postgres row-lock + `WHERE hub_org IS NULL OR hub_org = $target`; catches `23505` on the inverse case (the org already has a *different* install). | `services/github-app-installations.ts:112-213` (codex P0-3 + H2) |
| **D9** | **Authorize the `installation_id` query parameter against `/user/installations` before binding.** | ✅ PR-323 | `installation_id` arrives in the user's browser address bar — not a secret, not signed. Without this, any signed-in user could append `?installation_id=<other org's ID>` and bind another team's install to their own Hub team (the App JWT has read access to every install). | `api/auth/github.ts:155-193` (codex P0-2), `services/github-app.ts:184-215` |
| **D10** | **`targetOrganizationId` rides inside the signed state JWT** when the install was kicked off from an org's Settings panel; re-checked in the callback against the live membership. | ✅ PR-322 (state JWT shape) + PR-323 (callback re-check) | Without it, an admin in org B installing the App would have the install bound to whichever org the callback resolved to (typically primary, ie wrong). The state JWT outlives membership revoke; the callback re-validates admin status on the live `members` row. | `services/oauth-state.ts:30-66`, `api/auth/github.ts:394-407` (codex P1-3) |
| **D11** | **Boot guards run in `buildApp`, not `index.ts`** — so the CLI server-start path is covered, not just the standalone bin. | ✅ PR-322 | `packages/command/src/core/server.ts → buildApp` was bypassing the production-config checks that lived in `index.ts`. Internal plumbing, not an architectural choice — listed here so the reviewer knows where the checks fire. | `boot-guards.ts:7-18`, `app.ts:144-150` (codex P1-8) |
| **D12** | **Half-configured App is a hard boot failure.** All five App env vars must be set together (each `.min(1)`); five-empty disables the block; partial trips `throw new Error`. | ✅ PR-322 | An empty webhook secret is silently catastrophic — `createHmac("sha256", "")` is a hash any attacker can reproduce. The Zod `.min(1)` is the primary defense; the boot guard is belt-and-braces. | `shared/src/config/server-config.ts:109-138`, `boot-guards.ts:31-87` |
| **D13** | **Orphan-install reclaim on every sign-in** when the GitHub account matches the signing-in user. | ✅ PR-322 (service helper) + PR-323 (callback sweep). The Settings "Claim install" picker UI is tracked in [first-tree-hub#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318), not yet shipped. | If the OAuth callback inserted the install row but the bind step failed, the row sits unbound forever — GitHub only sends `installation_id` on the *initial* install. The sweep auto-claims the single-orphan case; multi-orphan currently requires the operator to POST `/claim` directly. | `services/github-app-installations.ts:340-366`, `api/auth/github.ts:462-496` (codex P1-5 + H1) |
| **D14** | **`/dev-callback` requires explicit env opt-in** (`FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1`), on top of `NODE_ENV !== "production"`. Returns 404 (not 403) on either gate fail. | ✅ PR-323 | A misconfigured staging deploy with `NODE_ENV` unset would otherwise leak the bypass. 404 is intentional — it doesn't confirm the route exists. | `api/auth/github.ts:223-251` (codex P1-9) |
| **D15** | **Out-of-order safety on suspend / unsuspend / delete** via timestamp guards (suspend uses the payload timestamp; delete relies on GitHub minting a fresh `installation.id` per install). The earlier 60-second `createdAt`-based delete grace was reverted — it made install + immediate uninstall permanent. | ✅ PR-322 (service primitives). The webhook handler that calls `markInstallationSuspended` / `markInstallationUnsuspended` with payload timestamps lives in the webhook PR. | GitHub doesn't guarantee delivery order and redelivers on failure. Conditional UPDATEs filter stale events instead of relying on receive-order. A stale `delete` for id N can't corrupt a fresh re-install (id M ≠ N). | `services/github-app-installations.ts:221-302` (codex P1-7) |

---

## 3. Architecture Overview

### 3.1 New components (server)

```
packages/server/src/
├── api/
│   ├── auth/github.ts                          # OAuth callback (rewritten)
│   ├── orgs/github-app.ts                      # Admin API: GET install, install-url, claim
│   └── webhooks/
│       ├── github-app.ts                       # NEW: App webhook endpoint
│       └── github.ts                           # Trimmed to shared helpers (HMAC verify, mention-routing)
├── services/
│   ├── github-app.ts                           # NEW: App JWT, install token, user-token refresh, OAuth helpers
│   ├── github-app-installations.ts             # NEW: install state machine + bind + orphan reclaim
│   ├── oauth-state.ts                          # Extended: optional targetOrganizationId in state JWT
│   └── auth-identity.ts                        # Extended: token bundle now includes refresh + expiries
├── db/schema/github-app-installations.ts       # NEW: Drizzle schema
├── drizzle/0037_github_app_installations.sql   # NEW: table + indexes + FK
├── drizzle/0038_drop_github_integration_namespace.sql  # NEW: D3 cleanup
└── boot-guards.ts                              # NEW: extracted from index.ts
```

### 3.2 New components (web + shared)

```
packages/shared/src/schemas/github-app.ts              # NEW: shared DTO + token-metadata + claim body schemas
packages/web/src/api/github-app.ts                     # NEW: SPA client (GET install, GET install-url)
packages/web/src/pages/github-app-installation-panel.tsx  # NEW: Settings panel; replaces github-integration-panel
```

### 3.3 OAuth + install flow (sequence)

```
Browser            Hub Server                   GitHub
   │                   │                           │
   │ GET /auth/github/start ──────────────────────►│
   │                   │ signOAuthState (sets cookie + signs JWT)
   │ ◄── 302 to https://github.com/login/oauth/authorize?client_id=…&state=<jwt>
   │                                               │
   │ ─── GitHub renders combined OAuth + install ──►│ (first install only)
   │ ◄── 302 to /api/v1/auth/github/callback?code=<>&state=<jwt>&installation_id=<id>?
   │                   │
   │ ─── GET /callback ───────────────────────────►│
   │                   │ verifyOAuthState (cookie nonce + signature)
   │                   │ exchangeCodeForAppUserProfile  ─────►│
   │                   │ ◄──── access + refresh + profile ───│
   │                   │ if installation_id:                 │
   │                   │   listUserAccessibleInstallationIds ►│  (D9)
   │                   │   ◄── set of allowed IDs ───────────│
   │                   │   if installation_id ∈ allowed:
   │                   │     createAppJwt + fetchInstallation►│
   │                   │     ◄── installation metadata ──────│
   │                   │     upsertInstallationFromMetadata
   │                   │ findOrCreateUserFromGithub
   │                   │ resolve membership (invite / target / primary / fresh personal)
   │                   │ if installation_id + resolvedOrg:
   │                   │   bindInstallationToOrg              (D8)
   │                   │ orphan-reclaim sweep                 (D13)
   │                   │ signTokensForUser
   │ ◄── 302 to /auth/github/complete#access=…&refresh=…&next=…&joinPath=…
```

### 3.4 Webhook flow (sequence) — 🔮 deferred to webhook PR

> The sequence below describes the design intent the webhook PR will implement. It was prototyped end-to-end on `ship/pr-300-rollup` (the original PR-300 head before the split) and is preserved here as the architectural target. None of these handlers exist on `main` post-PR-322/323.

```
GitHub                     Hub Server (POST /api/v1/webhooks/github)
   │                           │
   │ ── installation: created ►│ HMAC verify (D3 single secret)
   │                           │ (event=installation → state-machine path)
   │                           │ tryClaim(deliveryId) — INSERT into processed_events
   │                           │ upsertInstallationFromMetadata
   │ ◄── 200 ───────────────── │
   │                           │
   │ ── issues: opened ───────►│ HMAC verify
   │                           │ shouldSilent? → 200 (no claim) (D4)
   │                           │ extractInstallationId from payload
   │                           │ findInstallationByGithubId
   │                           │   no row OR no binding? → 503 NO CLAIM (D6/D7)
   │                           │ row found + bound:
   │                           │   tryClaim(deliveryId)
   │                           │   action ∈ MENTION_ACTIONS[event]? else 200 handled=false
   │                           │   handleMentionDelegation(org, event, payload)
   │                           │     extractMentions + resolveTargetChat + sendMessage
   │ ◄── 200 ───────────────── │
```

### 3.5 Routing surface (after PR-322 + PR-323 merge; webhook PR pending)

| Route | Method | Auth | Purpose | Status |
|---|---|---|---|---|
| `/api/v1/auth/github/start` | GET | public | Mint state, redirect to GitHub OAuth+install authorize URL | ✅ PR-323 |
| `/api/v1/auth/github/callback` | GET | public (state JWT) | Verify state, exchange code, optionally bind install | ✅ PR-323 |
| `/api/v1/auth/github/dev-callback` | GET | gated by `NODE_ENV` + `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` | Skip GitHub round-trip for local dev | ✅ PR-323 |
| `/api/v1/webhooks/github` | POST | HMAC | App webhook endpoint (single tenant URL) | 🔮 webhook PR |
| `/api/v1/orgs/:orgId/github-app-installation` | GET | org admin (Class B) | Read installation bound to this org | ✅ PR-323 |
| `/api/v1/orgs/:orgId/github-app-installation/install-url` | GET | org admin (Class B) | Mint signed-state install URL + cookie | ✅ PR-323 |
| `/api/v1/orgs/:orgId/github-app-installation/claim` | POST | org admin (Class B) | Manually claim an unbound installation (API-only — Settings UI tracked in [#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318)) | ✅ PR-323 |

D3 cut — split across the two-stage rollout:

| Removed | When | Replacement |
|---|---|---|
| Legacy OAuth-App env vars (`FIRST_TREE_HUB_GITHUB_OAUTH_*`) + `oauth.github` config block + `services/github-oauth.ts` legacy helpers | ✅ PR-323 | GitHub App env vars (`FIRST_TREE_HUB_GITHUB_APP_*`) + `oauth.githubApp` config block + `services/github-app.ts` user-OAuth helpers |
| Web `github-integration-panel.tsx` | ✅ PR-323 | `github-app-installation-panel.tsx` |
| `POST /api/v1/webhooks/github/:orgId` | 🔮 webhook PR | `POST /api/v1/webhooks/github` (single, reverse-lookup) |
| `*` of namespace `github_integration` in `organization_settings` | 🔮 webhook PR (migration `0038`) | `github_app_installations` table + per-deploy webhook secret env var |

---

## 4. Detailed Design per Subsystem

### 4.a Authentication / sign-in flow

**Status:** ✅ shipped — route rewrite in PR-323; underlying `oauth-state.ts` / `github-app.ts` primitives in PR-322.

**Entry:** `packages/server/src/api/auth/github.ts:59-323`.

The flow is the standard OAuth dance with one twist: the *same* GitHub redirect can deliver an
install side-effect when the user installs the App during sign-in. The handler distinguishes
"install just happened" (callback carries `installation_id`) from "user signing in normally"
(no `installation_id`) and threads either case through the same downstream `completeOauthFlow`.

**State JWT (`services/oauth-state.ts:50-67`):**

```ts
export async function signOAuthState(
  jwtSecret: string,
  next: string,
  opts: SignOAuthStateOptions = {},
): Promise<{ token: string; nonce: string }> {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  // ...
  const claims: StatePayload = { nonce, next };
  if (opts.targetOrganizationId) claims.targetOrganizationId = opts.targetOrganizationId;
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
  return { token, nonce };
}
```

The state token carries the post-callback `next` path and (when applicable) the `targetOrganizationId`
the install should bind to. The matching nonce rides in an HttpOnly cookie. Double-submit verification
in `verifyOAuthState` requires both: signature must verify *and* cookie nonce must equal
`payload.nonce`. A login-CSRF where the attacker pre-signs `start` with their own GitHub account is
defeated because the victim's browser carries no cookie set by the attacker's `start`.

**Callback dispatch (`api/auth/github.ts:97-221`):**

1. If GitHub App not configured → 503.
2. Parse `code`, `state`, optional `installation_id`. Verify state. Clear the state cookie (single-use).
3. Exchange the code via `exchangeCodeForAppUserProfile`. Encrypt access + refresh tokens with
   `services/crypto.encryptValue` (AES-256-GCM). Persist expiries verbatim.
4. **D9 authorization:** if `installation_id` is present, call
   `listUserAccessibleInstallationIds` — wraps `GET /user/installations` with the user-access-token.
   If the installation_id is not in that set, drop it (and log `github_app.installation_id_unauthorized`).
   Failing closed: any error during this check also drops the installation_id.
5. If `installation_id` is still set, mint an App JWT, fetch installation metadata, UPSERT row.
6. Hand off to `completeOauthFlow`.

**`completeOauthFlow` (`api/auth/github.ts:325-511`):**

Resolves the user's Hub team in priority order:

| Priority | Source | Trigger | Notes |
|---|---|---|---|
| 1 | Invite redemption | `next` matches `/invite/<token>` | Joins the inviting org as `inv.role`. Drops the `next` to `/`. |
| 2 | Signed `targetOrganizationId` | Install initiated from Settings | Re-checks active admin membership; 403 if not. Preserves caller's `next`. |
| 3 | Existing primary membership | User has any active membership | Most-recent-joined wins. Preserves `next`. |
| 4 | Fresh personal team | None of the above | Mints `${login}'s team` org + admin membership + 1:1 human agent. |

After membership resolves, `bindInstallationToOrg(installationId, resolvedOrgId)` is attempted (no-op
if no `installation_id`). Failures are logged; sign-in continues. The orphan-reclaim sweep then runs
(D13).

Final response: `302 /auth/github/complete#access=…&refresh=…&next=…&joinPath=…`. The fragment
delivery model means the SPA bootstraps the tokens client-side; the server never echoes them in a
URL the proxy or referrer log can capture.

### 4.b Installation lifecycle

**Status:** ✅ shipped — the state-machine primitives in `services/github-app-installations.ts` (PR-322). The webhook handler that *invokes* them on `installation:*` events is 🔮 webhook PR.

**State machine (`services/github-app-installations.ts`):**

| Event | Operation | DB effect |
|---|---|---|
| `installation: created` | `upsertInstallationFromMetadata` | INSERT or UPDATE-by-`installation_id`; never touches `hub_organization_id` |
| `installation: new_permissions_accepted` | `upsertInstallationFromMetadata` | Same as `created` (re-snapshots permissions/events) |
| `installation: suspend` | `markInstallationSuspended(suspendedAt)` | Sets `suspended_at` only if currently NULL or older — out-of-order safe |
| `installation: unsuspend` | `markInstallationUnsuspended(unsuspendedAt)` | Clears `suspended_at` only if it predates the receive time — out-of-order safe |
| `installation: deleted` | `deleteInstallationByGithubId` | Hard DELETE by `installation_id`; no grace window |
| `installation_repositories: added/removed` | `upsertInstallationFromMetadata` | Re-snapshots `events` / `permissions` blocks. Per-repo children table is not yet modeled (deferred). |

**Out-of-order suspend/unsuspend (`services/github-app-installations.ts:231-272`):**

```ts
await db
  .update(githubAppInstallations)
  .set({ suspendedAt, updatedAt: new Date() })
  .where(
    and(
      eq(githubAppInstallations.installationId, installationId),
      or(isNull(githubAppInstallations.suspendedAt), lt(githubAppInstallations.suspendedAt, suspendedAt)),
    ),
  );
```

Stale `suspend` re-suspending an active row is filtered by the `lt(...)` clause; stale `unsuspend`
arriving after a newer `suspend` is filtered by `< unsuspendedAt`. Documented limitation: once
`unsuspend` clears the column to NULL, the system loses the original suspend timestamp, so a stale
`suspend` arriving after that point would re-suspend. Real-world risk is low — suspend/unsuspend are
human actions minutes apart, well outside any realistic reorder window.

**Delete handling (`services/github-app-installations.ts:300-302`):** hard DELETE by `installation_id`,
no grace window — see D15 for why the earlier 60-second `createdAt`-based grace was reverted. Residual
hole (stale `created` after `deleted` resurrects the row) is tracked as follow-up #314.

### 4.c Installation binding model (1:1 hub_org ↔ install)

**Status:** ✅ shipped — schema + `bindInstallationToOrg` in PR-322; the OAuth callback that calls it in PR-323.

**Binding invariant** (D2): each `installation_id` binds to at most one `hub_organization_id`, and
each `hub_organization_id` holds at most one installation. Three enforcement layers:

1. **`UNIQUE(installation_id)`** — duplicate webhook deliveries can't insert a second row for the same install.
2. **`UNIQUE(hub_organization_id)` (NULLs distinct)** — a Hub team can have only one bound install; Postgres' NULL-distinct semantics lets multiple unbound rows coexist (orphan-reclaim path).
3. **Race-safe `bindInstallationToOrg`** — a conditional UPDATE serialized via row-lock (replaced the original TOCTOU-prone SELECT-then-UPDATE; codex P0-3, with H2 adding the inverse case).

**Race-safe bind (`services/github-app-installations.ts:145-213`):**

```ts
const result = await db
  .update(githubAppInstallations)
  .set({ hubOrganizationId, updatedAt: new Date() })
  .where(
    and(
      eq(githubAppInstallations.installationId, installationId),
      or(
        isNull(githubAppInstallations.hubOrganizationId),
        eq(githubAppInstallations.hubOrganizationId, hubOrganizationId),
      ),
    ),
  )
  .returning({ id: githubAppInstallations.id });
// updatedCount === 0 → either no row exists or row is bound elsewhere → SELECT to disambiguate
// 23505 catch → another row already binds the target org (H2)
```

The Postgres rowlock on the conditional UPDATE serializes concurrent callers. The loser sees
`updatedCount === 0`, runs a SELECT to disambiguate `NotFoundError` from `ConflictError`, and
throws a structured error.

The 23505 catch handles the inverse: this row's binding succeeds the WHERE filter, but the
`UNIQUE(hub_organization_id)` constraint rejects the write because a *different* row is already
bound to the same org.

Idempotent re-bind (same install → same org) is allowed and treated as a no-op (return value is
"true on any successful UPDATE"; tests assert state at the row level).

### 4.d Webhook ingress + dispatch — 🔮 deferred to webhook PR

> **The entire webhook subsystem ships in a separate PR with a different owner.** The design below was prototyped on `ship/pr-300-rollup` and is preserved here as the spec the webhook PR should implement. None of the routes / handlers / dispatch in this section exist on `main` post-PR-322/323 — the legacy `/api/v1/webhooks/github/:orgId` per-org route is still the live webhook surface until the webhook PR cuts it.
>
> File references in this section resolve only on the original `ship/pr-300-rollup` branch (preserved for design reference; not a maintained branch). The webhook PR may rewrite specifics but should preserve decisions D3 / D4 / D5 / D6 / D7 / D15 from the table above.

**Endpoint:** `POST /api/v1/webhooks/github` (single URL, deployment-wide).
**Implementation:** `packages/server/src/api/webhooks/github-app.ts`. HMAC verify reuses
`verifyGithubWebhookSignature` (`timingSafeEqual` over equal-length buffers; `UnauthorizedError` on
mismatch); body parsing uses a scoped `buffer`-mode JSON content-type parser to preserve the raw
bytes for HMAC — both the same pattern as the legacy per-org endpoint, only the secret source
differs.

**Dispatch order (`api/webhooks/github-app.ts:69-217`):**

1. **App not configured** → 501 (operator must set env vars).
2. **Missing `x-hub-signature-256` header** → 401.
3. **HMAC verify** → 401 on mismatch.
4. **JSON parse failure** → 400.
5. **Missing `x-github-event`** → 400.
6. **`event === "ping"`** → 200, no claim, no side effect. (GitHub fires this once on App webhook wire-up.)
7. **`shouldSilent(event, payload)`** → 200, no claim. Silent events: `workflow_run`, `check_run`,
   `push`, label noise, `sender.type === "Bot"`. Avoids burning rows in `processed_events` on
   net-zero events.
8. **Lifecycle events** (`installation`, `installation_repositories`):
   - `tryClaim(deliveryId)` against `processed_events` (claim-by-INSERT-ON-CONFLICT).
   - On claim conflict → 200 deduped.
   - Run state-machine handler.
   - On handler error → `unclaimEvent` then re-throw.
9. **Content events** (`issues`, `issue_comment`, `pull_request`, …):
   - **Resolve binding FIRST** (`extractInstallationId` → `findInstallationByGithubId`).
   - If no row OR `hubOrganizationId` is null → 503 (NOT 200; do NOT claim). GitHub redelivers on
     its own retry schedule. (D6/D7)
   - Missing `installation` block in payload → 200 routed=false (claiming is moot).
   - `tryClaim(deliveryId)`. On conflict → 200 deduped.
   - Action-gate via `MENTION_ACTIONS[eventType]`. Off-allowlist → 200 handled=false.
   - `handleMentionDelegation(org, event, payload)`. On error → unclaim + re-throw.

**Mention-only routing (`api/webhooks/github.ts:395-424`):**

```ts
export async function handleMentionDelegation(app, organizationId, eventType, payload) {
  const mentionText = extractEventText(eventType, payload);
  const textMentions = extractMentions(mentionText);
  const structuralMentions = extractStructuralMentions(eventType, payload);
  const mentions = [...new Set([...textMentions, ...structuralMentions])];
  if (mentions.length === 0) return 0;
  const ctx = extractEventContext(eventType, payload);
  if (!ctx) return 0;
  const entity = extractEventEntity(eventType, payload);
  if (!entity) return 0;
  const relatedRefs = (eventType === "pull_request" && ctx.repository.length > 0)
    ? parseFixesRefs(ctx.body, ctx.repository) : [];
  return routeMentionDelegations(app, organizationId, mentions, ctx, entity, relatedRefs);
}
```

For each `@mention` matching an agent with `delegate_mention` configured, the code resolves the
target chat via `resolveTargetChat` (entity-clustering rules from #304), posts a card from the
human-bound agent to the delegate, and triggers the `notifyRecipients` notifier. `pull_request:
review_requested` uses `extractStructuralMentions` because the reviewer is in
`requested_reviewer.login`, not in any text body.

**`MENTION_ACTIONS`** allowlist (action-gate) — mention scanning runs only on these
"new content" actions:

```ts
{
  issues: ["opened", "edited"],
  issue_comment: ["created"],
  pull_request: ["opened", "edited", "review_requested"],
  pull_request_review: ["submitted"],
  pull_request_review_comment: ["created"],
  discussion: ["created", "edited"],
  discussion_comment: ["created"],
  commit_comment: ["created"],
}
```

**Dedup table:** `processed_events(event_id, platform)` — pre-existing infra, reused as-is.
`claimEvent` does `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id`; claim succeeds iff no
prior delivery under the same `x-github-delivery` GUID + platform `"github-app"` was processed.

### 4.e Token model

**Status:** ✅ shipped — minting / refresh primitives in `services/github-app.ts` (PR-322); the OAuth callback's use of the user-token pair + the `/me/github/repos` refresh wiring in PR-323. (The installation token has no request-path consumer yet — Phase 4.)

The migration introduces three distinct GitHub credentials — only the user-OAuth pair lives on the row.

| Token | Lifetime | Storage | Purpose |
|---|---|---|---|
| **App JWT** (RS256, `iss=appId`) | ~9 minutes (capped at 10 by GitHub) | Not persisted; minted per request | Authenticates Hub-as-this-App to `/app/...` endpoints |
| **Installation token** (server-to-server) | ~1 hour | Not persisted; minted per request via App JWT | Acts on tenant repos. Currently unused in request paths (Phase 4) |
| **User access token** (user-to-server) | ~8 hours | `auth_identities.metadata.accessToken` (AES-256-GCM ciphertext) | OAuth user identity; used by `/me/github/repos` for the Step 2 onboarding repo picker |
| **User refresh token** | ~6 months, **rotated on every refresh** | `auth_identities.metadata.refreshToken` (ciphertext) | Slides the access token; persist the *new* one or the next refresh fails |

**App JWT minting (`services/github-app.ts:92-101`):**

```ts
export async function createAppJwt(creds: GithubAppCredentials): Promise<string> {
  const key = await importPKCS8(creds.privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(creds.appId)
    .setIssuedAt(now - APP_JWT_IAT_SKEW_SECONDS)  // 60s back-date for clock skew
    .setExpirationTime("9m")
    .sign(key);
}
```

PEM is re-imported on every call. Cost is microseconds; deliberate — avoids a global mutable cache
that would need locking under concurrent requests. If profiling ever shows this hot, callers can
memoize.

**User-token refresh (`services/github-app.ts:307-369`):**

```ts
export async function refreshAppUserToken(clientId, clientSecret, refreshToken, opts = {}) {
  const res = await fetcher("https://github.com/login/oauth/access_token", { ... });
  // ...
  if (body.error || !body.access_token || !body.refresh_token) {
    throw new GithubAppApiError(401, `… rejected: ${description}`);  // normalize 200-with-error to 401
  }
  if (typeof body.expires_in !== "number" || typeof body.refresh_token_expires_in !== "number") {
    throw new GithubAppApiError(500, "… missing expires_in fields — App likely has user-token expiration disabled");
  }
  // ... compute absolute expiries, return
}
```

Two normalization choices worth noting:

1. **200-with-`error` is normalized to `GithubAppApiError(401, ...)`.** GitHub returns 200 OK with
   `error: "bad_refresh_token"` in the body when the refresh token is malformed or already-rotated.
   The route layer's only sane response is "force re-login", so we surface as 401.
2. **Missing `expires_in` is a 500.** GitHub Apps must have "Expire user authorization tokens"
   enabled in the App's settings page. If the response omits the fields, the deployment is
   misconfigured — we'd otherwise persist a row that lies about TTL. Fail loud.

**Refresh wiring (`api/me.ts:182-277`):**

The `/me/github/repos` endpoint (Step 2 repo picker) is the only request path that currently
needs a guaranteed-fresh user token. Logic:

1. Decrypt stored `accessToken`. 503 on missing / decryption failure.
2. If the row carries `accessTokenExpiresAt` (App-flavoured) AND `expiresAt - 60_000 ≤ Date.now()`:
   - Decrypt refresh token. Call `refreshAppUserToken`. Encrypt + persist new pair.
   - GitHub rotates the refresh token on every refresh; the old one becomes `bad_refresh_token`.
3. On refresh failure: 401 from GitHub → 403 with `code: refresh_failed` ("Your GitHub session has
   expired"); other → 503 ("Couldn't refresh GitHub credentials").
4. Call `listUserRepos` with the (possibly fresh) access token.

Legacy rows (no expiry fields) skip refresh entirely — never-expiring OAuth-App tokens still work.

**Manual claim endpoint (`api/orgs/github-app.ts:146-176`)** uses `getStoredGithubAccessToken`
(no refresh) for the `/user/installations` admin check. Tolerates a stale token — the downstream
GitHub call surfaces a 401 which the route maps to "sign in again, then retry".

### 4.f Schema changes

**Status:** ✅ shipped — `github_app_installations` table (`0037`) + `auth_identities.metadata` shape in PR-322; the `0038` `github_integration`-drop migration is 🔮 webhook PR.

#### 4.f.1 `github_app_installations` (new)

```sql
CREATE TABLE IF NOT EXISTS "github_app_installations" (
  "id" text PRIMARY KEY NOT NULL,                                    -- UUID v7 (app-generated)
  "installation_id" bigint NOT NULL,                                 -- GitHub-issued install ID
  "account_type" text NOT NULL,                                      -- 'User' | 'Organization' (CHECK)
  "account_login" text NOT NULL,                                     -- mutable, refreshed on webhook
  "account_github_id" bigint NOT NULL,                               -- immutable account id
  "hub_organization_id" text,                                        -- nullable, FK ON DELETE SET NULL
  "permissions" jsonb NOT NULL,                                      -- granted permissions snapshot
  "events" jsonb NOT NULL,                                           -- subscribed events list
  "suspended_at" timestamp with time zone,                           -- non-null while suspended upstream
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_github_app_installations_account_type"
    CHECK ("account_type" IN ('User', 'Organization'))
);
ALTER TABLE "github_app_installations"
  ADD CONSTRAINT "github_app_installations_hub_organization_id_organizations_id_fk"
  FOREIGN KEY ("hub_organization_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "uq_github_app_installations_installation_id" ON "github_app_installations" ("installation_id");
CREATE UNIQUE INDEX "uq_github_app_installations_hub_org"        ON "github_app_installations" ("hub_organization_id");
CREATE INDEX        "idx_github_app_installations_account"        ON "github_app_installations" ("account_github_id");
```

Notable shape choices:

| Choice | Rationale |
|---|---|
| `bigint mode: "number"` for `installation_id` and `account_github_id` | GitHub assigns 64-bit IDs; current values are ~8 digits, safely below `Number.MAX_SAFE_INTEGER`. Avoids the bigint-string ergonomics tax. |
| `hub_organization_id` nullable | Allows the install row to be inserted before the user's Hub team is provisioned (fresh-signup flow). The orphan-reclaim sweep is the cleanup path. |
| `ON DELETE SET NULL` (not CASCADE) on `hub_organization_id` | The GitHub-side install still exists upstream when a Hub team is deleted. Keeping the row lets a future re-bind recover. |
| `UNIQUE(hub_organization_id)` (NULLs distinct) | Enforces D2 1:1 *and* tolerates multiple unbound rows. Postgres' default NULL-distinct semantics is what makes this work. |
| `CHECK (account_type IN ('User', 'Organization'))` | Defense-in-depth against a manual SQL bypass of the Drizzle column type. |
| No FK on `installation_id` | GitHub is the source of truth for that ID; nothing else in the schema references it. |

#### 4.f.2 `auth_identities.metadata` (extended shape)

The column itself is unchanged (already `jsonb`); the consumed shape grew. Pre-PR (legacy OAuth):

```jsonc
{
  "login": "octocat",
  "accessToken": "<AES-256-GCM ciphertext, never-expires OAuth token>"
}
```

Post-PR (App user-to-server):

```jsonc
{
  "login": "octocat",
  "accessToken": "<ciphertext, ~8h TTL>",
  "accessTokenExpiresAt": "2026-05-12T18:00:00.000+00:00",
  "refreshToken": "<ciphertext, ~6mo TTL>",
  "refreshTokenExpiresAt": "2026-11-12T10:00:00.000+00:00"
}
```

Service code MUST tolerate both shapes — absence of expiry fields = "still on legacy OAuth token,
skip refresh". Wire format owned by `githubAppUserTokenMetadataSchema` in `packages/shared/src/schemas/github-app.ts:78-89`.

#### 4.f.3 Dropped `github_integration` namespace

Migration `0038`:

```sql
DELETE FROM "organization_settings" WHERE "namespace" = 'github_integration';
```

No CREATE/DROP TABLE; `organization_settings` is the generic `(org_id, namespace) → JSONB` store.
The shared `ORG_SETTINGS_NAMESPACES` registry was trimmed in the same commit so any code path
still trying to read or write `github_integration` will fail at the service layer before reaching
the DB.

#### 4.f.4 Migration ordering

`0036` / `0037` shipped with PR-322; the rollup-branch commit `940ad5c` bumped their timestamps so
deployments that had run the old PR-300 layout still pick up the renamed `0036`. (Drizzle's pg
migrator dedups by `lastApplied.created_at < folderMillis` — no hash-based dedup — so renumbering
needed new timestamps strictly above the prior PR-300 max.)

| Migration | Purpose | Status / notes |
|---|---|---|
| `0036_github_entity_chat_mappings.sql` | Pre-existing #304 work, retimestamped | ✅ shipped (PR-322); required for entity-clustering chat resolution |
| `0037_github_app_installations.sql` | Create the new table + indexes + FK | ✅ shipped (PR-322); forward-only, no rollback path |
| `0038_drop_github_integration_namespace.sql` | DELETE legacy webhook config | 🔮 webhook PR; forward-only, data deletion irreversible |

> **`0038` numbering caveat:** this doc refers to the `github_integration`-drop migration as `0038` for continuity with the original PR-300 plan. After the split, `0038` on `main` was taken by an unrelated change (`0038_chat_membership_user_state`). The webhook PR will create the drop migration with whatever the next free index is at that time — treat every "`0038`" in this doc as a placeholder name for "the webhook-side `github_integration`-namespace-drop migration", not a literal file number.

### 4.g Configuration surface

**Status:** ✅ shipped — env-var block + boot guard in PR-322.

**Six new environment variables** (`packages/shared/src/config/server-config.ts:108-138`):

| Env var | Required | Min | Purpose |
|---|---|---|---|
| `FIRST_TREE_HUB_GITHUB_APP_ID` | yes (with the rest) | 1 | Numeric App ID from GitHub App settings page (issuer claim on App JWT) |
| `FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID` | yes | 1 | OAuth client ID for user-token exchange |
| `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET` | yes (secret) | 1 | OAuth client secret |
| `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY` | yes (secret) | 1 | RSA PKCS#8 PEM (multi-line) |
| `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` | yes (secret) | 1 | HMAC key for webhook signature verification |
| `FIRST_TREE_HUB_GITHUB_APP_SLUG` | optional within block | 1 | URL slug for `https://github.com/apps/<slug>` — only the install-URL endpoint needs it; absence yields 503 on that endpoint, doesn't block boot |

Plus one dev-only flag:

| Env var | Purpose |
|---|---|
| `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` | Must be `"1"` or `"true"` to enable `/dev-callback`. Enforced *in addition* to `NODE_ENV !== "production"` (D14). Vitest's setup script sets this so existing tests keep working. |

**Boot guards (`boot-guards.ts:31-87`):**

```ts
function assertGithubAppConfigComplete(config: Config): void {
  const ghApp = config.oauth?.githubApp;
  if (!ghApp) return;
  const required: Record<string, string | undefined> = {
    FIRST_TREE_HUB_GITHUB_APP_ID: ghApp.appId,
    FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID: ghApp.clientId,
    FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET: ghApp.clientSecret,
    FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY: ghApp.privateKeyPem,
    FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET: ghApp.webhookSecret,
  };
  const missing = Object.entries(required).filter(([, v]) => !v || v.trim().length === 0).map(([k]) => k);
  if (missing.length > 0 && missing.length < Object.keys(required).length) {
    throw new Error(`GitHub App is half-configured — missing env vars: ${missing.join(", ")}. Set all five or none.`);
  }
  if (missing.length === Object.keys(required).length) {
    throw new Error("GitHub App env block is present but every value is empty — unset…");
  }
  if (ghApp.privateKeyPem && !ghApp.privateKeyPem.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY does not look like a PKCS#8 PEM…");
  }
}
```

The Zod `.min(1)` on every field is the primary defense; the boot guard is belt-and-braces. The
PEM-shape sniff catches the common mistake of pasting only the body or leaving literal `\n`
sequences in single-line env files.

`assertBootConfigValid` is now called from `buildApp` (D11), so both server entry points (the
standalone bin and the CLI's `server start`) get the same checks.

---

## 5. Security Model

### 5.1 What's signed, what's verified, what's encrypted

| Surface | Mechanism | Notes |
|---|---|---|
| OAuth state JWT | HS256 (HMAC) with `jwtSecret` | 10-minute TTL; signature + cookie nonce double-submit (`oauth-state.ts:79-108`) |
| App JWT (Hub → GitHub) | RS256 with App private key | 9-minute TTL; 60s back-dated `iat` for clock skew (`github-app.ts:92-101`) |
| Webhook payloads | HMAC-SHA256 with `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` | `timingSafeEqual` over equal-length buffers (`github.ts:23-31`) |
| User access + refresh tokens | AES-256-GCM via `services/crypto.encryptValue` | Plaintext never touches the row; `accessToken`/`refreshToken` fields on `auth_identities.metadata` are ciphertext |
| Hub session JWTs | HS256 with `jwtSecret` | Same as pre-PR; unchanged |

### 5.2 Authorization boundaries

| Action | Required authorization |
|---|---|
| Bind installation to org during sign-in | (a) state JWT verified, (b) caller's GitHub user has access via `/user/installations` (D9), (c) if `targetOrganizationId` in state, caller is active admin of that org (D10) |
| Manual `/claim` install | (a) Class B admin of target org, (b) caller's GitHub access token confirms admin via `/user/installations` (mirrors D9) |
| Read installation panel (`GET /github-app-installation`) | Class B admin of target org |
| Get install URL (`GET /install-url`) | Class B admin of target org; mints state with the org as `targetOrganizationId` |
| Webhook ingress | HMAC verify only (no per-request authorization — every event lands at one endpoint) |

### 5.3 Attack surface (acknowledged)

Items the architect should evaluate explicitly:

1. **`installation_id` on the address bar is not a secret** (D9 mitigation). Any attempt to bind an
   installation goes through the `/user/installations` check; a failure of that check (network or 4xx)
   fails closed by dropping the installation_id and continuing sign-in.
2. **State JWT outlives membership revoke** (D10 mitigation). The 10-minute window is long enough
   for an admin role to be revoked between minting and consuming. The callback re-checks the live
   `members` row via `findActiveMembership` before honoring `targetOrganizationId`.
3. **Webhook secret is a single value across all tenants.** A leak compromises the webhook channel
   entirely; rotation is a one-step operator action (env-var swap + GitHub App settings update).
   Trade-off accepted vs. the per-org-cipher complexity.
4. **App private key is in `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`** as a PEM string. Boot guard
   sniffs the PEM header but does not verify the key. Compromise → impersonation of Hub-as-App for
   any installation. Secret-manager pattern is acknowledged as deferred (PR description §6 risk 4).
5. **`/dev-callback` mints arbitrary GitHub identities** if both gates pass. Gate 1 is `NODE_ENV`
   (default-deny if unset because anything ≠ `"production"` allows); Gate 2 is explicit env opt-in.
   Failure mode: an operator deliberately sets the env var in prod. There is no defense beyond the
   audit trail for this.
6. **App JWT has read access to every installation** by design. The D9 authorization is what
   prevents Hub from misusing it; the App private key is the trust root.
7. **`/user/installations` does not actually prove admin access** — open follow-up #312. GitHub's
   endpoint lists installations the user can administer in some contexts but the docs are weaker
   than the wording implies. The current implementation treats it as authoritative; a concerted
   attacker who can manipulate GitHub-side membership might forge an inclusion. P1 follow-up.

### 5.4 Logging / audit

Structured log markers worth grep-ing in production:

- `github_app.installation_id_unauthorized` — D9 hijack attempt blocked
- `onboarding.team_created` — fresh personal team minted at OAuth bootstrap
- `github app webhook for unbound installation — 503 so GitHub redelivers` — race window observed
- `multiple unbound installs match this account — skipping auto-claim` — D13 multi-orphan path

---

## 6. Edge Cases & Race Conditions Handled

| # | Scenario | Handling | Refs |
|---|---|---|---|
| **R1** | OAuth callback's `installation_id` is forged with another team's id | `/user/installations` check; drop the id on mismatch or check failure | `api/auth/github.ts:155-193` |
| **R2** | Webhook `installation: created` arrives before the OAuth callback completes the bind | Webhook returns 503 (no claim) → GitHub redelivers → bind has landed → next attempt succeeds | `api/webhooks/github-app.ts:174-198` |
| **R3** | Two concurrent OAuth callbacks for the same fresh install try to bind to different orgs | Conditional UPDATE: loser's WHERE filters out the freshly-set value; throws `ConflictError`. The Postgres rowlock serializes them | `services/github-app-installations.ts:155-183` |
| **R4** | Install metadata UPSERT lands but bind fails (transient DB error, racing invite) | Row is left unbound; orphan-reclaim sweep on next sign-in (matches by `accountGithubId`) auto-claims when there's exactly one orphan | `api/auth/github.ts:462-496`, `services/github-app-installations.ts:340-366` |
| **R5** | User signs in repeatedly with no `installation_id` (returning user) | Idempotent re-bind to the same org is a no-op (`bindInstallationToOrg` returns true; nothing changes). No call when `installationId === null` | `api/auth/github.ts:452-461` |
| **R6** | Stale `installation: suspend` arrives after a newer one | Conditional UPDATE on `WHERE suspended_at IS NULL OR suspended_at < new` — stale event matches 0 rows | `services/github-app-installations.ts:236-244` |
| **R7** | Stale `installation: unsuspend` arrives after a fresh `suspend` | Conditional UPDATE on `WHERE suspended_at < unsuspendedAt` — stale event matches 0 rows. Documented hole: once an unsuspend NULLs the column, the system loses the timestamp anchor for further ordering | `services/github-app-installations.ts:262-272` |
| **R8** | `installation: deleted` arrives, then a fresh re-install on the same account | GitHub mints a fresh `installation.id` per install, so the delete is for id N and the re-install is id M ≠ N. No collision. The 60-s grace window that existed in the C.12 commit was reverted because it made install + immediate uninstall permanent | `services/github-app-installations.ts:274-302` |
| **R9** | Webhook delivery retried by GitHub (same `x-github-delivery` GUID) | `processed_events(event_id, platform="github-app")` UNIQUE-on-INSERT short-circuits with deduped 200 | `api/webhooks/github-app.ts:128-141` |
| **R10** | Handler throws after claim succeeded | `unclaimEvent` deletes the claim row; the error re-throws so the route layer maps to 5xx; GitHub retries; next attempt re-claims | `api/webhooks/github-app.ts:142-149` |
| **R11** | Two concurrent OAuth sign-ins for the same GitHub `login` (slug collision) | `users.username` UNIQUE catches; retry with hex disambiguator (`auth-identity.ts:181-208`); same pattern for `organizations.name` (`membership.ts:159-182`) |
| **R12** | Webhook payload missing `installation` block on a non-lifecycle event | 200 routed=false reason=`no_installation`. Claiming is moot — nothing reprocesses an unroutable event. Logged as a payload bug | `api/webhooks/github-app.ts:174-182` |
| **R13** | App webhook arrives for an event type Hub doesn't recognize | If lifecycle: handled by the `default` case in `handleInstallationEvent` (logs + 200 ack so GitHub stops retrying). If content: action gate filters; off-allowlist returns 200 handled=false | `api/webhooks/github-app.ts:253-260, 207-210` |
| **R14** | User has multiple unbound installs on the same account | Sweep finds N>1; auto-claim is skipped to avoid guessing; logs `multiple unbound installs match this account`; Settings UI is supposed to surface a picker (deferred — #318) | `api/auth/github.ts:485-490` |
| **R15** | An admin in org B installs the App but the OAuth callback would default to their primary org A | `targetOrganizationId` rides in the signed state (set by `/install-url`); callback re-validates active admin on the live `members` row; refuses with 403 if revoked between mint and consume | `api/auth/github.ts:394-407` |

---

## 7. D3 Hard Cut

D3 ("no compatibility window between legacy and App surfaces") is split across the auth-side cut (PR-323, **shipped**) and the webhook-side cut (webhook PR, **deferred**). After PR-322 + PR-323 merge, the legacy webhook is the only legacy surface still alive.

### 7.1 Auth-side cut — ✅ PR-323

| Removed | Notes |
|---|---|
| `services/github-oauth.ts` legacy OAuth helpers (`buildAuthorizeUrl`, `exchangeCodeForProfile`) | Module trimmed to just `listUserRepos` + `GithubApiError` for the Step 2 picker |
| Web `github-integration-panel.tsx` | 205 lines deleted; replaced by `github-app-installation-panel.tsx` (251 lines) |
| Legacy OAuth-App env vars (`FIRST_TREE_HUB_GITHUB_OAUTH_*`) | Schema definition removed from `oauth.github` block |
| Half-config check in `src/index.ts` for `oauth.github` | Removed (block no longer exists) |

### 7.2 Webhook-side cut — 🔮 deferred to webhook PR

| To be removed (in webhook PR) | Notes |
|---|---|
| `POST /api/v1/webhooks/github/:orgId` route | Replaced by `POST /api/v1/webhooks/github` with reverse-lookup |
| `github-webhook-review-requested.test.ts` | Coverage to move to App webhook tests |
| `org_settings.github_integration` namespace + the row data | Migration `0038`; shared `ORG_SETTINGS_NAMESPACES` registry to be trimmed |
| Legacy `webhookSecretCipher` field handling in `services/org-settings.ts` | Function `getDecryptedGithubWebhookSecret` to be removed |
| `webhooks/github.ts` per-org route handler | The dispatch helpers (mention extraction, `MENTION_ACTIONS`, etc.) stay; only the route registration is removed |

Until the webhook PR ships, the legacy `/webhooks/github/:orgId` route still accepts deliveries — Hub orgs that already have the legacy webhook configured continue to work. The new GitHub App's webhook URL points at `/webhooks/github` (the App webhook), which will 404 until the webhook PR lands.

### 7.3 Why no compatibility window

Per the original design, three reasons (all still apply across the two-stage cut):

1. **No GA tenant on the legacy path** — the deployment isn't yet serving the public, so there is
   no "in-flight migration" cohort to bridge.
2. **Public unauthenticated endpoints** — running both the legacy webhook URL and the App URL
   simultaneously doubles the attack surface during the migration window. A misconfigured webhook
   secret on either side could leak independently.
3. **No partial value** — the App schema alone, the App schema + sign-in alone, the App schema +
   webhook alone are all dead code until the cutover lands.

> **Caveat from the split:** PR-322 + PR-323 leave Hub in an intermediate state — App-flow sign-in is live but the App's webhook URL has no handler. This is OK because: (a) operators provisioning a new App after PR-323 merges should leave the App's webhook URL unset (or pointing at the eventual `/webhooks/github`), (b) staging is the only environment using this code today, and (c) the webhook PR is expected to follow within a sprint.

### 7.4 Rollback

Forward-only at every stage. PR-323's auth-side cut deletes the legacy OAuth-App env-var schema; reverting requires restoring the legacy `oauth.github` config block. Migration `0038` (in the webhook PR) deletes data; reverting requires re-installing on every customer account. No automated rollback path is provided. Each PR is treated as a deploy-time event and shipped only after the operator confirms the new surface works end-to-end on staging.

---

## 8. Known Gaps / Deferred Work

All filed as GitHub issues. Severity is the codex-review classification.

| # | Title | Severity | Status |
|---|---|---|---|
| [#312](https://github.com/agent-team-foundation/first-tree-hub/issues/312) | `/user/installations` does not prove admin access — claim endpoint can hijack installs | P1 (security) | Open. Pre-existing in P0-2 commit; exposed more by C.10's claim endpoint. Needs a stronger admin primitive (probably a per-installation re-check via the App API). |
| [#313](https://github.com/agent-team-foundation/first-tree-hub/issues/313) | `upsertInstallationFromMetadata` clobbers `suspended_at` on stale events | P1 | Open. Pre-existing in original Phase 1. Needs a `last_lifecycle_event_at` column to be order-safe. |
| [#314](https://github.com/agent-team-foundation/first-tree-hub/issues/314) | Stale `created` / `repositories` events resurrect deleted install rows | P1 | Open. Same lifecycle-ordering gap as #313 — same fix shape. |
| [#315](https://github.com/agent-team-foundation/first-tree-hub/issues/315) | Install URL state minted on render — multi-tab/multi-org clobbers cookie nonce | P2 | Open. Each `/install-url` GET sets a fresh cookie; opening Settings in two tabs in different orgs leaves only the second tab's nonce valid. New in C.8. |
| [#317](https://github.com/agent-team-foundation/first-tree-hub/issues/317) | Webhook `processed_events` leak when claim succeeds but post-claim work fails | P1 (design-level) | Open. The `unclaimEvent` path covers thrown errors, but a post-claim async side effect that silently swallows could leak. Applies to per-org webhook on main historically too. |
| [#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318) | Settings UI lacks "Claim install" buttons for multi-orphan recovery | P1 | Open. Backend endpoint shipped in C.10 (`POST /claim`); web UI deferred. Multi-orphan case logs + skips auto-claim, with no user surface for resolution today. |
| [#319](https://github.com/agent-team-foundation/first-tree-hub/issues/319) | `/user/installations` pagination capped at 500 — power users can fail callback bind | P2 | Open. `listUserAccessibleInstallationIds` walks 5 pages × 100. Power users with >500 installs (rare but possible at GitHub Enterprise scale) trip the cap and fail D9. |
| [#320](https://github.com/agent-team-foundation/first-tree-hub/issues/320) | Webhook tests bypass real `bindInstallationToOrg` (call `upsertInstallationFromMetadata` directly) | P2 (test quality) | Open. Test scaffolding shortcut; doesn't affect prod behavior but reduces confidence in the binding path's webhook-side coverage. |
| [#321](https://github.com/agent-team-foundation/first-tree-hub/issues/321) | PR conversation comments mis-routed to issue chats (issue_comment with issue.pull_request) | P2 | Open. Pre-existing in main #304's `github-entity.ts`; cleanup not in this PR's scope. |

**Fix-shape clusters (per PR description):**

- **#313 + #314** share a lifecycle-ordering column on `github_app_installations`
- **#312 + #319** share rebuilding the install-admin primitive
- **#317** needs a design pass on claim/dedup semantics
- **#318** is straightforward web UI work
- **#315 + #321** are independent small fixes
- **#320** is trivial test cleanup

**Other deferred work** (PR description §"What's NOT in this PR"):

- Per-repo children table (`installation_repositories: added/removed` re-snapshots the parent row
  but doesn't model individual repos yet)
- Phase 4 identity convergence — `members:read` permission is granted but no sync runs yet
- Secret-manager pattern for `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY` (design doc §6 risk 4)
- `breeze` / Hub client variant boundary cleanup (design doc §6 risk 2)

---

## 9. Testing Surface

### 9.1 Server tests added

7 new test files; ~2,300 lines covering the new surface.

| File | Lines | `test()`/`it()` blocks | Surface covered |
|---|---|---|---|
| `__tests__/github-app.test.ts` | 529 | 25 | App JWT, install token, user-token refresh, OAuth helpers, `listUserAccessibleInstallationIds` |
| `__tests__/github-app-installations.test.ts` | 300 | 17 | State machine: upsert, bind (race-safe + idempotent), suspend/unsuspend out-of-order, delete, orphan list, count |
| `__tests__/github-app-webhook.test.ts` | 404 | 13 | Endpoint dispatch: HMAC, ping, silent filter, lifecycle, content-with-binding, content-without-binding (503 no-claim), missing installation block, action gate, dedup, claim/unclaim |
| `__tests__/github-app-orphan-recovery.test.ts` | 341 | 10 | D13 sweep: single-orphan auto-claim, multi-orphan skip, claim endpoint authorization, manual claim happy + 403 + 404 + 409 paths |
| `__tests__/github-app-callback-target-org.test.ts` | 242 | 4 | D10 path: state-borne `targetOrganizationId`, admin re-check, 403 on revoked admin, invite override |
| `__tests__/github-app-install-url.test.ts` | 118 | 4 | `/install-url`: slug present (200), slug missing (503), state JWT shape, cookie set |
| `__tests__/oauth-flow.test.ts` | 294 | 18 | End-to-end: `/start` → `/callback` round-trip, dev-callback opt-in gate, joinPath classification |
| Modifications to `oauth-state.test.ts`, `org-settings.test.ts`, `helpers.ts`, `setup.ts` | — | — | `targetOrganizationId` in state JWT; `vitest.setup.ts` sets `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` |

PR description claims **809/809 server tests passing** (testcontainers PG; +41 vs pre-Phase-A
baseline of 768/768).

### 9.2 Manual smoke tests required

The PR explicitly defers four checks until real App credentials are provisioned:

- [ ] GitHub → Hub OAuth round-trip via the App authorize URL (verify `state` JWT round-trips,
      install dialog appears on first sign-in)
- [ ] Real `installation: created` webhook delivery + HMAC validation against staging
- [ ] User token refresh against `https://github.com/login/oauth/access_token`
- [ ] C.8 install-URL flow: trigger from Settings panel, confirm GitHub round-trips the `state`
      query param

These cannot be exercised in unit tests because they all touch the live GitHub API. The
operator's pre-merge runbook (§5 of the PR description) requires staging validation before merge.

### 9.3 Test scaffolding notes

- `vitest.setup.ts` sets `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` so existing dev-callback tests
  keep working without per-test plumbing (D14).
- App tests use injectable `fetcher` / `now` to stub network round-trips deterministically
  (`services/github-app.ts:131-136, 250-256, 313-318, 466-471`).
- Webhook tests bypass `bindInstallationToOrg` and call `upsertInstallationFromMetadata` directly
  for setup convenience (acknowledged as #320).

---

## 10. Operational Implications

### 10.1 What changes for the operator

**Pre-merge:** an operator who runs the legacy stack must register a GitHub App **before** merging
this PR. The PR description §"Pre-merge runbook" lists:

1. Create staging + prod GitHub Apps (two sets, sharing dev with staging in this team's setup).
2. Distribute the 6 secrets (`APP_ID` / `CLIENT_ID` / `CLIENT_SECRET` / `WEBHOOK_SECRET` /
   `PRIVATE_KEY` PEM / `APP_SLUG`) via team secret manager.
3. Run `pnpm --filter @first-tree-hub/server db:migrate` against staging.
4. Smoke-test the four pending checkboxes above on staging.
5. Merge.

**Per-customer:** customers no longer configure their own webhook secret. Each customer admin
clicks "Install on GitHub" in Settings → Integrations once per Hub team; the install dialog
guides them through repo selection. Hub binds the resulting `installation_id` to their team
automatically.

**Install URL distribution:** there is no "static install link" to share. Each install must go
through `/orgs/:orgId/github-app-installation/install-url` so the state JWT carries the
`targetOrganizationId`. A shared link would lose this binding and revert to the OAuth-callback's
"primary org" fallback (which is wrong for any non-personal team).

### 10.2 Secret rotation

- **Webhook secret rotation:** swap `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` env var, restart
  Hub, update the secret in the GitHub App's settings page. Brief HMAC failures during the
  window between Hub restart and GitHub config update; GitHub's redelivery covers them.
- **App private key rotation:** GitHub allows multiple private keys per App during a rotation.
  Procedure: add new key on GitHub, swap `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`, restart Hub,
  delete old key on GitHub. No webhook downtime (App JWT is regenerated every 9 minutes per
  request).
- **Client secret rotation:** swap `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET`, restart. Requires
  rotation on the GitHub App settings page in lockstep — there is no overlap window for OAuth
  client secrets. In-flight OAuth dances will fail; users re-click sign-in.

### 10.3 Disabling the GitHub App entirely

Unset all 5 required env vars (the boot guard treats partial as fatal). Routes that depend on the
App (`/auth/github/start`, `/auth/github/callback`, `/api/v1/webhooks/github`) return 503/501.
The Settings panel renders the "GitHub App not configured" empty state.

### 10.4 Observability surface

The boot log emits a single line per startup:

```
GitHub App not configured — /auth/github/start will return 503. Set FIRST_TREE_HUB_GITHUB_APP_* to enable.
```

(when the block is absent), or no message when configured.

Run-time structured log markers worth alerting on:

| Marker | Meaning | Suggested action |
|---|---|---|
| `github_app.installation_id_unauthorized` (warn) | D9 attempt blocked | Investigate caller — could be CSRF or hijack attempt |
| `github app webhook for unbound installation` (info) | R2 race window observed | Normal during fresh installs; alert if rate is sustained |
| `multiple unbound installs match this account` (info) | R14 multi-orphan path | Settings UI is missing the picker (#318); manual claim may be needed |
| `github app install bind-to-org failed` (warn) | R4 — orphan created | Should heal on next sign-in via D13 sweep |
| `dev-callback request refused` (info) | D14 gate caught a request | Expected in prod; alert if seen with valid query string |

---

## 11. Risk Assessment

### 11.1 What could go wrong post-merge

| # | Risk | Severity | Likelihood | Mitigation in this PR |
|---|---|---|---|---|
| **X1** | Operator merges without provisioning the GitHub App | High (sign-in 503; webhooks 501) | Medium | Boot guard refuses partial config; manual smoke-test step in runbook |
| **X2** | Operator pastes single-line PEM with literal `\n` | High (App JWT minting fails) | Medium | Boot guard sniffs for `-----BEGIN PRIVATE KEY-----` header; error message names the failure mode |
| **X3** | Webhook secret leaked | Critical (forge any tenant's events) | Low | One env-var rotation; documented runbook |
| **X4** | App private key leaked | Critical (impersonate any installation) | Low | Same env-var swap procedure; GitHub allows multi-key rotation |
| **X5** | Race between `installation: created` and OAuth callback bind permanently burns the event | Medium (mention silently dropped) | Medium | D6 — webhook returns 503 (not claim) when binding is missing; GitHub's retry budget covers the bind window |
| **X6** | Stale lifecycle event resurrects a deleted install row | Medium (zombie binding) | Low (within GitHub's reorder window) | Acknowledged in #314; not blocking — needs lifecycle-ordering column |
| **X7** | Power user with >500 installations fails the D9 check | Medium (can't bind) | Low | Acknowledged in #319; current cap is 5 pages × 100 |
| **X8** | `/user/installations` admin signal is forgeable | High (claim hijack) | Low | Acknowledged in #312; current implementation treats it as authoritative |
| **X9** | Multi-tab install URL fetch clobbers cookie nonce | Low (one tab's flow fails CSRF check) | Medium | Acknowledged in #315; user retries |
| **X10** | Migration `0038` deletes legacy `github_integration` rows | High if rollback needed | Low (forward-only is the chosen mode) | No mitigation; rollback requires re-install on every customer account |
| **X11** | Test bypass of `bindInstallationToOrg` masks a regression in the binding path | Medium | Low | Acknowledged in #320; manual smoke test covers production path |
| **X12** | `dev-callback` accidentally enabled in prod | Critical (mint arbitrary identities) | Very low | Two-gate defense (`NODE_ENV` + explicit env var); 404 (not 403) on either gate fail |

### 11.2 Recommended pre-approval checks

The architect should explicitly verify before approving:

1. **The race-safety claims** for `bindInstallationToOrg` actually serialize under concurrent
   load. The conditional UPDATE + 23505 catch is sound on paper; the `github-app-installations.test.ts`
   suite covers the logic but can't exercise actual parallel transactions without testcontainers
   running with concurrency isolation set explicitly.
2. **The "no claim" decision for unbound webhooks** (D6) is correct. If the architect believes
   GitHub's redelivery budget will exhaust before the bind lands in some edge case, this becomes a
   permanent dropped-event path. The current judgment is "bind lands within seconds of OAuth
   round-trip"; that's empirically true but not enforceable.
3. **The orphan-reclaim semantics** (D13). Auto-claiming a single orphan based on
   `accountGithubId` matching is a strong implicit trust signal — the user is the same GitHub
   identity that originally installed the App. The architect should be comfortable that the
   implicit trust is justified for User-type accounts. Org-type accounts go through manual
   claim only (PR description: "auto-claim is too risky for orgs").
4. **Severity of #312** (claim endpoint hijack via weak admin signal). If this is "needs fix
   before public ship", the PR should not merge. If "P1 follow-up acceptable for a deployment
   without an active threat model", merge is fine. The PR currently treats it as the latter.
5. **Migration ordering compatibility** with deployments that ran the old PR-300 layout. The
   `940ad5c` commit bumps migration timestamps so the renamed `0036` re-applies cleanly.
   Architect should verify the `pgMigrator`'s `lastApplied.created_at < folderMillis` semantics
   on whichever PG version the deployment runs.

### 11.3 Recommended monitoring (first 30 days)

- Rate of `github_app.installation_id_unauthorized` warnings (should be near zero; spike → active
  hijack attempt or buggy client).
- Rate of `github app webhook for unbound installation` info logs (should taper to zero quickly
  after each install; sustained → bind path is failing systemically).
- Webhook redelivery counts on the GitHub App settings page (should be low; high → 503/5xx churn).
- `processed_events` row growth rate (sanity check on dedup table size).
- `github_app_installations` rows where `hub_organization_id IS NULL` for >24h (should be zero;
  non-zero → orphan-reclaim is failing for some account, manual claim needed).

---

## Appendix A — File Map

Key files in this PR with line ranges:

| File | Role |
|---|---|
| `packages/server/src/api/auth/github.ts:59-323` | OAuth callback, dev-callback, completeOauthFlow |
| `packages/server/src/api/webhooks/github-app.ts:54-217` | Webhook dispatch + state machine routing |
| `packages/server/src/api/webhooks/github.ts:19-31` | Shared HMAC verify (used by both webhook routes — only the App webhook remains) |
| `packages/server/src/api/webhooks/github.ts:395-440` | `handleMentionDelegation` + `MENTION_ACTIONS` |
| `packages/server/src/api/orgs/github-app.ts:42-176` | Admin API: GET install / install-url / claim |
| `packages/server/src/services/github-app.ts:92-559` | App JWT, install token, user-OAuth helpers, refresh |
| `packages/server/src/services/github-app-installations.ts:69-380` | State machine, race-safe bind, orphan helpers |
| `packages/server/src/services/oauth-state.ts:50-108` | State JWT mint + verify |
| `packages/server/src/services/auth-identity.ts:9-167` | Token bundle persistence + login-collision retry |
| `packages/server/src/api/me.ts:182-277` | Token refresh in the request path (`/me/github/repos`) |
| `packages/server/src/db/schema/github-app-installations.ts:36-110` | Drizzle schema |
| `packages/server/src/db/schema/auth-identities.ts:31-45` | Extended metadata jsdoc |
| `packages/server/drizzle/0037_github_app_installations.sql` | Table + indexes + FK |
| `packages/server/drizzle/0038_drop_github_integration_namespace.sql` | DELETE legacy rows |
| `packages/server/src/boot-guards.ts:7-87` | Boot validation (App config + production publicUrl) |
| `packages/server/src/app.ts:144-150, 427, 466` | `assertBootConfigValid` call site + route registrations |
| `packages/shared/src/config/server-config.ts:81-138` | Env var schema (App block) |
| `packages/shared/src/schemas/github-app.ts:1-131` | Shared Zod schemas + DTO |
| `packages/web/src/api/github-app.ts:1-52` | SPA client (GET install + install-url) |
| `packages/web/src/pages/github-app-installation-panel.tsx:1-232` | Settings UI panel |

---

## Appendix B — codex Review Provenance

The PR went through two rounds of codex review + adversarial challenge. Findings traced to
specific commits:

- **P0-2** (`366a7a3`) — authorize `installation_id` (D9)
- **P0-3 + H2** (`b32c89d`) — race-safe `bindInstallationToOrg` (D8)
- **P1-1** (`7037bfe`) — install URL via App slug, not OAuth authorize URL (codex P1-1; the
  authorize URL never surfaces the install dialog for users who haven't installed the App, so
  the legacy CTA silently never produced an install)
- **P1-2** (`d49c466`) — `ApiError.status === 404` detection in web client (regex was checking
  literal "404" in error message body)
- **P1-3** (`71e6dc2`) — bind installs to target org via state JWT (D10)
- **P1-4** (`d49c466`) — token-refresh wiring in `/me/github/repos`
- **P1-5 + H1** (`753d74b`) — orphan reclaim sweep + manual claim endpoint (D13)
- **P1-6** (`094c74f`) — webhook ordering: resolve binding before claim (D7)
- **P1-7** (`45f7d1e`) — suspend/unsuspend/delete order-safety (D15 — though delete grace
  reverted in `a2ad802`)
- **P1-8** (`a4b2d87`) — boot guards in `buildApp` + `.min(1)` on App secrets (D11/D12)
- **P1-9** (`5b1ca20`) — explicit opt-in for `/dev-callback` (D14)
- **Post-rollup P1** (`940ad5c`) — migration timestamps bumped so old PR-300 DB layouts pick up
  the renamed `0036`
