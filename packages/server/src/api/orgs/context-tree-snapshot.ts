import { contextTreeSnapshotSchema } from "@first-tree/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOrgMembership } from "../../scope/require-org.js";
import {
  type ContextTreeBinding,
  contextTreeSnapshotWindowDays,
  getContextTreeSnapshot,
  isGithubRemoteBinding,
} from "../../services/context-tree-snapshot.js";
import { findInstallationByOrg } from "../../services/github-app-installations.js";
import {
  type ContextTreeInstallationTokenResult,
  decorateSnapshotWithMintGuidance,
  mintContextTreeInstallationToken,
} from "../../services/github-app-token.js";
import { getOrgContextTree } from "../../services/org-settings.js";
import { summarizeContextTreeUsage } from "../../services/session-event.js";

const querySchema = z
  .object({
    window: z.enum(["1d", "7d", "30d"]).optional(),
  })
  .strict();

export async function orgContextTreeSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>(
    "/snapshot",
    {
      config: {
        rateLimit: {
          max: app.config.rateLimit?.contextTreeSnapshotMax ?? 6,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest): string =>
            `${request.user?.userId ?? request.ip}:${orgIdParam(request.params) ?? "unknown-org"}`,
        },
      },
    },
    async (request) => {
      const query = querySchema.parse(request.query);
      const scope = await requireOrgMembership(request, app.db);
      const binding: ContextTreeBinding = await getOrgContextTree(app.db, scope.organizationId);
      let mintResult: ContextTreeInstallationTokenResult | null = null;
      if (isGithubRemoteBinding(binding)) {
        const installation = await findInstallationByOrg(app.db, scope.organizationId);
        mintResult = await mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
      }
      const githubToken = mintResult?.ok ? mintResult.token : undefined;
      const window = query.window ?? "7d";
      const rawSnapshot = await getContextTreeSnapshot({ ...binding, githubToken }, window);
      const snapshot = mintResult ? decorateSnapshotWithMintGuidance(rawSnapshot, binding, mintResult) : rawSnapshot;
      const usage = await summarizeContextTreeUsage(
        app.db,
        scope.organizationId,
        contextTreeSnapshotWindowDays(window),
        { humanAgentId: scope.humanAgentId, memberId: scope.memberId },
      );
      return contextTreeSnapshotSchema.parse({ ...snapshot, usage });
    },
  );
}

function orgIdParam(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  if (!("orgId" in params)) return null;
  const orgId = params.orgId;
  return typeof orgId === "string" ? orgId : null;
}
