import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentProvisioningAudit } from "../db/schema/agent-provisioning-audit.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("agent-executable provisioning", () => {
  const getApp = useTestApp({ runtimeHttpTokenEnforcement: true });

  it("requires the capability, creates with initial settings, and writes an audit row", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `provision-${crypto.randomUUID().slice(0, 8)}` });
    const actor = await createAgent(app.db, {
      name: "provisioner",
      type: "agent",
      organizationId: admin.organizationId,
      managerId: admin.memberId,
      clientId: admin.clientId,
      runtimeProvider: "codex",
    });
    const runtimeToken = await bindAgentRuntimeSession(app.db, actor.uuid, admin.clientId);
    const headers = {
      authorization: `Bearer ${admin.accessToken}`,
      "x-first-tree-acting-agent": actor.uuid,
      "x-agent-runtime-session": runtimeToken,
      "x-first-tree-chat-id": "chat-provisioning",
      "x-first-tree-session-id": "session-provisioning",
    };

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers,
      payload: { name: "worker-denied", type: "agent", clientId: admin.clientId, runtimeProvider: "codex" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/not authorized to provision/i);

    const missingActorHeader = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "x-agent-runtime-session": runtimeToken,
      },
      payload: { name: "worker-missing-actor", type: "agent", clientId: admin.clientId },
    });
    expect(missingActorHeader.statusCode).toBe(403);
    expect(missingActorHeader.json().error).toMatch(/not authorized|active runtime session/i);

    const grant = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${actor.uuid}/provisioning-capability`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: true },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().canProvisionAgents).toBe(true);

    const derivedActor = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "x-agent-runtime-session": runtimeToken,
      },
      payload: { name: "worker-derived-actor", type: "agent", clientId: admin.clientId, runtimeProvider: "codex" },
    });
    expect(derivedActor.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers,
      payload: {
        name: "worker-created",
        type: "agent",
        clientId: admin.clientId,
        runtimeProvider: "codex",
        model: "gpt-5.6-codex",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{ uuid: string; managerId: string }>();
    expect(createdBody.managerId).toBe(admin.memberId);

    const [config] = await app.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, createdBody.uuid))
      .limit(1);
    expect(config?.payload.model).toBe("gpt-5.6-codex");
    const resources = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${createdBody.uuid}/resources`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(resources.statusCode).toBe(200);
    const promptSet = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${createdBody.uuid}/resources`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        expectedVersion: resources.json<{ version: number }>().version,
        bindings: [{ type: "prompt", mode: "include", resourceId: null, inlinePromptBody: "You are a reviewer." }],
      },
    });
    expect(promptSet.statusCode).toBe(200);
    expect(promptSet.json().bindings).toEqual([
      expect.objectContaining({ type: "prompt", inlinePromptBody: "You are a reviewer." }),
    ]);
    const [audit] = await app.db
      .select()
      .from(agentProvisioningAudit)
      .where(eq(agentProvisioningAudit.createdAgentId, createdBody.uuid))
      .limit(1);
    expect(audit).toMatchObject({
      actingAgentId: actor.uuid,
      managingMemberId: admin.memberId,
      createdAgentId: createdBody.uuid,
      chatId: null,
      sessionId: null,
    });
  });

  it("revocation takes effect immediately and invalid runtime proofs are rejected", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `revoke-${crypto.randomUUID().slice(0, 8)}` });
    const actor = await createAgent(app.db, {
      name: "revoked-provisioner",
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const delegatedGrant = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${actor.uuid}/provisioning-capability`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "x-first-tree-acting-agent": actor.uuid,
      },
      payload: { enabled: true },
    });
    expect(delegatedGrant.statusCode).toBe(403);
    await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${actor.uuid}/provisioning-capability`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: true },
    });

    const invalidProof = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "x-first-tree-acting-agent": actor.uuid,
        "x-agent-runtime-session": "invalid",
      },
      payload: { name: "invalid-proof", type: "agent", clientId: admin.clientId },
    });
    expect(invalidProof.statusCode).toBe(403);
    expect(invalidProof.json().error).toMatch(/active runtime session/i);

    const revoke = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${actor.uuid}/provisioning-capability`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: false },
    });
    expect(revoke.statusCode).toBe(200);
    const runtimeToken = await bindAgentRuntimeSession(app.db, actor.uuid, admin.clientId);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "x-first-tree-acting-agent": actor.uuid,
        "x-agent-runtime-session": runtimeToken,
      },
      payload: { name: "after-revoke", type: "agent", clientId: admin.clientId },
    });
    expect(denied.statusCode).toBe(403);
  });
});
