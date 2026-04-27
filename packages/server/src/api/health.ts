import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    try {
      await app.db.execute(sql`SELECT 1`);
      // `commandVersion` is the version of the `command` package that
      // bundled this server. The CLI's `client connect` reads it on
      // first contact so it can warn (M8 P2 in
      // docs/saas-onboarding-journey.md) when the locally-installed
      // CLI is older than what the server expects — the WS-driven
      // UpdateManager only kicks in for the long-running `client
      // start` runtime, not for one-shot subcommands like `connect`.
      return { status: "ok", db: "connected", commandVersion: app.commandVersion };
    } catch {
      return { status: "degraded", db: "disconnected", commandVersion: app.commandVersion };
    }
  });
}
