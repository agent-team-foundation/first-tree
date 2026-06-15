import { createHmac } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents as agentsTable } from "../db/schema/agents.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { members as membersTable } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import {
  bindInstallationToOrg,
  findInstallationByGithubId,
  upsertInstallationFromMetadata,
} from "../services/github-app-installations.js";
import { ensureActiveInvitation } from "../services/invitation.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const APP_WEBHOOK_SECRET = "test-app-webhook-secret";

function signGithubWebhookBody(body: string): string {
  return `sha256=${createHmac("sha256", APP_WEBHOOK_SECRET).update(body).digest("hex")}`;
}

describe("DELETE /api/v1/orgs/:orgId", () => {
  const getApp = useTestApp();

  async function createSecondaryOrg(app: FastifyInstance, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        name: `delete-org-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Delete Me",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{ organization: { id: string } }>();
    return body.organization.id;
  }

  it("lets an org admin delete a non-default org and removes it from active access", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-delete-admin-${crypto.randomUUID().slice(0, 8)}` });
    const orgId = await createSecondaryOrg(app, admin);
    const installationId = Number.parseInt(crypto.randomUUID().slice(0, 8), 16);

    const memberRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        username: `org-delete-extra-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Extra Member",
        role: "member",
      },
    });
    expect(memberRes.statusCode).toBe(201);
    const { username, password } = memberRes.json<{ username: string; password: string }>();
    const memberLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    expect(memberLoginRes.statusCode).toBe(200);
    const memberAccessToken = memberLoginRes.json<{ accessToken: string }>().accessToken;
    const connectTokenRes = await app.inject({
      method: "POST",
      url: "/api/v1/me/connect-tokens",
      headers: { authorization: `Bearer ${memberAccessToken}` },
    });
    expect(connectTokenRes.statusCode).toBe(200);
    const connectToken = connectTokenRes.json<{ token: string }>().token;
    const invitation = await ensureActiveInvitation(app.db, orgId, admin.userId);

    const [adminOrgMember] = await app.db
      .select({ memberId: membersTable.id, agentId: membersTable.agentId })
      .from(membersTable)
      .where(
        and(
          eq(membersTable.userId, admin.userId),
          eq(membersTable.organizationId, orgId),
          eq(membersTable.status, "active"),
        ),
      )
      .limit(1);
    if (!adminOrgMember) throw new Error("expected admin membership in secondary org");
    const [peerAgent] = await app.db
      .select({ uuid: agentsTable.uuid })
      .from(agentsTable)
      .where(and(eq(agentsTable.organizationId, orgId), ne(agentsTable.uuid, adminOrgMember.agentId)))
      .limit(1);
    if (!peerAgent) throw new Error("expected peer agent in secondary org");
    const { chatId } = await createMeChat(app.db, adminOrgMember.agentId, orgId, {
      participantIds: [peerAgent.uuid],
    });

    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "delete-org",
        accountGithubId: installationId,
        permissions: { contents: "read" },
        events: ["issues"],
        suspendedAt: null,
      },
    });
    await bindInstallationToOrg(app.db, installationId, orgId);

    const previewRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/delete-preview`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json<{ activeMemberCount: number; agentCount: number; historyRetained: boolean }>();
    expect(preview.activeMemberCount).toBe(2);
    expect(preview.agentCount).toBeGreaterThanOrEqual(2);
    expect(preview.historyRetained).toBe(true);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual(preview);

    const orgsRes = await app.inject({
      method: "GET",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const orgs = orgsRes.json<Array<{ id: string }>>();
    expect(orgs.some((org) => org.id === orgId)).toBe(false);

    const readDeletedRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(readDeletedRes.statusCode).toBe(403);

    await app.db.update(membersTable).set({ status: "active" }).where(eq(membersTable.id, adminOrgMember.memberId));
    const readDeletedChatRes = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(readDeletedChatRes.statusCode).toBe(404);
    await app.db.update(membersTable).set({ status: "left" }).where(eq(membersTable.id, adminOrgMember.memberId));

    const [orgRow] = await app.db
      .select({ status: organizations.status, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(orgRow?.status).toBe("deleted");
    expect(orgRow?.name).toBe(`deleted-${orgId}`);

    const memberRows = await app.db
      .select({ status: membersTable.status })
      .from(membersTable)
      .where(eq(membersTable.organizationId, orgId));
    expect(memberRows.length).toBeGreaterThan(0);
    expect(memberRows.every((row) => row.status === "left")).toBe(true);

    const agentRows = await app.db
      .select({ status: agentsTable.status, name: agentsTable.name })
      .from(agentsTable)
      .where(eq(agentsTable.organizationId, orgId));
    expect(agentRows.length).toBeGreaterThan(0);
    expect(agentRows.every((row) => row.status === "deleted" && row.name === null)).toBe(true);

    const [installationAfterDelete] = await app.db
      .select({ hubOrganizationId: githubAppInstallations.hubOrganizationId })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(installationAfterDelete?.hubOrganizationId).toBeNull();

    const webhookBody = JSON.stringify({
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    const webhookAfterDelete = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github-app",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": signGithubWebhookBody(webhookBody),
      },
      payload: webhookBody,
    });
    expect(webhookAfterDelete.statusCode).toBe(200);
    expect(webhookAfterDelete.json().ignored).toBe("installation not bound");

    const reboundOrgId = await createSecondaryOrg(app, admin);
    await expect(bindInstallationToOrg(app.db, installationId, reboundOrgId)).resolves.toBe(true);
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBe(reboundOrgId);

    const invitePreviewAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/invitations/${invitation.token}/preview`,
    });
    expect(invitePreviewAfterDelete.statusCode).toBe(404);

    const joinAfterDelete = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations/join",
      headers: { authorization: `Bearer ${memberAccessToken}` },
      payload: { token: invitation.token },
    });
    expect(joinAfterDelete.statusCode).toBe(404);

    const connectExchangeAfterDelete = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connect-token",
      payload: { token: connectToken },
    });
    expect(connectExchangeAfterDelete.statusCode).toBe(401);
  });

  it("rejects deletion by a non-admin member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-delete-owner-${crypto.randomUUID().slice(0, 8)}` });
    const orgId = await createSecondaryOrg(app, admin);

    const memberRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        username: `org-delete-member-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Plain Member",
        role: "member",
      },
    });
    expect(memberRes.statusCode).toBe(201);
    const { username, password } = memberRes.json<{ username: string; password: string }>();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = loginRes.json<{ accessToken: string }>();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("rejects deletion of the reserved default org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `org-delete-default-${crypto.randomUUID().slice(0, 8)}` });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${admin.organizationId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(deleteRes.statusCode).toBe(400);
  });
});
