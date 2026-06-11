# HTTP Path Conventions

> **Read this first** if your work touches any of:
> - `packages/server/src/api/`, `middleware/`, `scope/`, `services/auth.ts`
> - `packages/web/src/api/`, `packages/client/src/sdk.ts`
> - Any "cross-org / multi-org / switch-org" bug
>
> This is the single source of truth for route naming. Any conflicting older code, comment, or design doc is wrong — fix it to match this.

## JWT scope

JWT carries **only** `userId`. `request.user` is `{ userId }`. Anything beyond that — org, role, member — is resolved per-request via `scope/require-*` helpers, which probe the DB in real time. Reading `request.user.organizationId / memberId / role` is impossible (the fields don't exist) — that is the type-level enforcement of the rule.

```ts
type AccessTokenPayload = { sub: string; type: "access"; iat: number; exp: number; jti: string };
```

## Decision tree

```
Q1: Does the operation involve an organization?
    No  → Class A
    Yes → Q2

Q2: Is the target a globally-unique resource (agent / chat / session / ...)?
    Yes → Class C
    No  → Class B

Special: agent runtime self → Class D
```

## Class A — User-scoped

| Path | Middleware | Notes |
|---|---|---|
| `/api/v1/me/...` | `requireUser` | scope = `{ userId }` |
| `/api/v1/auth/...` | none / `requireUser` | login, refresh, logout |

Use when the operation is about "me as a user" — cross-org or org-agnostic.

## Class B — Org-scoped

| Path | Middleware | Notes |
|---|---|---|
| `/api/v1/orgs/:orgId/<resources>` | `requireOrgMembership` | any role |
| `/api/v1/orgs/:orgId/<resources>` | `requireOrgAdmin` | admin-only |

Use for org-scoped lists, creates, and org-wide config. The `:orgId` param is **mandatory** in the path — middleware type signature requires `req.params.orgId`.

Example: `GET POST /api/v1/orgs/:orgId/agents`, `GET POST /api/v1/orgs/:orgId/chats`, `WS /api/v1/orgs/:orgId/ws`.

## Class C — Resource-scoped

| Path | Middleware | Returns |
|---|---|---|
| `/api/v1/<resources>/:id/...` | `require<Resource>Access` | `{ resource, scope: OrgScope }` |

Use for ops on a specific UUID. The resource's own org is intrinsic — **do not** put `:orgId` in the URL. Middleware looks up the resource, resolves caller's membership in the resource's org, applies visibility/manage rules.

Example: `GET /api/v1/agents/:uuid`, `POST /api/v1/chats/:chatId/messages`.

## Class D — Agent runtime self

| Path | Middleware | Auth |
|---|---|---|
| `/api/v1/agent/...` (singular) | `agentSelector` | user JWT + `X-Agent-Id` header |

For the AgentRuntime process speaking as an agent. Parallels `/me` (user self) — both are first-person `self` namespaces, distinct from `/agents/:uuid` (resource collection). Only used by `packages/client/src/sdk.ts`.

Example: `GET /api/v1/agent/me`, `POST /api/v1/agent/chats/:chatId/messages`, `WS /api/v1/agent/ws`.

## Naming rules

| Rule | Example |
|---|---|
| Resource collections: plural + kebab-case | `agents`, `chats`, `system-config` |
| First-person self: singular | `me`, `agent` (only these two) |
| Path params: `:orgId`, `:uuid` (agents), `:chatId`, `:id`, `:token` | |
| WebSocket: `/ws` suffix under owning scope | `/orgs/:orgId/ws`, `/agent/ws` |

## Forbidden

- ❌ `/admin/...` prefix anywhere — role lives in middleware, not URL
- ❌ Reading `request.user.organizationId` / `memberId` / `role` — these fields don't exist; JWT carries only `sub`
- ❌ `?organizationId=` query param for org scope — use `:orgId` path param
- ❌ Class B route without `:orgId` in path — `requireOrgMembership` will fail to type-check
- ❌ Class C route with `:orgId` in path — redundant; resource UUID locates the org
- ❌ Mixing classes (e.g. `/me/...` route calling `requireOrgMembership`)
- ❌ Top-level `/ws` or custom suffixes like `/realtime`, `/socket`
- ❌ `enum` for path params; use `as const` / Zod literals
- ❌ Reintroducing `memberScope`, `resolveAdminScope`, `requireMemberInOrg`, `requireAdminRoleHook` — all deleted
- ❌ **Role-conditional response set** — a single route returning different resource collections based on caller role (e.g. members get their own clients, admins get the org's clients). Split into Class A + Class B and let the frontend pick. URLs describe data, not "what to show whom"

## Pre-commit checklist

- [ ] Path matches the decision tree
- [ ] Middleware matches the Class
- [ ] Plural resources, singular self
- [ ] No `/admin` prefix
- [ ] No reads of `request.user.organizationId` / `memberId` / `role`
- [ ] WebSocket under owning scope with `/ws` suffix
- [ ] Multi-org test coverage for any new Class B / C route
- [ ] Response set depends only on path params + scope, not on caller role
