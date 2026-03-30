import type { FastifyInstance } from "fastify";

export async function agentContextTreeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => {
    const { repo, branch } = app.config.contextTree;
    if (!repo) {
      return reply.status(404).send({ error: "Context Tree not configured" });
    }
    return reply.send({ repo, branch });
  });
}
