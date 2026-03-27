import { randomUUID } from "node:crypto";
import { initConfig, serverConfigSchema } from "@first-tree-core/shared/config";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";

async function main() {
  const serverConfig = await initConfig({
    schema: serverConfigSchema,
    role: "server",
  });

  const config: Config = {
    ...serverConfig,
    instanceId: `srv_${randomUUID().slice(0, 8)}`,
    logger: true,
  };

  const app = await buildApp(config);
  await app.listen({ host: config.server.host, port: config.server.port });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
