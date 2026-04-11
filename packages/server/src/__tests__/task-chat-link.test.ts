import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organizations } from "../db/schema/organizations.js";
import { taskChats } from "../db/schema/tasks.js";
import { createAgent } from "../services/agent.js";
import { findOrCreateDirectChat } from "../services/chat.js";
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
    await taskService.unlinkChatFromTask(app.db, task.id, chat.id);
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
      .values({ id: altOrgId, name: `alt-${Date.now()}`, displayName: "Alt" })
      .onConflictDoNothing();
    const foreignA = await createAgent(app.db, {
      name: "foreign-a",
      type: "autonomous_agent",
      organizationId: altOrgId,
    });
    const foreignB = await createAgent(app.db, {
      name: "foreign-b",
      type: "autonomous_agent",
      organizationId: altOrgId,
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
    await expect(taskService.unlinkChatFromTask(app.db, task.id, "nonexistent")).rejects.toThrow(/not linked/i);
  });
});
