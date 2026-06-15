import { contextTreeSnapshotSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgMembership } from "../../scope/require-org.js";
import { buildContextTreeIoSummary } from "../../services/context-tree-io.js";
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
  app.get<{ Params: { orgId: string } }>("/snapshot", async (request) => {
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
    const usage = await summarizeContextTreeUsage(app.db, scope.organizationId, contextTreeSnapshotWindowDays(window), {
      humanAgentId: scope.humanAgentId,
      memberId: scope.memberId,
    });
    const windowDays = contextTreeSnapshotWindowDays(window);
    // Reads come from telemetry; writes are the snapshot's git-derived rows
    // reconciled against write telemetry for agent attribution (complete,
    // PR merges included, deduped). See buildContextTreeIoSummary.
    const io = await buildContextTreeIoSummary(app.db, scope.organizationId, windowDays, snapshot.io.writes, {
      humanAgentId: scope.humanAgentId,
      memberId: scope.memberId,
    });
    return contextTreeSnapshotSchema.parse({ ...snapshot, usage, io });
  });
}
