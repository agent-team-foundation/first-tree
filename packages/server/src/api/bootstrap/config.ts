import type { FastifyInstance } from "fastify";

export async function bootstrapConfigRoutes(_app: FastifyInstance): Promise<void> {
  /**
   * Public endpoint — returns bootstrap prerequisites for CLI auto-discovery.
   *
   * `allowedOrg` used to surface here from the global `github.allowedOrg`
   * config; it is now per-installation state on `github_app_installations`
   * (see issue #255). A public bootstrap endpoint can't resolve an
   * installation without a caller, so the field is surfaced as `null`.
   */
  _app.get("/config", async () => {
    return { allowedOrg: null as string | null };
  });
}
