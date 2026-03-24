import type { FastifyInstance } from "fastify";

export async function adminAdapterStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    return app.adapterManager.getBotStatuses();
  });
}
