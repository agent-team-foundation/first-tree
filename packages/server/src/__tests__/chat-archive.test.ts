/**
 * Unit tests for the chat auto-archive sweeper (`sweepChatArchive`). Covers
 * the two SCM-source branches the sweeper owns:
 *
 *   Mapped branch — SCM-origin chats with complete attention lines: archive
 *                   when every active GitHub/GitLab entity is terminal AND
 *                   `last_message_at` is older than the SCM idle threshold.
 *   No-mapping branch — SCM-origin chats without an SCM mapping: archive
 *                       acknowledged (chat, user) pairs after the same idle
 *                       threshold.
 *
 * Also asserts the shared per-user safety guards: deleted-sticky and
 * already-archived rows are never touched; sweeps are idempotent.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { sweepChatArchive } from "../services/chat-archive.js";
import { createGitlabConnection } from "../services/gitlab-connections.js";
import { createGitlabIdentityLink } from "../services/gitlab-identities.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;
type ChatMetadata = Record<string, unknown>;

function githubMetadata(key = `owner/repo#${randomUUID().slice(0, 8)}`): ChatMetadata {
  return { source: "github", entityType: "pull_request", entityKey: key };
}

function gitlabMetadata(iid: number): ChatMetadata {
  return {
    source: "gitlab",
    entityType: "pull_request",
    entityKey: `701:pull_request:${iid}`,
    entityUrl: `https://gitlab.internal/acme/archive/-/merge_requests/${iid}`,
  };
}

let nextGitlabEntityIid = 10_000;

async function seedHumanAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `human-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "human",
    displayName: "x",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedDelegateAgent(app: App, orgId: string, memberId: string): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `dlg-${uuid.slice(0, 8)}`,
    organizationId: orgId,
    type: "agent",
    displayName: "d",
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

async function seedChat(
  app: App,
  orgId: string,
  lastMessageAt: Date | null,
  metadata: ChatMetadata = githubMetadata(),
): Promise<string> {
  const chatId = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({
    id: chatId,
    organizationId: orgId,
    type: "direct",
    lastMessageAt,
    metadata,
  });
  return chatId;
}

async function addHumanMember(app: App, chatId: string, agentId: string): Promise<void> {
  await app.db.insert(chatMembership).values({
    chatId,
    agentId,
    role: "member",
    accessMode: "speaker",
    source: "manual",
  });
}

async function seedGitlabConnection(app: App, organizationId: string, memberId: string): Promise<string> {
  const connection = await createGitlabConnection(app.db, {
    organizationId,
    memberId,
    displayName: `Archive GitLab ${randomUUID().slice(0, 8)}`,
    instanceOrigin: "https://gitlab.internal",
  });
  return connection.connectionId;
}

async function seedGitlabMapping(
  app: App,
  input: {
    organizationId: string;
    connectionId: string;
    chatId: string;
    declaredByAgentId: string;
    humanAgentId?: string | null;
    delegateAgentId?: string | null;
    entityState: string;
    active?: boolean;
  },
): Promise<void> {
  const iid = nextGitlabEntityIid++;
  const hasCompletePair = input.humanAgentId != null && input.delegateAgentId != null;
  await app.db.insert(gitlabEntityChatMappings).values({
    id: randomUUID(),
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    chatId: input.chatId,
    declaredByAgentId: input.declaredByAgentId,
    boundVia: "agent_declared",
    humanAgentId: input.humanAgentId ?? null,
    delegateAgentId: input.delegateAgentId ?? null,
    attentionMode: hasCompletePair ? "paired" : "legacy_route_only",
    attentionBackfillVersion: hasCompletePair ? 1 : 0,
    active: input.active ?? true,
    entityType: "pull_request",
    entityIid: iid,
    projectId: 701,
    projectPath: "acme/archive",
    projectPathNormalized: "acme/archive",
    entityUrl: `https://gitlab.internal/acme/archive/-/merge_requests/${iid}`,
    title: `Archive MR ${iid}`,
    entityState: input.entityState,
  });
}

async function getEngagement(app: App, chatId: string, agentId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ engagementStatus: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentId)))
    .limit(1);
  return row?.engagementStatus ?? null;
}

const HOURS = 60 * 60;
const longAgo = () => new Date(Date.now() - 48 * HOURS * 1000);
const recent = () => new Date(Date.now() - 5 * 60 * 1000);

describe("sweepChatArchive — mapped SCM branch", () => {
  const getApp = useTestApp();

  it("archives a chat when every mapped entity is terminal and idle > threshold", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#1",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("archives a GitLab-owned chat under the same terminal and idle gates", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, admin.humanAgentUuid));
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Archive GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const link = await createGitlabIdentityLink(app.db, {
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      membershipId: admin.memberId,
      username: "archive.user",
    });
    const chatId = await seedChat(app, admin.organizationId, longAgo(), {
      source: "gitlab",
      entityType: "pull_request",
      entityKey: "501:pull_request:17",
      entityUrl: "https://gitlab.internal/acme/api/-/merge_requests/17",
    });
    await app.db.insert(gitlabEntityChatMappings).values({
      id: randomUUID(),
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      chatId,
      declaredByAgentId: admin.humanAgentUuid,
      boundVia: "identity_target",
      identityLinkId: link.id,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      active: true,
      entityType: "pull_request",
      entityIid: 17,
      projectId: 501,
      projectPath: "acme/api",
      projectPathNormalized: "acme/api",
      entityUrl: "https://gitlab.internal/acme/api/-/merge_requests/17",
      title: "Merged",
      entityState: "merged",
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 1 });
    expect(await getEngagement(app, chatId, admin.humanAgentUuid)).toBe("archived");
  });

  it("keeps a GitLab-owned chat active while any mapped entity remains open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, admin.humanAgentUuid));
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Mixed GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const link = await createGitlabIdentityLink(app.db, {
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      membershipId: admin.memberId,
      username: "mixed.user",
    });
    const chatId = await seedChat(app, admin.organizationId, longAgo(), {
      source: "gitlab",
      entityType: "pull_request",
      entityKey: "502:pull_request:18",
      entityUrl: "https://gitlab.internal/acme/api/-/merge_requests/18",
    });
    await app.db.insert(gitlabEntityChatMappings).values(
      [
        { iid: 18, state: "merged", title: "Merged" },
        { iid: 19, state: "open", title: "Still open" },
      ].map(({ iid, state, title }) => ({
        id: randomUUID(),
        organizationId: admin.organizationId,
        connectionId: connection.connectionId,
        chatId,
        declaredByAgentId: admin.humanAgentUuid,
        boundVia: "identity_target" as const,
        identityLinkId: link.id,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        active: true,
        entityType: "pull_request" as const,
        entityIid: iid,
        projectId: 502,
        projectPath: "acme/api",
        projectPathNormalized: "acme/api",
        entityUrl: `https://gitlab.internal/acme/api/-/merge_requests/${iid}`,
        title,
        entityState: state,
      })),
    );

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 0 });
    expect(await getEngagement(app, chatId, admin.humanAgentUuid)).toBeNull();
  });

  it("keeps a GitLab-origin chat active when GitLab is terminal but GitHub is open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId = await seedGitlabConnection(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo(), gitlabMetadata(21));
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId,
      declaredByAgentId: delegate,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityState: "merged",
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#cross-provider-open",
      chatId,
      boundVia: "agent_declared",
      entityState: "open",
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 0 });
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("keeps a GitHub-origin chat active when GitHub is terminal but GitLab is open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId = await seedGitlabConnection(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#cross-provider-merged",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId,
      declaredByAgentId: delegate,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityState: "open",
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 0 });
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("archives a GitLab-origin chat whose only complete terminal line is GitHub", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo(), gitlabMetadata(22));
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#opposite-only",
      chatId,
      boundVia: "agent_declared",
      entityState: "closed",
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 1 });
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("archives a GitHub-origin chat whose only complete terminal line is GitLab", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId = await seedGitlabConnection(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId,
      declaredByAgentId: delegate,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityState: "merged",
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 1 });
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive mixed-provider mapped chats unless their source is an SCM provider", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId = await seedGitlabConnection(app, admin.organizationId, admin.memberId);
    const manualChatId = await seedChat(app, admin.organizationId, longAgo(), {});
    const agentChatId = await seedChat(app, admin.organizationId, longAgo(), { source: "agent" });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#manual",
        chatId: manualChatId,
        boundVia: "human_declared",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#agent",
        chatId: agentChatId,
        boundVia: "agent_declared",
        entityState: "merged",
      },
    ]);
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId: manualChatId,
      declaredByAgentId: delegate,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityState: "merged",
    });
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId: agentChatId,
      declaredByAgentId: delegate,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, manualChatId, human)).toBeNull();
    expect(await getEngagement(app, agentChatId, human)).toBeNull();
  });

  it("uses active GitLab legacy route-only rows as state guards without inventing archive targets", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId = await seedGitlabConnection(app, admin.organizationId, admin.memberId);

    const routeOnlyChatId = await seedChat(app, admin.organizationId, longAgo(), gitlabMetadata(23));
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId: routeOnlyChatId,
      declaredByAgentId: delegate,
      entityState: "merged",
    });
    await addHumanMember(app, routeOnlyChatId, human);
    await app.db.insert(chatUserState).values({
      chatId: routeOnlyChatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 0,
      lastReadAt: new Date(Date.now() - 24 * HOURS * 1000),
    });

    const guardedChatId = await seedChat(
      app,
      admin.organizationId,
      longAgo(),
      githubMetadata("owner/repo#route-only-guard"),
    );
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#route-only-guard",
      chatId: guardedChatId,
      boundVia: "direct",
      entityState: "merged",
    });
    await seedGitlabMapping(app, {
      organizationId: admin.organizationId,
      connectionId,
      chatId: guardedChatId,
      declaredByAgentId: delegate,
      entityState: "open",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, routeOnlyChatId, human)).toBe("active");
    expect(await getEngagement(app, guardedChatId, human)).toBeNull();
  });

  it.each([
    "github",
    "gitlab",
  ] as const)("applies unread, open-request, working, and blocked guards to complete $provider lines", async (provider) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const connectionId =
      provider === "gitlab" ? await seedGitlabConnection(app, admin.organizationId, admin.memberId) : null;
    const guardCases = [
      { guard: "unread", runtimeState: null },
      { guard: "open-request", runtimeState: null },
      { guard: "working", runtimeState: "working" },
      { guard: "blocked", runtimeState: "blocked" },
    ] as const;
    const chatIds: string[] = [];

    for (const [index, guardCase] of guardCases.entries()) {
      const metadata =
        provider === "github"
          ? githubMetadata(`owner/repo#${provider}-guard-${guardCase.guard}`)
          : gitlabMetadata(30 + index);
      const chatId = await seedChat(app, admin.organizationId, longAgo(), metadata);
      chatIds.push(chatId);

      if (provider === "github") {
        await app.db.insert(githubEntityChatMappings).values({
          organizationId: admin.organizationId,
          humanAgentId: human,
          delegateAgentId: delegate,
          entityType: "pull_request",
          entityKey: `owner/repo#${provider}-guard-${guardCase.guard}`,
          chatId,
          boundVia: "direct",
          entityState: "merged",
        });
      } else {
        if (!connectionId) throw new Error("GitLab connection missing");
        await seedGitlabMapping(app, {
          organizationId: admin.organizationId,
          connectionId,
          chatId,
          declaredByAgentId: delegate,
          humanAgentId: human,
          delegateAgentId: delegate,
          entityState: "merged",
        });
      }

      if (guardCase.guard === "unread" || guardCase.guard === "open-request") {
        await app.db.insert(chatUserState).values({
          chatId,
          agentId: human,
          engagementStatus: "active",
          unreadMentionCount: guardCase.guard === "unread" ? 1 : 0,
          openRequestCount: guardCase.guard === "open-request" ? 1 : 0,
        });
      }
      if (guardCase.runtimeState) {
        await app.db.insert(agentChatSessions).values({
          agentId: delegate,
          chatId,
          state: "active",
          runtimeState: guardCase.runtimeState,
          runtimeStateAt: new Date(),
        });
      }
    }

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 0 });
    await Promise.all(
      chatIds.map(async (chatId) => {
        expect(await getEngagement(app, chatId, human)).not.toBe("archived");
      }),
    );
  });

  it("does not archive mapped chats while any request in the chat is still open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#open-request",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 0,
      openRequestCount: 1,
    });

    const blocked = await sweepChatArchive(app.db);
    expect(blocked.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("active");

    await app.db.update(chatUserState).set({ openRequestCount: 0 }).where(eq(chatUserState.chatId, chatId));

    const unblocked = await sweepChatArchive(app.db);
    expect(unblocked.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive while a session turn is working", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#working",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });
    await app.db.insert(agentChatSessions).values({
      agentId: delegate,
      chatId,
      state: "active",
      runtimeState: "working",
      runtimeStateAt: new Date(),
    });

    expect(await sweepChatArchive(app.db)).toMatchObject({ mappedRowsArchived: 0 });
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("does not archive when any mapped entity is still open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // One merged, one still open → the non-terminal mapping blocks archive.
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#2",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#3",
        chatId,
        boundVia: "direct",
        entityState: "open",
      },
    ]);

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("does not archive when chat is settled but message is recent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, recent());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#4",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("preserves user-deleted state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#5",
      chatId,
      boundVia: "direct",
      entityState: "closed",
    });
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "deleted",
      unreadMentionCount: 0,
    });

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("deleted");
  });

  it("archives chats whose every mapped entity is 'closed' (not just merged)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // Both entities are 'closed' (e.g. issue closed without a fix PR + a closed-unmerged PR).
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#9",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#10",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
    ]);

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not touch sub-chats (parent_chat_id IS NOT NULL)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const parentChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: parentChatId,
      organizationId: admin.organizationId,
      type: "direct",
      lastMessageAt: longAgo(),
      metadata: githubMetadata("owner/repo#parent"),
    });
    // Sub-chat: same shape, but parent_chat_id set. Matches the schema's
    // historical-only scaffolding scenario.
    const subChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: subChatId,
      organizationId: admin.organizationId,
      type: "direct",
      parentChatId,
      lastMessageAt: longAgo(),
      metadata: githubMetadata("owner/repo#11"),
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#11",
      chatId: subChatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, subChatId, human)).toBeNull();
  });

  it("is idempotent under repeated sweeps", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#6",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const first = await sweepChatArchive(app.db);
    const second = await sweepChatArchive(app.db);

    expect(first.mappedRowsArchived).toBe(1);
    expect(second.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("skips a user with unread > 0 while still archiving the other user on the same chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const h1 = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const h2 = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    // Two mapping rows on the same chat — one per (human, delegate, entity).
    // PK includes humanAgentId, so this is permitted.
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: h1,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#14",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: h2,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#14",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
    ]);
    // h1 still has unread (mention or manual mark — both surface here per
    // the semantic overload of unread_mention_count). h2 is fully read.
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: h1,
      engagementStatus: "active",
      unreadMentionCount: 3,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const result = await sweepChatArchive(app.db);

    expect(result.mappedRowsArchived).toBe(1);
    // h1 keeps the explicit active row — guard short-circuits before write.
    expect(await getEngagement(app, chatId, h1)).toBe("active");
    // h2 had no prior row — sweeper materialises one in 'archived'.
    expect(await getEngagement(app, chatId, h2)).toBe("archived");
  });

  it("does not let non-archivable mapped rows consume the mapped batch", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);

    const archivedChatId = await seedChat(
      app,
      admin.organizationId,
      longAgo(),
      githubMetadata("owner/repo#already-archived"),
    );
    const deletedChatId = await seedChat(app, admin.organizationId, longAgo(), githubMetadata("owner/repo#deleted"));
    const unreadChatId = await seedChat(app, admin.organizationId, longAgo(), githubMetadata("owner/repo#unread"));
    const targetChatId = await seedChat(app, admin.organizationId, longAgo(), githubMetadata("owner/repo#target"));

    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#already-archived",
        chatId: archivedChatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#deleted",
        chatId: deletedChatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#unread",
        chatId: unreadChatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#target",
        chatId: targetChatId,
        boundVia: "direct",
        entityState: "merged",
      },
    ]);

    await app.db.insert(chatUserState).values([
      {
        chatId: archivedChatId,
        agentId: human,
        engagementStatus: "archived",
        unreadMentionCount: 0,
      },
      {
        chatId: deletedChatId,
        agentId: human,
        engagementStatus: "deleted",
        unreadMentionCount: 0,
      },
      {
        chatId: unreadChatId,
        agentId: human,
        engagementStatus: "active",
        unreadMentionCount: 1,
      },
    ]);

    const result = await sweepChatArchive(app.db, { batchSize: 1 });

    expect(result.mappedRowsArchived).toBe(1);
    expect(await getEngagement(app, archivedChatId, human)).toBe("archived");
    expect(await getEngagement(app, deletedChatId, human)).toBe("deleted");
    expect(await getEngagement(app, unreadChatId, human)).toBe("active");
    expect(await getEngagement(app, targetChatId, human)).toBe("archived");
  });
});

describe("sweepChatArchive — no-mapping SCM branch", () => {
  const getApp = useTestApp();

  async function seedReadAcknowledgement(app: App, chatId: string, agentId: string): Promise<void> {
    await app.db.insert(chatUserState).values({
      chatId,
      agentId,
      engagementStatus: "active",
      unreadMentionCount: 0,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
  }

  it("archives a source=github chat with no mappings once it is idle and the user has acknowledged read", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBeGreaterThanOrEqual(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("archives an acknowledged source=gitlab chat after its mappings are removed", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo(), {
      source: "gitlab",
      entityType: "issue",
      entityKey: "501:issue:7",
      entityUrl: "https://gitlab.internal/acme/api/-/issues/7",
    });
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);

    expect(await sweepChatArchive(app.db)).toMatchObject({ unmappedRowsArchived: 1 });
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive no-mapping chats unless their source is an SCM provider", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const manualChatId = await seedChat(app, admin.organizationId, longAgo(), {});
    const agentChatId = await seedChat(app, admin.organizationId, longAgo(), { source: "agent" });
    await addHumanMember(app, manualChatId, human);
    await addHumanMember(app, agentChatId, human);
    await seedReadAcknowledgement(app, manualChatId, human);
    await seedReadAcknowledgement(app, agentChatId, human);

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, manualChatId, human)).toBe("active");
    expect(await getEngagement(app, agentChatId, human)).toBe("active");
  });

  it("does not archive a user who has never opened the chat (last_read_at IS NULL)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    // No chat_user_state row at all — user has never opened the chat. The
    // sweeper must leave the implicit-active view alone, otherwise the user
    // returns to find the chat already in the Archived tab without ever
    // having seen it.

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("does not archive a user with unread mentions", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 2,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("does not archive no-mapping source=github chats while any request in the chat is still open", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 0,
      openRequestCount: 1,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const blocked = await sweepChatArchive(app.db);
    expect(blocked.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("active");

    await app.db.update(chatUserState).set({ openRequestCount: 0 }).where(eq(chatUserState.chatId, chatId));

    const unblocked = await sweepChatArchive(app.db);
    expect(unblocked.unmappedRowsArchived).toBe(1);
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("does not archive a recently active chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, recent());
    await addHumanMember(app, chatId, human);
    await seedReadAcknowledgement(app, chatId, human);

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("does not archive a manually created chat owned by a human", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [delegate],
    });
    await app.db.update(chats).set({ lastMessageAt: longAgo() }).where(eq(chats.id, chatId));
    await seedReadAcknowledgement(app, chatId, admin.humanAgentUuid);

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, admin.humanAgentUuid)).toBe("active");
  });

  it("does not archive chats that have GitHub mappings (mapped branch responsibility)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, human);
    // Make the user a no-mapping-branch eligible candidate so the assertion
    // only succeeds because mapping presence excludes the chat from this branch.
    await seedReadAcknowledgement(app, chatId, human);
    // Mapping with an open entity -> mapped branch should NOT fire either, and
    // the no-mapping branch must skip this chat entirely.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#7",
      chatId,
      boundVia: "direct",
      entityState: "open",
    });

    const result = await sweepChatArchive(app.db);

    expect(result.unmappedRowsArchived).toBe(0);
    expect(result.mappedRowsArchived).toBe(0);
    expect(await getEngagement(app, chatId, human)).toBe("active");
  });

  it("ignores non-human members", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const robot = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, longAgo());
    await addHumanMember(app, chatId, robot);

    await sweepChatArchive(app.db);

    expect(await getEngagement(app, chatId, robot)).toBeNull();
  });
});

describe("sweepChatArchive — thresholds", () => {
  const getApp = useTestApp();

  it("respects custom mappedIdleSeconds", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const delegate = await seedDelegateAgent(app, admin.organizationId, admin.memberId);
    // 30 minutes ago → under the default 1h, but a custom 10-minute threshold catches it.
    const chatId = await seedChat(app, admin.organizationId, new Date(Date.now() - 30 * 60 * 1000));
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#8",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const before = await sweepChatArchive(app.db);
    expect(before.mappedRowsArchived).toBe(0);

    const after = await sweepChatArchive(app.db, { mappedIdleSeconds: 10 * 60 });
    expect(after.mappedRowsArchived).toBe(1);
  });

  it("uses mappedIdleSeconds for the no-mapping source=github branch too", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const human = await seedHumanAgent(app, admin.organizationId, admin.memberId);
    const chatId = await seedChat(app, admin.organizationId, new Date(Date.now() - 30 * 60 * 1000));
    await addHumanMember(app, chatId, human);
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "active",
      unreadMentionCount: 0,
      lastReadAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const before = await sweepChatArchive(app.db);
    expect(before.unmappedRowsArchived).toBe(0);

    const after = await sweepChatArchive(app.db, { mappedIdleSeconds: 10 * 60 });
    expect(after.unmappedRowsArchived).toBe(1);
  });
});
