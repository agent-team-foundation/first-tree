import { registerPreTeardownHook, startRunWorld } from "../framework/lifecycle.js";
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

  // Stop the devuser CLI child before lifecycle tears down server/pg, so its
  // WebSocket gets a clean close instead of a server-pulled-out-from-under-it
  // EHOSTUNREACH. Registered via lifecycle's hook list rather than a
  // parallel `process.once("SIGINT")` to avoid racing the lifecycle handler.
  if (devSession) {
    const session = devSession;
    registerPreTeardownHook(() => session.stop().catch(() => undefined));
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
    console.log(`  devMsg:       ${devSession.firstMessageId}`);
  } else {
    console.log(`  devUser:      ** provisioning failed — see error above **`);
  }
  console.log("\nWeb dev login:");
  console.log(`  start web:  VITE_PROXY_TARGET=${world.server.baseUrl} pnpm --filter @first-tree-hub/web dev`);
  console.log(`  then open:  http://localhost:5173/login  →  "Continue as Dev User"`);
  if (devSession) console.log(`              settings should now list client ${devSession.clientId}`);
  console.log("\nPress Ctrl-C to tear down.");

  // Park forever — lifecycle's SIGINT/SIGTERM handler (set up in
  // registerProcessExitHooks) drives the actual shutdown via the
  // pre-teardown hook registered above and then `process.exit(130)`.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("e2e:up failed:", err);
  process.exit(1);
});
