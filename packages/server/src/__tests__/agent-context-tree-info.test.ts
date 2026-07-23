import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import * as orgSettingsService from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedClient, useTestApp } from "./helpers.js";

describe("agent context tree info route", () => {
  const getApp = useTestApp();

  it("uses the authenticated agent org, not the caller primary org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const sideOrgId = `org-agent-ct-${crypto.randomUUID().slice(0, 8)}`;
    const sideMemberId = uuidv7();

    await app.db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: sideOrgId,
        name: `agent-ct-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Agent Context Tree Org",
      });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `agent-ct-human-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Agent Context Tree Human",
        managerId: sideMemberId,
        organizationId: sideOrgId,
      });
      await tx.insert(members).values({
        id: sideMemberId,
        userId: admin.userId,
        organizationId: sideOrgId,
        agentId: humanAgent.uuid,
        role: "admin",
      });
    });
    await app.db
      .update(members)
      .set({ createdAt: new Date(Date.now() + 1_000) })
      .where(eq(members.id, admin.memberId));

    const sideClientId = await seedClient(app, admin.userId, sideOrgId);
    const sideAgent = await createAgent(app.db, {
      name: `agent-ct-runtime-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Agent Context Tree Runtime",
      managerId: sideMemberId,
      organizationId: sideOrgId,
      clientId: sideClientId,
    });
    const installationId = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 10), 16);
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "example",
        accountGithubId: installationId + 1,
        permissions: { metadata: "read", pull_requests: "write" },
        events: ["pull_request"],
        suspendedAt: null,
      },
      hubOrganizationId: sideOrgId,
    });

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/default-context", branch: "main" },
      { updatedBy: admin.userId },
    );
    await orgSettingsService.putOrgSetting(
      app.db,
      sideOrgId,
      "context_tree",
      { repo: "https://github.com/example/side-context", branch: "side" },
      { updatedBy: admin.userId },
    );
    await orgSettingsService.putOrgSetting(
      app.db,
      sideOrgId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: sideAgent.uuid } },
      { updatedBy: admin.userId, memberId: sideMemberId },
    );

    const agentMe = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: { authorization: `Bearer ${admin.accessToken}`, "x-agent-id": sideAgent.uuid },
    });
    expect(agentMe.statusCode).toBe(200);
    const derivedOrgId = agentMe.json<{ organizationId: string }>().organizationId;
    expect(derivedOrgId).toBe(sideOrgId);

    const updatedSide = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${encodeURIComponent(derivedOrgId)}/settings/context_tree`,
      headers: { authorization: `Bearer ${admin.accessToken}`, "x-agent-id": sideAgent.uuid },
      payload: { repo: "git@github.com:example/updated-side-context.git", branch: "updated-side" },
    });
    expect(updatedSide.statusCode).toBe(200);
    expect(updatedSide.json()).toEqual({
      provider: "github",
      repo: "git@github.com:example/updated-side-context.git",
      branch: "updated-side",
    });

    const agentScoped = await app.inject({
      method: "GET",
      url: "/api/v1/agent/context-tree/info",
      headers: { authorization: `Bearer ${admin.accessToken}`, "x-agent-id": sideAgent.uuid },
    });
    expect(agentScoped.statusCode).toBe(200);
    expect(agentScoped.json()).toEqual({
      provider: "github",
      repo: "git@github.com:example/updated-side-context.git",
      branch: "updated-side",
      contextReviewer: { enabled: true, agentUuid: sideAgent.uuid },
    });

    await app.db
      .update(organizationSettings)
      .set({ value: { repo: "http://legacy.example/context-tree.git", branch: "bad..branch" } })
      .where(
        and(eq(organizationSettings.organizationId, sideOrgId), eq(organizationSettings.namespace, "context_tree")),
      );
    const invalidAgentScoped = await app.inject({
      method: "GET",
      url: "/api/v1/agent/context-tree/info",
      headers: { authorization: `Bearer ${admin.accessToken}`, "x-agent-id": sideAgent.uuid },
    });
    expect(invalidAgentScoped.statusCode).toBe(200);
    expect(invalidAgentScoped.json()).toEqual({
      provider: null,
      repo: null,
      branch: null,
      contextReviewer: { enabled: true, agentUuid: sideAgent.uuid },
    });

    const legacyUserScoped = await app.inject({
      method: "GET",
      url: "/api/v1/context-tree/info",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(legacyUserScoped.statusCode).toBe(200);
    expect(legacyUserScoped.json()).toEqual({
      repo: "https://github.com/example/default-context",
      branch: "main",
    });

    await app.db
      .update(organizationSettings)
      .set({ value: { repo: "http://legacy.example/default-context.git", branch: "bad..branch" } })
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    const invalidLegacyUserScoped = await app.inject({
      method: "GET",
      url: "/api/v1/context-tree/info",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(invalidLegacyUserScoped.statusCode).toBe(200);
    expect(invalidLegacyUserScoped.json()).toEqual({ repo: null, branch: null });
  });
});
