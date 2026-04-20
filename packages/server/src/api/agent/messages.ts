import {
  paginationQuerySchema,
  sendMessageSchema,
  sendToAgentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgent } from "../../middleware/require-identity.js";
import { createLogger } from "../../observability/index.js";
import * as chatService from "../../services/chat.js";
import * as messageService from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";

const log = createLogger("AgentMessages");

const editMessageSchema = z.object({
  format: z.string().optional(),
  content: z.unknown(),
});

export async function agentMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const body = sendMessageSchema.parse(request.body);
    const { message: msg, recipients } = await messageService.sendMessage(
      app.db,
      request.params.chatId,
      identity.uuid,
      body,
    );

    notifyRecipients(app.notifier, recipients, msg.id);

    return reply.status(201).send({
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    });
  });

  app.patch<{ Params: { chatId: string; messageId: string } }>("/:chatId/messages/:messageId", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const body = editMessageSchema.parse(request.body);
    const msg = await messageService.editMessage(
      app.db,
      request.params.chatId,
      request.params.messageId,
      identity.uuid,
      body,
    );

    app.adapterManager
      .editOutboundMessage(msg.id, msg.format, msg.content)
      .catch((err) => log.error({ err, messageId: msg.id }, "failed to edit outbound message"));

    return {
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    };
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const query = paginationQuerySchema.parse(request.query);
    const result = await messageService.listMessages(app.db, request.params.chatId, query.limit, query.cursor);
    return {
      items: result.items.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  });
}

export async function agentSendToAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { name: string } }>("/:name/messages", async (request, reply) => {
    const identity = requireAgent(request);
    const body = sendToAgentSchema.parse(request.body);
    const { message: msg, recipients } = await messageService.sendToAgent(
      app.db,
      identity.uuid,
      request.params.name,
      body,
    );

    notifyRecipients(app.notifier, recipients, msg.id);

    return reply.status(201).send({
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    });
  });
}
