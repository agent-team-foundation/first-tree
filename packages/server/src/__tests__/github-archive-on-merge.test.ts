/**
 * Unit tests for `archiveChatsForMergedPr`. Exercises the per-(chat, human)
 * flip from `active` → `archived`, the deleted/archived guards, and idempotency
 * under repeated calls. The webhook bypass that calls this service is covered
 * by `github-app-webhook-route.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { archiveChatsForMergedPr } from "../services/github-archive-on-merge.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

async function seedAgent(app: ReturnType<ReturnType<typeof useTestApp>>, opts: { orgId: string; memberId: string }) {
  const uuid = randomUUID();
  const { agents } = await import("../db/schema/agents.js");
  await app.db.insert(agents).values({
    uuid,
    name: `agent-${uuid.slice(0, 8)}`,
    organizationId: opts.orgId,
    type: "agent",
    displayName: "x",
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
  });
  return uuid;
}

async function seedChat(app: ReturnType<ReturnType<typeof useTestApp>>, orgId: string): Promise<string> {
  const chatId = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({ id: chatId, organizationId: orgId, type: "direct" });
  return chatId;
}

async function seedMapping(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  opts: {
    orgId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entityKey: string;
    chatId: string;
    entityType?: string;
  },
): Promise<void> {
  await app.db.insert(githubEntityChatMappings).values({
    organizationId: opts.orgId,
    humanAgentId: opts.humanAgentId,
    delegateAgentId: opts.delegateAgentId,
    entityType: opts.entityType ?? "pull_request",
    entityKey: opts.entityKey,
    chatId: opts.chatId,
    boundVia: "direct",
  });
}

async function getEngagement(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  chatId: string,
  agentId: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ engagementStatus: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentId)))
    .limit(1);
  return row?.engagementStatus ?? null;
}

describe("archiveChatsForMergedPr", () => {
  const getApp = useTestApp();

  it("returns zero when no mapping exists for the PR", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 9999,
    });

    expect(result).toEqual({ chats: 0, rowsConsidered: 0 });
  });

  it("archives a single chat × single human binding (implicit active → archived)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#101",
      chatId,
    });

    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 101,
    });

    expect(result).toEqual({ chats: 1, rowsConsidered: 1 });
    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("archives all humans bound to the same chat through the same PR", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const humanA = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const humanB = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: humanA,
      delegateAgentId: delegate,
      entityKey: "owner/repo#102",
      chatId,
    });
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: humanB,
      delegateAgentId: delegate,
      entityKey: "owner/repo#102",
      chatId,
    });

    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 102,
    });

    expect(result.chats).toBe(1);
    expect(result.rowsConsidered).toBe(2);
    expect(await getEngagement(app, chatId, humanA)).toBe("archived");
    expect(await getEngagement(app, chatId, humanB)).toBe("archived");
  });

  it("archives every chat bound to the same PR", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatA = await seedChat(app, admin.organizationId);
    const chatB = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#103",
      chatId: chatA,
    });
    // Same human, different delegate → different mapping row but valid because
    // PK includes delegateAgentId.
    const delegate2 = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate2,
      entityKey: "owner/repo#103",
      chatId: chatB,
    });

    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 103,
    });

    expect(result.chats).toBe(2);
    expect(await getEngagement(app, chatA, human)).toBe("archived");
    expect(await getEngagement(app, chatB, human)).toBe("archived");
  });

  it("preserves user-manually deleted state (does not overwrite)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#104",
      chatId,
    });

    // User had previously deleted this chat from their view.
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: human,
      engagementStatus: "deleted",
      unreadMentionCount: 0,
    });

    await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 104,
    });

    expect(await getEngagement(app, chatId, human)).toBe("deleted");
  });

  it("is idempotent under repeated calls and leaves existing archived rows alone", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#105",
      chatId,
    });

    const args = { organizationId: admin.organizationId, repoFullName: "owner/repo", prNumber: 105 };
    await archiveChatsForMergedPr(app.db, args);
    await archiveChatsForMergedPr(app.db, args);
    await archiveChatsForMergedPr(app.db, args);

    expect(await getEngagement(app, chatId, human)).toBe("archived");
  });

  it("ignores non-pull_request mappings sharing the same entity_key", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    // Bound as issue, not pull_request → must not be touched.
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#106",
      chatId,
      entityType: "issue",
    });

    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: admin.organizationId,
      repoFullName: "owner/repo",
      prNumber: 106,
    });

    expect(result).toEqual({ chats: 0, rowsConsidered: 0 });
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });

  it("scopes to organization (does not cross-archive)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { organizations } = await import("../db/schema/organizations.js");
    const { uuidv7 } = await import("../uuid.js");

    // Seed a second org distinct from the test admin's default org so the
    // service's organization_id filter has something to discriminate against.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: `oth-${otherOrgId.slice(0, 8)}`, displayName: "Other Org" });

    const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId });
    const chatId = await seedChat(app, admin.organizationId);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityKey: "owner/repo#107",
      chatId,
    });

    // Archiving against the OTHER org for the same entity_key must not touch
    // admin's mapping (which lives under admin.organizationId).
    const result = await archiveChatsForMergedPr(app.db, {
      organizationId: otherOrgId,
      repoFullName: "owner/repo",
      prNumber: 107,
    });

    expect(result).toEqual({ chats: 0, rowsConsidered: 0 });
    expect(await getEngagement(app, chatId, human)).toBeNull();
  });
});
