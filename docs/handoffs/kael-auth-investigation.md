# Handoff: Kael Auth Investigation

**For:** A Claude session with read access to `agent-team-foundation/kael-*` private repos.

**From:** The session coordinating the first-tree-hub onboarding redesign (no access to Kael repos; restricted to `agent-team-foundation/first-tree-hub`).

**Status:** Working doc. Delete after the investigation lands and findings are merged into the redesign plan.

---

## Why we need you

We are mid-flight on a redesign of `first-tree-hub`'s onboarding. The planning lives on branch `feat/first-tree-hub-onboarding`:

- `docs/onboarding-redesign.md` — canonical (English)
- `docs/onboarding-redesign-zh.md` — internal discussion version (Chinese)

For the **hosted scenario** (Section 4.2), one open question is `Qh-1.y` — what authentication mechanism Hub uses. Today it is username + password (admin creates account, hands password offline), which is the worst friction point for new hosted users.

Two paths under consideration:

1. **Build Hub's own email magic-code auth** (Multica-style). Substantial engineering effort.
2. **Reuse Kael's existing auth** as Hub's identity provider. Possibly much cheaper, plus would unify identity across the team's products.

Path 2 is the reason this handoff exists. We need to know whether Kael's auth is suitable, and if so, what integration shape works.

## What we already know about Kael (from this side)

- Kael is referenced in Hub as a **cloud agent runtime** option (`packages/web/src/components/new-agent-dialog.tsx:61`, "kael — coming soon").
- Hub forwards messages to Kael via `POST {KAEL_ENDPOINT}/api/v1/hub/messages` (`packages/server/src/services/kael-runtime.ts`). API-key auth, server-to-server.
- Hub stores `kaelUserId` + `kaelProjectId` + `agentToken` per agent in `adapter_configs` (encrypted).
- Kael as a product has **at least 10 private repos** in `agent-team-foundation`:
  - `kael-backend` (Python, FastAPI + pydantic-ai) — main backend, **most likely** holds auth
  - `kael-frontend` (TypeScript) — Web UI
  - `kael-desktop` (Rust) — desktop app
  - `kael-workspace` (TypeScript) — workspace tooling
  - `kael-browser-extension` (TypeScript)
  - `kael-logger`, `kael-claw`, `kael-landing-page`, `kael-product-demo`, `kael-tree` (archived)

We do **not** know what auth Kael uses internally — that is what this investigation answers.

## Specifically, please answer

Read `kael-backend` (and `kael-frontend` if helpful) and produce a structured report. Sections:

### 1. Auth protocol Kael uses today

What does a Kael user actually do to log in?

- Email + password? Email magic code? Email magic link?
- Google OAuth? GitHub OAuth? Other social providers?
- SAML / OIDC for enterprise?
- Mix of any of these?

Quote the auth router endpoints (e.g., `/auth/login`, `/auth/oauth/google/callback`, etc.) so we can see the surface.

### 2. Can Kael act as an OAuth/OIDC provider for other services?

Specifically: could Hub register itself as a Kael OAuth client, redirect users to Kael for sign-in, and receive an ID token back?

- Are there `/oauth/authorize` and `/oauth/token` endpoints exposing standard OAuth 2.0 / OIDC?
- Or does Kael only act as an OAuth *client* of Google/GitHub (consumer side) and not provide its own identity outward?
- Or is there a custom token-exchange API that a third-party service could plug into?
- Or is auth fully closed (only Kael frontend / desktop can call it)?

This is the most important question — it determines whether a clean OAuth-style integration is even possible.

### 3. User data model

In `kael-backend` schemas / models:

- `users` table fields (id, email, name, avatar, role, etc.)
- Is there an `organizations` / `workspaces` / `teams` concept? What does the schema look like?
- Multi-tenant: how does a user relate to a workspace? Many-to-many with role?
- Is `users.id` a UUID? An int? Email?
- Is there a stable external ID a downstream service like Hub could store as a foreign key?

### 4. Self-host story

- Is `kael-backend` open source / does it have a self-host mode?
- If a user wants to self-host **first-tree-hub** AND `first-tree-hub` depends on Kael auth, can they self-host Kael alongside it?
- If not (Kael is hosted-only or closed), what does that mean for self-hosted Hub deployments?
- Are there deploy docs (Docker compose, k8s, etc.)?

### 5. Stability and ownership

Soft questions, infer from repo activity / readme tone:

- How active is Kael auth development? Stable enough for Hub to depend on without breakage?
- Does the README or any architecture doc indicate Kael wants to be a platform other services build on, or is it a single-product monolith?
- Whom would the Hub team need to coordinate with to add Hub as a downstream consumer?

## Files most likely to contain the answers

In `kael-backend` (adjust to actual layout):

- `pyproject.toml` or `requirements.txt` → look for auth deps: `authlib`, `fastapi-users`, `python-jose`, `passlib`, `pyjwt`, `python-multipart`, `email-validator`, `resend`, `sendgrid`
- `app/api/`, `app/routers/`, or top-level `main.py` → find `auth.py`, `users.py`, `oauth.py`, `sessions.py`
- `app/models/` or `app/schemas/` → `user.py`, `organization.py`, `workspace.py`
- `app/core/security.py`, `app/core/auth.py` → JWT signing, password hashing, OAuth client wiring
- `README.md`, `docs/` → deployment + architecture narrative
- `.env.example` or `config.py` → env vars hinting at OAuth providers, SMTP, Resend keys
- `migrations/` (if Alembic) → user table evolution

In `kael-frontend`:

- `src/pages/login*` or `src/pages/auth/` — what UI flow users actually see
- `src/api/auth*` or auth client code — confirms what backend endpoints are called

## Deliverable format

A markdown report ~150-300 words organised under the same section headings (1–5). End with:

```
## Recommended integration path for first-tree-hub

A. OAuth/OIDC standard         — Kael acts as identity provider; Hub is a client
B. Cookie sharing on root domain — both deployed under acme.com, share session
C. API token paste              — user generates Kael token, pastes into Hub
D. SDK / library                — Kael team ships an auth SDK we import
X. None — Kael auth not suitable; recommend Hub builds its own email auth

[Pick one with one-paragraph justification.]

## Open follow-ups

[Questions that need product/team alignment rather than code reading.]
```

Paste the report back to the coordinating session. They will incorporate findings into `docs/onboarding-redesign.md` Section 4.2 / `Qh-1.y` decisions.

## Out of scope (hard limits)

- **Do not modify** any Kael code.
- **Do not modify** any first-tree-hub code.
- **Do not draft** a full integration implementation — just gather and report facts.
- **Do not propose** changes to Kael's auth design (we are a downstream evaluator, not a Kael team member).
- **Do not commit** anything. This is a read-and-report task only.

## Reference materials (read first if you want full context)

In `agent-team-foundation/first-tree-hub`, branch `feat/first-tree-hub-onboarding`:

- `docs/onboarding-redesign.md` — full planning doc (~400 lines), Section 4.2 (hosted scenario) and Section 6 (decisions log) are most relevant
- `docs/onboarding-redesign-zh.md` — Chinese version with extra reasoning
- `packages/server/src/services/auth.ts` — Hub's current auth implementation (for understanding what Hub needs to replace/integrate with)
- `packages/server/src/services/kael-runtime.ts` — Hub's current Kael integration (server-to-server, message forwarding only — the auth integration is what doesn't exist yet)

If short on time, you can skip the redesign doc and rely on this handoff alone — sections 1–5 above are self-contained.
