import { contextTreeSnapshotSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTimingCollector } from "../../observability/timing.js";
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
  app.get<{ Params: { orgId: string } }>("/snapshot", async (request, reply) => {
    const timing = createTimingCollector();
    const query = timing.timeSync("parse_query", () => querySchema.parse(request.query));
    const scope = await timing.time("auth", () => requireOrgMembership(request, app.db));
    const binding: ContextTreeBinding = await timing.time("binding", () =>
      getOrgContextTree(app.db, scope.organizationId),
    );
    let mintResult: ContextTreeInstallationTokenResult | null = null;
    if (isGithubRemoteBinding(binding)) {
      mintResult = await timing.time("github_token", async () => {
        const installation = await findInstallationByOrg(app.db, scope.organizationId);
        return mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
      });
    }
    const githubToken = mintResult?.ok ? mintResult.token : undefined;
    const window = query.window ?? "7d";
    const rawSnapshot = await timing.time("snapshot_build", () =>
      getContextTreeSnapshot({ ...binding, githubToken }, window, { timing: timing.add }),
    );
    const snapshot = mintResult ? decorateSnapshotWithMintGuidance(rawSnapshot, binding, mintResult) : rawSnapshot;
    const usage = await timing.time("usage_summary", () =>
      summarizeContextTreeUsage(app.db, scope.organizationId, contextTreeSnapshotWindowDays(window), {
        humanAgentId: scope.humanAgentId,
        memberId: scope.memberId,
      }),
    );
    const windowDays = contextTreeSnapshotWindowDays(window);
    // Reads come from telemetry; writes are the snapshot's git-derived rows
    // reconciled against write telemetry for agent attribution (complete,
    // PR merges included, deduped). See buildContextTreeIoSummary.
    const io = await timing.time("io_summary", () =>
      buildContextTreeIoSummary(
        app.db,
        scope.organizationId,
        windowDays,
        snapshot.io.writes,
        {
          humanAgentId: scope.humanAgentId,
          memberId: scope.memberId,
        },
        { contextTreeBinding: binding, timing: timing.add },
      ),
    );
    const response = timing.timeSync("schema_parse", () => contextTreeSnapshotSchema.parse({ ...snapshot, usage, io }));
    const totalMs = timing.elapsedMs();
    reply.header("Server-Timing", timing.serverTimingHeader());
    request.log[totalMs > 1500 || timing.records.some((record) => record.ms > 500) ? "warn" : "info"](
      {
        event: "context_tree_snapshot_timing",
        orgId: scope.organizationId,
        window,
        snapshotStatus: response.snapshotStatus,
        nodeCount: response.nodes.length,
        updateCount: response.updates.length,
        totalMs,
        timings: timing.records,
      },
      "context tree snapshot timing",
    );
    return response;
  });
}
