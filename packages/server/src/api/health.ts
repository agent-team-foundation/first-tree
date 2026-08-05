import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const db = await app.databaseReadinessProbe.check();
    if (db === "connected") {
      return { status: "ok", db: "connected" };
    }
    return { status: "degraded", db: "disconnected" };
  });
}
