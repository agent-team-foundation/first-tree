# Decouple Client from Organization — Design Doc

**Status:** Draft — exploring direction, not yet approved
**Author intent:** Make a single physical client (one `~/.first-tree/hub/` install) usable across every org the user belongs to, without re-registering on every org switch.
**Supersedes (in part):** [multi-tenancy-hardening-design.md](./multi-tenancy-hardening-design.md) — specifically the "a client is bound to exactly one org for its lifetime" rule.

---

## Background

Three things are bound to a single `organizationId` today:

1. **JWT** — every access/refresh token carries one `organizationId` claim. `signTokensForMember()` stamps it from the `members` row.
2. **`clients.organization_id`** — set on first `client:register`, immutable for the row's lifetime ([packages/server/src/db/schema/clients.ts:27-29](../packages/server/src/db/schema/clients.ts:27)).
3. **`agents.organization_id`** — every agent lives in exactly one org; `agents.name` is unique per org.

When a user belongs to multiple orgs, the server-side `/auth/switch-org` API ([packages/server/src/api/me.ts:219](../packages/server/src/api/me.ts:219), shipped in PR #187) re-issues a token under a new `organizationId`. **But it does nothing to the client layer.** The next time the local CLI reconnects, [`registerClient()`](../packages/server/src/services/client.ts:89) finds the existing row pinned to the old org, throws `ClientOrgMismatchError`, the CLI rotates `client.yaml` → `client.yaml.bak`, and the operator is told to re-run.

That is the user complaint: "switching org should not require re-establishing the client connection."

The R-RUN scoping rule was designed under the implicit assumption "one user → one org". Multi-org self-service shipped in PR #187 but did not revisit that premise.

---

## Goals

1. A single physical client can serve every org the user belongs to without `ClientOrgMismatchError` and without rotating its local identity.
2. `/auth/switch-org` is a true zero-touch operation from the operator's perspective: token refresh only.
3. Multi-tenancy guarantees stay intact: an agent in org A can never be operated under a session bound to org B.
4. Clear migration path from existing `clients.organization_id != null` rows.

## Non-goals

- Sharing a single agent across orgs (agents stay org-scoped — that's a product question).
- Running agents from two orgs simultaneously in the same OS process (different problem; addressed by Q2 below).
- Re-architecting the JWT model — JWT stays per-org for session scoping.
- Web UX changes for org switching beyond what `/auth/switch-org` already provides.

---

## Key questions to resolve

These need answers before implementation. Recommended answers in **bold**.

### Q1. What is a "client"?

Two clean mental models — pick one:

- **Model A — `client = user`, org is runtime context.** A client represents "this user's machine". The WebSocket session carries an org context that can change. One clientId, many orgs over its lifetime.
- **Model B — `client = (user, org)` with transparent multiplexing.** Server still binds clientId to org; local config maintains a `{org → clientId}` map and rotates transparently. No `ClientOrgMismatchError` ever reaches the operator.

**Recommendation: Model A.** Matches the user's stated mental model, avoids local mapping state, lines up with how the Web UI presents org switching. Model B is "user experience sugar over the existing constraint" — cleaner short-term but leaves the architectural mismatch in place.

### Q2. Can one client run agents from multiple orgs at the same time?

Today: no. The WS session has exactly one `organizationId` ([packages/server/src/api/agent/ws-client.ts:228](../packages/server/src/api/agent/ws-client.ts:228)) and `agent:bind` requires `agent.organizationId === session.organizationId` ([same file, line 355](../packages/server/src/api/agent/ws-client.ts:355)).

Two sub-options for Model A:

- **Q2a — Single-active-org.** Session has one active org at a time. Switching unbinds old-org agents and re-binds new-org agents. Simpler invariants.
- **Q2b — Multi-active-org.** Session can hold agents from multiple orgs concurrently; every frame is org-tagged. Matches "one client, all my orgs" intuition (e.g. agent-A and agent-B both `connected` from the same machine simultaneously).

**Recommendation: Q2a for v1.** Q2b is the long-term direction but adds significant complexity (per-frame org tagging, presence per (client, org), inbox subscription multiplexing). Ship Q2a first; reassess.

### Q3. What replaces `clients.organization_id`?

- **Drop the column.** Cleanest. Admin "clients in this org" view derives from `agents` joined to `agent_presence`.
- **Make it nullable, treat as informational.** Less invasive but leaves a misleading column behind.
- **Replace with a `client_organizations` join table.** Tracks every org a client has served. Useful for audit, heavier than needed.

**Recommendation: drop the column.** The cleanest signal-to-noise. Anything we lose can be derived.

### Q4. What happens to `agent_presence` rows on org switch?

`agent_presence.client_id` represents "which physical machine is currently running this agent". On WS org switch:

- **Treat the WS session as authoritative.** On switch, mark all old-org agents pinned to this client as `offline` (reset clientId), then re-pin new-org agents. Causes bind/unbind churn but keeps presence honest.

**Recommendation: above (unbind old + rebind new).** Alternatives leak "ghost connected" state — confusing for operators and adapters.

### Q5. How does R-RUN survive?

Today's check (in `packages/server/src/services/agent.ts`):

```
client.userId === jwt.userId            ← keep
client.organizationId === jwt.orgId     ← remove
agent.organizationId === jwt.orgId      ← keep (already enforced)
```

**New invariant:** `agent.organizationId === session.organizationId AND client.userId === jwt.userId`.

Cross-tenant safety still holds: binding agent X (org A) requires (1) a JWT for org A — only issued if user is a member of A — and (2) ownership of the client. The only thing weakened: a single `clientId` can be operated under multiple orgs over its lifetime. Every individual op is still scoped.

**Recommendation: confirm with security review.** This is the load-bearing change.

### Q6. Migration path

`clients.organization_id` is `notNull` with FK. We need to either drop or null it.

**Recommendation:** same PR drops the column, the index, the `ClientOrgMismatchError` class, the rotation helper, and updates docs. Single migration: `DROP INDEX idx_clients_org; ALTER TABLE clients DROP COLUMN organization_id;`. No backfill needed (we are throwing data away that is no longer authoritative).

### Q7. How does the running CLI learn about an org switch initiated on the Web?

After `/auth/switch-org` returns new tokens, the running client process still has the old token in memory. Two options:

- **Server pushes `session:org_changed` frame** over the existing WS, client re-handshakes in-place.
- **Client polls / re-handshakes on token expiry** — natural cycle, slower switch.

**Recommendation: server-pushed frame.** Snappy UX, low complexity. Could be deferred to a follow-up if scoping the first PR.

---

## Recommended design (one sentence)

> A `clients` row is owned by exactly one user and is **not** bound to any org; the WebSocket session carries the active `organizationId` from the verified JWT; R-RUN keeps `agent.organizationId === session.organizationId` and `client.userId === jwt.userId`; `/auth/switch-org` becomes zero-touch for the local CLI, optionally accelerated by a server-pushed `session:org_changed` frame.

---

## Impact surface

### By layer

| Layer | What changes | Risk |
|---|---|---|
| **DB schema** | Drop `clients.organization_id` + `idx_clients_org`. Single migration. | Medium — destructive. |
| **`registerClient()`** | Remove the cross-org check; remove `organizationId` from the function signature. | Low — pure simplification. |
| **`ws-client.ts` handshake** | Stop writing `organizationId` to `clients`. Session still derives org from `members`. | Low. |
| **R-RUN (agent service)** | Drop `client.organizationId === session.organizationId`; keep the user check + agent-org check. | **High — security-critical. Mandatory cross-tenant tests.** |
| **`agent_presence` lifecycle** | On WS org-switch, unbind old-org pins, re-pin new-org. New code path. | Medium — easy to leak ghost-connected state. |
| **`/auth/switch-org`** | Optionally push `session:org_changed` to the active WS so the client re-handshakes without restart. | Low (if deferred). |
| **`ClientOrgMismatchError`** | Delete the class, the API mapping, the WS close path. | Low — pure deletion. |
| **CLI `handleClientOrgMismatch` + `rotateClientIdWithBackup`** | Delete both. Remove catch sites in `connect.ts`, `client.ts`, `saas-connect.ts`. | Low. |
| **`inferWizardStep()`** | The "ever connected" check is `(clients.userId, clients.organizationId)`. Becomes derived from `agents` (e.g. "user has any agent in this org" or "any agent for this org's manager has been pinned"). | Medium — onboarding UX regression risk if signal is wrong. |
| **Admin "clients in this org" view** | Today: `WHERE clients.organization_id = $1`. After: derive via agents pinned to a client × agent's org. | Medium — touches admin/analytics. |
| **Tests** | `client-org-scoping.test.ts`, `me-multi-org.test.ts` rewrite. New tests for cross-org R-RUN, org-switch presence transitions, switch-without-rotation. | High — net more test surface. |
| **Docs** | `multi-tenancy-hardening-design.md` needs "superseded by" note. AGENTS.md "Unified user-JWT auth" paragraph. CLI reference. | Low. |

### Concrete file list (paths confirmed; specific lines TBD during impl)

**Server:**
- [packages/server/src/db/schema/clients.ts](../packages/server/src/db/schema/clients.ts) — drop column + index
- `packages/server/drizzle/00XX_*.sql` — new migration (drop column, drop index)
- [packages/server/src/services/client.ts:69-128](../packages/server/src/services/client.ts:69) — remove org check, drop arg
- [packages/server/src/services/agent.ts](../packages/server/src/services/agent.ts) — R-RUN org check removal
- [packages/server/src/middleware/agent-selector.ts](../packages/server/src/middleware/agent-selector.ts) — confirm and update
- [packages/server/src/api/agent/ws-client.ts](../packages/server/src/api/agent/ws-client.ts) — handshake + (Q7) `session:org_changed` emit
- [packages/server/src/errors.ts:53-57](../packages/server/src/errors.ts:53) — delete `ClientOrgMismatchError`
- [packages/server/src/api/me.ts:260-278](../packages/server/src/api/me.ts:260) — replace `inferWizardStep`'s clients query
- [packages/server/src/api/me.ts:219-245](../packages/server/src/api/me.ts:219) — `/auth/switch-org` emits the frame (Q7)

**Client SDK:**
- [packages/client/src/client-connection.ts:96-102, 455](../packages/client/src/client-connection.ts:96) — drop the WS-close mismatch path; (Q7) handle `session:org_changed`

**CLI:**
- [packages/command/src/core/client-reidentify.ts](../packages/command/src/core/client-reidentify.ts) — delete file
- [packages/command/src/core/index.ts](../packages/command/src/core/index.ts) — drop the export
- [packages/command/src/index.ts](../packages/command/src/index.ts) — drop the re-export
- [packages/command/src/commands/connect.ts:377-386](../packages/command/src/commands/connect.ts:377) — drop catch
- [packages/command/src/commands/client.ts:181-186](../packages/command/src/commands/client.ts:181) — drop catch
- [packages/command/src/commands/saas-connect.ts:254](../packages/command/src/commands/saas-connect.ts:254) — drop catch

**Tests:**
- [packages/server/src/__tests__/client-org-scoping.test.ts](../packages/server/src/__tests__/client-org-scoping.test.ts) — rewrite or delete
- [packages/server/src/__tests__/me-multi-org.test.ts](../packages/server/src/__tests__/me-multi-org.test.ts) — update assertions
- New: cross-tenant agent-bind rejection
- New: org-switch presence transition
- New: `client connect` + `/auth/switch-org` no-rotation flow

**Docs:**
- [docs/multi-tenancy-hardening-design.md](./multi-tenancy-hardening-design.md) — add "superseded" note
- [AGENTS.md](../AGENTS.md) — update "Unified user-JWT auth" paragraph
- [docs/cli-reference.md](./cli-reference.md) — remove rotation references

---

## Risk and rollback

- **R-RUN weakening is the load-bearing risk.** New cross-tenant integration tests are mandatory before merge. A security review pass is appropriate.
- **Migration is destructive** (column drop). Rollback requires `ADD COLUMN` and re-derivation from `agent_presence`/`agents`. Down migration must be tested on a snapshot.
- **Onboarding wizard regression.** `inferWizardStep`'s replacement signal must be validated against fresh-install, single-org, and multi-org paths.
- **Admin UI silent regression.** Any view that lists "clients in this org" needs an audit pass.

---

## Test plan

1. `pnpm check && pnpm typecheck` pass.
2. Existing Vitest suites pass after rewrites.
3. New integration tests:
   - User U with members in orgs A and B. Connect once. Switch token A → B via `/auth/switch-org`. Verify `client:register` succeeds without `ClientOrgMismatchError` and `agent:bind` for an org-B agent succeeds.
   - User U holds JWT for org A. Tries to bind an agent that belongs to org B. R-RUN rejects with the existing agent-org mismatch error (not the deleted `ClientOrgMismatchError`).
   - Same user has agents pinned in org A. Switches to org B. Org-A agents transition to `offline`, org-B agents transition to `connected`. Switches back. Org-A agents come back online without manual intervention.
   - `inferWizardStep`: user is a fresh member of org X with no agents → step is `connect` (or whatever the new signal yields). Same user already had a client connected under org Y; switches to X → step is `connect` for X (because no agents-in-X yet).
4. Manual CLI dry-run:
   - Connect under org A. Web-side `/auth/switch-org` to org B. Verify no rotation prompt; verify org-B agents become bindable.
   - launchd / managed mode: same scenario, no human prompt, no `.bak` file written.
5. Threat-model review: confirm "single client across orgs" does not enable any new cross-tenant data path.

---

## Sequencing

1. Resolve open questions Q1–Q7 with stakeholders.
2. Schema change + migration.
3. Service-layer change: `registerClient`, R-RUN, ws-client handshake. Delete `ClientOrgMismatchError`.
4. Update `inferWizardStep` and any admin views that filter clients by org.
5. CLI: delete `client-reidentify.ts`, drop catch sites.
6. Tests: cross-tenant integration coverage, org-switch presence transitions.
7. (Optional) Server-pushed `session:org_changed` frame + client-side handler.
8. Docs: supersede `multi-tenancy-hardening-design.md`, update AGENTS.md.

Branch name suggestion: `feat/decouple-client-from-org`.

---

## Appendix: today's failure trace (for reference)

1. User connects on machine M to org A. `clients` row created with `organization_id = A`.
2. User accepts an invite to org B (or signs up a second org). Now belongs to both.
3. User clicks "switch to org B" in Web → `/auth/switch-org` → new tokens with `organizationId = B`.
4. CLI on machine M (still running, or restarted) sends `client:register` with the new JWT.
5. [`registerClient()`](../packages/server/src/services/client.ts:89) reads `clients` row, finds `organization_id = A ≠ B` → throws `ClientOrgMismatchError`.
6. WebSocket closes with `CLIENT_ORG_MISMATCH` code.
7. CLI catches in [`handleClientOrgMismatch()`](../packages/command/src/core/client-reidentify.ts:66) → backs up `client.yaml` → generates new `client_xxxx` → exits, prompts operator to re-run.
8. Operator re-runs → new `clients` row created with `organization_id = B`.

The proposed design eliminates steps 5–8 entirely.
