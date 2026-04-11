import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Tasks API", () => {
  const getApp = useTestApp();

  it("creates a task via POST and returns serialized task", async () => {
    const app = getApp();
    const { token: t1 } = await createTestAgent(app, { name: "at-a1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
      payload: { title: "My task", body: "do stuff" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; assigneeAgentId: string | null }>();
    expect(body.status).toBe("pending");
    expect(body.assigneeAgentId).toBeNull();
  });

  it("creates a task assigned to another agent and triggers notification fan-out", async () => {
    const app = getApp();
    const { token: t1 } = await createTestAgent(app, { name: "at-creator" });
    const { agent: a2, token: t2 } = await createTestAgent(app, { name: "at-assignee" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
      payload: { title: "Assigned task", assigneeAgentId: a2.uuid },
    });
    expect(res.statusCode).toBe(201);
    const task = res.json<{ id: string; status: string }>();
    expect(task.status).toBe("assigned");

    // Assignee should see a task-format message in their inbox
    const inboxRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(inboxRes.statusCode).toBe(200);
    const entries = inboxRes.json<Array<{ message: { format: string; content: { taskId: string; event: string } } }>>();
    expect(entries.length).toBeGreaterThan(0);
    const taskEntry = entries.find((e) => e.message.format === "task");
    expect(taskEntry).toBeDefined();
    expect(taskEntry?.message.content.taskId).toBe(task.id);
    expect(taskEntry?.message.content.event).toBe("assigned");
  });

  it("lists tasks scoped to the caller's organization", async () => {
    const app = getApp();
    const { token: t1 } = await createTestAgent(app, { name: "at-lister" });
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
      payload: { title: "List me" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ title: string }> }>();
    expect(body.items.some((t) => t.title === "List me")).toBe(true);
  });

  it("rejects status update from a non-assignee", async () => {
    const app = getApp();
    const { token: t1 } = await createTestAgent(app, { name: "at-ns-creator" });
    const { agent: a2 } = await createTestAgent(app, { name: "at-ns-assignee" });
    const { token: t3 } = await createTestAgent(app, { name: "at-ns-stranger" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
      payload: { title: "Locked down", assigneeAgentId: a2.uuid },
    });
    const task = createRes.json<{ id: string }>();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/tasks/${task.id}`,
      headers: { authorization: `Bearer ${t3}` },
      payload: { status: "working" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("links and unlinks a chat", async () => {
    const app = getApp();
    const { agent: a1, token: t1 } = await createTestAgent(app, { name: "at-link-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "at-link-a2" });
    // Task (self-assigned → working)
    const taskRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${t1}` },
      payload: { title: "Linked", assigneeAgentId: a1.uuid },
    });
    const task = taskRes.json<{ id: string }>();
    // Create a chat
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.uuid] },
    });
    const chat = chatRes.json<{ id: string }>();

    const linkRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${task.id}/chats`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { chatId: chat.id },
    });
    expect(linkRes.statusCode).toBe(204);

    const unlinkRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/tasks/${task.id}/chats/${chat.id}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(unlinkRes.statusCode).toBe(204);
  });

  it("rejects unauthenticated task access", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/tasks" });
    expect(res.statusCode).toBe(401);
  });
});
