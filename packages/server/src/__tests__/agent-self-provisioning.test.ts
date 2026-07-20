import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Issue #1885 — gated agent self-provisioning.
 *
 * The security model is server-enforced default-deny. These tests deliberately
 * run under the default test app (runtime-session enforcement OFF), so a pass
 * proves the gate holds on the always-on teeth — userAuth + X-Agent-Id +
 * org-membership + R-RUN + capability — not on a flag that ships disabled.
 */
describe("Agent self-provisioning (#1885)", () => {
  const getApp = useTestApp();

  const PROVISION = "provision-agents";

  /** Grant capabilities to an agent as the admin operator (no X-Agent-Id). */
  function grant(app: FastifyInstance, accessToken: string, agentUuid: string, capabilities: string[]) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agentUuid}/capabilities`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { capabilities },
    });
  }

  it("default-deny: an agent without the capability cannot provision (403)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });

    const res = await actor.request("POST", "/api/v1/agent/managed-agents", {
      name: `t-${crypto.randomUUID().slice(0, 6)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error ?? res.body).toMatch(/provision-agents/);
  });

  it("granted: provisions a teammate forced into own org + own manager, stamped source=agent-api + createdBy", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    expect((await grant(app, actor.accessToken, actor.agent.uuid, [PROVISION])).statusCode).toBe(200);

    const name = `mate-${crypto.randomUUID().slice(0, 6)}`;
    // Body tries to widen scope — the narrow schema + server forcing must ignore it.
    const res = await actor.request("POST", "/api/v1/agent/managed-agents", {
      name,
      organizationId: "some-other-org",
      managerId: "some-other-member",
      type: "human",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe(name);
    expect(body.type).toBe("agent");
    expect(body.source).toBe("agent-api");
    expect(body.organizationId).toBe(actor.organizationId);
    expect(body.managerId).toBe(actor.memberId);
    expect(body.createdBy).toMatchObject({ agentId: actor.agent.uuid, memberId: actor.memberId });

    // Confirm persisted scope, not just the response.
    const [row] = await app.db.select().from(agents).where(eq(agents.uuid, body.uuid)).limit(1);
    expect(row?.organizationId).toBe(actor.organizationId);
    expect(row?.managerId).toBe(actor.memberId);
    expect(row?.source).toBe("agent-api");
  });

  it("member create route rejects an SDK-mediated call (X-Agent-Id) but allows the operator (no header)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    // Even WITH the capability granted, the ungated member route must refuse an
    // agent-context call so the capability gate can't be sidestepped.
    await grant(app, actor.accessToken, actor.agent.uuid, [PROVISION]);

    const orgUrl = `/api/v1/orgs/${actor.organizationId}/agents`;
    const payload = { name: `viamember-${crypto.randomUUID().slice(0, 6)}`, type: "agent", clientId: actor.clientId };

    // With X-Agent-Id → funnelled away (403).
    const agentCtx = await actor.request("POST", orgUrl, payload);
    expect(agentCtx.statusCode).toBe(403);
    expect(agentCtx.json().error ?? agentCtx.body).toMatch(/managed-agents/);

    // Same operator token WITHOUT X-Agent-Id → the human path still works (201).
    const operator = await app.inject({
      method: "POST",
      url: orgUrl,
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload,
    });
    expect(operator.statusCode).toBe(201);
  });

  it("grant is admin-only: a non-admin manager is refused (403)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    // Demote the caller to a plain member; they still MANAGE the agent.
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, actor.memberId));

    const res = await grant(app, actor.accessToken, actor.agent.uuid, [PROVISION]);
    expect(res.statusCode).toBe(403);
    expect(res.json().error ?? res.body).toMatch(/admin/i);
  });

  it("grant refuses an SDK-mediated (X-Agent-Id) call even from an admin (defense-in-depth)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });

    const res = await actor.request("PATCH", `/api/v1/agents/${actor.agent.uuid}/capabilities`, {
      capabilities: [PROVISION],
    });
    expect(res.statusCode).toBe(403);
  });

  it("self-grant via the free-form metadata field is rejected (reserved key)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${actor.agent.uuid}`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { metadata: { agentCapabilities: [PROVISION] } },
    });
    expect(res.statusCode).toBe(400);
    // The reserved-key rejection detail lives in the Zod issues (details[]).
    expect(JSON.stringify(res.json())).toMatch(/reserved|agentCapabilities/i);
  });

  it("read-back: an admin can read the grant + provisioning provenance (not write-only)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    await grant(app, actor.accessToken, actor.agent.uuid, [PROVISION]);

    // Acting agent: has the capability, no provenance (it was operator-created).
    const actorCaps = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${actor.agent.uuid}/capabilities`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
    });
    expect(actorCaps.statusCode).toBe(200);
    expect(actorCaps.json().agentCapabilities).toEqual([PROVISION]);
    expect(actorCaps.json().createdBy).toBeNull();

    // Provision a teammate, then read ITS provenance back as admin.
    const created = await actor.request("POST", "/api/v1/agent/managed-agents", {
      name: `mate-${crypto.randomUUID().slice(0, 6)}`,
    });
    const teammateUuid = created.json().uuid;
    const mateCaps = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${teammateUuid}/capabilities`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
    });
    expect(mateCaps.statusCode).toBe(200);
    expect(mateCaps.json().agentCapabilities).toEqual([]);
    expect(mateCaps.json().createdBy).toMatchObject({ agentId: actor.agent.uuid });
  });

  it("the capability survives a later public-metadata update (preserved reserved key)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    await grant(app, actor.accessToken, actor.agent.uuid, [PROVISION]);

    // A normal metadata edit must NOT wipe the reserved grant.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${actor.agent.uuid}`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { metadata: { note: "hello" } },
    });
    expect(patch.statusCode).toBe(200);

    const caps = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${actor.agent.uuid}/capabilities`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
    });
    expect(caps.json().agentCapabilities).toEqual([PROVISION]);
  });

  it("rejects an unknown capability value at the edge (400)", async () => {
    const app = getApp();
    const actor = await createTestAgent(app, { name: `actor-${crypto.randomUUID().slice(0, 6)}` });
    const res = await grant(app, actor.accessToken, actor.agent.uuid, ["make-me-root"]);
    expect(res.statusCode).toBe(400);
  });
});
