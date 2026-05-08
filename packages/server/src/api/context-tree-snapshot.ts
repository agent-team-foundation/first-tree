import { contextTreeSnapshotSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getContextTreeSnapshot } from "../services/context-tree-snapshot.js";

const querySchema = z.object({
  since: z.string().min(1).optional(),
});

export async function contextTreeSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get("/snapshot", async (request) => {
    const query = querySchema.parse(request.query);
    const snapshot = await getContextTreeSnapshot(app.config, query.since);
    return contextTreeSnapshotSchema.parse(snapshot);
  });
}
