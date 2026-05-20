import { paginationQuerySchema, sendMessageSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAgent } from "../../middleware/require-identity.js";
import { createLogger } from "../../observability/index.js";
import * as chatService from "../../services/chat.js";
import { prepareImageOutbound } from "../../services/image-broadcast.js";
import * as messageService from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";

const log = createLogger("AgentMessages");

const editMessageSchema = z.object({
  format: z.string().optional(),
  content: z.unknown(),
});

/**
 * Per-agent rate limit on outbound message writes. Keyed by `agent.uuid`
 * (populated by `agentSelectorHook`, which runs as an onRequest hook before
 * the global limiter — registered with `hook: "preHandler"` — fires).
 *
 * Rationale: agent ↔ agent reply loops are the documented failure mode
 * (`mention_only` is the semantic guard; this is the hard ceiling).
 *
 * The IP fallback is **defensive scaffolding, not a real code path**. These
 * routes mount under `/agent` which forces `memberAuth + agentSelector`
 * onRequest hooks (see app.ts) — a missing `req.agent` would have already
 * 403'd before this preHandler runs. The fallback exists so that if a future
 * refactor reorders hooks (or detaches one of these routes from the agent
 * scope), the limiter degrades to per-IP keying with a logged warning rather
 * than silently keying everyone to the same `undefined` bucket.
 */
function agentMessageWriteRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest): string => {
        const agentId = req.agent?.uuid;
        if (agentId) return `agent:${agentId}`;
        log.warn(
          { ip: req.ip, route: req.routeOptions?.url ?? req.url },
          "rate-limit keyGenerator fell back to IP — req.agent missing on a route under /agent (hook order regression?)",
        );
        return `ip:${req.ip}`;
      },
    },
  };
}

export async function agentMessageRoutes(app: FastifyInstance): Promise<void> {
  const writeRateLimit = agentMessageWriteRateLimit(app.config.rateLimit?.agentMessageMax ?? 30);

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/messages",
    { config: { ...writeRateLimit, otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      // NOTE: `sendMessageSchema.source` defaults to "api" when omitted
      // (see shared/schemas/message.ts). This is an intentional HTTP-
      // boundary tolerance for SDK callers; production callers all set
      // source explicitly (web/cli/api/feishu/github). Do not "fix" this
      // to require explicit source — it would break unaudited third-
      // party integrations.
      const body = sendMessageSchema.parse(request.body);
      const prepared = await prepareImageOutbound(app.db, app.notifier, request.params.chatId, body);
      const { message: msg, recipients } = await messageService.sendMessage(
        app.db,
        request.params.chatId,
        identity.uuid,
        prepared,
        {
          enforceGroupMention: true,
          normalizeMentionsInContent: true,
          // Agent endpoint preserves content `@<name>` extraction as a
          // **fallback** — when the caller does not declare routing intent
          // via `metadata.mentions` or `receiverNames`, the IM-natural
          // "typed `@b` wakes b" path still works. Declaring either field
          // makes the call explicit-wins and skips content extraction (see
          // `sendMessage`). The full retire of content extraction on agent
          // path is deferred to a follow-up PR.
          extractMentionsFromContent: true,
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

      app.adapterManager
        .editOutboundMessage(msg.id, msg.format, msg.content)
        .catch((err) => log.error({ err, messageId: msg.id }, "failed to edit outbound message"));

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
}
