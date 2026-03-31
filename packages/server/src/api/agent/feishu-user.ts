import { delegateFeishuUserSchema } from "@first-tree-hub/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterAgentMappings } from "../../db/schema/adapter-agent-mappings.js";
import { BadRequestError, ConflictError, ForbiddenError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { createAgentMapping } from "../../services/adapter-mapping.js";
import * as agentService from "../../services/agent.js";

export async function agentFeishuUserRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /agent/delegated/:humanAgentId/feishu-user
   * Assistant binds its owner's Feishu user ID via delegate_mention authorization.
   */
  app.post<{ Params: { humanAgentId: string } }>("/:humanAgentId/feishu-user", async (request, reply) => {
    const identity = requireAgent(request);
    const { humanAgentId } = request.params;
    const body = delegateFeishuUserSchema.parse(request.body);

    // 1. Get target human agent
    const humanAgent = await agentService.getAgent(app.db, humanAgentId);
    if (humanAgent.type !== "human") {
      throw new BadRequestError(`Agent "${humanAgentId}" is not a human agent`);
    }

    // 2. Check delegate_mention authorization
    if (humanAgent.delegateMention !== identity.id) {
      throw new ForbiddenError(
        `Agent "${identity.id}" is not the delegate of "${humanAgentId}". ` +
          `Expected delegate_mention="${identity.id}" but found "${humanAgent.delegateMention ?? "(none)"}".`,
      );
    }

    // 3. Create mapping
    try {
      const mapping = await createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: body.feishuUserId,
        agentId: humanAgentId,
        boundVia: "delegate",
        displayName: body.displayName,
      });

      return reply.status(201).send({
        id: mapping.id,
        platform: mapping.platform,
        externalUserId: mapping.externalUserId,
        agentId: mapping.agentId,
        boundVia: mapping.boundVia,
        displayName: mapping.displayName,
        createdAt: mapping.createdAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // Check if it's a unique constraint violation
      const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
      if (pgCode === "23505") {
        throw new ConflictError(`Feishu user "${body.feishuUserId}" is already bound to an agent`);
      }
      throw err;
    }
  });

  /**
   * DELETE /agent/delegated/:humanAgentId/feishu-user
   * Assistant unbinds its owner's Feishu user ID.
   */
  app.delete<{ Params: { humanAgentId: string } }>("/:humanAgentId/feishu-user", async (request, reply) => {
    const identity = requireAgent(request);
    const { humanAgentId } = request.params;

    // 1. Get target human agent
    const humanAgent = await agentService.getAgent(app.db, humanAgentId);

    // 2. Check delegate_mention authorization
    if (humanAgent.delegateMention !== identity.id) {
      throw new ForbiddenError(`Agent "${identity.id}" is not the delegate of "${humanAgentId}"`);
    }

    // 3. Delete mapping
    await app.db
      .delete(adapterAgentMappings)
      .where(and(eq(adapterAgentMappings.platform, "feishu"), eq(adapterAgentMappings.agentId, humanAgentId)));

    return reply.status(204).send();
  });
}
