// Boot the First Tree server in foreground against the e2e DB, with the
// pre-built web/dist served as static files. Used for hand-driven
// verification of the AskUserQuestion UI after `seed-askuser-demo.mjs`.
//
// Skips telemetry / interactive config / migrations — assumes
// `pnpm db:migrate` has already been run against $DATABASE_URL and the
// web has been built to ../web/dist.
//
// Run from packages/server:
//   DATABASE_URL=postgresql://firsttree:firsttree@localhost:5432/fth_e2e_askuser \
//   PORT=8000 \
//   npx tsx scripts/start-demo.mjs

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? "8000");
const HOST = process.env.HOST ?? "127.0.0.1";

const webDistPath = resolve(import.meta.dirname, "..", "..", "web", "dist");
if (!existsSync(webDistPath)) {
  console.error(`web/dist not found at ${webDistPath}; run 'pnpm --filter @first-tree/web build' first.`);
  process.exit(1);
}

const { buildApp } = await import("../src/app.ts");

const config = {
  database: { url: DB_URL, provider: "external" },
  server: { port: PORT, host: HOST, publicUrl: undefined },
  secrets: {
    jwtSecret: process.env.JWT_SECRET_KEY ?? process.env.JWT_SECRET ?? "demo-jwt-secret",
    encryptionKey: process.env.ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  github: { webhookSecret: "demo-webhook", allowedOrg: "demo" },
  oauth: { github: { clientId: "x", clientSecret: "x" } },
  trustProxy: false,
  rateLimit: {
    max: 10000,
    loginMax: 10000,
    webhookMax: 10000,
    agentMessageMax: 10000,
    contextTreeSnapshotMax: 10000,
  },
  observability: { logging: { level: "info", format: "pretty", bridgeToSpanLevel: "off" } },
  runtime: {
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    notificationWebhookUrl: undefined,
  },
  webDistPath,
  instanceId: "demo-foreground",
};

const app = await buildApp(config);
await app.listen({ port: PORT, host: HOST });

const url = `http://${HOST}:${PORT}`;
console.log("");
console.log(`════════════════════════════════════════════════════════════════════`);
console.log(`  First Tree server:     ${url}`);
console.log(`  Web (SPA fallback):    ${url}/`);
console.log(`  API:                   ${url}/api/v1/healthz`);
console.log(`  Login:                 ${url}/login`);
console.log(`════════════════════════════════════════════════════════════════════`);
console.log("");
console.log("Press Ctrl+C to stop.");

const shutdown = async (signal) => {
  console.log(`\nReceived ${signal}; shutting down…`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
