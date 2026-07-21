import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const db = await app.dbHealth.check();
    return db.ok ? { status: "ok", db: "connected" } : { status: "degraded", db: "disconnected" };
  });
}
