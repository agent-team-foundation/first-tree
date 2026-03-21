import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);

  await app.listen({ host: config.serverHost, port: config.serverPort });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
