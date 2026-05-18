import { writeFileSync } from "node:fs";
import { HANDLE_PATH } from "./current-handle.js";
import { startRunWorld, stopRunWorld } from "./lifecycle.js";

/**
 * Vitest globalSetup hook. Boots one shared `pg + server [+ client]` per
 * vitest run. Whether the spawned client comes up is gated by
 * `E2E_WITH_CLIENT=1` so the existing smoke test (M1) keeps the cheaper
 * server-only path while messaging / github-webhook / agent-runtime tests
 * opt into a real authenticated client.
 *
 * The world handle is dumped to `.e2e-runs/current.json`; individual tests
 * read it via `readCurrentHandle()` and reach into HTTP / WS / PG directly.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const withClient = process.env.E2E_WITH_CLIENT === "1";
  const world = await startRunWorld({ withClient });
  writeFileSync(
    HANDLE_PATH,
    JSON.stringify(
      {
        runId: world.identity.runId,
        serverBaseUrl: world.server.baseUrl,
        databaseUrl: world.pg.databaseUrl,
        clientHome: world.identity.home,
        jwtSecret: world.jwtSecret,
        githubWebhookSecret: world.githubApp.webhookSecret,
        credentials: world.credentials,
      },
      null,
      2,
    ),
  );
  return async () => {
    await stopRunWorld();
  };
}
