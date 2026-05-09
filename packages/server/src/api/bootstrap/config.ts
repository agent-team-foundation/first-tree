import type { FastifyInstance } from "fastify";

export async function bootstrapConfigRoutes(_app: FastifyInstance): Promise<void> {
  /**
   * Public endpoint — returns bootstrap prerequisites for CLI auto-discovery.
   *
   * `allowedOrg` used to surface here from the global `github.allowedOrg`
   * config; it is now a per-org setting (see issue #255). A public bootstrap
   * endpoint can't resolve an org without a caller, so the field is
   * surfaced as `null` and consumers should fetch the per-org value via
   * `/api/v1/orgs/:orgId/settings/github_integration` after auth.
   */
  _app.get("/config", async () => {
    return { allowedOrg: null as string | null };
  });
}
