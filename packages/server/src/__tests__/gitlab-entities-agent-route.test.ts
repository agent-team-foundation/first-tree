import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { createGitlabConnection } from "../services/gitlab-connections.js";
import {
  listVisibleChatGitlabEntities,
  observeGitlabEntityAndResolveFollowers,
} from "../services/gitlab-entity-follow.js";
import { createGitlabIdentityLink } from "../services/gitlab-identities.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("GitLab entity attention agent routes", () => {
  const getApp = useTestApp();

  async function createRuntimeChat() {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `gitlab-follow-${randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    return { app, runtime, chatId };
  }

  it("fails before writing when the Team has no current GitLab connection", async () => {
    const { app, runtime, chatId } = await createRuntimeChat();
    const response = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: "https://gitlab.example/acme/api/-/issues/42",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/connection is not configured/i) });
    expect(
      await app.db.select().from(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.chatId, chatId)),
    ).toHaveLength(0);
  });

  it("accepts both GitLab route shapes and preserves the latest explicitly followed URL", async () => {
    const { app, runtime, chatId } = await createRuntimeChat();
    await createGitlabConnection(app.db, {
      organizationId: runtime.organizationId,
      memberId: runtime.memberId,
      displayName: "Private GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const dashedIssueUrl = "https://gitlab.internal/Acme/API/-/issues/41";
    const workingIssueUrl = "https://gitlab.internal/Acme/API/issues/41";

    const initial = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: dashedIssueUrl,
    });
    expect(initial.statusCode).toBe(201);
    expect(initial.json()).toMatchObject({ status: "created", entity: { entityUrl: dashedIssueUrl } });

    const corrected = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: workingIssueUrl,
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      status: "already_following",
      entity: {
        entityType: "issue",
        entityIid: 41,
        projectPath: "Acme/API",
        entityUrl: workingIssueUrl,
      },
    });
    expect((await runtime.request("GET", `/api/v1/agent/chats/${chatId}/gitlab-entities`)).json()).toMatchObject({
      items: [{ entityUrl: workingIssueUrl }],
    });

    const removedByAlias = await runtime.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/gitlab-entities?entity=${encodeURIComponent(dashedIssueUrl)}`,
    );
    expect(removedByAlias.json()).toEqual({ removed: 1 });

    const workingMergeRequestUrl = "https://gitlab.internal/Acme/API/merge_requests/42";
    const fresh = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: workingMergeRequestUrl,
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json()).toMatchObject({
      status: "created",
      entity: { entityType: "pull_request", entityIid: 42, entityUrl: workingMergeRequestUrl },
    });
  });

  it("follows, projects, activates, multi-follows, and URL-unfollows without leaking internal fields", async () => {
    const { app, runtime, chatId } = await createRuntimeChat();
    const second = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const connection = await createGitlabConnection(app.db, {
      organizationId: runtime.organizationId,
      memberId: runtime.memberId,
      displayName: "Private GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const entityUrl = "https://gitlab.internal/Acme/API/-/merge_requests/42";

    const first = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, { entityUrl });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({
      status: "created",
      entity: {
        entityType: "pull_request",
        entityUrl,
        projectPath: "Acme/API",
        entityIid: 42,
        title: null,
        state: null,
        status: "pending",
        boundVia: "agent_declared",
      },
    });

    const repeated = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, { entityUrl });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ status: "already_following", entity: { status: "pending" } });

    const secondChatFollow = await runtime.request("POST", `/api/v1/agent/chats/${second.chatId}/gitlab-entities`, {
      entityUrl,
    });
    expect(secondChatFollow.statusCode).toBe(409);
    expect(secondChatFollow.json()).toMatchObject({
      error: "ENTITY_FOLLOWED_ELSEWHERE",
      conflict: { chatId },
    });

    const pendingList = await runtime.request("GET", `/api/v1/agent/chats/${chatId}/gitlab-entities`);
    expect(pendingList.statusCode).toBe(200);
    expect(pendingList.json()).toEqual({ items: [first.json().entity] });
    expect(JSON.stringify(pendingList.json())).not.toMatch(
      /connectionId|organizationId|declaredByAgentId|projectPathNormalized|mappingId|createdAt|updatedAt/,
    );

    const wrongOrigin = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: "https://other.example/Acme/API/-/issues/7",
    });
    expect(wrongOrigin.statusCode).toBe(400);
    const unsupported = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: "https://gitlab.internal/Acme/API/-/pipelines/7",
    });
    expect(unsupported.statusCode).toBe(400);
    const rowsBeforeControlCharacter = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.connectionId, connection.connectionId));
    const controlCharacter = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: "https://gitlab.internal/Acme/%00API/-/issues/7",
    });
    expect(controlCharacter.statusCode).toBe(400);
    expect(controlCharacter.json()).toMatchObject({ error: expect.stringMatching(/control characters/i) });
    expect(
      await app.db
        .select()
        .from(gitlabEntityChatMappings)
        .where(eq(gitlabEntityChatMappings.connectionId, connection.connectionId)),
    ).toHaveLength(rowsBeforeControlCharacter.length);
    const internalField = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl,
      connectionId: connection.connectionId,
    });
    expect(internalField.statusCode).toBe(400);

    await observeGitlabEntityAndResolveFollowers(app.db, connection.connectionId, {
      entityType: "pull_request",
      entityIid: 42,
      projectId: 501,
      projectPath: "Acme/API",
      entityUrl,
      title: "Ship GitLab attention",
      entityState: "open",
    });
    const activeList = await runtime.request("GET", `/api/v1/agent/chats/${chatId}/gitlab-entities`);
    expect(activeList.json()).toMatchObject({
      items: [{ status: "active", title: "Ship GitLab attention", state: "open" }],
    });

    const identity = await createGitlabIdentityLink(app.db, {
      organizationId: runtime.organizationId,
      connectionId: connection.connectionId,
      membershipId: runtime.memberId,
      username: "reviewer.one",
    });
    await app.db.insert(gitlabEntityChatMappings).values({
      id: `identity-${randomUUID()}`,
      organizationId: runtime.organizationId,
      connectionId: connection.connectionId,
      chatId,
      declaredByAgentId: runtime.humanAgentUuid,
      boundVia: "identity_target",
      identityLinkId: identity.id,
      humanAgentId: runtime.humanAgentUuid,
      delegateAgentId: runtime.agent.uuid,
      active: true,
      entityType: "pull_request",
      entityIid: 42,
      projectId: 501,
      projectPath: "Acme/API",
      projectPathNormalized: "acme/api",
      entityUrl,
      title: "Ship GitLab attention",
      entityState: "opened",
    });
    expect(await listVisibleChatGitlabEntities(app.db, chatId)).toMatchObject({
      items: [
        {
          entityType: "pull_request",
          entityUrl,
          projectPath: "Acme/API",
          entityIid: 42,
          title: "Ship GitLab attention",
          state: "open",
          status: "active",
        },
      ],
    });
    const automaticUrl = "https://gitlab.internal/Acme/API/-/merge_requests/43";
    await app.db.insert(gitlabEntityChatMappings).values({
      id: `identity-${randomUUID()}`,
      organizationId: runtime.organizationId,
      connectionId: connection.connectionId,
      chatId,
      declaredByAgentId: runtime.humanAgentUuid,
      boundVia: "identity_target",
      identityLinkId: identity.id,
      humanAgentId: runtime.humanAgentUuid,
      delegateAgentId: runtime.agent.uuid,
      active: true,
      entityType: "pull_request",
      entityIid: 43,
      projectId: 501,
      projectPath: "Acme/API",
      projectPathNormalized: "acme/api",
      entityUrl: automaticUrl,
      title: "Automatic reviewer route",
      entityState: "open",
    });
    const automaticList = await runtime.request("GET", `/api/v1/agent/chats/${chatId}/gitlab-entities`);
    expect(automaticList.json()).toMatchObject({
      items: [
        { entityIid: 42 },
        {
          entityIid: 43,
          entityUrl: automaticUrl,
          boundVia: "identity_target",
          status: "active",
        },
      ],
    });
    const repeatAutomaticFollow = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      entityUrl: automaticUrl,
    });
    expect(repeatAutomaticFollow.statusCode).toBe(200);
    expect(repeatAutomaticFollow.json()).toMatchObject({
      status: "already_following",
      entity: { entityIid: 43, boundVia: "identity_target" },
    });
    const automaticRemoval = await runtime.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/gitlab-entities?entity=${encodeURIComponent(automaticUrl)}`,
    );
    expect(automaticRemoval.json()).toEqual({ removed: 1 });

    const removed = await runtime.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/gitlab-entities?entity=${encodeURIComponent(entityUrl)}`,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: 2 });

    const rebindSourceUrl = "https://gitlab.internal/Acme/API/-/issues/99";
    expect(
      (
        await runtime.request("POST", `/api/v1/agent/chats/${chatId}/gitlab-entities`, {
          entityUrl: rebindSourceUrl,
        })
      ).statusCode,
    ).toBe(201);
    const rebound = await runtime.request("POST", `/api/v1/agent/chats/${second.chatId}/gitlab-entities`, {
      entityUrl: rebindSourceUrl,
      rebind: true,
    });
    expect(rebound.statusCode).toBe(201);
    expect(rebound.json()).toMatchObject({ status: "rebound", entity: { entityIid: 99 } });
    const repeatedRemoval = await runtime.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/gitlab-entities?entity=${encodeURIComponent(entityUrl)}`,
    );
    expect(repeatedRemoval.json()).toEqual({ removed: 0 });
    expect((await runtime.request("GET", `/api/v1/agent/chats/${chatId}/gitlab-entities`)).json()).toEqual({
      items: [],
    });

    const remainingFirstChatRows = await app.db
      .select({ boundVia: gitlabEntityChatMappings.boundVia })
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, connection.connectionId),
          eq(gitlabEntityChatMappings.chatId, chatId),
          eq(gitlabEntityChatMappings.active, true),
        ),
      );
    expect(remainingFirstChatRows).toEqual([]);

    expect(
      await app.db
        .select()
        .from(gitlabEntityChatMappings)
        .where(
          and(
            eq(gitlabEntityChatMappings.connectionId, connection.connectionId),
            eq(gitlabEntityChatMappings.chatId, second.chatId),
          ),
        ),
    ).toHaveLength(1);
  });
});
