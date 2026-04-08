import { bootstrapTokenRequestSchema } from "@first-tree-hub/shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import * as agentService from "../../services/agent.js";

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /bootstrap/:agentId/token
   * GitHub identity → Agent token.
   * Auto-creates the agent if it does not exist.
   * Only works when the agent has no active tokens.
   */
  app.post<{ Params: { agentId: string } }>("/:agentId/token", async (request, reply) => {
    const { agentId } = request.params;
    const githubUser = request.githubUser;
    if (!githubUser) {
      throw new ForbiddenError("GitHub authentication required");
    }

    // Check GitHub org membership if configured
    const allowedOrg = app.config.github.allowedOrg;
    if (allowedOrg) {
      const githubToken = request.headers["x-github-token"];
      if (!githubToken || typeof githubToken !== "string") {
        throw new ForbiddenError("Missing GitHub token for org membership check");
      }
      const isMember = await agentService.checkGitHubOrgMembership(githubToken, allowedOrg);
      if (!isMember) {
        throw new ForbiddenError(
          `GitHub user "${githubUser.username}" is not a member of organization "${allowedOrg}"`,
        );
      }
    }

    const body = bootstrapTokenRequestSchema.parse(request.body ?? {});
    const result = await agentService.bootstrapToken(app.db, agentId, githubUser.username, {
      tokenName: body.name,
      type: body.type,
      displayName: body.displayName,
      profile: body.profile,
      metadata: body.metadata,
    });

    return reply.status(201).send({
      id: result.id,
      agentId: result.agentId,
      name: result.name,
      token: result.token,
      expiresAt: result.expiresAt?.toISOString() ?? null,
      createdAt: result.createdAt.toISOString(),
    });
  });

  /**
   * GET /bootstrap/:agentId/status
   * Check if an agent exists and its status (for polling).
   */
  app.get<{ Params: { agentId: string } }>("/:agentId/status", async (request) => {
    const { agentId } = request.params;
    const githubUser = request.githubUser;
    if (!githubUser) {
      throw new ForbiddenError("GitHub authentication required");
    }

    try {
      const agent = await agentService.getAgent(app.db, agentId);

      // Verify caller is in owners
      const owners: string[] = Array.isArray(agent.metadata?.owners) ? (agent.metadata.owners as string[]) : [];
      if (!owners.includes(githubUser.username)) {
        throw new ForbiddenError(
          `GitHub user "${githubUser.username}" is not in the owners list for agent "${agentId}"`,
        );
      }

      return {
        exists: true,
        status: agent.status as "active" | "suspended",
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { exists: false, status: null };
      }
      throw err;
    }
  });
}
