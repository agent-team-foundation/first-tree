import { paginationQuerySchema, sendMessageSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as chatService from "../../services/chat.js";
import * as messageService from "../../services/message.js";

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
