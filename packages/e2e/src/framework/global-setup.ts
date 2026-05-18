import { writeFileSync } from "node:fs";
import { HANDLE_PATH } from "./current-handle.js";
import { startRunWorld, stopRunWorld } from "./lifecycle.js";

/**
 * Vitest globalSetup hook. Boots one shared `pg + server` per vitest run
 * and (when M2 lands the connect-token helper) also a `client`. Tests use
 * HTTP / WS to talk to that world. The world handle is dumped to
 * `.e2e-runs/current.json` so individual tests can pick up `baseUrl` / port
 * info without going through globalThis hacks.
 *
 * M1 default: server-only. Flip `withClient: true` in M2 once credentials
 * provisioning is wired up — see `lifecycle.ts` StartRunOptions.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const world = await startRunWorld({ withClient: false });
  writeFileSync(
    HANDLE_PATH,
    JSON.stringify(
      {
        runId: world.identity.runId,
        serverBaseUrl: world.server.baseUrl,
        databaseUrl: world.pg.databaseUrl,
        clientHome: world.identity.home,
      },
      null,
      2,
    ),
  );
  return async () => {
    await stopRunWorld();
  };
}
