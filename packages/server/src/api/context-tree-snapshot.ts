import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../scope/require-user.js";
import {
  type ContextTreeBinding,
  contextTreeSnapshotWindowDays,
  getContextTreeSnapshot,
  isGithubRemoteBinding,
} from "../services/context-tree-snapshot.js";
import { findInstallationByOrg } from "../services/github-app-installations.js";
import {
  type ContextTreeInstallationTokenResult,
  decorateSnapshotWithMintGuidance,
  mintContextTreeInstallationToken,
} from "../services/github-app-token.js";
import { getOrgContextTree, resolveUserPrimaryOrgId } from "../services/org-settings.js";
import { summarizeContextTreeUsage } from "../services/session-event.js";

const querySchema = z
  .object({
    window: z.enum(["1d", "7d", "30d"]).optional(),
  })
  .strict();

export async function contextTreeSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/snapshot",
    {
      config: {
        rateLimit: {
          max: app.config.rateLimit?.contextTreeSnapshotMax ?? 6,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest): string => request.user?.userId ?? request.ip,
        },
      },
    },
    async (request) => {
      const query = querySchema.parse(request.query);
      const { userId } = requireUser(request);
      const orgId = await resolveUserPrimaryOrgId(app.db, userId);
      const binding: ContextTreeBinding = orgId ? await getOrgContextTree(app.db, orgId) : {};
      let mintResult: ContextTreeInstallationTokenResult | null = null;
      if (orgId && isGithubRemoteBinding(binding)) {
        const installation = await findInstallationByOrg(app.db, orgId);
        mintResult = await mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
      }
      const githubToken = mintResult?.ok ? mintResult.token : undefined;
      const window = query.window ?? "7d";
      const rawSnapshot = await getContextTreeSnapshot({ ...binding, githubToken }, window);
      const snapshot = mintResult ? decorateSnapshotWithMintGuidance(rawSnapshot, binding, mintResult) : rawSnapshot;
      const usage = orgId
        ? await summarizeContextTreeUsage(app.db, orgId, contextTreeSnapshotWindowDays(window))
        : snapshot.usage;
      return contextTreeSnapshotSchema.parse({ ...snapshot, usage });
    },
  );
}
