import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { ServerConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOrgMembership } from "../../scope/require-org.js";
import {
  type ContextTreeBinding,
  contextTreeSnapshotWindowDays,
  getContextTreeSnapshot,
} from "../../services/context-tree-snapshot.js";
import { getOrgContextTree } from "../../services/org-settings.js";
import { summarizeContextTreeUsage } from "../../services/session-event.js";
import { contextTreeGithubTokenForRepo } from "../context-tree-snapshot.js";

const querySchema = z
  .object({
    window: z.enum(["1d", "3d", "7d", "30d"]).optional(),
  })
  .strict();

type ContextTreeSyncConfig = NonNullable<ServerConfig["contextTreeSync"]>;

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
      const githubToken = contextTreeGithubTokenForRepo(
        binding.repo,
        app.config.contextTreeSync as ContextTreeSyncConfig | undefined,
      );
      const window = query.window ?? "7d";
      const snapshot = await getContextTreeSnapshot({ ...binding, githubToken }, window);
      const usage = await summarizeContextTreeUsage(
        app.db,
        scope.organizationId,
        contextTreeSnapshotWindowDays(window),
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
