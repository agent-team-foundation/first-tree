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
  // Half-configured guard for the GitHub App block — the legacy
  // `oauth.github` (OAuth App) check that lived next to this was removed
  // in the D3 cutover. App is the only sign-in path now. All five fields ride together —
  // the App's user-OAuth uses clientId/clientSecret, the App JWT uses
  // appId/privateKeyPem, and the webhook endpoint verifies signatures
  // with webhookSecret. A partially-set block almost always means the
  // operator copied the env recipe but missed one var; fail loud rather
  // than serve a half-working install flow.
  const ghApp = serverConfig.oauth?.githubApp;
  if (ghApp) {
    const required = {
      FIRST_TREE_HUB_GITHUB_APP_ID: ghApp.appId,
      FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID: ghApp.clientId,
      FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET: ghApp.clientSecret,
      FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY: ghApp.privateKeyPem,
      FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET: ghApp.webhookSecret,
    } as const;
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0 && missing.length < Object.keys(required).length) {
      throw new Error(`GitHub App is half-configured — missing env vars: ${missing.join(", ")}. Set all five or none.`);
    }
    // Belt-and-braces: a real PKCS#8 PEM starts with this header. Catches
    // the common operator mistake of pasting only the body or leaving in
    // literal `\n` sequences instead of newlines. Cheap to check at boot.
    if (ghApp.privateKeyPem && !ghApp.privateKeyPem.includes("-----BEGIN PRIVATE KEY-----")) {
      throw new Error(
        "FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY does not look like a PKCS#8 PEM — expected `-----BEGIN PRIVATE KEY-----` header. " +
          "If the value came from a single-line env file, replace literal `\\n` with real newlines.",
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
