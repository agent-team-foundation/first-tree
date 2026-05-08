import { adminCreateTaskSchema, taskListQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import type { SendMessageResult } from "../../services/message.js";
import { type Notifier, notifyRecipients } from "../../services/notifier.js";
import * as taskService from "../../services/task.js";

function dispatch(notifier: Notifier, result: SendMessageResult | undefined): void {
  if (!result) return;
  notifyRecipients(notifier, result.recipients, result.message.id);
}

/** Class B — `/api/v1/orgs/:orgId/tasks`. Per-task ops live in api/tasks.ts. */
export async function orgTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = taskListQuerySchema.parse(request.query);
    const result = await taskService.listTasks(app.db, scope.organizationId, query);
    return {
      items: result.items.map((t) => taskService.serializeTask(t)),
      nextCursor: result.nextCursor,
    };
  });

  app.post<{ Params: { orgId: string } }>("/", async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const body = adminCreateTaskSchema.parse(request.body);
    const { task, notification } = await taskService.createTask(
      app.db,
      { type: "admin", adminId: scope.memberId },
      {
        title: body.title,
        body: body.body,
        ...(body.assigneeAgentId !== undefined ? { assigneeAgentId: body.assigneeAgentId } : {}),
        ...(body.originRef !== undefined ? { originRef: body.originRef } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        organizationId: scope.organizationId,
      },
    );
    dispatch(app.notifier, notification);
    return reply.status(201).send(taskService.serializeTask(task));
  });
}
