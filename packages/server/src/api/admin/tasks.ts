import {
  adminCreateTaskSchema,
  adminUpdateTaskSchema,
  taskListQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../middleware/require-identity.js";
import type { SendMessageResult } from "../../services/message.js";
import { type Notifier, notifyRecipients } from "../../services/notifier.js";
import { resolveDefaultOrgId, resolveOrganization } from "../../services/organization.js";
import * as taskService from "../../services/task.js";

function dispatch(notifier: Notifier, result: SendMessageResult | undefined): void {
  if (!result) return;
  notifyRecipients(notifier, result.recipients, result.message.id);
}

export async function adminTaskRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve the target organization from the `org` query param (uuid or name), fallback to default. */
  async function resolveOrgId(orgParam: string | undefined): Promise<string> {
    if (orgParam) {
      const resolved = await resolveOrganization(app.db, orgParam);
      return resolved.id;
    }
    return resolveDefaultOrgId(app.db);
  }

  app.get("/", async (request) => {
    const query = taskListQuerySchema.parse(request.query);
    const orgParam = (request.query as Record<string, string>).org;
    const orgId = await resolveOrgId(orgParam);
    const result = await taskService.listTasks(app.db, orgId, query);
    return {
      items: result.items.map((t) => taskService.serializeTask(t)),
      nextCursor: result.nextCursor,
    };
  });

  app.get<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const detail = await taskService.getTaskDetail(app.db, request.params.taskId);
    return {
      ...taskService.serializeTask(detail),
      chats: detail.chats,
    };
  });

  app.post("/", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = adminCreateTaskSchema.parse(request.body);
    const organizationId = body.organizationId ?? (await resolveDefaultOrgId(app.db));
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "admin", adminId: admin.id },
      {
        title: body.title,
        body: body.body,
        ...(body.assigneeAgentId !== undefined ? { assigneeAgentId: body.assigneeAgentId } : {}),
        ...(body.originRef !== undefined ? { originRef: body.originRef } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        organizationId,
      },
    );
    dispatch(app.notifier, notification);
    return reply.status(201).send(taskService.serializeTask(task));
  });

  app.patch<{ Params: { taskId: string } }>("/:taskId", async (request) => {
    const admin = requireAdmin(request);
    const body = adminUpdateTaskSchema.parse(request.body);
    const { task, notification } = await taskService.adminUpdateTask(
      app.db,
      request.params.taskId,
      { type: "admin", adminId: admin.id },
      body,
    );
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.post<{ Params: { taskId: string } }>("/:taskId/cancel", async (request) => {
    const admin = requireAdmin(request);
    const { task, notification } = await taskService.cancelTask(app.db, request.params.taskId, {
      type: "admin",
      adminId: admin.id,
    });
    dispatch(app.notifier, notification);
    return taskService.serializeTask(task);
  });

  app.get<{ Params: { taskId: string } }>("/:taskId/health", async (request) => {
    return taskService.getTaskHealth(app.db, request.params.taskId);
  });
}
