import { getMeDocResponseSchema, getMeDocSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { NotFoundError } from "../errors.js";
import { requireChatAccess } from "../scope/require-resource.js";
import { getMeDocPreview } from "../services/me-doc.js";

export type MeDocsRouteOptions = {
  /**
   * Must point at the same workspaces directory used by agent runtimes; local
   * file preview is unavailable when server and runtime storage diverge.
   */
  workspacesRoot?: string;
};

export async function meDocsRoutes(app: FastifyInstance, options: MeDocsRouteOptions = {}): Promise<void> {
  app.get<{ Params: { chatId: string } }>("/chats/:chatId/docs/preview", async (request) => {
    await requireChatAccess(request, app.db);
    const query = getMeDocSchema.parse(request.query);

    const [participant] = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, request.params.chatId),
          eq(chatMembership.agentId, query.agentId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      )
      .limit(1);
    if (!participant) throw new NotFoundError("Document not found");

    const [agent] = await app.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, query.agentId))
      .limit(1);
    if (!agent?.name) throw new NotFoundError("Document not found");

    const preview = await getMeDocPreview({
      chatId: request.params.chatId,
      agentId: query.agentId,
      agentName: agent.name,
      basePath: query.basePath,
      path: query.path,
      workspacesRoot: options.workspacesRoot,
    });
    return getMeDocResponseSchema.parse(preview);
  });
}
