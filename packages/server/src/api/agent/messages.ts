import { paginationQuerySchema, sendMessageSchema, sendToAgentSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgent } from "../../middleware/require-identity.js";
import * as chatService from "../../services/chat.js";
import * as messageService from "../../services/message.js";

const editMessageSchema = z.object({
  format: z.string().optional(),
  content: z.unknown(),
});

export async function agentMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.id);
    const body = sendMessageSchema.parse(request.body);
    const msg = await messageService.sendMessage(app.db, request.params.chatId, identity.id, body);
    return reply.status(201).send({
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    });
  });

  app.patch<{ Params: { chatId: string; messageId: string } }>("/:chatId/messages/:messageId", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.id);
    const body = editMessageSchema.parse(request.body);
    const msg = await messageService.editMessage(
      app.db,
      request.params.chatId,
      request.params.messageId,
      identity.id,
      body,
    );

    // Fire-and-forget: edit on external platforms
    app.adapterManager
      .editOutboundMessage(msg.id, msg.format, msg.content)
      .catch((err) => app.log.error({ err, messageId: msg.id }, "Failed to edit outbound message"));

    return {
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    };
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.id);
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
  app.post<{ Params: { agentId: string } }>("/:agentId/messages", async (request, reply) => {
    const identity = requireAgent(request);
    const body = sendToAgentSchema.parse(request.body);
    const msg = await messageService.sendToAgent(app.db, identity.id, request.params.agentId, body);
    return reply.status(201).send({
      ...msg,
      createdAt: msg.createdAt.toISOString(),
    });
  });
}
