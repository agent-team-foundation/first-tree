import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import * as activityService from "../services/activity.js";
import { findOrCreateDirectChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import * as presenceService from "../services/presence.js";
import * as taskService from "../services/task.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Task health detection (hub-task-design Section 9).
 * Scenarios covered:
 *   - not_applicable (task not working)
 *   - no_chat (no linked chats)
 *   - idle_island (assignee session suspended)
 *   - awaiting_reply (assignee spoke last)
 *   - normal (other party spoke last, session active)
 */
describe("Task health detection", () => {
  const getApp = useTestApp();

  async function setupWorkingTask(app: Awaited<ReturnType<typeof getApp>>) {
    const { agent: creator } = await createTestAgent(app, { name: `h-creator-${Date.now()}` });
    const { agent: assignee } = await createTestAgent(app, { name: `h-assignee-${Date.now()}` });
    // Presence row must exist for upsertSessionState to aggregate into
    await presenceService.setOnline(app.db, assignee.uuid, "test-instance");
    const { task: pendingTask } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "health", assigneeAgentId: assignee.uuid, organizationId: creator.organizationId },
    );
    // assigned → working
    const { task } = await taskService.updateTaskStatus(
      app.db,
      pendingTask.id,
      { type: "agent", agentId: assignee.uuid, organizationId: assignee.organizationId },
      { status: "working" },
    );
    return { creator, assignee, task };
  }

  it("returns not_applicable for non-working tasks", async () => {
    const app = getApp();
    const { agent: creator } = await createTestAgent(app, { name: `na-${Date.now()}` });
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "na", organizationId: creator.organizationId },
    );
    const health = await taskService.getTaskHealth(app.db, task.id);
    expect(health.signal).toBe("not_applicable");
  });

  it("returns no_chat when a working task has zero linked chats", async () => {
    const app = getApp();
    const { task } = await setupWorkingTask(app);
    const health = await taskService.getTaskHealth(app.db, task.id);
    expect(health.signal).toBe("no_chat");
  });

  it("returns idle_island when assignee has no active session in any linked chat", async () => {
    const app = getApp();
    const { creator, assignee, task } = await setupWorkingTask(app);
    const chat = await findOrCreateDirectChat(app.db, creator.uuid, assignee.uuid);
    await taskService.linkChatToTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: assignee.uuid,
      organizationId: assignee.organizationId,
    });
    // Assignee session is suspended
    await activityService.upsertSessionState(app.db, assignee.uuid, chat.id, "suspended", assignee.organizationId);
    const health = await taskService.getTaskHealth(app.db, task.id);
    expect(health.signal).toBe("idle_island");
  });

  it("returns awaiting_reply when assignee sent the last message", async () => {
    const app = getApp();
    const { creator, assignee, task } = await setupWorkingTask(app);
    const chat = await findOrCreateDirectChat(app.db, creator.uuid, assignee.uuid);
    await taskService.linkChatToTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: assignee.uuid,
      organizationId: assignee.organizationId,
    });
    await activityService.upsertSessionState(app.db, assignee.uuid, chat.id, "active", assignee.organizationId);
    // Assignee writes the last message
    await sendMessage(app.db, chat.id, assignee.uuid, { format: "text", content: "Waiting" });
    const health = await taskService.getTaskHealth(app.db, task.id);
    expect(health.signal).toBe("awaiting_reply");
  });

  it("returns normal when a non-assignee sent the last message and the session is active", async () => {
    const app = getApp();
    const { creator, assignee, task } = await setupWorkingTask(app);
    const chat = await findOrCreateDirectChat(app.db, creator.uuid, assignee.uuid);
    await taskService.linkChatToTask(app.db, task.id, chat.id, {
      type: "agent",
      agentId: assignee.uuid,
      organizationId: assignee.organizationId,
    });
    await activityService.upsertSessionState(app.db, assignee.uuid, chat.id, "active", assignee.organizationId);
    // Creator writes the last message; assignee must reply next
    await sendMessage(app.db, chat.id, creator.uuid, { format: "text", content: "Please work" });
    const health = await taskService.getTaskHealth(app.db, task.id);
    expect(health.signal).toBe("normal");
  });

  // Sanity: schema import is referenced (avoids TS unused import if test runner reshuffles)
  it("table reference is wired", () => {
    expect(agentChatSessions).toBeDefined();
  });
});
