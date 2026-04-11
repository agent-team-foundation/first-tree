import { TASK_STATUSES } from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { tasks } from "../db/schema/tasks.js";
import { createAgent } from "../services/agent.js";
import * as taskService from "../services/task.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Task service", () => {
  const getApp = useTestApp();

  async function seedTwoAgents(app: Awaited<ReturnType<typeof getApp>>) {
    const { agent: creator } = await createTestAgent(app, { name: "task-creator" });
    const { agent: assignee } = await createTestAgent(app, { name: "task-assignee" });
    return { creator, assignee };
  }

  it("creates a pending task when no assignee is given", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Review quarterly migration plan",
        body: "Check schema changes in 0012",
        organizationId: creator.organizationId,
      },
    );
    expect(task.status).toBe(TASK_STATUSES.PENDING);
    expect(task.assigneeAgentId).toBeNull();
    expect(notification).toBeUndefined();
  });

  it("creates a working task when creator self-assigns (work-first, no notification)", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Summarize last week activity",
        body: "",
        assigneeAgentId: creator.uuid,
        organizationId: creator.organizationId,
      },
    );
    expect(task.status).toBe(TASK_STATUSES.WORKING);
    expect(task.assigneeAgentId).toBe(creator.uuid);
    expect(notification).toBeUndefined();
  });

  it("creates an assigned task and dispatches a notification via system-tasks agent", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Investigate flaky test",
        body: "test/foo.test.ts fails intermittently",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    expect(task.status).toBe(TASK_STATUSES.ASSIGNED);
    expect(notification).toBeDefined();
    expect(notification?.recipients.length ?? 0).toBeGreaterThan(0);

    // System-tasks agent was provisioned for this org
    const [systemAgent] = await app.db.select().from(agents).where(eq(agents.name, "__hub_system_tasks")).limit(1);
    expect(systemAgent).toBeDefined();
    expect(systemAgent?.organizationId).toBe(creator.organizationId);

    // Task notification message was stored and fanned-out into assignee's inbox
    const [msg] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.id, notification?.message.id ?? "none"))
      .limit(1);
    expect(msg?.format).toBe("task");
    const content = msg?.content as { taskId: string; event: string; status: string };
    expect(content.taskId).toBe(task.id);
    expect(content.event).toBe("assigned");
    expect(content.status).toBe("assigned");

    const inbox = await app.db.select().from(inboxEntries).where(eq(inboxEntries.inboxId, assignee.inboxId));
    expect(inbox.length).toBeGreaterThan(0);
  });

  it("rejects assignment to an agent in another organization", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);

    // Create a second org and an agent there
    const { organizations } = await import("../db/schema/organizations.js");
    const altOrgId = "01961234-0000-7000-8000-000000000099";
    await app.db
      .insert(organizations)
      .values({ id: altOrgId, name: `alt-${Date.now()}`, displayName: "Alt" })
      .onConflictDoNothing();
    const foreignAgent = await createAgent(app.db, {
      name: "foreign-agent",
      type: "autonomous_agent",
      organizationId: altOrgId,
    });

    await expect(
      taskService.createTask(
        app.db,
        { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
        {
          title: "Invalid",
          assigneeAgentId: foreignAgent.uuid,
          organizationId: creator.organizationId,
        },
      ),
    ).rejects.toThrow(/different organization/i);
  });

  it("enforces the status state machine", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "State machine test",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    // Illegal: assigned → completed (must go through working first)
    await expect(
      taskService.updateTaskStatus(
        app.db,
        task.id,
        { type: "agent", agentId: assignee.uuid, organizationId: assignee.organizationId },
        { status: "completed", result: "done" },
      ),
    ).rejects.toThrow(/Illegal status transition/);

    // Legal: assigned → working
    const { task: working } = await taskService.updateTaskStatus(
      app.db,
      task.id,
      { type: "agent", agentId: assignee.uuid, organizationId: assignee.organizationId },
      { status: "working" },
    );
    expect(working.status).toBe(TASK_STATUSES.WORKING);

    // Legal: working → completed (with result)
    const { task: completed } = await taskService.updateTaskStatus(
      app.db,
      task.id,
      { type: "agent", agentId: assignee.uuid, organizationId: assignee.organizationId },
      { status: "completed", result: "All green" },
    );
    expect(completed.status).toBe(TASK_STATUSES.COMPLETED);
    expect(completed.result).toBe("All green");

    // Terminal: completed → any (illegal)
    await expect(
      taskService.updateTaskStatus(
        app.db,
        task.id,
        { type: "agent", agentId: assignee.uuid, organizationId: assignee.organizationId },
        { status: "working" },
      ),
    ).rejects.toThrow(/Illegal status transition/);
  });

  it("requires completion to include an explicit result", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Self",
        assigneeAgentId: creator.uuid,
        organizationId: creator.organizationId,
      },
    );
    await expect(
      taskService.updateTaskStatus(
        app.db,
        task.id,
        { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
        { status: "completed" },
      ),
    ).rejects.toThrow(/result/i);
  });

  it("rejects status updates from non-assignees", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Unauthorized test",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    await expect(
      taskService.updateTaskStatus(
        app.db,
        task.id,
        { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
        { status: "working" },
      ),
    ).rejects.toThrow(/assignee/);
  });

  it("cancels a task, records cancel metadata, and notifies the assignee", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "To cancel",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    const { task: cancelled, notification } = await taskService.cancelTask(app.db, task.id, {
      type: "agent",
      agentId: creator.uuid,
      organizationId: creator.organizationId,
    });
    expect(cancelled.status).toBe(TASK_STATUSES.CANCELLED);
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(cancelled.cancelledByType).toBe("agent");
    expect(cancelled.cancelledById).toBe(creator.uuid);
    expect(notification).toBeDefined();
  });

  it("blocks cancel from actors who are neither creator nor assignee", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { agent: stranger } = await createTestAgent(app, { name: "stranger" });
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Locked",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    await expect(
      taskService.cancelTask(app.db, task.id, {
        type: "agent",
        agentId: stranger.uuid,
        organizationId: stranger.organizationId,
      }),
    ).rejects.toThrow(/assignee or creator/);
  });

  it("allows admin to reassign a pending task", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Pending",
        organizationId: creator.organizationId,
      },
    );
    expect(task.status).toBe(TASK_STATUSES.PENDING);

    const { task: updated, notification } = await taskService.adminUpdateTask(
      app.db,
      task.id,
      { type: "admin", adminId: "admin-1" },
      { assigneeAgentId: assignee.uuid },
    );
    expect(updated.status).toBe(TASK_STATUSES.ASSIGNED);
    expect(updated.assigneeAgentId).toBe(assignee.uuid);
    expect(notification).toBeDefined();
  });

  it("blocks admin from setting status=assigned without an assignee", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "Unassigned", organizationId: creator.organizationId },
    );
    expect(task.status).toBe(TASK_STATUSES.PENDING);
    expect(task.assigneeAgentId).toBeNull();

    await expect(
      taskService.adminUpdateTask(app.db, task.id, { type: "admin", adminId: "admin-1" }, { status: "assigned" }),
    ).rejects.toThrow(/without an assignee/i);
  });

  it("blocks admin from reassigning a non-pending task", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Already assigned",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );
    const { agent: other } = await createTestAgent(app, { name: "other-assignee" });
    await expect(
      taskService.adminUpdateTask(
        app.db,
        task.id,
        { type: "admin", adminId: "admin-1" },
        { assigneeAgentId: other.uuid },
      ),
    ).rejects.toThrow(/not pending/);
  });

  it("ensureSystemTasksAgent is idempotent per org", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const id1 = await taskService.ensureSystemTasksAgent(app.db, creator.organizationId);
    const id2 = await taskService.ensureSystemTasksAgent(app.db, creator.organizationId);
    expect(id1).toBe(id2);
    const all = await app.db.select().from(agents).where(eq(agents.name, "__hub_system_tasks"));
    expect(all).toHaveLength(1);
    expect(all[0]?.organizationId).toBe(creator.organizationId);
  });

  it("filters task list by status and assignee", async () => {
    const app = getApp();
    const { creator, assignee } = await seedTwoAgents(app);
    await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      { title: "pending-1", organizationId: creator.organizationId },
    );
    await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "assigned-1",
        assigneeAgentId: assignee.uuid,
        organizationId: creator.organizationId,
      },
    );

    const byStatus = await taskService.listTasks(app.db, creator.organizationId, {
      status: "pending",
      limit: 20,
    });
    expect(byStatus.items.every((t) => t.status === "pending")).toBe(true);
    expect(byStatus.items.some((t) => t.title === "pending-1")).toBe(true);

    const byAssignee = await taskService.listTasks(app.db, creator.organizationId, {
      assigneeAgentId: assignee.uuid,
      limit: 20,
    });
    expect(byAssignee.items.every((t) => t.assigneeAgentId === assignee.uuid)).toBe(true);
  });

  it("stores originRef without interpretation", async () => {
    const app = getApp();
    const { creator } = await seedTwoAgents(app);
    const { task } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: creator.uuid, organizationId: creator.organizationId },
      {
        title: "Linked",
        originRef: "owner/repo#123",
        organizationId: creator.organizationId,
      },
    );
    expect(task.originRef).toBe("owner/repo#123");
    const [row] = await app.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
    expect(row?.originRef).toBe("owner/repo#123");
  });
});
