---
id: agent-self-provisioning-capability
description: Gated agent self-provisioning — an agent may create teammate agents only with an admin-granted capability, scoped to its own org/manager/client.
areas: [cross-surface]
surfaces: [cli, client, server]
---

# Agent Self-Provisioning Capability

## Purpose

Validate that an authenticated agent can provision teammate agents from inside a
running session (issue #1885) **only** when a human admin has granted the
`provision-agents` capability, and that the grant is a real, server-enforced,
default-deny boundary — not a prompt convention. The core risk is
privilege-escalation: a prompt-injected agent must not be able to create agents
or sidestep the gate.

## Preconditions

- Run against an isolated server + Postgres (Docker) and a temporary worktree.
- One org with: an admin member, a non-admin member, and a non-human agent
  (`actor`) pinned to a client the admin's user owns.
- A live client runtime so `actor` runs with a real `X-Agent-Id` + runtime
  session (the enforcement flag may be on or off — the gate must hold either way).
- Capture agent IDs, org/member IDs, `source`, and API responses; never capture
  JWTs or runtime-session tokens.

## Scenarios

1. **Default-deny.** With no capability granted, `actor` runs
   `first-tree agent create <name>` (agent context) → expect a 403 whose message
   names `provision-agents` and how an admin grants it. No agent row is created.
2. **Grant + provision.** Admin runs `agent config set-capabilities actor provision-agents`.
   `actor` then provisions a teammate → 201. Verify the teammate is in `actor`'s
   org, managed by `actor`'s manager, `source = agent-api`, and carries a
   `createdBy` provenance stamp. A body attempting to set `organizationId`,
   `managerId`, or `type: human` must not widen scope.
3. **Member-route bypass is closed.** A direct `POST /orgs/:orgId/agents` carrying
   `X-Agent-Id` → 403 (funnelled to the gated path); the same request without the
   header (human operator / web console) still succeeds.
4. **Grant is admin-only.** A non-admin manager calling the grant route → 403; a
   grant request carrying `X-Agent-Id` → 403 (defense-in-depth). A grant via the
   free-form `metadata.agentCapabilities` field → 400 (reserved key).
5. **Read-back + durability.** An admin reads the grant and provenance
   (`get-capabilities`); a later ordinary metadata edit does not wipe the grant.
6. **Scope boundaries.** `actor` cannot target a client not owned by its manager,
   nor exceed the org `maxAgents` quota (reused from the create path).
7. **Non-escalation note.** When `actor`'s manager is itself an org admin,
   self-granting is cosmetic (the agent already holds org-admin authority); this
   is acceptable by construction, not a finding.

## Evidence

- CLI stdout for allow/deny paths, redacted create + capabilities API responses.
- DB evidence limited to stable IDs, `source`, `managerId`, `organizationId`, and
  the presence/absence of the capability + `createdBy`.

## Result Rules

- `PASS` requires default-deny, forced-scope, admin-only grant, the closed member
  route, and readable-but-write-protected capability/provenance to all hold.
- Server/Docker/runtime bring-up failures are `BLOCKED`.
- Any create without a capability, any scope widened by the request body, any
  non-admin or agent-context grant succeeding, or a grant wiped by a normal
  metadata update is `FAIL`.

## Limitations

- A hand-crafted raw request bearing the manager's bare JWT with no `X-Agent-Id`
  is indistinguishable from a human admin and is out of scope for the gate — the
  capability funnels SDK-mediated (well-behaved) agents, it does not defeat a
  determined actor forging requests with the human's token.
