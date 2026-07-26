import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { backfillGitlabAttentionPairs } from "../services/gitlab-attention-backfill.js";
import { createGitlabConnection, hashGitlabUrlBearer, withGitlabIngressFence } from "../services/gitlab-connections.js";
import {
  declareGitlabEntityFollowWithStatus,
  observeGitlabEntityAndResolveFollowers,
} from "../services/gitlab-entity-follow.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("GitLab attention pair controlled backfill", () => {
  const getApp = useTestApp();

  it("pairs only deterministic legacy declarations and leaves ambiguous rows route-only", async () => {
    const app = getApp();
    const primary = await createTestAgent(app, { name: `backfill-primary-${randomUUID().slice(0, 8)}` });
    const secondary = await createTestAgent(app, { name: `backfill-secondary-${randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, primary.humanAgentUuid, primary.organizationId, {
      participantIds: [primary.agent.uuid],
    });
    await app.db.insert(chatMembership).values([
      {
        chatId,
        agentId: secondary.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
      },
      {
        chatId,
        agentId: secondary.agent.uuid,
        role: "member",
        accessMode: "speaker",
      },
    ]);
    await app.db
      .update(agents)
      .set({ delegateMention: primary.agent.uuid })
      .where(eq(agents.uuid, primary.humanAgentUuid));
    const connection = await createGitlabConnection(app.db, {
      organizationId: primary.organizationId,
      memberId: primary.memberId,
      displayName: "Backfill GitLab",
      instanceOrigin: "https://gitlab.internal",
    });

    const base = {
      organizationId: primary.organizationId,
      connectionId: connection.connectionId,
      chatId,
      active: true,
      entityType: "issue",
      projectId: null,
      projectPath: "Acme/API",
      projectPathNormalized: "acme/api",
      title: null,
      entityState: "open",
    };
    await app.db.insert(gitlabEntityChatMappings).values([
      {
        ...base,
        id: `legacy-agent-${randomUUID()}`,
        declaredByAgentId: primary.agent.uuid,
        boundVia: "agent_declared",
        entityIid: 41,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/41",
      },
      {
        ...base,
        id: `legacy-human-${randomUUID()}`,
        declaredByAgentId: primary.humanAgentUuid,
        boundVia: "human_declared",
        entityIid: 42,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
      },
      {
        ...base,
        id: `legacy-ambiguous-${randomUUID()}`,
        declaredByAgentId: secondary.agent.uuid,
        boundVia: "agent_declared",
        entityIid: 43,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/43",
      },
      {
        ...base,
        id: `legacy-pending-ambiguous-${randomUUID()}`,
        declaredByAgentId: secondary.agent.uuid,
        boundVia: "agent_declared",
        active: false,
        entityIid: 44,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/44",
      },
    ]);

    await expect(backfillGitlabAttentionPairs(app.db)).resolves.toEqual({
      paired: 2,
      legacyRouteOnly: 2,
    });
    const rows = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.chatId, chatId));
    expect(rows.find((row) => row.entityIid === 41)).toMatchObject({
      humanAgentId: primary.humanAgentUuid,
      delegateAgentId: primary.agent.uuid,
      attentionMode: "paired",
      attentionBackfillVersion: 1,
    });
    expect(rows.find((row) => row.entityIid === 42)).toMatchObject({
      humanAgentId: primary.humanAgentUuid,
      delegateAgentId: primary.agent.uuid,
      attentionMode: "paired",
      attentionBackfillVersion: 1,
    });
    expect(rows.find((row) => row.entityIid === 43)).toMatchObject({
      humanAgentId: null,
      delegateAgentId: null,
      attentionMode: "legacy_route_only",
      attentionBackfillVersion: 1,
    });
    expect(rows.find((row) => row.entityIid === 44)).toMatchObject({
      active: false,
      humanAgentId: null,
      delegateAgentId: null,
      attentionMode: "legacy_route_only",
      attentionBackfillVersion: 1,
    });
    await app.db
      .update(agents)
      .set({ delegateMention: secondary.agent.uuid })
      .where(eq(agents.uuid, secondary.humanAgentUuid));
    await expect(backfillGitlabAttentionPairs(app.db)).resolves.toEqual({
      paired: 0,
      legacyRouteOnly: 0,
    });
    const [stillLegacy] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.entityIid, 43));
    expect(stillLegacy).toMatchObject({
      humanAgentId: null,
      delegateAgentId: null,
      attentionMode: "legacy_route_only",
      attentionBackfillVersion: 1,
    });
    const [stillPendingLegacy] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.entityIid, 44));
    expect(stillPendingLegacy).toMatchObject({
      active: false,
      humanAgentId: null,
      delegateAgentId: null,
      attentionMode: "legacy_route_only",
      attentionBackfillVersion: 1,
    });
  });

  it("marks the same pair and entity in two legacy chats ambiguous instead of choosing a home", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `backfill-duplicate-${randomUUID().slice(0, 8)}` });
    await app.db
      .update(agents)
      .set({ delegateMention: runtime.agent.uuid })
      .where(eq(agents.uuid, runtime.humanAgentUuid));
    const first = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const second = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const connection = await createGitlabConnection(app.db, {
      organizationId: runtime.organizationId,
      memberId: runtime.memberId,
      displayName: "Duplicate Backfill GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const base = {
      organizationId: runtime.organizationId,
      connectionId: connection.connectionId,
      declaredByAgentId: runtime.agent.uuid,
      boundVia: "agent_declared",
      active: true,
      entityType: "issue",
      entityIid: 51,
      projectId: null,
      projectPath: "Acme/API",
      projectPathNormalized: "acme/api",
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/51",
      title: null,
      entityState: "open",
    };
    await app.db.insert(gitlabEntityChatMappings).values([
      { ...base, id: `legacy-first-${randomUUID()}`, chatId: first.chatId },
      { ...base, id: `legacy-second-${randomUUID()}`, chatId: second.chatId },
    ]);

    await expect(backfillGitlabAttentionPairs(app.db)).resolves.toEqual({
      paired: 0,
      legacyRouteOnly: 2,
    });
    const rows = await app.db.select().from(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.entityIid, 51));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: first.chatId,
          humanAgentId: null,
          attentionMode: "legacy_route_only",
          attentionBackfillVersion: 1,
        }),
        expect.objectContaining({
          chatId: second.chatId,
          humanAgentId: null,
          attentionMode: "legacy_route_only",
          attentionBackfillVersion: 1,
        }),
      ]),
    );
  });

  it("serializes classification with live follow and ingress observation", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `backfill-race-${randomUUID().slice(0, 8)}` });
    await app.db
      .update(agents)
      .set({ delegateMention: runtime.agent.uuid })
      .where(eq(agents.uuid, runtime.humanAgentUuid));
    const { chatId } = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const connection = await createGitlabConnection(app.db, {
      organizationId: runtime.organizationId,
      memberId: runtime.memberId,
      displayName: "Concurrent Backfill GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const entityUrl = "https://gitlab.internal/Acme/API/-/issues/61";
    await app.db.insert(gitlabEntityChatMappings).values({
      id: `legacy-race-${randomUUID()}`,
      organizationId: runtime.organizationId,
      connectionId: connection.connectionId,
      chatId,
      declaredByAgentId: runtime.agent.uuid,
      boundVia: "agent_declared",
      active: true,
      entityType: "issue",
      entityIid: 61,
      projectId: null,
      projectPath: "Acme/API",
      projectPathNormalized: "acme/api",
      entityUrl,
      title: null,
      entityState: "open",
    });

    await Promise.all([
      backfillGitlabAttentionPairs(app.db),
      declareGitlabEntityFollowWithStatus(app.db, {
        organizationId: runtime.organizationId,
        connectionId: connection.connectionId,
        chatId,
        declaredByAgentId: runtime.agent.uuid,
        humanAgentId: runtime.humanAgentUuid,
        delegateAgentId: runtime.agent.uuid,
        entityUrl,
        rebind: false,
      }),
      withGitlabIngressFence(app.db, connection.connectionId, hashGitlabUrlBearer(connection.bearer), async (tx) =>
        observeGitlabEntityAndResolveFollowers(tx, connection.connectionId, {
          entityType: "issue",
          entityIid: 61,
          projectId: 701,
          projectPath: "Acme/API",
          entityUrl,
          title: "Concurrent classification",
          entityState: "open",
        }),
      ),
    ]);

    const rows = await app.db.select().from(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.entityIid, 61));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chatId,
      projectId: 701,
      humanAgentId: runtime.humanAgentUuid,
      delegateAgentId: runtime.agent.uuid,
      attentionMode: "paired",
      attentionBackfillVersion: 1,
    });
  });
});
