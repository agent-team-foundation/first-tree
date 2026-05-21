import {
  addParticipantSchema,
  createChatSchema,
  paginationQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { createLogger } from "../../observability/index.js";
import { agentAvatarImageUrl } from "../../services/agent.js";
import { getAttachmentForDownload } from "../../services/attachment.js";
import * as chatService from "../../services/chat.js";
import { WIRE_RECIPIENT_MODE } from "../../services/message-dispatcher.js";
import { sendAttachmentResponse } from "../attachment-response.js";

const log = createLogger("AgentChatsRoute");

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
    const detail = await chatService.getChatDetail(app.db, request.params.chatId, identity.uuid);
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
      // v2: wire `mode` field is reserved for v3 cleanup; write the constant
      // `WIRE_RECIPIENT_MODE` so already-deployed client runtimes that still
      // parse the field see a stable value. No consumer reads this today.
      mode: WIRE_RECIPIENT_MODE,
      name: r.name,
      displayName: r.displayName,
      type: r.type,
      joinedAt: r.joinedAt.toISOString(),
      avatarColorToken: r.avatarColorToken ?? null,
      avatarImageUrl: agentAvatarImageUrl(r.agentId, r.avatarImageUpdatedAt ?? null),
    }));
  });

  /**
   * GET /agent/chats/:chatId/attachments/:attachmentId — download an
   * attachment's bytes for the agent runtime to materialise locally and Read
   * (route 2). Same member-gated, hardened-header path as the web route; the
   * viewer is the agent itself.
   */
  app.get<{ Params: { chatId: string; attachmentId: string } }>(
    "/:chatId/attachments/:attachmentId",
    async (request, reply) => {
      const identity = requireAgent(request);
      const att = await getAttachmentForDownload(app.db, {
        chatId: request.params.chatId,
        attachmentId: request.params.attachmentId,
        viewerId: identity.uuid,
      });
      sendAttachmentResponse(reply, att);
    },
  );

  // Participant management
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const identity = requireAgent(request);

    // Reject the deprecated `mode` field early with a clear error. Phase 1
    // moved participant mode to server-derived state; callers that still
    // send `mode` would otherwise have it silently ignored, which is
    // strictly worse than a loud 400. The log entry is the regression
    // signal — operators can grep for `MODE_FIELD_DEPRECATED` to find any
    // remaining caller that needs updating. See design doc §3.2.
    if (request.body !== null && typeof request.body === "object" && "mode" in request.body) {
      log.warn(
        {
          code: "MODE_FIELD_DEPRECATED",
          chatId: request.params.chatId,
          senderAgentId: identity.uuid,
          userAgent: request.headers["user-agent"] ?? "unknown",
        },
        "Rejected: addParticipant body contains deprecated `mode` field",
      );
      return reply.status(400).send({
        error:
          "MODE_FIELD_DEPRECATED: the `mode` field is no longer accepted. Participant mode is derived server-side from chat type + agent type. Remove this field from your request.",
      });
    }

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
