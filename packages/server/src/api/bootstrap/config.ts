import type { FastifyInstance } from "fastify";
import { configuredServerAuthority } from "../../utils/server-authority.js";

export async function bootstrapConfigRoutes(app: FastifyInstance): Promise<void> {
  const serverAuthority = configuredServerAuthority(app.config);

  app.get("/server-authority", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { v: 1 as const, authority: serverAuthority };
  });

  /**
   * Public endpoint — returns bootstrap prerequisites for CLI auto-discovery.
   *
   * `allowedOrg` used to surface here from the global `github.allowedOrg`
   * config; it is now per-installation state on `github_app_installations`
   * (see issue #255). A public bootstrap endpoint can't resolve an
   * installation without a caller, so the field is surfaced as `null`.
   */
  app.get("/config", async () => {
    return {
      allowedOrg: null as string | null,
      serverCommandVersion: app.commandVersion(),
      // Release channel this server speaks (`dev` | `staging` | `prod`). Lets
      // the web gate channel-scoped affordances (e.g. the staging-only "hide
      // agent final text" view toggle) without shipping prod-visible dev UI.
      channel: app.config.channel,
      // Product flag for growth landing funnels. Kept separate from release
      // channel so staging/dev do not implicitly expose public campaigns.
      growthLandingPagesEnabled: app.config.growth.landingPagesEnabled,
      authProviders: {
        google: Boolean(app.config.oauth?.google),
        github: Boolean(app.config.oauth?.githubApp),
      },
    };
  });
}
