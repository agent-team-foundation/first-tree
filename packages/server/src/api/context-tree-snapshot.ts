import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../scope/require-user.js";
import { getContextTreeSnapshot } from "../services/context-tree-snapshot.js";
import { getOrgContextTree, resolveUserPrimaryOrgId } from "../services/org-settings.js";

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
      const binding = orgId ? await getOrgContextTree(app.db, orgId) : {};
      const snapshot = await getContextTreeSnapshot(binding, query.window ?? "7d");
      return contextTreeSnapshotSchema.parse(snapshot);
    },
  );
}
