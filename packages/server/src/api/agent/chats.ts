import {
  addParticipantSchema,
  createChatSchema,
  paginationQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as chatService from "../../services/chat.js";

function serializeChat(chat: { createdAt: Date; updatedAt: Date; [key: string]: unknown }) {
  return {
    ...chat,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

export async function agentChatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (request, reply) => {
    const identity = requireAgent(request);
    const body = createChatSchema.parse(request.body);
    const result = await chatService.createChat(app.db, identity.uuid, body);
    return reply.status(201).send({
      ...serializeChat(result),
      participants: result.participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = paginationQuerySchema.parse(request.query);
    const result = await chatService.listChats(app.db, identity.uuid, query.limit, query.cursor);
    return {
      items: result.items.map(serializeChat),
      nextCursor: result.nextCursor,
    };
  });

  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const detail = await chatService.getChatDetail(app.db, request.params.chatId);
    return {
      ...serializeChat(detail),
      participants: detail.participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    };
  });

  /**
   * List chat participants with agent names/displayNames. Used by the client
   * runtime to resolve `@<name>` mentions against the authoritative participant
   * set (see proposals/hub-agent-messaging-reply-and-mentions §4).
   */
  app.get<{ Params: { chatId: string } }>("/:chatId/participants", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const rows = await chatService.listChatParticipantsWithNames(app.db, request.params.chatId);
    return rows.map((r) => ({
      agentId: r.agentId,
      role: r.role,
      mode: r.mode,
      name: r.name,
      displayName: r.displayName,
      type: r.type,
      joinedAt: r.joinedAt.toISOString(),
    }));
  });

  // Participant management
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const identity = requireAgent(request);
    const body = addParticipantSchema.parse(request.body);
    const participants = await chatService.addParticipant(app.db, request.params.chatId, identity.uuid, body);
    return reply.status(201).send(
      participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    );
  });

  app.delete<{ Params: { chatId: string; agentId: string } }>(
    "/:chatId/participants/:agentId",
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.removeParticipant(app.db, request.params.chatId, identity.uuid, request.params.agentId);
      return reply.status(204).send();
    },
  );
}
