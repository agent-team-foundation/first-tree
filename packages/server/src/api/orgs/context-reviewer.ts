import {
  contextReviewerAssignmentInputSchema,
  contextReviewerCandidatesOutputSchema,
  contextReviewerEnablementInputSchema,
  orgContextTreeFeaturesOutputSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { listContextReviewerCandidates } from "../../services/context-reviewer-readiness.js";
import {
  putContextReviewerAssignment,
  putContextReviewerEnablement,
} from "../../services/context-reviewer-settings.js";

/** Class B — `/api/v1/orgs/:orgId/context-reviewer`. */
export async function orgContextReviewerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/candidates", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const result = await listContextReviewerCandidates(app.db, {
      organizationId: scope.organizationId,
      now: new Date(),
      staleSeconds: app.config.runtime.presenceCleanupSeconds,
    });
    return contextReviewerCandidatesOutputSchema.parse(result);
  });

  app.put<{ Params: { orgId: string }; Body: unknown }>("/assignment", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const input = contextReviewerAssignmentInputSchema.parse(request.body);
    return orgContextTreeFeaturesOutputSchema.parse(
      await putContextReviewerAssignment(app.db, scope.organizationId, input.agentUuid, {
        updatedBy: scope.userId,
      }),
    );
  });

  app.put<{ Params: { orgId: string }; Body: unknown }>("/enablement", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const input = contextReviewerEnablementInputSchema.parse(request.body);
    return orgContextTreeFeaturesOutputSchema.parse(
      await putContextReviewerEnablement(app.db, scope.organizationId, input.enabled, {
        updatedBy: scope.userId,
        staleSeconds: app.config.runtime.presenceCleanupSeconds,
        githubAppCredentials: app.config.oauth?.githubApp,
      }),
    );
  });
}
