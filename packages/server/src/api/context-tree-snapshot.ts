import { contextTreeSnapshotSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveOrgViewer } from "../scope/require-resource.js";
import { requireUser } from "../scope/require-user.js";
import { buildContextTreeIoSummary } from "../services/context-tree-io.js";
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
  app.get("/snapshot", async (request) => {
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
    const viewer = orgId ? await resolveOrgViewer(app.db, userId, orgId) : null;
    const usage = orgId
      ? await summarizeContextTreeUsage(app.db, orgId, contextTreeSnapshotWindowDays(window), viewer ?? undefined)
      : snapshot.usage;
    // With an org: telemetry reads + git-derived writes reconciled for agent
    // attribution. Without one: keep the snapshot's git-derived io.writes as-is
    // (no telemetry to reconcile against). Same path as the org-scoped route so
    // writes never silently empty here. See buildContextTreeIoSummary.
    const io = orgId
      ? await buildContextTreeIoSummary(
          app.db,
          orgId,
          contextTreeSnapshotWindowDays(window),
          snapshot.io.writes,
          viewer ?? undefined,
        )
      : snapshot.io;
    return contextTreeSnapshotSchema.parse({ ...snapshot, usage, io });
  });
}
