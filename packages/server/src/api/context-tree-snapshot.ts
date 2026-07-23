import { contextTreeSnapshotSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTimingCollector } from "../observability/timing.js";
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
  mintContextTreeInstallationToken,
  resolveContextTreeRecoveryAction,
} from "../services/github-app-token.js";
import {
  getOrgContextReviewRuntime,
  isOrgContextReviewRuntimeCurrent,
  resolveUserPrimaryOrgId,
} from "../services/org-settings.js";
import { summarizeContextTreeUsage } from "../services/session-event.js";

const querySchema = z
  .object({
    window: z.enum(["1d", "7d", "30d"]).optional(),
  })
  .strict();

export async function contextTreeSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get("/snapshot", async (request, reply) => {
    const timing = createTimingCollector();
    const query = timing.timeSync("parse_query", () => querySchema.parse(request.query));
    const { userId } = timing.timeSync("auth", () => requireUser(request));
    const orgId = await timing.time("resolve_primary_org", () => resolveUserPrimaryOrgId(app.db, userId));
    const reviewRuntime = orgId
      ? await timing.time("context_tree_runtime", () => getOrgContextReviewRuntime(app.db, orgId))
      : null;
    const binding: ContextTreeBinding = {
      ...(reviewRuntime?.provider ? { provider: reviewRuntime.provider } : {}),
      ...(reviewRuntime?.repo ? { repo: reviewRuntime.repo } : {}),
      ...(reviewRuntime?.branch ? { branch: reviewRuntime.branch } : {}),
    };
    let mintResult: ContextTreeInstallationTokenResult | null = null;
    if (orgId && isGithubRemoteBinding(binding)) {
      mintResult = await timing.time("github_token", async () => {
        const installation = await findInstallationByOrg(app.db, orgId);
        return mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
      });
    }
    const githubToken = mintResult?.ok ? mintResult.token : undefined;
    const window = query.window ?? "7d";
    const snapshot = await timing.time("snapshot_build", () =>
      getContextTreeSnapshot({ ...binding, githubToken }, window, {
        timing: timing.add,
        gitlabInstanceOrigin: reviewRuntime?.gitlabConnection?.instanceOrigin,
        gitlabEgressAllowlist: app.config.gitlab?.egressAllowlist ?? [],
        gitlabExecutionGuard:
          orgId && reviewRuntime?.provider === "gitlab"
            ? () => isOrgContextReviewRuntimeCurrent(app.db, orgId, reviewRuntime)
            : undefined,
      }),
    );
    // Probe (only on the unavailable + GitHub-remote + minted path) whether the
    // App genuinely cannot read the repo. Keep the structured diagnosis for API
    // compatibility and observability; the Context tab routes recovery to chat.
    const recoveryAction = mintResult
      ? await timing.time("github_recovery", () => resolveContextTreeRecoveryAction(snapshot, binding, mintResult))
      : null;
    const viewer = orgId ? await timing.time("resolve_viewer", () => resolveOrgViewer(app.db, userId, orgId)) : null;
    const usage = orgId
      ? await timing.time("usage_summary", () =>
          summarizeContextTreeUsage(app.db, orgId, contextTreeSnapshotWindowDays(window), viewer ?? undefined),
        )
      : snapshot.usage;
    // With an org: telemetry reads + git-derived writes reconciled for agent
    // attribution. Without one: keep the snapshot's git-derived io.writes as-is
    // (no telemetry to reconcile against). Same path as the org-scoped route so
    // writes never silently empty here. See buildContextTreeIoSummary.
    const io = orgId
      ? await timing.time("io_summary", () =>
          buildContextTreeIoSummary(
            app.db,
            orgId,
            contextTreeSnapshotWindowDays(window),
            snapshot.io.writes,
            viewer ?? undefined,
            { contextTreeBinding: binding, timing: timing.add },
          ),
        )
      : snapshot.io;
    const response = timing.timeSync("schema_parse", () =>
      contextTreeSnapshotSchema.parse({ ...snapshot, recoveryAction, usage, io }),
    );
    const totalMs = timing.elapsedMs();
    reply.header("Server-Timing", timing.serverTimingHeader());
    request.log[totalMs > 1500 || timing.records.some((record) => record.ms > 500) ? "warn" : "info"](
      {
        event: "context_tree_snapshot_timing",
        orgId,
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
