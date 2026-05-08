import { adminUpdateTaskSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireTaskAccess } from "../scope/require-resource.js";
import type { SendMessageResult } from "../services/message.js";
import { type Notifier, notifyRecipients } from "../services/notifier.js";
import * as taskService from "../services/task.js";

function dispatch(notifier: Notifier, result: SendMessageResult | undefined): void {
  if (!result) return;
  notifyRecipients(notifier, result.recipients, result.message.id);
}

/** Class C — `/api/v1/tasks/:taskId`. The task's `organizationId` locates the org. */
export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    await requireTaskAccess(request, app.db);
    const detail = await taskService.getTaskDetail(app.db, request.params.taskId);
    return { ...taskService.serializeTask(detail), chats: detail.chats };
  });

  app.patch<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const { scope } = await requireTaskAccess(request, app.db);
    const body = adminUpdateTaskSchema.parse(request.body);
    const { task, notification } = await taskService.adminUpdateTask(
      app.db,
      request.params.taskId,
      { type: "admin", adminId: scope.memberId },
      body,
    );
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.post<{ Params: { taskId: string } }>("/:taskId/cancel", async (request) => {
    const { scope } = await requireTaskAccess(request, app.db);
    const { task, notification } = await taskService.cancelTask(app.db, request.params.taskId, {
      type: "admin",
      adminId: scope.memberId,
    });
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.get<{ Params: { taskId: string } }>("/:taskId/health", async (request) => {
    await requireTaskAccess(request, app.db);
    return taskService.getTaskHealth(app.db, request.params.taskId);
  });
}
