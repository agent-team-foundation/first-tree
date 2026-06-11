import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HANDLE_PATH } from "./current-handle.js";
import { PACKAGE_E2E_ROOT } from "./env.js";
import { startRunWorld, stopRunWorld } from "./lifecycle.js";

/**
 * Path of the fake `claude` TUI binary (mirrors runtime-tui-fixture.ts —
 * imported here to avoid a circular dep through the fixture module).
 */
const FAKE_TUI_BIN = resolve(PACKAGE_E2E_ROOT, "src/mocks/fake-claude-tui.mjs");

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
  // E2E_TUI=1 swaps the daemon's `claude` to the fake-tui binary AND injects
  // a fake `ANTHROPIC_API_KEY` so the shared Claude auth probe reports
  // authenticated. The TUI scenarios live behind this knob so the existing
  // SDK-based suites keep their lean spawn.
  const tuiMode = process.env.E2E_TUI === "1";
  const world = await startRunWorld({
    withClient,
    // Tests that need a second-or-third user (client-claim, multi-org)
    // mint via dev-callback. Always on for the e2e run — the route 404s
    // unless this env is explicitly set, so it's still off in prod.
    //
    // Full e2e can generate concentrated HTTP bursts from one loopback actor.
    // A high ceiling keeps the limiter installed (so its wiring is still
    // exercised) without throttling the test driver; production defaults remain
    // untouched.
    serverExtraEnv: {
      FIRST_TREE_DEV_CALLBACK_ENABLED: "1",
      FIRST_TREE_RATE_LIMIT_MAX: "100000",
    },
    clientClaudeCodeExecutable: tuiMode ? FAKE_TUI_BIN : undefined,
    clientExtraEnv: tuiMode ? { ANTHROPIC_API_KEY: "fake-tui-e2e-key" } : undefined,
  });
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
