import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("Admin Tasks API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const admin = await createTestAdmin(app, { username: `tasks-admin-${Date.now()}` });
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
    return Object.assign(req, { admin });
  }

  it("creates a task via admin and notifies the assignee", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const target = await createTestAgent(app, { name: "admin-task-target" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/tasks`, {
      title: "Admin-issued work",
      body: "Please look at this",
      assigneeAgentId: target.agent.uuid,
    });
    expect(createRes.statusCode).toBe(201);
    const task = createRes.json<{ id: string; status: string; createdByType: string }>();
    expect(task.status).toBe("assigned");
    expect(task.createdByType).toBe("admin");

    // Target agent should have received a task notification via inbox
    const inboxRes = await target.request("GET", "/api/v1/agent/inbox");
    const entries = inboxRes.json() as Array<{ message: { format: string } }>;
    expect(entries.some((e) => e.message.format === "task")).toBe(true);
  });

  it("lists tasks, supports status filter", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent: a } = await createTestAgent(app, { name: "admin-list" });
    await req("POST", `/api/v1/orgs/${req.admin.organizationId}/tasks`, { title: "Task one" });
    await req("POST", `/api/v1/orgs/${req.admin.organizationId}/tasks`, { title: "Task two", assigneeAgentId: a.uuid });

    const allRes = await req("GET", `/api/v1/orgs/${req.admin.organizationId}/tasks`);
    expect(allRes.statusCode).toBe(200);
    const all = allRes.json<{ items: Array<{ title: string; status: string }> }>();
    expect(all.items.length).toBeGreaterThanOrEqual(2);

    const pendingRes = await req("GET", `/api/v1/orgs/${req.admin.organizationId}/tasks?status=pending`);
    const pending = pendingRes.json<{ items: Array<{ status: string }> }>();
    expect(pending.items.every((t) => t.status === "pending")).toBe(true);
  });

  it("admin can cancel a task", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent: a } = await createTestAgent(app, { name: "admin-cancel" });
    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/tasks`, {
      title: "Cancel me",
      assigneeAgentId: a.uuid,
    });
    const task = createRes.json<{ id: string }>();

    const res = await req("POST", `/api/v1/tasks/${task.id}/cancel`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; cancelledByType: string }>();
    expect(body.status).toBe("cancelled");
    expect(body.cancelledByType).toBe("admin");
  });

  it("admin can reassign a pending task", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const { agent: a } = await createTestAgent(app, { name: "admin-reassign" });

    const createRes = await req("POST", `/api/v1/orgs/${req.admin.organizationId}/tasks`, { title: "Pending" });
    const task = createRes.json<{ id: string; status: string }>();
    expect(task.status).toBe("pending");

    const patchRes = await req("PATCH", `/api/v1/tasks/${task.id}`, {
      assigneeAgentId: a.uuid,
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json<{ status: string; assigneeAgentId: string }>();
    expect(updated.status).toBe("assigned");
    expect(updated.assigneeAgentId).toBe(a.uuid);
  });

  it("rejects unauthenticated admin task access", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/orgs/any/tasks" });
    expect(res.statusCode).toBe(401);
  });
});
