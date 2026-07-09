import { describe, expect, it } from "vitest";
import { upsertSessionState } from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { filterSessionsByParticipant, listAgentSessions } from "../services/session.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("session service extra edges", () => {
  const getApp = useTestApp();

  async function setupSession() {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createAgent(app.db, {
      name: `session-extra-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Session Extra Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
    });
    await upsertSessionState(app.db, agent.uuid, chatId, "active", admin.organizationId);
    return { app, admin, agent, chatId };
  }

  it("filters sessions by participant speaker membership and short-circuits empty input", async () => {
    const { app, admin, chatId } = await setupSession();

    await expect(filterSessionsByParticipant(app.db, [], admin.humanAgentUuid)).resolves.toEqual([]);
    await expect(
      filterSessionsByParticipant(
        app.db,
        [
          {
            agentId: "agent-a",
            chatId,
            state: "active",
            runtimeState: null,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            messageCount: 0,
            summary: null,
            topic: null,
          },
          {
            agentId: "agent-a",
            chatId: crypto.randomUUID(),
            state: "active",
            runtimeState: null,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            messageCount: 0,
            summary: null,
            topic: null,
          },
        ],
        admin.humanAgentUuid,
      ),
    ).resolves.toMatchObject([{ chatId }]);
  });

  it("applies runtime-state filters and extracts the first message summary", async () => {
    const { app, admin, agent, chatId } = await setupSession();
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "A concise session summary" },
      { allowRecipientlessSend: true },
    );

    await expect(listAgentSessions(app.db, agent.uuid, { runtimeState: "working" })).resolves.toEqual([]);

    const sessions = await listAgentSessions(app.db, agent.uuid);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe("A concise session summary");
  });
});
