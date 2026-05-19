import { startRunWorld, stopRunWorld } from "../framework/lifecycle.js";
import { createComponentLogger } from "../framework/logging.js";
import { type DevUserSession, setupDevUser } from "../framework/setup-devuser.js";

async function main(): Promise<void> {
  const withClient = process.env.E2E_WITH_CLIENT === "1" || process.env.E2E_WITH_CLIENT === "true";
  const world = await startRunWorld({
    withClient,
    // Enable the web dev-login bypass so a human can sign in via the
    // "Continue as Dev User" button on /login while the env is parked.
    serverExtraEnv: { FIRST_TREE_HUB_DEV_CALLBACK_ENABLED: "1" },
  });

  // Drive the real "log in as Dev User → generate connect-token → CLI connect"
  // flow so that by the time this script announces ready, the web settings
  // page for devuser shows a live client.
  const devLogger = createComponentLogger(world.identity.runDir, "devuser");
  world.loggers.push(devLogger);
  let devSession: DevUserSession | null = null;
  try {
    devSession = await setupDevUser({
      serverBaseUrl: world.server.baseUrl,
      databaseUrl: world.pg.databaseUrl,
      runHome: world.identity.home,
      logger: devLogger,
    });
  } catch (err) {
    console.error("\ndevuser provisioning failed:", err);
    console.error("Environment kept alive for manual debugging. Press Ctrl-C to tear down.");
  }

  console.log("e2e environment ready");
  console.log(`  runId:        ${world.identity.runId}`);
  console.log(`  serverBaseUrl: ${world.server.baseUrl}`);
  console.log(`  databaseUrl:  ${world.pg.databaseUrl}`);
  console.log(`  clientHome:   ${world.identity.home}`);
  if (world.credentials) {
    console.log(`  fixtureUser:  username=e2e-…  userId=${world.credentials.userId}`);
    console.log(`  fixtureOrg:   ${world.credentials.organizationId}`);
    console.log(`  fixtureAgent: name=${world.credentials.humanAgentName}  id=${world.credentials.humanAgentId}`);
    console.log(`  fixtureClient: ${world.credentials.clientId}`);
  }
  if (devSession) {
    console.log(`  devUser:      username=${devSession.username}  userId=${devSession.userId}`);
    console.log(`  devOrg:       ${devSession.organizationId}`);
    console.log(`  devClient:    ${devSession.clientId}  (status=connected)`);
    console.log(`  devHome:      ${devSession.home}`);
    console.log(`  devAgent:     name=${devSession.agentName}  id=${devSession.agentId}`);
    console.log(`  devChat:      ${devSession.chatId}  (1 message)`);
  } else {
    console.log(`  devUser:      ** provisioning failed — see error above **`);
  }
  console.log("\nWeb dev login:");
  console.log(`  start web:  VITE_PROXY_TARGET=${world.server.baseUrl} pnpm --filter @first-tree-hub/web dev`);
  console.log(`  then open:  http://localhost:5173/login  →  "Continue as Dev User"`);
  if (devSession) console.log(`              settings should now list client ${devSession.clientId}`);
  console.log("\nPress Ctrl-C to tear down.");

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const handler = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`\nReceived ${signal}, shutting down…`);
      (async () => {
        if (devSession) await devSession.stop().catch(() => undefined);
        await stopRunWorld();
        resolve();
      })();
    };
    process.once("SIGINT", () => handler("SIGINT"));
    process.once("SIGTERM", () => handler("SIGTERM"));
  });
}

main().catch((err) => {
  console.error("e2e:up failed:", err);
  process.exit(1);
});
