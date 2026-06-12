import type { FastifyReply } from "fastify";
import type { DeclareFollowResult } from "../services/github-entity-follow.js";

/**
 * Translate a `declareEntityFollow` outcome to the wire — shared by the
 * user-scoped (`/chats/:chatId/github-entities`) and agent-scoped
 * (`/agent/chats/:chatId/github-entities`) follow routes so the status-code
 * contract can't drift between the two:
 *
 *   created / rebound → 201, already_following → 200,
 *   conflict → 409 + the existing chat's id/topic (the caller decides
 *   between working there and re-issuing with `rebind`).
 */
export function sendFollowResult(reply: FastifyReply, result: DeclareFollowResult, entityRef: string): FastifyReply {
  if (result.outcome === "conflict") {
    return reply.status(409).send({
      error: "ENTITY_FOLLOWED_ELSEWHERE",
      message:
        `This line for ${entityRef} already lives in chat ${result.conflict.chatId}` +
        `${result.conflict.topic ? ` ("${result.conflict.topic}")` : ""}. Default: work in that chat — the ` +
        "context lives there. Re-issue with rebind to MOVE the line into this chat instead.",
      conflict: result.conflict,
    });
  }
  return reply
    .status(result.outcome === "already_following" ? 200 : 201)
    .send({ status: result.outcome, entity: result.entity });
}
