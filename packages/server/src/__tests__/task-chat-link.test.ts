import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organizations } from "../db/schema/organizations.js";
import { taskChats } from "../db/schema/tasks.js";
import { createAgent } from "../services/agent.js";
import { findOrCreateDirectChat } from "../services/chat.js";
import { generateInviteToken } from "../services/organization.js";
import * as taskService from "../services/task.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Task ↔ Chat linking", () => {
  const getApp = useTestApp();

  it("links a chat to a task and allows unlink", async () => {
    const app = getApp();
    const { agent: a } = await createTestAgent(app, { name: "link-a" });
    const { agent: b } = await createTestAgent(app, { name: "link-b" });
    const chat = await findOrCreateDirectChat(app.db, a.uuid, b.uuid);

    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: a.uuid, organizationId: a.organizationId },
      { title: "With linked chat", organizationId: a.organizationId, assigneeAgentId: a.uuid },
    );

    await taskService.linkChatToTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: a.uuid,
      organizationId: a.organizationId,
    });
    const linked = await app.db.select().from(taskChats).where(eq(taskChats.taskId, task.id));
    expect(linked).toHaveLength(1);
    expect(linked[0]?.chatId).toBe(chat.id);
    expect(linked[0]?.linkedByAgentId).toBe(a.uuid);

    // Idempotent — re-linking is a no-op
    await taskService.linkChatToTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: a.uuid,
      organizationId: a.organizationId,
    });
    const afterRelink = await app.db.select().from(taskChats).where(eq(taskChats.taskId, task.id));
    expect(afterRelink).toHaveLength(1);

    // Unlink
    await taskService.unlinkChatFromTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: a.uuid,
      organizationId: a.organizationId,
    });
    const afterUnlink = await app.db.select().from(taskChats).where(eq(taskChats.taskId, task.id));
    expect(afterUnlink).toHaveLength(0);
  });

  it("rejects linking a chat from a different organization", async () => {
    const app = getApp();
    const { agent: a } = await createTestAgent(app, { name: "org1-a" });
    const { agent: b } = await createTestAgent(app, { name: "org1-b" });

    const altOrgId = "01961234-0000-7000-8000-0000000000aa";
    await app.db
      .insert(organizations)
      .values({
        id: altOrgId,
        name: `alt-${Date.now()}`,
        displayName: "Alt",
        inviteToken: generateInviteToken(),
      })
      .onConflictDoNothing();
    // Use human type so createAgent doesn't require a client — this test is
    // about cross-org chat linking, not R-RUN pinning.
    const foreignA = await createAgent(app.db, {
      name: "foreign-a",
      type: "human",
      organizationId: altOrgId,
      managerId: a.managerId ?? undefined,
    });
    const foreignB = await createAgent(app.db, {
      name: "foreign-b",
      type: "human",
      organizationId: altOrgId,
      managerId: a.managerId ?? undefined,
    });
    const foreignChat = await findOrCreateDirectChat(app.db, foreignA.uuid, foreignB.uuid);

    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: a.uuid, organizationId: a.organizationId },
      { title: "Cross-org", organizationId: a.organizationId, assigneeAgentId: b.uuid },
    );

    await expect(
      taskService.linkChatToTask(app.db, task.id, foreignChat.id, {
        type: "agent",
        agentId: a.uuid,
        organizationId: a.organizationId,
      }),
    ).rejects.toThrow(/different organization/i);
  });

  it("unlink reports 404 when the association does not exist", async () => {
    const app = getApp();
    const { agent: a } = await createTestAgent(app, { name: "nolink-a" });
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: a.uuid, organizationId: a.organizationId },
      { title: "No link", organizationId: a.organizationId, assigneeAgentId: a.uuid },
    );
    await expect(
      taskService.unlinkChatFromTask(app.db, task.id, "nonexistent", {
        type: "agent",
        agentId: a.uuid,
        organizationId: a.organizationId,
      }),
    ).rejects.toThrow(/not linked/i);
  });

  it("rejects link from an agent who is neither creator, assignee, nor chat participant", async () => {
    const app = getApp();
    const { agent: creator } = await createTestAgent(app, { name: "auth-creator" });
    const { agent: assignee } = await createTestAgent(app, { name: "auth-assignee" });
    const { agent: stranger } = await createTestAgent(app, { name: "auth-stranger" });

    const chat = await findOrCreateDirectChat(app.db, creator.uuid, assignee.uuid);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "Locked", organizationId: creator.organizationId, assigneeAgentId: assignee.uuid },
    );

    await expect(
      taskService.linkChatToTask(app.db, task.id, chat.id, {
        type: "agent",
        agentId: stranger.uuid,
        organizationId: stranger.organizationId,
      }),
    ).rejects.toThrow(/creator or assignee/i);
  });

  it("rejects link when the agent is creator/assignee but not a chat participant", async () => {
    const app = getApp();
    const { agent: creator } = await createTestAgent(app, { name: "np-creator" });
    const { agent: assignee } = await createTestAgent(app, { name: "np-assignee" });
    const { agent: other1 } = await createTestAgent(app, { name: "np-other1" });
    const { agent: other2 } = await createTestAgent(app, { name: "np-other2" });

    // Chat exists between other1/other2 — creator/assignee are not participants
    const foreignChat = await findOrCreateDirectChat(app.db, other1.uuid, other2.uuid);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "NP", organizationId: creator.organizationId, assigneeAgentId: assignee.uuid },
    );

    await expect(
      taskService.linkChatToTask(app.db, task.id, foreignChat.id, {
        type: "agent",
        agentId: creator.uuid,
        organizationId: creator.organizationId,
      }),
    ).rejects.toThrow(/participant/i);
  });
});
