import type { CurrentRunHandle } from "./current-handle.js";
import { startRunWorld, stopRunWorld } from "./lifecycle.js";
import { FAKE_CLAUDE_TUI_EXECUTABLE } from "./runtime-tui-fixture.js";

/**
 * Boot a dedicated TUI world *inside the calling worker process*.
 *
 * Why this exists: vitest runs `globalSetup` in the main process but each
 * test file in a forked worker. The daemon-restart helpers
 * (`stopActiveClient` / `respawnActiveClient` in lifecycle.ts) operate on the
 * module-level `activeWorld`, which only exists in whichever process called
 * `startRunWorld`. A test that needs to stop + respawn the daemon mid-run
 * (orphan-sweep, restart-resume) therefore CANNOT drive the globalSetup
 * world — that world lives in the main process, unreachable from the worker.
 *
 * The fix is for those tests to own their world: call `setupOwnTuiWorld()` in
 * `beforeAll` so `activeWorld` is set in the worker, then the restart helpers
 * work in-process. Steady-state tests keep using the cheaper shared
 * globalSetup world via `readCurrentHandle()`.
 *
 * The spawned world uses the same fake-tui binary + raised rate limit as the
 * globalSetup TUI world (see global-setup.ts), so behaviour is identical.
 */
export async function setupOwnTuiWorld(): Promise<CurrentRunHandle> {
  const world = await startRunWorld({
    withClient: true,
    serverExtraEnv: {
      FIRST_TREE_DEV_CALLBACK_ENABLED: "1",
      FIRST_TREE_RATE_LIMIT_MAX: "100000",
      FIRST_TREE_RATE_LIMIT_AGENT_MESSAGE_MAX: "100000",
    },
    clientClaudeCodeExecutable: FAKE_CLAUDE_TUI_EXECUTABLE,
    clientExtraEnv: { ANTHROPIC_API_KEY: "fake-tui-e2e-key" },
    // Critical: this world boots ALONGSIDE the shared globalSetup world. The
    // default stale-container sweep would `docker rm -f` the shared world's
    // running pg (same naming pattern), 500-ing every steady-state scenario.
    skipStaleContainerCleanup: true,
  });
  if (!world.credentials) {
    throw new Error("setupOwnTuiWorld: world started without credentials — withClient was not honoured");
  }
  return {
    runId: world.identity.runId,
    serverBaseUrl: world.server.baseUrl,
    databaseUrl: world.pg.databaseUrl,
    clientHome: world.identity.home,
    jwtSecret: world.jwtSecret,
    githubWebhookSecret: world.githubApp.webhookSecret,
    credentials: world.credentials,
  };
}

/** Tear down the worker-owned world booted by `setupOwnTuiWorld`. */
export async function teardownOwnTuiWorld(): Promise<void> {
  await stopRunWorld();
}
