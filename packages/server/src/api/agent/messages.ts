import { paginationQuerySchema, sendMessageSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgent } from "../../middleware/require-identity.js";
import * as chatService from "../../services/chat.js";
import * as messageService from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";

const editMessageSchema = z.object({
  format: z.string().optional(),
  content: z.unknown(),
});

export async function agentMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/messages",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      // NOTE: `sendMessageSchema.source` defaults to "api" when omitted
      // (see shared/schemas/message.ts). This is an intentional HTTP-
      // boundary tolerance for SDK callers; production callers all set
      // source explicitly (web/cli/api/github). Do not "fix" this
      // to require explicit source — it would break unaudited third-
      // party integrations.
      const body = sendMessageSchema.parse(request.body);
      const { message: msg, recipients } = await messageService.sendMessage(
        app.db,
        request.params.chatId,
        identity.uuid,
        body,
        {
          // Explicit-recipient enforcement is the default in `sendMessage()`;
          // this route carries no business flag. Agent SDK callers (CLI
          // `chat send`, result-sink, etc.) declare routing via `receiverNames`
          // or `metadata.mentions`, or set `purpose: "agent-final-text"` for
          // silent history-only sends. The server no longer parses `@<name>`
          // out of content — see `services/message.ts` Routing contract.
          //
          // Auto-prepend `@<name>` for declared mentions missing from the
          // body so the rendered message matches the routing decision
          // (mainly: result-sink puts the trigger sender in `mentions` but
          // the agent's text rarely includes the @).
          normalizeMentionsInContent: true,
        },
      );

      notifyRecipients(app.notifier, recipients, msg.id);

      return reply.status(201).send({
        ...msg,
        createdAt: msg.createdAt.toISOString(),
      });
    },
  );

  app.patch<{ Params: { chatId: string; messageId: string } }>(
    "/:chatId/messages/:messageId",
    { config: { otelRecordBody: true } },
    async (request) => {
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

      return {
        ...msg,
        createdAt: msg.createdAt.toISOString(),
      };
    },
  );

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

  // The caller's currently-open questions in this chat, window-independent —
  // the blocking answer UI reads this so an open ask that scrolled past the
  // (capped, unpaginated) message page still surfaces.
  app.get<{ Params: { chatId: string } }>("/:chatId/open-requests", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const items = await messageService.listOpenRequestsForViewer(app.db, request.params.chatId, identity.uuid);
    return {
      items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  });
}
