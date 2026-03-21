import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    try {
      await app.db.execute(sql`SELECT 1`);
      return { status: "ok", db: "connected" };
    } catch {
      return { status: "degraded", db: "disconnected" };
    }
  });
}
