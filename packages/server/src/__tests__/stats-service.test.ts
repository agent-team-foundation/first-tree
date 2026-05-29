import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { getStats } from "../services/stats.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("stats service", () => {
  const getApp = useTestApp();

  it("merges agent, chat, and message counts by organization", async () => {
    const app = getApp();
    const orgA = await createAdminContext(app, { username: `stats-a-${crypto.randomUUID().slice(0, 6)}` });
    const baseline = await getStats(app.db, orgA.organizationId);

    const activeAgent = await createAgent(app.db, {
      name: `stats-active-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Stats Active",
      managerId: orgA.memberId,
      clientId: orgA.clientId,
      organizationId: orgA.organizationId,
    });
    const deletedAgent = await createAgent(app.db, {
      name: `stats-deleted-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Stats Deleted",
      managerId: orgA.memberId,
      clientId: orgA.clientId,
      organizationId: orgA.organizationId,
    });
    await app.db.update(agents).set({ status: "deleted" }).where(eq(agents.uuid, deletedAgent.uuid));
    const chat = await createChat(app.db, orgA.humanAgentUuid, {
      type: "group",
      participantIds: [activeAgent.uuid],
      topic: "Stats chat",
    });
    await app.db.insert(messages).values([
      {
        id: uuidv7(),
        chatId: chat.id,
        senderId: orgA.humanAgentUuid,
        format: "text",
        content: "hello",
        metadata: {},
        source: "api",
      },
      {
        id: uuidv7(),
        chatId: chat.id,
        senderId: activeAgent.uuid,
        format: "text",
        content: "hi",
        metadata: {},
        source: "agent",
      },
    ]);

    const orgBChatId = uuidv7();
    const orgBId = uuidv7();
    await app.db.insert(organizations).values({
      id: orgBId,
      name: `stats-b-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Stats B",
    });
    await app.db.insert(chats).values({
      id: orgBChatId,
      organizationId: orgBId,
      type: "group",
      topic: "Other org chat",
      metadata: {},
    });

    const filtered = await getStats(app.db, orgA.organizationId);
    expect(filtered.totalAgents).toBe(baseline.totalAgents + 1);
    expect(filtered.totalChats).toBe(baseline.totalChats + 1);
    expect(filtered.totalMessages).toBe(baseline.totalMessages + 2);
    expect(filtered.byOrganization).toHaveLength(1);
    expect(filtered.byOrganization[0]).toEqual({
      organizationId: orgA.organizationId,
      agentCount: baseline.totalAgents + 1,
      chatCount: baseline.totalChats + 1,
      messageCount: baseline.totalMessages + 2,
    });

    const all = await getStats(app.db);
    const orgABreakdown = all.byOrganization.find((entry) => entry.organizationId === orgA.organizationId);
    const orgBBreakdown = all.byOrganization.find((entry) => entry.organizationId === orgBId);

    expect(orgABreakdown).toMatchObject({
      agentCount: baseline.totalAgents + 1,
      chatCount: baseline.totalChats + 1,
      messageCount: baseline.totalMessages + 2,
    });
    expect(orgBBreakdown).toMatchObject({
      agentCount: 0,
      chatCount: 1,
      messageCount: 0,
    });
    expect(all.totalAgents).toBeGreaterThanOrEqual(filtered.totalAgents);
    expect(all.totalChats).toBeGreaterThanOrEqual(filtered.totalChats + 1);
    expect(all.totalMessages).toBeGreaterThanOrEqual(filtered.totalMessages);
  });
});
