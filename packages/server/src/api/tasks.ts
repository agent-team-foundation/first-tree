import { adminUpdateTaskSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq as drizzleEq, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { members } from "../db/schema/members.js";
import { tasks } from "../db/schema/tasks.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import type { SendMessageResult } from "../services/message.js";
import { type Notifier, notifyRecipients } from "../services/notifier.js";
import * as taskService from "../services/task.js";

function dispatch(notifier: Notifier, result: SendMessageResult | undefined): void {
  if (!result) return;
  notifyRecipients(notifier, result.recipients, result.message.id);
}

/** Class C — `/api/v1/tasks/:taskId`. The task's `organizationId` locates the org. */
export async function taskRoutes(app: FastifyInstance): Promise<void> {
  async function gate(app: FastifyInstance, userId: string, taskId: string) {
    const [task] = await app.db
      .select({ organizationId: tasks.organizationId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) throw new NotFoundError(`Task "${taskId}" not found`);
    const [member] = await app.db
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(
        and(
          drizzleEq(members.userId, userId),
          drizzleEq(members.organizationId, task.organizationId),
          drizzleEq(members.status, "active"),
        ),
      )
      .limit(1);
    if (!member) throw new NotFoundError(`Task "${taskId}" not found`);
    return { memberId: member.id };
  }

  app.get<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const { userId } = requireUser(request);
    await gate(app, userId, request.params.taskId);
    const detail = await taskService.getTaskDetail(app.db, request.params.taskId);
    return { ...taskService.serializeTask(detail), chats: detail.chats };
  });

  app.patch<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const { userId } = requireUser(request);
    const { memberId } = await gate(app, userId, request.params.taskId);
    const body = adminUpdateTaskSchema.parse(request.body);
    const { task, notification } = await taskService.adminUpdateTask(
      app.db,
      request.params.taskId,
      { type: "admin", adminId: memberId },
      body,
    );
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.post<{ Params: { taskId: string } }>("/:taskId/cancel", async (request) => {
    const { userId } = requireUser(request);
    const { memberId } = await gate(app, userId, request.params.taskId);
    const { task, notification } = await taskService.cancelTask(app.db, request.params.taskId, {
      type: "admin",
      adminId: memberId,
    });
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.get<{ Params: { taskId: string } }>("/:taskId/health", async (request) => {
    const { userId } = requireUser(request);
    await gate(app, userId, request.params.taskId);
    return taskService.getTaskHealth(app.db, request.params.taskId);
  });
}
