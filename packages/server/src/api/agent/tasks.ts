import {
  createTaskSchema,
  linkTaskChatSchema,
  taskListQuerySchema,
  updateTaskStatusSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { notifyRecipients } from "../../services/notifier.js";
import * as taskService from "../../services/task.js";

export async function agentTaskRoutes(app: FastifyInstance): Promise<void> {
  /** Create a task. Agent creator; assignee defaults to self (work-first) if omitted. */
  app.post("/", async (request, reply) => {
    const identity = requireAgent(request);
    const body = createTaskSchema.parse(request.body);
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "agent", agentId: identity.uuid, organizationId: identity.organizationId },
      { ...body, organizationId: identity.organizationId },
    );
    if (notification) {
      notifyRecipients(app.notifier, notification.recipients, notification.message.id);
    }
    return reply.status(201).send(taskService.serializeTask(task));
  });

  /** List tasks scoped to the caller's organization. */
  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = taskListQuerySchema.parse(request.query);
    const result = await taskService.listTasks(app.db, identity.organizationId, query);
    return {
      items: result.items.map((t) => taskService.serializeTask(t)),
      nextCursor: result.nextCursor,
    };
  });

  /** Get task detail — includes linked chats. */
  app.get<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const identity = requireAgent(request);
    const detail = await taskService.getTaskDetail(app.db, request.params.taskId);
    if (detail.organizationId !== identity.organizationId) {
      // Don't leak cross-org existence
      throw new NotFoundError(`Task "${request.params.taskId}" not found`);
    }
    return {
      ...taskService.serializeTask(detail),
      chats: detail.chats,
    };
  });

  /** Agent self-report: working / completed / failed. */
  app.patch<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const identity = requireAgent(request);
    const body = updateTaskStatusSchema.parse(request.body);
    const { task, notification } = await taskService.updateTaskStatus(
      app.db,
      request.params.taskId,
      { type: "agent", agentId: identity.uuid, organizationId: identity.organizationId },
      body,
    );
    if (notification) {
      notifyRecipients(app.notifier, notification.recipients, notification.message.id);
    }
    return taskService.serializeTask(task);
  });

  /** Cancel a task (assignee or creator). */
  app.post<{ Params: { taskId: string } }>("/:taskId/cancel", async (request) => {
    const identity = requireAgent(request);
    const { task, notification } = await taskService.cancelTask(app.db, request.params.taskId, {
      type: "agent",
      agentId: identity.uuid,
      organizationId: identity.organizationId,
    });
    if (notification) {
      notifyRecipients(app.notifier, notification.recipients, notification.message.id);
    }
    return taskService.serializeTask(task);
  });

  /** Link a chat to a task (agent reports the chat it is using). */
  app.post<{ Params: { taskId: string } }>("/:taskId/chats", async (request, reply) => {
    const identity = requireAgent(request);
    const body = linkTaskChatSchema.parse(request.body);
    await taskService.linkChatToTask(app.db, request.params.taskId, body.chatId, {
      type: "agent",
      agentId: identity.uuid,
      organizationId: identity.organizationId,
    });
    return reply.status(204).send();
  });

  /** Unlink a chat from a task. */
  app.delete<{ Params: { taskId: string; chatId: string } }>("/:taskId/chats/:chatId", async (request, reply) => {
    requireAgent(request);
    await taskService.unlinkChatFromTask(app.db, request.params.taskId, request.params.chatId);
    return reply.status(204).send();
  });

  /** Task health signal — only meaningful while task.status === "working". */
  app.get<{ Params: { taskId: string } }>("/:taskId/health", async (request) => {
    const identity = requireAgent(request);
    const task = await taskService.getTask(app.db, request.params.taskId);
    if (task.organizationId !== identity.organizationId) {
      throw new NotFoundError(`Task "${request.params.taskId}" not found`);
    }
    return taskService.getTaskHealth(app.db, request.params.taskId);
  });
}
