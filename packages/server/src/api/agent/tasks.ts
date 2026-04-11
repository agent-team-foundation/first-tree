import {
  createTaskSchema,
  linkTaskChatSchema,
  taskListQuerySchema,
  updateTaskStatusSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import type { SendMessageResult } from "../../services/message.js";
import { type Notifier, notifyRecipients } from "../../services/notifier.js";
import * as taskService from "../../services/task.js";

function dispatch(notifier: Notifier, result: SendMessageResult | undefined): void {
  if (!result) return;
  notifyRecipients(notifier, result.recipients, result.message.id);
}

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
    dispatch(app.notifier, notification);
    return reply.status(201).send(taskService.serializeTask(task));
  });

  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = taskListQuerySchema.parse(request.query);
    const result = await taskService.listTasks(app.db, identity.organizationId, query);
    return {
      items: result.items.map((t) => taskService.serializeTask(t)),
      nextCursor: result.nextCursor,
    };
  });

  app.get<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const identity = requireAgent(request);
    const detail = await taskService.getTaskDetail(app.db, request.params.taskId, identity.organizationId);
    return {
      ...taskService.serializeTask(detail),
      chats: detail.chats,
    };
  });

  /** Agent self-report: working / completed / failed. */
  app.patch<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const identity = requireAgent(request);
    const body = updateTaskStatusSchema.parse(request.body);
    const { task } = await taskService.updateTaskStatus(
      app.db,
      request.params.taskId,
      { type: "agent", agentId: identity.uuid, organizationId: identity.organizationId },
      body,
    );
    return taskService.serializeTask(task);
  });

  app.post<{ Params: { taskId: string } }>("/:taskId/cancel", async (request) => {
    const identity = requireAgent(request);
    const { task, notification } = await taskService.cancelTask(app.db, request.params.taskId, {
      type: "agent",
      agentId: identity.uuid,
      organizationId: identity.organizationId,
    });
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

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

  app.delete<{ Params: { taskId: string; chatId: string } }>("/:taskId/chats/:chatId", async (request, reply) => {
    const identity = requireAgent(request);
    await taskService.unlinkChatFromTask(app.db, request.params.taskId, request.params.chatId, {
      type: "agent",
      agentId: identity.uuid,
      organizationId: identity.organizationId,
    });
    return reply.status(204).send();
  });

  /** Task health signal — only meaningful while task.status === "working". */
  app.get<{ Params: { taskId: string } }>("/:taskId/health", async (request) => {
    const identity = requireAgent(request);
    return taskService.getTaskHealth(app.db, request.params.taskId, identity.organizationId);
  });
}
