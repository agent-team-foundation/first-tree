import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Tasks API", () => {
  const getApp = useTestApp();

  it("creates a task via POST and returns serialized task", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "at-a1" });
    const res = await a1.request("POST", "/api/v1/agent/tasks", { title: "My task", body: "do stuff" });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; assigneeAgentId: string | null }>();
    expect(body.status).toBe("pending");
    expect(body.assigneeAgentId).toBeNull();
  });

  it("creates a task assigned to another agent and triggers notification fan-out", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "at-creator" });
    const a2 = await createTestAgent(app, { name: "at-assignee" });

    const res = await a1.request("POST", "/api/v1/agent/tasks", {
      title: "Assigned task",
      assigneeAgentId: a2.agent.uuid,
    });
    expect(res.statusCode).toBe(201);
    const task = res.json<{ id: string; status: string }>();
    expect(task.status).toBe("assigned");

    const inboxRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(inboxRes.statusCode).toBe(200);
    const entries = inboxRes.json() as Array<{
      message: { format: string; content: { taskId: string; event: string } };
    }>;
    expect(entries.length).toBeGreaterThan(0);
    const taskEntry = entries.find((e) => e.message.format === "task");
    expect(taskEntry).toBeDefined();
    expect(taskEntry?.message.content.taskId).toBe(task.id);
    expect(taskEntry?.message.content.event).toBe("assigned");
  });

  it("lists tasks scoped to the caller's organization", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "at-lister" });
    await a1.request("POST", "/api/v1/agent/tasks", { title: "List me" });
    const res = await a1.request("GET", "/api/v1/agent/tasks");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ title: string }> };
    expect(body.items.some((t) => t.title === "List me")).toBe(true);
  });

  it("rejects status update from a non-assignee", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "at-ns-creator" });
    const a2 = await createTestAgent(app, { name: "at-ns-assignee" });
    const a3 = await createTestAgent(app, { name: "at-ns-stranger" });

    const createRes = await a1.request("POST", "/api/v1/agent/tasks", {
      title: "Locked down",
      assigneeAgentId: a2.agent.uuid,
    });
    const task = createRes.json<{ id: string }>();

    const res = await a3.request("PATCH", `/api/v1/agent/tasks/${task.id}`, { status: "working" });
    expect(res.statusCode).toBe(403);
  });

  it("links and unlinks a chat", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "at-link-a1" });
    const a2 = await createTestAgent(app, { name: "at-link-a2" });
    const taskRes = await a1.request("POST", "/api/v1/agent/tasks", {
      title: "Linked",
      assigneeAgentId: a1.agent.uuid,
    });
    const task = taskRes.json<{ id: string }>();
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a2.agent.uuid],
    });
    const chat = chatRes.json<{ id: string }>();

    const linkRes = await a1.request("POST", `/api/v1/agent/tasks/${task.id}/chats`, { chatId: chat.id });
    expect(linkRes.statusCode).toBe(204);

    const unlinkRes = await a1.request("DELETE", `/api/v1/agent/tasks/${task.id}/chats/${chat.id}`);
    expect(unlinkRes.statusCode).toBe(204);
  });

  it("rejects unauthenticated task access", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/tasks" });
    expect(res.statusCode).toBe(401);
  });
});
