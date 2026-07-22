import { CONNECT_BOOTSTRAP_CODE_PLACEHOLDER } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { buildServerConnectBootstrapCommand } from "../../services/connect-bootstrap-command.js";

export async function bootstrapConfigRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public endpoint — returns bootstrap prerequisites for CLI auto-discovery.
   *
   * `allowedOrg` used to surface here from the global `github.allowedOrg`
   * config; it is now per-installation state on `github_app_installations`
   * (see issue #255). A public bootstrap endpoint can't resolve an
   * installation without a caller, so the field is surfaced as `null`.
   */
  app.get("/config", async (request) => {
    // The public setup preview always models the hosted staging flow. Build
    // its non-authenticating template from the same server-owned path as real
    // connect tokens so deployment mirror/public-URL overrides stay exact.
    const connectBootstrapCommandTemplate =
      app.config.channel === "prod"
        ? null
        : {
            command: buildServerConnectBootstrapCommand({
              app,
              request,
              token: CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
              channel: "staging",
            }).bootstrapCommand,
            codePlaceholder: CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
          };
    return {
      allowedOrg: null as string | null,
      serverCommandVersion: app.commandVersion(),
      // Release channel this server speaks (`dev` | `staging` | `prod`). Lets
      // the web gate channel-scoped affordances (e.g. the staging-only "hide
      // agent final text" view toggle) without shipping prod-visible dev UI.
      channel: app.config.channel,
      connectBootstrapCommandTemplate,
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
