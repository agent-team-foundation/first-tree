import { startRunWorld, stopRunWorld } from "../framework/lifecycle.js";

async function main(): Promise<void> {
  const world = await startRunWorld();
  console.log("e2e environment ready");
  console.log(`  runId:        ${world.identity.runId}`);
  console.log(`  serverBaseUrl: ${world.server.baseUrl}`);
  console.log(`  databaseUrl:  ${world.pg.databaseUrl}`);
  console.log(`  clientHome:   ${world.identity.home}`);
  console.log("\nPress Ctrl-C to tear down.");

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const handler = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`\nReceived ${signal}, shutting down…`);
      stopRunWorld().finally(() => resolve());
    };
    process.once("SIGINT", () => handler("SIGINT"));
    process.once("SIGTERM", () => handler("SIGTERM"));
  });
}

main().catch((err) => {
  console.error("e2e:up failed:", err);
  process.exit(1);
});
