import {
  addMeChatParticipantsSchema,
  createMeChatSchema,
  listMeChatsQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { BadRequestError } from "../errors.js";
import { memberScope, requireMemberInOrg } from "../services/access-control.js";
import {
  addMeChatParticipants,
  createMeChat,
  joinMeChat,
  leaveMeChat,
  listMeChats,
  markMeChatRead,
} from "../services/me-chat.js";

/**
 * `/me/chats*` member-facing chat APIs for the chat-first workspace. Mounted
 * under the existing `memberAuth` hook.
 *
 * Auth & visibility model: every read/write here resolves through the
 * caller's human agent uuid (member.agentId). Server-side authorisation
 * keeps cross-org leakage impossible — `chats.organization_id` is verified
 * against the participant's own membership inside each service.
 */
export async function meChatRoutes(app: FastifyInstance): Promise<void> {
  /** GET /me/chats — paginated conversation list (chat-first workspace). */
  app.get("/", async (request) => {
    const scope = memberScope(request);
    const query = listMeChatsQuerySchema.parse(request.query);
    return listMeChats(app.db, scope.humanAgentId, query);
  });

  /** POST /me/chats — always creates a new chat (no dedupe).
   *
   * Multi-org resolution: the chat's org is derived from the participants,
   * NOT the caller's JWT default org. A user who is a member of multiple
   * orgs may create a chat with agents in any of them, and `memberScope`
   * — which reads `organizationId` straight off the JWT — would otherwise
   * pin the chat to the JWT default and trip `createMeChat`'s same-org
   * guard ("Cross-organization chat not allowed: …"). Mirrors the same
   * fix shape as `POST /admin/agents/:uuid/chats` (#222) for the
   * /me/chats* surface introduced in the chat-first workspace.
   *
   * Resolution order:
   *   1. Look up the first non-self participant → its `organizationId`.
   *   2. `requireMemberInOrg(targetOrgId)` — verifies the caller is an
   *      active member there and returns THEIR human agent in that org.
   *   3. Hand the resolved `(humanAgentId, organizationId)` pair to
   *      `createMeChat`, which still enforces every other participant
   *      is in the same org via its existing `crossOrg` check.
   */
  app.post("/", async (request, reply) => {
    const scope = memberScope(request);
    const body = createMeChatSchema.parse(request.body);

    const distinct = [...new Set(body.participantIds)].filter((id) => id !== scope.humanAgentId);
    if (distinct.length === 0) {
      throw new BadRequestError("At least one non-self participant required");
    }
    const firstId = distinct[0];
    if (!firstId) {
      // Defensive: distinct.length > 0 implies firstId is defined, but TS
      // narrows on `string | undefined` from array index access.
      throw new BadRequestError("At least one non-self participant required");
    }
    const [firstAgent] = await app.db
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.uuid, firstId))
      .limit(1);
    if (!firstAgent) {
      throw new BadRequestError(`Agent not found: ${firstId}`);
    }
    const probe = await requireMemberInOrg(app.db, request, firstAgent.organizationId);

    const result = await createMeChat(app.db, probe.agentId, firstAgent.organizationId, body);
    return reply.status(201).send(result);
  });

  /** POST /me/chats/:chatId/read — mark the user's row read. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/read", async (request) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    return markMeChatRead(app.db, chatId, scope.humanAgentId);
  });

  /** POST /me/chats/:chatId/participants — add one or more speaking participants. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    const body = addMeChatParticipantsSchema.parse(request.body);
    await addMeChatParticipants(app.db, chatId, scope.humanAgentId, scope.organizationId, body);
    return reply.status(204).send();
  });

  /** POST /me/chats/:chatId/join — watcher → speaking participant. State-carry. */
  app.post<{ Params: { chatId: string } }>("/:chatId/join", async (request, reply) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    await joinMeChat(app.db, chatId, scope.humanAgentId);
    return reply.status(204).send();
  });

  /** POST /me/chats/:chatId/leave — speaking participant → watcher (or detach). */
  app.post<{ Params: { chatId: string } }>("/:chatId/leave", async (request) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    return leaveMeChat(app.db, chatId, scope.humanAgentId);
  });
}
