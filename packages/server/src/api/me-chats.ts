import {
  addMeChatParticipantsSchema,
  createMeChatSchema,
  listMeChatsQuerySchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { memberScope } from "../services/access-control.js";
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

  /** POST /me/chats — always creates a new chat (no dedupe). */
  app.post("/", async (request, reply) => {
    const scope = memberScope(request);
    const body = createMeChatSchema.parse(request.body);
    const result = await createMeChat(app.db, scope.humanAgentId, scope.organizationId, body);
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
