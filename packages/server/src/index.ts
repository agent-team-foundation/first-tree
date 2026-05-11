import { randomUUID } from "node:crypto";
import { initConfig, serverConfigSchema } from "@agent-team-foundation/first-tree-hub-shared/config";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { applyLoggerConfig, createLogger, initTelemetry, shutdownTelemetry } from "./observability/index.js";

const log = createLogger("Bootstrap");

async function main() {
  const serverConfig = await initConfig({
    schema: serverConfigSchema,
    role: "server",
  });

  // Apply logger config first so bootstrap logs use the right level / format.
  applyLoggerConfig({
    level: serverConfig.observability.logging.level,
    format: serverConfig.observability.logging.format,
    bridgeToSpanLevel: serverConfig.observability.logging.bridgeToSpanLevel,
  });

  // Production hardening — `server.publicUrl` is what the connect-token
  // `iss` claim and OAuth callback URL are built off of. Booting prod
  // without it means the CLI's `connect <token>` form would have no
  // anchor and OAuth would echo back to whatever the inbound proxy
  // injected via Host headers (forgery risk). Fail closed instead.
  if (process.env.NODE_ENV === "production" && !serverConfig.server.publicUrl) {
    throw new Error("FIRST_TREE_HUB_PUBLIC_URL is required in production — set the public-facing hub URL.");
  }
  // Reject the half-configured OAuth shape: clientId without secret (or
  // vice versa) almost always means the operator intended to enable OAuth
  // but forgot half the env vars; surface that loudly rather than silently
  // serving a 503 from `/auth/github/start`.
  const oauthGh = serverConfig.oauth?.github;
  if (oauthGh) {
    const half = (oauthGh.clientId && !oauthGh.clientSecret) || (!oauthGh.clientId && oauthGh.clientSecret);
    if (half) {
      throw new Error(
        "GitHub OAuth is half-configured — set BOTH FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID and ..._CLIENT_SECRET, or neither.",
      );
    }
  }

  const config: Config = {
    ...serverConfig,
    instanceId: `srv_${randomUUID().slice(0, 8)}`,
  };

  // Initialize telemetry before anything else — spans emitted during app
  // bootstrap (e.g. notifier.start) will then be captured. instanceId is
  // carried as service.instance.id so replicas are distinguishable in the
  // trace backend.
  await initTelemetry(serverConfig.observability.tracing, config.instanceId);

  const app = await buildApp(config);
  await app.listen({ host: config.server.host, port: config.server.port });
  log.info(`server listening on http://${config.server.host}:${config.server.port}`);

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
    } finally {
      await shutdownTelemetry();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  const bootLog = createLogger("Bootstrap");
  bootLog.fatal({ err }, "failed to start server");
  process.exit(1);
});
