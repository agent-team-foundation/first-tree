import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getContextTreeSnapshot } from "../services/context-tree-snapshot.js";

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
      const snapshot = await getContextTreeSnapshot(app.config, query.window ?? "7d");
      return contextTreeSnapshotSchema.parse(snapshot);
    },
  );
}
